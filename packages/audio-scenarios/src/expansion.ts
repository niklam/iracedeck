/**
 * Expansion (issue #1514): a fire's `Step` tree turned into execution ops at
 * fire time — shorthand → ops, pool / variable / include / conditional
 * resolution, the radio frame around a body that speaks (issue #1064) and the
 * cut tail an end plays (issue #1407) — and the abort decision of #835 that
 * keeps a fragment from ever being spoken.
 *
 * It reads the compiled scripts, the vocabulary, the pools and the user's
 * frame switches, and touches no bus state: nothing here calls
 * `IAudioService`, and nothing here decides whether a fire may speak. What it
 * hands back is UNCOMMITTED — `prepare` and `prepareFrame` each open a pick
 * session and return its `commit()` beside the ops, and the caller (the
 * scheduler) asks the contract's speak-time gate (issue #1138) before it
 * commits, so a fire the gate refuses consumed no take.
 */
import { AudioChannel } from "@iracedeck/audio-service";
import { CONNECTOR_POOL } from "@iracedeck/callout-script";
import type { SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";

import type { ContractRegistry } from "./contract-registry.js";
import type { ResolvedStep, ScenarioContext } from "./dsl.js";
import { applyBase, NO_FRAME } from "./dsl.js";
import {
  type CompiledScenario,
  type ExecOp,
  type ExpandedFrame,
  ExpansionAbort,
  fireContext,
  FRAME_PREVIEW_ID,
  type FrameSide,
  type PreparedFire,
} from "./engine-types.js";
import type { FrameOptions } from "./interpreter.js";
import type { OnceWarnings } from "./once-warnings.js";
import type { PickSession, PoolStore } from "./pool-store.js";
import type { CompiledFrame, CompiledVoiceScript } from "./script-compiler.js";
import type { ScriptSet } from "./script-set.js";
import type { Vocabulary } from "./vocabulary.js";

/** What an expansion reads, as the modules that own it — only the members it uses. */
export type ExpansionDeps = {
  /** The registered contracts, for a legacy include's target. */
  contracts: Pick<ContractRegistry, "get">;
  /** The var registry and the case lookup. */
  vocabulary: Pick<Vocabulary, "vars" | "pickCaseBranch">;
  /** The pick session, the pickers, `{voice}` substitution and the live manifest reads. */
  pools: Pick<
    PoolStore,
    "openSession" | "substituteVoice" | "pickFromPool" | "pickFromPoolRef" | "hasClip" | "currentManifest"
  >;
  /** The compile a dirty script set runs before a fire looks anything up, and the compiled scripts. */
  scripts: Pick<ScriptSet, "ensureCompiled" | "compiled">;
};

/**
 * A fire expanded and ready for the speak-time gate (issue #1138): what it
 * plays, the context it was expanded in — `vars` filled, which the gate
 * reads — and `commit()`, which makes its pool picks the takes the driver
 * heard. The caller commits only once the gate has admitted the fire.
 */
export type PreparedCallout = { fire: PreparedFire; ctx: ScenarioContext; commit(): void };

/**
 * A frame expanded around nothing for the Background Test (issue #1124), and
 * `commit()` for its pool picks; the caller commits at once, since no gate
 * stands between the preview and the bus.
 */
export type PreparedFramePreview = { frame: ExpandedFrame; commit(): void };

export class Expansion {
  constructor(
    private readonly logger: ILogger,
    private readonly warnings: OnceWarnings,
    /** Resolves the active Race Engineer voice key at expansion time; `null` when none is selected. */
    private readonly getActiveVoice: () => string | null,
    /**
     * The user's Radio beeps / Pit ambience switches (issue #1064), read at
     * every frame expansion so a toggle takes effect on the next callout.
     */
    private readonly getFrameOptions: () => FrameOptions,
    private readonly deps: ExpansionDeps,
  ) {}

  /**
   * Expand a fire's sequence into execution ops — the abort decision point
   * (issue #835). Returns `null` when the fire must not play: a REQUIRED
   * clip-producing step resolved to nothing (missing clip / null var / empty
   * pool for the active voice — never a half-sentence), the expansion threw,
   * it produced no ops, or — for a contract — the active voice's script has
   * no compiled entry for it (issue #1064). `attemptFire` reaches this BEFORE
   * any bus cancellation, so an aborting fire can't silence an in-flight
   * one, and an aborted fire stamps no cooldown. Otherwise the fire comes
   * back uncommitted, with the context its gate is asked against and the
   * `commit()` of its pool picks (`PreparedCallout`).
   *
   * Frame application (issue #1064): a body that expanded to at least one
   * clip is wrapped in its frame — the script entry's, else the contract's,
   * else `DEFAULT_FRAME` — as the active voice's script defines it, with the
   * user's beeps / ambience switches applied by position. An empty body, or
   * one with no clip at all, gets no frame: no callout ever plays bare ticks
   * around nothing. The frame is part of the callout, so a frame step that
   * resolves to nothing aborts the fire like any other required step — and
   * for a body that could hold a clip the frame is expanded BEFORE the body,
   * so that a body step's side effect cannot be left standing by a frame
   * aborting afterwards, for a fire that never plays. No body CONDITION
   * commits anything: a registered condition must be pure since #1138 — the
   * one that did, the furled-flag `if` that marked the flag spoken, moved to
   * the contract's `speakGate` — precisely because a pack may write it into
   * a body. A var RESOLVER may still keep a tracker, which is why the frame
   * is expanded first: it costs nothing, and it is what keeps such a tracker
   * from being moved by a frame that then aborts. The position readout's
   * intro was that example until #1138 — it still DECIDES its lead-in during
   * expansion, but only stashes the decision for its contract's `speakGate`
   * to commit, so a readout refused there (or aborted further down) records
   * nothing for the next one's delta.
   * A body that can never hold a clip (`canProducePlay`) has no frame
   * expanded at all — nothing can be due for it, so nothing can abort it or
   * warn about it. The rule and its one accepted cost are stated on
   * `applyFrame`.
   */
  prepare(entry: CompiledScenario, event: SimEventOf<SimEventName> | null): PreparedCallout | null {
    this.deps.scripts.ensureCompiled();

    const ctx = fireContext(event);

    const voice = this.getActiveVoice();
    const script = voice === null ? undefined : this.deps.scripts.compiled(voice);
    let body: ResolvedStep[];
    let frameName: string;

    if (entry.resolvedSequence === null) {
      const scripted = script?.scenarios.get(entry.raw.id);

      if (!scripted) {
        this.logger.debug(`Scenario "${entry.raw.id}" skipped — no script for voice "${voice ?? "(none)"}"`);

        return null;
      }

      body = scripted.resolved;
      frameName = scripted.frame;
    } else {
      body = entry.resolvedSequence;
      frameName = entry.frame;
    }

    let prepared: PreparedFire;
    // The pool picks this expansion makes are recorded on the session and
    // committed into the pools only once the fire is accepted (issue #1138):
    // a fire that aborts, expands empty or is refused by the gate consumed no
    // take, so the next fire still avoids the take the driver last heard.
    const session = this.deps.pools.openSession();

    try {
      // The cut tail is expanded only for a contract an event can end (issue
      // #1407): any other contract never plays it, and expanding it anyway
      // would let a broken `cut` abort a callout that cannot be ended. It is
      // expanded under this fire's picks, so its pool take is committed with
      // the fire's — a take of the tail counted but never heard only shifts
      // that pool's no-repeat guard.
      const frame = canProducePlay(body)
        ? this.expandFrame(
            frameName,
            voice,
            script,
            entry.raw.id,
            ctx,
            entry.raw.endsOn !== undefined ? entry.raw.channel : null,
            session,
          )
        : null;
      const bodyOps = this.expandSequence(
        body,
        entry.raw.base,
        entry.raw.channel,
        ctx,
        new Set([entry.raw.id]),
        session,
      );
      prepared = applyFrame(bodyOps, frame);
    } catch (err) {
      if (err instanceof ExpansionAbort) {
        this.logger.debug(`Scenario "${entry.raw.id}" skipped — ${err.reason}`);

        return null;
      }

      this.logger.error(
        `Scenario "${entry.raw.id}" expansion failed: ${err instanceof Error ? err.message : String(err)}`,
      );

      return null;
    }

    if (prepared.ops.length === 0) {
      this.logger.debug(`Scenario "${entry.raw.id}" expanded to empty sequence; skipping`);

      return null;
    }

    return { fire: prepared, ctx, commit: () => session.commit() };
  }

  /**
   * Expand the ACTIVE voice's compiled frame `frameName` around nothing, for
   * the Background Test (issue #1124), under a pick session of its own. The
   * caller has already found the frame in `script` and the bus free; this is
   * the expansion alone, and it returns `null` — after one debug line for an
   * abort, one error line for anything else — when the frame cannot play.
   * The frame's two halves may both be empty (both switches off); deciding
   * what that means is the caller's.
   */
  prepareFrame(frameName: string, voice: string, script: CompiledVoiceScript): PreparedFramePreview | null {
    let frame: ExpandedFrame | null;
    const session = this.deps.pools.openSession();

    try {
      frame = this.expandFrame(frameName, voice, script, FRAME_PREVIEW_ID, fireContext(null), null, session);
    } catch (err) {
      if (err instanceof ExpansionAbort) {
        this.logger.debug(`Frame preview "${frameName}" skipped — ${err.reason}`);
      } else {
        this.logger.error(
          `Frame preview "${frameName}" expansion failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return null;
    }

    if (frame === null) return null;

    return { frame, commit: () => session.commit() };
  }

  /**
   * Expand the frame a fire will be wrapped in, as the active voice's script
   * defines it (see `prepare`) — before the body, so a frame that aborts
   * never lets a body side effect commit, and only for a body that could
   * hold a clip, so its warns and aborts concern a callout the frame is
   * actually due for. A `cutChannel` also expands the cut tail an end plays
   * (issue #1407), tagged `cut` — the frame's `cut`, spoken on that channel
   * (the callout's own), else its `close` as the close plays — and `null`
   * leaves it empty. Unlike an open or close step, a tail step that resolves
   * to nothing does not abort the fire: the tail is only what an end plays,
   * so the line still speaks, and the tail falls back to the close
   * (`expandCutTail`).
   * Returns `null` when no frame applies: the scenario
   * wants none (`NO_FRAME`), the voice has no script, or its script does not
   * provide the frame (a legacy scenario's, since a contract's was checked
   * at compile time — warned once per `(voice, frame)`, saying whether the
   * frame is undefined or failed to compile).
   *
   * Two things are decided here and nowhere else (issue #1064):
   *
   * - **Every op the frame produces is tagged with its side**, which is how
   *   the frame is identified afterwards — never by clip path.
   * - **Every clip the frame's open and close play goes on the SFX
   *   channel**, whatever it is: a pack's own beep rides the Background bus
   *   like the built-in tick, under the Background volume and the Radio
   *   beeps switch. The `cut` is the exception (issue #1407): it is what the
   *   engineer SAYS when a line is abandoned, so its clips are spoken on the
   *   callout's channel, and only the built-in ticks in it are sound effects.
   *
   * The user's two switches are applied to the frame's STEPS, before any of
   * them expands, so a step the user switched off can never abort the
   * callout because its clip is missing. A frame step that resolves to
   * nothing otherwise throws `ExpansionAbort` like any required step, after
   * one warn per `(voice, frame)` — the body's own abort stays at debug, but
   * a frame failure is a broken pack, not a per-callout omission, and it
   * silences every callout the frame wraps.
   */
  private expandFrame(
    frameName: string,
    voice: string | null,
    script: CompiledVoiceScript | undefined,
    ownerId: string,
    ctx: ScenarioContext,
    cutChannel: AudioChannel | null,
    session: PickSession,
  ): ExpandedFrame | null {
    if (frameName === NO_FRAME) return null;

    if (voice === null || !script) {
      this.logger.debug(`Scenario "${ownerId}" gets no frame — no script for voice "${voice ?? "(none)"}"`);

      return null;
    }

    const frame = script.frames.get(frameName);

    if (!frame) {
      const key = `${voice}|${frameName}`;

      if (this.warnings.once("legacyFrames", key)) {
        const failure = script.failedFrames.get(frameName);
        this.logger.warn(
          failure === undefined
            ? `Voice "${voice}" defines no frame "${frameName}" — legacy scenarios using it play unframed`
            : `Voice "${voice}" frame "${frameName}" failed to compile: ${failure} — legacy scenarios using it play unframed`,
        );
      }

      return null;
    }

    const options = this.frameOptions();
    const side = (steps: ResolvedStep[], tag: FrameSide): ExecOp[] =>
      this.expandSequence(
        filterFrameSteps(steps, options),
        undefined,
        AudioChannel.SFX,
        ctx,
        new Set([ownerId]),
        session,
      )
        // A second pass on the ops, for the one step whose ops cannot be
        // predicted from its kind: an include, whose fragment is only known
        // once expanded. Every other step was filtered before it expanded.
        .filter((op) => (op.kind === "ambient" ? options.ambience : options.beeps))
        .map((op) => ({ ...op, frame: tag }));

    let halves: { open: ExecOp[]; close: ExecOp[] };

    try {
      halves = { open: side(frame.open, "open"), close: side(frame.close, "close") };
    } catch (err) {
      if (err instanceof ExpansionAbort) {
        const key = `${voice}|${frameName}`;

        if (this.warnings.once("frameAborts", key)) {
          this.logger.warn(
            `Voice "${voice}" frame "${frameName}" cannot play — ${err.reason}; every callout it frames is skipped`,
          );
        }
      }

      throw err;
    }

    if (cutChannel === null) return { ...halves, cut: [] };

    // The cut is spoken (issue #1407): its clips default to the callout's
    // channel and only the built-in ticks route to SFX (`channelForPath`).
    // Pit ambience still drops its ambient steps, but Radio beeps drops only
    // the SFX plays — the ticks — never the words. So the steps are not
    // filtered for beeps before they expand (a tick the user switched off is
    // a built-in the manifest always carries), and the ops are sorted after.
    const cutSide = (steps: ResolvedStep[]): ExecOp[] =>
      this.expandSequence(
        filterFrameSteps(steps, { ambience: options.ambience, beeps: true }),
        undefined,
        cutChannel,
        ctx,
        new Set([ownerId]),
        session,
      )
        .filter((op) => {
          if (op.kind === "ambient") return options.ambience;

          return op.kind !== "play" || op.channel !== AudioChannel.SFX || options.beeps;
        })
        .map((op) => ({ ...op, frame: "cut" as const }));

    return {
      ...halves,
      cut: this.expandCutTail(frame, frameName, voice, cutSide, (steps) => side(steps, "cut"), session),
    };
  }

  /**
   * Expand a frame's cut tail (issue #1407): its `cut` through `cutSide`
   * (spoken on the callout's channel, see `expandFrame`), else its `close`
   * through `closeSide` — exactly as the close plays, every clip a sound
   * effect — so a pack that never heard of `cut` still lets go of the button
   * the way it always does. A `cut` step that
   * resolves to nothing does not abort the fire it rides: the tail is only
   * what an end would play, and trading the line itself for it would silence
   * the warning to save the "never mind". It falls back to the close instead
   * — the tail is empty, and an end stops silently, if that aborts too —
   * after one warn per `(voice, frame)`, keyed apart from the frame-abort
   * warn in the same set. The picks a failed attempt made are put back, so a
   * take that will never be played commits nothing.
   */
  private expandCutTail(
    frame: CompiledFrame,
    frameName: string,
    voice: string,
    cutSide: (steps: ResolvedStep[]) => ExecOp[],
    closeSide: (steps: ResolvedStep[]) => ExecOp[],
    session: PickSession,
  ): ExecOp[] {
    const attempt = (expand: (steps: ResolvedStep[]) => ExecOp[], steps: ResolvedStep[]): ExecOp[] | ExpansionAbort => {
      const before = session.snapshot();

      try {
        return expand(steps);
      } catch (err) {
        if (!(err instanceof ExpansionAbort)) throw err;

        session.restore(before);

        return err;
      }
    };

    const tail = frame.cut === null ? attempt(closeSide, frame.close) : attempt(cutSide, frame.cut);

    if (!(tail instanceof ExpansionAbort)) return tail;

    const key = `${voice}|${frameName}|cut`;

    if (this.warnings.once("frameAborts", key)) {
      this.logger.warn(
        `Voice "${voice}" frame "${frameName}" cut tail cannot play — ${tail.reason}; an ended line closes the radio instead`,
      );
    }

    if (frame.cut === null) return [];

    const close = attempt(closeSide, frame.close);

    return close instanceof ExpansionAbort ? [] : close;
  }

  /** The user's frame switches, read live; a throwing accessor keeps the frame whole. */
  private frameOptions(): FrameOptions {
    try {
      return this.getFrameOptions();
    } catch (err) {
      this.logger.error(`getFrameOptions threw: ${err instanceof Error ? err.message : String(err)}`);

      return { beeps: true, ambience: true };
    }
  }

  // ── Sequence expansion ──

  private expandSequence(
    steps: ResolvedStep[],
    base: string | undefined,
    defaultChannel: AudioChannel,
    ctx: ScenarioContext,
    visitedIncludes: Set<string>,
    session: PickSession,
  ): ExecOp[] {
    const out: ExecOp[] = [];

    for (const step of steps) {
      switch (step.kind) {
        case "clip": {
          const path = this.deps.pools.substituteVoice(applyBase(base, step.path));
          this.assertClipAvailable(path, `clip "${step.path}"`);
          this.pushClip(out, path, defaultChannel);
          break;
        }

        case "var": {
          const resolver = this.deps.vocabulary.vars.get(step.name);
          const value = resolver ? resolver(ctx) : null;
          ctx.vars[step.name] = value;

          if (!value) throw new ExpansionAbort(`var {{${step.name}}} resolved to nothing`);

          // A resolver may return a dynamic pool reference (`pool:<group>/<base>`,
          // issue #836) instead of a clip path — value-indexed clips (numbers,
          // names, temps) are pools too, usually of size 1.
          if (value.startsWith("pool:")) {
            const pick = this.deps.pools.pickFromPoolRef(value, session);

            if (!pick) {
              throw new ExpansionAbort(`var {{${step.name}}} → "${value}" is empty for the active voice`);
            }

            this.pushClip(out, pick, defaultChannel, value);

            break;
          }

          const path = this.deps.pools.substituteVoice(value);
          this.assertClipAvailable(path, `var {{${step.name}}}`);
          this.pushClip(out, path, defaultChannel);

          break;
        }

        case "pool": {
          // A slashed name addresses the voice's own clip groups directly
          // (`group/base`, issue #1064) — the same reference form a var
          // resolver returns. Registered names never carry a slash.
          const slashed = step.name.includes("/");
          const key = slashed ? `pool:${step.name}` : step.name;
          const pick = slashed
            ? this.deps.pools.pickFromPoolRef(key, session, step.noRepeat)
            : this.deps.pools.pickFromPool(step.name, session, step.noRepeat);

          if (!pick) throw new ExpansionAbort(`pool "${step.name}" resolved to nothing for the active voice`);

          const path = this.deps.pools.substituteVoice(pick);
          this.assertClipAvailable(path, `pool "${step.name}"`);
          this.pushClip(out, path, defaultChannel, key);

          break;
        }

        case "connector": {
          const pick = this.deps.pools.pickFromPool(CONNECTOR_POOL, session, true);

          if (!pick) throw new ExpansionAbort(`connector pool resolved to nothing`);

          const path = this.deps.pools.substituteVoice(pick);
          this.assertClipAvailable(path, `connector`);
          this.pushClip(out, path, defaultChannel, CONNECTOR_POOL);

          break;
        }

        case "include": {
          if (visitedIncludes.has(step.id)) {
            throw new Error(`include cycle: ${Array.from(visitedIncludes).join(" → ")} → ${step.id}`);
          }

          const target = this.deps.contracts.get(step.id);

          if (!target) throw new Error(`include target not found: ${step.id}`);

          // Only a legacy closure sequence ever carries an include here: a
          // script's includes target the script's own fragments and are
          // inlined at compile time (issue #1065). A contract has no sequence
          // of its own to splice in, so a legacy include may not target one.
          if (target.resolvedSequence === null) throw new Error(`include target has no sequence: ${step.id}`);

          const nested = this.expandSequence(
            target.resolvedSequence,
            target.raw.base,
            defaultChannel,
            ctx,
            new Set([...visitedIncludes, step.id]),
            session,
          );
          out.push(...nested);
          break;
        }

        case "if": {
          let predicateResult = false;

          try {
            predicateResult = step.predicate(ctx);
          } catch (err) {
            this.logger.error(`Conditional predicate threw: ${err instanceof Error ? err.message : String(err)}`);
          }

          const branch = predicateResult ? step.then : (step.else ?? []);
          out.push(...this.expandSequence(branch, base, defaultChannel, ctx, visitedIncludes, session));
          break;
        }

        case "case": {
          // The resolver returns a key; the script maps keys to steps (issue
          // #1064). An unmapped key takes the script's `default` branch, or
          // nothing — the completeness of the mapping is the pack's business.
          // A key the resolver never DECLARED is a code bug: warned once, then
          // treated as unmapped.
          out.push(
            ...this.expandSequence(
              this.deps.vocabulary.pickCaseBranch(step, ctx),
              base,
              defaultChannel,
              ctx,
              visitedIncludes,
              session,
            ),
          );
          break;
        }

        case "optional": {
          // A genuinely-optional clause (issue #835): a member resolving to
          // nothing skips the WHOLE group locally — never half a clause —
          // and the rest of the callout still plays. Each recursive call
          // builds its own op list, so a mid-group abort discards the
          // group's partial ops cleanly.
          try {
            out.push(...this.expandSequence(step.steps, base, defaultChannel, ctx, visitedIncludes, session));
          } catch (err) {
            if (!(err instanceof ExpansionAbort)) throw err;

            this.logger.debug(`optional clause skipped — ${err.reason}`);
          }

          break;
        }

        case "ambient":
          out.push({ kind: "ambient", action: step.action });
          break;

        case "pause":
          out.push({ kind: "pause", ms: step.ms });
          break;
      }
    }

    return out;
  }

  /**
   * Guard a resolved clip path against the manifest (issue #835): a required
   * clip the active voice doesn't have aborts the whole callout — never a
   * half-sentence. `{ optional: [...] }` groups catch the abort locally.
   */
  private assertClipAvailable(path: string, what: string): void {
    if (this.deps.pools.hasClip(path)) return;

    throw new ExpansionAbort(`${what} → "${path}" is not in the manifest for the active voice`);
  }

  /**
   * Push a clip op, routing walkie-talkie ticks to SFX and everything else to
   * the default channel. `pool` is the key the clip was drawn from, given only
   * for a pool-drawn pick — see `ExecOp` and `opsEqual` (issue #1136).
   */
  private pushClip(out: ExecOp[], path: string, defaultChannel: AudioChannel, pool?: string): void {
    const channel = this.channelForPath(path, defaultChannel);

    out.push({ kind: "play", channel, path, pool });
  }

  private channelForPath(path: string, defaultChannel: AudioChannel): AudioChannel {
    const { ticks } = this.deps.pools.currentManifest();

    if (path === ticks.open || path === ticks.close) return AudioChannel.SFX;

    return defaultChannel;
  }
}

/**
 * Wrap an expanded body in its expanded frame — unless there is no frame, or
 * the body holds no clip: no callout ever plays bare ticks around nothing,
 * so a body of ambience or pauses alone, or an empty one, stays as it is and
 * the frame is discarded. The frame's cut tail (issue #1407) is handed back
 * beside the ops when the frame was applied, and is empty when it was not.
 *
 * The ORDER the two were expanded in is decided in `prepare` from the
 * body's steps, before either runs (`canProducePlay`): a body that can never
 * hold a clip — ambience or pauses alone, at every nesting — never has its
 * frame expanded at all, so a broken frame cannot kill it and earns no warn
 * for it; a body that can hold one has its frame expanded FIRST, so a frame
 * that aborts can commit none of the body's side effects. That case is
 * hypothetical rather than actual since #1138 — a body step commits nothing
 * now that the furled marking is the contract's `speakGate`, and a
 * registered condition must stay a pure read — and the order is kept
 * because it costs nothing and holds whatever a body is later asked to do.
 * Between the two sits the one accepted cost: a body that could speak but
 * expands to nothing this time (a script `if` that said no) is dropped by a
 * broken frame rather than played bare — it would have played nothing
 * anyway — and the frame's warn fires, because the frame is due for that
 * callout whenever its body speaks. Knowing the dynamic answer before the
 * body runs would mean running it, which is exactly what the order avoids
 * committing to.
 */
function applyFrame(body: ExecOp[], frame: ExpandedFrame | null): PreparedFire {
  // The cut tail (issue #1407) goes with the frame: a body left bare has no
  // radio to let go of, so an end stops it silently.
  if (frame === null || !body.some((op) => op.kind === "play")) return { ops: body, cutTail: [] };

  return { ops: [...frame.open, ...body, ...frame.close], cutTail: frame.cut };
}

/**
 * Whether a body's steps could expand to a `play` op at all — read off the
 * steps, without expanding them, so it commits nothing. `clip`, `var`,
 * `pool`, `connector` and `include` can (an include's fragment is not
 * inspected: the conservative answer is what keeps `prepare`'s order
 * right); `ambient` and `pause` never can; the branching forms can iff a
 * branch can.
 */
function canProducePlay(steps: readonly ResolvedStep[]): boolean {
  return steps.some((step) => {
    switch (step.kind) {
      case "optional":
        return canProducePlay(step.steps);
      case "if":
        return canProducePlay(step.then) || (step.else !== undefined && canProducePlay(step.else));
      case "case":
        return canProducePlay(step.fallback) || [...step.of.values()].some(canProducePlay);
      case "ambient":
      case "pause":
        return false;
      default:
        return true;
    }
  });
}

/**
 * The user's two frame switches, applied to a frame's steps BEFORE any of
 * them expands (issue #1064): `ambient` steps stay iff `ambience`, every
 * other sound leaf iff `beeps` — by kind, which is by position in the frame,
 * so a pack's own beep clip is governed exactly like the built-in tick. A
 * step the user switched off is never expanded, so a missing clip behind it
 * can never abort the callout. The branching forms (`optional`, `if`,
 * `case`) and `include` are structure rather than sound and are kept — the
 * branches with their contents filtered, an include as it is, since its
 * fragment is only known once expanded and the post-expansion op filter in
 * `expandFrame` is what sorts its ops — so an `if` around the ambience bed,
 * or a fragment carrying it, still keeps the bed when only beeps are off.
 * The include case is reachable only from a legacy closure sequence: a
 * script's includes are inlined by the compiler (issue #1065), so a frame
 * from a script arrives here with its fragments already spliced in and
 * filtered by kind like any other step.
 */
function filterFrameSteps(steps: readonly ResolvedStep[], options: FrameOptions): ResolvedStep[] {
  const out: ResolvedStep[] = [];

  for (const step of steps) {
    switch (step.kind) {
      case "optional":
        out.push({ ...step, steps: filterFrameSteps(step.steps, options) });
        break;
      case "if":
        out.push({
          ...step,
          then: filterFrameSteps(step.then, options),
          else: step.else ? filterFrameSteps(step.else, options) : undefined,
        });
        break;
      case "case":
        out.push({
          ...step,
          of: new Map([...step.of].map(([key, branch]) => [key, filterFrameSteps(branch, options)])),
          fallback: filterFrameSteps(step.fallback, options),
        });
        break;
      case "include":
        out.push(step);
        break;
      case "ambient":
        if (options.ambience) out.push(step);

        break;
      default:
        if (options.beeps) out.push(step);

        break;
    }
  }

  return out;
}
