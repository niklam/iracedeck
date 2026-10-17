/**
 * The Replay Control dial's paced search (#801): one runner per process that
 * steps a pending count of lap, session or incident searches through
 * iRacing's own searches, one on its way at a time, as a policy on the replay
 * command gate (`shared/replay-command-gate.ts`, #1430) and never a gate of
 * its own. Design: docs/superpowers/specs/2026-10-12-issue-801-replay-control-dial-stepping.md,
 * "The paced search".
 */

/** What a paced search steps through. */
export type ReplaySearchTarget = "lap" | "session" | "incident";

/** The count clamp (maintainer, 2026-10-12). */
export const SEARCH_QUEUE_MAX = 10;

/** The runner's patience floor and cap for a search nothing shows on its way (ms). */
export const SEARCH_PATIENCE_MIN_MS = 1_600;
export const SEARCH_PATIENCE_MAX_MS = 3_000;

/** One turn's contribution to the queue. */
export interface ReplaySearchTurn {
  readonly target: ReplaySearchTarget;
  /** Signed detents: positive is next, negative previous; never 0. */
  readonly ticks: number;
  /** The turning dial's origin token (its context id), for #1430's state seam. */
  readonly origin: string;
  /** The cursor owner name the runner claims under, e.g. `replay-control-dial lap`. */
  readonly owner: string;
}

/** What the queue shows a dial: the pending count for one target, or null when no run is under way. */
export interface ReplaySearchPending {
  readonly target: ReplaySearchTarget;
  /** Signed: what is left to step, after the search on its way. */
  readonly count: number;
  /** The token of the dial whose turn started the run. */
  readonly origin: string;
}

/**
 * Adds a turn to the pending count and starts the runner when none is
 * running. A turn for another target than the run's replaces the count and
 * starts a run of its own (the first ends superseded). Returns at once; the
 * runner works in the background and `onChange` listeners hear each step.
 */
export function queueReplaySearch(turn: ReplaySearchTurn): void {
  void turn;
  throw new Error("not implemented");
}

/** The run under way, or null. */
export function pendingReplaySearch(): ReplaySearchPending | null {
  throw new Error("not implemented");
}

/** Whether a run is under way for `target` (a Lap or Session turn then goes to the count, not the record). */
export function isReplaySearchRunning(target: ReplaySearchTarget): boolean {
  void target;
  throw new Error("not implemented");
}

/** Hears every change of the pending count and the run's end, so a dial re-renders. Returns the unsubscribe. */
export function onReplaySearchChange(listener: () => void): () => void {
  void listener;
  throw new Error("not implemented");
}

/** @internal Exported for testing: ends any run and clears the queue. */
export function _resetReplaySearchQueue(): void {
  throw new Error("not implemented");
}
