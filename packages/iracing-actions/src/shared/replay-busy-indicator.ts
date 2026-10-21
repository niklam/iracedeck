/**
 * The replay busy indicator (#1437): what the pressed replay key or dial shows while its press is
 * worked on — working (a stepped spinner), waiting (a still mark) or not done (a red cross for one
 * second).
 *
 * It reads only the command gate's state seam (#1430): the per-token view and the notices. It
 * decides nothing about the replay and sends nothing; "landed" has one definition, the gate's.
 * The one input that never reaches the gate is a press the action ignored itself, which the action
 * reports here directly ({@link reportReplayPressIgnored}).
 *
 * Everything timed lives here: one interval for the whole plugin, alive only while a registered
 * surface is showing working, and a one-shot timer per token for the second of not done. Every
 * tick reads the gate's view again, so a notice that never arrives costs one frame, not a spinner
 * that never ends. A spinner that has been showing for five minutes stops with a warning.
 *
 * Spec: docs/superpowers/specs/2026-10-13-issue-1437-replay-key-busy-look.md.
 */
import { type ILogger, silentLogger } from "@iracedeck/logger";
import {
  getReplayGateView,
  type ReplayGateEndReason,
  type ReplayGateFactEnd,
  type ReplayGateNotice,
  subscribeReplayGate,
} from "@iracedeck/replay-engine";

/** How often a spinning surface steps (ms): eight frames a second, eight frames to a turn. */
export const REPLAY_BUSY_FRAME_MS = 125;

/**
 * @internal Exported for testing
 *
 * The longest one run of a token shows working (ms). Reaching it means the gate reported a fact
 * that never ended, or a search on a recording far longer than designed for.
 */
export const REPLAY_BUSY_MAX_SHOW_MS = 300_000;

/**
 * @internal Exported for testing
 *
 * How long not done shows (ms).
 */
export const REPLAY_BUSY_NOT_DONE_MS = 1_000;

/**
 * What a token's surface shows. `tick` is the plugin-wide step counter, monotonic while the
 * interval runs: a key draws step `tick % 8`, a dial box `Math.floor(tick / 2) % 3`.
 */
export type ReplayBusyLook =
  | { readonly kind: "rest" }
  | { readonly kind: "working"; readonly tick: number }
  | { readonly kind: "waiting" }
  | { readonly kind: "not-done" };

export interface ReplayBusySurface {
  /** The surface's origin token: the context id of the key or dial, as passed to the gate. */
  readonly token: string;
  /**
   * Whether the surface's own command is a jump or a search. False for a speed key or Frame
   * Forward / Back: such a surface shows rest while only under way, and still shows waiting and
   * not done.
   */
  readonly drawsWorking: boolean;
  /** Draws the surface with `look`. Called only when the look changes, or on each step while working. */
  redraw(look: ReplayBusyLook): void;
}

interface Registration {
  readonly surface: ReplayBusySurface;
}

/** One run of a token showing working, for the ceiling. A new `since` is a new run. */
interface WorkingRun {
  readonly since: number;
  readonly shownAt: number;
  ceilingHit: boolean;
}

const REST: ReplayBusyLook = { kind: "rest" };
const WAITING: ReplayBusyLook = { kind: "waiting" };
const NOT_DONE: ReplayBusyLook = { kind: "not-done" };

let log: ILogger = silentLogger;
const surfaces = new Map<string, Registration>();
/** What the indicator last told each registered surface (or what it read on registering). */
const lastLooks = new Map<string, ReplayBusyLook>();
const notDoneTimers = new Map<string, ReturnType<typeof setTimeout>>();
const workingRuns = new Map<string, WorkingRun>();
let tick = 0;
let interval: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;

/** The logger the indicator's own lines go to. */
export function setReplayBusyIndicatorLogger(logger: ILogger): void {
  log = logger;
}

function unref(handle: ReturnType<typeof setTimeout>): void {
  const maybe = handle as { unref?: () => void };

  if (typeof maybe.unref === "function") maybe.unref();
}

/** The look of `token` from the state as it stands. Pure: it changes nothing. */
function computeLook(token: string): ReplayBusyLook {
  const registration = surfaces.get(token);

  if (registration === undefined) return REST;

  const view = getReplayGateView(token);

  if (view.waiting !== null) return WAITING;

  if (view.underWay !== null && registration.surface.drawsWorking) {
    const run = workingRuns.get(token);
    const ceilingHit = run !== undefined && run.since === view.underWay.since && run.ceilingHit;

    if (!ceilingHit) return { kind: "working", tick };
  }

  if (notDoneTimers.has(token)) return NOT_DONE;

  return REST;
}

/** What `token`'s surface shows now. An unregistered token shows rest. */
export function getReplayBusyLook(token: string): ReplayBusyLook {
  return computeLook(token);
}

/** Keeps the token's working run in step with the gate's view, and its first showing. */
function trackRun(token: string, look: ReplayBusyLook): void {
  const underWay = getReplayGateView(token).underWay;
  const run = workingRuns.get(token);

  if (underWay === null) {
    workingRuns.delete(token);

    return;
  }

  if (run !== undefined && run.since !== underWay.since) workingRuns.delete(token);

  if (look.kind === "working" && !workingRuns.has(token)) {
    workingRuns.set(token, { since: underWay.since, shownAt: Date.now(), ceilingHit: false });
  }
}

function clearNotDone(token: string): void {
  const timer = notDoneTimers.get(token);

  if (timer === undefined) return;

  clearTimeout(timer);
  notDoneTimers.delete(token);
}

function startNotDone(token: string): void {
  clearNotDone(token);

  const timer = setTimeout(() => {
    notDoneTimers.delete(token);
    update(token, "not-done-elapsed");
  }, REPLAY_BUSY_NOT_DONE_MS);

  unref(timer);
  notDoneTimers.set(token, timer);
}

function redraw(registration: Registration, look: ReplayBusyLook): void {
  try {
    registration.surface.redraw(look);
  } catch (err) {
    log.debug(`Replay busy redraw failed for ${registration.surface.token}: ${String(err)}`);
  }
}

function logChange(token: string, before: ReplayBusyLook, after: ReplayBusyLook, reason: string): void {
  if (after.kind === "rest") {
    log.debug(`Replay busy look ended: ${token} was ${before.kind} (${reason})`);
  } else {
    log.debug(`Replay busy look started: ${token} ${after.kind} (${reason})`);
  }
}

/**
 * Recomputes `token`'s look and redraws its surface if the kind changed. A drawn fact (waiting, or
 * working) cancels a pending not done, so a not done set while a fact stands is never shown for a
 * stale second after the fact ends cleanly.
 */
function update(token: string, reason: string): void {
  const registration = surfaces.get(token);

  if (registration === undefined) return;

  if (interval === null) tick = 0;

  const look = computeLook(token);

  trackRun(token, look);

  if (look.kind === "working" || look.kind === "waiting") clearNotDone(token);

  const before = lastLooks.get(token) ?? REST;

  if (before.kind !== look.kind) {
    lastLooks.set(token, look);
    logChange(token, before, look, reason);
    redraw(registration, look);
  }

  syncInterval();
}

function anyWorking(): boolean {
  for (const [token, look] of lastLooks) {
    if (look.kind === "working" && surfaces.has(token)) return true;
  }

  return false;
}

function syncInterval(): void {
  const working = anyWorking();

  if (working && interval === null) {
    interval = setInterval(step, REPLAY_BUSY_FRAME_MS);
    unref(interval);
  } else if (!working && interval !== null) {
    clearInterval(interval);
    interval = null;
    tick = 0;
  }
}

/** One frame: every token showing working reads the gate's view again and steps, or stops. */
function step(): void {
  tick++;

  const now = Date.now();

  for (const [token, registration] of [...surfaces]) {
    if (lastLooks.get(token)?.kind !== "working") continue;

    // A redraw earlier in this frame may have unregistered or replaced it.
    if (surfaces.get(token) !== registration) continue;

    let look = computeLook(token);
    let reason = "tick";

    trackRun(token, look);

    const run = workingRuns.get(token);

    if (look.kind === "working" && run !== undefined && now - run.shownAt >= REPLAY_BUSY_MAX_SHOW_MS) {
      run.ceilingHit = true;
      log.warn(
        `Replay busy look for ${token} has shown working for ${Math.round((now - run.shownAt) / 1000)} s; stopping it while the gate still reports it under way`,
      );
      look = computeLook(token);
      reason = "ceiling";
    }

    const before = lastLooks.get(token) ?? REST;

    lastLooks.set(token, look);

    if (look.kind !== "working") logChange(token, before, look, reason);

    redraw(registration, look);
  }

  syncInterval();
}

/**
 * Gave-up reasons that draw rest rather than not done: leaving the replay or losing the sim says the
 * press stopped mattering, not that it failed (Jump to Live ends its own search by leaving the replay).
 */
const GAVE_UP_WITHOUT_NOT_DONE: ReadonlySet<ReplayGateEndReason> = new Set(["replay-left", "disconnected"]);

/** Whether a fact's end shows not done: a give-up, other than by the replay being left or the sim lost. */
function endShowsNotDone(end: ReplayGateFactEnd): boolean {
  return end.class === "gave-up" && !GAVE_UP_WITHOUT_NOT_DONE.has(end.reason);
}

function onNotice(notice: ReplayGateNotice): void {
  const token = notice.origin;

  if (!surfaces.has(token)) {
    // The fact is the gate's and outlives the key: keep its run for the ceiling until it ends.
    const run = workingRuns.get(token);

    if (run !== undefined && (notice.view.underWay === null || notice.view.underWay.since !== run.since)) {
      workingRuns.delete(token);
    }

    return;
  }

  if (notice.ended.some(endShowsNotDone)) startNotDone(token);

  const reasons = notice.ended.map((end) => end.reason);

  update(token, reasons.length > 0 ? reasons.join(", ") : "notice");
}

/**
 * Registers a key or dial for its token, when it appears or its settings change. Registering the
 * same token again replaces the entry. Nothing is redrawn: the surface draws its own icon from
 * {@link getReplayBusyLook}. The interval starts if the token is showing working already.
 *
 * @returns The unregister, which removes only this registration, never a newer one for the token.
 */
export function registerReplayBusySurface(surface: ReplayBusySurface): () => void {
  if (unsubscribe === null) unsubscribe = subscribeReplayGate(onNotice);

  const registration: Registration = { surface };
  const token = surface.token;

  surfaces.set(token, registration);

  if (interval === null) tick = 0;

  const look = computeLook(token);

  trackRun(token, look);

  if (look.kind === "working" || look.kind === "waiting") clearNotDone(token);

  lastLooks.set(token, look);
  syncInterval();

  return () => {
    if (surfaces.get(token) !== registration) return;

    const before = lastLooks.get(token) ?? REST;

    surfaces.delete(token);
    lastLooks.delete(token);
    clearNotDone(token);

    if (before.kind !== "rest") logChange(token, before, REST, "unregistered");

    syncInterval();
  };
}

/**
 * A press the action ignored itself, because a fastest-lap or green-flag press is in flight. Shows
 * not done for one second, unless the token is already showing working or waiting.
 */
export function reportReplayPressIgnored(token: string): void {
  if (!surfaces.has(token)) return;

  const look = computeLook(token);

  if (look.kind === "working" || look.kind === "waiting") return;

  startNotDone(token);
  update(token, "ignored");
}

/** @internal Reset for tests: timers, registrations, state and the gate subscription. */
export function _resetReplayBusyIndicator(): void {
  if (interval !== null) clearInterval(interval);

  interval = null;
  tick = 0;

  for (const timer of notDoneTimers.values()) clearTimeout(timer);

  notDoneTimers.clear();
  surfaces.clear();
  lastLooks.clear();
  workingRuns.clear();
  unsubscribe?.();
  unsubscribe = null;
  log = silentLogger;
}
