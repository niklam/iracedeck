/**
 * Scenario DSL — types for the audio scenario catalog.
 *
 * A scenario is data: a triggering event, a sequence of `Step`s, and
 * metadata (weight, cooldown, interrupt/queueable, channel/bus routing). The
 * interpreter resolves steps against registered pools and variables, then
 * drives `@iracedeck/audio-service` to produce the audio.
 *
 * See `docs/plans/2026-04-19-audio-architecture-design.md` §7 for rationale.
 */
import type { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventName, SimEventOf } from "@iracedeck/event-bus";

/**
 * Named scheduling-weight bands (issue #652). A scenario's `weight` decides
 * which fire wins a busy bus — higher always wins. Bands are conventions for
 * readability; any integer is valid, and the gaps leave room for custom tuning.
 */
export const WEIGHT = {
  /**
   * Terse, time-sensitive callouts that must never defer or preempt — they
   * play only when the bus is idle and drop otherwise. Pair with
   * `queueable: false`. (The pit-box count-in originally sat here per #646;
   * #758 moved it above CHATTER so it wins the bus over the readback.)
   */
  TRANSIENT: 5,
  /**
   * Background commentary that yields to anything more important (position
   * readouts, race-status, pit readback, service-reminder). Pair with
   * `queueable: true` to keep the defer-and-replay behaviour.
   */
  CHATTER: 10,
  /** Default band for ordinary callouts (applied when `weight` is omitted). */
  NORMAL: 50,
  /**
   * Safety / time-critical information that should win the bus over routine
   * chatter (flag calls, pit-lane phase announcements) and sit above an
   * exclusive-focus floor.
   */
  SAFETY: 70,
  /** Must-hear lines that cut anything below them (meatball, fuel-critical). Pair with `interrupt: true`. */
  CRITICAL: 100,
} as const;

/** Scheduling weight applied when a scenario omits `weight`. */
export const DEFAULT_WEIGHT: number = WEIGHT.NORMAL;

/**
 * Runtime context passed to conditional `if` steps and `where` predicates.
 *
 * `telemetry` is the snapshot carried by the event envelope (may be undefined
 * for fires triggered imperatively via `engine.fire(id)`).
 */
export type ScenarioContext = {
  /** The triggering event envelope, or null if the scenario was fired imperatively. */
  event: SimEventOf<SimEventName> | null;
  /** Shortcut to `event.telemetry`. Unknown since the catalog is sim-agnostic. */
  telemetry: unknown;
  /** Shortcut to `event.data`. Payload type depends on the event. */
  data: unknown;
  /** Timestamp when the fire was initiated. */
  now: number;
  /** Resolved variable values at fire time (populated during sequence expansion). */
  vars: Record<string, string | null>;
};

/**
 * A single step in a scenario sequence.
 *
 * Strings are shorthand for one of the object forms (see `parseStepShorthand`).
 *
 * `{ optional: [...] }` (issue #835) marks a genuinely-optional clause: when
 * any clip-producing step inside it resolves to nothing for the active voice,
 * the WHOLE group is skipped locally (never half a clause) and the rest of
 * the callout still plays. Outside an optional group, a step that resolves
 * to nothing aborts the entire callout instead.
 */
export type Step =
  | string
  | { clip: string }
  | { var: string }
  | { pool: string; noRepeat?: boolean }
  | { connector: true }
  | { pause: number }
  | { include: string }
  | { if: (ctx: ScenarioContext) => boolean; then: Step[]; else?: Step[] }
  | { optional: Step[] }
  | { ambient: "start" | "stop" | "seek" };

/**
 * A scenario — the core unit of the audio catalog.
 *
 * Scenarios without `when` never auto-fire; consumers trigger them via
 * `engine.fire(id)` (used for PI "Test" buttons).
 */
export type Scenario = {
  id: string;
  when?: {
    event: SimEventName;
    where?: (e: SimEventOf<SimEventName>) => boolean;
  };
  channel: AudioChannel;
  bus: AudioBus;
  /**
   * Scheduling weight — higher weight wins a busy bus. Defaults to
   * `WEIGHT.NORMAL`. See the `WEIGHT` bands for the conventional values; any
   * integer is allowed.
   */
  weight?: number;
  /**
   * When this fire wins a busy bus over an in-flight LOWER-weight fire, cut
   * that fire mid-sentence immediately (`true`) instead of waiting for its
   * current line to finish before playing (`false`, the default). Equal- or
   * lower-weight fires never cut what's playing — they defer or drop.
   */
  interrupt?: boolean;
  /**
   * When this fire cannot take the bus right now (a higher- or equal-weight
   * fire is playing, or it is below an exclusive-focus floor), defer it and
   * replay when the bus next idles (`true`) instead of dropping it outright
   * (`false`, the default). The deferred fire replays unconditionally — its
   * `where:` is NOT re-evaluated (a `where:` that commits a side effect, like
   * the position-readout cooldown claim, would fail on a second call);
   * freshness comes from var resolvers reading live state at speak time.
   */
  queueable?: boolean;
  /**
   * When an `interrupt` cuts this queueable fire mid-playback, remember how
   * far it got and CONTINUE from the interrupted clip at idle-replay instead
   * of re-firing from the top (`true`; issue #758). The replay re-expands the
   * sequence first: an unchanged expansion resumes at the interrupted clip
   * (re-keying the radio frame with the open tick when one was already
   * opened); a changed expansion — the snapshot moved on while stashed —
   * falls back to a full fresh replay, preserving the #481 freshness
   * guarantee. Requires `queueable: true` (validated at load time). Because
   * the resume decision re-expands the sequence, `if:` predicates of a
   * resumable scenario must be side-effect-free, and pool draws may differ
   * between expansions (forcing the full-replay path) — best suited to
   * deterministic sequences like the pit-service readback.
   */
  resumable?: boolean;
  /**
   * After this fire finishes, hold the bus's pending replay for N ms instead
   * of draining it immediately (issue #758). A scenario that arrives in a
   * train of related fires (e.g. the pit-box count-in marks, ~1 s apart)
   * declares this so a fire it displaced doesn't stutter back into the gaps
   * between its family-mates — the hold re-arms after each mark and the
   * displaced fire plays once the train has been quiet for the window. A new
   * fire taking the bus cancels the hold; it re-arms when that fire finishes.
   */
  pendingHoldMs?: number;
  /** Minimum ms between successive fires of this scenario id. */
  cooldown?: number;
  /**
   * Marks this scenario as belonging to an exclusive-focus owner (see
   * `IScenarioEngine.acquireFocus`). While a focus floor is held on this
   * scenario's bus, the owner's own fires bypass the floor; every other fire
   * needs `weight` at or above the floor to play.
   */
  focusOwner?: string;
  /**
   * Family identifier — scenarios sharing a `family` preempt each other on
   * the same bus regardless of weight. Use this for groups where a new
   * event invalidates a prior callout (e.g. all tire-set scenarios share
   * `family: "tire"` so a new selection cancels the in-flight one).
   * Scenarios without a family use the weight-based scheduling rules only.
   */
  family?: string;
  /**
   * Defer the where: predicate and sequence-expansion (including var
   * resolution) by N milliseconds after the trigger event. Use this when the
   * data the scenario needs takes a moment to settle in the underlying
   * telemetry — e.g. iRacing's `session.changed` lands on a tick where
   * `TrackWetness` may still read `Unknown` for a beat. A leading
   * `{ pause: N }` step inside the sequence does NOT solve this — vars are
   * resolved at expansion time (synchronously when the scenario fires),
   * before any pause executes. `triggerDelay` delays the entire fire decision
   * so the where: predicate and var resolvers see telemetry that has
   * settled.
   *
   * Behavior:
   *   - On event arrival, the where: predicate is NOT evaluated immediately.
   *   - The engine schedules a one-shot timer for N ms.
   *   - When the timer fires, where: is evaluated against current state
   *     (telemetry may have changed since the trigger event landed).
   *   - If where: returns true, attemptFire runs and vars are resolved
   *     against current telemetry.
   *   - If a new event for the same scenario arrives while a timer is
   *     pending, the pending timer is canceled and replaced with a fresh
   *     one — the most recent event wins.
   *
   * The bus is NOT locked during the delay window, so other scenarios can
   * still fire and claim the channel; if the bus is busy when the delayed fire
   * attempts, the standard weight/family scheduling rules apply (wait, defer,
   * drop, or cut).
   */
  triggerDelay?: number;
  /** Optional path prefix applied to clip/pool members; leading `/` on a path escapes it. */
  base?: string;
  sequence: Step[];
};

/** Resolved step after shorthand parsing — what the interpreter actually walks. */
export type ResolvedStep =
  | { kind: "clip"; path: string }
  | { kind: "var"; name: string }
  | { kind: "pool"; name: string; noRepeat: boolean }
  | { kind: "connector" }
  | { kind: "pause"; ms: number }
  | { kind: "include"; id: string }
  | { kind: "if"; predicate: (ctx: ScenarioContext) => boolean; then: ResolvedStep[]; else?: ResolvedStep[] }
  | { kind: "optional"; steps: ResolvedStep[] }
  | { kind: "ambient"; action: "start" | "stop" | "seek" };

/**
 * Parse a shorthand string into a resolved step.
 *
 * Rules:
 *   "pool:<name>"       → pool (noRepeat: true)
 *   "pause:<number>"    → pause (ms)
 *   "@<id>"             → include
 *   "{{<name>}}"        → var
 *   everything else     → clip (path)
 */
export function parseStepShorthand(s: string): ResolvedStep {
  if (s.startsWith("pool:")) {
    return { kind: "pool", name: s.slice("pool:".length), noRepeat: true };
  }

  if (s.startsWith("pause:")) {
    const ms = Number(s.slice("pause:".length));

    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`Invalid pause duration: ${s}`);
    }

    return { kind: "pause", ms };
  }

  if (s.startsWith("@")) {
    return { kind: "include", id: s.slice(1) };
  }

  const varMatch = /^\{\{(.+)\}\}$/.exec(s);

  if (varMatch) {
    return { kind: "var", name: varMatch[1] };
  }

  return { kind: "clip", path: s };
}

/**
 * Convert a `Step` (string or object) into its `ResolvedStep` form.
 *
 * Object forms pass through with a minor normalization (e.g. `connector: true`
 * becomes `{ kind: "connector" }`).
 */
export function resolveStep(step: Step): ResolvedStep {
  if (typeof step === "string") {
    return parseStepShorthand(step);
  }

  if ("clip" in step) return { kind: "clip", path: step.clip };

  if ("var" in step) return { kind: "var", name: step.var };

  if ("pool" in step) {
    return { kind: "pool", name: step.pool, noRepeat: step.noRepeat ?? true };
  }

  if ("connector" in step) return { kind: "connector" };

  if ("pause" in step) return { kind: "pause", ms: step.pause };

  if ("include" in step) return { kind: "include", id: step.include };

  if ("ambient" in step) return { kind: "ambient", action: step.ambient };

  if ("optional" in step) {
    return { kind: "optional", steps: step.optional.map(resolveStep) };
  }

  if ("if" in step) {
    return {
      kind: "if",
      predicate: step.if,
      then: step.then.map(resolveStep),
      else: step.else?.map(resolveStep),
    };
  }

  throw new Error(`Unrecognized step shape: ${JSON.stringify(step)}`);
}

/**
 * Apply a scenario's `base` to a clip path. Leading `/` escapes the base.
 *
 *   applyBase("pit-crew", "greeting/alright.mp3")   → "pit-crew/greeting/alright.mp3"
 *   applyBase("pit-crew", "/sfx/IRD-tick-open.mp3") → "sfx/IRD-tick-open.mp3"
 *   applyBase(undefined,      "sfx/IRD-tick-open.mp3")  → "sfx/IRD-tick-open.mp3"
 */
export function applyBase(base: string | undefined, path: string): string {
  if (path.startsWith("/")) return path.slice(1);

  if (!base) return path;

  return `${base}/${path}`;
}

/**
 * Build a dynamic pool reference for a `var` resolver to return (issue #836):
 * `pool:<group>/<base>`. The interpreter derives the pool's members from the
 * manifest for the active voice at fire time — every
 * `voice/<voice>/<group>/<base>-NN.mp3` plus the bare `<base>.mp3` — so
 * value-indexed clips (numbers, names, temps, digits) are pools too, usually
 * of size 1, and gain variants by just adding clip files. A reference that is
 * empty for the active voice aborts the callout (or skips its `optional`
 * group) per the issue #835 rule.
 */
export function poolRef(group: string, base: string): string {
  return `pool:${group}/${base}`;
}
