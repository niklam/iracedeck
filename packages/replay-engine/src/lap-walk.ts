/**
 * The lap walk (#607, #1203, #1354; out of `ReplayControl` in #1467): the
 * search of the replay for the start of one car's lap that Jump to Fastest
 * Lap runs when the record has no frame for it, and Jump to Race Start runs
 * for the pole car's lap 1. It reads telemetry, session info and the replay
 * state through the engine env, the time through the engine clock, and sends
 * every command through the replay command gate as the holder of the press's
 * cursor claim. Its lines go to the engine's `ReplayControl` scope.
 *
 * A walk is stopped two ways, both observed at every `checkpoint` and every
 * poll of its own waits. A replay command from any key cancels its claim:
 * {@link FastestLapPressCancelled}, and nothing more is sent. A camera switch
 * interrupts it (#1428 / #1435, `interruptLapWalks`): {@link LapWalkInterrupted},
 * which {@link runFastestLapWalk} catches to put the replay back as a walk
 * that gave up does, since the walk still holds the cursor. Only the search
 * is interruptible: the moment it has its answer (or has given up) the walk
 * ends its claim's interrupts (`endReplayCursorInterrupts`), and a camera
 * switch then waits for the jump to the lap or the way back to finish.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { getReplaySessionStore, isReplaySessionStoreInitialized } from "@iracedeck/replay-store";

import { now, pollUntil, sleep } from "./engine-clock.js";
import { lastListedSessionNum } from "./green-flag-target.js";
import {
  FastestLapPressCancelled,
  inReplayNow,
  lapPressLogger,
  LapWalkInterrupted,
  readSessionInfo,
  throwIfWalkStopped,
  walkStopView,
} from "./lap-press.js";
import { halvingProbeFrames } from "./lap-walk-probes.js";
import { type ReplayGateCommand, sendOwnedReplayCommand, waitForReplayJumpsToSettle } from "./replay-command-gate.js";
import { endReplayCursorInterrupts } from "./replay-cursor.js";
import { engineReads } from "./replay-engine-env.js";
import type { ReplayJump } from "./replay-jump-playback.js";
import { onReplayLeft } from "./replay-left.js";
import { replaySeekWaitMs, seekReplayFrame } from "./replay-seek.js";
import { formatSpeedDisplay } from "./replay-speed-format.js";
import {
  readFastestLapSearchDelayMs,
  STABILIZATION_POLL_INTERVAL_MS,
  STABILIZATION_TIMEOUT_MULTIPLIER,
} from "./replay-timing.js";

/**
 * Safety cap on the bisection probes that show the car and so move a bound
 * (issue #607). log₂(N) jumps converge in ~24 steps for a 2-hour endurance
 * replay at 60 Hz (~430 k frames), so 30 is a comfortable engineering ceiling.
 * Distinct from the old `MAX_LAP_SEARCH_STEPS` cap, which had to absorb O(N)
 * lap-by-lap walks and a `× gap` wall-clock budget — the bisection's
 * wall-clock is ~`30 × gap` worst case.
 */
export const MAX_BISECTION_STEPS = 30;

/**
 * How many bisection probes of one walk may find the car out of the world
 * (#1354). Such a probe moves no bound — the car is gone before it joins,
 * after it retires and while it sits in the garage, and one frame cannot tell
 * which — so the walk tries the next frame of the open interval instead
 * (`halvingProbeFrames`). 31 is five rounds of halving: a car that was on track
 * for a sixteenth of the session is found, and a car that never was costs the
 * walk ~`31 × gap` before it gives up and puts the replay back.
 */
export const MAX_ABSENT_PROBES = 31;

// Jump to Fastest Lap is a lookup first and a walk second (issue #1203,
// docs/superpowers/specs/2026-09-24-issue-1203-fastest-lap-from-session-record.md).
//
// The lookup reads the per-session replay record (`getReplaySessionStore().laps`,
// written live by the translator's lap-crossing events): a hit is one
// `setPlayPosition` to `LAP_START_APPROACH_FRAMES` before the recorded lap
// start and, once the cursor has landed there, one camera switch.
//
// Either way the press ends as the Replay jump playback global setting says
// (#1276, `replay-jump-playback.ts`): at the speed the replay had when
// the key was pressed, at 1×, or paused.
//
// The walk is the fallback for a lap the record does not have (the plugin was
// not running, someone else's `.rpy`, an offline session's replay opened
// later). Issue #607 follow-up #3 gave it its three phases, because bisecting
// the whole buffer could not find a lap in a non-current session:
//
//   1. Session map. On the first walk per `SessionUniqueID`, navigate
//      `goToStart` → `nextSession` × N, recording the start frame of each
//      session. The recording's extent is `ReplayFrameNum + ReplayFrameNumEnd`,
//      constant and readable from any replay frame, so no `goToEnd` — which
//      in a live session returns the sim to the live view, where
//      `ReplayFrameNum` reads 0 and the last session's bounds collapse.
//      Cached at module scope and reused for every walk on the same replay.
//   2. Bisect within the target session's bounds (looked up from the cache)
//      until `CarIdxLap[carIdx]` is within `CLOSE_ENOUGH_LAPS` of the target.
//   3. Lap-step refinement: `nextLap` / `prevLap` until `CarIdxLap[carIdx]`
//      is the lap before the target.
//   4. The crossing (#1432): two frames at most `LAP_CROSSING_MAX_FRAMES`
//      apart, the earlier reading the lap before the target and the later
//      the target, bracketed from where a lap search left the cursor (one
//      Next Lap nudge when that is not near enough) and bisected to adjacent
//      frames by absolute jumps. The later is the lap start, and the cursor
//      is left `LAP_START_APPROACH_FRAMES` before it.
//
// #1203 changed how the walk waits and ends: an absolute jump settles when
// `ReplayFrameNum` reads the frame that was sent, a search when the frame has
// moved and held; every speed sent reaches the keys and dials (today through
// the speed state, `replay-speed-state.ts`, and `onReplaySpeedChanged`);
// one walk runs per action instance and any other Replay Control command
// cancels it; and a converged walk writes the lap start it found into the
// record, so the next press is a lookup.

/**
 * After bisection, the lap-step phase takes over. `CLOSE_ENOUGH_LAPS = 2`
 * means the bisection exits when the player car is within 2 laps of the
 * target either way — the lap-step phase finishes the job with at most a
 * few `nextLap` / `prevLap` calls.
 */
export const CLOSE_ENOUGH_LAPS = 2;

/**
 * Safety cap on the lap-step phase. iRacing's lap navigation is precise so
 * this should never trip in practice; it exists for the case where the
 * SDK's reported `CarIdxLap` doesn't change after a `nextLap` / `prevLap`
 * broadcast (e.g. cursor at the buffer edge).
 */
export const MAX_LAP_STEPS = 10;

/**
 * Sanity cap on the number of sessions in a single replay. Most iRacing
 * sessions have at most 4 (practice / qualifying / warmup / race); 10 is
 * generous headroom.
 */
export const MAX_SESSIONS = 10;

/**
 * How far from where a lap search left the cursor the walk's first crossing
 * probe looks for the frame the lap counter flips (#1432): the 11 frames
 * iRacing's Next Lap was measured to rest short of the line, with half
 * again and rounded up to a power of two, so the measured case is bisected
 * in four more probes.
 */
export const LAP_CROSSING_NEAR_FRAMES = 16;

/**
 * The furthest from where a lap search left the cursor the walk looks for
 * the frame the lap counter flips (#1432): two seconds of replay. A flip
 * further away is not found, and the walk records nothing. Eleven times the
 * measured offset, and above the ~100 frames a rolling start's lap search
 * was measured to rest before the line; each doubling of it costs one probe.
 */
export const LAP_CROSSING_MAX_FRAMES = 120;

/**
 * Frames before the recorded lap start a record hit lands at: one second of
 * approach in the in-session replay, two in a saved file (a live-recorded
 * frame lands about a second early there — the #1162 lag decision), both
 * showing the crossing into the timed lap. A walk that found the lap start
 * leaves the cursor here too (#1432), so its press and every later one land
 * alike.
 */
export const LAP_START_APPROACH_FRAMES = 60;

/**
 * How far the record's lap time may differ from `ResultsPositions[].FastestTime`
 * before the lookup logs the disagreement: one sim tick. The lap-number
 * convention (that `FastestLap` counts laps the way `CarIdxLap` does, so the
 * record's `lap` matches) is what a disagreement would contradict; the jump
 * still happens.
 */
export const FASTEST_TIME_TOLERANCE_MS = 1000 / 60;

/**
 * One session instance's frame bounds within the replay buffer, keyed by the
 * `(SessionNum, SessionUniqueID)` pair: a session restarted within one sim run
 * keeps its `SessionNum` and gets a new `SessionUniqueID`, and is a second
 * entry, not the end of the map. `endFrame` is `null` for the LAST instance —
 * the recording's end, which a live session keeps pushing out — and every walk
 * reads it fresh as `ReplayFrameNum + ReplayFrameNumEnd` from its own first
 * stable sample rather than trusting the value at build time (#1203: a frozen
 * end made the bisection collapse below any lap driven since the build).
 */
export type SessionMapEntry = {
  sessionNum: number;
  sessionUniqueId: number;
  startFrame: number;
  endFrame: number | null;
};

export type FastestLapSessionMap = {
  /**
   * `WeekendInfo.SubSessionID` of the replay the map was built in. The
   * `SessionUniqueID`s alone cannot tell two replays apart — they restart at 1
   * in every sim run (the 2026-09-17 Homestead captures), so a second `.rpy`
   * opened in the same process repeats them.
   */
  subSessionId: number | undefined;
  /**
   * Every `SessionUniqueID` observed while building the map (one per session
   * instance). A walk reuses the map only when its own `SessionUniqueID` is
   * one of these AND the `SubSessionID` matches; a session instance the map
   * has never seen (a restart after the build) misses and rebuilds.
   */
  sessionUniqueIds: Set<number>;
  sessions: SessionMapEntry[];
  /**
   * The build stopped at {@link MAX_SESSIONS} steps with the recording
   * possibly going on: the last entry is then not known to be the last
   * session, so nothing may be read off the map as "the latest".
   */
  truncated: boolean;
};

/**
 * Module-level cache of the session map, dropped on SDK disconnect (the
 * engine's `replayLeft` with reason `disconnected`, through
 * {@link forgetFastestLapSessionMap}) and replaced on a `SubSessionID` or
 * unseen `SessionUniqueID`. The frames a walk lands on are NOT cached here:
 * they go into the replay record (`store.laps.recordLapStart`), which
 * outlives the process.
 */
let cachedFastestLapSessionMap: FastestLapSessionMap | null = null;

/**
 * Drops the session map: a disconnect is the one signal that the replay it
 * described is gone, and the next walk rebuilds against whatever is open
 * then. Leaving the replay for the car keeps it: the same replay may be
 * opened again.
 */
function forgetFastestLapSessionMap(): void {
  cachedFastestLapSessionMap = null;
}

// The engine's disconnect drops the map whether or not any Replay Control key or dial is on screen (#1467).
onReplayLeft(({ reason }) => {
  if (reason === "disconnected") forgetFastestLapSessionMap();
});

/**
 * @internal Exported for testing — clears the module-level session-map cache
 * so each test starts from a clean slate.
 */
export function _resetFastestLapSessionCache(): void {
  cachedFastestLapSessionMap = null;
}

/**
 * @internal Exported for testing — exposes the current cache state so tests
 * can assert the session map without poking at module-private variables.
 */
export function _getFastestLapSessionCache(): FastestLapSessionMap | null {
  return cachedFastestLapSessionMap;
}

/** What a converged walk writes into the lap record beside the frame it found. */
export type FastestLapRecordIdentity = {
  carNumberRaw: number;
  userId: number;
  /** `WeekendInfo.SubSessionID`, when readable; the store ignores a record for a session it is not holding. */
  subSessionId: number | undefined;
};

/**
 * Where a walk left the cursor. The replay is paused there; what it does next
 * is the caller's step (the **Replay jump playback** setting, #1276).
 */
export type FastestLapWalkLanding = {
  /** The sample read on the landed frame, which the playback step compares the speed wanted against. */
  telemetry: TelemetryData;
  /** The frame the cursor is on: `LAP_START_APPROACH_FRAMES` before `lapStartFrame`, at 0 at the latest. */
  landedFrame: number;
  /**
   * The frame the walk takes for the lap's start. When `converged`, the first
   * frame it read the car on the target lap, the frame before reading the
   * lap before it (#1432); otherwise, unverified, where the last lap search
   * on the lap before left the cursor (else the frame the lap steps ended on).
   */
  lapStartFrame: number;
  /** Whether the walk found the frame the car's lap counter flips. Only then did it go into the record. */
  converged: boolean;
  /**
   * The car's `CarIdxLapDistPct` where one of iRacing's lap searches last
   * left the cursor showing the car in the target session instance on the
   * lap before the target; null when none did. What a caller with a looser
   * need than the record's judges an unverified landing by (#1354, #1432).
   */
  priorLapDist: number | null;
  /**
   * Undo the walk: the cursor back on the frame the press found it on, at the
   * speed it had there. For a caller that will not use the landing; a walk
   * that gave up has already done it.
   */
  putBack: () => Promise<void>;
};

/** What the walk proper returns; `runFastestLapWalk` adds the way back. */
export type LapWalkResult = Omit<FastestLapWalkLanding, "putBack">;

/**
 * Where the press found the replay, for putting it back. `frame` is null
 * until the walk has read it from a settled sample, and again for a walk that
 * turned out to run from the car, where no command is honoured. `paused` says
 * whether the walk has sent its opening pause: a walk stopped after it and
 * before `frame` was read has moved the replay by that pause alone (#1428).
 */
export type LapWalkOrigin = { frame: number | null; paused: boolean };

/**
 * What a walk looks for: the start of one lap of one car in one session
 * instance. `instance` says which instance of `sessionNum`: the one the
 * cursor is in when the walk starts (Jump to Fastest Lap), or the latest one
 * in the recording — the target of a press made from outside that session,
 * which knows no `SessionUniqueID` for it (Jump to Race Start from practice
 * or qualifying, #1354).
 */
export type LapWalkTarget = {
  carIdx: number;
  lap: number;
  sessionNum: number;
  instance: "cursor" | "latest";
  identity: FastestLapRecordIdentity;
  /** What opens the walk's log lines, so each mode that walks reads as itself. */
  label: string;
};

/**
 * Within-session lap+dist range. A score is `SessionNum * SESSION_STRIDE +
 * (lap + dist)`; the stride must exceed any plausible (lap + dist) value so
 * `session` is the dominant comparison dimension. 24-hour endurance at 200
 * km/h on a 5 km track ≈ 960 laps, so 10_000 has a 10× margin.
 */
export const SESSION_STRIDE = 10_000;

/**
 * Result of sampling the player's score at one bisection probe (issue #607).
 * The walker compares this to `targetScore` to pick the next half-bracket and
 * to detect convergence; the discriminated union keeps the "is the car
 * in-world at this frame" check inline so the consumer can't accidentally
 * trust a stale `lap`/`dist` from a NotInWorld tick.
 */
export type FastestLapBisectionProbe =
  | { kind: "in-world"; sessionNum: number; lap: number; dist: number; score: number }
  | { kind: "out-of-world"; sessionNum: number }
  | { kind: "missing" };

/**
 * @internal Exported for testing.
 *
 * Compute the bisection score for the current frame from a telemetry sample.
 * Returns `in-world` with a monotonic `score` (`SessionNum * SESSION_STRIDE
 * + CarIdxLap + CarIdxLapDistPct`) when the target car has valid lap +
 * distance fields; `out-of-world` when the car is gone (lap or dist below
 * zero) but `SessionNum` is still readable; `missing` when even `SessionNum`
 * isn't available (caller must abort). Mirrors the #603 `frameScore`
 * convention so a future shared helper can absorb both.
 */
export function computeFastestLapBisectionProbe(
  telemetry: TelemetryData | null,
  carIdx: number,
): FastestLapBisectionProbe {
  const sessionNum = telemetry?.SessionNum;

  if (typeof sessionNum !== "number") return { kind: "missing" };

  const lap = (telemetry?.CarIdxLap as number[] | undefined)?.[carIdx];
  const dist = (telemetry?.CarIdxLapDistPct as number[] | undefined)?.[carIdx];

  if (typeof lap !== "number" || lap < 0 || typeof dist !== "number" || dist < 0) {
    return { kind: "out-of-world", sessionNum };
  }

  const score = sessionNum * SESSION_STRIDE + lap + dist;

  return { kind: "in-world", sessionNum, lap, dist, score };
}

/**
 * Walk to a lap start ({@link walkToLapStart}) and, when the walk gives up or
 * a camera switch interrupts it, put the replay back where the press found it
 * ({@link putReplayBack}). So a null landing means the press changed nothing:
 * a search that cannot find its lap must not leave the user somewhere in the
 * recording they did not ask for (#1354; as first built an aborted walk
 * stayed where it stopped, which for a car that had retired was the last
 * frame of the tape), and a camera key pressed during the search means the
 * driver no longer wants the lap (#1428 / #1435). The caller then undoes its
 * own camera move, as for a walk that gave up, and the camera switch that
 * interrupted the walk goes out after that.
 */
export async function runFastestLapWalk(
  jump: ReplayJump,
  target: LapWalkTarget,
): Promise<FastestLapWalkLanding | null> {
  const origin: LapWalkOrigin = { frame: null, paused: false };
  const putBack = (): Promise<void> => putReplayBack(jump, target.label, origin);
  let landing: LapWalkResult | null;

  try {
    landing = await walkToLapStart(jump, target, origin);
  } catch (error) {
    if (!(error instanceof LapWalkInterrupted)) throw error;

    await putReplayBack(jump, target.label, origin, error.by);

    return null;
  }

  // The search is over, found or not: what is left (the way back here, or
  // the caller's jump to the lap) is a plain jump a camera switch waits for.
  endReplayCursorInterrupts(jump.claim);

  if (landing === null) {
    await putBack();

    return null;
  }

  return { ...landing, putBack };
}

/**
 * Undo a walk that came to nothing, or that a camera switch interrupted
 * (`interruptedBy`, #1428 / #1435): the cursor back on the frame the press
 * found it on, then the speed it had there. Not the **Replay jump playback**
 * setting: nothing was jumped to, so the press leaves the replay as if it
 * had not been made. A walk that never read where the replay was but sent
 * its opening pause (stopped in that pause, or the telemetry never settled
 * after it) has moved the replay by the pause alone, so only the speed goes
 * back, when it was not zero. One that sent nothing, or that ran from the
 * car, where every command is ignored, sends nothing. A way back the sim
 * does not honour is logged, and the replay stays paused where the walk
 * stopped. Runs on an interrupted claim, which still holds the cursor;
 * throws {@link FastestLapPressCancelled} when another replay command has
 * taken the cursor: that command's own effect stands, and nothing more is
 * sent.
 */
export async function putReplayBack(
  jump: ReplayJump,
  label: string,
  origin: LapWalkOrigin,
  interruptedBy?: string,
): Promise<void> {
  const { frame } = origin;
  const { claim } = jump;
  const logger = lapPressLogger();

  if (frame === null) {
    if (!origin.paused) {
      if (interruptedBy !== undefined) {
        logger.info(`${label}: walk interrupted before it moved the replay`);
        logger.debug(`Interrupted by ${interruptedBy}; nothing to put back`);
      }

      return;
    }

    if (claim.cancelledBy !== null) throw new FastestLapPressCancelled(claim.cancelledBy);

    if (!restoreCapturedSpeed(jump, label, null)) {
      logNotPutBack(label, interruptedBy);

      return;
    }

    logPutBack(label, interruptedBy);
    logger.debug(`Opening pause undone: ${formatSpeedDisplay(jump.captured.speed, jump.captured.slowMotion)}`);

    return;
  }

  if (claim.cancelledBy !== null) throw new FastestLapPressCancelled(claim.cancelledBy);

  const readTelemetry = (): TelemetryData | null => engineReads().readTelemetry();
  const now = readTelemetry();
  // Out of the `SessionNum = -1` transient, where the frame reads 0 whatever it is.
  const onFrame = now?.ReplayFrameNum === frame && typeof now.SessionNum === "number" && now.SessionNum >= 0;

  if (!onFrame) {
    // The walk may have given up with a seek still under way, so the cursor
    // can be anywhere: the length of the recording bounds the way back.
    const recordingFrames =
      typeof now?.ReplayFrameNum === "number" && typeof now.ReplayFrameNumEnd === "number"
        ? now.ReplayFrameNum + now.ReplayFrameNumEnd
        : 0;
    const timeoutMs = replaySeekWaitMs(
      recordingFrames,
      readFastestLapSearchDelayMs() * STABILIZATION_TIMEOUT_MULTIPLIER,
    );
    const outcome = await seekReplayFrame({
      frame,
      claim,
      send: (f) => sendOwnedReplayCommand(claim, { kind: "jump", frame: f }) === "sent",
      readTelemetry,
      timeoutMs,
      pollMs: STABILIZATION_POLL_INTERVAL_MS,
    });

    if (outcome.kind === "cancelled") throw new FastestLapPressCancelled(outcome.by);

    if (outcome.kind !== "reached") {
      logger.warn(`${label}: could not put the replay back; it is left paused where the search stopped`);
      logger.debug(
        outcome.kind === "refused"
          ? `setPlayPosition to frame ${frame} failed`
          : `Sent frame ${frame}, saw frame ${outcome.telemetry?.ReplayFrameNum ?? "n/a"} after ${timeoutMs} ms`,
      );
      logNotPutBack(label, interruptedBy);

      return;
    }
  }

  if (!restoreCapturedSpeed(jump, label, frame)) {
    logNotPutBack(label, interruptedBy);

    return;
  }

  logPutBack(label, interruptedBy);
  logger.debug(`Frame ${frame}, ${formatSpeedDisplay(jump.captured.speed, jump.captured.slowMotion)} before the press`);
}

/**
 * Sends the speed captured at the press, when it was not zero: the way
 * back's last step, on `frame` once the cursor is back there (null when only
 * the opening pause is undone). False when the send failed, logged; throws
 * {@link FastestLapPressCancelled} when a replay command took the cursor.
 */
function restoreCapturedSpeed(jump: ReplayJump, label: string, frame: number | null): boolean {
  const { claim } = jump;
  const { speed, slowMotion } = jump.captured;

  if (speed === 0) return true;

  if (claim.cancelledBy !== null) throw new FastestLapPressCancelled(claim.cancelledBy);

  if (sendOwnedReplayCommand(claim, { kind: "speed", speed, slowMotion }) !== "sent") {
    const logger = lapPressLogger();

    if (frame === null) {
      logger.warn(`${label}: speed command failed; replay left paused`);
      logger.debug(`Failed setPlaySpeed: ${formatSpeedDisplay(speed, slowMotion)}`);
    } else {
      logger.warn(`${label}: speed command failed; replay left paused on the frame the press found it on`);
      logger.debug(`Failed setPlaySpeed: ${formatSpeedDisplay(speed, slowMotion)} on frame ${frame}`);
    }

    return false;
  }

  // The gate records the speed it sent, and the keys redraw from the speed state's change subscription.
  return true;
}

/** For a walk a camera switch interrupted whose way back failed (already warned): the press ends as interrupted. */
function logNotPutBack(label: string, interruptedBy: string | undefined): void {
  if (interruptedBy === undefined) return;

  const logger = lapPressLogger();

  logger.info(`${label}: walk interrupted; replay not put back`);
  logger.debug(`Interrupted by ${interruptedBy}; the way back did not complete`);
}

/** The way back's one info line: for a walk a camera switch interrupted, or one that came to nothing. */
function logPutBack(label: string, interruptedBy: string | undefined): void {
  lapPressLogger().info(
    interruptedBy === undefined
      ? `${label}: replay put back where the press found it`
      : `${label}: walk interrupted by ${interruptedBy}; replay put back`,
  );
}

/**
 * The walk itself: drive the cursor to the lap start and record the frame
 * when it was verified. It lands and does nothing about playback — the
 * replay is paused on the frame it returns, and the press applies the
 * **Replay jump playback** setting from there. Null for every abort, which
 * leaves the replay paused where the walk stopped for the caller,
 * {@link runFastestLapWalk}, to put back: `origin` is where it tells that
 * caller the frame the press found the replay on. Throws
 * {@link FastestLapPressCancelled} when another replay command took the
 * cursor, and {@link LapWalkInterrupted} when a camera switch interrupted the
 * walk, from its next `checkpoint` or poll.
 *
 * `target` names the lap, the session instance it is in and the mode the
 * walk runs for: Jump to Fastest Lap walks to a lap of the cursor's own
 * session, Jump to Race Start to lap 1 of a race session the cursor may not
 * be in (#1354).
 */
export async function walkToLapStart(
  jump: ReplayJump,
  target: LapWalkTarget,
  origin: LapWalkOrigin,
): Promise<LapWalkResult | null> {
  const { carIdx, lap: targetLap, sessionNum: targetSessionNum, identity, label: logLabel } = target;
  const { claim } = jump;
  const logger = lapPressLogger();

  /** One of the walk's own commands, through the replay command gate as the cursor's holder (#1430). */
  const send = (command: ReplayGateCommand): boolean => sendOwnedReplayCommand(claim, command) === "sent";

  /** A cancel throws {@link FastestLapPressCancelled}, an interrupt {@link LapWalkInterrupted}. */
  const checkpoint = (): void => throwIfWalkStopped(claim);

  /** The claim the walk's own waits poll: stopped by a cancel or an interrupt, which `checkpoint` tells apart. */
  const waitClaim = walkStopView(claim);

  /** Every wait in the walk: a cancellation or an interrupt is observed as soon as the sleep ends. */
  const wait = async (ms: number): Promise<void> => {
    await sleep(ms);
    checkpoint();
  };

  const readFrame = (tel: TelemetryData | null): number | null =>
    typeof tel?.ReplayFrameNum === "number" ? tel.ReplayFrameNum : null;

  /**
   * Whether any sample this walk read had the raw `IsReplayPlaying` true.
   * The debounced state that admitted the press cannot tell a press just
   * after a seek from one within a second of the user returning to the car
   * through iRacing's own UI (Esc, Drive) — but the walk's own samples can:
   * from the car the flag never reads true, and a replay command sent from
   * the car is ignored, so a map built on such samples describes the live
   * view and must not be kept (#1324).
   */
  let sawReplayFlag = false;

  /** Out of the `SessionNum = -1` transient — a sample whose per-car arrays can be read. */
  const isSettledSample = (tel: TelemetryData | null): tel is TelemetryData =>
    tel != null && typeof tel.SessionNum === "number" && tel.SessionNum >= 0;

  /**
   * Where the cursor may be when the next jump is sent: the frame of the last
   * settled sample, and the frame of a jump that was sent and not seen to
   * land. A seek under way reads frame 0, so the live sample cannot say.
   */
  let lastSettledFrame: number | null = null;
  let unlandedJumpFrame: number | null = null;

  /** Every telemetry sample the walk takes goes through here, so the flag check above sees them all. */
  const readTelemetry = (): TelemetryData | null => {
    const tel = engineReads().readTelemetry();

    if (tel?.IsReplayPlaying === true) sawReplayFlag = true;

    if (isSettledSample(tel) && typeof tel.ReplayFrameNum === "number") lastSettledFrame = tel.ReplayFrameNum;

    return tel;
  };

  const carLap = (tel: TelemetryData | null): number | undefined => (tel?.CarIdxLap as number[] | undefined)?.[carIdx];
  const carDist = (tel: TelemetryData | null): number | undefined =>
    (tel?.CarIdxLapDistPct as number[] | undefined)?.[carIdx];

  const settleTimeoutMs = (): number => readFastestLapSearchDelayMs() * STABILIZATION_TIMEOUT_MULTIPLIER;

  /**
   * Poll until the telemetry is out of the `SessionNum = -1` transient, or
   * null past the settle timeout. Used for the samples no command precedes.
   */
  const readSettledSample = async (): Promise<TelemetryData | null> => {
    const settled = await pollUntil(
      () => {
        // A cancellation or an interrupt is observed as soon as a sleep ends, as `wait` does it.
        checkpoint();

        const tel = readTelemetry();

        return isSettledSample(tel) ? tel : undefined;
      },
      { intervalMs: STABILIZATION_POLL_INTERVAL_MS, timeoutMs: settleTimeoutMs() },
    );

    return settled.kind === "done" ? settled.value : null;
  };

  /**
   * Send an absolute jump and wait until `ReplayFrameNum` reads the frame
   * that was sent. Null past the timeout, with the frame seen logged. The
   * wait grows with the jump's length (`replaySeekWaitMs`): a probe half a
   * long recording away takes longer to land than the settle timeout allows.
   */
  const jumpTo = async (frame: number): Promise<TelemetryData | null> => {
    checkpoint();

    const from = [lastSettledFrame, unlandedJumpFrame].filter((f): f is number => f !== null);
    const distance = Math.max(0, ...from.map((f) => Math.abs(frame - f)));
    const timeoutMs = replaySeekWaitMs(distance, settleTimeoutMs());

    unlandedJumpFrame = frame;

    const outcome = await seekReplayFrame({
      frame,
      claim: waitClaim,
      send: (f) => send({ kind: "jump", frame: f }),
      readTelemetry,
      timeoutMs,
      pollMs: STABILIZATION_POLL_INTERVAL_MS,
    });

    if (outcome.kind === "cancelled") {
      checkpoint();

      throw new FastestLapPressCancelled(outcome.by);
    }

    if (outcome.kind === "reached") {
      unlandedJumpFrame = null;

      return outcome.telemetry;
    }

    if (outcome.kind === "refused") {
      unlandedJumpFrame = null;
      logger.warn(`${logLabel}: jump not sent; aborting walk`);
      logger.debug(`setPlayPosition to frame ${frame} failed`);

      return null;
    }

    const last = outcome.telemetry;

    logger.warn(`${logLabel}: jump did not settle; aborting walk`);
    logger.debug(
      `Sent frame ${frame}, saw frame ${readFrame(last) ?? "n/a"} (SessionNum ${last?.SessionNum ?? "n/a"}) after ${timeoutMs} ms`,
    );

    return null;
  };

  type SearchOutcome =
    | { kind: "moved"; telemetry: TelemetryData }
    | { kind: "unmoved"; telemetry: TelemetryData | null }
    | { kind: "unsettled"; telemetry: TelemetryData | null };

  /**
   * Send a search and wait for its landing. `moved`: the frame left its
   * pre-command value and, after the configured minimum gap had elapsed,
   * held across two reads out of the transient — the decision sample is
   * always taken after the gap and must agree with the read before it, so
   * an intermediate frame the sim parks on for a moment is never taken as
   * the landing. `unmoved`: every read to the deadline showed the
   * pre-command frame (a search at the buffer's edge is a no-op the sim
   * never reports). `unsettled`: the frame moved but never held, or the
   * telemetry went away — the cursor is somewhere unverified.
   *
   * `waitMs` is how long the frame may stay on its pre-command value before
   * the search counts as `unmoved`: four times the settle gap unless the
   * caller knows the search may run longer. A session search does: it
   * covers its distance at the rate of a position jump, and on a paused
   * replay nothing in the telemetry moves until it lands, so one still under
   * way reads exactly like one that did nothing (measured 2026-10-13).
   */
  const search = async (
    command: () => boolean,
    label: string,
    waitMs: number = settleTimeoutMs(),
  ): Promise<SearchOutcome> => {
    checkpoint();

    const before = readFrame(readTelemetry());
    const sentAt = now();

    command();

    const gapMs = readFastestLapSearchDelayMs();
    const deadline = sentAt + waitMs;
    let held: number | null = null;
    let sawMovement = false;

    while (now() < deadline) {
      await wait(STABILIZATION_POLL_INTERVAL_MS);
      const tel = readTelemetry();
      const frame = readFrame(tel);

      if (frame === null) {
        held = null;
        sawMovement = true;
        continue;
      }

      if (frame === before) {
        held = null;
        continue;
      }

      sawMovement = true;

      if (held === frame && isSettledSample(tel) && now() - sentAt >= gapMs) {
        return { kind: "moved", telemetry: tel };
      }

      held = frame;
    }

    const telemetry = readTelemetry();

    if (!sawMovement) {
      logger.debug(`${logLabel}: ${label} did not move the cursor from frame ${before ?? "n/a"} in ${waitMs} ms`);

      return { kind: "unmoved", telemetry };
    }

    logger.warn(`${logLabel}: ${label} moved the cursor but it never settled; aborting`);
    logger.debug(
      `${label}: before=${before ?? "n/a"}, last seen frame=${readFrame(telemetry) ?? "n/a"} (SessionNum ${telemetry?.SessionNum ?? "n/a"}) after ${waitMs} ms`,
    );

    return { kind: "unsettled", telemetry };
  };

  /**
   * The map's frame for the target session instance's end: the next
   * instance's start, or — for the last one — the recording's current
   * length, read from this walk's own stable sample.
   */
  const resolveEndFrame = (entry: SessionMapEntry, sample: TelemetryData): number | null => {
    if (entry.endFrame !== null) return entry.endFrame;

    const frame = sample.ReplayFrameNum;
    const framesToEnd = sample.ReplayFrameNumEnd;

    return typeof frame === "number" && typeof framesToEnd === "number" ? frame + framesToEnd : null;
  };

  const buildSessionMap = async (subSessionId: number | undefined): Promise<FastestLapSessionMap | null> => {
    const sessionUniqueIds = new Set<number>();
    const sessions: SessionMapEntry[] = [];

    /** One settled step of the build: its entry, or null (aborts the build) with the reason logged. */
    const entryFrom = (tel: TelemetryData, label: string): SessionMapEntry | null => {
      const frame = tel.ReplayFrameNum;
      const sessionNum = tel.SessionNum;
      const sessionUniqueId = tel.SessionUniqueID;

      if (typeof frame !== "number" || typeof sessionNum !== "number" || typeof sessionUniqueId !== "number") {
        logger.warn(`${logLabel}: missing fields after ${label}; aborting map build`);
        logger.debug(`After ${label}: frame=${frame}, session=${sessionNum}, uniqueId=${sessionUniqueId}`);

        return null;
      }

      sessionUniqueIds.add(sessionUniqueId);

      return { sessionNum, sessionUniqueId, startFrame: frame, endFrame: null };
    };

    const first = await search(() => send({ kind: "go-to", end: "start" }), "goToStart");

    if (first.kind === "unsettled") return null;

    if (first.kind === "unmoved" && readFrame(first.telemetry) !== 0) {
      // Already at the start is the one legitimate no-op, and the start of
      // a recording is frame 0; anywhere else, the sim did not honour it.
      logger.warn(`${logLabel}: goToStart did not move the cursor; aborting map build`);
      logger.debug(`goToStart left the cursor at frame ${readFrame(first.telemetry) ?? "n/a"}`);

      return null;
    }

    if (!isSettledSample(first.telemetry)) {
      logger.warn(`${logLabel}: telemetry did not settle after goToStart; aborting map build`);

      return null;
    }

    const firstEntry = entryFrom(first.telemetry, "goToStart");

    if (firstEntry === null) return null;

    sessions.push(firstEntry);

    // Whether the loop saw the end of the recording, or ran out of steps first.
    let sawEnd = false;
    // In an event that is not offline, the last session the YAML lists is the
    // last there can be: nothing is searched for from inside it.
    const finalSessionNum =
      typeof subSessionId === "number" && subSessionId > 0 ? lastListedSessionNum(readSessionInfo()) : null;
    /** The sample of the session start the next search leaves from. */
    let at: TelemetryData = first.telemetry;

    for (let i = 0; i < MAX_SESSIONS; i++) {
      const label = `nextSession #${i + 1}`;

      if (finalSessionNum !== null && sessions[sessions.length - 1].sessionNum === finalSessionNum) {
        logger.debug(`${logLabel}: session ${finalSessionNum} is the last this event lists; ${label} not sent`);
        sawEnd = true;
        break;
      }

      // A Next Session search runs to the next session's start at the rate of
      // a position jump and shows nothing meanwhile, so it is given the time
      // a search to the end of the recording would take before it counts as
      // "already in the last session". Four times the settle gap, the wait
      // every search had, read a session longer than about 55 minutes that
      // way, and the map ended there.
      const framesToEnd = typeof at.ReplayFrameNumEnd === "number" ? at.ReplayFrameNumEnd : 0;
      const step = await search(
        () => send({ kind: "search", search: "nextSession" }),
        label,
        replaySeekWaitMs(framesToEnd, settleTimeoutMs()),
      );

      // Not moving is how the sim says "already in the last session"; a move
      // that never settled leaves the cursor unverified, and a map built on
      // it would be trusted by every later press.
      if (step.kind === "unmoved") {
        sawEnd = true;
        break;
      }

      if (step.kind === "unsettled") return null;

      const entry = entryFrom(step.telemetry, label);

      if (entry === null) return null;

      const last = sessions[sessions.length - 1];

      if (entry.sessionNum === last.sessionNum && entry.sessionUniqueId === last.sessionUniqueId) {
        sawEnd = true;
        break;
      }

      last.endFrame = entry.startFrame - 1;
      sessions.push(entry);
      at = step.telemetry;
    }

    return { subSessionId, sessionUniqueIds, sessions, truncated: !sawEnd };
  };

  // Refuse from the car: iRacing honours replay commands only out of it
  // (irsdk_defines.h: "camera and replay commands only work when you are out
  // of your car"), and a map built from ignored commands would describe the
  // live view, not the replay. The debounced state, not the raw flag, so a
  // press right after a seek is not taken for the car (#1324).
  if (!inReplayNow()) {
    logger.info(`${logLabel}: replay not open; iRacing ignores replay commands from the car`);

    return null;
  }

  // A jump still under way when the press came (a marker jump, a dial spin)
  // is let land first: a search sent into it would throw it, and its pause
  // would end it where it stands (#1430). A wait that runs out goes on: the
  // walk's first command is a position jump or a search from wherever the
  // replay is, and every later step reads where it landed.
  const settled = await waitForReplayJumpsToSettle(waitClaim);

  if (settled === "superseded") {
    checkpoint();

    throw new FastestLapPressCancelled(claim.cancelledBy ?? "unknown");
  }

  if (settled === "gave-up") logger.debug(`${logLabel}: a jump was still under way; walking anyway`);

  // Pause first so the cursor doesn't drift between commands and the
  // post-settle telemetry sample. The gate records the pause as the speed,
  // so a Play press during or after the walk sends play rather than pause,
  // and the keys redraw from it. A walk stopped from here on has moved the
  // replay by the pause at least, which its way back undoes.
  checkpoint();
  origin.paused = send({ kind: "pause" });
  await wait(readFastestLapSearchDelayMs());

  // Phase 1: session map (cache or build). The sample that keys it is a
  // stable one — the `SessionNum = -1` transient carries no usable id.
  const initialTel = await readSettledSample();

  if (initialTel === null) {
    logger.warn(`${logLabel}: telemetry did not settle after pause; aborting`);

    return null;
  }

  // Where the press found the replay: the frame every abort from here on is undone to.
  origin.frame = readFrame(initialTel);

  const cursorSessionUniqueId = initialTel.SessionUniqueID;

  if (typeof cursorSessionUniqueId !== "number") {
    logger.warn(`${logLabel}: SessionUniqueID unavailable; aborting`);

    return null;
  }

  const subSessionId = identity.subSessionId;
  let sessionMap = cachedFastestLapSessionMap;
  // A cached map is trusted for the cursor's own session: it holds that
  // session's unique id or it is rebuilt. It says nothing about a session
  // the cursor is not in — the race may have started, or been restarted,
  // since the build — so a walk to the latest instance of a `SessionNum`
  // builds the map afresh every time.
  const cacheHit =
    target.instance === "cursor" &&
    sessionMap != null &&
    sessionMap.subSessionId === subSessionId &&
    sessionMap.sessionUniqueIds.has(cursorSessionUniqueId);

  logger.info(
    `${logLabel}: cache ${cacheHit ? "HIT" : "MISS"} (subSession=${subSessionId ?? "n/a"}, currentUniqueId=${cursorSessionUniqueId}, cached=${
      sessionMap == null
        ? "<none>"
        : `subSession ${sessionMap.subSessionId ?? "n/a"} {${[...sessionMap.sessionUniqueIds].join(",")}}`
    })`,
  );

  if (sessionMap == null || !cacheHit) {
    const built = await buildSessionMap(subSessionId);

    if (built == null) return null;

    // Commit the map only if the walk was seen to run in a replay. From the
    // car every command was ignored and the "map" is the live view (one
    // session at frame 0): keeping it would send every later press to
    // bounds that describe nothing.
    if (!sawReplayFlag) {
      logger.info(`${logLabel}: the walk ran from the car (IsReplayPlaying never read true); session map discarded`);
      // Nothing to put back, and no command to do it with.
      origin.frame = null;
      origin.paused = false;

      return null;
    }

    sessionMap = built;
    cachedFastestLapSessionMap = built;
    logger.info(
      `${logLabel}: session map built — subSession=${subSessionId ?? "n/a"}, ${sessionMap.sessions
        .map((s) => `S${s.sessionNum}/${s.sessionUniqueId}[${s.startFrame}-${s.endFrame ?? "end"}]`)
        .join(", ")}`,
    );
  } else {
    logger.debug(`${logLabel}: reusing cached session map (${sessionMap.sessions.length} sessions)`);
  }

  // Phase 2: the target session INSTANCE's bounds. For the cursor's own
  // session that is the entry whose pair matches, so a restarted session's
  // earlier instance is never bisected. A target the cursor is not in has no
  // pair to match: it is the latest instance of its `SessionNum`, which is
  // the last such entry of a map built in frame order.
  const instances = sessionMap.sessions.filter((s) => s.sessionNum === targetSessionNum);
  const bounds =
    target.instance === "cursor"
      ? instances.find((s) => s.sessionUniqueId === cursorSessionUniqueId)
      : instances[instances.length - 1];

  // A map that ran out of steps does not know its last entry is the last
  // session, and the wrong pass of a race is worse than no jump. Like every
  // abort below, it ends with the caller putting the replay back: the map
  // build took the cursor through the recording and the opening pause
  // stopped a replay that may have been playing.
  if (target.instance === "latest" && sessionMap.truncated) {
    logger.warn(
      `${logLabel}: the recording holds more sessions than the ${MAX_SESSIONS + 1} the search maps; the latest session ${targetSessionNum} cannot be told, aborting`,
    );

    return null;
  }

  if (bounds == null) {
    if (target.instance === "cursor") {
      logger.warn(
        `${logLabel}: target session ${targetSessionNum}/${cursorSessionUniqueId} not in session map; aborting`,
      );
    } else {
      // Not a fault: the event lists a session the recording has not reached
      // (a live event still in qualifying), and nothing the plugin reads
      // before the search says so.
      logger.info(`${logLabel}: the target session is not in this recording yet`);
      logger.debug(
        `Session ${targetSessionNum} is in none of the ${sessionMap.sessions.length} mapped session instances`,
      );
    }

    return null;
  }

  const sessionUniqueId = bounds.sessionUniqueId;

  const endFrame = resolveEndFrame(bounds, initialTel);

  if (endFrame === null) {
    logger.warn(`${logLabel}: recording length unavailable (ReplayFrameNum + ReplayFrameNumEnd); aborting`);

    return null;
  }

  let loFrame = bounds.startFrame;
  let hiFrame = endFrame;

  if (hiFrame <= loFrame) {
    logger.warn(
      `${logLabel}: empty session bounds for session ${targetSessionNum}/${sessionUniqueId} (lo=${loFrame}, hi=${hiFrame}); aborting`,
    );

    return null;
  }

  // The bisection and the lap steps aim at the lap BEFORE the target: the
  // side of the line the crossing phase brackets the lap start from.
  const targetLapMinus1 = Math.max(0, targetLap - 1);

  // Phase 3: bisect within the target session until we're within
  // CLOSE_ENOUGH_LAPS of the lap-before-fastest. Only a probe that shows the
  // car moves a bound: the lower one when its lap is before the target, the
  // upper one otherwise. A probe that finds the car out of the world is no
  // information — gone before it joined, after it retired, or in the garage
  // between two runs — so it moves nothing and the next frame of the open
  // interval is tried instead (`halvingProbeFrames`), up to
  // MAX_ABSENT_PROBES of them in a walk (#1354).
  let bisectionSteps = 0;
  let absentProbes = 0;
  let tel: TelemetryData | null = initialTel;
  /** The probe that showed the car nearest the target lap: where the lap steps start when the bisection stops short. */
  let nearest: { frame: number; lap: number } | null = null;
  let closeEnough = false;
  let bisecting = true;

  while (bisecting && hiFrame - loFrame > 1) {
    let boundMoved = false;

    for (const mid of halvingProbeFrames(loFrame, hiFrame)) {
      if (bisectionSteps >= MAX_BISECTION_STEPS || absentProbes >= MAX_ABSENT_PROBES) {
        bisecting = false;
        break;
      }

      tel = await jumpTo(mid);

      if (tel == null) return null;

      // The bounds are the map's, and a frame inside them that reads another
      // session says the map does not describe this recording: a session
      // search that had not landed when the build stopped waiting for it, or
      // a recording that changed under a cached map. Bisecting on would
      // compare laps across a session boundary, so the walk stops and the map
      // is dropped, for the next press to build afresh.
      if (tel.SessionNum !== targetSessionNum || tel.SessionUniqueID !== sessionUniqueId) {
        logger.warn(
          `${logLabel}: a probe inside session ${targetSessionNum}/${sessionUniqueId} read session ${tel.SessionNum ?? "n/a"}/${tel.SessionUniqueID ?? "n/a"}; the session map does not match the recording, aborting`,
        );
        logger.debug(`Probe frame ${mid}, bounds ${bounds.startFrame}-${endFrame}; cached session map dropped`);
        cachedFastestLapSessionMap = null;

        return null;
      }

      const lap = carLap(tel);

      if (typeof lap !== "number" || lap < 0) {
        absentProbes++;
        continue;
      }

      bisectionSteps++;

      if (nearest === null || Math.abs(lap - targetLapMinus1) < Math.abs(nearest.lap - targetLapMinus1)) {
        nearest = { frame: mid, lap };
      }

      if (Math.abs(lap - targetLapMinus1) <= CLOSE_ENOUGH_LAPS) {
        logger.debug(
          `${logLabel}: bisection landed within ${CLOSE_ENOUGH_LAPS} laps after ${bisectionSteps} steps (frame=${mid}, lap=${lap}, target=${targetLapMinus1})`,
        );
        closeEnough = true;
        bisecting = false;
        break;
      }

      if (lap < targetLapMinus1) {
        loFrame = mid;
      } else {
        hiFrame = mid;
      }

      boundMoved = true;
      break;
    }

    // Every frame between the bounds was tried and none showed the car.
    if (!boundMoved) bisecting = false;
  }

  if (absentProbes > 0) {
    logger.debug(`${logLabel}: ${absentProbes} probe(s) found carIdx ${carIdx} out of the world and moved no bound`);

    if (nearest === null) {
      logger.warn(
        `${logLabel}: carIdx ${carIdx} was not found on track in session ${targetSessionNum}/${sessionUniqueId}; aborting`,
      );

      return null;
    }

    // The last probe may be one that found the car gone: the lap steps
    // start from the best frame the bisection saw the car on.
    if (!closeEnough && readFrame(tel) !== nearest.frame) {
      tel = await jumpTo(nearest.frame);

      if (tel == null) return null;
    }
  }

  /** Why the walk did not converge, or null while it still may. Set once; the first reason stands. */
  let notConverged: string | null = null;

  // Phase 4: lap-step until we're on the lap-before-fastest. `tel` is the
  // settled sample of the last command, so each step reads before it sends.
  let lapSteps = 0;
  /**
   * Whether the sample in `tel` is where one of iRacing's own lap searches
   * left the cursor, as opposed to a bisection probe. Only a lap search
   * knows where a line is crossed.
   */
  let landedByLapSearch = false;

  for (let step = 0; step < MAX_LAP_STEPS; step++) {
    const lap = carLap(tel);

    if (typeof lap !== "number" || lap < 0) {
      logger.warn(`${logLabel}: CarIdxLap unavailable during lap-step ${step} (lap=${lap}); aborting`);

      return null;
    }

    if (lap === targetLapMinus1) {
      logger.debug(
        `${logLabel}: lap-step phase converged after ${lapSteps} steps (lap=${lap}, target=${targetLapMinus1})`,
      );
      break;
    }

    const stepped =
      lap < targetLapMinus1
        ? await search(() => send({ kind: "search", search: "nextLap" }), "nextLap")
        : await search(() => send({ kind: "search", search: "prevLap" }), "prevLap");

    lapSteps = step + 1;

    if (stepped.kind === "unmoved") {
      logger.warn(`${logLabel}: lap-step ${step} did not move the cursor; aborting`);

      return null;
    }

    if (stepped.kind === "unsettled") return null;

    tel = stepped.telemetry;
    landedByLapSearch = true;
  }

  // The loop's last step is never read by the loop itself: the budget may
  // have run out one lap short, or far off after a corrupted bisection.
  if (carLap(tel) !== targetLapMinus1) {
    notConverged = `lap-step budget of ${MAX_LAP_STEPS} exhausted at lap ${carLap(tel) ?? "n/a"}, target ${targetLapMinus1}`;
  }

  // Phase 5: the crossing (#1432). The walk has converged when it holds two
  // frames at most LAP_CROSSING_MAX_FRAMES apart, the earlier reading the car
  // on the lap before the target and the later on the target lap, both in the
  // target session instance; a bisection then narrows them to adjacent
  // frames, and the later is the lap start. Nothing about the distance enters
  // it: iRacing's lap search rests short of the line by an offset it does not
  // keep (11 frames on #1432's tape, about 100 for lap 1 of a rolling start).
  // Every probe is an absolute jump that reads back before the next is sent,
  // so a cancel or an interrupt stops the phase as it stops a bisection probe.
  const describeSample = (sample: TelemetryData | null): string =>
    `lap=${carLap(sample) ?? "n/a"}, dist=${typeof carDist(sample) === "number" ? (carDist(sample) as number).toFixed(4) : "n/a"}, session=${sample?.SessionNum ?? "n/a"}/${sample?.SessionUniqueID ?? "n/a"}`;
  const inTargetSession = (sample: TelemetryData | null): boolean =>
    sample?.SessionNum === targetSessionNum && sample?.SessionUniqueID === sessionUniqueId;

  /** A sample on one side of the line: the lap before the target (`before`) or the target lap (`on`). */
  type CrossingSample = { frame: number; sample: TelemetryData; side: "before" | "on" };

  /** Which side of the line a sample is on, or what else it read, for the log. */
  const crossingSide = (sample: TelemetryData): "before" | "on" | string => {
    if (!inTargetSession(sample)) return `session ${sample.SessionNum ?? "n/a"}/${sample.SessionUniqueID ?? "n/a"}`;

    const lap = carLap(sample);
    const dist = carDist(sample);

    if (typeof lap !== "number" || lap < 0 || typeof dist !== "number" || dist < 0) return "the car out of the world";

    if (lap === targetLapMinus1) return "before";

    if (lap === targetLap) return "on";

    return `lap ${lap}`;
  };

  /** A crossing step that ended the phase: the walk aborts (a jump that did not land), or does not converge. */
  type CrossingStop = { kind: "aborted" } | { kind: "stopped"; reason: string };

  let crossingProbes = 0;
  let nudges = 0;
  /**
   * Where a lap search last left the cursor on the lap before the target, in
   * the target session instance: what an unconverged walk returns as its
   * unverified lap start, and the sample its `priorLapDist` is read on.
   */
  let searchLanding: TelemetryData | null = null;

  const toFrameInSession = (frame: number): number => Math.min(endFrame, Math.max(bounds.startFrame, frame));

  /** One crossing probe: an absolute jump, read back, that must land on one side of the line. */
  const probeCrossing = async (frame: number): Promise<CrossingSample | CrossingStop> => {
    const sample = await jumpTo(frame);

    crossingProbes++;

    if (sample == null) return { kind: "aborted" };

    const side = crossingSide(sample);

    if (side !== "before" && side !== "on") {
      return { kind: "stopped", reason: `a crossing probe on frame ${frame} read ${side}` };
    }

    return { frame, sample, side };
  };

  type Bracket =
    | { kind: "bracketed"; before: CrossingSample; on: CrossingSample }
    | { kind: "unbracketed"; reason: string; last: CrossingSample };

  /**
   * Look for the other side of the line from `anchor`: forward from the lap
   * before, backward from the target lap, first LAP_CROSSING_NEAR_FRAMES away
   * and then LAP_CROSSING_MAX_FRAMES, each clamped to the session instance.
   * `from` names the anchor for the log.
   */
  const bracketFrom = async (anchor: CrossingSample, from: string): Promise<Bracket | CrossingStop> => {
    const direction = anchor.side === "before" ? 1 : -1;
    let last = anchor;

    for (const reach of [LAP_CROSSING_NEAR_FRAMES, LAP_CROSSING_MAX_FRAMES]) {
      const frame = toFrameInSession(anchor.frame + direction * reach);

      if (frame === last.frame) break;

      const probe = await probeCrossing(frame);

      if (!("side" in probe)) return probe;

      if (probe.side !== anchor.side) {
        return direction === 1
          ? { kind: "bracketed", before: last, on: probe }
          : { kind: "bracketed", before: probe, on: last };
      }

      last = probe;
    }

    const where = `${from} (frame ${anchor.frame}, ${describeSample(anchor.sample)})`;

    return {
      kind: "unbracketed",
      last,
      reason:
        direction === 1
          ? `lap ${targetLap} not reached within ${LAP_CROSSING_MAX_FRAMES} frames of ${where}`
          : `lap ${targetLapMinus1} not found within ${LAP_CROSSING_MAX_FRAMES} frames before ${where}`,
    };
  };

  /** The crossing the walk found: the adjacent frames either side of the line, and the anchor it was bracketed from. */
  type Crossing = { before: CrossingSample; on: CrossingSample; anchor: CrossingSample; from: string };

  /** Bracket from `anchor`, then bisect the bracket to adjacent frames. */
  const findCrossing = async (
    anchor: CrossingSample,
    from: string,
  ): Promise<Crossing | Extract<Bracket, { kind: "unbracketed" }> | CrossingStop> => {
    const bracket = await bracketFrom(anchor, from);

    if (bracket.kind !== "bracketed") return bracket;

    let { before, on } = bracket;

    while (on.frame - before.frame > 1) {
      const probe = await probeCrossing(Math.floor((before.frame + on.frame) / 2));

      if (!("side" in probe)) return probe;

      if (probe.side === "before") before = probe;
      else on = probe;
    }

    return { before, on, anchor, from };
  };

  /**
   * The one Next Lap nudge, for a cursor the lap steps did not leave near the
   * line: where it lands is bracketed from, forward on the lap before the
   * target, backward on the target lap (the old overshoot, which a Previous
   * Lap recovered at an offset nobody had measured).
   */
  const nudge = async (why: string): Promise<CrossingSample | CrossingStop> => {
    logger.debug(`${logLabel}: nudging via nextLap (${why})`);

    const forward = await search(() => send({ kind: "search", search: "nextLap" }), "nextLap (nudge)");

    nudges++;

    if (forward.kind !== "moved") return { kind: "stopped", reason: `nudge (nextLap) ${forward.kind}` };

    const sample = forward.telemetry;
    const frame = readFrame(sample);
    const side = crossingSide(sample);

    if (frame === null || (side !== "before" && side !== "on")) {
      return { kind: "stopped", reason: `nudge (nextLap) on frame ${frame ?? "n/a"} read ${side}` };
    }

    if (side === "before") {
      searchLanding = sample;
    } else {
      logger.debug(`${logLabel}: nextLap landed on lap ${targetLap}; bracketing back from frame ${frame}`);
    }

    return { frame, sample, side };
  };

  // Where the lap steps left the cursor: what every abort and every walk that
  // does not converge falls back on.
  const stepsFrame = readFrame(tel);

  if (stepsFrame === null) {
    logger.warn(`${logLabel}: ReplayFrameNum unavailable after the lap steps; aborting`);

    return null;
  }

  if (notConverged === null && !inTargetSession(tel)) {
    notConverged = `landed outside the target session ${targetSessionNum}/${sessionUniqueId} (${describeSample(tel)})`;
  }

  let crossing: Crossing | null = null;

  if (notConverged === null && tel !== null && crossingSide(tel) === "before") {
    const stepsSample: CrossingSample = { frame: stepsFrame, sample: tel, side: "before" };
    const lapSearchLanding = "the lap search's landing";
    /** The first search that did not bracket: its reason stands for the walk. */
    let firstMiss: string | null = null;
    /** The furthest frame the last attempt that did not bracket read. */
    let missedOn = stepsFrame;

    /** One bracket attempt: true when the phase is over, found or stopped. */
    const attempt = async (anchor: CrossingSample, from: string): Promise<boolean | "aborted"> => {
      const found = await findCrossing(anchor, from);

      if ("anchor" in found) {
        crossing = found;

        return true;
      }

      if (found.kind === "aborted") return "aborted";

      if (found.kind === "stopped") {
        notConverged = found.reason;

        return true;
      }

      firstMiss ??= found.reason;
      missedOn = found.last.frame;

      return false;
    };

    /** The nudge, then a bracket from its landing: true when the phase is over. */
    const nudgeAndAttempt = async (why: string): Promise<boolean | "aborted"> => {
      const landing = await nudge(why);

      if (!("side" in landing)) {
        if (landing.kind === "aborted") return "aborted";

        notConverged = landing.reason;

        return true;
      }

      return attempt(landing, lapSearchLanding);
    };

    let over: boolean | "aborted";

    if (landedByLapSearch) {
      // A lap search's landing is near the line, or the nudge is owed.
      searchLanding = tel;
      over = await attempt(stepsSample, lapSearchLanding);

      if (over === false) over = await nudgeAndAttempt(`lap ${targetLapMinus1} still read on frame ${missedOn}`);
    } else {
      // A bisection probe is anywhere in the lap: the nudge first, and the
      // probe's own frame only for one that fell in the lap's last frames.
      // On lap 0 this is what keeps a car standing on its grid slot within
      // metres of the line from being taken for one at it (#1354).
      over = await nudgeAndAttempt(`the lap steps ended on a bisection probe, frame ${stepsFrame}`);

      if (over === false) over = await attempt(stepsSample, "the bisection probe");
    }

    if (over === "aborted") return null;

    if (over === false) notConverged = firstMiss;
  } else if (notConverged === null && tel !== null) {
    notConverged = `the lap steps ended on ${crossingSide(tel)} (frame ${stepsFrame})`;
  }

  // Phase 6: the search has its answer, or has given up. A cancellation or an
  // interrupt that arrived during the last crossing probe ends the press
  // here, before anything is recorded. From here on a camera switch no
  // longer interrupts the walk (#1428 / #1435): the jump to the lap's run-up
  // is a plain jump, which it waits for.
  checkpoint();
  endReplayCursorInterrupts(claim);

  const found = crossing as Crossing | null;
  const lapStartFrame = found !== null ? found.on.frame : (readFrame(searchLanding) ?? stepsFrame);
  const landedFrame = Math.max(0, lapStartFrame - LAP_START_APPROACH_FRAMES);
  const searchLandingDist = carDist(searchLanding);
  const priorLapDist = typeof searchLandingDist === "number" ? searchLandingDist : null;
  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const probes = count(crossingProbes, "crossing probe");
  const iterations = `${bisectionSteps} bisection + ${lapSteps} lap-step + ${nudges} nudge iterations + ${probes}`;

  if (found === null) {
    logger.warn(`${logLabel}: walk did not converge (${notConverged ?? "no crossing found"}); nothing recorded`);
    logger.debug(
      `${logLabel}: gave up after ${iterations} (lap start frame=${lapStartFrame}, landed frame=${landedFrame}, target=${targetLap}, session=${targetSessionNum}/${sessionUniqueId})`,
    );
  } else {
    // The first frame on the target lap is where this car started it: into
    // the record it goes, so the next press for this lap is a lookup (and a
    // press after a restart, and a marker-style jump from another feature).
    // It is what the live recorder writes too: the first tick of the lap.
    let recorded = false;

    if (isReplaySessionStoreInitialized()) {
      recorded = getReplaySessionStore().laps.recordLapStart({
        subSessionId,
        sessionNum: targetSessionNum,
        sessionUniqueId,
        carIdx,
        carNumberRaw: identity.carNumberRaw,
        userId: identity.userId,
        lap: targetLap,
        frame: lapStartFrame,
      });
    }

    const offset = lapStartFrame - found.anchor.frame;
    const anchorSays =
      found.from === "the bisection probe"
        ? `the bisection probe was ${count(offset, "frame")} before it`
        : `the lap search landed ${count(Math.abs(offset), "frame")} ${offset >= 0 ? "before" : "after"} it`;

    logger.info(`${logLabel}: walk converged (lap start ${recorded ? "recorded" : "not recorded"})`);
    logger.debug(`${logLabel}: lap ${targetLap} starts at frame ${lapStartFrame}; ${anchorSays} (${probes})`);
    logger.debug(
      `${logLabel}: converged after ${iterations} (lap start frame=${lapStartFrame}, landed frame=${landedFrame}, ${describeSample(found.on.sample)}, target=${targetLap}, session=${targetSessionNum}/${sessionUniqueId})`,
    );
  }

  // Phase 7: the cursor to the lap's run-up, where a record jump to the same
  // lap lands, so the first press of a lap and every later one look alike.
  // The replay is left paused there.
  const finalTel = await jumpTo(landedFrame);

  if (finalTel == null) return null;

  return { telemetry: finalTel, landedFrame, lapStartFrame, converged: found !== null, priorLapDist };
}
