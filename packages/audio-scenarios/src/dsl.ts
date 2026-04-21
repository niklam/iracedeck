/**
 * Scenario DSL — types for the audio scenario catalog.
 *
 * A scenario is data: a triggering event, a sequence of `Step`s, and
 * metadata (priority, cooldown, preempt, channel/bus routing). The
 * interpreter resolves steps against registered pools and variables, then
 * drives `@iracedeck/audio-service` to produce the audio.
 *
 * See `docs/plans/2026-04-19-audio-architecture-design.md` §7 for rationale.
 */
import type { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventName, SimEventOf } from "@iracedeck/event-bus";

/** A scenario's priority affects scheduling when another scenario is playing. */
export type ScenarioPriority = "low" | "normal" | "high" | "urgent";

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
  priority?: ScenarioPriority;
  /** Minimum ms between successive fires of this scenario id. */
  cooldown?: number;
  /** If true and priority is "urgent", cancels the currently-playing scenario on the same bus. */
  preempt?: boolean;
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
 *   applyBase("pit-engineer", "greeting/alright.mp3")   → "pit-engineer/greeting/alright.mp3"
 *   applyBase("pit-engineer", "/sfx/IRD-tick-open.mp3") → "sfx/IRD-tick-open.mp3"
 *   applyBase(undefined,      "sfx/IRD-tick-open.mp3")  → "sfx/IRD-tick-open.mp3"
 */
export function applyBase(base: string | undefined, path: string): string {
  if (path.startsWith("/")) return path.slice(1);

  if (!base) return path;

  return `${base}/${path}`;
}
