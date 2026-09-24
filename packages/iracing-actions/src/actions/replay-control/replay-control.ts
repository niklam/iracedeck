import {
  applyGraphicTransform,
  assembleIcon,
  CommonSettings,
  computeGraphicArea,
  ConnectionStateAwareAction,
  extractGraphicContent,
  generateBorderParts,
  generateTitleText,
  getCommands,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalSettings,
  getGlobalTitleSettings,
  getReplaySessionStore,
  ICON_BASE_TEMPLATE,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  isReplaySessionStoreInitialized,
  type LapStartLookup,
  type LapStartQuery,
  parseSvgViewBox,
  renderIconTemplate,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
} from "@iracedeck/deck-core";
import fastForwardIconSvg from "@iracedeck/icons/replay-control/fast-forward.svg";
import frameBackwardIconSvg from "@iracedeck/icons/replay-control/frame-backward.svg";
import frameForwardIconSvg from "@iracedeck/icons/replay-control/frame-forward.svg";
import jumpToBeginningIconSvg from "@iracedeck/icons/replay-control/jump-to-beginning.svg";
import jumpToFastestLapIconSvg from "@iracedeck/icons/replay-control/jump-to-fastest-lap.svg";
import jumpToLiveIconSvg from "@iracedeck/icons/replay-control/jump-to-live.svg";
import jumpToMyCarIconSvg from "@iracedeck/icons/replay-control/jump-to-my-car.svg";
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
  carInWorld,
  findNearestCarOnTrack,
  getAllCarNumbers,
  getCarNumberRawFromSessionInfo,
  ReplayPosMode,
  replaySpeedFromTelemetry,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import z from "zod";

import { computeCarNumberTarget } from "../../shared/car-cycling.js";
import { RepeatController } from "../../shared/repeat-controller.js";

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
  "next-car": "CAR\nNEXT",
  "prev-car": "CAR\nPREVIOUS",
  "next-car-number": "CAR #\nNEXT",
  "prev-car-number": "CAR #\nPREVIOUS",
};

/**
 * Which mode each detent of a rotation fires, for the modes that come in a
 * bidirectional pair. Keyed by the mode the key/dial is SET to; both members of
 * a pair map to the same two targets, so a dial behaves identically whichever
 * half of the pair it sits on.
 *
 * The fields name the physical gesture rather than the pair's "next" member on
 * purpose: most pairs read clockwise = next, but the car-number pair is
 * deliberately inverted (issue #973). On the number-primary controls a
 * clockwise detent makes the number on screen go DOWN — matching the Camera
 * Controls dial's Cycle by Car # and Cycle by Race Position modes (#884, #973)
 * — so one turn direction means the same thing across every control that
 * cycles BY a number.
 *
 * `next-car` / `prev-car` are NOT inverted: they tap iRacing's own Next /
 * Previous Car bindings (V / Shift-V by default), so the sim owns that ordering
 * and its "next" is not a number to shrink.
 *
 * The keypad is unaffected — a key dispatches `settings.mode` directly, so the
 * named modes ("CAR # NEXT" / "CAR # PREVIOUS") keep meaning what they say. So
 * does a dial PUSH (`executeDialDown`), which is deliberate but worth stating:
 * on a `next-car-number` dial the button walks UP the number order while a
 * clockwise turn walks DOWN it. The button keeps its printed meaning; only the
 * rotation follows the cross-action turn rule.
 */
const DIRECTIONAL_PAIRS: Partial<
  Record<ReplayControlMode, { clockwise: ReplayControlMode; counterClockwise: ReplayControlMode }>
> = {
  "next-session": { clockwise: "next-session", counterClockwise: "prev-session" },
  "prev-session": { clockwise: "next-session", counterClockwise: "prev-session" },
  "next-lap": { clockwise: "next-lap", counterClockwise: "prev-lap" },
  "prev-lap": { clockwise: "next-lap", counterClockwise: "prev-lap" },
  "next-incident": { clockwise: "next-incident", counterClockwise: "prev-incident" },
  "prev-incident": { clockwise: "next-incident", counterClockwise: "prev-incident" },
  "next-car": { clockwise: "next-car", counterClockwise: "prev-car" },
  "prev-car": { clockwise: "next-car", counterClockwise: "prev-car" },
  "next-car-number": { clockwise: "prev-car-number", counterClockwise: "next-car-number" },
  "prev-car-number": { clockwise: "prev-car-number", counterClockwise: "next-car-number" },
};

/**
 * @internal Exported for testing
 *
 * Global setting keys for the configurable car-cycle keystrokes.
 * The defaults (V / Shift+V) are declared in
 * `packages/iracing-actions/src/actions/data/key-bindings.json` under `replayControl`.
 */
export const NEXT_CAR_BINDING_KEY = "replayControlNextCar";
export const PREV_CAR_BINDING_KEY = "replayControlPrevCar";

/** Modes that depend on a global key binding (rather than an SDK command). */
const KEYSTROKE_MODES: Partial<Record<ReplayControlMode, string>> = {
  "next-car": NEXT_CAR_BINDING_KEY,
  "prev-car": PREV_CAR_BINDING_KEY,
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
 * Safety cap on bisection iterations (issue #607). log₂(N) jumps converge in
 * ~24 steps for a 2-hour endurance replay at 60 Hz (~430 k frames), so 30 is
 * a comfortable engineering ceiling that only trips on a pathological case
 * (an `inWorld` predicate that never converges because the car was never
 * in-world at any reachable frame). Distinct from the old `MAX_LAP_SEARCH_STEPS`
 * cap, which had to absorb O(N) lap-by-lap walks and a `× gap` wall-clock
 * budget — the bisection's wall-clock is ~`30 × gap` worst case.
 */
const MAX_BISECTION_STEPS = 30;

// Jump to Fastest Lap is a lookup first and a walk second (issue #1203,
// docs/superpowers/specs/2026-09-24-issue-1203-fastest-lap-from-session-record.md).
//
// The lookup reads the per-session replay record (`getReplaySessionStore().laps`,
// written live by the translator's lap-crossing events): a hit is one camera
// switch, one `setPlayPosition` to `LAP_START_APPROACH_FRAMES` before the
// recorded lap start, and `play()`.
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
// the walk ends with `play()` at 1×; one walk runs per action instance and any
// other Replay Control command cancels it; and a converged walk writes its
// landed frame into the record, so the next press is a lookup.

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
 * One session's frame bounds within the replay buffer. `endFrame` for the
 * LAST session is the recording's total length (`ReplayFrameNum +
 * ReplayFrameNumEnd`) at the time of the map build — it can lag the true live
 * edge if the replay keeps growing, but the fastest lap typically sits well
 * inside the recorded window anyway.
 */
type SessionMapEntry = {
  sessionNum: number;
  startFrame: number;
  endFrame: number;
};

type FastestLapSessionMap = {
  /**
   * Every `SessionUniqueID` we observed while building the map (one per
   * session — iRacing increments SessionUniqueID per session, not per race
   * weekend, so a single race-weekend has N IDs for N sessions). The cache
   * is reused whenever the current walk's SessionUniqueID matches ANY of
   * these — a press in practice and a press in race both reuse the same
   * map, but starting a new race weekend (all-new IDs) misses cleanly.
   */
  sessionUniqueIds: Set<number>;
  sessions: SessionMapEntry[];
};

/**
 * Module-level cache of the session map. Reused whenever the current walk's
 * `SessionUniqueID` is one of the IDs we observed while building, so a
 * single map covers every session in the race weekend. The frames a walk
 * lands on are NOT cached here: they go into the replay record
 * (`store.laps.recordLapStart`), which outlives the process.
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

/** Thrown inside a walk when another Replay Control command cancelled it; `walkToFastestLap` catches it. */
class FastestLapWalkCancelled extends Error {
  constructor(readonly by: string) {
    super(`walk cancelled by ${by}`);
    this.name = "FastestLapWalkCancelled";
  }
}

/** The one in-flight walk's cancellation token: set by the command that cancels it, read at the walk's next await. */
type FastestLapWalkToken = { cancelledBy: string | null };

/** What a converged walk writes into the lap record beside the frame it found. */
type FastestLapRecordIdentity = {
  carNumberRaw: number;
  userId: number;
  /** `WeekendInfo.SubSessionID`, when readable; the store ignores a record for a session it is not holding. */
  subSessionId: number | undefined;
};

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
 * Multiplier applied to the configured `fastestLapSearchDelayMs` to cap how
 * long the walk waits for a command to settle: an absolute jump until
 * `ReplayFrameNum` reads the frame that was sent (with `SessionNum` out of the
 * `-1` transient iRacing publishes while the cursor lands, issue #607), a
 * search until the frame has moved and held. The cap is `delay × 4` (default
 * 1.6 s). A jump that has not settled by then aborts the walk — the old
 * clock-only wait accepted the previous frame's telemetry and bisected the
 * wrong bracket (#1203). A search that has not moved by then is a legitimate
 * no-op at the buffer's edge (`nextSession` in the last session). Observed
 * first-jump transient is ~514 ms after a paused-replay `setPlayPosition`.
 */
const STABILIZATION_TIMEOUT_MULTIPLIER = 4;

/**
 * Interval the walk polls `getCurrentTelemetry()` at while waiting for a
 * command to settle, and the hold a moved search frame must keep across two
 * reads. 50 ms is ~3 sim ticks at 60 Hz — short enough to catch the
 * transition promptly without spinning.
 */
const STABILIZATION_POLL_INTERVAL_MS = 50;

/**
 * Default minimum gap after a replay lap-search broadcast before the next
 * command, when the `fastestLapSearchDelayMs` global setting isn't set. Even
 * when the replay is paused, the manual Next Lap / Previous Lap actions
 * exhibit the same drift when pressed in rapid succession: iRacing appears to
 * be resolving the exact lap-boundary position asynchronously after each
 * `ReplaySearch` and a follow-up broadcast that arrives before that work
 * finishes leaves the cursor parked mid-lap. 400 ms is the empirical default
 * that works reliably; slower machines and longer tracks can raise it via
 * Common Settings → Replay → Fastest Lap Search Delay. Since #1203 it is also
 * the timeout base for absolute jumps (`× STABILIZATION_TIMEOUT_MULTIPLIER`)
 * rather than their wait.
 */
const REPLAY_LAP_SEARCH_GAP_DEFAULT_MS = 400;

const REPLAY_LAP_SEARCH_GAP_MIN_MS = 50;
const REPLAY_LAP_SEARCH_GAP_MAX_MS = 1000;

/**
 * Reads the live `fastestLapSearchDelayMs` global setting, clamped to the
 * accepted range. Falls back to {@link REPLAY_LAP_SEARCH_GAP_DEFAULT_MS} on
 * any non-numeric value so a corrupted persisted value can't break the
 * walker.
 */
function readFastestLapSearchDelayMs(): number {
  const raw = (getGlobalSettings() as Record<string, unknown>).fastestLapSearchDelayMs;
  const value = typeof raw === "number" ? raw : Number(raw);

  if (!Number.isFinite(value)) return REPLAY_LAP_SEARCH_GAP_DEFAULT_MS;

  return Math.min(Math.max(value, REPLAY_LAP_SEARCH_GAP_MIN_MS), REPLAY_LAP_SEARCH_GAP_MAX_MS);
}

/**
 * @internal Exported for testing
 *
 * Parses a speed setting value into speed and slowMotion flag.
 * Format: "1"-"16" for normal speeds, "s2"-"s16" for slow-motion (1/Nx).
 */
export function parseSpeedSetting(value: string): { speed: number; slowMotion: boolean } {
  if (value.startsWith("s")) {
    const speed = parseInt(value.slice(1), 10);

    return { speed: isNaN(speed) ? 2 : Math.max(2, Math.min(speed, 16)), slowMotion: true };
  }

  const speed = parseInt(value, 10);

  return { speed: isNaN(speed) ? 1 : Math.max(1, Math.min(speed, 16)), slowMotion: false };
}

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
 * Formats a speed value for display.
 */
export function formatSpeedDisplay(speed: number, slowMotion: boolean): string {
  if (speed === 0) return "PAUSED";

  if (slowMotion && speed < 0) return `-1/${Math.abs(speed)}x`;

  if (slowMotion) return `1/${Math.abs(speed)}x`;

  if (speed < 0) return `${speed}x`;

  return `${speed}x`;
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
 */
export function generateReplayControlSvg(
  settings: { mode: ReplayControlMode; speed?: string } & Partial<CommonSettings>,
  isPlaying?: boolean,
  replaySpeed?: number,
  replaySlowMotion?: boolean,
  bindingMissing = false,
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

    if (graphicContent && viewBox) {
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

    if (graphicContent && viewBox) {
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

    return assembleIcon({ graphicSvg: iconSvg, colors: pauseColors, title, border, graphic });
  }

  // All other modes: static title via assembleIcon
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * @internal Exported for testing
 *
 * Find the physically closest car ahead or behind the currently viewed car (CamCarIdx).
 * Delegates to the shared findNearestCarOnTrack from @iracedeck/iracing-sdk.
 */
export function findAdjacentCarOnTrack(telemetry: TelemetryData | null, direction: "ahead" | "behind"): number | null {
  const camCarIdx = (telemetry?.CamCarIdx as number) ?? -1;

  return findNearestCarOnTrack(telemetry, camCarIdx, direction);
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
 * Includes all cars (even in pits), skips the pace car.
 * Returns the CarNumberRaw value for camera API use, or null if not found.
 *
 * Delegates to the shared `computeCarNumberTarget` walk (#885), so an
 * `isPresent` predicate (the shared `carInWorld`) makes it skip cars that are no
 * longer in the sim world — session info keeps every driver listed after they
 * tow out or leave post-race, but iRacing silently ignores a camera switch to
 * an absent car, which would dead-loop the cycle on the same target.
 */
export function findAdjacentCarByNumber(
  sessionInfo: unknown,
  currentCarIdx: number,
  direction: "next" | "prev",
  isPresent?: (carIdx: number) => boolean,
): number | null {
  const allCars = getAllCarNumbers(sessionInfo, true);
  const target = computeCarNumberTarget(currentCarIdx, allCars, direction === "next" ? "next" : "previous", isPresent);

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
});

type ReplayControlSettings = z.infer<typeof ReplayControlSettings>;

/**
 * Replay Control
 * Unified replay action combining transport, speed, and navigation controls.
 * Provides progressive speed control for fast-forward, rewind, and slow-motion
 * with telemetry-driven display.
 */
export const REPLAY_CONTROL_UUID = "com.iracedeck.sd.core.replay-control" as const;

export class ReplayControl extends ConnectionStateAwareAction<ReplayControlSettings> {
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
   * The one in-flight jump-to-fastest-lap walk, per action instance — two
   * keys would otherwise run two walks against one cursor. A second
   * fastest-lap press while it runs is dropped (the walk is converging on the
   * same target); any other Replay Control command cancels it through the
   * token, and the walk unwinds at its next await without sending anything
   * more, leaving the cursor where the user's command put it.
   */
  private activeFastestLapWalk: { contextId: string; token: FastestLapWalkToken } | null = null;

  /** Last rendered state key per context (prevents redundant re-renders) */
  private lastState = new Map<string, string>();

  override async onWillAppear(ev: IDeckWillAppearEvent<ReplayControlSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.setActiveBinding(KEYSTROKE_MODES[settings.mode] ?? null);

    // Seed initial state from current telemetry
    const current = this.sdkController.getCurrentTelemetry();
    this.seedTelemetryState(ev.action.id, current);

    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry: TelemetryData | null) => {
      const prevStateKey = this.buildTelemetryStateKey(ev.action.id);
      this.updateTelemetryState(ev.action.id, telemetry);
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
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<ReplayControlSettings>): Promise<void> {
    this.repeat.clear(ev.action.id);
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.replaySpeed.delete(ev.action.id);
    this.replaySlowMotion.delete(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<ReplayControlSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    // Settings can change mid-hold; drop any pending repeat and held state.
    this.repeat.clear(ev.action.id);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.setActiveBinding(KEYSTROKE_MODES[settings.mode] ?? null);
    await this.updateDisplay(ev, settings);
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
          this.executeMode(ev.action.id, settings);

          return true;
        },
      });
    }
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<ReplayControlSettings>): Promise<void> {
    this.repeat.onKeyUp(ev.action.id);
  }

  override async onDialDown(ev: IDeckDialDownEvent<ReplayControlSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeDialDown(ev.action.id, settings);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<ReplayControlSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeDialRotate(ev.action.id, settings.mode, ev.payload.ticks);
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

  private findAdjacentCarOnTrack(direction: "ahead" | "behind"): number | null {
    const telemetry = this.sdkController.getCurrentTelemetry();

    return findAdjacentCarOnTrack(telemetry, direction);
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
   * Cancel the in-flight walk, if any, naming the command that did. Idempotent:
   * the first caller names the reason, later ones find it set. The walk
   * observes the token at its next await, so a command sent right after this
   * call is never overridden by a further probe.
   */
  private cancelFastestLapWalk(by: string): void {
    const walk = this.activeFastestLapWalk;

    if (walk === null || walk.token.cancelledBy !== null) return;

    walk.token.cancelledBy = by;
    this.logger.info(`Jump to fastest lap: walk cancelled by ${by}`);
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
   *   1. **Session map.** On the first walk per `SessionUniqueID`, build a
   *      cache of session bounds by `goToStart` + `nextSession` × N; the
   *      recording's extent is `ReplayFrameNum + ReplayFrameNumEnd` from the
   *      first stable read, so the walk never leaves the replay (no `goToEnd`).
   *      Subsequent walks within the same replay skip straight to phase 2.
   *   2. **Bisect within target session.** Look up the target session's
   *      [startFrame, endFrame] from the map and bisect with
   *      `setPlayPosition(Begin, mid)` until the car is within
   *      {@link CLOSE_ENOUGH_LAPS} of the lap before the target.
   *   3. **Lap-step refinement.** `nextLap` / `prevLap` until
   *      `CarIdxLap[carIdx]` is the lap before the target, a distance nudge
   *      to that lap's end, and a {@link FASTEST_LAP_FINAL_BACKSTEP_TICKS}
   *      back-step, so the car is visibly approaching the line.
   *   4. **Play, and record.** `play()` at 1× (mirrored into the speed cache,
   *      like the opening `pause()`), and the landed frame — back-adjusted by
   *      the back-step — goes into the record as the car's start of `targetLap`,
   *      so the next press for it is a lookup.
   *
   * An absolute jump settles when `ReplayFrameNum` reads the sent frame; a
   * search when the frame has moved from its pre-command value and held across
   * two reads {@link STABILIZATION_POLL_INTERVAL_MS} apart, with the configured
   * `fastestLapSearchDelayMs` as the minimum gap before the next command. One
   * walk runs per action instance; a second fastest-lap press while it runs is
   * ignored, and any other Replay Control command cancels it. An aborted walk
   * (a jump that never settled, a missing field) leaves the replay paused with
   * the cache saying so, so the Play key plays.
   */
  async walkToFastestLap(
    contextId: string,
    carIdx: number,
    targetLap: number,
    targetSessionNum: number,
    identity: FastestLapRecordIdentity,
  ): Promise<void> {
    if (this.activeFastestLapWalk !== null) {
      this.logger.info("Jump to fastest lap: walk already in flight; press ignored");
      this.logger.debug(
        `In-flight walk context: ${this.activeFastestLapWalk.contextId}, ignored press context: ${contextId}`,
      );

      return;
    }

    const token: FastestLapWalkToken = { cancelledBy: null };

    this.activeFastestLapWalk = { contextId, token };

    try {
      await this.runFastestLapWalk(token, carIdx, targetLap, targetSessionNum, identity);
    } catch (error) {
      if (error instanceof FastestLapWalkCancelled) {
        this.logger.debug(`Jump to fastest lap: ${error.message}; cursor left where that command put it`);
      } else {
        this.logger.error(
          `Jump to fastest lap: walk failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      this.activeFastestLapWalk = null;
    }
  }

  private async runFastestLapWalk(
    token: FastestLapWalkToken,
    carIdx: number,
    targetLap: number,
    targetSessionNum: number,
    identity: FastestLapRecordIdentity,
  ): Promise<void> {
    const replay = getCommands().replay;
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    const checkpoint = (): void => {
      if (token.cancelledBy !== null) throw new FastestLapWalkCancelled(token.cancelledBy);
    };

    /** Every wait in the walk: a cancellation is observed as soon as the sleep ends. */
    const wait = async (ms: number): Promise<void> => {
      await sleep(ms);
      checkpoint();
    };

    const readFrame = (tel: TelemetryData | null): number | null =>
      typeof tel?.ReplayFrameNum === "number" ? tel.ReplayFrameNum : null;

    /** Out of the `SessionNum = -1` transient — a sample whose per-car arrays can be read. */
    const isSettledSample = (tel: TelemetryData | null): tel is TelemetryData =>
      tel != null && typeof tel.SessionNum === "number" && tel.SessionNum >= 0;

    /**
     * Send an absolute jump and wait until `ReplayFrameNum` reads the frame
     * that was sent. Null past the timeout, with the frame seen logged.
     */
    const jumpTo = async (frame: number): Promise<TelemetryData | null> => {
      checkpoint();
      replay.setPlayPosition(ReplayPosMode.Begin, frame);

      const timeoutMs = readFastestLapSearchDelayMs() * STABILIZATION_TIMEOUT_MULTIPLIER;
      const deadline = Date.now() + timeoutMs;
      let last: TelemetryData | null = null;

      while (Date.now() < deadline) {
        await wait(STABILIZATION_POLL_INTERVAL_MS);
        last = this.sdkController.getCurrentTelemetry();

        if (readFrame(last) === frame && isSettledSample(last)) return last;
      }

      this.logger.warn("Jump to fastest lap: jump did not settle; aborting walk");
      this.logger.debug(
        `Sent frame ${frame}, saw frame ${readFrame(last) ?? "n/a"} (SessionNum ${last?.SessionNum ?? "n/a"}) after ${timeoutMs} ms`,
      );

      return null;
    };

    /**
     * Send a search and wait until `ReplayFrameNum` has moved from its
     * pre-command value and held across two reads. Past the timeout the
     * cursor is taken not to have moved (a search at the buffer's edge is a
     * no-op the sim never reports). The configured delay is the minimum gap
     * before the next command either way.
     */
    const search = async (
      command: () => boolean,
      label: string,
    ): Promise<{ telemetry: TelemetryData | null; moved: boolean }> => {
      checkpoint();

      const before = readFrame(this.sdkController.getCurrentTelemetry());
      const sentAt = Date.now();

      command();

      const gapMs = readFastestLapSearchDelayMs();
      const deadline = sentAt + gapMs * STABILIZATION_TIMEOUT_MULTIPLIER;
      let held: number | null = null;
      let result: { telemetry: TelemetryData | null; moved: boolean } | null = null;

      while (Date.now() < deadline) {
        await wait(STABILIZATION_POLL_INTERVAL_MS);
        const tel = this.sdkController.getCurrentTelemetry();
        const frame = readFrame(tel);

        if (frame === null || frame === before) {
          held = null;
          continue;
        }

        if (held === frame && isSettledSample(tel)) {
          result = { telemetry: tel, moved: true };
          break;
        }

        held = frame;
      }

      if (result === null) {
        result = { telemetry: this.sdkController.getCurrentTelemetry(), moved: false };
        this.logger.debug(`Jump to fastest lap: ${label} did not move the cursor from frame ${before ?? "n/a"}`);
      }

      const remainingGapMs = sentAt + gapMs - Date.now();

      if (remainingGapMs > 0) await wait(remainingGapMs);

      return result;
    };

    const buildSessionMap = async (): Promise<FastestLapSessionMap | null> => {
      const sessionUniqueIds = new Set<number>();
      const recordUniqueId = (tel: TelemetryData): void => {
        if (typeof tel.SessionUniqueID === "number") sessionUniqueIds.add(tel.SessionUniqueID);
      };

      const first = await search(() => replay.goToStart(), "goToStart");
      const firstTel = first.telemetry;

      if (!isSettledSample(firstTel)) {
        this.logger.warn("Jump to fastest lap: telemetry did not settle after goToStart; aborting map build");

        return null;
      }

      recordUniqueId(firstTel);
      const firstFrame = firstTel.ReplayFrameNum;
      const firstSession = firstTel.SessionNum;
      const framesToEnd = firstTel.ReplayFrameNumEnd;

      if (typeof firstFrame !== "number" || typeof firstSession !== "number" || typeof framesToEnd !== "number") {
        this.logger.warn("Jump to fastest lap: missing fields after goToStart; aborting map build");
        this.logger.debug(`After goToStart: frame=${firstFrame}, framesToEnd=${framesToEnd}, session=${firstSession}`);

        return null;
      }

      // The recording's total length, constant while a replay is open — the
      // buffer's end without a `goToEnd`, which in a live session would leave
      // the replay for the live view.
      const totalFrames = firstFrame + framesToEnd;
      const sessions: SessionMapEntry[] = [{ sessionNum: firstSession, startFrame: firstFrame, endFrame: -1 }];
      let lastSession = firstSession;

      for (let i = 0; i < MAX_SESSIONS; i++) {
        const step = await search(() => replay.nextSession(), `nextSession #${i + 1}`);

        // Not moving is how the sim says "already in the last session".
        if (!step.moved) break;

        const tel = step.telemetry;

        if (!isSettledSample(tel)) {
          this.logger.warn(`Jump to fastest lap: telemetry did not settle after nextSession #${i + 1}; aborting`);

          return null;
        }

        recordUniqueId(tel);
        const frame = tel.ReplayFrameNum;
        const session = tel.SessionNum;

        if (typeof frame !== "number" || typeof session !== "number") {
          this.logger.warn("Jump to fastest lap: missing fields after nextSession; aborting map build");

          return null;
        }

        if (session === lastSession) break;

        sessions.push({ sessionNum: session, startFrame: frame, endFrame: -1 });
        lastSession = session;
      }

      for (let i = 0; i < sessions.length; i++) {
        sessions[i].endFrame = i + 1 < sessions.length ? sessions[i + 1].startFrame - 1 : totalFrames;
      }

      return { sessionUniqueIds, sessions };
    };

    // Pause first so the cursor doesn't drift between commands and the
    // post-settle telemetry sample — and tell the speed cache, so a Play
    // press during or after the walk sends play rather than pause.
    replay.pause();
    this.setLocalSpeed(0, false);
    this.updateAllTelemetryDisplays();
    await wait(readFastestLapSearchDelayMs());

    // Phase 1: session map (cache or build).
    const initialTel = this.sdkController.getCurrentTelemetry();
    const sessionUniqueId = initialTel?.SessionUniqueID;

    if (typeof sessionUniqueId !== "number") {
      this.logger.warn("Jump to fastest lap: SessionUniqueID unavailable; aborting");

      return;
    }

    let sessionMap = cachedFastestLapSessionMap;
    const cacheHit = sessionMap != null && sessionMap.sessionUniqueIds.has(sessionUniqueId);

    this.logger.info(
      `Jump to fastest lap: cache ${cacheHit ? "HIT" : "MISS"} (currentUniqueId=${sessionUniqueId}, cachedUniqueIds=${
        sessionMap == null ? "<none>" : `{${[...sessionMap.sessionUniqueIds].join(",")}}`
      })`,
    );

    if (sessionMap == null || !cacheHit) {
      const built = await buildSessionMap();

      if (built == null) return;

      sessionMap = built;
      cachedFastestLapSessionMap = built;
      this.logger.info(
        `Jump to fastest lap: session map built — uniqueIds={${[...sessionMap.sessionUniqueIds].join(",")}}, ${sessionMap.sessions
          .map((s) => `S${s.sessionNum}[${s.startFrame}-${s.endFrame}]`)
          .join(", ")}`,
      );
    } else {
      this.logger.debug(`Jump to fastest lap: reusing cached session map (${sessionMap.sessions.length} sessions)`);
    }

    // Phase 2: look up target session bounds.
    const bounds = sessionMap.sessions.find((s) => s.sessionNum === targetSessionNum);

    if (bounds == null) {
      this.logger.warn(`Jump to fastest lap: target session ${targetSessionNum} not in session map; aborting`);

      return;
    }

    let loFrame = bounds.startFrame;
    let hiFrame = bounds.endFrame;

    if (hiFrame <= loFrame) {
      this.logger.warn(
        `Jump to fastest lap: empty session bounds for session ${targetSessionNum} (lo=${loFrame}, hi=${hiFrame}); aborting`,
      );

      return;
    }

    // Target the lap BEFORE the fastest one — we want to land at the end
    // of that lap (just before the S/F crossing into the fastest lap), so
    // the play that ends the walk shows the line-crossing into the fast lap.
    const targetLapMinus1 = Math.max(0, targetLap - 1);

    // Phase 3: bisect within the target session until we're within
    // CLOSE_ENOUGH_LAPS of the lap-before-fastest.
    let bisectionSteps = 0;
    let tel: TelemetryData | null = initialTel;

    for (let step = 0; step < MAX_BISECTION_STEPS; step++) {
      if (hiFrame - loFrame <= 1) break;

      const mid = Math.floor((loFrame + hiFrame) / 2);

      tel = await jumpTo(mid);
      bisectionSteps = step + 1;

      if (tel == null) return;

      const lap = (tel.CarIdxLap as number[] | undefined)?.[carIdx];

      if (typeof lap !== "number" || lap < 0) {
        // Car not in world at this probe — assume we're before the target
        // and advance the lower bound.
        loFrame = mid;
        continue;
      }

      if (Math.abs(lap - targetLapMinus1) <= CLOSE_ENOUGH_LAPS) {
        this.logger.debug(
          `Jump to fastest lap: bisection landed within ${CLOSE_ENOUGH_LAPS} laps after ${bisectionSteps} steps (frame=${mid}, lap=${lap}, target=${targetLapMinus1})`,
        );
        break;
      }

      if (lap < targetLapMinus1) {
        loFrame = mid;
      } else {
        hiFrame = mid;
      }
    }

    // Phase 4: lap-step until we're on the lap-before-fastest. `tel` is the
    // settled sample of the last command, so each step reads before it sends.
    let lapSteps = 0;

    for (let step = 0; step < MAX_LAP_STEPS; step++) {
      const lap = (tel?.CarIdxLap as number[] | undefined)?.[carIdx];

      if (typeof lap !== "number" || lap < 0) {
        this.logger.warn(`Jump to fastest lap: CarIdxLap unavailable during lap-step ${step} (lap=${lap}); aborting`);

        return;
      }

      if (lap === targetLapMinus1) {
        this.logger.debug(
          `Jump to fastest lap: lap-step phase converged after ${lapSteps} steps (lap=${lap}, target=${targetLapMinus1})`,
        );
        break;
      }

      const stepped =
        lap < targetLapMinus1
          ? await search(() => replay.nextLap(), "nextLap")
          : await search(() => replay.prevLap(), "prevLap");

      lapSteps = step + 1;

      if (!stepped.moved) {
        this.logger.warn(`Jump to fastest lap: lap-step ${step} did not move the cursor; aborting`);

        return;
      }

      tel = stepped.telemetry;
    }

    // Phase 5: dist refinement. We're on the right lap but maybe not at
    // the end. If dist < 0.999, press nextLap to advance to the end; if
    // that overshoots into the next lap, press prevLap to come back.
    const refineLap = (tel?.CarIdxLap as number[] | undefined)?.[carIdx];
    const refineDist = (tel?.CarIdxLapDistPct as number[] | undefined)?.[carIdx];
    let nudges = 0;

    if (
      typeof refineLap === "number" &&
      typeof refineDist === "number" &&
      refineLap === targetLapMinus1 &&
      refineDist < FASTEST_LAP_DIST_THRESHOLD
    ) {
      this.logger.debug(
        `Jump to fastest lap: nudging via nextLap (currently lap=${refineLap}, dist=${refineDist.toFixed(4)})`,
      );
      const forward = await search(() => replay.nextLap(), "nextLap (nudge)");

      nudges++;
      tel = forward.telemetry;
      const afterLap = (tel?.CarIdxLap as number[] | undefined)?.[carIdx];

      if (typeof afterLap === "number" && afterLap > targetLapMinus1) {
        this.logger.debug(`Jump to fastest lap: nextLap overshot to lap=${afterLap}; recovering via prevLap`);
        const back = await search(() => replay.prevLap(), "prevLap (nudge recovery)");

        nudges++;
        tel = back.telemetry;
      }
    }

    // Phase 6: single absolute-frame back-step. Read the current frame,
    // jump to `frame - FASTEST_LAP_FINAL_BACKSTEP_TICKS` in one broadcast.
    const preBackstepFrame = readFrame(tel);

    if (preBackstepFrame === null) {
      this.logger.warn("Jump to fastest lap: ReplayFrameNum unavailable before the back-step; aborting");

      return;
    }

    const landedFrame = Math.max(0, preBackstepFrame - FASTEST_LAP_FINAL_BACKSTEP_TICKS);
    const finalTel = await jumpTo(landedFrame);

    if (finalTel == null) return;

    // Phase 7: play at 1× — the same end state as a record hit — and tell the
    // speed cache what was sent.
    checkpoint();
    replay.play();
    this.setLocalSpeed(1, false);
    this.updateAllTelemetryDisplays();

    // The landed frame, back-adjusted by the back-step, is where this car
    // started `targetLap` as far as the walk can tell: into the record it
    // goes, so the next press for this lap is a lookup (and a press after a
    // restart, and a marker-style jump from another feature).
    const lapStartFrame = landedFrame + FASTEST_LAP_FINAL_BACKSTEP_TICKS;
    let recorded = false;

    if (isReplaySessionStoreInitialized()) {
      recorded = getReplaySessionStore().laps.recordLapStart({
        subSessionId: identity.subSessionId,
        sessionNum: targetSessionNum,
        sessionUniqueId,
        carIdx,
        carNumberRaw: identity.carNumberRaw,
        userId: identity.userId,
        lap: targetLap,
        frame: lapStartFrame,
      });
    }

    const finalLap = (finalTel.CarIdxLap as number[] | undefined)?.[carIdx];
    const finalDist = (finalTel.CarIdxLapDistPct as number[] | undefined)?.[carIdx];

    this.logger.info(
      `Jump to fastest lap: walk converged; replay playing (lap start ${recorded ? "recorded" : "not recorded"})`,
    );
    this.logger.debug(
      `Jump to fastest lap: converged after ${bisectionSteps} bisection + ${lapSteps} lap-step + ${nudges} nudge iterations + ${FASTEST_LAP_FINAL_BACKSTEP_TICKS}-tick back-step (landed frame=${landedFrame}, lap start frame=${lapStartFrame}, lap=${finalLap}, dist=${typeof finalDist === "number" ? finalDist.toFixed(4) : "n/a"}, target=${targetLap}, session=${targetSessionNum}/${sessionUniqueId})`,
    );
  }

  private executeMode(contextId: string, settings: ReplayControlSettings): void {
    const replay = getCommands().replay;
    const { mode } = settings;

    // Every command but the fastest-lap press itself takes the replay back
    // from an in-flight walk (speed-display sends nothing and is left out).
    if (mode !== "jump-to-fastest-lap" && mode !== "speed-display") this.cancelFastestLapWalk(mode);

    switch (mode) {
      case "play-pause": {
        const current = this.getCurrentSpeed();

        if (current.speed !== 0) {
          // Any non-zero speed → pause
          const success = replay.pause();
          this.setLocalSpeed(0, false);
          this.logger.info("Pause executed");
          this.logger.debug(`Result: ${success}, was speed: ${current.speed}`);
        } else {
          // Paused → play forward at 1x
          const success = replay.play();
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
          const success = replay.pause();
          this.setLocalSpeed(0, false);
          this.logger.info("Pause backward executed");
          this.logger.debug(`Result: ${success}, was speed: ${current.speed}`);
        } else {
          // Paused → play backward at -1x
          const success = replay.setPlaySpeed(-1);
          this.setLocalSpeed(-1, false);
          this.logger.info("Play backward executed");
          this.logger.debug(`Result: ${success}`);
        }

        break;
      }
      case "stop": {
        const success = replay.pause();
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

        const success = replay.setPlaySpeed(nextSpeed);
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

        const success = replay.setPlaySpeed(nextSpeed);
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

        const success = replay.setPlaySpeed(nextSpeed, true);
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

        const success = replay.setPlaySpeed(nextSpeed, true);
        this.setLocalSpeed(nextSpeed, true);
        this.logger.info("Slow motion rewind executed");
        this.logger.debug(`Result: ${success}, speed: -1/${Math.abs(nextSpeed)}x, step: ${step}`);
        break;
      }
      case "frame-forward": {
        const success = replay.nextFrame();
        this.logger.info("Frame forward executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "frame-backward": {
        const success = replay.prevFrame();
        this.logger.info("Frame backward executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "speed-increase": {
        const current = this.getCurrentSpeed();
        const absSpeed = Math.abs(current.speed);
        const isBackward = current.speed < 0;
        const sign = isBackward ? -1 : 1;
        let success: boolean;

        if (current.slowMotion && absSpeed > 2) {
          const next = absSpeed - 1;
          success = replay.setPlaySpeed(next * sign, true);
          this.setLocalSpeed(next * sign, true);
          this.logger.debug(`Speed increase: slow-mo 1/${absSpeed}x -> 1/${next}x`);
        } else if (current.slowMotion && absSpeed <= 2) {
          success = replay.setPlaySpeed(sign, false);
          this.setLocalSpeed(sign, false);
          this.logger.debug(`Speed increase: exiting slow-mo to ${sign}x`);
        } else if (absSpeed === 0) {
          success = replay.play();
          this.setLocalSpeed(1, false);
          this.logger.debug("Speed increase: from paused to 1x");
        } else if (absSpeed < 16) {
          success = replay.setPlaySpeed((absSpeed + 1) * sign);
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
        let success: boolean;

        if (current.slowMotion && absSpeed < 16) {
          const next = absSpeed + 1;
          success = replay.setPlaySpeed(next * sign, true);
          this.setLocalSpeed(next * sign, true);
          this.logger.debug(`Speed decrease: slow-mo 1/${absSpeed}x -> 1/${next}x`);
        } else if (current.slowMotion) {
          this.logger.debug("Speed decrease: already at min slow-mo speed");
          break;
        } else if (absSpeed === 0) {
          success = replay.setPlaySpeed(2, true);
          this.setLocalSpeed(2, true);
          this.logger.debug("Speed decrease: from paused to 1/2x");
        } else if (absSpeed > 1) {
          success = replay.setPlaySpeed((absSpeed - 1) * sign);
          this.setLocalSpeed((absSpeed - 1) * sign, false);
          this.logger.debug(`Speed decrease: ${current.speed}x -> ${(absSpeed - 1) * sign}x`);
        } else {
          success = replay.setPlaySpeed(2 * sign, true);
          this.setLocalSpeed(2 * sign, true);
          this.logger.debug(`Speed decrease: entering slow-mo at ${isBackward ? "-" : ""}1/2x`);
        }

        this.logger.info("Speed decrease executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "set-speed": {
        const { speed, slowMotion } = parseSpeedSetting(settings.speed);
        const success = replay.setPlaySpeed(speed, slowMotion);
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
        const success = replay.nextSession();
        this.logger.info("Next session executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "prev-session": {
        const success = replay.prevSession();
        this.logger.info("Previous session executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "next-lap": {
        const success = replay.nextLap();
        this.logger.info("Next lap executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "prev-lap": {
        const success = replay.prevLap();
        this.logger.info("Previous lap executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "next-incident": {
        const success = replay.nextIncident();
        this.logger.info("Next incident executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "prev-incident": {
        const success = replay.prevIncident();
        this.logger.info("Previous incident executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "jump-to-beginning": {
        const success = replay.goToStart();
        this.logger.info("Jump to beginning executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "jump-to-live": {
        const success = replay.goToEnd();
        this.logger.info("Jump to live executed");
        this.logger.debug(`Result: ${success}`);
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

        const targetLap = findFastestLapForCar(sessionInfo, telemetry, targetCarIdx);

        if (targetLap === null) {
          this.logger.info("Jump to fastest lap: no best lap recorded yet for target car");
          this.logger.debug(`Target carIdx: ${targetCarIdx}`);
          break;
        }

        // Switch the replay camera onto the target car so the viewed car is
        // the one whose lap plays, and so iRacing's lap-search (camera-focus-
        // relative) walks the right driver. For viewed-car this is usually a
        // no-op (camera is already there); for always-my-car it actively
        // re-frames.
        const carNum = this.getCarNumberRawByIdx(targetCarIdx);

        if (carNum === null) {
          this.logger.warn("Could not find car number for jump-to-fastest-lap target");
          break;
        }

        const cameraSwitched = getCommands().camera.switchNum(carNum, 0, 0);

        if (!cameraSwitched) {
          // If the SDK refused, abort rather than play or walk the wrong driver.
          this.logger.warn("Jump to fastest lap: camera switch failed, aborting");
          this.logger.debug(`Failed switchNum: carNum=${carNum}, carIdx=${targetCarIdx}`);
          break;
        }

        // Resolve the session at dispatch time so the lookup and the walk
        // both address the session the cursor is in (practice + qualifying
        // + race). `findFastestLapForCar` already used the same `SessionNum`
        // to look the lap number up; the `SessionUniqueID` pair tells two
        // instances of one `SessionNum` apart (a restart within a sim run).
        const targetSessionNum = typeof telemetry?.SessionNum === "number" ? telemetry.SessionNum : 0;
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
          // A walk in flight is converging on a frame the record already has.
          this.cancelFastestLapWalk(mode);

          const approachFrame = Math.max(0, lookup.frame - LAP_START_APPROACH_FRAMES);
          const positioned = replay.setPlayPosition(ReplayPosMode.Begin, approachFrame);
          const played = replay.play();

          this.setLocalSpeed(1, false);
          this.logger.info(`Jump to fastest lap: record HIT (matchedBy ${lookup.matchedBy})`);
          this.logger.debug(
            `Lap ${targetLap} of carIdx ${targetCarIdx} starts at frame ${lookup.frame} (time ${lookup.timeMs ?? "untimed"} ms); jumped to ${approachFrame} (setPlayPosition: ${positioned}, play: ${played})`,
          );
          this.logFastestTimeDisagreement(sessionInfo, targetSessionNum, targetCarIdx, targetLap, lookup.timeMs);
          break;
        }

        this.logger.info(`Jump to fastest lap: record MISS (${lookup.reason}); walking`);

        // The walk (issue #607, repaired in #1203). Fire-and-forget — the
        // press handler returns immediately; the walk ends with the replay
        // playing and writes what it found into the record.
        void this.walkToFastestLap(contextId, targetCarIdx, targetLap, targetSessionNum, {
          carNumberRaw: carNum,
          userId: readUserId(sessionInfo, targetCarIdx),
          subSessionId,
        });
        break;
      }
      case "next-car": {
        // Send the configured keystroke (default: V) so iRacing's own car-ordering
        // drives the cycle. Telemetry-driven selection picks the wrong driver during
        // replay-while-towed, where CamCarIdx reflects the live field.
        void this.tapBinding(NEXT_CAR_BINDING_KEY);
        this.logger.info("Next car executed (keystroke)");
        break;
      }
      case "prev-car": {
        void this.tapBinding(PREV_CAR_BINDING_KEY);
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
        // Skip cars that left the world (#885) — switching to one is silently
        // ignored by iRacing and would dead-loop the cycle on the same target.
        const carNum = findAdjacentCarByNumber(sessionInfo, camCarIdx, navDirection, carInWorld(telemetry));

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

  private executeDialDown(contextId: string, settings: ReplayControlSettings): void {
    const replay = getCommands().replay;
    const { mode } = settings;

    if (mode === "speed-increase" || mode === "speed-decrease") {
      // Speed modes: encoder push resets to normal speed
      this.cancelFastestLapWalk(mode);
      const success = replay.play();
      this.setLocalSpeed(1, false);
      this.logger.info("Speed reset to normal");
      this.logger.debug(`Result: ${success}`);
      this.updateAllTelemetryDisplays();
    } else if (mode === "play-pause" || mode === "play-backward") {
      this.executeMode(contextId, settings);
    } else if (mode === "set-speed") {
      this.executeMode(contextId, settings);
    } else if (mode === "speed-display") {
      // No action for speed display
    } else if (DIRECTIONAL_PAIRS[mode]) {
      this.executeMode(contextId, settings);
    } else if (mode === "jump-to-beginning" || mode === "jump-to-live") {
      this.executeMode(contextId, settings);
    } else if (mode === "jump-to-my-car") {
      this.executeMode(contextId, settings);
    } else if (mode === "jump-to-fastest-lap") {
      // Single-shot jump — no meaningful encoder push semantic.
    } else {
      // Transport modes: encoder push plays
      this.cancelFastestLapWalk(mode);
      const success = replay.play();
      this.setLocalSpeed(1, false);
      this.logger.info("Play executed (dial)");
      this.logger.debug(`Result: ${success}`);
      this.updateAllTelemetryDisplays();
    }
  }

  private executeDialRotate(contextId: string, mode: ReplayControlMode, ticks: number): void {
    // A zero-tick rotate carries no direction; every branch below reads
    // `ticks > 0` as clockwise and anything else as counter-clockwise, so
    // without this guard a 0 would silently dispatch the counter-clockwise
    // half (the same guard the camera dial surface applies).
    if (ticks === 0) return;

    const replay = getCommands().replay;

    if (mode === "jump-to-fastest-lap") {
      // Single-shot jump — rotation has no meaningful semantic.
      return;
    }

    if (mode === "speed-increase" || mode === "speed-decrease") {
      // Speed modes: rotate adjusts speed progressively
      const adjustedMode: ReplayControlMode = ticks > 0 ? "speed-increase" : "speed-decrease";
      this.executeMode(contextId, {
        mode: adjustedMode,
        speed: "1",
        stepRate: 1,
        fastestLapTarget: "viewed-car",
        flagsOverlay: false,
        addedWithVersion: "0.0.0",
      });
    } else if (DIRECTIONAL_PAIRS[mode]) {
      const pair = DIRECTIONAL_PAIRS[mode]!;
      const nav = ticks > 0 ? pair.clockwise : pair.counterClockwise;
      this.executeMode("__dial__", {
        mode: nav,
        speed: "1",
        stepRate: 1,
        fastestLapTarget: "viewed-car",
        flagsOverlay: false,
        addedWithVersion: "0.0.0",
      });
    } else if (mode === "jump-to-beginning" || mode === "jump-to-live") {
      this.cancelFastestLapWalk(mode);

      if (ticks > 0) {
        replay.nextIncident();
        this.logger.info("Next incident (dial)");
      } else {
        replay.prevIncident();
        this.logger.info("Previous incident (dial)");
      }
    } else if (mode === "jump-to-my-car") {
      // Rotate cycles next/prev car on track. A camera switch mid-walk would
      // point iRacing's camera-relative lap-search at another car, so it
      // cancels the walk like a cursor command does.
      this.cancelFastestLapWalk(mode);
      const direction = ticks > 0 ? "ahead" : "behind";
      const carIdx = this.findAdjacentCarOnTrack(direction);

      if (carIdx === null) {
        this.logger.warn("No adjacent car found on track (dial)");
      } else {
        const carNum = this.getCarNumberRawByIdx(carIdx);

        if (carNum === null) {
          this.logger.warn("Could not find car number for adjacent car (dial)");
        } else {
          const camera = getCommands().camera;
          camera.switchNum(carNum, 0, 0);
          this.logger.info(ticks > 0 ? "Next car (dial)" : "Previous car (dial)");
        }
      }
    } else {
      // Transport modes: rotate does frame step
      this.cancelFastestLapWalk(mode);

      if (ticks > 0) {
        replay.nextFrame();
        this.logger.info("Frame forward (dial)");
      } else {
        replay.prevFrame();
        this.logger.info("Frame backward (dial)");
      }
    }
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<ReplayControlSettings> | IDeckDidReceiveSettingsEvent<ReplayControlSettings>,
    settings: ReplayControlSettings,
  ): Promise<void> {
    const isPlaying = this.shouldShowPause(ev.action.id);
    const speed = this.replaySpeed.get(ev.action.id);
    const slowMo = this.replaySlowMotion.get(ev.action.id);
    const bindingMissing = this.isBindingMissing(KEYSTROKE_MODES[settings.mode]);
    const svgDataUri = generateReplayControlSvg(settings, isPlaying, speed, slowMo, bindingMissing);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () =>
      generateReplayControlSvg(
        settings,
        isPlaying,
        speed,
        slowMo,
        this.isBindingMissing(KEYSTROKE_MODES[settings.mode]),
      ),
    );
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

    const isPlaying = this.shouldShowPause(contextId);
    const speed = this.replaySpeed.get(contextId) ?? 0;
    const slowMo = this.replaySlowMotion.get(contextId) ?? false;
    const bo = settings.borderOverrides;
    const borderKey = `${bo?.enabled ?? ""}|${bo?.borderWidth ?? ""}|${bo?.borderColor ?? ""}|${bo?.glowEnabled ?? ""}|${bo?.glowWidth ?? ""}`;
    const stateKey = `${settings.mode}:${speed}:${slowMo}:${borderKey}`;

    if (this.lastState.get(contextId) === stateKey) return;

    this.lastState.set(contextId, stateKey);

    const bindingMissing = this.isBindingMissing(KEYSTROKE_MODES[settings.mode]);
    const svgDataUri = generateReplayControlSvg(settings, isPlaying, speed, slowMo, bindingMissing);
    await this.updateKeyImage(contextId, svgDataUri);
    this.setRegenerateCallback(contextId, () =>
      generateReplayControlSvg(
        settings,
        isPlaying,
        speed,
        slowMo,
        this.isBindingMissing(KEYSTROKE_MODES[settings.mode]),
      ),
    );
  }
}
