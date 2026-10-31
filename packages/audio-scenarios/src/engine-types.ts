/**
 * The types the scenario engine's modules share (issue #1514): what a
 * registered contract is at runtime, what a fire looks like waiting, playing
 * or stashed, the ops an expansion produces, and the abort signal. None of
 * them is a published contract — the package index exports nothing from here
 * — and no module owns them: each field has one writer, named on the field or
 * in the owning module.
 */
import type { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventName, SimEventOf } from "@iracedeck/event-bus";

import type { ResolvedStep, ScenarioContext, ScenarioContract } from "./dsl.js";
import type { PendingQueue } from "./pending-queue.js";

export type CompiledScenario = {
  raw: ScenarioContract;
  /**
   * The sequence a legacy `Scenario` welded on, resolved once at definition;
   * `null` for a contract, whose body is looked up in the active voice's
   * compiled script at fire time (issue #1064).
   */
  resolvedSequence: ResolvedStep[] | null;
  /** The default frame name (`s.frame ?? DEFAULT_FRAME`); a script entry may override it. */
  frame: string;
  enabled: boolean;
  unsubscribe: (() => void) | null;
  lastFireAt: number;
  /**
   * Active `triggerDelay` timer handle, if any — or the current hop of a
   * `settle` wait (issue #1284), which re-arms it for each re-ask. New event
   * arrivals cancel and replace the pending timer so the most recent trigger
   * wins. Cleared on timer expiry, on disable (`setEnabled(false)`), and on
   * `defineScenario` replacement.
   */
  pendingTriggerTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * A fire waiting for the bus to idle — either a higher-weight fire that won
 * the bus but is letting the current line finish (no `interrupt`), a
 * lower/equal-weight `queueable` fire deferred behind what's playing or
 * below a focus floor, or a queueable fire an interrupt cut. It is the
 * payload of one entry in the bus's `PendingQueue` (issue #1185).
 * Retains the triggering event so the replay resolves vars against the same
 * payload the original fire would have used — critical for scenarios whose
 * vars or conditions read the event's payload or telemetry snapshot.
 */
export type WaitingFire = {
  id: string;
  event: SimEventOf<SimEventName> | null;
  weight: number;
  /**
   * Present when an `interrupt` cut a `resumable` fire mid-playback: the
   * fire's full expanded ops and the index of the op that was in flight when
   * it was cut. The idle-replay uses this to continue from the interrupted
   * clip instead of re-firing from the top (issue #758).
   */
  resume?: ResumeState;
  /**
   * Whether this fire had already passed its contract's `speakGate` (issue
   * #1138) when it was parked: `true` for a fire an interrupt cut out of
   * playback (whether or not it carries a `resume`), and carried along by
   * every re-park of such a fire; `false` for a fire deferred before it ever
   * expanded (a `queueable` fire behind a busier line), which is asked at
   * replay. The replay's `prepareOps` skips the gate iff this is set — a
   * fire that already passed the gate, cut and stashed, resumed, or replayed
   * whole, is not asked again, and a claiming gate is never asked to refuse
   * its own claim. An explicit flag rather than `resume !== undefined`:
   * a non-`resumable` fire is stashed without a resume and replays whole.
   */
  admitted: boolean;
  /**
   * When the fire was FIRST deferred (issue #1185). The max wait is measured
   * from it, and a replay that is deferred again keeps it, so a fire cannot
   * outlive its max wait by being re-parked. A fire an interrupt cut out of
   * playback is a new deferral and starts a new one.
   */
  queuedAt: number;
};

/** Where an interrupted resumable fire left off, for continuation at idle-replay. */
export type ResumeState = {
  /** The interrupted fire's FULL original expansion. */
  ops: readonly ExecOp[];
  /** Index of the op that was in flight when the fire was cut. */
  index: number;
  /**
   * The active voice, and the engine's expansion `generation`, at the moment
   * of the cut (issue #1136). Both must still hold at idle-replay or the fire
   * replays whole: since a pool-drawn op compares by its POOL key, and that
   * key is voice-independent and survives a redefinition of what the pool
   * holds, `opsEqual` alone would let an all-pool body resume its tail in a
   * different voice than its head, or against a pack that changed under it.
   */
  voice: string | null;
  generation: number;
};

/**
 * Per-bus execution state. Each audio bus can independently be playing a
 * scenario, holding deferred fires for replay on idle, and/or holding an
 * exclusive-focus floor.
 */
export type BusState = {
  playingId: string | null;
  /** The fires waiting to play when the bus next idles (issue #1185). */
  queue: PendingQueue<WaitingFire>;
  activeFire: ActiveFire | null;
  /** Exclusive-focus floor (issue #652); non-owner fires need weight at or above `floor`. */
  focus: { ownerId: string; floor: number } | null;
  /**
   * Armed by `finishFire` when the finished scenario declares `pendingHoldMs`
   * and fires are waiting: the drain runs when the timer expires instead of
   * immediately. Cancelled when a new fire takes the bus (it re-arms at that
   * fire's finish), by `stopAll` (issue #758) and by the session-change
   * clear (issue #1185).
   */
  pendingHoldTimer: ReturnType<typeof setTimeout> | null;
};

export type ActiveFire = {
  id: string;
  bus: AudioBus;
  /** Scheduling weight of this fire — compared against arriving fires. */
  weight: number;
  ops: ExecOp[];
  index: number;
  /**
   * Source mapping back to the fire's FULL original expansion, so a resumed
   * fire that is cut AGAIN can stash its position in the original expansion
   * rather than in the resumed tail (issue #758). For a fresh fire,
   * `sourceOps === ops` with `sourceStart === prerollCount === 0`; for a
   * resumed fire, `ops` is `[re-open tick?] + sourceOps.slice(sourceStart)`.
   */
  sourceOps: ExecOp[];
  sourceStart: number;
  prerollCount: number;
  cancelled: boolean;
  pauseTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Channels this fire can touch — computed once from the expanded ops and
   * used by `cancelActiveFire` so we don't stop channels belonging to
   * scenarios running on other buses.
   */
  usedChannels: ReadonlySet<AudioChannel>;
  /**
   * Triggering event retained so a queueable fire that gets preempted (cut by
   * an `interrupt`, or deferred behind a busier bus) can be replayed with the
   * same `ctx.data` / `ctx.telemetry` it would have seen originally. Mirrors
   * the `WaitingFire.event` shape.
   */
  event: SimEventOf<SimEventName> | null;
  /**
   * The engine's `sessionGeneration` when this fire took the bus (issue
   * #1185). An interrupt that cuts it in a later session does not stash it.
   */
  sessionGeneration: number;
  /**
   * What an end plays once words have been heard (issue #1407): the frame's
   * `cut` — else its `close` — expanded and tagged `cut` with the fire. The
   * cut's clips are spoken on the callout's channel and only its built-in
   * ticks are sound effects, so Radio beeps drops only those ticks; Pit
   * ambience drops its ambient ops. A close fallback plays as the close
   * does, every clip a sound effect. Empty for a fire with no frame
   * around its body (`frame: "none"`, or a body with no clip), for a contract
   * without `endsOn` (nothing ever ends it), and for the frame preview. Only
   * `endFires` plays it: a fire cut for any other reason plays nothing more.
   */
  cutTail: ExecOp[];
  /**
   * `true` for the fire an end put on the bus to play the cut tail (issue
   * #1407). A second end is a no-op for it, and an interrupt that cuts it
   * never stashes it: an ended line is never re-queued.
   */
  ended: boolean;
  /**
   * Run once when the fire leaves the bus, whether it finished or was cut
   * (`settle`). Only the frame preview sets it (issue #1124): its caller
   * holds the Background bus open for the preview and must release it
   * however the preview ends.
   */
  onSettled?: () => void;
};

/**
 * A playing fire as every module but playback sees it (issue #1514): every
 * field read-only, `ops`, `sourceOps` and `cutTail` as `ReadonlyArray`, and
 * without the two transport internals only playback touches (`pauseTimer`,
 * `onSettled`). The scheduler and the line ends read a bus's active fire
 * through this and change it only by calling playback.
 */
export type ActiveFireView = Readonly<
  Omit<ActiveFire, "ops" | "sourceOps" | "cutTail" | "pauseTimer" | "onSettled">
> & {
  readonly ops: readonly ExecOp[];
  readonly sourceOps: readonly ExecOp[];
  readonly cutTail: readonly ExecOp[];
};

/**
 * Which part of the radio frame an op came from (issue #1064): its open, its
 * close, or the cut tail an end plays in place of the close (issue #1407).
 */
export type FrameSide = "open" | "close" | "cut";

/**
 * Post-expansion execution ops. Each op is either a blocking play (wait for
 * channel-complete) or a fire-and-forget side-effect (ambient, pause).
 *
 * `frame` tags an op the frame contributed, by POSITION — `expandFrame` sets
 * it on everything the frame's `open` / `close` / cut tail expanded to, and
 * nothing else carries it. It is what identifies the frame afterwards: the
 * resume-from-interrupt re-key replays the ops tagged `open`, and two
 * expansions are equal only if their tags agree. Never by clip path — a
 * pack's frame plays whatever clips the pack put there, and a body is free
 * to play the built-in tick as an ordinary clip.
 *
 * `pool` names the pool a play op's clip was DRAWN from — the registered
 * name, or the `pool:<group>/<base>` reference for a slashed pool step or a
 * var resolver's reference — and is absent on a clip step or a var resolving
 * to a path. `opsEqual` compares such an op by that key rather than by the
 * take drawn, since which recording of a slot came up is not part of what a
 * body says (issue #1136).
 */
export type ExecOp =
  | { kind: "play"; channel: AudioChannel; path: string; pool?: string; frame?: FrameSide }
  | { kind: "ambient"; action: "start" | "stop" | "seek"; frame?: FrameSide }
  | { kind: "pause"; ms: number; frame?: FrameSide };

/**
 * A frame's two halves, expanded and tagged, ready to wrap a body
 * (`applyFrame`), and the cut tail an end plays instead of the close (issue
 * #1407): the frame's `cut`, else its `close`, tagged `cut` — or empty when
 * the fire was expanded without one (see `expandFrame`).
 */
export type ExpandedFrame = { open: ExecOp[]; close: ExecOp[]; cut: ExecOp[] };

/**
 * What `prepareOps` hands a fire to play: its ops, and the cut tail an end
 * plays once words have been heard (issue #1407, see `ActiveFire.cutTail`).
 */
export type PreparedFire = { ops: ExecOp[]; cutTail: ExecOp[] };

/**
 * Internal control-flow signal (issue #835): a REQUIRED clip-producing step
 * resolved to nothing during expansion — missing clip for the active voice,
 * null var, or empty pool. Thrown by `expandSequence`, caught locally by
 * `{ optional: [...] }` groups, and otherwise surfaced to `prepareOps`, which
 * skips the whole callout so a fragment is never spoken. The abort is decided
 * BEFORE any bus cancellation (see `attemptFire`), so an aborting fire can
 * never silence an in-flight one.
 */
export class ExpansionAbort {
  constructor(readonly reason: string) {}
}

/**
 * The bus id the frame preview plays under (issue #1124). Not a scenario:
 * no contract is registered with it, so every lookup by it misses — no
 * cooldown, no pending hold, nothing to stash when it is cut.
 */
export const FRAME_PREVIEW_ID = "(frame preview)";

/** The context a fire's resolvers, predicates and gates read (`ScenarioContext`); `vars` fill in during expansion. */
export function fireContext(event: SimEventOf<SimEventName> | null): ScenarioContext {
  return {
    event,
    telemetry: event?.telemetry ?? null,
    data: event?.data ?? null,
    now: Date.now(),
    vars: {},
  };
}

/**
 * Code-point order, not `localeCompare`: both reports feed a generated
 * reference (#1066) and a completeness test, and a locale-aware sort would
 * order the same names differently from one machine's ICU to another's.
 */
export function codePointOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
