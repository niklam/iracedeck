/**
 * The engine's pools and its view of the clips (issue #1514): the manifest
 * in force, the code-registered pools (`definePool`, `definePoolFromManifest`),
 * the cached dynamic `pool:<group>/<base>` refs, the per-voice state of the
 * pools a script defines, and the pickers with their no-repeat rules — the
 * rules of #1136 and #1138 live here: a pick is committed only once its fire
 * is accepted, and the takes of a resumed head are put back.
 *
 * Every pick goes through a `PickSession` the store hands out, and the
 * session's `commit()` is the one place a pick becomes a pool's `lastIndex`.
 * The one exception is the no-repeat reset on a voice change, which stays a
 * direct write at pick time: it applies even to a fire that later aborts or
 * is refused by the gate.
 *
 * The manifest is read live through `currentManifest()` and `hasClip()` on
 * every use, never captured, because `setManifest` swaps it.
 */
import type { ILogger } from "@iracedeck/logger";

import type { ExecOp } from "./engine-types.js";
import { type AudioAssetsManifest, referenceVoice } from "./manifest.js";

/**
 * A pool is either an explicit clip list (`static`) or derived from the
 * manifest per voice at fire time (`manifest`, issue #664). Both share the
 * no-immediate-repeat `lastIndex`; manifest pools also track the voice the
 * index belongs to, since variant counts differ across voices. `lastIndex`
 * is the last take the driver HEARD: a pick made during expansion is
 * recorded on the expansion's `PickSession` and written here only once the
 * fire is accepted (`commit`, issue #1138) — a fire the gate refuses, or
 * that aborts after the pick, commits nothing.
 */
export type PoolState =
  | { kind: "static"; clips: string[]; lastIndex: number }
  | {
      kind: "manifest";
      group: string;
      base: string;
      byVoice: Map<string, string[]>;
      lastIndex: number;
      lastVoice: string | null;
    };

/** A session's picks as `snapshot` captured them, for `restore`. */
export type PickSnapshot = ReadonlyMap<PoolState, number>;

/**
 * The pool picks of one expansion, keyed by pool (issue #1138): consulted
 * FIRST by `pickFromPool`, so two picks from one pool inside one body still
 * avoid each other, and committed into the pools' `lastIndex` only when the
 * fire is accepted. `snapshot` / `restore` let a cut tail's failed attempt
 * put back the picks it made (issue #1407).
 */
export class PickSession {
  private readonly picks = new Map<PoolState, number>();

  /** The take this session already drew from `pool`, if any. */
  last(pool: PoolState): number | undefined {
    return this.picks.get(pool);
  }

  /** Record a take drawn from `pool`; committed by `commit`. */
  record(pool: PoolState, index: number): void {
    this.picks.set(pool, index);
  }

  snapshot(): PickSnapshot {
    return new Map(this.picks);
  }

  restore(snapshot: PickSnapshot): void {
    this.picks.clear();

    for (const [pool, idx] of snapshot) this.picks.set(pool, idx);
  }

  /** Accepted: the takes this session drew are now the ones the driver hears. */
  commit(): void {
    for (const [pool, idx] of this.picks) pool.lastIndex = idx;
  }
}

/**
 * Where the active voice's script defines a pool of this name — its
 * manifest `(group, base)` source — or `undefined` when it defines none. The
 * script set answers it; the store reads it live on every pick.
 */
export type ScriptPoolSource = (voice: string, name: string) => { group: string; base: string } | undefined;

export class PoolStore {
  private manifest: AudioAssetsManifest;
  /** Set view of `manifest.clips` for O(1) availability checks at expansion time. */
  private clipSet: Set<string>;
  private readonly registered = new Map<string, PoolState>();
  /**
   * `(group, base)` source of every manifest-backed pool, so a manifest reload
   * can re-derive them without the catalog having to re-register anything
   * (issue #1034).
   */
  private readonly manifestPoolSources = new Map<string, { group: string; base: string }>();
  /**
   * Per-voice state of the pools a script defines — the no-repeat tracker
   * and the manifest-derived members — keyed `(voice, pool name)`. Built
   * lazily on first pick; cleared by `setManifest` and by every compile
   * (`clearScriptPools`).
   */
  private readonly scriptPoolState = new Map<string, Map<string, PoolState>>();

  constructor(
    manifest: AudioAssetsManifest,
    private readonly logger: ILogger,
    /**
     * Resolves the active Race Engineer voice key (e.g. `"luca"`) at clip-
     * resolution time. Used to substitute `{voice}` placeholders in scenario
     * `base` and pool clips. Returns `null` if no voice is selected.
     */
    private readonly getActiveVoice: () => string | null,
    private readonly scriptPoolSource: ScriptPoolSource,
  ) {
    this.manifest = manifest;
    this.clipSet = new Set(manifest.clips);
  }

  /** The manifest currently in force. */
  currentManifest(): AudioAssetsManifest {
    return this.manifest;
  }

  /** Whether the manifest in force carries `path`. */
  hasClip(path: string): boolean {
    return this.clipSet.has(path);
  }

  /** Every code-registered pool and cached dynamic ref by key — the view validation reads. */
  get pools(): ReadonlyMap<string, PoolState> {
    return this.registered;
  }

  /** Registered names only: the `pool:` keys are cached dynamic refs, not pools a script may name. */
  registeredPoolNames(): Set<string> {
    return new Set([...this.registered.keys()].filter((name) => !name.startsWith("pool:")));
  }

  /**
   * Drop every script-defined pool's cached state. A compile redefines what
   * a script pool holds, so the script set calls this on every compile —
   * the one write into this module from another.
   */
  clearScriptPools(): void {
    this.scriptPoolState.clear();
  }

  /** Open the pick session of one expansion. */
  openSession(): PickSession {
    return new PickSession();
  }

  /**
   * Substitute `{voice}` in a path with the active voice. No-op when the
   * path has no placeholder. Returns the path unchanged when the placeholder
   * is present but no voice is selected — the resulting malformed path
   * (e.g. `voice//pit-actions/fuel-on.mp3`) will fail to play and surface
   * loudly via the audio engine, which is the right behaviour: a templated
   * scenario without a voice means the user hasn't picked one yet.
   */
  substituteVoice(path: string): string {
    if (!path.includes("{voice}")) return path;

    const voice = this.getActiveVoice() ?? "";

    return path.replace(/\{voice\}/g, voice);
  }

  /** Register an explicit clip list. Returns whether the pool was accepted. */
  definePool(name: string, clips: string[]): boolean {
    if (this.registered.has(name)) {
      this.logger.warn(`Pool "${name}" redefined`);
    }

    // A `{voice}`-templated clip is checked against the REFERENCE voice only
    // (issue #664): per-voice clip sets may legitimately diverge, so a gap in
    // another voice is not an error. A miss for the reference voice is a
    // probable typo and warns without rejecting the pool. Non-templated
    // clips must exist verbatim.
    const reference = referenceVoice(this.manifest);
    const missing: string[] = [];
    const suspect: string[] = [];

    for (const clip of clips) {
      if (clip.includes("{voice}")) {
        if (reference !== null) {
          const resolved = clip.replace(/\{voice\}/g, reference);

          if (!this.manifest.clips.includes(resolved)) suspect.push(resolved);
        }
      } else if (!this.manifest.clips.includes(clip)) {
        missing.push(clip);
      }
    }

    if (missing.length > 0) {
      this.logger.error(`Pool "${name}" rejected; unknown clips:\n  - ${missing.join("\n  - ")}`);

      return false;
    }

    if (suspect.length > 0) {
      this.logger.warn(
        `Pool "${name}": no clip for reference voice "${reference}" (possible typo):\n  - ${suspect.join("\n  - ")}`,
      );
    }

    this.registered.set(name, { kind: "static", clips: [...clips], lastIndex: -1 });

    return true;
  }

  /** Register a manifest-derived pool (see `IScenarioEngine.definePoolFromManifest`). Never rejects. */
  definePoolFromManifest(name: string, group: string, base: string): void {
    if (this.registered.has(name)) {
      this.logger.warn(`Pool "${name}" redefined`);
    }

    this.manifestPoolSources.set(name, { group, base });

    const pool = this.buildManifestPool(group, base);

    // Typo guard: only the reference voice is checked — other voices may
    // legitimately omit the callout. Warn, never reject: a pool that is
    // empty for the active voice just skips at fire time.
    const reference = referenceVoice(this.manifest);

    if (reference !== null && !pool.byVoice.has(reference)) {
      this.logger.warn(
        `Pool "${name}": no "${group}/${base}" clips for reference voice "${reference}" (possible typo)`,
      );
    }

    this.registered.set(name, pool);
  }

  /**
   * Replace the manifest (issue #1034) and re-derive every pool from it. The
   * facade invalidates the stashed resumes beside this call: every pool's
   * membership is re-derived below, so a stashed resume was expanded against
   * clip lists that no longer exist (issue #1136).
   */
  setManifest(manifest: AudioAssetsManifest): void {
    this.manifest = manifest;
    this.clipSet = new Set(manifest.clips);

    // Script-defined pools are derived per voice from the manifest too (issue
    // #1064); drop every cached member list so the next pick rebuilds it.
    this.scriptPoolState.clear();

    // Re-derive every manifest-backed pool from its recorded `(group, base)`.
    // Members are per-voice, so a pack arriving or leaving changes what a pool
    // holds for the voices it touches and nothing else.
    for (const [name, source] of this.manifestPoolSources) {
      this.registered.set(name, this.buildManifestPool(source.group, source.base));
    }

    // Dynamic `pool:<group>/<base>` refs (issue #836) are built lazily on first
    // use and cached under the ref string. Drop them so they rebuild against the
    // new manifest instead of serving a stale member list.
    for (const key of [...this.registered.keys()]) {
      if (key.startsWith("pool:")) this.registered.delete(key);
    }

    // Static pools keep their clips (they were registered explicitly, not
    // derived), but every pool's no-repeat tracker is reset: variant counts
    // differ per voice, so a retained index can point past the end of the new
    // member list — the same reason an active-voice change resets them.
    for (const pool of this.registered.values()) pool.lastIndex = -1;
  }

  /**
   * Scan the manifest for a pool's members: every
   * `voice/<voice>/<group>/<base>-NN.mp3` variant PLUS the bare
   * `voice/<voice>/<group>/<base>.mp3` (issue #836 — a bare value clip is a
   * size-1 pool, so numbers/names/temps need no rename migration).
   */
  private buildManifestPool(group: string, base: string): Extract<PoolState, { kind: "manifest" }> {
    const pattern = poolMemberPattern(group, base);
    const byVoice = new Map<string, string[]>();

    for (const clip of this.manifest.clips) {
      const match = pattern.exec(clip);

      if (!match) continue;

      let members = byVoice.get(match[1]);

      if (!members) {
        members = [];
        byVoice.set(match[1], members);
      }

      members.push(clip);
    }

    for (const members of byVoice.values()) members.sort();

    return { kind: "manifest", group, base, byVoice, lastIndex: -1, lastVoice: null };
  }

  /**
   * Put back the no-repeat tracker of every pool drawn ONLY in the part of
   * the body the driver already heard (issue #1136).
   *
   * The fresh expansion's picks are committed before the engine decides to
   * resume, and the resume then slices the head off — so a head slot's pool
   * is left recording a take that will never be played, while
   * `PoolState.lastIndex` is documented as the last take the driver HEARD.
   * The next fire's no-repeat guard would then steer away from that unheard
   * take and could serve the very one the driver did hear. So each such pool
   * is set back to the take the STASHED head played, which is what was heard.
   * A pool that `remaining` still draws keeps its fresh commit: that take is
   * the one that will have been heard last. Newly reachable, because before
   * #1136 a multi-take body never resumed at all.
   *
   * A pool or a path it cannot account for is skipped in silence — there is
   * nothing to restore and nothing to report. The clips are compared through
   * `substituteVoice` so a `{voice}`-templated static pool is matched by the
   * path the op actually carries.
   */
  restoreHeadPoolIndices(head: readonly ExecOp[], remaining: readonly ExecOp[]): void {
    const stillToBeHeard = new Set<string>();

    for (const op of remaining) {
      if (op.kind === "play" && op.pool !== undefined) stillToBeHeard.add(op.pool);
    }

    const voice = this.getActiveVoice();

    for (const op of head) {
      if (op.kind !== "play" || op.pool === undefined || stillToBeHeard.has(op.pool)) continue;

      const pool = this.scriptPool(op.pool) ?? this.registered.get(op.pool);

      if (!pool) continue;

      let clips: string[];

      if (pool.kind === "manifest") {
        if (voice === null) continue;

        clips = pool.byVoice.get(voice) ?? [];
      } else {
        clips = pool.clips;
      }

      const index = clips.findIndex((clip) => this.substituteVoice(clip) === op.path);

      if (index >= 0) pool.lastIndex = index;
    }
  }

  /**
   * Resolve a dynamic pool reference returned by a var resolver (issue #836):
   * `pool:<group>/<base>`. The pool is derived from the manifest on first use
   * and cached in the pools map under the full ref string (registered pool
   * names never carry the `pool:` prefix, so the namespaces can't collide) —
   * giving value pools the same no-repeat guard and voice-change reset as
   * registered pools. No reference-voice typo guard: values legitimately
   * differ per voice.
   *
   * `noRepeat` defaults on, which is what a var resolver gets; a slashed
   * pool step passes its own, so `{ "pool": "flags/green", "noRepeat":
   * false }` means what it says in either spelling of a pool name.
   */
  pickFromPoolRef(ref: string, session: PickSession, noRepeat = true): string | null {
    if (!this.registered.has(ref)) {
      const spec = ref.slice("pool:".length);
      const slash = spec.indexOf("/");

      if (slash <= 0 || slash === spec.length - 1) {
        this.logger.error(`pickFromPoolRef: malformed pool reference "${ref}" — expected pool:<group>/<base>`);

        return null;
      }

      this.registered.set(ref, this.buildManifestPool(spec.slice(0, slash), spec.slice(slash + 1)));
    }

    return this.pickFromPool(ref, session, noRepeat);
  }

  /**
   * A pool the active voice's script defines shadows a code-registered pool
   * of the same name, for that voice only (issue #1064): its state lives in
   * the per-voice cache, built from the manifest on first pick.
   */
  private scriptPool(name: string): PoolState | null {
    const voice = this.getActiveVoice();

    if (voice === null) return null;

    const source = this.scriptPoolSource(voice, name);

    if (!source) return null;

    let perVoice = this.scriptPoolState.get(voice);

    if (!perVoice) {
      perVoice = new Map();
      this.scriptPoolState.set(voice, perVoice);
    }

    let pool = perVoice.get(name);

    if (!pool) {
      pool = this.buildManifestPool(source.group, source.base);
      perVoice.set(name, pool);
    }

    return pool;
  }

  pickFromPool(name: string, session: PickSession, noRepeat: boolean): string | null {
    const pool = this.scriptPool(name) ?? this.registered.get(name);

    if (!pool) {
      // Surfaces a class of bug that's otherwise silent: a scenario references
      // a pool that was never registered (or was removed without updating the
      // scenario). `defineScenario` validation catches this for scenarios
      // defined ahead of fire time, but not for pools that vanish later or
      // for `connector` step types whose pool is implicit.
      this.logger.error(`pickFromPool: unknown pool "${name}" — step skipped, clip will not play`);

      return null;
    }

    let clips: string[];

    if (pool.kind === "manifest") {
      const voice = this.getActiveVoice();

      if (!voice) {
        this.logger.debug(`pickFromPool: pool "${name}" skipped — no active voice selected`);

        return null;
      }

      // Variant counts differ across voices, so a stale lastIndex from
      // another voice would skew the no-repeat guard — reset it on voice
      // change (issue #664). A direct write, not part of the session's
      // commit: it applies even to a fire that aborts or is refused later.
      if (voice !== pool.lastVoice) {
        pool.lastVoice = voice;
        pool.lastIndex = -1;
      }

      clips = pool.byVoice.get(voice) ?? [];
    } else {
      clips = pool.clips;
    }

    if (clips.length === 0) {
      // Not an error: a voice may legitimately omit a callout (issue #664) —
      // the step skips silently.
      this.logger.debug(`pickFromPool: pool "${name}" is empty for the active voice — step skipped`);

      return null;
    }

    let idx = Math.floor(Math.random() * clips.length);
    // A pick already made from this pool by the expansion in progress comes
    // first, so two draws inside one body avoid each other; otherwise the
    // last take that actually played (issue #1138).
    const last = session.last(pool) ?? pool.lastIndex;

    if (noRepeat && clips.length > 1 && idx === last) {
      idx = (idx + 1) % clips.length;
    }

    // Recorded on the session and committed on acceptance.
    session.record(pool, idx);

    return clips[idx];
  }
}

/** Escape a literal string for embedding in a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @internal Exported for testing — the pool-membership rule `buildManifestPool`
 * applies to the manifest: a clip belongs to the `(group, base)` pool of the
 * voice it names when its path is `voice/<voice>/<group>/<base>-NN.mp3` with
 * exactly two digits, or the bare `voice/<voice>/<group>/<base>.mp3` (issue
 * #836). The first capture group is the voice. The digit count is pinned on
 * purpose: the #1051 entry in the callout-examples rule records what a
 * three-digit suffix did to a whole family.
 */
export function poolMemberPattern(group: string, base: string): RegExp {
  return new RegExp(`^voice/([^/]+)/${escapeRegExp(group)}/${escapeRegExp(base)}(?:-\\d{2})?\\.mp3$`);
}
