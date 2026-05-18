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
  getCarNumberFromSessionInfo,
  getCarNumberRawFromSessionInfo,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import z from "zod";

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
 * Safety cap on iterations the adaptive lap walker performs in a single
 * press. Combined with `REPLAY_LAP_SEARCH_GAP_MS`, this bounds the worst-case
 * wall-clock time at MAX × GAP. Each iteration reads telemetry first, so a
 * normal delta finishes in `delta + a-few-retries` iterations; the cap only
 * trips on a pathological scenario.
 */
const MAX_LAP_SEARCH_STEPS = 150;

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
 * Consecutive iterations the adaptive walker tolerates without the cursor
 * advancing before giving up. Covers the case where the cursor is at a
 * session boundary or the target lap is unreachable in the current replay
 * buffer.
 */
const LAP_WALK_STUCK_LIMIT = 5;

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

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
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
    | Record<string, unknown>
    | undefined;
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
 */
export function findAdjacentCarByNumber(
  sessionInfo: unknown,
  currentCarIdx: number,
  direction: "next" | "prev",
): number | null {
  const allCars = getAllCarNumbers(sessionInfo, true);

  if (allCars.length === 0) return null;

  const currentCarNumber = getCarNumberFromSessionInfo(sessionInfo, currentCarIdx);
  const fallbackCar = direction === "next" ? allCars[0] : allCars[allCars.length - 1];

  if (currentCarNumber === null) {
    return fallbackCar.carNumberRaw;
  }

  const currentIndex = allCars.findIndex((c) => c.carNumber === currentCarNumber);

  if (currentIndex === -1) {
    return fallbackCar.carNumberRaw;
  }

  if (direction === "next") {
    const nextIndex = (currentIndex + 1) % allCars.length;

    return allCars[nextIndex].carNumberRaw;
  } else {
    const prevIndex = (currentIndex - 1 + allCars.length) % allCars.length;

    return allCars[prevIndex].carNumberRaw;
  }
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
   * Adaptive walker that drives the replay cursor to a target lap for a
   * specific car. Reads `CarIdxLap[carIdx]` between each step and re-sends
   * `nextLap`/`prevLap` when the cursor didn't advance — that recovers from
   * iRacing dropping individual `ReplaySearch` broadcasts (the failure mode
   * fixed-spacing bursts had at every tested gap, including 100 ms). Bails
   * when the cursor sits still for {@link LAP_WALK_STUCK_LIMIT} consecutive
   * iterations (e.g. target lap is outside the replay buffer) or when
   * iterations reach {@link MAX_LAP_SEARCH_STEPS}. Only one walk per context
   * runs at a time; second presses while one is in flight are ignored.
   */
  async walkToFastestLap(contextId: string, carIdx: number, targetLap: number): Promise<void> {
    if (this.fastestLapWalkInFlight.has(contextId)) {
      this.logger.debug(`Jump to fastest lap: walk already in flight for ${contextId}; ignoring`);

      return;
    }

    this.fastestLapWalkInFlight.add(contextId);

    try {
      const replay = getCommands().replay;
      let attempts = 0;
      let lastObservedLap: number | null = null;
      let stuckCount = 0;

      while (attempts++ < MAX_LAP_SEARCH_STEPS) {
        const telemetry = this.sdkController.getCurrentTelemetry();
        const currentLaps = telemetry?.CarIdxLap as number[] | undefined;
        const currentLap = currentLaps?.[carIdx];

        if (typeof currentLap !== "number" || currentLap < 0) {
          this.logger.debug(`Jump to fastest lap: bail, CarIdxLap[${carIdx}] is unavailable`);

          return;
        }

        if (currentLap === targetLap) {
          this.logger.debug(`Jump to fastest lap: reached lap ${targetLap} after ${attempts} iterations`);

          return;
        }

        // Detect the cursor not advancing — either a session-edge condition
        // or the replay buffer doesn't reach the target lap.
        if (lastObservedLap !== null && currentLap === lastObservedLap) {
          stuckCount++;

          if (stuckCount >= LAP_WALK_STUCK_LIMIT) {
            this.logger.warn(`Jump to fastest lap: cursor stuck at lap ${currentLap} (target ${targetLap}); giving up`);

            return;
          }
        } else {
          stuckCount = 0;
        }

        lastObservedLap = currentLap;

        if (currentLap < targetLap) {
          replay.nextLap();
        } else {
          replay.prevLap();
        }

        // Read the gap live on every iteration so a user can drag the slider
        // mid-walk and have the next step pick up the new value.
        const gapMs = readFastestLapSearchDelayMs();
        await new Promise<void>((resolve) => setTimeout(resolve, gapMs));
      }

      this.logger.warn(
        `Jump to fastest lap: safety cap hit (${MAX_LAP_SEARCH_STEPS} iterations) at lap ${lastObservedLap}, target ${targetLap}`,
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

        if (targetCarIdx < 0) {
          this.logger.warn("No target car available for jump to fastest lap");
          this.logger.debug(`Target setting: ${settings.fastestLapTarget}`);
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

        getCommands().camera.switchNum(carNum, 0, 0);

        // iRacing's nextLap jumps to the *end* of the targeted lap (=start of
        // the lap after it). Subtract one so the cursor lands at the start of
        // the fastest lap, not at its end.
        const walkTargetLap = targetLap - 1;

        // Adaptive lap walk: read CarIdxLap between steps and re-send when the
        // cursor didn't advance. iRacing's broadcast queue drops fixed-spacing
        // bursts (observed at 50 / 100 ms in live testing), so polling between
        // steps is the only reliable way to converge on the target lap.
        // Fire-and-forget — the press handler returns immediately.
        void this.walkToFastestLap(contextId, targetCarIdx, walkTargetLap);

        this.logger.info("Jump to fastest lap executed");
        this.logger.debug(`Target carIdx: ${targetCarIdx}, fastest lap: ${targetLap}, walker target: ${walkTargetLap}`);
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
    const svgDataUri = generateReplayControlSvg(settings, isPlaying, speed, slowMo);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateReplayControlSvg(settings, isPlaying, speed, slowMo));
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

    const svgDataUri = generateReplayControlSvg(settings, isPlaying, speed, slowMo);
    await this.updateKeyImage(contextId, svgDataUri);
    this.setRegenerateCallback(contextId, () => generateReplayControlSvg(settings, isPlaying, speed, slowMo));
  }
}
