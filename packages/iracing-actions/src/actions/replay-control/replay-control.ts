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
  ICON_BASE_TEMPLATE,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
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
  findNearestCarOnTrack,
  getAllCarNumbers,
  getCarNumberRawFromSessionInfo,
  ReplayPosMode,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import z from "zod";

import { carPresence, computeCarNumberTarget } from "../../shared/car-cycling.js";
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
 * Directional pairs for encoder rotation support.
 * Modes in this map support clockwise=next / counter-clockwise=prev.
 */
const DIRECTIONAL_PAIRS: Partial<Record<ReplayControlMode, { next: ReplayControlMode; prev: ReplayControlMode }>> = {
  "next-session": { next: "next-session", prev: "prev-session" },
  "prev-session": { next: "next-session", prev: "prev-session" },
  "next-lap": { next: "next-lap", prev: "prev-lap" },
  "prev-lap": { next: "next-lap", prev: "prev-lap" },
  "next-incident": { next: "next-incident", prev: "prev-incident" },
  "prev-incident": { next: "next-incident", prev: "prev-incident" },
  "next-car": { next: "next-car", prev: "prev-car" },
  "prev-car": { next: "next-car", prev: "prev-car" },
  "next-car-number": { next: "next-car-number", prev: "prev-car-number" },
  "prev-car-number": { next: "next-car-number", prev: "prev-car-number" },
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

// Issue #607 follow-up #3: live testing showed that bisecting on the whole
// replay buffer doesn't reliably find the fastest lap when the target lap
// sits in a non-current session (e.g. user in race trying to find quali's
// fastest). Replaced the buffer-wide bisection with a three-phase walk:
//
//   1. Session map. On the first walk per `SessionUniqueID`, navigate
//      `goToStart` → `nextSession` × N → `goToEnd`, recording the start
//      frame of each session and the buffer's end frame. Cached at module
//      scope and reused for every subsequent walk on the same replay.
//   2. Bisect within the target session's bounds (looked up from the cache)
//      until `CarIdxLap[carIdx]` is within `CLOSE_ENOUGH_LAPS` of the target
//      — much faster than the prior whole-buffer bisection, and immune to
//      cross-session lap-number weirdness.
//   3. Lap-step refinement: `nextLap` / `prevLap` until `CarIdxLap[carIdx]
//      === targetLap`. iRacing's lap-step lands at a clean lap boundary, so
//      no backstep is needed to land at the start of the fastest lap.

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
 * One session's frame bounds within the replay buffer. `endFrame` for the
 * LAST session is the buffer's live edge at the time of the map build —
 * it can lag the true live edge if the replay keeps growing, but the
 * fastest lap typically sits well inside the recorded window anyway.
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
  /**
   * Per-car cache of the final cursor frame for a `(carIdx, targetLap,
   * sessionNum)` triple. Populated at the end of every successful walk;
   * subsequent presses with the same triple jump straight to the cached
   * frame with a single `setPlayPosition`, skipping the bisection +
   * lap-step + nudge + tick-back phases. Stale entries (when the car
   * sets a new fastest lap) naturally fall through to a cache miss
   * because the `targetLap` part of the key changes.
   */
  fastestLapFrames: Map<string, number>;
};

function fastestLapCacheKey(carIdx: number, targetLap: number, targetSessionNum: number): string {
  return `${carIdx}|${targetLap}|${targetSessionNum}`;
}

/**
 * Module-level cache of the session map. Reused whenever the current walk's
 * `SessionUniqueID` is one of the IDs we observed while building, so a
 * single map covers every session in the race weekend.
 */
let cachedFastestLapSessionMap: FastestLapSessionMap | null = null;

/**
 * @internal Exported for testing — clears the module-level session-map +
 * per-car frame cache so each test starts from a clean slate.
 */
export function _resetFastestLapSessionCache(): void {
  cachedFastestLapSessionMap = null;
}

/**
 * @internal Exported for testing — exposes the current cache state so tests
 * can assert the per-car frame Map contents without poking at module-private
 * variables.
 */
export function _getFastestLapSessionCache(): FastestLapSessionMap | null {
  return cachedFastestLapSessionMap;
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
 * long the bisection waits for telemetry to LEAVE the `SessionNum = -1`
 * transient that iRacing publishes between a `setPlayPosition` broadcast
 * landing and the cursor settling at the new frame (issue #607). The base
 * settle is the configured delay (default 400 ms); the cap is `× 4`, so the
 * worst-case wait per probe is `delay × 4` (default 1.6 s). Observed first-
 * jump transient is ~514 ms after a paused-replay `setPlayPosition`, so this
 * gives plenty of headroom while still keeping the common case fast (one
 * post-poll read after a 50 ms wait).
 */
const STABILIZATION_TIMEOUT_MULTIPLIER = 4;

/**
 * Interval the bisection polls `getCurrentTelemetry()` at while waiting for
 * `SessionNum` to leave the `-1` transient. 50 ms is ~3 sim ticks at 60 Hz
 * — short enough to catch the transition promptly without spinning.
 */
const STABILIZATION_POLL_INTERVAL_MS = 50;

/**
 * Default gap between consecutive replay lap-search broadcasts when the
 * `fastestLapSearchDelayMs` global setting isn't set. Even when the replay
 * is paused, the manual Next Lap / Previous Lap actions exhibit the same
 * drift when pressed in rapid succession: iRacing appears to be resolving
 * the exact lap-boundary position asynchronously after each `ReplaySearch`
 * and a follow-up broadcast that arrives before that work finishes leaves
 * the cursor parked mid-lap. 400 ms is the empirical default that works
 * reliably; slower machines and longer tracks can raise it via Common
 * Settings → Replay → Fastest Lap Search Delay.
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
  const sessionInfoRoot = (sessionInfo as Record<string, unknown> | undefined)?.SessionInfo as
    Record<string, unknown> | undefined;
  const sessions = sessionInfoRoot?.Sessions as Array<Record<string, unknown>> | undefined;

  if (sessions && typeof sessionNum === "number") {
    const session = sessions.find((s) => (s?.SessionNum as number | undefined) === sessionNum);
    const positions = session?.ResultsPositions as Array<Record<string, unknown>> | undefined;
    const entry = positions?.find((p) => (p?.CarIdx as number | undefined) === carIdx);
    const fastestLap = entry?.FastestLap as number | undefined;

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
 * `isPresent` predicate (see `carPresence`) makes it skip cars that are no
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
   * Context IDs with an in-flight jump-to-fastest-lap walk. A second press
   * while one is running is dropped (the in-flight walk is converging on the
   * same target, so re-kicking would just race itself).
   */
  private fastestLapWalkInFlight = new Set<string>();

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

    if (telemetry.ReplayPlaySpeed !== undefined) {
      this.replaySpeed.set(contextId, telemetry.ReplayPlaySpeed as number);
    }

    if (telemetry.ReplayPlaySlowMotion !== undefined) {
      this.replaySlowMotion.set(contextId, telemetry.ReplayPlaySlowMotion as boolean);
    }
  }

  private updateTelemetryState(contextId: string, telemetry: TelemetryData | null): void {
    if (!telemetry) {
      this.replaySpeed.set(contextId, 0);
      this.replaySlowMotion.set(contextId, false);

      return;
    }

    if (telemetry.ReplayPlaySpeed !== undefined) {
      this.replaySpeed.set(contextId, telemetry.ReplayPlaySpeed as number);
    }

    if (telemetry.ReplayPlaySlowMotion !== undefined) {
      this.replaySlowMotion.set(contextId, telemetry.ReplayPlaySlowMotion as boolean);
    }
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
   * @internal Exposed for testing.
   *
   * Drives the replay cursor to the start of the fastest lap for a specific
   * car (issue #607). Three phases:
   *
   *   1. **Session map.** On the first walk per `SessionUniqueID`, build a
   *      cache of session bounds (start frame of each session + buffer's
   *      live edge) by `goToStart` + `nextSession` × N + `goToEnd`.
   *      Subsequent walks within the same replay skip straight to phase 2.
   *   2. **Bisect within target session.** Look up the target session's
   *      [startFrame, endFrame] from the map and bisect with
   *      `setPlayPosition(Begin, mid)` until the player car is within
   *      {@link CLOSE_ENOUGH_LAPS} of the target lap.
   *   3. **Lap-step refinement.** `nextLap` / `prevLap` until
   *      `CarIdxLap[carIdx] === targetLap`. iRacing's lap-step lands at a
   *      clean lap boundary, so the cursor parks at the start of the
   *      fastest lap with no further fix-up.
   *
   * Only one walk per context runs at a time; second presses while one is
   * in flight are ignored.
   */
  async walkToFastestLap(
    contextId: string,
    carIdx: number,
    targetLap: number,
    targetSessionNum: number,
  ): Promise<void> {
    if (this.fastestLapWalkInFlight.has(contextId)) {
      this.logger.debug(`Jump to fastest lap: walk already in flight for ${contextId}; ignoring`);

      return;
    }

    this.fastestLapWalkInFlight.add(contextId);

    try {
      const replay = getCommands().replay;
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

      /**
       * Wait for the base settle gap to elapse, then poll the telemetry until
       * `SessionNum >= 0` — the transient `-1` value iRacing publishes between
       * a search / setPlayPosition broadcast landing and the cursor settling
       * at the new frame (issue #607). Returns the stable telemetry sample or
       * `null` if `SessionNum` never leaves the transient state within
       * `STABILIZATION_TIMEOUT_MULTIPLIER × settle` ms.
       */
      const readStableTelemetry = async (): Promise<TelemetryData | null> => {
        const baseSettleMs = readFastestLapSearchDelayMs();

        await sleep(baseSettleMs);
        const initial = this.sdkController.getCurrentTelemetry();

        if (typeof initial?.SessionNum === "number" && initial.SessionNum >= 0) return initial;

        const deadline = Date.now() + baseSettleMs * (STABILIZATION_TIMEOUT_MULTIPLIER - 1);

        while (Date.now() < deadline) {
          await sleep(STABILIZATION_POLL_INTERVAL_MS);
          const tel = this.sdkController.getCurrentTelemetry();

          if (typeof tel?.SessionNum === "number" && tel.SessionNum >= 0) return tel;
        }

        return null;
      };

      const buildSessionMap = async (): Promise<FastestLapSessionMap | null> => {
        const sessionUniqueIds = new Set<number>();
        const recordUniqueId = (tel: TelemetryData): void => {
          if (typeof tel.SessionUniqueID === "number") sessionUniqueIds.add(tel.SessionUniqueID);
        };

        replay.goToStart();
        const firstTel = await readStableTelemetry();

        if (firstTel == null) {
          this.logger.warn("Jump to fastest lap: telemetry did not stabilize after goToStart; aborting map build");

          return null;
        }

        recordUniqueId(firstTel);
        const firstFrame = firstTel.ReplayFrameNum;
        const firstSession = firstTel.SessionNum;

        if (typeof firstFrame !== "number" || typeof firstSession !== "number") {
          this.logger.warn(
            `Jump to fastest lap: missing fields after goToStart (frame=${firstFrame}, session=${firstSession}); aborting map build`,
          );

          return null;
        }

        const sessions: SessionMapEntry[] = [{ sessionNum: firstSession, startFrame: firstFrame, endFrame: -1 }];
        let lastFrame = firstFrame;
        let lastSession = firstSession;

        for (let i = 0; i < MAX_SESSIONS; i++) {
          replay.nextSession();
          const tel = await readStableTelemetry();

          if (tel == null) {
            this.logger.warn(`Jump to fastest lap: telemetry did not stabilize after nextSession #${i + 1}; aborting`);

            return null;
          }

          recordUniqueId(tel);
          const frame = tel.ReplayFrameNum;
          const session = tel.SessionNum;

          if (typeof frame !== "number" || typeof session !== "number") {
            this.logger.warn("Jump to fastest lap: missing fields after nextSession; aborting map build");

            return null;
          }

          if (session === lastSession || frame === lastFrame) {
            // nextSession was a no-op — we're already in the last session.
            break;
          }

          sessions.push({ sessionNum: session, startFrame: frame, endFrame: -1 });
          lastFrame = frame;
          lastSession = session;
        }

        replay.goToEnd();
        const endTel = await readStableTelemetry();

        if (endTel == null) {
          this.logger.warn("Jump to fastest lap: telemetry did not stabilize after goToEnd; aborting map build");

          return null;
        }

        recordUniqueId(endTel);
        const endFrame = endTel.ReplayFrameNum;

        if (typeof endFrame !== "number") {
          this.logger.warn("Jump to fastest lap: ReplayFrameNum missing after goToEnd; aborting map build");

          return null;
        }

        for (let i = 0; i < sessions.length; i++) {
          sessions[i].endFrame = i + 1 < sessions.length ? sessions[i + 1].startFrame - 1 : endFrame;
        }

        return { sessionUniqueIds, sessions, fastestLapFrames: new Map<string, number>() };
      };

      // Pause first so the cursor doesn't drift between commands and the
      // post-settle telemetry sample. `readStableTelemetry` rides out the
      // ~500 ms SessionNum=-1 transient that the first paused-replay command
      // produces; subsequent commands clear in ~100 ms.
      replay.pause();
      await sleep(readFastestLapSearchDelayMs());

      // Phase 1: session map (cache or build).
      const initialTel = await readStableTelemetry();

      if (initialTel == null) {
        this.logger.warn("Jump to fastest lap: telemetry did not stabilize after pause; aborting");

        return;
      }

      const sessionUniqueId = initialTel.SessionUniqueID;

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

      // Phase 2a: per-car cache check. If we've already walked this
      // (carIdx, targetLap, sessionNum) triple, jump straight to the stored
      // frame — no bisection, no lap-step, no nudge, no tick-back.
      const cacheKey = fastestLapCacheKey(carIdx, targetLap, targetSessionNum);
      const cachedFrame = sessionMap.fastestLapFrames.get(cacheKey);

      if (typeof cachedFrame === "number") {
        this.logger.info(
          `Jump to fastest lap: per-car cache HIT (key=${cacheKey}, frame=${cachedFrame}); using stored frame`,
        );
        replay.setPlayPosition(ReplayPosMode.Begin, cachedFrame);
        await readStableTelemetry();

        return;
      }

      this.logger.info(`Jump to fastest lap: per-car cache MISS (key=${cacheKey}); walking`);

      // Phase 2b: look up target session bounds.
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
      // pressing Play immediately shows the line-crossing into the fast lap.
      const targetLapMinus1 = Math.max(0, targetLap - 1);

      // Phase 3: bisect within the target session until we're within
      // CLOSE_ENOUGH_LAPS of the lap-before-fastest.
      let bisectionSteps = 0;

      for (let step = 0; step < MAX_BISECTION_STEPS; step++) {
        if (hiFrame - loFrame <= 1) break;

        const mid = Math.floor((loFrame + hiFrame) / 2);

        replay.setPlayPosition(ReplayPosMode.Begin, mid);
        const tel = await readStableTelemetry();

        bisectionSteps = step + 1;

        if (tel == null) {
          this.logger.warn(
            `Jump to fastest lap: telemetry did not stabilize at frame ${mid} (bisection step ${step}); aborting`,
          );

          return;
        }

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

      // Phase 4: lap-step until we're on the lap-before-fastest.
      let lapSteps = 0;

      for (let step = 0; step < MAX_LAP_STEPS; step++) {
        const tel = await readStableTelemetry();

        if (tel == null) {
          this.logger.warn(`Jump to fastest lap: telemetry did not stabilize during lap-step ${step}; aborting`);

          return;
        }

        const lap = (tel.CarIdxLap as number[] | undefined)?.[carIdx];

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

        if (lap < targetLapMinus1) replay.nextLap();
        else replay.prevLap();

        lapSteps = step + 1;
      }

      // Phase 5: dist refinement. We're on the right lap but maybe not at
      // the end. If dist < 0.999, press nextLap to advance to the end; if
      // that overshoots into the next lap, press prevLap to come back.
      const refineTel = await readStableTelemetry();
      const refineLap = (refineTel?.CarIdxLap as number[] | undefined)?.[carIdx];
      const refineDist = (refineTel?.CarIdxLapDistPct as number[] | undefined)?.[carIdx];
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
        replay.nextLap();
        nudges++;

        const afterTel = await readStableTelemetry();
        const afterLap = (afterTel?.CarIdxLap as number[] | undefined)?.[carIdx];

        if (typeof afterLap === "number" && afterLap > targetLapMinus1) {
          this.logger.debug(`Jump to fastest lap: nextLap overshot to lap=${afterLap}; recovering via prevLap`);
          replay.prevLap();
          nudges++;
          await readStableTelemetry();
        }
      }

      // Phase 6: single absolute-frame back-step. Read the current frame,
      // jump to `frame - FASTEST_LAP_FINAL_BACKSTEP_TICKS` in one broadcast.
      const preBackstepTel = await readStableTelemetry();
      const preBackstepFrame = preBackstepTel?.ReplayFrameNum;

      if (typeof preBackstepFrame === "number") {
        const targetFrame = Math.max(0, preBackstepFrame - FASTEST_LAP_FINAL_BACKSTEP_TICKS);

        replay.setPlayPosition(ReplayPosMode.Begin, targetFrame);
        await readStableTelemetry();
      }

      // Final report + store the landed frame in the per-car cache so the
      // next press for this (carIdx, targetLap, sessionNum) triple hits.
      const finalTel = await readStableTelemetry();
      const finalLap = (finalTel?.CarIdxLap as number[] | undefined)?.[carIdx];
      const finalDist = (finalTel?.CarIdxLapDistPct as number[] | undefined)?.[carIdx];
      const finalFrame = finalTel?.ReplayFrameNum;

      if (typeof finalFrame === "number") {
        sessionMap.fastestLapFrames.set(cacheKey, finalFrame);
        this.logger.debug(`Jump to fastest lap: stored per-car cache entry (key=${cacheKey}, frame=${finalFrame})`);
      }

      this.logger.debug(
        `Jump to fastest lap: converged after ${bisectionSteps} bisection + ${lapSteps} lap-step + ${nudges} nudge iterations + ${FASTEST_LAP_FINAL_BACKSTEP_TICKS}-tick back-step (lap=${finalLap}, dist=${typeof finalDist === "number" ? finalDist.toFixed(4) : "n/a"}, target=${targetLap}, session=${targetSessionNum})`,
      );
    } finally {
      this.fastestLapWalkInFlight.delete(contextId);
    }
  }

  private executeMode(contextId: string, settings: ReplayControlSettings): void {
    const replay = getCommands().replay;
    const { mode } = settings;

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
          nextSpeed = Math.min(current.speed + step, 16);
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
          nextSpeed = Math.max(current.speed - step, -16);
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

        // Switch the replay camera onto the target car so iRacing's lap-search
        // operates against the right driver. For viewed-car this is usually a
        // no-op (camera is already there); for always-my-car it actively
        // re-frames before the lap walk.
        const carNum = this.getCarNumberRawByIdx(targetCarIdx);

        if (carNum === null) {
          this.logger.warn("Could not find car number for jump-to-fastest-lap target");
          break;
        }

        const cameraSwitched = getCommands().camera.switchNum(carNum, 0, 0);

        if (!cameraSwitched) {
          // The walker depends on the camera being on the right car (iRacing's
          // lap-search is camera-focus-relative). If the SDK refused, abort
          // rather than burn the retry budget walking the wrong driver.
          this.logger.warn("Jump to fastest lap: camera switch failed, aborting walk");
          this.logger.debug(`Failed switchNum: carNum=${carNum}, carIdx=${targetCarIdx}`);
          break;
        }

        // Resolve the session at dispatch time so the bisection narrows to
        // the right session in a multi-session replay (practice + qualifying
        // + race). `findFastestLapForCar` already used the same `SessionNum`
        // to look the lap number up.
        const targetSessionNum = typeof telemetry?.SessionNum === "number" ? telemetry.SessionNum : 0;

        // Frame-based bisection (issue #607). Pauses the replay, brackets the
        // buffer with toStart/toEnd, then binary-searches by absolute frame
        // until the cursor lands at the start of `targetLap` for `targetCarIdx`
        // within `targetSessionNum`. Fire-and-forget — the press handler
        // returns immediately.
        void this.walkToFastestLap(contextId, targetCarIdx, targetLap, targetSessionNum);

        this.logger.info("Jump to fastest lap executed");
        this.logger.debug(`Target carIdx: ${targetCarIdx}, fastest lap: ${targetLap}, session: ${targetSessionNum}`);
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
        const carNum = findAdjacentCarByNumber(sessionInfo, camCarIdx, navDirection, carPresence(telemetry));

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
      const success = replay.play();
      this.setLocalSpeed(1, false);
      this.logger.info("Play executed (dial)");
      this.logger.debug(`Result: ${success}`);
      this.updateAllTelemetryDisplays();
    }
  }

  private executeDialRotate(contextId: string, mode: ReplayControlMode, ticks: number): void {
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
      const nav = ticks > 0 ? pair.next : pair.prev;
      this.executeMode("__dial__", {
        mode: nav,
        speed: "1",
        stepRate: 1,
        fastestLapTarget: "viewed-car",
        flagsOverlay: false,
        addedWithVersion: "0.0.0",
      });
    } else if (mode === "jump-to-beginning" || mode === "jump-to-live") {
      if (ticks > 0) {
        replay.nextIncident();
        this.logger.info("Next incident (dial)");
      } else {
        replay.prevIncident();
        this.logger.info("Previous incident (dial)");
      }
    } else if (mode === "jump-to-my-car") {
      // Rotate cycles next/prev car on track
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
