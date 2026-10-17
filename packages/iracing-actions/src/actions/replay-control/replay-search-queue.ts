/**
 * The Replay Control dial's paced search (#801): one runner per process that
 * steps a pending count of lap, session or incident searches through
 * iRacing's own searches, one on its way at a time, as a policy on the replay
 * command gate (`shared/replay-command-gate.ts`, #1430) and never a gate of
 * its own. Design: docs/superpowers/specs/2026-10-12-issue-801-replay-control-dial-stepping.md,
 * "The paced search".
 *
 * The runner is a replay jump (`beginReplayJump`, #1276) that sends no
 * position jump of its own, and it holds the replay cursor for the whole run:
 *
 * 1. **Start.** Behind a jump of the plugin's it waits for that jump's frame
 *    to read back; behind a search that may be on its way it waits for the
 *    landing for its patience, and else settles the replay by the gate's
 *    jump. With nothing on its way it awaits nothing before its first send:
 *    the pause of a moving replay, or, on a replay playing at 1x or slower,
 *    its first search (the playing path, below).
 * 2. **Pause** a replay that still reads moving, and wait for the pause to
 *    read back.
 * 3. **Step.** While the count is not zero: hold the reading for three reads
 *    50 ms apart, send one search toward zero through the gate, and wait for
 *    its landing for the patience. A landing takes one off the count. A
 *    search that has not landed is settled by the gate's jump and sent once
 *    more; a second ends the run, settling once more.
 * 4. **End.** At zero, the **Replay jump playback** step on a held landing.
 *    The count is read once the landing has held, so a turn made during that
 *    hold is stepped, and a reversal to zero during a hold ends on it. Every
 *    other ending sends nothing more but the settle jump of step 3.
 *
 * **The playing path.** On a replay playing at 1x or slower with nothing of
 * the plugin's on its way, the first search goes out before any pause and the
 * gate reads its sign: found nothing ends the run with nothing more sent; on
 * its way is waited for however long (to the two-minute ceiling); landed takes
 * one off the count, and the run then ends by the playback step at zero, or
 * pauses on the landing and goes on as a paused run, jumping back to the frame
 * the landing first read before a lap or session step against the direction of
 * play. A first lap or session step against the direction of play takes the
 * paused path: the capture that would settle it was not run.
 *
 * Each search's outcome comes from one function ({@link runOneSearch}), so
 * #1439 can add an outcome and a start branch without rewriting the runner.
 */
import { getController } from "@iracedeck/deck-iracing";
import { replaySpeedFromTelemetry, type TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";

import {
  getReplayGateRecord,
  replaySearchCouldRunMs,
  type ReplaySearchKind,
  type ReplaySearchLandingOutcome,
  replaySearchMayRunMs,
  sendOwnedReplayCommand,
  settleReplayByJump,
  waitForReplaySearchLanding,
  waitForReplaySettled,
} from "../../shared/replay-command-gate.js";
import {
  applyReplayJumpPlayback,
  beginReplayJump,
  type ReplayJump,
  type ReplayJumpResult,
  type ReplaySpeed,
} from "../../shared/replay-jump-playback.js";
import { isSameSpeed } from "../../shared/replay-jump-speed.js";
import type { ReplayTarget } from "../../shared/replay-position-state.js";
import { isPaused, waitForReplay } from "../../shared/replay-seek.js";
import {
  readFastestLapSearchDelayMs,
  readReplayJumpTimeoutMs,
  REPLAY_JUMP_MAX_WAIT_MS,
  REPLAY_JUMP_POLL_MS,
  STABILIZATION_POLL_INTERVAL_MS,
  STABILIZATION_TIMEOUT_MULTIPLIER,
} from "../../shared/replay-timing.js";
import { keepDialPendingSpeed } from "./replay-speed-state.js";

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

// ---------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------

/** What the runner reads besides the gate; injectable for tests. */
export interface ReplaySearchQueueEnv {
  /** A fresh telemetry reading, or null. */
  readTelemetry(): TelemetryData | null;
  /** Whether a replay is on screen: the controller's debounced replay state (#1324). */
  inReplay(): boolean;
}

const defaultEnv: ReplaySearchQueueEnv = {
  readTelemetry: () => {
    try {
      return getController().getCurrentTelemetry();
    } catch {
      return null;
    }
  },
  inReplay: () => {
    try {
      return getController().getReplayState().inReplay;
    } catch {
      return false;
    }
  },
};

let env: ReplaySearchQueueEnv = defaultEnv;
let log: ILogger = silentLogger;

/** The logger the runner's lines go to. Replay Control sets it once, at construction. */
export function setReplaySearchQueueLogger(logger: ILogger): void {
  log = logger;
}

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

/** How many reads a reading must show before a search follows it: the read-back form of the 100 ms that worked 16 of 16. */
const HOLD_READS = 3;

/** How far apart those reads are (ms). */
const HOLD_GAP_MS = STABILIZATION_POLL_INTERVAL_MS;

/** Frames per millisecond at 1x. */
const FRAMES_PER_MS = 60 / 1000;

/** A reading that is the replay's. */
interface Reading {
  readonly frame: number;
  readonly speed: ReplaySpeed;
  /** Playback in frames per millisecond, signed; 0 paused. */
  readonly rate: number;
  readonly at: number;
}

function readReading(telemetry: TelemetryData | null, at: number): Reading | null {
  if (telemetry === null || telemetry.IsReplayPlaying !== true) return null;

  const frame = telemetry.ReplayFrameNum;

  if (typeof frame !== "number" || !Number.isFinite(frame)) return null;

  const raw = replaySpeedFromTelemetry(telemetry);
  const speed: ReplaySpeed = raw === null || raw.speed === 0 ? { speed: 0, slowMotion: false } : raw;

  return { frame, speed, rate: rateOf(speed), at };
}

/** Playback in frames per millisecond: in slow motion the speed is the divisor. */
function rateOf(speed: ReplaySpeed): number {
  if (speed.speed === 0) return 0;

  const factor = speed.slowMotion ? Math.sign(speed.speed) / Math.abs(speed.speed) : speed.speed;

  return factor * FRAMES_PER_MS;
}

/** How far a reading may sit from where playback puts it and still be playback (frames): the gate's measure. */
function playbackTolerance(rate: number, elapsedMs: number): number {
  return 3 + Math.abs(rate) * 20 + 0.25 * Math.abs(rate * elapsedMs);
}

/** Whether `next` is where `last` and playback put it: the very frame on a paused replay. */
function agrees(last: Reading, next: Reading): boolean {
  if (!isSameSpeed(last.speed, next.speed)) return false;

  if (last.rate === 0) return next.frame === last.frame;

  const elapsed = next.at - last.at;

  return Math.abs(next.frame - (last.frame + last.rate * elapsed)) <= playbackTolerance(last.rate, elapsed);
}

/** Whether `next` leapt away from where playback puts it from `last`: a search's landing. */
function leapt(last: Reading, next: Reading): boolean {
  const elapsed = next.at - last.at;

  return (
    next.frame !== last.frame &&
    Math.abs(next.frame - (last.frame + last.rate * elapsed)) > playbackTolerance(last.rate, elapsed)
  );
}

/** Whether a playing speed is 1x or slower, forward or reverse, slow motion included. */
function atMostNormal(speed: ReplaySpeed): boolean {
  return speed.speed !== 0 && (speed.slowMotion || Math.abs(speed.speed) <= 1);
}

/**
 * @internal Exported for testing
 *
 * The runner's patience for a search nothing shows on its way: the gate's
 * figure for how long it could run, never under {@link SEARCH_PATIENCE_MIN_MS}
 * and never over {@link SEARCH_PATIENCE_MAX_MS}, except that the fastest-lap
 * walk's wait (four times the Fastest Lap Search Delay) takes the place of
 * either bound where it is the longer.
 */
export function replaySearchPatienceMs(figureMs: number): number {
  const walkMs = readFastestLapSearchDelayMs() * STABILIZATION_TIMEOUT_MULTIPLIER;
  const floor = Math.max(SEARCH_PATIENCE_MIN_MS, walkMs);
  const cap = Math.max(SEARCH_PATIENCE_MAX_MS, walkMs);
  const figure = Number.isFinite(figureMs) ? figureMs : cap;

  return Math.min(cap, Math.max(floor, figure));
}

/** The gate's search for a target and a direction. */
function searchKind(target: ReplaySearchTarget, direction: 1 | -1): ReplaySearchKind {
  switch (target) {
    case "lap":
      return direction > 0 ? "nextLap" : "prevLap";
    case "session":
      return direction > 0 ? "nextSession" : "prevSession";
    case "incident":
      return direction > 0 ? "nextIncident" : "prevIncident";
  }
}

function clampCount(count: number): number {
  return Math.min(SEARCH_QUEUE_MAX, Math.max(-SEARCH_QUEUE_MAX, count));
}

function directionOf(count: number): 1 | -1 {
  return count < 0 ? -1 : 1;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** One run of the runner. */
interface Run {
  readonly target: ReplaySearchTarget;
  readonly origin: string;
  /** The net steps still to make, the search on its way included; less {@link inFlight}, it is within ±{@link SEARCH_QUEUE_MAX}. */
  count: number;
  /** The direction of the search on its way, or 0. */
  inFlight: 0 | 1 | -1;
  /** Set once the run has ended: by itself, by a take of the cursor, or by a reset. */
  ended: boolean;
  jump: ReplayJump | null;
  /** The speed a run this one superseded captured: that run paused the replay, so its capture is the user's speed. */
  readonly inheritedSpeed: ReplaySpeed | null;
}

let run: Run | null = null;
const listeners = new Set<() => void>();
const speedListeners = new Set<(speed: ReplaySpeed) => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      log.debug(`Replay search queue listener failed: ${String(err)}`);
    }
  }
}

function active(): Run | null {
  return run !== null && !run.ended ? run : null;
}

/** Tells the speed listeners of a speed the runner sent, so a surface mirrors it before telemetry shows it. */
function noteSpeedSent(speed: ReplaySpeed): void {
  for (const listener of speedListeners) {
    try {
      listener(speed);
    } catch (err) {
      log.debug(`Replay search queue speed listener failed: ${String(err)}`);
    }
  }
}

/** Whether the runner must stop: its run ended, or another replay command took the cursor. */
function stopped(r: Run): boolean {
  return r.ended || r.jump === null || r.jump.claim.cancelledBy !== null;
}

// ---------------------------------------------------------------------------
// The public surface
// ---------------------------------------------------------------------------

/**
 * Adds a turn to the pending count and starts the runner when none is
 * running. A turn for another target than the run's replaces the count and
 * starts a run of its own (the first ends superseded). Returns at once; the
 * runner works in the background and `onChange` listeners hear each step.
 */
export function queueReplaySearch(turn: ReplaySearchTurn): void {
  const ticks = Math.trunc(turn.ticks);

  if (!Number.isFinite(ticks) || ticks === 0) return;

  const current = active();

  if (current !== null && current.target === turn.target) {
    // The clamp is on what is left after the search on its way, the count a dial shows, never on the two together.
    current.count = current.inFlight + clampCount(current.count - current.inFlight + ticks);
    log.debug(
      `Replay search queue: ${turn.target} ${ticks > 0 ? "+" : ""}${ticks} from ${turn.origin}; ` +
        `${current.count - current.inFlight} left after the search on its way`,
    );
    notify();

    return;
  }

  startRun(turn, ticks, current);
}

/** The run under way, or null. */
export function pendingReplaySearch(): ReplaySearchPending | null {
  const current = active();

  if (current === null) return null;

  return { target: current.target, count: current.count - current.inFlight, origin: current.origin };
}

/** Whether a run is under way for `target` (a Lap or Session turn then goes to the count, not the record). */
export function isReplaySearchRunning(target: ReplaySearchTarget): boolean {
  return active()?.target === target;
}

/** Hears every change of the pending count and the run's end, so a dial re-renders. Returns the unsubscribe. */
export function onReplaySearchChange(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Hears every speed the runner sends: its pause, and the speed the Replay jump
 * playback step leaves at the end of a run at zero, as a record jump's
 * `onPaused` and landing tell the dial. Returns the unsubscribe.
 */
export function onReplaySearchSpeedSent(listener: (speed: ReplaySpeed) => void): () => void {
  speedListeners.add(listener);

  return () => {
    speedListeners.delete(listener);
  };
}

/** @internal Exported for testing: ends any run and clears the queue, its listeners, environment and logger. */
export function _resetReplaySearchQueue(): void {
  const current = run;

  run = null;

  if (current !== null && !current.ended) {
    current.ended = true;
    current.jump?.end("cancelled");
  }

  listeners.clear();
  speedListeners.clear();
  env = defaultEnv;
  log = silentLogger;
}

/** @internal Replace the environment for tests; `undefined` keys keep the default. */
export function _configureReplaySearchQueue(overrides: Partial<ReplaySearchQueueEnv>): void {
  env = { ...defaultEnv, ...overrides };
}

// ---------------------------------------------------------------------------
// A run
// ---------------------------------------------------------------------------

function startRun(turn: ReplaySearchTurn, ticks: number, previous: Run | null): void {
  const r: Run = {
    target: turn.target,
    origin: turn.origin,
    count: clampCount(ticks),
    inFlight: 0,
    ended: false,
    jump: null,
    inheritedSpeed: previous === null ? null : (previous.inheritedSpeed ?? previous.jump?.captured ?? null),
  };

  // The new claim cancels the old run's. It is marked ended first, so its own cancellation tells nobody twice.
  if (previous !== null) {
    previous.ended = true;
    log.debug(`Replay search queue: the ${previous.target} run is superseded by a ${turn.target} turn`);
  }

  run = r;

  const atStart = env.readTelemetry();

  try {
    // The dial's own cursor take, as its record jump's is: a speed or pause the dial sent just before the turn still
    // stands until telemetry shows it, where any other action's take drops it.
    r.jump = keepDialPendingSpeed(() =>
      beginReplayJump(turn.owner, atStart, (by) => cancelled(r, by), Date.now(), {
        origin: turn.origin,
        sendsPositionJump: false,
      }),
    );
  } catch (err) {
    log.warn(`Replay search queue: the ${turn.target} run could not start: ${String(err)}`);
    r.ended = true;
    run = null;
    notify();

    return;
  }

  log.debug(`Replay search queue: ${turn.target} run of ${r.count} started by ${turn.origin}`);
  notify();
  void drive(r, atStart);
}

/** Another replay command took the cursor: the run ends, and sends nothing more. */
function cancelled(r: Run, by: string): void {
  if (r.ended) return;

  r.ended = true;

  if (run === r) run = null;

  log.debug(`Replay search queue: the ${r.target} run is cancelled by ${by}; ${r.count - r.inFlight} dropped`);
  notify();
}

/** Runs a run to its end, catching whatever it throws, and hands the cursor back however it ended. */
async function drive(r: Run, atStart: TelemetryData | null): Promise<void> {
  let result: ReplayJumpResult = "gave-up";

  try {
    result = await work(r, atStart);
  } catch (err) {
    log.warn(`Replay search queue: the ${r.target} run failed: ${String(err)}`);
    result = "gave-up";
  } finally {
    finish(r, result);
  }
}

function finish(r: Run, result: ReplayJumpResult): void {
  const final: ReplayJumpResult = r.jump !== null && r.jump.claim.cancelledBy !== null ? "cancelled" : result;
  const wasActive = !r.ended;

  r.ended = true;
  r.inFlight = 0;
  r.jump?.end(final);

  if (run === r) run = null;

  log.debug(`Replay search queue: the ${r.target} run ended ${final}`);

  if (wasActive) notify();
}

/** How a run ended, as its replay jump reports it to the gate's state seam. */
type Ending = ReplayJumpResult;

/**
 * Whether the replay counts as on screen: the controller says so, or a move of
 * the plugin's own is under way (a target stands, or a seek shows), as the
 * dial surface counts it. In a live session the controller gives the replay up
 * a second into a seek, which a long jump outlasts; a run behind that jump
 * waits for its landing rather than ending at once. The run's own replay jump
 * is not such a move, so it is not asked whether the plugin is moving the
 * replay: it always is while the run holds the cursor.
 */
function replayOnScreen(): boolean {
  if (env.inReplay()) return true;

  const record = getReplayGateRecord();

  return record.target !== null || record.seekShowing;
}

/** The gave-up ending with a warning: a read-back that never came. */
function neverReadBack(r: Run, what: string): Ending {
  if (!replayOnScreen()) return leftReplay(r);

  log.warn(`Replay search queue: ${what}; the rest of the ${r.target} run is dropped`);

  return "gave-up";
}

/**
 * The replay was left during the run. That is not a give-up of the runner's,
 * so it must draw no cross: the gate's replay-jump end has no replay-left
 * result, and cancelled is the one that says "not given up".
 */
function leftReplay(r: Run): Ending {
  log.debug(`Replay search queue: the replay was left; the ${r.target} run ends`);

  return "cancelled";
}

/**
 * The run, from the cursor taken to its ending. With nothing of the plugin's
 * on its way, the first send (a pause, or the playing path's first search)
 * goes out before anything is awaited.
 */
async function work(r: Run, atStart: TelemetryData | null): Promise<Ending> {
  const jump = r.jump;

  if (jump === null || stopped(r)) return "cancelled";

  // openReplayJump settled the gate against the reading taken at the start.
  const record = getReplayGateRecord();
  const jumpOnItsWay = record.target !== null || record.seekShowing;
  const searchOnItsWay = record.search !== null && record.search.onItsWay !== "no";

  if (jumpOnItsWay) {
    const behind = await behindJump(r, record.target);

    if (behind !== null) return behind;
  } else if (searchOnItsWay) {
    const behind = await behindSearch(r);

    if (behind !== null) return behind;
  } else {
    const reading = readReading(atStart, Date.now());

    if (reading !== null && playingPathFits(r.target, directionOf(r.count), reading, jump.captured)) {
      return playingPath(r, reading);
    }

    // The captured speed as well as the reading, as the jump sequence judges it: a speed just applied and not
    // shown yet is moving too.
    const moving = reading === null ? !isPaused(atStart) : reading.rate !== 0 || jump.captured.speed !== 0;

    if (moving) {
      const paused = await pause(r);

      if (paused !== null) return paused;
    }

    return pausedRun(r);
  }

  const paused = await pauseIfMoving(r);

  if (paused !== null) return paused;

  return pausedRun(r);
}

/**
 * Whether the first search may go out on the playing replay: the replay plays
 * at 1x or slower, the reading and the speed the run captured agree, and the
 * step is an incident either way or a lap or session step in the direction of
 * play. A first lap or session step against it takes the paused path: whether
 * iRacing's Previous from a frame or two past a line goes to the line before
 * was never measured.
 */
function playingPathFits(
  target: ReplaySearchTarget,
  direction: 1 | -1,
  reading: Reading,
  captured: ReplaySpeed,
): boolean {
  if (reading.rate === 0 || !atMostNormal(reading.speed) || !isSameSpeed(reading.speed, captured)) return false;

  return target === "incident" || direction === Math.sign(reading.rate);
}

/**
 * Behind a jump of the plugin's: wait for it to land and the reading to hold.
 * Null to go on. `target` is the gate's record of the jump when the wait
 * began, null for a seek only the witness shows.
 *
 * A held reading on the target's frame is a landing. One off it is a landing
 * only where the gate said so: a takeover's jump, or the settle jump of
 * `settleReplayByJump`, is judged moved and then held, even a few frames off,
 * and a plain position jump by its frame alone. The gate keeps that verdict
 * to itself, so it is read from when the target left the record: before its
 * own deadline (`sentAt` + `giveUpMs`, as the record last showed them, since
 * a seek marked sent restarts both) the gate ended it as read back, and at or
 * after it as given up. Two windows read wrong. A landing in the last poll
 * before the deadline reads as a give-up, which refuses. And a takeover
 * recorded with no replay reading on screen has a deadline later than its
 * nothing-moved wait, so nothing moving reads as a landing. An exported
 * target fate would make both exact.
 */
async function behindJump(r: Run, target: ReplayTarget | null, frame = target?.frame ?? null): Promise<Ending | null> {
  let standing = target;
  let leftAt: number | null = null;

  const held = await holdReading(r, {
    requirePaused: false,
    timeoutMs: REPLAY_JUMP_MAX_WAIT_MS,
    observe: () => {
      if (standing === null || leftAt !== null) return;

      const now = getReplayGateRecord().target;

      if (now !== null && now.id === standing.id) standing = now;
      else leftAt = Date.now();
    },
  });

  if (held.kind === "cancelled") return "cancelled";

  if (held.kind === "left") return leftReplay(r);

  if (held.kind === "gave-up") return neverReadBack(r, "the jump under way never read back");

  if (frame === null || held.reading.frame === frame) return null;

  const readBack =
    standing !== null && standing.sent && leftAt !== null && leftAt < standing.sentAt + standing.giveUpMs;

  if (readBack) {
    log.debug(`Replay search queue: the jump under way landed on frame ${held.reading.frame} (sent to ${frame})`);

    return null;
  }

  return neverReadBack(r, `the jump under way did not land on frame ${frame} (reads ${held.reading.frame})`);
}

/** Behind a search that may be on its way: its landing, or a settle by the gate's jump. Null to go on. */
async function behindSearch(r: Run): Promise<Ending | null> {
  const claim = r.jump?.claim;

  if (claim === undefined) return "cancelled";

  const outcome = await waitForReplaySearchLanding({
    patienceMs: replaySearchPatienceMs(replaySearchCouldRunMs() ?? 0),
    hardBoundMs: REPLAY_JUMP_MAX_WAIT_MS,
    claim,
  });

  if (stopped(r)) return "cancelled";

  switch (outcome) {
    case "landed":
    case "found-nothing":
      return null;
    case "not-landed": {
      const settled = await settleReplayByJump({ claim, origin: r.origin });

      if (settled === "superseded" || stopped(r)) return "cancelled";

      if (settled === "nothing-moved") {
        log.debug(`Replay search queue: the settle jump behind a search moved nothing; the ${r.target} run ends`);

        return "gave-up";
      }

      return null;
    }
    case "gave-up":
      return neverReadBack(r, "the search under way never landed");
    case "superseded":
      return "cancelled";
  }
}

/** Sends the pause and waits for it to read back. Null to go on. */
async function pause(r: Run): Promise<Ending | null> {
  const claim = r.jump?.claim;

  if (claim === undefined) return "cancelled";

  const sent = sendOwnedReplayCommand(
    claim,
    { kind: "pause", send: (replay) => replay.setPlaySpeed(0) },
    { origin: r.origin },
  );

  if (sent === "cancelled") return "cancelled";

  if (sent === "refused") return neverReadBack(r, "the pause was refused");

  if (sent === "sent") noteSpeedSent({ speed: 0, slowMotion: false });

  const outcome = await waitForReplay(
    {
      claim,
      readTelemetry: () => env.readTelemetry(),
      timeoutMs: readReplayJumpTimeoutMs(),
      pollMs: REPLAY_JUMP_POLL_MS,
    },
    (sample): sample is TelemetryData => sample !== null && sample.IsReplayPlaying === true && isPaused(sample),
  );

  if (outcome.kind === "cancelled" || stopped(r)) return "cancelled";

  if (outcome.kind === "timeout") return neverReadBack(r, "the pause never read back");

  return null;
}

/** Pauses the replay if it reads moving. Null to go on. */
async function pauseIfMoving(r: Run): Promise<Ending | null> {
  const reading = readReading(env.readTelemetry(), Date.now());

  if (reading === null || reading.rate === 0) return null;

  return pause(r);
}

/** How a hold of the reading ended. */
type HoldResult =
  | { readonly kind: "held"; readonly telemetry: TelemetryData; readonly reading: Reading }
  | { readonly kind: "gave-up" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "left" };

/** A reading that has held. */
type HeldReading = Extract<HoldResult, { readonly kind: "held" }>;

/**
 * Waits until nothing the gate knows of is under way and the reading has
 * shown the same position, or where playback puts it, on three reads 50 ms
 * apart. With `requirePaused`, only a paused reading counts. `observe` runs
 * after each of the gate's settles, 50 ms apart, for a caller that watches
 * the record while the wait goes on.
 */
async function holdReading(
  r: Run,
  options: { requirePaused: boolean; timeoutMs: number; observe?: () => void },
): Promise<HoldResult> {
  const claim = r.jump?.claim;

  if (claim === undefined) return { kind: "cancelled" };

  const startedAt = Date.now();
  let last: Reading | null = null;
  let agreeing = 0;

  for (;;) {
    if (stopped(r)) return { kind: "cancelled" };

    if (!replayOnScreen()) return { kind: "left" };

    // One settle of the gate's a poll, so the record can be watched and the replay asked about between them.
    const settled = await waitForReplaySettled({ reads: 1, timeoutMs: 0, claim });

    if (settled === "superseded" || stopped(r)) return { kind: "cancelled" };

    options.observe?.();

    const telemetry = settled === "settled" ? env.readTelemetry() : null;
    const reading = readReading(telemetry, Date.now());

    if (reading !== null && (!options.requirePaused || reading.rate === 0)) {
      agreeing = last !== null && agrees(last, reading) ? agreeing + 1 : 1;
      last = reading;
    } else {
      agreeing = 0;
      last = null;
    }

    if (agreeing >= HOLD_READS && telemetry !== null && reading !== null) return { kind: "held", telemetry, reading };

    if (Date.now() - startedAt >= options.timeoutMs) return replayOnScreen() ? { kind: "gave-up" } : { kind: "left" };

    await sleep(HOLD_GAP_MS);
  }
}

/** What became of one search the runner sent. */
interface SearchStep {
  readonly outcome: ReplaySearchLandingOutcome;
  /** For a search watched on a playing replay: the frame its landing first read, when it landed. */
  readonly landingFrame: number | null;
  /** Set when it ended `gave-up` because the send itself was refused. */
  readonly refused?: boolean;
}

/**
 * Sends one search toward `direction` and waits for its landing: the one
 * function that says what became of a search (#1439 adds to it, not around
 * it). The send goes out before anything is awaited. A landing takes one off
 * the count; any other outcome leaves the count as it was.
 */
async function runOneSearch(r: Run, direction: 1 | -1, options: { watchLanding: boolean }): Promise<SearchStep> {
  const claim = r.jump?.claim;

  if (claim === undefined) return { outcome: "superseded", landingFrame: null };

  const atSend = env.readTelemetry();
  const kind = searchKind(r.target, direction);
  const sent = sendOwnedReplayCommand(claim, { kind: "search", search: kind }, { origin: r.origin });

  if (sent === "cancelled") return { outcome: "superseded", landingFrame: null };

  if (sent !== "sent") return { outcome: "gave-up", landingFrame: null, refused: true };

  r.inFlight = direction;
  log.debug(`Replay search queue: ${kind} sent; ${r.count - r.inFlight} left after it`);
  notify();

  const watcher = options.watchLanding ? watchLandingFrame(atSend) : null;
  let outcome: ReplaySearchLandingOutcome;

  try {
    outcome = await waitForReplaySearchLanding({
      patienceMs: replaySearchPatienceMs(replaySearchCouldRunMs() ?? replaySearchMayRunMs(atSend, direction)),
      hardBoundMs: REPLAY_JUMP_MAX_WAIT_MS,
      claim,
    });
  } finally {
    watcher?.stop();
  }

  if (outcome === "landed") r.count -= direction;

  r.inFlight = 0;

  if (!stopped(r)) notify();

  log.debug(`Replay search queue: ${kind} ${outcome}`);

  return { outcome, landingFrame: watcher?.frame() ?? null };
}

/**
 * Reads the replay every poll while a search on a playing replay is on its
 * way, and keeps the first frame that leapt away from where playback puts it:
 * the frame the landing first read.
 */
function watchLandingFrame(atSend: TelemetryData | null): { frame(): number | null; stop(): void } {
  let last = readReading(atSend, Date.now());
  let first: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const step = (): void => {
    const next = readReading(env.readTelemetry(), Date.now());

    if (first === null && last !== null && next !== null && leapt(last, next)) first = next.frame;

    if (next !== null) last = next;

    timer = setTimeout(step, REPLAY_JUMP_POLL_MS);
  };

  timer = setTimeout(step, REPLAY_JUMP_POLL_MS);

  return {
    frame: () => first,
    stop: () => {
      if (timer !== null) clearTimeout(timer);

      timer = null;
    },
  };
}

/** The first search on a playing replay, before any pause; then the end, or the paused run. */
async function playingPath(r: Run, reading: Reading): Promise<Ending> {
  const playDirection = Math.sign(reading.rate);
  const step = await runOneSearch(r, directionOf(r.count), { watchLanding: true });

  if (stopped(r)) return "cancelled";

  switch (step.outcome) {
    case "found-nothing":
      log.debug(`Replay search queue: the first ${r.target} search found nothing; the replay plays on`);

      return "gave-up";
    case "gave-up":
      return neverReadBack(r, step.refused === true ? "the search was refused" : "the search never landed");
    case "superseded":
      return "cancelled";
    case "not-landed": {
      // Neither sign within the patience: settled as on a paused replay, and the step is tried once more there.
      const settled = await settleReplayByJump({ claim: r.jump?.claim, origin: r.origin });

      if (settled === "superseded" || stopped(r)) return "cancelled";

      if (settled === "nothing-moved") return "gave-up";

      return pausedRun(r, 1);
    }
    case "landed":
      break;
  }

  if (r.count === 0) {
    const ended = await endAtZero(r);

    if (ended !== null) return ended;

    // A turn made while the landing held: the run goes on as with a count left at the landing.
  }

  const paused = await pause(r);

  if (paused !== null) return paused;

  // Between the landing and the pause the replay played on, so a lap or session step against the direction of play
  // would start from past the line the search landed on: the cursor goes back to the frame the landing first read.
  if (r.count !== 0 && r.target !== "incident" && directionOf(r.count) !== playDirection) {
    const back = await jumpBack(r, step.landingFrame);

    if (back !== null) return back;
  }

  return pausedRun(r);
}

/**
 * The jump back to the frame a playing landing first read, waited for to read
 * back and hold. Null to go on. A replay the pause left on that very frame (a
 * slow replay can still be on it) gets no jump: one to the frame on screen
 * can never read back conclusively, and with the runner holding the cursor
 * the gate would keep its target to the two-minute ceiling.
 */
async function jumpBack(r: Run, frame: number | null): Promise<Ending | null> {
  const claim = r.jump?.claim;

  if (claim === undefined) return "cancelled";

  if (frame === null) return neverReadBack(r, "the landing's first frame was not read");

  if (readReading(env.readTelemetry(), Date.now())?.frame === frame) {
    log.debug(`Replay search queue: the pause left the replay on frame ${frame}, where the landing first read`);

    return null;
  }

  const sent = sendOwnedReplayCommand(claim, { kind: "jump", frame }, { origin: r.origin });

  if (sent === "cancelled") return "cancelled";

  if (sent !== "sent") return neverReadBack(r, `the jump back to frame ${frame} was refused`);

  return behindJump(r, getReplayGateRecord().target, frame);
}

/**
 * Steps 3 to 5 on a paused replay: hold, one search toward zero, its landing.
 * A search that has not landed is settled by the gate's jump and sent once
 * more, and a second ends the run. `misses` is how many have not landed
 * running into it.
 */
async function pausedRun(r: Run, misses = 0): Promise<Ending> {
  let notLanded = misses;

  for (;;) {
    if (stopped(r)) return "cancelled";

    // The count is read once the reading has held, never before: a turn made during the hold, the end's hold
    // included, is a step still to make, and a reversal to zero during it ends the run on that same hold.
    const held = await holdReading(r, { requirePaused: true, timeoutMs: readReplayJumpTimeoutMs() });

    if (held.kind === "cancelled") return "cancelled";

    if (held.kind === "left") return leftReplay(r);

    if (held.kind === "gave-up") return neverReadBack(r, "the replay did not settle paused");

    if (r.count === 0) {
      const ended = await endAtZero(r, held);

      if (ended !== null) return ended;

      continue;
    }

    const step = await runOneSearch(r, directionOf(r.count), { watchLanding: false });

    if (stopped(r)) return "cancelled";

    switch (step.outcome) {
      case "landed":
        notLanded = 0;
        continue;
      case "not-landed": {
        notLanded++;

        // The settle jump ends a search still on its way, and clears the gate's record of it.
        const settled = await settleReplayByJump({ claim: r.jump?.claim, origin: r.origin });

        if (settled === "superseded" || stopped(r)) return "cancelled";

        if (notLanded >= 2) {
          log.debug(`Replay search queue: two ${r.target} searches running did not land; nothing further that way`);

          return "gave-up";
        }

        if (settled === "nothing-moved") {
          log.debug(`Replay search queue: the settle jump moved nothing; the ${r.target} run ends`);

          return "gave-up";
        }

        continue;
      }
      case "found-nothing":
        return "gave-up";
      case "gave-up":
        return neverReadBack(r, step.refused === true ? "the search was refused" : "the search never landed");
      case "superseded":
        return "cancelled";
    }
  }
}

/**
 * The count is zero: the Replay jump playback step on a landing that has
 * held, `held` when the caller's hold already did so. Null when a turn made
 * during the hold left a count to step: the run goes on. The count is read
 * after the hold, and nothing is awaited between that read and the run's end.
 */
async function endAtZero(r: Run, held?: HeldReading): Promise<Ending | null> {
  const jump = r.jump;

  if (jump === null) return "cancelled";

  let landing: HeldReading;

  if (held !== undefined) {
    landing = held;
  } else {
    const result = await holdReading(r, { requirePaused: false, timeoutMs: readReplayJumpTimeoutMs() });

    if (result.kind === "cancelled") return "cancelled";

    if (result.kind === "left") return leftReplay(r);

    if (result.kind === "gave-up") return neverReadBack(r, "the landing never held");

    landing = result;
  }

  if (r.count !== 0) {
    log.debug(`Replay search queue: a ${r.target} turn came while the landing held; the run goes on`);

    return null;
  }

  const playback = r.inheritedSpeed === null ? jump : { ...jump, captured: r.inheritedSpeed };
  const applied = applyReplayJumpPlayback(playback, landing.telemetry);

  if (applied === null) return "cancelled";

  if (applied.command === "failed") log.warn("Replay search queue: speed command failed; replay left as it landed");

  // The speed the replay is at now, as a record jump's landing reports it: the one wanted, or the landing's own.
  noteSpeedSent(applied.speed);

  return "landed";
}
