import {
  applyGraphicTransform,
  assembleIcon,
  type BusyMark,
  busyMarkSvg,
  CommonSettings,
  computeGraphicArea,
  extractGraphicContent,
  generateBorderParts,
  generateTitleText,
  getGlobalBorderSettings,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  ICON_BASE_TEMPLATE,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckTouchTapEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  parseSvgViewBox,
  renderIconTemplate,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
} from "@iracedeck/deck-core";
import { getCommands, SimIRacingAction } from "@iracedeck/deck-iracing";
import fastForwardIconSvg from "@iracedeck/icons/replay-control/fast-forward.svg";
import frameBackwardIconSvg from "@iracedeck/icons/replay-control/frame-backward.svg";
import frameForwardIconSvg from "@iracedeck/icons/replay-control/frame-forward.svg";
import jumpToBeginningIconSvg from "@iracedeck/icons/replay-control/jump-to-beginning.svg";
import jumpToFastestLapIconSvg from "@iracedeck/icons/replay-control/jump-to-fastest-lap.svg";
import jumpToLiveIconSvg from "@iracedeck/icons/replay-control/jump-to-live.svg";
import jumpToMyCarIconSvg from "@iracedeck/icons/replay-control/jump-to-my-car.svg";
import jumpToRaceStartIconSvg from "@iracedeck/icons/replay-control/jump-to-race-start.svg";
import nextCarNumberIconSvg from "@iracedeck/icons/replay-control/next-car-number.svg";
import nextCarIconSvg from "@iracedeck/icons/replay-control/next-car.svg";
import nextIncidentIconSvg from "@iracedeck/icons/replay-control/next-incident.svg";
import nextLapIconSvg from "@iracedeck/icons/replay-control/next-lap.svg";
import nextSessionIconSvg from "@iracedeck/icons/replay-control/next-session.svg";
import pauseIconSvg from "@iracedeck/icons/replay-control/pause.svg";
import playBackwardIconSvg from "@iracedeck/icons/replay-control/play-backward.svg";
import playPauseIconSvg from "@iracedeck/icons/replay-control/play-pause.svg";
import prevCarNumberIconSvg from "@iracedeck/icons/replay-control/prev-car-number.svg";
import prevCarIconSvg from "@iracedeck/icons/replay-control/prev-car.svg";
import prevIncidentIconSvg from "@iracedeck/icons/replay-control/prev-incident.svg";
import prevLapIconSvg from "@iracedeck/icons/replay-control/prev-lap.svg";
import prevSessionIconSvg from "@iracedeck/icons/replay-control/prev-session.svg";
import rewindIconSvg from "@iracedeck/icons/replay-control/rewind.svg";
import setSpeedIconSvg from "@iracedeck/icons/replay-control/set-speed.svg";
import slowMotionRewindIconSvg from "@iracedeck/icons/replay-control/slow-motion-rewind.svg";
import slowMotionIconSvg from "@iracedeck/icons/replay-control/slow-motion.svg";
import speedDecreaseIconSvg from "@iracedeck/icons/replay-control/speed-decrease.svg";
import speedDisplayIconSvg from "@iracedeck/icons/replay-control/speed-display.svg";
import speedIncreaseIconSvg from "@iracedeck/icons/replay-control/speed-increase.svg";
import stopIconSvg from "@iracedeck/icons/replay-control/stop.svg";
import {
  getAllCarNumbers,
  getCarNumberRawFromSessionInfo,
  replaySpeedFromTelemetry,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import {
  getReplaySessionStore,
  type GreenLookup,
  type GreenQuery,
  isReplaySessionStoreInitialized,
  type LapStartLookup,
  type LapStartQuery,
} from "@iracedeck/replay-store";
import { getGlobalColors } from "@iracedeck/settings";
import z from "zod";

import { CAR_CYCLE_BINDING_KEYS } from "../../shared/car-cycle-bindings.js";
import { computeCarNumberTarget } from "../../shared/car-cycling.js";
import { RepeatController } from "../../shared/repeat-controller.js";
import {
  getReplayBusyLook,
  registerReplayBusySurface,
  type ReplayBusyLook,
  reportReplayPressIgnored,
  setReplayBusyIndicatorLogger,
} from "../../shared/replay-busy-indicator.js";
import { replayBusyKeyMark, replayBusyMarkKey } from "../../shared/replay-busy-mark.js";
import {
  pressReplayCommand,
  type ReplayGateCommand,
  type ReplayPressResult,
  sendOwnedReplayCommand,
  setReplayCommandGateLogger,
  waitForReplayJumpsToSettle,
} from "../../shared/replay-command-gate.js";
import { cancelReplayCursorOwner, type ReplayCursorClaim } from "../../shared/replay-cursor.js";
import {
  applyReplayJumpPlayback,
  beginReplayJump,
  describeReplayJump,
  type ReplayJump,
  type ReplayJumpApplied,
  type ReplayJumpOutcome,
  runReplayJump,
} from "../../shared/replay-jump-playback.js";
import { replaySeekWaitMs, seekReplayFrame } from "../../shared/replay-seek.js";
import {
  readFastestLapSearchDelayMs,
  STABILIZATION_POLL_INTERVAL_MS,
  STABILIZATION_TIMEOUT_MULTIPLIER,
} from "../../shared/replay-timing.js";
import { unavailableLook } from "../../shared/unavailable-look.js";
import {
  acceptsGreenFallbackLanding,
  greenApproachFrame,
  type GreenFlagTarget,
  isRaceStartUnavailable,
  lastListedSessionNum,
  resolveGreenFallbackCar,
  resolveGreenFlagTarget,
  resolvePoleCarIdx,
} from "./green-flag-target.js";
import { halvingProbeFrames } from "./lap-walk-probes.js";
import { replayControlDialField } from "./replay-control-dial-settings.js";
import { ReplayControlDialSurface } from "./replay-control-dial-surface.js";
import { formatSpeedDisplay, parseSpeedSetting } from "./replay-speed-format.js";
import { noteTelemetrySpeed } from "./replay-speed-state.js";

// The speed text helpers moved to their own module so the dial surface shares
// them (#1316); re-exported so this module's API is unchanged.
export { formatSpeedDisplay, parseSpeedSetting } from "./replay-speed-format.js";

const REPLAY_CONTROL_MODES = [
  "play-pause",
  "play-backward",
  "stop",
  "fast-forward",
  "rewind",
  "slow-motion",
  "slow-motion-rewind",
  "frame-forward",
  "frame-backward",
  "speed-increase",
  "speed-decrease",
  "set-speed",
  "speed-display",
  "next-session",
  "prev-session",
  "next-lap",
  "prev-lap",
  "next-incident",
  "prev-incident",
  "jump-to-beginning",
  "jump-to-live",
  "jump-to-my-car",
  "jump-to-fastest-lap",
  "jump-to-race-start",
  "next-car",
  "prev-car",
  "next-car-number",
  "prev-car-number",
] as const;

type ReplayControlMode = (typeof REPLAY_CONTROL_MODES)[number];

const REPLAY_CONTROL_ICONS: Record<ReplayControlMode, string> = {
  "play-pause": playPauseIconSvg,
  "play-backward": playBackwardIconSvg,
  stop: stopIconSvg,
  "fast-forward": fastForwardIconSvg,
  rewind: rewindIconSvg,
  "slow-motion": slowMotionIconSvg,
  "slow-motion-rewind": slowMotionRewindIconSvg,
  "frame-forward": frameForwardIconSvg,
  "frame-backward": frameBackwardIconSvg,
  "speed-increase": speedIncreaseIconSvg,
  "speed-decrease": speedDecreaseIconSvg,
  "set-speed": setSpeedIconSvg,
  "speed-display": speedDisplayIconSvg,
  "next-session": nextSessionIconSvg,
  "prev-session": prevSessionIconSvg,
  "next-lap": nextLapIconSvg,
  "prev-lap": prevLapIconSvg,
  "next-incident": nextIncidentIconSvg,
  "prev-incident": prevIncidentIconSvg,
  "jump-to-beginning": jumpToBeginningIconSvg,
  "jump-to-live": jumpToLiveIconSvg,
  "jump-to-my-car": jumpToMyCarIconSvg,
  "jump-to-fastest-lap": jumpToFastestLapIconSvg,
  "jump-to-race-start": jumpToRaceStartIconSvg,
  "next-car": nextCarIconSvg,
  "prev-car": prevCarIconSvg,
  "next-car-number": nextCarNumberIconSvg,
  "prev-car-number": prevCarNumberIconSvg,
};

const REPLAY_CONTROL_TITLES: Record<ReplayControlMode, string> = {
  "play-pause": "PLAY / PAUSE",
  "play-backward": "PLAY BACKW",
  stop: "STOP",
  "fast-forward": "FAST\nFORWARD",
  rewind: "REWIND",
  "slow-motion": "SLOW\nMOTION",
  "slow-motion-rewind": "SLOW\nREWIND",
  "frame-forward": "FRAME FWD",
  "frame-backward": "FRAME BACK",
  "speed-increase": "REPLAY\nFASTER",
  "speed-decrease": "REPLAY\nSLOWER",
  "set-speed": "SET SPEED",
  "speed-display": "REPLAY\nSPEED",
  "next-session": "SESSION\nNEXT",
  "prev-session": "SESSION\nPREVIOUS",
  "next-lap": "NEXT\nLAP",
  "prev-lap": "PREVIOUS\nLAP",
  "next-incident": "INCIDENT\nNEXT",
  "prev-incident": "INCIDENT\nPREVIOUS",
  "jump-to-beginning": "JUMP TO\nBEGINNING",
  "jump-to-live": "JUMP TO\nLIVE",
  "jump-to-my-car": "JUMP TO\nMY CAR",
  "jump-to-fastest-lap": "FASTEST\nLAP",
  "jump-to-race-start": "RACE\nSTART",
  "next-car": "CAR\nNEXT",
  "prev-car": "CAR\nPREVIOUS",
  "next-car-number": "CAR #\nNEXT",
  "prev-car-number": "CAR #\nPREVIOUS",
};

/**
 * Modes that depend on a global key binding (rather than an SDK command). Keys
 * live in `shared/car-cycle-bindings.ts`, because Camera Controls' Cycle by
 * Track Order taps the same two bindings (#1277); the defaults (V / Shift+V)
 * are declared in `data/key-bindings.json`.
 */
const KEYSTROKE_MODES: Partial<Record<ReplayControlMode, string>> = {
  "next-car": CAR_CYCLE_BINDING_KEYS.next,
  "prev-car": CAR_CYCLE_BINDING_KEYS.previous,
};

/** Modes whose display changes based on telemetry state */
const TELEMETRY_DISPLAY_MODES: ReadonlySet<ReplayControlMode> = new Set([
  "play-pause",
  "play-backward",
  "speed-display",
]);

/** Modes that support long-press repeat */
const LONG_PRESS_REPEAT_MODES: ReadonlySet<ReplayControlMode> = new Set([
  "fast-forward",
  "rewind",
  "slow-motion",
  "slow-motion-rewind",
  "frame-forward",
  "frame-backward",
  "speed-increase",
  "speed-decrease",
]);

const LONG_PRESS_INITIAL_DELAY = 500;
/**
 * Gap between the completion of one repeat tick and the start of the next.
 * The loop is self-awaiting so the effective cadence is `executeMode_duration + this`.
 * executeMode here is a fast synchronous SDK broadcast (~microseconds), so the gap
 * is essentially the whole period — matches the pre-fix setInterval cadence.
 */
const LONG_PRESS_REPEAT_GAP_MS = 250;
/** Maximum duration for long-press repeat before auto-stop (safety net for missed keyUp) */
const LONG_PRESS_MAX_DURATION_MS = 15_000;

/**
 * Safety cap on the bisection probes that show the car and so move a bound
 * (issue #607). log₂(N) jumps converge in ~24 steps for a 2-hour endurance
 * replay at 60 Hz (~430 k frames), so 30 is a comfortable engineering ceiling.
 * Distinct from the old `MAX_LAP_SEARCH_STEPS` cap, which had to absorb O(N)
 * lap-by-lap walks and a `× gap` wall-clock budget — the bisection's
 * wall-clock is ~`30 × gap` worst case.
 */
const MAX_BISECTION_STEPS = 30;

/**
 * How many bisection probes of one walk may find the car out of the world
 * (#1354). Such a probe moves no bound — the car is gone before it joins,
 * after it retires and while it sits in the garage, and one frame cannot tell
 * which — so the walk tries the next frame of the open interval instead
 * (`halvingProbeFrames`). 31 is five rounds of halving: a car that was on track
 * for a sixteenth of the session is found, and a car that never was costs the
 * walk ~`31 × gap` before it gives up and puts the replay back.
 */
const MAX_ABSENT_PROBES = 31;

// Jump to Fastest Lap is a lookup first and a walk second (issue #1203,
// docs/superpowers/specs/2026-09-24-issue-1203-fastest-lap-from-session-record.md).
//
// The lookup reads the per-session replay record (`getReplaySessionStore().laps`,
// written live by the translator's lap-crossing events): a hit is one
// `setPlayPosition` to `LAP_START_APPROACH_FRAMES` before the recorded lap
// start and, once the cursor has landed there, one camera switch.
//
// Either way the press ends as the Replay jump playback global setting says
// (#1276, `shared/replay-jump-playback.ts`): at the speed the replay had when
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
//      is the lap before the target, a distance nudge to its end, and a
//      two-tick back-step.
//
// #1203 changed how the walk waits and ends: an absolute jump settles when
// `ReplayFrameNum` reads the frame that was sent, a search when the frame has
// moved and held; every speed sent is mirrored into the action's speed cache;
// one walk runs per action instance and any other Replay Control command
// cancels it; and a converged walk writes its landed frame into the record,
// so the next press is a lookup.

/**
 * After bisection, the lap-step phase takes over. `CLOSE_ENOUGH_LAPS = 2`
 * means the bisection exits when the player car is within 2 laps of the
 * target either way — the lap-step phase finishes the job with at most a
 * few `nextLap` / `prevLap` calls.
 */
const CLOSE_ENOUGH_LAPS = 2;

/**
 * Safety cap on the lap-step phase. iRacing's lap navigation is precise so
 * this should never trip in practice; it exists for the case where the
 * SDK's reported `CarIdxLap` doesn't change after a `nextLap` / `prevLap`
 * broadcast (e.g. cursor at the buffer edge).
 */
const MAX_LAP_STEPS = 10;

/**
 * Sanity cap on the number of sessions in a single replay. Most iRacing
 * sessions have at most 4 (practice / qualifying / warmup / race); 10 is
 * generous headroom.
 */
const MAX_SESSIONS = 10;

/**
 * Threshold for `CarIdxLapDistPct` (0..1) at which the cursor is "close
 * enough to the end of the lap". After lap-step lands on the right lap,
 * if dist is below this we do one extra `nextLap` (with `prevLap` recovery
 * on overshoot) so the cursor parks at the very end of the lap-before-the-
 * fastest, ready for a Play press to show the line-crossing.
 */
const FASTEST_LAP_DIST_THRESHOLD = 0.999;

/**
 * Number of `prevFrame` calls applied as the very last step. At 60 Hz that's
 * ~16 ms per tick, so 2 ticks ≈ 32 ms of buffer before the line-crossing —
 * the cursor lands far enough back that the next Play press shows the car
 * visibly approaching, not already crossing.
 */
const FASTEST_LAP_FINAL_BACKSTEP_TICKS = 2;

/**
 * Frames before the recorded lap start a record hit lands at: one second of
 * approach in the in-session replay, two in a saved file (a live-recorded
 * frame lands about a second early there — the #1162 lag decision), both
 * showing the crossing into the timed lap.
 */
const LAP_START_APPROACH_FRAMES = 60;

/**
 * How far the record's lap time may differ from `ResultsPositions[].FastestTime`
 * before the lookup logs the disagreement: one sim tick. The lap-number
 * convention (that `FastestLap` counts laps the way `CarIdxLap` does, so the
 * record's `lap` matches) is what a disagreement would contradict; the jump
 * still happens.
 */
const FASTEST_TIME_TOLERANCE_MS = 1000 / 60;

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
type SessionMapEntry = {
  sessionNum: number;
  sessionUniqueId: number;
  startFrame: number;
  endFrame: number | null;
};

type FastestLapSessionMap = {
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
 * subscriber's null tick) and replaced on a `SubSessionID` or unseen
 * `SessionUniqueID`. The frames a walk lands on are NOT cached here: they go
 * into the replay record (`store.laps.recordLapStart`), which outlives the
 * process.
 */
let cachedFastestLapSessionMap: FastestLapSessionMap | null = null;

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

/**
 * Thrown inside a Jump to Fastest Lap press — the walk or a record jump — when
 * a replay command, any action's, took the cursor; `holdFastestLapSlot` catches it.
 */
class FastestLapPressCancelled extends Error {
  constructor(
    readonly by: string,
    noun: "walk" | "jump" = "walk",
  ) {
    super(`${noun} cancelled by ${by}`);
    this.name = "FastestLapPressCancelled";
  }
}

/** The owner name the walk claims the replay cursor under (`shared/replay-cursor.ts`). */
const FASTEST_LAP_WALK_OWNER = "jump-to-fastest-lap walk";

/** The owner name a record jump claims the replay cursor under while it waits for the landing (#1275). */
const FASTEST_LAP_RECORD_JUMP_OWNER = "jump-to-fastest-lap record jump";

/** What opens the log lines of a Jump to Fastest Lap press, where a shared step writes them. */
const FASTEST_LAP_LOG_LABEL = "Jump to fastest lap";

// Jump to Race Start (issue #1354,
// docs/superpowers/specs/2026-10-05-issue-1354-replay-jump-to-green-flag.md)
// is a lookup first too. The race start is recorded live in the replay
// record's `greens` section (the translator's `replay.greenFlag`), so a press
// is one waited jump to five seconds before it, with no camera switch: the
// green belongs to the whole field. With no recorded green the pole car's
// lap 1 stands in for it, from the lap record when it holds that lap, else
// from the walk above run for lap 1. The press shares Jump to Fastest Lap's
// in-flight slot and ends as the Replay jump playback setting says.

/** The owner name a Jump to Race Start press claims the replay cursor under for its single waited jump. */
const RACE_START_JUMP_OWNER = "jump-to-race-start jump";

/** The owner name a Jump to Race Start press claims the replay cursor under while it searches for the pole car's lap 1. */
const RACE_START_WALK_OWNER = "jump-to-race-start walk";

/** What opens the log lines of a Jump to Race Start press. */
const RACE_START_LOG_LABEL = "Jump to race start";

/** How a press that holds the in-flight slot names itself: on the replay cursor, and in the log. */
type ReplayPressIdentity = {
  owner: string;
  noun: "walk" | "jump";
  /** What opens the press's log lines. */
  label: string;
};

/** What a converged walk writes into the lap record beside the frame it found. */
type FastestLapRecordIdentity = {
  carNumberRaw: number;
  userId: number;
  /** `WeekendInfo.SubSessionID`, when readable; the store ignores a record for a session it is not holding. */
  subSessionId: number | undefined;
};

/**
 * Where a walk left the cursor. The replay is paused there; what it does next
 * is the caller's step (the **Replay jump playback** setting, #1276).
 */
type FastestLapWalkLanding = {
  /** The sample read on the landed frame, which the playback step compares the speed wanted against. */
  telemetry: TelemetryData;
  /** The frame the cursor is on: the back-step short of where the walk got to. */
  landedFrame: number;
  /** The frame the walk takes for the lap's start: `landedFrame` plus the back-step. Verified only when `converged`. */
  lapStartFrame: number;
  /** Whether the walk verified the landing as the lap start. Only then did it go into the record. */
  converged: boolean;
  /**
   * The car's `CarIdxLapDistPct` on the landed frame, when one of iRacing's
   * lap searches put the cursor there and that sample shows the car in the
   * target session instance on the lap before the target; null otherwise. What a caller with a looser need than the record's
   * judges an unverified landing by (#1354, #1432).
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
type LapWalkResult = Omit<FastestLapWalkLanding, "putBack">;

/**
 * Where the press found the replay, for putting it back. `frame` is null
 * until the walk has read it from a settled sample, and again for a walk that
 * turned out to run from the car, where no command is honoured.
 */
type LapWalkOrigin = { frame: number | null };

/**
 * What a walk looks for: the start of one lap of one car in one session
 * instance. `instance` says which instance of `sessionNum`: the one the
 * cursor is in when the walk starts (Jump to Fastest Lap), or the latest one
 * in the recording — the target of a press made from outside that session,
 * which knows no `SessionUniqueID` for it (Jump to Race Start from practice
 * or qualifying, #1354).
 */
type LapWalkTarget = {
  carIdx: number;
  lap: number;
  sessionNum: number;
  instance: "cursor" | "latest";
  identity: FastestLapRecordIdentity;
  /** What opens the walk's log lines, so each mode that walks reads as itself. */
  label: string;
};

/** A green lookup's outcome, widened with the case where no store was initialized (tests, a plugin without one). */
type RecordedGreenLookup = GreenLookup | { hit: false; reason: "no store" };

/** A record lookup's outcome, widened with the case where no store was initialized (tests, a plugin without one). */
type RecordedLapStartLookup = LapStartLookup | { hit: false; reason: "no store" };

/** The `ResultsPositions` entry for a car in a session, matched by `SessionNum` field, not array index. */
function findResultsPosition(
  sessionInfo: unknown,
  sessionNum: number,
  carIdx: number,
): Record<string, unknown> | undefined {
  const sessionInfoRoot = (sessionInfo as Record<string, unknown> | undefined)?.SessionInfo as
    Record<string, unknown> | undefined;
  const sessions = sessionInfoRoot?.Sessions as Array<Record<string, unknown>> | undefined;
  const session = sessions?.find((s) => (s?.SessionNum as number | undefined) === sessionNum);
  const positions = session?.ResultsPositions as Array<Record<string, unknown>> | undefined;

  return positions?.find((p) => (p?.CarIdx as number | undefined) === carIdx);
}

/** `WeekendInfo.SubSessionID` as a finite number, else undefined (nothing loaded yet). */
function readSubSessionId(sessionInfo: unknown): number | undefined {
  const weekend = (sessionInfo as Record<string, unknown> | undefined)?.WeekendInfo as
    Record<string, unknown> | undefined;
  const raw = weekend?.SubSessionID;
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;

  return Number.isFinite(value) ? value : undefined;
}

/** `DriverInfo.Drivers[].UserID` for a car, else 0 — stored for a person reading the file, never matched on. */
function readUserId(sessionInfo: unknown, carIdx: number): number {
  const driverInfo = (sessionInfo as Record<string, unknown> | undefined)?.DriverInfo as
    Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers as Array<Record<string, unknown>> | undefined;
  const userId = drivers?.find((d) => (d?.CarIdx as number | undefined) === carIdx)?.UserID;

  return typeof userId === "number" && Number.isFinite(userId) ? userId : 0;
}

/**
 * Within-session lap+dist range. A score is `SessionNum * SESSION_STRIDE +
 * (lap + dist)`; the stride must exceed any plausible (lap + dist) value so
 * `session` is the dominant comparison dimension. 24-hour endurance at 200
 * km/h on a 5 km track ≈ 960 laps, so 10_000 has a 10× margin.
 */
const SESSION_STRIDE = 10_000;

/**
 * @internal Exported for testing
 *
 * Calculates the gauge needle angle for a speed setting value.
 * Scale: 1/16x = -90°, 1x = 0°, 16x = 90°.
 */
export function calculateNeedleAngle(speedSetting: string): number {
  const { speed, slowMotion } = parseSpeedSetting(speedSetting);

  // Map to position 0-30: slow-mo (0-14), 1x (15), fast (16-30)
  const position = slowMotion ? 16 - speed : 14 + speed;

  return ((position - 15) / 15) * 90;
}

/**
 * @internal Exported for testing
 *
 * Formats a speed setting value for display on the set-speed icon.
 */
export function formatSetSpeedLabel(speedSetting: string): string {
  const { speed, slowMotion } = parseSpeedSetting(speedSetting);

  return formatSpeedDisplay(speed, slowMotion);
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the replay control action.
 * When mode is "play-pause", the label toggles based on isPlaying state.
 * When mode is "speed-display", the label shows the current speed.
 * When mode is "set-speed", the label shows the configured speed.
 * With `unavailable`, a static mode draws the greyed, faded look Replay
 * Markers gives a key whose press would do nothing (Jump to Race Start in a
 * replay with no race session, #1354).
 * With `busy`, the artwork gives way to the replay busy mark (#1437) while the
 * title and border stay; it wins over `unavailable` and `bindingMissing`, as
 * `assembleIcon` decides for the modes it draws. Speed Display and Set Speed,
 * assembled here by hand, draw the same mark in the same place.
 */
export function generateReplayControlSvg(
  settings: { mode: ReplayControlMode; speed?: string } & Partial<CommonSettings>,
  isPlaying?: boolean,
  replaySpeed?: number,
  replaySlowMotion?: boolean,
  bindingMissing = false,
  unavailable = false,
  busy?: BusyMark,
): string {
  const { mode } = settings;

  let iconSvg = REPLAY_CONTROL_ICONS[mode] || REPLAY_CONTROL_ICONS["play-pause"];
  const defaultTitle = REPLAY_CONTROL_TITLES[mode] || REPLAY_CONTROL_TITLES["play-pause"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);

  // speed-display: dynamic template variable (speedText) embedded in the graphic snippet
  if (mode === "speed-display") {
    const speed = replaySpeed ?? 0;
    const slowMo = replaySlowMotion ?? false;
    const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);
    const rawGraphic = extractGraphicContent(iconSvg);
    let graphicContent = title.showGraphics
      ? renderIconTemplate(rawGraphic, { speedText: formatSpeedDisplay(speed, slowMo), ...colors })
      : "";
    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);
    const viewBox = parseSvgViewBox(iconSvg);

    if (busy) {
      graphicContent = handBuiltBusyMark(busy, title, colors);
    } else if (graphicContent && viewBox) {
      graphicContent = applyGraphicTransform(
        graphicContent,
        { x: 0, y: 0, width: viewBox.width, height: viewBox.height },
        computeGraphicArea(title),
        graphic.scale,
      );
    }

    const titleContent = title.showTitle
      ? generateTitleText({
          text: title.titleText,
          fontSize: title.fontSize,
          bold: title.bold,
          position: title.position,
          customPosition: title.customPosition,
          fill: colors.textColor ?? "#ffffff",
        })
      : "";
    const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);
    const borderSvg = generateBorderParts(border);
    const borderContent = borderSvg.defs + borderSvg.rects;
    const svg = renderIconTemplate(ICON_BASE_TEMPLATE, {
      backgroundColor: colors.backgroundColor ?? "#000000",
      graphicContent,
      titleContent,
      borderContent,
    });

    return svgToDataUri(svg);
  }

  // set-speed: dynamic template variable (needleAngle) embedded in the graphic snippet
  if (mode === "set-speed" && settings.speed) {
    const mainLabel = formatSetSpeedLabel(settings.speed);
    const needleAngle = String(calculateNeedleAngle(settings.speed));
    const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, mainLabel);
    const rawGraphic = extractGraphicContent(iconSvg);
    let graphicContent = title.showGraphics
      ? renderIconTemplate(rawGraphic, { mainLabel, needleAngle, ...colors })
      : "";
    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);
    const viewBox = parseSvgViewBox(iconSvg);

    if (busy) {
      graphicContent = handBuiltBusyMark(busy, title, colors);
    } else if (graphicContent && viewBox) {
      graphicContent = applyGraphicTransform(
        graphicContent,
        { x: 0, y: 0, width: viewBox.width, height: viewBox.height },
        computeGraphicArea(title),
        graphic.scale,
      );
    }

    const titleContent = title.showTitle
      ? generateTitleText({
          text: title.titleText,
          fontSize: title.fontSize,
          bold: title.bold,
          position: title.position,
          customPosition: title.customPosition,
          fill: colors.textColor ?? "#ffffff",
        })
      : "";
    const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);
    const borderSvg = generateBorderParts(border);
    const borderContent = borderSvg.defs + borderSvg.rects;
    const svg = renderIconTemplate(ICON_BASE_TEMPLATE, {
      backgroundColor: colors.backgroundColor ?? "#000000",
      graphicContent,
      titleContent,
      borderContent,
    });

    return svgToDataUri(svg);
  }

  // play-pause / play-backward: icon switches to pause when playing
  if ((mode === "play-pause" || mode === "play-backward") && isPlaying) {
    iconSvg = pauseIconSvg;
    const pauseColors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
    const title = resolveTitleSettings(
      iconSvg,
      getGlobalTitleSettings(),
      settings.titleOverrides,
      REPLAY_CONTROL_TITLES[mode],
    );

    const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

    return assembleIcon({ graphicSvg: iconSvg, colors: pauseColors, title, border, graphic, busy });
  }

  // All other modes: static title via assembleIcon
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({
    graphicSvg: iconSvg,
    title,
    graphic,
    bindingMissing,
    busy,
    // A busy key keeps its own colours: the mark takes `graphic1Color`, which
    // the unavailable look would have turned grey.
    ...(unavailable && !busy ? unavailableLook(colors, border) : { colors, border }),
  });
}

/**
 * The busy mark for an icon assembled by hand (Speed Display, Set Speed): in
 * the title-aware graphic area, in the colour `assembleIcon` gives it, and
 * whether or not the graphic is shown.
 */
function handBuiltBusyMark(
  busy: BusyMark,
  title: Parameters<typeof computeGraphicArea>[0],
  colors: Record<string, string>,
): string {
  return busyMarkSvg(busy, computeGraphicArea(title), colors.graphic1Color ?? colors.textColor ?? "#ffffff");
}

/**
 * @internal Exported for testing
 *
 * Resolves a car's fastest lap number for the **current replay session**,
 * preferring `SessionInfo.Sessions[].ResultsPositions[].FastestLap` over
 * live telemetry. `ResultsPositions` is the authoritative post-session
 * record iRacing populates as soon as a replay is loaded — `CarIdxBestLapNum`
 * only fills in for laps the replay cursor has actually visited, which is
 * empty on a freshly-loaded replay.
 *
 * Session matching is by `SessionNum` field equality (not by array index),
 * because the array order is not contractually tied to the session number.
 *
 * Returns `null` when neither source yields a positive lap number.
 */
export function findFastestLapForCar(
  sessionInfo: unknown,
  telemetry: TelemetryData | null,
  carIdx: number,
): number | null {
  const sessionNum = telemetry?.SessionNum as number | undefined;

  if (typeof sessionNum === "number") {
    const fastestLap = findResultsPosition(sessionInfo, sessionNum, carIdx)?.FastestLap as number | undefined;

    if (typeof fastestLap === "number" && fastestLap > 0) {
      return fastestLap;
    }
  }

  // Fallback for live sessions where ResultsPositions hasn't been written yet
  // (race in progress, practice without finalised positions, etc.).
  const bestLapNums = telemetry?.CarIdxBestLapNum as number[] | undefined;
  const telemetryLap = bestLapNums?.[carIdx];

  if (typeof telemetryLap === "number" && telemetryLap > 0) {
    return telemetryLap;
  }

  return null;
}

/**
 * @internal Exported for testing
 *
 * Find the next or previous car by car number order.
 * Returns the CarNumberRaw value for camera API use, or null if not found.
 *
 * Walks every car the session has had (issue #1281) — in the pits, towed or
 * departed alike — over the same competitor list as Camera Controls' car-number
 * walk (no pace car, no spectators), through the shared
 * `computeCarNumberTarget`. There is no world-presence filter: a camera switch
 * to a car that has left the world works, live and in a replay scrubbed back to
 * when it raced, and the per-car telemetry arrays read the live field during an
 * in-session replay, so they could not say whether the car is racing at the
 * replay moment anyway.
 */
export function findAdjacentCarByNumber(
  sessionInfo: unknown,
  currentCarIdx: number,
  direction: "next" | "prev",
): number | null {
  const allCars = getAllCarNumbers(sessionInfo, true, true);
  const target = computeCarNumberTarget(currentCarIdx, allCars, direction === "next" ? "next" : "previous");

  return target?.carNumberRaw ?? null;
}

/**
 * Result of sampling the player's score at one bisection probe (issue #607).
 * The walker compares this to `targetScore` to pick the next half-bracket and
 * to detect convergence; the discriminated union keeps the "is the car
 * in-world at this frame" check inline so the consumer can't accidentally
 * trust a stale `lap`/`dist` from a NotInWorld tick.
 */
type FastestLapBisectionProbe =
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

const ReplayControlSettings = CommonSettings.extend({
  mode: z.enum(REPLAY_CONTROL_MODES).default("play-pause"),
  speed: z.string().default("1"),
  stepRate: z.coerce.number().int().min(1).max(15).default(1),
  fastestLapTarget: z.enum(["viewed-car", "always-my-car"]).default("viewed-car"),
  dial: replayControlDialField,
});

type ReplayControlSettings = z.infer<typeof ReplayControlSettings>;

/**
 * Replay Control
 * Unified replay action combining transport, speed, and navigation controls.
 * Provides progressive speed control for fast-forward, rewind, and slow-motion
 * with telemetry-driven display. Since #1316 the action is dual-surface: a dial
 * instance routes every event to {@link ReplayControlDialSurface}.
 */
export const REPLAY_CONTROL_UUID = "com.iracedeck.sd.core.replay-control" as const;

/**
 * The modes that send no replay command, only a camera change or a keystroke:
 * they stay outside the replay command gate (#1430) and take the replay
 * cursor themselves, which stops a walk searching on the camera's car.
 */
const CAMERA_ONLY_MODES: ReadonlySet<ReplayControlMode> = new Set<ReplayControlMode>([
  "jump-to-my-car",
  "next-car",
  "prev-car",
  "next-car-number",
  "prev-car-number",
]);

/**
 * The key modes whose own command is a jump or a search: the replay busy
 * indicator draws them working while the gate reports it under way (#1437).
 * Every other mode that sends a replay command draws only waiting and not
 * done: a speed key's command is never under way, and a held Frame Forward is
 * under way for as long as the finger is down.
 */
const BUSY_DRAWS_WORKING_MODES: ReadonlySet<ReplayControlMode> = new Set<ReplayControlMode>([
  "next-session",
  "prev-session",
  "next-lap",
  "prev-lap",
  "next-incident",
  "prev-incident",
  "jump-to-beginning",
  "jump-to-live",
  "jump-to-fastest-lap",
  "jump-to-race-start",
]);

/**
 * Whether a key in `mode` registers with the replay busy indicator: every mode
 * whose press sends a replay command with the key's context as its origin.
 * The camera and car modes send none, and Speed Display sends nothing at all.
 */
function registersReplayBusy(mode: ReplayControlMode): boolean {
  return !CAMERA_ONLY_MODES.has(mode) && mode !== "speed-display";
}

/** What a press through the gate came to, for the `Result:` debug line: the SDK's answer when it went out. */
function pressResult(result: ReplayPressResult): string {
  return result.kind === "sent" ? String(result.ok) : result.kind;
}

export class ReplayControl extends SimIRacingAction<ReplayControlSettings> {
  /** Current replay speed from telemetry, keyed by action context ID */
  private replaySpeed = new Map<string, number>();

  /** Current slow-motion state from telemetry, keyed by action context ID */
  private replaySlowMotion = new Map<string, boolean>();

  private readonly repeat = new RepeatController(this.logger);

  /** @internal Compat accessor — tests read repeat state via this field. */
  private get repeatTimers() {
    return this.repeat.timers;
  }

  /** @internal Compat accessor — tests read held state via this field. */
  private get heldButtons() {
    return this.repeat.heldButtons;
  }

  /** Cached settings per context for telemetry-driven display updates */
  private activeContexts = new Map<string, ReplayControlSettings>();

  /**
   * The one in-flight Jump to Fastest Lap or Jump to Race Start press, per
   * action instance — two keys would otherwise run two walks against one
   * cursor. A second press of either while it stands is dropped before any
   * command is sent. Any replay command — this
   * action's other modes, Replay Markers' jumps — cancels it through the
   * shared cursor claim, and the walk unwinds at its next await without
   * sending anything more. A cancelled walk no longer holds the slot: a new
   * press walks while the old one unwinds.
   */
  private activeFastestLapPress: { contextId: string; claim: ReplayCursorClaim } | null = null;

  /** Last rendered state key per context (prevents redundant re-renders) */
  private lastState = new Map<string, string>();

  /**
   * Per key context registered with the replay busy indicator (#1437): the
   * unregister its registration returned. A mode that sends no replay command
   * has no entry.
   */
  private readonly busyRegistrations = new Map<string, () => void>();

  /** The dial half of the action (#1316); every dial event routes here. */
  private readonly dialSurface = new ReplayControlDialSurface({
    logger: this.logger,
    // The controller's debounced state (#1324): raw `IsReplayPlaying` reads
    // false for ~300 ms after every seek, which would drop detents after one.
    inReplay: () => this.sdkController.getReplayState().inReplay,
    // A fresh read every time, never the last tick delivered: a subscriber is
    // told only when `SessionTick` advances, and a paused or scrubbed replay
    // changes without it. The surface takes one per entry; a tick brings its own.
    telemetry: () => this.sdkController.getCurrentTelemetry(),
    setLocalSpeed: (speed, slowMotion) => this.setLocalSpeed(speed, slowMotion),
    // The keypad's own Jump to Live, cursor take and replay-state note included, under the dial's
    // token so its box shows the busy look (#1437).
    jumpToLive: (origin) => this.executeMode(origin ?? "__dial__", this.parseSettings({ mode: "jump-to-live" })),
    // The keypad's own Jump to Race Start press (#1354), guards and fallback included.
    jumpToRaceStart: (origin) =>
      this.executeMode(origin ?? "__dial__", this.parseSettings({ mode: "jump-to-race-start" })),
    canJumpToRaceStart: () =>
      resolveGreenFlagTarget(this.sdkController.getSessionInfo(), this.sdkController.getCurrentTelemetry()) !== null,
    refreshKeys: () => this.updateAllTelemetryDisplays(),
  });

  /**
   * Per Jump to Race Start context: whether the key shows the unavailable
   * look, and the session info it was judged from. iRacing republishes the
   * session YAML only when something in it changed, so a tick usually compares
   * one reference and stops.
   */
  private raceStartShown = new Map<string, { sessionInfo: unknown; unavailable: boolean }>();

  constructor(logger?: ILogger) {
    super(logger);
    // Every replay command this action sends goes through the one gate
    // (#1430), whose own lines (a press held behind a jump, one dropped) go
    // to a scope of this action's log.
    setReplayCommandGateLogger(this.logger.createScope("ReplayGate"));
    // The busy indicator (#1437) reads that gate; its lines (a look started or
    // ended, a spinner stopped at its ceiling) go to a scope of their own.
    setReplayBusyIndicatorLogger(this.logger.createScope("ReplayBusy"));
  }

  override async onWillAppear(ev: IDeckWillAppearEvent<ReplayControlSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      const contextId = ev.action.id;

      await this.dialSurface.willAppear(ev.action, settings.dial);
      // A dial joins the speed cache and the telemetry subscription, but never
      // the key contexts: it has no key icon and no binding.
      this.seedTelemetryState(contextId, this.sdkController.getCurrentTelemetry());
      this.sdkController.subscribe(contextId, (telemetry: TelemetryData | null) =>
        this.onDialTelemetry(contextId, telemetry),
      );

      return;
    }

    this.activeContexts.set(ev.action.id, settings);
    this.setActiveBinding(KEYSTROKE_MODES[settings.mode] ?? null);
    // Before the first draw: an unregistered key reads rest, and a key coming
    // back while its press still stands shows the look at once.
    this.syncBusyRegistration(ev.action.id, settings.mode);

    // Seed initial state from current telemetry
    const current = this.sdkController.getCurrentTelemetry();
    this.seedTelemetryState(ev.action.id, current);

    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry: TelemetryData | null) => {
      // A disconnect is the one signal that the replay this map described is
      // gone; the next walk rebuilds against whatever is open then.
      if (telemetry === null) cachedFastestLapSessionMap = null;

      const prevStateKey = this.buildTelemetryStateKey(ev.action.id);
      this.updateTelemetryState(ev.action.id, telemetry);
      this.rememberReplaySpeed(telemetry);
      const newStateKey = this.buildTelemetryStateKey(ev.action.id);

      const storedSettings = this.activeContexts.get(ev.action.id);

      if (storedSettings && prevStateKey !== newStateKey) {
        this.logger.debug(
          `Telemetry state changed: ${prevStateKey} -> ${newStateKey}, mode=${storedSettings.mode}, inDisplayModes=${TELEMETRY_DISPLAY_MODES.has(storedSettings.mode)}`,
        );

        if (TELEMETRY_DISPLAY_MODES.has(storedSettings.mode)) {
          this.updateDisplayFromTelemetry(ev.action.id, storedSettings);
        }
      }

      this.refreshRaceStartAvailability(ev.action.id);
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<ReplayControlSettings>): Promise<void> {
    this.repeat.clear(ev.action.id);
    this.dialSurface.willDisappear(ev.action.id);
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.replaySpeed.delete(ev.action.id);
    this.replaySlowMotion.delete(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
    this.raceStartShown.delete(ev.action.id);
    this.busyRegistrations.get(ev.action.id)?.();
    this.busyRegistrations.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<ReplayControlSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    // Settings can change mid-hold; drop any pending repeat and held state.
    this.repeat.clear(ev.action.id);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      await this.dialSurface.didReceiveSettings(ev.action, settings.dial);

      return;
    }

    this.activeContexts.set(ev.action.id, settings);
    this.setActiveBinding(KEYSTROKE_MODES[settings.mode] ?? null);
    // The mode may have changed, and with it whether the key registers and
    // whether it draws working.
    this.syncBusyRegistration(ev.action.id, settings.mode);
    await this.updateDisplay(ev, settings);
  }

  /**
   * Registers a key with the replay busy indicator for its mode, replacing any
   * registration it had, or unregisters it when the mode sends no replay
   * command. The new registration goes in before the old one is dropped, so a
   * look standing for the token (a not done's second) carries over.
   */
  private syncBusyRegistration(contextId: string, mode: ReplayControlMode): void {
    const previous = this.busyRegistrations.get(contextId);

    if (registersReplayBusy(mode)) {
      this.busyRegistrations.set(
        contextId,
        registerReplayBusySurface({
          token: contextId,
          drawsWorking: BUSY_DRAWS_WORKING_MODES.has(mode),
          redraw: (look) => this.redrawBusyKey(contextId, look),
        }),
      );
    } else {
      this.busyRegistrations.delete(contextId);
    }

    previous?.();
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<ReplayControlSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeMode(ev.action.id, settings);

    if (LONG_PRESS_REPEAT_MODES.has(settings.mode)) {
      this.repeat.onKeyDown(ev.action.id, {
        holdMs: LONG_PRESS_INITIAL_DELAY,
        intervalMs: LONG_PRESS_REPEAT_GAP_MS,
        safetyMs: LONG_PRESS_MAX_DURATION_MS,
        execute: () => {
          // A repeat of the held key, not a second press: behind a search it waits rather than taking over.
          this.executeMode(ev.action.id, settings, true);

          return true;
        },
      });
    }
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<ReplayControlSettings>): Promise<void> {
    this.repeat.onKeyUp(ev.action.id);
  }

  override async onDialDown(ev: IDeckDialDownEvent<ReplayControlSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.down(ev.action, settings.dial);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<ReplayControlSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.rotate(ev.action, settings.dial, ev.payload.ticks, ev.payload.pressed === true);
  }

  override async onDialUp(ev: IDeckDialUpEvent<ReplayControlSettings>): Promise<void> {
    await this.dialSurface.up(ev.action.id);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<ReplayControlSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.touchTap(ev.action, settings.dial, ev.payload.hold === true);
  }

  /**
   * One telemetry tick for a dial context. Its replay speed is decoded once
   * for all three uses: the shared speed cache, the speed Play/Pause resumes,
   * and the dial's own screen, which is handed the tick so comparing its frame
   * costs no telemetry read and redraws only on a change.
   */
  private onDialTelemetry(contextId: string, telemetry: TelemetryData | null): void {
    // As for a key: a disconnect is the one signal that the replay the
    // fastest-lap map described is gone, and a page of dials alone must not
    // miss it.
    if (telemetry === null) cachedFastestLapSessionMap = null;

    const speed = telemetry ? replaySpeedFromTelemetry(telemetry) : null;

    // The keypad's `updateTelemetryState`, from the speed already decoded: no
    // telemetry reads as paused, and a tick with no speed leaves the cache.
    if (!telemetry || speed) {
      this.replaySpeed.set(contextId, speed?.speed ?? 0);
      this.replaySlowMotion.set(contextId, speed?.slowMotion ?? false);
    }

    this.rememberReplaySpeed(telemetry, speed);
    this.dialSurface.onTick(contextId, { telemetry, speed });
  }

  /**
   * Feeds one tick to the speed the dial's Play/Pause resumes
   * (`replay-speed-state.ts`). Every context of this action calls it, keys
   * included, so a speed set and paused while only keys are on the page is
   * remembered when a dial's page comes back. Only while a replay is on
   * screen: out of one, `ReplayPlaySpeed` says nothing about a replay. A speed
   * set while no Replay Control context is visible at all is still not seen.
   * `current` is the tick's speed where the caller has already decoded it.
   */
  private rememberReplaySpeed(
    telemetry: TelemetryData | null,
    current = telemetry ? replaySpeedFromTelemetry(telemetry) : null,
  ): void {
    if (current && this.sdkController.getReplayState().inReplay) noteTelemetrySpeed(current, Date.now());
  }

  /**
   * @internal Compat shim — preserves the pre-refactor `startRepeat` guard test.
   * Tests install/remove heldButtons entries manually and then call this method to
   * verify timers are not armed when the button is no longer held.
   */
  private startRepeat(contextId: string, settings: ReplayControlSettings): void {
    if (!this.repeat.isHeld(contextId)) return;

    this.repeat.onKeyDown(contextId, {
      holdMs: LONG_PRESS_INITIAL_DELAY,
      intervalMs: LONG_PRESS_REPEAT_GAP_MS,
      safetyMs: LONG_PRESS_MAX_DURATION_MS,
      execute: () => {
        this.executeMode(contextId, settings);

        return true;
      },
    });
  }

  private parseSettings(settings: unknown): ReplayControlSettings {
    const parsed = ReplayControlSettings.safeParse(settings);

    return parsed.success ? parsed.data : ReplayControlSettings.parse({});
  }

  private seedTelemetryState(contextId: string, telemetry: TelemetryData | null): void {
    if (!telemetry) return;

    this.readReplaySpeed(contextId, telemetry);
  }

  private updateTelemetryState(contextId: string, telemetry: TelemetryData | null): void {
    if (!telemetry) {
      this.replaySpeed.set(contextId, 0);
      this.replaySlowMotion.set(contextId, false);

      return;
    }

    this.readReplaySpeed(contextId, telemetry);
  }

  /**
   * Caches the replay speed in the units the user sees: in slow motion the
   * speed is the divisor (5 = 1/5x), decoded from iRacing's raw value (#1202).
   */
  private readReplaySpeed(contextId: string, telemetry: TelemetryData): void {
    const current = replaySpeedFromTelemetry(telemetry);

    if (!current) return;

    this.replaySpeed.set(contextId, current.speed);
    this.replaySlowMotion.set(contextId, current.slowMotion);
  }

  /**
   * Determines if the replay is currently playing (not paused).
   * Uses ReplayPlaySpeed rather than IsReplayPlaying, because IsReplayPlaying
   * indicates "sim is in replay mode" and stays true even when paused.
   */
  private isCurrentlyPlaying(contextId: string): boolean {
    return (this.replaySpeed.get(contextId) ?? 0) !== 0;
  }

  /**
   * Determines if the play-pause/play-backward icon should show the PAUSE icon.
   * Shows PAUSE when playing in any direction (forward or backward).
   */
  private shouldShowPause(contextId: string): boolean {
    return (this.replaySpeed.get(contextId) ?? 0) !== 0;
  }

  private buildTelemetryStateKey(contextId: string): string {
    const speed = this.replaySpeed.get(contextId) ?? 0;
    const slowMo = this.replaySlowMotion.get(contextId) ?? false;

    return `${speed}:${slowMo}`;
  }

  private getCurrentSpeed(): { speed: number; slowMotion: boolean } {
    // Use the first available telemetry context (speed is global, same across all contexts)
    for (const [contextId] of this.replaySpeed) {
      return {
        speed: this.replaySpeed.get(contextId) ?? 0,
        slowMotion: this.replaySlowMotion.get(contextId) ?? false,
      };
    }

    return { speed: 0, slowMotion: false };
  }

  /**
   * Optimistically update the local speed cache after sending a command.
   * Prevents duplicate speeds on rapid presses before telemetry catches up.
   */
  private setLocalSpeed(speed: number, slowMotion: boolean): void {
    for (const [contextId] of this.replaySpeed) {
      this.replaySpeed.set(contextId, speed);
      this.replaySlowMotion.set(contextId, slowMotion);
    }
  }

  private getCarNumberRawByIdx(carIdx: number): number | null {
    const sessionInfo = this.sdkController.getSessionInfo();

    return getCarNumberRawFromSessionInfo(sessionInfo, carIdx);
  }

  /**
   * @internal Exposed for testing.
   *
   * Resolves the carIdx whose fastest lap we should jump to. For
   * `always-my-car` the lookup is the driver's own car (the same path
   * `jump-to-my-car` uses). For `viewed-car` it's whichever car the replay
   * camera is currently framing (`telemetry.CamCarIdx`). Returns `-1` when
   * the resolution fails — caller is responsible for the warn.
   */
  resolveFastestLapCarIdx(target: "viewed-car" | "always-my-car", telemetry: TelemetryData | null): number {
    if (target === "always-my-car") {
      const sessionInfo = this.sdkController.getSessionInfo();
      const driverInfo = (sessionInfo as Record<string, unknown>)?.DriverInfo as Record<string, unknown> | undefined;

      return (driverInfo?.DriverCarIdx as number) ?? -1;
    }

    return (telemetry?.CamCarIdx as number) ?? -1;
  }

  /**
   * Take the replay cursor for a camera or car key, which sends no replay
   * command: cancels the in-flight walk (this instance's or any other cursor
   * owner's), naming the mode that did, so a walk searching on the camera's
   * car does not go on following another one. A key that sends a replay
   * command takes the cursor through the replay command gate instead
   * (`pressReplayCommand`, #1430). The walk observes it at its next await.
   */
  private cancelFastestLapWalk(by: string): void {
    cancelReplayCursorOwner(by);
  }

  /** A walk that has not been cancelled holds the slot; one unwinding after a cancel does not. */
  private isFastestLapPressInFlight(): boolean {
    return this.activeFastestLapPress !== null && this.activeFastestLapPress.claim.cancelledBy === null;
  }

  /**
   * The recorded start frame of a car's lap, from the per-session replay
   * record. Degrades to a miss when no store was initialized (tests, a plugin
   * without one), so the press still walks.
   */
  private lookupRecordedLapStart(query: LapStartQuery & { subSessionId?: number }): RecordedLapStartLookup {
    if (!isReplaySessionStoreInitialized()) return { hit: false, reason: "no store" };

    return getReplaySessionStore().laps.findLapStart(query);
  }

  /**
   * The record can check the lap-number convention the lookup relies on: when
   * `ResultsPositions[].FastestTime` is present and differs from the matched
   * entry's `timeMs` by more than a tick, log it. The jump still happens.
   */
  private logFastestTimeDisagreement(
    sessionInfo: unknown,
    sessionNum: number,
    carIdx: number,
    lap: number,
    timeMs: number | null,
  ): void {
    if (timeMs === null) return;

    const fastestTime = findResultsPosition(sessionInfo, sessionNum, carIdx)?.FastestTime;

    if (typeof fastestTime !== "number" || !(fastestTime > 0)) return;

    const diffMs = Math.abs(fastestTime * 1000 - timeMs);

    if (diffMs > FASTEST_TIME_TOLERANCE_MS) {
      this.logger.debug(
        `Jump to fastest lap: FastestTime disagreement — ResultsPositions says ${fastestTime.toFixed(3)} s for carIdx ${carIdx}, the record's lap ${lap} took ${timeMs} ms (diff ${diffMs.toFixed(1)} ms); jumping anyway`,
      );
    }
  }

  /**
   * @internal Exposed for testing.
   *
   * Drives the replay cursor to the start of the fastest lap for a specific
   * car when the record has no frame for it (issue #607, repaired in #1203).
   * Phases:
   *
   *   1. **Session map.** On the first walk per replay (`SubSessionID` plus
   *      the `SessionUniqueID`s seen), build a map of session-instance bounds
   *      by `goToStart` + `nextSession` × N, one entry per
   *      `(SessionNum, SessionUniqueID)`; the last entry's end is open and
   *      every walk reads it live as `ReplayFrameNum + ReplayFrameNumEnd`, so
   *      the walk never leaves the replay (no `goToEnd`) and a live session
   *      that grew since the build is bisected to its current edge. A Next
   *      Session search covers its session at the rate of a position jump
   *      and shows nothing on a paused replay until it lands, so it is waited
   *      for as long as a search to the end of the recording would take, and
   *      from the last session a real event lists none is sent (#1354). A
   *      bisection probe that reads another session than its bounds promise
   *      drops the map.
   *   2. **Bisect within the target session instance.** Look up the entry
   *      whose pair matches the target and bisect with
   *      `setPlayPosition(Begin, mid)` until the car is within
   *      {@link CLOSE_ENOUGH_LAPS} of the lap before the target. Only a probe
   *      that shows the car moves a bound; one that finds it out of the world
   *      is no information, and another frame of the open interval is probed
   *      instead, up to {@link MAX_ABSENT_PROBES} of them (#1354).
   *   3. **Lap-step refinement.** `nextLap` / `prevLap` until
   *      `CarIdxLap[carIdx]` is the lap before the target, a distance nudge
   *      to that lap's end, and a {@link FASTEST_LAP_FINAL_BACKSTEP_TICKS}
   *      back-step, so the car is visibly approaching the line.
   *   4. **Record what was verified.** The landed frame goes into the record
   *      as the car's start of `targetLap` ONLY when the walk converged: the
   *      sample before the back-step showed the car on `targetLap − 1` at
   *      `dist ≥` {@link FASTEST_LAP_DIST_THRESHOLD} in the target session
   *      instance, and the sample at the back-stepped frame agreed on lap and
   *      session. Anything less — lap steps exhausted, a nudge that did not
   *      move, a landing in another lap or session — stays where it got to,
   *      warns `walk did not converge`, and records nothing: a later press
   *      would trust that frame forever.
   *   5. **Leave the replay as the Replay jump playback setting says**
   *      (#1276), converged or not: at the speed it had at the press, at 1×,
   *      or paused (`applyReplayJumpPlayback`, mirrored into the speed cache
   *      like the opening `pause()`). The speed to restore is captured before
   *      that pause, when the press takes the cursor. This step belongs to
   *      the press, not to the walk: `runFastestLapWalk` only lands.
   *
   * An absolute jump settles when `ReplayFrameNum` reads the sent frame; a
   * search when the frame has moved from its pre-command value and, once the
   * configured `fastestLapSearchDelayMs` has elapsed, held across two reads
   * {@link STABILIZATION_POLL_INTERVAL_MS} apart. A search whose frame never
   * held is "unsettled" and aborts (the build caches nothing); one whose frame
   * never left its pre-command value is "unmoved" — how the sim says
   * `nextSession` in the last session. The walk holds the shared replay-cursor
   * claim; any replay command from any action cancels it, and it sends
   * nothing more. It refuses to start while no replay is on screen (the
   * controller's debounced replay state, #1324), because iRacing ignores
   * replay commands from the car. A walk that gives up puts the replay back
   * on the frame and at the speed the press found it (#1354), and the camera
   * back on `viewedCarIdx`, the car that was on screen at the press, when the
   * press had moved it. Only when the sim does not honour the way back does
   * the replay stay paused where the walk stopped, with the cache saying so,
   * so the Play key plays.
   *
   * `cameraCarNum` is the car number a press switches the camera onto before
   * the walk, since iRacing's lap search follows the camera; null leaves the
   * camera alone. That switch, and the one back after a walk that gave up, is
   * sent only once no jump is under way (#1430): iRacing drops a camera change
   * that arrives during a seek, and a walk that then searched on the car on
   * screen would not converge.
   */
  async walkToFastestLap(
    contextId: string,
    carIdx: number,
    targetLap: number,
    targetSessionNum: number,
    identity: FastestLapRecordIdentity,
    viewedCarIdx: number = carIdx,
    cameraCarNum: number | null = null,
  ): Promise<void> {
    if (this.isFastestLapPressInFlight()) {
      this.logger.info("Jump to fastest lap: walk already in flight; press ignored");
      this.logger.debug(
        `In-flight walk context: ${this.activeFastestLapPress?.contextId}, ignored press context: ${contextId}`,
      );
      reportReplayPressIgnored(contextId);

      return;
    }

    const press: ReplayPressIdentity = { owner: FASTEST_LAP_WALK_OWNER, noun: "walk", label: FASTEST_LAP_LOG_LABEL };

    await this.holdFastestLapSlot(contextId, press, async (jump) => {
      // The camera onto the target car before the walk: iRacing's lap search
      // is camera-focus-relative, so the walk must start on the right driver.
      // For viewed-car this is usually a no-op (the camera is already there);
      // for always-my-car it actively re-frames.
      if (cameraCarNum !== null) {
        await this.waitToSwitchCamera(jump.claim, FASTEST_LAP_LOG_LABEL);

        if (!getCommands().camera.switchNum(cameraCarNum, 0, 0)) {
          // If the SDK refused, abort rather than walk the wrong driver.
          this.logger.warn("Jump to fastest lap: camera switch failed, aborting");
          this.logger.debug(`Failed switchNum: carNum=${cameraCarNum}, carIdx=${carIdx}`);

          return;
        }
      }

      const landing = await this.runFastestLapWalk(jump, {
        carIdx,
        lap: targetLap,
        sessionNum: targetSessionNum,
        instance: "cursor",
        identity,
        label: FASTEST_LAP_LOG_LABEL,
      });

      // A walk that gave up has put the replay back where the press found it,
      // whatever the setting says: nothing was jumped to. The camera the press
      // moved onto the target car goes back too, once no seek is in flight.
      if (landing === null) {
        const viewedCarNum =
          viewedCarIdx !== carIdx && viewedCarIdx >= 0 && viewedCarIdx !== 255
            ? this.getCarNumberRawByIdx(viewedCarIdx)
            : null;

        if (viewedCarNum === null) return;

        await this.waitToSwitchCamera(jump.claim, FASTEST_LAP_LOG_LABEL);

        if (!getCommands().camera.switchNum(viewedCarNum, 0, 0)) {
          this.logger.warn("Jump to fastest lap: could not switch the camera back; it is left on the target car");
          this.logger.debug(`Failed switchNum: carNum=${viewedCarNum}, carIdx=${viewedCarIdx}`);
        }

        return;
      }

      const applied = applyReplayJumpPlayback(jump, landing.telemetry);

      if (applied === null) throw new FastestLapPressCancelled(jump.claim.cancelledBy ?? "unknown");

      this.mirrorReplayJumpSpeed(FASTEST_LAP_LOG_LABEL, applied);
      this.logger.debug(
        `Jump to fastest lap: walk ${landing.converged ? "converged" : "did not converge"} on frame ${landing.landedFrame}; replay left at ${formatSpeedDisplay(applied.speed.speed, applied.speed.slowMotion)} (speed command ${applied.command})`,
      );
    });
  }

  /**
   * Run one Jump to Fastest Lap or Jump to Race Start press — a walk or a
   * record jump — holding the replay cursor and this action's in-flight slot
   * for its whole duration, so any replay command cancels it and a second
   * press of either mode is ignored. The press
   * starts as a replay jump (`beginReplayJump`, #1276): the speed the replay
   * has now is captured before `run` sends anything, which is what the
   * **Replay jump playback** setting's `remember` restores at the end.
   * The press signals a cancellation by throwing {@link FastestLapPressCancelled}.
   *
   * The jump is opened with the replay command gate under the press's context
   * id (#1430). `target.frame` is the frame a record jump is going to, known at
   * the press, and `target.afterLanding` its own step once landed: the gate
   * records the frame as where the replay is headed before the pause, and runs
   * the step on the read-back when a key took the cursor in the meantime. A
   * walk, whose frame is found as it goes, passes neither.
   */
  private async holdFastestLapSlot(
    contextId: string,
    press: ReplayPressIdentity,
    run: (jump: ReplayJump) => Promise<void>,
    target: { frame?: number; afterLanding?: (landing: TelemetryData) => boolean } = {},
  ): Promise<void> {
    const { owner, noun, label } = press;
    const jump = beginReplayJump(
      owner,
      this.sdkController.getCurrentTelemetry(),
      (by) => {
        this.logger.info(`${label}: ${noun} cancelled by ${by}`);
      },
      Date.now(),
      { origin: contextId, frame: target.frame, afterLanding: target.afterLanding },
    );
    const { claim } = jump;

    this.activeFastestLapPress = { contextId, claim };

    try {
      await run(jump);
    } catch (error) {
      if (error instanceof FastestLapPressCancelled) {
        this.logger.debug(`${label}: ${error.message}; cursor left where that command put it`);
      } else {
        this.logger.error(`${label}: ${noun} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      jump.end();

      // A cancelled press may unwind after a newer one took the slot.
      if (this.activeFastestLapPress?.claim === claim) this.activeFastestLapPress = null;
    }
  }

  /**
   * Waits until no jump is under way before a camera switch a press makes for
   * itself outside a jump's landing step: the walk's switch onto the car it
   * searches on, Jump to Race Start's borrow of the pole car, and the camera
   * going back after a search that gave up (#1430). iRacing drops a camera
   * change that arrives during a seek, and a search on the car on screen
   * finds another car's lap. A wait that runs out is logged and lets the
   * switch go anyway. Throws {@link FastestLapPressCancelled} when another
   * command took the cursor meanwhile: that command's own effect stands, the
   * camera included.
   */
  private async waitToSwitchCamera(claim: ReplayCursorClaim, label: string): Promise<void> {
    const settled = await waitForReplayJumpsToSettle(claim);

    if (settled === "superseded") throw new FastestLapPressCancelled(claim.cancelledBy ?? "unknown");

    if (settled === "gave-up") this.logger.debug(`${label}: a jump was still under way; camera switched anyway`);
  }

  /**
   * Jump to an absolute frame through the shared sequence
   * (`shared/replay-jump-playback.ts`, #1276) and keep this action's speed
   * cache and icons in step with what it sends: pause a moving replay and wait
   * for the pause to show, seek and wait for `ReplayFrameNum` to read `frame`
   * — iRacing searches a long jump in steps and any command arriving
   * mid-search cuts it short (#1275) — then `afterLanding`, then the speed the
   * **Replay jump playback** setting asks for.
   *
   * `jump` comes from `beginReplayJump`, called at the press before any
   * command; the caller ends it. `label` opens every log line, so each mode
   * that jumps reads as itself in the log. `afterLanding` is the mode's own
   * command once the cursor has landed (a camera switch); returning false
   * stops the jump paused on the frame, and that step logs why.
   *
   * Never throws for a jump that stopped short or was cancelled: the outcome
   * says which. A stopped jump has sent nothing more and is logged here, so
   * the replay is paused where it stopped whatever the setting says. A
   * cancelled one is the caller's to report.
   */
  private async runJumpToFrame(
    jump: ReplayJump,
    options: { frame: number; label: string; afterLanding?: (landing: TelemetryData) => boolean },
  ): Promise<ReplayJumpOutcome> {
    const { frame, label, afterLanding } = options;
    const outcome = await runReplayJump(jump, {
      frame,
      readTelemetry: () => this.sdkController.getCurrentTelemetry(),
      onPaused: () => {
        this.setLocalSpeed(0, false);
        this.updateAllTelemetryDisplays();
      },
      afterLanding,
    });

    if (outcome.kind === "landed") {
      this.mirrorReplayJumpSpeed(label, outcome);
    } else if (outcome.kind === "stopped") {
      this.logReplayJumpStopped(label, frame, outcome);
    }

    return outcome;
  }

  /**
   * Put the speed a jump left the replay at into the speed cache, so the icons
   * and the Play key follow it without waiting for telemetry.
   */
  private mirrorReplayJumpSpeed(label: string, applied: ReplayJumpApplied): void {
    if (applied.command === "failed") {
      this.logger.warn(`${label}: speed command failed; replay left paused on the frame`);
      this.logger.debug(`Replay still at ${formatSpeedDisplay(applied.speed.speed, applied.speed.slowMotion)}`);
    }

    this.setLocalSpeed(applied.speed.speed, applied.speed.slowMotion);
    this.updateAllTelemetryDisplays();
  }

  /** One warning for a jump that stopped short, the details at debug. A failed `afterLanding` step is logged by that step. */
  private logReplayJumpStopped(
    label: string,
    frame: number,
    outcome: Extract<ReplayJumpOutcome, { kind: "stopped" }>,
  ): void {
    if (outcome.reason === "after-landing-failed") return;

    const report = describeReplayJump(outcome, frame);

    this.logger.warn(`${label}: ${report.warn}`);
    this.logger.debug(`${label}: ${report.detail}`);
  }

  /**
   * Jump to a lap start the record holds (#1203): the shared sequence to one
   * second before the line, with the camera switched onto the car once the
   * cursor has landed — sent any earlier it would cut the seek short (#1275).
   * The replay then does what the **Replay jump playback** setting says
   * (#1276). On any failure nothing more is sent, leaving the replay paused
   * where it stopped rather than playing from a spot nobody asked for.
   */
  private async jumpToRecordedLapStart(
    contextId: string,
    target: {
      carIdx: number;
      carNum: number;
      lap: number;
      frame: number;
      timeMs: number | null;
    },
  ): Promise<void> {
    const press: ReplayPressIdentity = {
      owner: FASTEST_LAP_RECORD_JUMP_OWNER,
      noun: "jump",
      label: FASTEST_LAP_LOG_LABEL,
    };

    const approachFrame = Math.max(0, target.frame - LAP_START_APPROACH_FRAMES);
    // The camera onto the car once the cursor has landed. It belongs to where
    // the jump is going, so when a key takes the cursor mid-jump the gate
    // still runs it on the read-back (#1430); a car key's cancel does not.
    const afterLanding = (): boolean => {
      if (getCommands().camera.switchNum(target.carNum, 0, 0)) return true;

      this.logger.warn("Jump to fastest lap: camera switch failed; replay left at the lap start");
      this.logger.debug(`Failed switchNum: carNum=${target.carNum}, carIdx=${target.carIdx}`);

      return false;
    };

    await this.holdFastestLapSlot(
      contextId,
      press,
      async (jump) => {
        const outcome = await this.runJumpToFrame(jump, {
          frame: approachFrame,
          label: FASTEST_LAP_LOG_LABEL,
          afterLanding,
        });

        if (outcome.kind === "cancelled") throw new FastestLapPressCancelled(outcome.by, "jump");

        if (outcome.kind === "landed") {
          this.logger.debug(
            `Lap ${target.lap} of carIdx ${target.carIdx} starts at frame ${target.frame} (time ${target.timeMs ?? "untimed"} ms); landed on ${approachFrame}; replay left at ${formatSpeedDisplay(outcome.speed.speed, outcome.speed.slowMotion)} (speed command ${outcome.command})`,
          );
        }
      },
      { frame: approachFrame, afterLanding },
    );
  }

  /**
   * The recorded race start of a session, from the per-session replay record
   * (#1354). Degrades to a miss when no store was initialized (tests, a plugin
   * without one), so the press still falls back.
   */
  private lookupRecordedGreen(query: GreenQuery & { subSessionId?: number }): RecordedGreenLookup {
    if (!isReplaySessionStoreInitialized()) return { hit: false, reason: "no store" };

    return getReplaySessionStore().greens.findGreen(query);
  }

  /**
   * One Jump to Race Start press (#1354): a lookup first, like Jump to Fastest
   * Lap. The target is the race session the cursor is in, else the last race
   * session of the replay (`resolveGreenFlagTarget`). Its recorded start is
   * one waited jump to five seconds before the green, with no camera switch;
   * with no record, the pole car's lap 1 stands in ({@link jumpToGreenFromPoleCar}).
   *
   * The guards are Jump to Fastest Lap's, in its order, and each ignores the
   * press before any command is sent: no race session in the replay (the one
   * case the key greys for), the `SessionNum = -1` transient after a seek, a
   * press of either jump still in flight, and no replay on screen — the
   * debounced state, not the raw flag, which reads false for ~300 ms after
   * every seek (#1324).
   */
  private pressJumpToRaceStart(contextId: string): void {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const sessionInfo = this.sdkController.getSessionInfo();
    const target = resolveGreenFlagTarget(sessionInfo, telemetry);

    if (target === null) {
      this.logger.info("Jump to race start: no race session in this replay; press ignored");

      return;
    }

    const cursorSessionNum = telemetry?.SessionNum;

    if (typeof cursorSessionNum !== "number" || cursorSessionNum < 0) {
      this.logger.info("Jump to race start: replay session not settled yet; press ignored");
      this.logger.debug(`SessionNum=${String(cursorSessionNum)}`);

      return;
    }

    if (this.isFastestLapPressInFlight()) {
      this.logger.info("Jump to race start: previous jump still in flight; press ignored");
      this.logger.debug(
        `In-flight context: ${this.activeFastestLapPress?.contextId}, ignored press context: ${contextId}`,
      );
      reportReplayPressIgnored(contextId);

      return;
    }

    if (!this.sdkController.getReplayState().inReplay) {
      this.logger.info("Jump to race start: replay not open; iRacing ignores replay commands from the car");

      return;
    }

    const subSessionId = readSubSessionId(sessionInfo);

    this.logger.info("Jump to race start executed");
    this.logger.debug(
      `Target session: ${target.sessionNum}/${target.sessionUniqueId ?? "n/a"} (${target.from}), cursor session: ${cursorSessionNum}, subSession: ${subSessionId ?? "n/a"}`,
    );

    const lookup = this.lookupRecordedGreen({
      subSessionId,
      sessionNum: target.sessionNum,
      sessionUniqueId: target.sessionUniqueId,
      kind: "start",
    });

    if (lookup.hit) {
      this.logger.info(`Jump to race start: record HIT (matchedBy ${lookup.matchedBy})`);
      this.logger.debug(`Green of session ${target.sessionNum}/${lookup.sessionUniqueId} at frame ${lookup.frame}`);

      // Fire-and-forget: the jump waits for the cursor to land before it sends
      // anything else (#1275), and the press handler returns immediately.
      void this.jumpToGreenApproach(contextId, { frame: lookup.frame, what: "green recorded" });

      return;
    }

    this.logger.info(`Jump to race start: record MISS (${lookup.reason}); falling back to lap 1 of the pole car`);
    this.jumpToGreenFromPoleCar(contextId, target, { telemetry, sessionInfo, subSessionId });
  }

  /**
   * The single waited jump of a Jump to Race Start press: through the shared
   * sequence to the run-up before `anchor.frame` — the recorded green, or the
   * recorded start of the pole car's lap 1 — and then whatever the **Replay
   * jump playback** setting says. No camera switch. A jump that stops short
   * leaves the replay paused where it stopped (`runJumpToFrame` logs it).
   */
  private async jumpToGreenApproach(contextId: string, anchor: { frame: number; what: string }): Promise<void> {
    const press: ReplayPressIdentity = { owner: RACE_START_JUMP_OWNER, noun: "jump", label: RACE_START_LOG_LABEL };

    const approachFrame = greenApproachFrame(anchor.frame);

    await this.holdFastestLapSlot(
      contextId,
      press,
      async (jump) => {
        const outcome = await this.runJumpToFrame(jump, { frame: approachFrame, label: RACE_START_LOG_LABEL });

        if (outcome.kind === "cancelled") throw new FastestLapPressCancelled(outcome.by, "jump");

        if (outcome.kind === "landed") {
          this.logger.debug(
            `Jump to race start: ${anchor.what} at frame ${anchor.frame}; landed on ${approachFrame}; replay left at ${formatSpeedDisplay(outcome.speed.speed, outcome.speed.slowMotion)} (speed command ${outcome.command})`,
          );
        }
      },
      { frame: approachFrame },
    );
  }

  /**
   * The fallback of a Jump to Race Start press with no recorded green: the
   * pole car's lap 1, which starts a second or two after the green at most
   * (`resolveGreenFallbackCar`: with no qualifying grid, or a pole sitter who
   * did not take part in the target session, the car the camera is on).
   * From the lap record when it holds that lap — one waited jump and no camera
   * switch, which is what every replay recorded before the green record
   * existed gets — else from a search of the replay ({@link searchGreenFromPoleCar}).
   */
  private jumpToGreenFromPoleCar(
    contextId: string,
    target: GreenFlagTarget,
    press: { telemetry: TelemetryData | null; sessionInfo: unknown; subSessionId: number | undefined },
  ): void {
    const { telemetry, sessionInfo, subSessionId } = press;
    const viewedCarIdx = typeof telemetry?.CamCarIdx === "number" ? telemetry.CamCarIdx : -1;
    const car = resolveGreenFallbackCar(sessionInfo, target.sessionNum, viewedCarIdx);

    if (car === null) {
      this.logger.warn("Jump to race start: no pole car and no viewed car to take lap 1 from; press ignored");
      this.logger.debug(`Pole carIdx: ${resolvePoleCarIdx(sessionInfo) ?? "n/a"}, CamCarIdx: ${viewedCarIdx}`);

      return;
    }

    const { carIdx } = car;

    const carNum = this.getCarNumberRawByIdx(carIdx);

    if (carNum === null) {
      this.logger.warn(
        "Jump to race start: could not find the car number of the car to take lap 1 from; press ignored",
      );
      this.logger.debug(`carIdx: ${carIdx}`);

      return;
    }

    this.logger.debug(
      `Jump to race start: lap 1 of carIdx ${carIdx}, carNum ${carNum} (${car.from === "pole" ? "pole" : "the viewed car; no pole car in the target session"})`,
    );

    const lookup = this.lookupRecordedLapStart({
      subSessionId,
      sessionNum: target.sessionNum,
      sessionUniqueId: target.sessionUniqueId,
      carIdx,
      carNumberRaw: carNum,
      lap: 1,
    });

    if (lookup.hit) {
      this.logger.info(`Jump to race start: lap record HIT (matchedBy ${lookup.matchedBy})`);
      void this.jumpToGreenApproach(contextId, { frame: lookup.frame, what: `lap 1 of carIdx ${carIdx} starts` });

      return;
    }

    this.logger.info(`Jump to race start: lap record MISS (${lookup.reason}); searching the replay`);
    void this.searchGreenFromPoleCar(contextId, target, {
      carIdx,
      carNum,
      viewedCarIdx,
      identity: { carNumberRaw: carNum, userId: readUserId(sessionInfo, carIdx), subSessionId },
    });
  }

  /**
   * The last resort of a Jump to Race Start press: search the replay for the
   * start of the pole car's lap 1 with the walk Jump to Fastest Lap uses, then
   * one waited jump back by the rest of the run-up.
   *
   * iRacing's lap search follows the camera, so the camera goes onto the pole
   * car for the search and back onto the car that was on screen at the press
   * once the cursor has landed — the green belongs to the whole field, and the
   * user had chosen what to watch. It goes back too when the search gives up
   * or the last jump stops short, but not when another replay command
   * cancelled the press: that command's own effect stands.
   *
   * A search that could not verify its landing still anchors the jump when
   * the landing is near the end of the lap before lap 1
   * (`acceptsGreenFallbackLanding`): the anchor of a five-second run-up need
   * not be the exact frame the lap record demands, and iRacing's Next Lap can
   * land a few frames short of what the walk verifies (#1432). Anything
   * further off is a search that came to nothing, and like one that gave up
   * on the way it ends with the replay back on the frame and at the speed the
   * press found it: the press leaves no trace but its log lines.
   */
  private async searchGreenFromPoleCar(
    contextId: string,
    target: GreenFlagTarget,
    car: { carIdx: number; carNum: number; viewedCarIdx: number; identity: FastestLapRecordIdentity },
  ): Promise<void> {
    const press: ReplayPressIdentity = { owner: RACE_START_WALK_OWNER, noun: "walk", label: RACE_START_LOG_LABEL };

    await this.holdFastestLapSlot(contextId, press, async (jump) => {
      const camera = getCommands().camera;
      const borrowed = car.viewedCarIdx !== car.carIdx;
      const viewedCarNum =
        car.viewedCarIdx >= 0 && car.viewedCarIdx !== 255 ? this.getCarNumberRawByIdx(car.viewedCarIdx) : null;

      if (borrowed) {
        // Not into a jump still under way, which would swallow the switch and
        // leave the search following the car on screen (#1430).
        await this.waitToSwitchCamera(jump.claim, RACE_START_LOG_LABEL);

        if (!camera.switchNum(car.carNum, 0, 0)) {
          // If the SDK refused, abort rather than search for the wrong driver's lap.
          this.logger.warn("Jump to race start: camera switch failed, aborting");
          this.logger.debug(`Failed switchNum: carNum=${car.carNum}, carIdx=${car.carIdx}`);

          return;
        }
      }

      /** The camera back on the car on screen at the press. Sync, for the last jump's landing step. */
      const restoreCamera = (): void => {
        if (!borrowed) return;

        if (viewedCarNum === null) {
          this.logger.debug("Jump to race start: no car was on screen at the press; camera left on the pole car");

          return;
        }

        if (!camera.switchNum(viewedCarNum, 0, 0)) {
          this.logger.warn("Jump to race start: could not switch the camera back; it is left on the pole car");
          this.logger.debug(`Failed switchNum: carNum=${viewedCarNum}, carIdx=${car.viewedCarIdx}`);
        }
      };

      /**
       * The same, outside a landing step: once no jump is under way, since a
       * search that gave up may have left a seek in flight (#1430).
       */
      const restoreCameraWhenSettled = async (): Promise<void> => {
        if (!borrowed || viewedCarNum === null) {
          restoreCamera();

          return;
        }

        await this.waitToSwitchCamera(jump.claim, RACE_START_LOG_LABEL);
        restoreCamera();
      };

      const landing = await this.runFastestLapWalk(jump, {
        carIdx: car.carIdx,
        lap: 1,
        sessionNum: target.sessionNum,
        instance: target.from === "cursor" ? "cursor" : "latest",
        identity: car.identity,
        label: RACE_START_LOG_LABEL,
      });

      // The search gave up, logged why and put the replay back.
      if (landing === null) {
        await restoreCameraWhenSettled();

        return;
      }

      if (!acceptsGreenFallbackLanding(landing)) {
        this.logger.warn("Jump to race start: the search did not reach the start of the pole car's lap 1");
        this.logger.debug(
          `Landed frame ${landing.landedFrame}, dist on the lap before lap 1: ${landing.priorLapDist ?? "n/a"}`,
        );
        // The camera only once the way back has landed: sent during the seek
        // it would cut it short (#1275), and iRacing would drop it (#1430).
        await landing.putBack();
        await restoreCameraWhenSettled();

        return;
      }

      const approachFrame = greenApproachFrame(landing.lapStartFrame);
      const outcome = await this.runJumpToFrame(jump, {
        frame: approachFrame,
        label: RACE_START_LOG_LABEL,
        // The camera goes back once the cursor has landed — sent any earlier it
        // would cut the seek short (#1275) — and never stops the jump: the
        // replay is where the press asked, whichever car is on screen.
        afterLanding: () => {
          restoreCamera();

          return true;
        },
      });

      if (outcome.kind === "cancelled") throw new FastestLapPressCancelled(outcome.by, "jump");

      // A jump that stopped short never reached `afterLanding`, and has sent
      // its last replay command: the camera goes back here, once its seek is
      // no longer under way.
      if (outcome.kind === "stopped") await restoreCameraWhenSettled();

      if (outcome.kind === "landed") {
        this.logger.debug(
          `Jump to race start: lap 1 of carIdx ${car.carIdx} starts at frame ${landing.lapStartFrame} (search ${landing.converged ? "converged" : "did not converge"}); landed on ${approachFrame}; replay left at ${formatSpeedDisplay(outcome.speed.speed, outcome.speed.slowMotion)} (speed command ${outcome.command})`,
        );
      }
    });
  }

  /**
   * Walk to a lap start ({@link walkToLapStart}) and, when the walk gives up,
   * put the replay back where the press found it ({@link putReplayBack}). So a
   * null landing means the press changed nothing: a search that cannot find
   * its lap must not leave the user somewhere in the recording they did not
   * ask for (#1354; as first built an aborted walk stayed where it stopped,
   * which for a car that had retired was the last frame of the tape).
   */
  private async runFastestLapWalk(jump: ReplayJump, target: LapWalkTarget): Promise<FastestLapWalkLanding | null> {
    const origin: LapWalkOrigin = { frame: null };
    const putBack = (): Promise<void> => this.putReplayBack(jump, target.label, origin);
    const landing = await this.walkToLapStart(jump, target, origin);

    if (landing === null) {
      await putBack();

      return null;
    }

    return { ...landing, putBack };
  }

  /**
   * Undo a walk that came to nothing: the cursor back on the frame the press
   * found it on, then the speed it had there. Not the **Replay jump playback**
   * setting: nothing was jumped to, so the press leaves the replay as if it
   * had not been made. Does nothing for a walk that never read where the
   * replay was — it sent nothing, or the telemetry never settled after its
   * opening pause — or that ran from the car, where every command is ignored.
   * A way back the sim does not honour is logged, and the replay stays paused
   * where the walk stopped. Throws
   * {@link FastestLapPressCancelled} when another replay command has taken the
   * cursor: that command's own effect stands.
   */
  private async putReplayBack(jump: ReplayJump, label: string, origin: LapWalkOrigin): Promise<void> {
    const { frame } = origin;
    const { claim } = jump;

    if (frame === null) return;

    if (claim.cancelledBy !== null) throw new FastestLapPressCancelled(claim.cancelledBy);

    const readTelemetry = (): TelemetryData | null => this.sdkController.getCurrentTelemetry();
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
        this.logger.warn(`${label}: could not put the replay back; it is left paused where the search stopped`);
        this.logger.debug(
          outcome.kind === "refused"
            ? `setPlayPosition to frame ${frame} failed`
            : `Sent frame ${frame}, saw frame ${outcome.telemetry?.ReplayFrameNum ?? "n/a"} after ${timeoutMs} ms`,
        );

        return;
      }
    }

    const { speed, slowMotion } = jump.captured;

    if (speed !== 0) {
      if (claim.cancelledBy !== null) throw new FastestLapPressCancelled(claim.cancelledBy);

      if (sendOwnedReplayCommand(claim, { kind: "speed", speed, slowMotion }) !== "sent") {
        this.logger.warn(`${label}: speed command failed; replay left paused on the frame the press found it on`);
        this.logger.debug(`Failed setPlaySpeed: ${formatSpeedDisplay(speed, slowMotion)} on frame ${frame}`);

        return;
      }

      this.setLocalSpeed(speed, slowMotion);
      this.updateAllTelemetryDisplays();
    }

    this.logger.info(`${label}: replay put back where the press found it`);
    this.logger.debug(`Frame ${frame}, ${formatSpeedDisplay(speed, slowMotion)} before the press`);
  }

  /**
   * The walk itself: drive the cursor to the lap start and record the frame
   * when it was verified. It lands and does nothing about playback — the
   * replay is paused on the frame it returns, and the press applies the
   * **Replay jump playback** setting from there. Null for every abort, which
   * leaves the replay paused where the walk stopped for the caller,
   * {@link runFastestLapWalk}, to put back: `origin` is where it tells that
   * caller the frame the press found the replay on. Throws
   * {@link FastestLapPressCancelled} when another replay command took the cursor.
   *
   * `target` names the lap, the session instance it is in and the mode the
   * walk runs for: Jump to Fastest Lap walks to a lap of the cursor's own
   * session, Jump to Race Start to lap 1 of a race session the cursor may not
   * be in (#1354).
   */
  private async walkToLapStart(
    jump: ReplayJump,
    target: LapWalkTarget,
    origin: LapWalkOrigin,
  ): Promise<LapWalkResult | null> {
    const { carIdx, lap: targetLap, sessionNum: targetSessionNum, identity, label: logLabel } = target;
    const { claim } = jump;
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    /** One of the walk's own commands, through the replay command gate as the cursor's holder (#1430). */
    const send = (command: ReplayGateCommand): boolean => sendOwnedReplayCommand(claim, command) === "sent";

    const checkpoint = (): void => {
      if (claim.cancelledBy !== null) throw new FastestLapPressCancelled(claim.cancelledBy);
    };

    /** Every wait in the walk: a cancellation is observed as soon as the sleep ends. */
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
      const tel = this.sdkController.getCurrentTelemetry();

      if (tel?.IsReplayPlaying === true) sawReplayFlag = true;

      if (isSettledSample(tel) && typeof tel.ReplayFrameNum === "number") lastSettledFrame = tel.ReplayFrameNum;

      return tel;
    };

    const carLap = (tel: TelemetryData | null): number | undefined =>
      (tel?.CarIdxLap as number[] | undefined)?.[carIdx];
    const carDist = (tel: TelemetryData | null): number | undefined =>
      (tel?.CarIdxLapDistPct as number[] | undefined)?.[carIdx];

    const settleTimeoutMs = (): number => readFastestLapSearchDelayMs() * STABILIZATION_TIMEOUT_MULTIPLIER;

    /**
     * Poll until the telemetry is out of the `SessionNum = -1` transient, or
     * null past the settle timeout. Used for the samples no command precedes.
     */
    const readSettledSample = async (): Promise<TelemetryData | null> => {
      const deadline = Date.now() + settleTimeoutMs();

      for (;;) {
        const tel = readTelemetry();

        if (isSettledSample(tel)) return tel;

        if (Date.now() >= deadline) return null;

        await wait(STABILIZATION_POLL_INTERVAL_MS);
      }
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
        claim,
        send: (f) => send({ kind: "jump", frame: f }),
        readTelemetry,
        timeoutMs,
        pollMs: STABILIZATION_POLL_INTERVAL_MS,
      });

      if (outcome.kind === "cancelled") throw new FastestLapPressCancelled(outcome.by);

      if (outcome.kind === "reached") {
        unlandedJumpFrame = null;

        return outcome.telemetry;
      }

      if (outcome.kind === "refused") {
        unlandedJumpFrame = null;
        this.logger.warn(`${logLabel}: jump not sent; aborting walk`);
        this.logger.debug(`setPlayPosition to frame ${frame} failed`);

        return null;
      }

      const last = outcome.telemetry;

      this.logger.warn(`${logLabel}: jump did not settle; aborting walk`);
      this.logger.debug(
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
      const sentAt = Date.now();

      command();

      const gapMs = readFastestLapSearchDelayMs();
      const deadline = sentAt + waitMs;
      let held: number | null = null;
      let sawMovement = false;

      while (Date.now() < deadline) {
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

        if (held === frame && isSettledSample(tel) && Date.now() - sentAt >= gapMs) {
          return { kind: "moved", telemetry: tel };
        }

        held = frame;
      }

      const telemetry = readTelemetry();

      if (!sawMovement) {
        this.logger.debug(
          `${logLabel}: ${label} did not move the cursor from frame ${before ?? "n/a"} in ${waitMs} ms`,
        );

        return { kind: "unmoved", telemetry };
      }

      this.logger.warn(`${logLabel}: ${label} moved the cursor but it never settled; aborting`);
      this.logger.debug(
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
          this.logger.warn(`${logLabel}: missing fields after ${label}; aborting map build`);
          this.logger.debug(`After ${label}: frame=${frame}, session=${sessionNum}, uniqueId=${sessionUniqueId}`);

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
        this.logger.warn(`${logLabel}: goToStart did not move the cursor; aborting map build`);
        this.logger.debug(`goToStart left the cursor at frame ${readFrame(first.telemetry) ?? "n/a"}`);

        return null;
      }

      if (!isSettledSample(first.telemetry)) {
        this.logger.warn(`${logLabel}: telemetry did not settle after goToStart; aborting map build`);

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
        typeof subSessionId === "number" && subSessionId > 0
          ? lastListedSessionNum(this.sdkController.getSessionInfo())
          : null;
      /** The sample of the session start the next search leaves from. */
      let at: TelemetryData = first.telemetry;

      for (let i = 0; i < MAX_SESSIONS; i++) {
        const label = `nextSession #${i + 1}`;

        if (finalSessionNum !== null && sessions[sessions.length - 1].sessionNum === finalSessionNum) {
          this.logger.debug(`${logLabel}: session ${finalSessionNum} is the last this event lists; ${label} not sent`);
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
    if (!this.sdkController.getReplayState().inReplay) {
      this.logger.info(`${logLabel}: replay not open; iRacing ignores replay commands from the car`);

      return null;
    }

    // A jump still under way when the press came (a marker jump, a dial spin)
    // is let land first: a search sent into it would throw it, and its pause
    // would end it where it stands (#1430). A wait that runs out goes on: the
    // walk's first command is a position jump or a search from wherever the
    // replay is, and every later step reads where it landed.
    const settled = await waitForReplayJumpsToSettle(claim);

    if (settled === "superseded") throw new FastestLapPressCancelled(claim.cancelledBy ?? "unknown");

    if (settled === "gave-up") this.logger.debug(`${logLabel}: a jump was still under way; walking anyway`);

    // Pause first so the cursor doesn't drift between commands and the
    // post-settle telemetry sample — and tell the speed cache, so a Play
    // press during or after the walk sends play rather than pause.
    send({ kind: "pause" });
    this.setLocalSpeed(0, false);
    this.updateAllTelemetryDisplays();
    await wait(readFastestLapSearchDelayMs());

    // Phase 1: session map (cache or build). The sample that keys it is a
    // stable one — the `SessionNum = -1` transient carries no usable id.
    const initialTel = await readSettledSample();

    if (initialTel === null) {
      this.logger.warn(`${logLabel}: telemetry did not settle after pause; aborting`);

      return null;
    }

    // Where the press found the replay: the frame every abort from here on is undone to.
    origin.frame = readFrame(initialTel);

    const cursorSessionUniqueId = initialTel.SessionUniqueID;

    if (typeof cursorSessionUniqueId !== "number") {
      this.logger.warn(`${logLabel}: SessionUniqueID unavailable; aborting`);

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

    this.logger.info(
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
        this.logger.info(
          `${logLabel}: the walk ran from the car (IsReplayPlaying never read true); session map discarded`,
        );
        // Nothing to put back, and no command to do it with.
        origin.frame = null;

        return null;
      }

      sessionMap = built;
      cachedFastestLapSessionMap = built;
      this.logger.info(
        `${logLabel}: session map built — subSession=${subSessionId ?? "n/a"}, ${sessionMap.sessions
          .map((s) => `S${s.sessionNum}/${s.sessionUniqueId}[${s.startFrame}-${s.endFrame ?? "end"}]`)
          .join(", ")}`,
      );
    } else {
      this.logger.debug(`${logLabel}: reusing cached session map (${sessionMap.sessions.length} sessions)`);
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
      this.logger.warn(
        `${logLabel}: the recording holds more sessions than the ${MAX_SESSIONS + 1} the search maps; the latest session ${targetSessionNum} cannot be told, aborting`,
      );

      return null;
    }

    if (bounds == null) {
      if (target.instance === "cursor") {
        this.logger.warn(
          `${logLabel}: target session ${targetSessionNum}/${cursorSessionUniqueId} not in session map; aborting`,
        );
      } else {
        // Not a fault: the event lists a session the recording has not reached
        // (a live event still in qualifying), and nothing the plugin reads
        // before the search says so.
        this.logger.info(`${logLabel}: the target session is not in this recording yet`);
        this.logger.debug(
          `Session ${targetSessionNum} is in none of the ${sessionMap.sessions.length} mapped session instances`,
        );
      }

      return null;
    }

    const sessionUniqueId = bounds.sessionUniqueId;

    const endFrame = resolveEndFrame(bounds, initialTel);

    if (endFrame === null) {
      this.logger.warn(`${logLabel}: recording length unavailable (ReplayFrameNum + ReplayFrameNumEnd); aborting`);

      return null;
    }

    let loFrame = bounds.startFrame;
    let hiFrame = endFrame;

    if (hiFrame <= loFrame) {
      this.logger.warn(
        `${logLabel}: empty session bounds for session ${targetSessionNum}/${sessionUniqueId} (lo=${loFrame}, hi=${hiFrame}); aborting`,
      );

      return null;
    }

    // Target the lap BEFORE the fastest one — we want to land at the end
    // of that lap (just before the S/F crossing into the fastest lap), so
    // playing from there shows the line-crossing into the fast lap.
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
          this.logger.warn(
            `${logLabel}: a probe inside session ${targetSessionNum}/${sessionUniqueId} read session ${tel.SessionNum ?? "n/a"}/${tel.SessionUniqueID ?? "n/a"}; the session map does not match the recording, aborting`,
          );
          this.logger.debug(`Probe frame ${mid}, bounds ${bounds.startFrame}-${endFrame}; cached session map dropped`);
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
          this.logger.debug(
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
      this.logger.debug(
        `${logLabel}: ${absentProbes} probe(s) found carIdx ${carIdx} out of the world and moved no bound`,
      );

      if (nearest === null) {
        this.logger.warn(
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
        this.logger.warn(`${logLabel}: CarIdxLap unavailable during lap-step ${step} (lap=${lap}); aborting`);

        return null;
      }

      if (lap === targetLapMinus1) {
        this.logger.debug(
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
        this.logger.warn(`${logLabel}: lap-step ${step} did not move the cursor; aborting`);

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

    // Phase 5: dist refinement. We're on the right lap but maybe not at
    // the end. If dist < 0.999, press nextLap to advance to the end; if
    // that overshoots into the next lap, press prevLap to come back. Each
    // nudge must be seen to land, or nothing about the frame is known.
    let nudges = 0;

    if (notConverged === null) {
      const refineDist = carDist(tel);
      // On lap 0 a car can stand still within a few metres of the line — on
      // its grid slot, in its pit stall — for minutes, so there a distance
      // near 1 proves nothing about the frame: a probe that landed on lap 0
      // without a lap search is nudged whatever it reads (#1354).
      const unplaced = targetLapMinus1 === 0 && !landedByLapSearch;

      if (unplaced || (typeof refineDist === "number" && refineDist < FASTEST_LAP_DIST_THRESHOLD)) {
        this.logger.debug(
          `${logLabel}: nudging via nextLap (currently lap=${targetLapMinus1}, dist=${typeof refineDist === "number" ? refineDist.toFixed(4) : "n/a"})`,
        );
        const forward = await search(() => send({ kind: "search", search: "nextLap" }), "nextLap (nudge)");

        nudges++;

        if (forward.kind !== "moved") {
          notConverged = `nudge (nextLap) ${forward.kind}`;
        } else {
          tel = forward.telemetry;
          landedByLapSearch = true;
          const afterLap = carLap(tel);

          if (typeof afterLap === "number" && afterLap > targetLapMinus1) {
            this.logger.debug(`${logLabel}: nextLap overshot to lap=${afterLap}; recovering via prevLap`);
            const back = await search(() => send({ kind: "search", search: "prevLap" }), "prevLap (nudge recovery)");

            nudges++;

            if (back.kind !== "moved") {
              notConverged = `nudge recovery (prevLap) ${back.kind}`;
            } else {
              tel = back.telemetry;
            }
          }
        }
      }
    }

    // The frame about to be recorded is the one before the back-step: verify
    // its sample says what the record will claim.
    const describeSample = (sample: TelemetryData | null): string =>
      `lap=${carLap(sample) ?? "n/a"}, dist=${typeof carDist(sample) === "number" ? (carDist(sample) as number).toFixed(4) : "n/a"}, session=${sample?.SessionNum ?? "n/a"}/${sample?.SessionUniqueID ?? "n/a"}`;
    const inTargetSession = (sample: TelemetryData | null): boolean =>
      sample?.SessionNum === targetSessionNum && sample?.SessionUniqueID === sessionUniqueId;

    if (notConverged === null) {
      const preLap = carLap(tel);
      const preDist = carDist(tel);

      if (!inTargetSession(tel)) {
        notConverged = `landed outside the target session ${targetSessionNum}/${sessionUniqueId} (${describeSample(tel)})`;
      } else if (preLap !== targetLapMinus1 || typeof preDist !== "number" || preDist < FASTEST_LAP_DIST_THRESHOLD) {
        notConverged = `not at the end of lap ${targetLapMinus1} before the back-step (${describeSample(tel)})`;
      }
    }

    // Phase 6: single absolute-frame back-step. Read the current frame,
    // jump to `frame - FASTEST_LAP_FINAL_BACKSTEP_TICKS` in one broadcast.
    const preBackstepFrame = readFrame(tel);

    if (preBackstepFrame === null) {
      this.logger.warn(`${logLabel}: ReplayFrameNum unavailable before the back-step; aborting`);

      return null;
    }

    const landedFrame = Math.max(0, preBackstepFrame - FASTEST_LAP_FINAL_BACKSTEP_TICKS);
    const finalTel = await jumpTo(landedFrame);

    if (finalTel == null) return null;

    // Two ticks back must still be the same lap of the same session instance
    // (the distance is allowed to dip under the threshold by those ticks).
    if (notConverged === null && (!inTargetSession(finalTel) || carLap(finalTel) !== targetLapMinus1)) {
      notConverged = `back-step landed elsewhere (${describeSample(finalTel)})`;
    }

    // Phase 7: the cursor is where the walk leaves it, paused. A cancellation
    // that arrived during the back-step ends the press here, before anything
    // is recorded.
    checkpoint();

    const lapStartFrame = landedFrame + FASTEST_LAP_FINAL_BACKSTEP_TICKS;
    const landedDist = carDist(finalTel);
    // Only for a landing a lap search produced: a bisection probe's distance
    // says where the car was on some frame, not that the frame is near a line.
    const priorLapDist =
      landedByLapSearch &&
      inTargetSession(finalTel) &&
      carLap(finalTel) === targetLapMinus1 &&
      typeof landedDist === "number"
        ? landedDist
        : null;

    if (notConverged !== null) {
      this.logger.warn(`${logLabel}: walk did not converge (${notConverged}); nothing recorded`);
      this.logger.debug(
        `${logLabel}: gave up after ${bisectionSteps} bisection + ${lapSteps} lap-step + ${nudges} nudge iterations (landed frame=${landedFrame}, target=${targetLap}, session=${targetSessionNum}/${sessionUniqueId})`,
      );

      return { telemetry: finalTel, landedFrame, lapStartFrame, converged: false, priorLapDist };
    }

    // The verified frame, back-adjusted by the back-step, is where this car
    // started `targetLap` as far as the walk can tell: into the record it
    // goes, so the next press for this lap is a lookup (and a press after a
    // restart, and a marker-style jump from another feature).
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

    this.logger.info(`${logLabel}: walk converged (lap start ${recorded ? "recorded" : "not recorded"})`);
    this.logger.debug(
      `${logLabel}: converged after ${bisectionSteps} bisection + ${lapSteps} lap-step + ${nudges} nudge iterations + ${FASTEST_LAP_FINAL_BACKSTEP_TICKS}-tick back-step (landed frame=${landedFrame}, lap start frame=${lapStartFrame}, ${describeSample(finalTel)}, target=${targetLap}, session=${targetSessionNum}/${sessionUniqueId})`,
    );

    return { telemetry: finalTel, landedFrame, lapStartFrame, converged: true, priorLapDist };
  }

  private executeMode(contextId: string, settings: ReplayControlSettings, repeat = false): void {
    const { mode } = settings;

    // Every replay command goes through the replay command gate (#1430),
    // which takes the replay cursor from an in-flight walk or jump itself and
    // decides whether the command goes out now, waits for the jump under way
    // to land, or is not sent. The camera and car keys send no replay command:
    // they take the cursor here, so a walk searching on the camera's car stops.
    // A fastest-lap or green-flag press takes it itself, once its guards have
    // passed: a press that is ignored must not cancel the one in flight.
    if (CAMERA_ONLY_MODES.has(mode)) this.cancelFastestLapWalk(mode);

    /** One press through the gate, named for the mode and this key's context. */
    const press = (command: ReplayGateCommand): ReplayPressResult =>
      pressReplayCommand(command, { by: mode, origin: contextId, repeat });

    switch (mode) {
      case "play-pause": {
        const current = this.getCurrentSpeed();

        if (current.speed !== 0) {
          // Any non-zero speed → pause
          const success = pressResult(press({ kind: "pause" }));
          this.setLocalSpeed(0, false);
          this.logger.info("Pause executed");
          this.logger.debug(`Result: ${success}, was speed: ${current.speed}`);
        } else {
          // Paused → play forward at 1x
          const success = pressResult(press({ kind: "speed", speed: 1, slowMotion: false, send: (r) => r.play() }));
          this.setLocalSpeed(1, false);
          this.logger.info("Play executed");
          this.logger.debug(`Result: ${success}`);
        }

        break;
      }
      case "play-backward": {
        const current = this.getCurrentSpeed();

        if (current.speed !== 0) {
          // Any non-zero speed → pause
          const success = pressResult(press({ kind: "pause" }));
          this.setLocalSpeed(0, false);
          this.logger.info("Pause backward executed");
          this.logger.debug(`Result: ${success}, was speed: ${current.speed}`);
        } else {
          // Paused → play backward at -1x
          const success = pressResult(press({ kind: "speed", speed: -1, slowMotion: false }));
          this.setLocalSpeed(-1, false);
          this.logger.info("Play backward executed");
          this.logger.debug(`Result: ${success}`);
        }

        break;
      }
      case "stop": {
        const success = pressResult(press({ kind: "pause" }));
        this.setLocalSpeed(0, false);
        this.logger.info("Stop executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "fast-forward": {
        const current = this.getCurrentSpeed();
        const step = settings.stepRate;
        let nextSpeed: number;

        if (!current.slowMotion && current.speed >= 2) {
          nextSpeed = Math.min(current.speed + step, 16);
        } else {
          nextSpeed = 2;
        }

        const success = pressResult(press({ kind: "speed", speed: nextSpeed, slowMotion: false }));
        this.setLocalSpeed(nextSpeed, false);
        this.logger.info("Fast forward executed");
        this.logger.debug(`Result: ${success}, speed: ${nextSpeed}, step: ${step}`);
        break;
      }
      case "rewind": {
        const current = this.getCurrentSpeed();
        const step = settings.stepRate;
        let nextSpeed: number;

        if (!current.slowMotion && current.speed <= -2) {
          nextSpeed = Math.max(current.speed - step, -16);
        } else {
          nextSpeed = -2;
        }

        const success = pressResult(press({ kind: "speed", speed: nextSpeed, slowMotion: false }));
        this.setLocalSpeed(nextSpeed, false);
        this.logger.info("Rewind executed");
        this.logger.debug(`Result: ${success}, speed: ${nextSpeed}, step: ${step}`);
        break;
      }
      case "slow-motion": {
        const current = this.getCurrentSpeed();
        const step = settings.stepRate;
        let nextSpeed: number;

        if (current.slowMotion && current.speed >= 2) {
          // Never faster than now: iRacing itself can sit below our 1/16x floor (1/17x)
          nextSpeed = Math.max(current.speed, Math.min(current.speed + step, 16));
        } else {
          nextSpeed = 2;
        }

        const success = pressResult(press({ kind: "speed", speed: nextSpeed, slowMotion: true }));
        this.setLocalSpeed(nextSpeed, true);
        this.logger.info("Slow motion executed");
        this.logger.debug(`Result: ${success}, speed: 1/${nextSpeed}x, step: ${step}`);
        break;
      }
      case "slow-motion-rewind": {
        const current = this.getCurrentSpeed();
        const step = settings.stepRate;
        let nextSpeed: number;

        if (current.slowMotion && current.speed <= -2) {
          // Never faster than now: iRacing itself can sit below our 1/16x floor (-1/17x)
          nextSpeed = Math.min(current.speed, Math.max(current.speed - step, -16));
        } else {
          nextSpeed = -2;
        }

        const success = pressResult(press({ kind: "speed", speed: nextSpeed, slowMotion: true }));
        this.setLocalSpeed(nextSpeed, true);
        this.logger.info("Slow motion rewind executed");
        this.logger.debug(`Result: ${success}, speed: -1/${Math.abs(nextSpeed)}x, step: ${step}`);
        break;
      }
      case "frame-forward": {
        const success = pressResult(press({ kind: "step", direction: 1 }));
        this.logger.info("Frame forward executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "frame-backward": {
        const success = pressResult(press({ kind: "step", direction: -1 }));
        this.logger.info("Frame backward executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "speed-increase": {
        const current = this.getCurrentSpeed();
        const absSpeed = Math.abs(current.speed);
        const isBackward = current.speed < 0;
        const sign = isBackward ? -1 : 1;
        let success: string;

        if (current.slowMotion && absSpeed > 2) {
          const next = absSpeed - 1;
          success = pressResult(press({ kind: "speed", speed: next * sign, slowMotion: true }));
          this.setLocalSpeed(next * sign, true);
          this.logger.debug(`Speed increase: slow-mo 1/${absSpeed}x -> 1/${next}x`);
        } else if (current.slowMotion && absSpeed <= 2) {
          success = pressResult(press({ kind: "speed", speed: sign, slowMotion: false }));
          this.setLocalSpeed(sign, false);
          this.logger.debug(`Speed increase: exiting slow-mo to ${sign}x`);
        } else if (absSpeed === 0) {
          success = pressResult(press({ kind: "speed", speed: 1, slowMotion: false, send: (r) => r.play() }));
          this.setLocalSpeed(1, false);
          this.logger.debug("Speed increase: from paused to 1x");
        } else if (absSpeed < 16) {
          success = pressResult(press({ kind: "speed", speed: (absSpeed + 1) * sign, slowMotion: false }));
          this.setLocalSpeed((absSpeed + 1) * sign, false);
          this.logger.debug(`Speed increase: ${current.speed}x -> ${(absSpeed + 1) * sign}x`);
        } else {
          // Already at max 16x
          this.logger.debug("Speed increase: already at max speed");
          break;
        }

        this.logger.info("Speed increase executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "speed-decrease": {
        const current = this.getCurrentSpeed();
        const absSpeed = Math.abs(current.speed);
        const isBackward = current.speed < 0;
        const sign = isBackward ? -1 : 1;
        let success: string;

        if (current.slowMotion && absSpeed < 16) {
          const next = absSpeed + 1;
          success = pressResult(press({ kind: "speed", speed: next * sign, slowMotion: true }));
          this.setLocalSpeed(next * sign, true);
          this.logger.debug(`Speed decrease: slow-mo 1/${absSpeed}x -> 1/${next}x`);
        } else if (current.slowMotion) {
          this.logger.debug("Speed decrease: already at min slow-mo speed");
          break;
        } else if (absSpeed === 0) {
          success = pressResult(press({ kind: "speed", speed: 2, slowMotion: true }));
          this.setLocalSpeed(2, true);
          this.logger.debug("Speed decrease: from paused to 1/2x");
        } else if (absSpeed > 1) {
          success = pressResult(press({ kind: "speed", speed: (absSpeed - 1) * sign, slowMotion: false }));
          this.setLocalSpeed((absSpeed - 1) * sign, false);
          this.logger.debug(`Speed decrease: ${current.speed}x -> ${(absSpeed - 1) * sign}x`);
        } else {
          success = pressResult(press({ kind: "speed", speed: 2 * sign, slowMotion: true }));
          this.setLocalSpeed(2 * sign, true);
          this.logger.debug(`Speed decrease: entering slow-mo at ${isBackward ? "-" : ""}1/2x`);
        }

        this.logger.info("Speed decrease executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "set-speed": {
        const { speed, slowMotion } = parseSpeedSetting(settings.speed);
        // A speed of 0 is a pause, which the gate treats as one: never sent into a jump under way.
        const success = pressResult(press(speed === 0 ? { kind: "pause" } : { kind: "speed", speed, slowMotion }));
        this.setLocalSpeed(speed, slowMotion);
        this.logger.info("Set speed executed");
        this.logger.debug(`Result: ${success}, speed: ${speed}, slowMotion: ${slowMotion}`);
        break;
      }
      case "speed-display": {
        // Read-only display — no action on press
        this.logger.debug("Speed display pressed — no action");
        break;
      }
      case "next-session": {
        const success = pressResult(press({ kind: "search", search: "nextSession" }));
        this.logger.info("Next session executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "prev-session": {
        const success = pressResult(press({ kind: "search", search: "prevSession" }));
        this.logger.info("Previous session executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "next-lap": {
        const success = pressResult(press({ kind: "search", search: "nextLap" }));
        this.logger.info("Next lap executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "prev-lap": {
        const success = pressResult(press({ kind: "search", search: "prevLap" }));
        this.logger.info("Previous lap executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "next-incident": {
        const success = pressResult(press({ kind: "search", search: "nextIncident" }));
        this.logger.info("Next incident executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "prev-incident": {
        const success = pressResult(press({ kind: "search", search: "prevIncident" }));
        this.logger.info("Previous incident executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "jump-to-beginning": {
        const success = pressResult(press({ kind: "go-to", end: "start" }));
        this.logger.info("Jump to beginning executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "jump-to-live": {
        const result = press({ kind: "go-to", end: "end" });

        // In a live session this leaves the replay for the car: every replay
        // consumer must read live at once, not hold the old replay frame
        // through the post-seek grace (#1230, #1324). In a saved replay it is
        // only a seek, and the controller leaves its state alone. Only for a
        // command that went out now: one waiting behind a search has not.
        if (result.kind === "sent" && result.ok) this.sdkController.noteReplayLeftForLive();

        this.logger.info("Jump to live executed");
        this.logger.debug(`Result: ${pressResult(result)}`);
        break;
      }
      case "jump-to-my-car": {
        const sessionInfo = this.sdkController.getSessionInfo();
        const driverInfo = (sessionInfo as Record<string, unknown>)?.DriverInfo as Record<string, unknown> | undefined;
        const driverCarIdx = (driverInfo?.DriverCarIdx as number) ?? -1;

        if (driverCarIdx < 0) {
          this.logger.warn("No session info available for jump to my car");
          break;
        }

        const carNum = this.getCarNumberRawByIdx(driverCarIdx);

        if (carNum === null) {
          this.logger.warn("Could not find car number for player");
          break;
        }

        const camera = getCommands().camera;
        const success = camera.switchNum(carNum, 0, 0);
        this.logger.info("Jump to my car executed");
        this.logger.debug(`Result: ${success}, carNum: ${carNum}`);
        break;
      }
      case "jump-to-fastest-lap": {
        const telemetry = this.sdkController.getCurrentTelemetry();
        const sessionInfo = this.sdkController.getSessionInfo();
        const targetCarIdx = this.resolveFastestLapCarIdx(settings.fastestLapTarget, telemetry);

        // CarIdx 255 is iRacing's "no driver" placeholder — appears when the
        // camera is mid-transition or focused on the pace car. The downstream
        // `findFastestLapForCar` would just return null and we'd log
        // "no best lap" anyway, but a direct guard is clearer and avoids
        // burning a SessionInfo/telemetry read.
        if (targetCarIdx < 0 || targetCarIdx === 255) {
          this.logger.warn("No target car available for jump to fastest lap");
          this.logger.debug(`Target setting: ${settings.fastestLapTarget}, carIdx: ${targetCarIdx}`);
          break;
        }

        // iRacing publishes SessionNum -1 for ~500 ms after the cursor lands
        // (see STABILIZATION_TIMEOUT_MULTIPLIER). A press in that window would
        // find a lap through the CarIdxBestLapNum fallback and walk toward session -1, which no session map
        // holds: the walk would pause the replay, move the cursor to the start
        // of the recording, and abort. Refuse it before any command is sent.
        const targetSessionNum = telemetry?.SessionNum;

        if (typeof targetSessionNum !== "number" || targetSessionNum < 0) {
          this.logger.info("Jump to fastest lap: replay session not settled yet; press ignored");
          this.logger.debug(`SessionNum=${String(targetSessionNum)}`);
          break;
        }

        const targetLap = findFastestLapForCar(sessionInfo, telemetry, targetCarIdx);

        // iRacing's own data (ResultsPositions, then CarIdxBestLapNum) names no
        // lap — a car with no timed lap yet, or none at all, like one that
        // finished with FastestLap -1. The session record is never consulted.
        if (targetLap === null) {
          this.logger.info("Jump to fastest lap: iRacing reports no fastest lap for the target car");
          this.logger.debug(`Target carIdx: ${targetCarIdx}`);
          break;
        }

        const carNum = this.getCarNumberRawByIdx(targetCarIdx);

        if (carNum === null) {
          this.logger.warn("Could not find car number for jump-to-fastest-lap target");
          break;
        }

        // A press while a walk or a record jump stands is ignored BEFORE any
        // command goes out: a camera switch from a key with another target
        // would re-frame the car iRacing's camera-relative lap-search is
        // walking (#1203), and any command cuts a record jump's seek short
        // (#1275).
        if (this.isFastestLapPressInFlight()) {
          this.logger.info("Jump to fastest lap: previous press still in flight; press ignored");
          this.logger.debug(
            `In-flight walk context: ${this.activeFastestLapPress?.contextId}, ignored press context: ${contextId}`,
          );
          reportReplayPressIgnored(contextId);
          break;
        }

        // iRacing honours camera and replay commands only out of the car
        // (irsdk_defines.h: "camera and replay commands only work when you
        // are out of your car"): a jump or a walk from the car would be sent,
        // ignored, and logged as done — and a walk would cache a session map
        // describing the live view. The debounced state, not the raw flag,
        // which reads false for ~300 ms after every seek (#1324).
        if (!this.sdkController.getReplayState().inReplay) {
          this.logger.info("Jump to fastest lap: replay not open; iRacing ignores replay commands from the car");
          break;
        }

        // Resolve the session at dispatch time so the lookup and the walk
        // both address the session the cursor is in (practice + qualifying
        // + race). `findFastestLapForCar` already used the same `SessionNum`
        // to look the lap number up; the `SessionUniqueID` pair tells two
        // instances of one `SessionNum` apart (a restart within a sim run).
        const sessionUniqueId = typeof telemetry?.SessionUniqueID === "number" ? telemetry.SessionUniqueID : null;
        const subSessionId = readSubSessionId(sessionInfo);

        this.logger.info("Jump to fastest lap executed");
        this.logger.debug(
          `Target carIdx: ${targetCarIdx}, carNum: ${carNum}, fastest lap: ${targetLap}, session: ${targetSessionNum}/${sessionUniqueId ?? "n/a"}, subSession: ${subSessionId ?? "n/a"}`,
        );

        // The record first (#1203): the lap start the plugin saw live, or a
        // frame an earlier walk landed on.
        const lookup = this.lookupRecordedLapStart({
          subSessionId,
          sessionNum: targetSessionNum,
          sessionUniqueId,
          carIdx: targetCarIdx,
          carNumberRaw: carNum,
          lap: targetLap,
        });

        if (lookup.hit) {
          this.logger.info(`Jump to fastest lap: record HIT (matchedBy ${lookup.matchedBy})`);
          this.logFastestTimeDisagreement(sessionInfo, targetSessionNum, targetCarIdx, targetLap, lookup.timeMs);

          // Fire-and-forget like the walk: the jump waits for the cursor to
          // land before it sends anything else (#1275), and the press handler
          // returns immediately.
          void this.jumpToRecordedLapStart(contextId, {
            carIdx: targetCarIdx,
            carNum,
            lap: targetLap,
            frame: lookup.frame,
            timeMs: lookup.timeMs,
          });
          break;
        }

        this.logger.info(`Jump to fastest lap: record MISS (${lookup.reason}); walking`);

        // The walk (issue #607, repaired in #1203). Fire-and-forget — the
        // press handler returns immediately; the walk writes what it found
        // into the record and leaves the replay as the Replay jump playback
        // setting says (#1276). It first switches the replay camera onto the
        // target car, since iRacing's lap-search is camera-focus-relative,
        // and only once no jump is under way: iRacing drops a camera change
        // sent during a seek (#1430). A record hit switches only after its
        // jump has landed, because any command sent during the seek can cut
        // it short (#1275).
        void this.walkToFastestLap(
          contextId,
          targetCarIdx,
          targetLap,
          targetSessionNum,
          { carNumberRaw: carNum, userId: readUserId(sessionInfo, targetCarIdx), subSessionId },
          typeof telemetry?.CamCarIdx === "number" ? telemetry.CamCarIdx : targetCarIdx,
          carNum,
        );
        break;
      }
      case "jump-to-race-start": {
        this.pressJumpToRaceStart(contextId);
        break;
      }
      case "next-car": {
        // Send the configured keystroke (default: V) so iRacing's own car-ordering
        // drives the cycle. Telemetry-driven selection picks the wrong driver during
        // replay-while-towed, where CamCarIdx reflects the live field.
        void this.tapBinding(CAR_CYCLE_BINDING_KEYS.next);
        this.logger.info("Next car executed (keystroke)");
        break;
      }
      case "prev-car": {
        void this.tapBinding(CAR_CYCLE_BINDING_KEYS.previous);
        this.logger.info("Previous car executed (keystroke)");
        break;
      }
      case "next-car-number":
      case "prev-car-number": {
        const telemetry = this.sdkController.getCurrentTelemetry();
        const camCarIdx = (telemetry?.CamCarIdx as number) ?? -1;

        if (camCarIdx < 0) {
          this.logger.warn("No camera target available for car number navigation");
          break;
        }

        const sessionInfo = this.sdkController.getSessionInfo();
        const navDirection = mode === "next-car-number" ? "next" : "prev";
        // Every car the session has had, departed ones included (#1281).
        const carNum = findAdjacentCarByNumber(sessionInfo, camCarIdx, navDirection);

        if (carNum === null) {
          this.logger.warn("Could not find adjacent car by number");
          break;
        }

        const camera = getCommands().camera;
        const success = camera.switchNum(carNum, 0, 0);
        this.logger.info("Car number navigation executed");
        this.logger.debug(`Direction: ${navDirection}, carNum: ${carNum}, result: ${success}`);
        break;
      }
    }

    // Re-render all telemetry-driven buttons (play-pause, play-backward, speed-display)
    // so cross-button state stays in sync (e.g., pressing play-backward updates the play-pause icon)
    this.updateAllTelemetryDisplays();
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<ReplayControlSettings> | IDeckDidReceiveSettingsEvent<ReplayControlSettings>,
    settings: ReplayControlSettings,
  ): Promise<void> {
    const contextId = ev.action.id;
    const svgDataUri = this.keySvg(contextId, settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(contextId, () => this.keySvg(contextId, settings));
  }

  /**
   * A key's icon from its state as it stands: playing, the replay speed, a
   * missing binding, Jump to Race Start's unavailable look, and the replay
   * busy look (#1437) — read from the indicator unless the caller has it.
   */
  private keySvg(
    contextId: string,
    settings: ReplayControlSettings,
    look: ReplayBusyLook = getReplayBusyLook(contextId),
  ): string {
    return generateReplayControlSvg(
      settings,
      this.shouldShowPause(contextId),
      this.replaySpeed.get(contextId),
      this.replaySlowMotion.get(contextId),
      this.isBindingMissing(KEYSTROKE_MODES[settings.mode]),
      this.readRaceStartUnavailable(contextId, settings),
      replayBusyKeyMark(look),
    );
  }

  /**
   * The replay busy indicator's redraw (#1437): the key composed from its
   * state with `look`, through the same path as every other redraw. A
   * telemetry-driven key also records what went out, so the next telemetry
   * redraw neither repeats it nor is swallowed by a key from before the look.
   */
  private redrawBusyKey(contextId: string, look: ReplayBusyLook): void {
    const settings = this.activeContexts.get(contextId);

    if (!settings) return;

    if (TELEMETRY_DISPLAY_MODES.has(settings.mode)) {
      this.lastState.set(contextId, this.telemetryDisplayKey(contextId, settings, replayBusyKeyMark(look)));
    }

    void this.updateKeyImage(contextId, this.keySvg(contextId, settings, look));
    this.setRegenerateCallback(contextId, () => this.keySvg(contextId, settings));
  }

  /**
   * Whether a context draws the unavailable look now, noting what went out so
   * a tick redraws only on a flip. Only Jump to Race Start has the look: a
   * replay with no race session is the one case its press cannot serve. A
   * missing green record does not grey the key — the fallback still lands —
   * and neither does sitting in the car, where every Replay Control jump does
   * nothing and a key grey all race would read as broken.
   */
  private readRaceStartUnavailable(contextId: string, settings: ReplayControlSettings): boolean {
    if (settings.mode !== "jump-to-race-start") {
      this.raceStartShown.delete(contextId);

      return false;
    }

    const sessionInfo = this.sdkController.getSessionInfo();
    const unavailable = isRaceStartUnavailable(sessionInfo);

    this.raceStartShown.set(contextId, { sessionInfo, unavailable });

    return unavailable;
  }

  /**
   * Per tick: redraw a Jump to Race Start key when the session list gains or
   * loses its race — a replay of another session was opened, or the YAML
   * arrived. A tick whose session info is the object last judged stops at the
   * comparison.
   */
  private refreshRaceStartAvailability(contextId: string): void {
    const settings = this.activeContexts.get(contextId);

    if (settings?.mode !== "jump-to-race-start") return;

    const shown = this.raceStartShown.get(contextId);

    if (shown !== undefined && shown.sessionInfo === this.sdkController.getSessionInfo()) return;

    const unavailable = this.readRaceStartUnavailable(contextId, settings);

    if (shown !== undefined && shown.unavailable === unavailable) return;

    this.logger.debug(`Jump to race start: key now ${unavailable ? "unavailable (no race session)" : "available"}`);
    void this.updateKeyImage(contextId, this.keySvg(contextId, settings));
    this.setRegenerateCallback(contextId, () => this.keySvg(contextId, settings));
  }

  private updateAllTelemetryDisplays(): void {
    for (const [contextId, settings] of this.activeContexts) {
      if (TELEMETRY_DISPLAY_MODES.has(settings.mode)) {
        this.updateDisplayFromTelemetry(contextId, settings);
      }
    }
  }

  private async updateDisplayFromTelemetry(contextId: string, settings: ReplayControlSettings): Promise<void> {
    if (!TELEMETRY_DISPLAY_MODES.has(settings.mode)) return;

    const look = getReplayBusyLook(contextId);
    const stateKey = this.telemetryDisplayKey(contextId, settings, replayBusyKeyMark(look));

    if (this.lastState.get(contextId) === stateKey) return;

    this.lastState.set(contextId, stateKey);

    const svgDataUri = this.keySvg(contextId, settings, look);
    await this.updateKeyImage(contextId, svgDataUri);
    this.setRegenerateCallback(contextId, () => this.keySvg(contextId, settings));
  }

  /**
   * What a telemetry-driven key last drew, for its redraw de-duplication: the
   * mode, the replay speed, the border overrides and the busy mark (#1437), so
   * a look that changed is never mistaken for the icon already on the key.
   */
  private telemetryDisplayKey(contextId: string, settings: ReplayControlSettings, mark: BusyMark | undefined): string {
    const speed = this.replaySpeed.get(contextId) ?? 0;
    const slowMo = this.replaySlowMotion.get(contextId) ?? false;
    const bo = settings.borderOverrides;
    const borderKey = `${bo?.enabled ?? ""}|${bo?.borderWidth ?? ""}|${bo?.borderColor ?? ""}|${bo?.glowEnabled ?? ""}|${bo?.glowWidth ?? ""}`;

    return `${settings.mode}:${speed}:${slowMo}:${borderKey}:${replayBusyMarkKey(mark)}`;
  }
}
