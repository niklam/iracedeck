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
import {
  beginReplayJump,
  canJumpToRaceStart,
  describeReplayJump,
  findRecordStep,
  formatSpeedDisplay,
  isRaceStartUnavailable,
  LAP_START_APPROACH_FRAMES,
  lastListedSessionNum,
  noteTelemetrySpeed,
  observeIncidentSearch,
  onReplaySpeedChanged,
  parseSpeedSetting,
  pressJumpToFastestLap,
  pressJumpToRaceStart,
  pressReplayCommand,
  readSubSessionId,
  RECORD_STEPS,
  type RecordStepMode,
  type RecordStepSource,
  type ReplayGateCommand,
  type ReplayPressResult,
  type ReplaySpeed,
  requestCameraSwitch,
  resolveReplayWalkStart,
  runJumpToFrame,
  shownReplaySpeed,
} from "@iracedeck/replay-engine";
import { getReplaySessionStore, isReplaySessionStoreInitialized } from "@iracedeck/replay-store";
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
} from "../../shared/replay-busy-indicator.js";
import { replayBusyKeyMark, replayBusyMarkKey } from "../../shared/replay-busy-mark.js";
import { unavailableLook } from "../../shared/unavailable-look.js";
import { replayControlDialField } from "./replay-control-dial-settings.js";
import { ReplayControlDialSurface } from "./replay-control-dial-surface.js";

// The speed text helpers moved to their own module so the dial surface shares
// them (#1316); re-exported so this module's API is unchanged.
export { formatSpeedDisplay, parseSpeedSetting } from "@iracedeck/replay-engine";

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

// Jump to Fastest Lap — the press, its record jump and its walk — and Jump to
// Race Start — the press, its record jumps and its search — are the replay
// engine's (#1467: `fastest-lap-press.ts`, `race-start-press.ts`,
// `lap-walk.ts`), and so is the machinery the two lap presses share
// (`lap-press.ts`): the one in-flight slot, the camera wait and the jump to a
// frame.

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
 * `assembleIcon` decides for the modes it draws. Set Speed, assembled here by
 * hand, draws the same mark in the same place. Speed Display sends no replay
 * command and never registers with the indicator, so it draws no mark.
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
 * The busy mark for the icon assembled by hand (Set Speed): in
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
 * they stay outside the replay command gate (#1430). Each goes through the
 * engine's one camera-switch waiter (#1467), which cancels a lap walk
 * searching on the camera's car and nothing else, and holds the switch behind
 * a position jump under way.
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
    // The keypad's own Jump to Live, cursor take and replay-state note included, under the dial's
    // token so its box shows the busy look (#1437).
    jumpToLive: (origin) => this.executeMode(origin, this.parseSettings({ mode: "jump-to-live" })),
    // The keypad's own Jump to Race Start press (#1354), guards and fallback included.
    jumpToRaceStart: (origin) => this.executeMode(origin, this.parseSettings({ mode: "jump-to-race-start" })),
    canJumpToRaceStart: () => canJumpToRaceStart(),
    // The keypad's Jump to My Car switch (#801), the bare send: the dial's gesture
    // hands it to the engine's camera-switch waiter, as the key does (#1467).
    jumpToMyCar: () => this.switchToMyCar(),
    canJumpToMyCar: () => "carNum" in this.resolveMyCarNumberRaw(),
    refreshKeys: () => this.updateAllTelemetryDisplays(),
    // What the Lap and Session modes step from and through (#801): the same
    // reads, and the same record source, as the keypad's record step.
    replayState: (nowMs) => this.sdkController.getReplayState(nowMs),
    sessionInfo: () => this.sdkController.getSessionInfo(),
    recordSource: (telemetry) => this.recordStepSource(telemetry),
    // The Track Order mode's binding (#801). Never `setActiveBinding`: its readiness
    // state is one value per action instance, and a dial's would bleed onto the
    // keys; `isBindingMissing` is stateless.
    tapBinding: (settingKey) => this.tapBinding(settingKey),
    isBindingMissing: (keys) => this.isBindingMissing(keys),
  });

  /**
   * The keys redraw on every speed the engine records as sent (#1467): a
   * slot dispatch, a search's pause or speed, a walk's or a jump's pause, a
   * press. A paused replay may deliver no tick, so a tick cannot be what
   * redraws them; a key whose icon would not change is skipped. For the
   * action's life, like the dial surface's own subscription.
   */
  private readonly speedSubscription = onReplaySpeedChanged(() => this.updateAllTelemetryDisplays());

  /**
   * The replay speed telemetry carried in this synchronous turn, or null when
   * none has been read in it (#1467). A fresh read decodes every telemetry
   * variable, and one turn draws many keys — the busy indicator's frame
   * redraws every working key, and each registration runs its regenerate
   * there and then — so the turn reads once and every draw in it shares the
   * sample. A tick seeds it with its own reading. It lapses at the turn's end:
   * the next turn reads afresh, since a paused replay may deliver no tick.
   * Only the sample is shared; the speed shown over it is resolved on every
   * draw, so a speed sent or held earlier in the turn still shows.
   */
  private turnSpeedSample: { readonly speed: ReplaySpeed | null } | null = null;

  /**
   * Per Jump to Race Start context: whether the key shows the unavailable
   * look, and the session info it was judged from. iRacing republishes the
   * session YAML only when something in it changed, so a tick usually compares
   * one reference and stops.
   */
  private raceStartShown = new Map<string, { sessionInfo: unknown; unavailable: boolean }>();

  override async onWillAppear(ev: IDeckWillAppearEvent<ReplayControlSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      const contextId = ev.action.id;

      await this.dialSurface.willAppear(ev.action, settings.dial);
      // A dial joins the telemetry subscription, but never the key contexts:
      // it has no key icon and no binding.
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

    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry: TelemetryData | null) => {
      const speed = this.holdTickSpeed(telemetry);

      this.rememberReplaySpeed(telemetry, speed);

      const storedSettings = this.activeContexts.get(ev.action.id);

      // The speed is the engine's one record over this tick's reading — the
      // tick is the fresh read, so it costs no telemetry read of its own; the
      // redraw is skipped when the key would draw what it already shows.
      if (storedSettings && TELEMETRY_DISPLAY_MODES.has(storedSettings.mode)) {
        this.updateDisplayFromTelemetry(ev.action.id, storedSettings, this.getCurrentSpeed(speed));
      }

      this.refreshRaceStartAvailability(ev.action.id);
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<ReplayControlSettings>): Promise<void> {
    this.repeat.clear(ev.action.id);
    this.dialSurface.willDisappear(ev.action.id);
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
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
   * for both uses: the speed Play/Pause resumes, and the dial's own screen,
   * which is handed the tick so comparing its frame costs no telemetry read
   * and redraws only on a change.
   */
  private onDialTelemetry(contextId: string, telemetry: TelemetryData | null): void {
    const speed = this.holdTickSpeed(telemetry);

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

  /**
   * Determines if the replay is currently playing (not paused).
   * Uses ReplayPlaySpeed rather than IsReplayPlaying, because IsReplayPlaying
   * indicates "sim is in replay mode" and stays true even when paused.
   */
  private isCurrentlyPlaying(): boolean {
    return this.getCurrentSpeed().speed !== 0;
  }

  /**
   * Determines if the play-pause/play-backward icon should show the PAUSE icon.
   * Shows PAUSE when playing in any direction (forward or backward).
   */
  private shouldShowPause(current = this.getCurrentSpeed()): boolean {
    return current.speed !== 0;
  }

  private buildTelemetryStateKey(current = this.getCurrentSpeed()): string {
    return `${current.speed}:${current.slowMotion}`;
  }

  /**
   * The replay speed the keys show and step from (#1467): the engine's one
   * record of it (`shownReplaySpeed`) — a speed the gate holds, else what was
   * just sent, else what telemetry carries — in the units the user sees: in
   * slow motion the speed is the divisor (5 = 1/5x), decoded from iRacing's
   * raw value (#1202). Over this turn's reading ({@link telemetrySpeedNow}), as
   * the dial's, never the last tick delivered: a paused replay may deliver
   * none. A tick's handler passes the tick's speed, which is that reading. No
   * telemetry reads as paused.
   */
  private getCurrentSpeed(telemetrySpeed: ReplaySpeed | null = this.telemetrySpeedNow()): ReplaySpeed {
    return shownReplaySpeed(telemetrySpeed, Date.now());
  }

  /** The replay speed telemetry carries this turn: a fresh read at the turn's first ask, shared by the rest of it. */
  private telemetrySpeedNow(): ReplaySpeed | null {
    if (this.turnSpeedSample !== null) return this.turnSpeedSample.speed;

    const telemetry = this.sdkController.getCurrentTelemetry();

    return this.holdTurnSpeed(telemetry ? replaySpeedFromTelemetry(telemetry) : null);
  }

  /** A tick's speed, decoded once: the tick is this turn's fresh reading, so the turn's draws share it. */
  private holdTickSpeed(telemetry: TelemetryData | null): ReplaySpeed | null {
    return this.holdTurnSpeed(telemetry ? replaySpeedFromTelemetry(telemetry) : null);
  }

  /** Keeps `speed` as this turn's sample until the turn ends. */
  private holdTurnSpeed(speed: ReplaySpeed | null): ReplaySpeed | null {
    const lapseQueued = this.turnSpeedSample !== null;

    this.turnSpeedSample = { speed };

    if (!lapseQueued) {
      queueMicrotask(() => {
        this.turnSpeedSample = null;
      });
    }

    return speed;
  }

  private getCarNumberRawByIdx(carIdx: number): number | null {
    const sessionInfo = this.sdkController.getSessionInfo();

    return getCarNumberRawFromSessionInfo(sessionInfo, carIdx);
  }

  /**
   * The player's car for Jump to My Car: its raw number for the camera
   * switch, or why there is none. Shared by the press and the dial's hold
   * preview of it (#801), so the preview promises only what the press does.
   */
  private resolveMyCarNumberRaw(): { carNum: number } | { miss: string } {
    const sessionInfo = this.sdkController.getSessionInfo();
    const driverInfo = (sessionInfo as Record<string, unknown>)?.DriverInfo as Record<string, unknown> | undefined;
    const driverCarIdx = (driverInfo?.DriverCarIdx as number) ?? -1;

    if (driverCarIdx < 0) return { miss: "No session info available for jump to my car" };

    const carNum = this.getCarNumberRawByIdx(driverCarIdx);

    return carNum === null ? { miss: "Could not find car number for player" } : { carNum };
  }

  /**
   * The camera to the player's car: Jump to My Car's switch, which takes no
   * cursor of its own. The key and the dial's gesture (#801) both hand it to
   * the engine's camera-switch waiter, which has cancelled only the two walks
   * before it runs (#1467). With no player's car, or no number for it, it
   * warns and sends nothing.
   */
  private switchToMyCar(): void {
    const myCar = this.resolveMyCarNumberRaw();

    if ("miss" in myCar) {
      this.logger.warn(myCar.miss);

      return;
    }

    const { carNum } = myCar;
    const camera = getCommands().camera;
    const success = camera.switchNum(carNum, 0, 0);
    this.logger.info("Jump to my car executed");
    this.logger.debug(`Result: ${success}, carNum: ${carNum}`);
  }

  /**
   * A camera or car key's switch (#1467, Decision 3 of the replay engine
   * spec): through the engine's one camera-switch waiter, as the dial's Track
   * Order turn and Jump to My Car gesture go. It cancels a lap walk searching
   * on the camera's car, naming the mode, and no other cursor owner — a
   * marker or record jump keeps its claim; the walk observes the cancel at its
   * next await. On a quiet replay `send` runs at once; behind a position jump
   * it waits for the landing as the one switch that waits for the whole
   * plugin, and is dropped if the wait gives up, or if by then the key has
   * left the screen or the replay has been left.
   */
  private requestKeyCameraSwitch(contextId: string, mode: ReplayControlMode, name: string, send: () => unknown): void {
    // The waiter logs a send that fails and never rejects for one.
    void requestCameraSwitch(send, {
      by: mode,
      label: "Replay control",
      name,
      asked: `${mode} pressed`,
      surface: "the key",
      stillValid: () => this.activeContexts.has(contextId) && this.sdkController.getReplayState().inReplay,
      logger: this.logger,
    });
  }

  /**
   * Next / Previous Car (Number Order)'s switch: the car beside the one on
   * camera when it goes out, by car number. With no camera car, or none
   * beside it, it warns and sends nothing.
   */
  private switchToAdjacentCarNumber(navDirection: "next" | "prev"): void {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const camCarIdx = (telemetry?.CamCarIdx as number) ?? -1;

    if (camCarIdx < 0) {
      this.logger.warn("No camera target available for car number navigation");

      return;
    }

    const sessionInfo = this.sdkController.getSessionInfo();
    // Every car the session has had, departed ones included (#1281).
    const carNum = findAdjacentCarByNumber(sessionInfo, camCarIdx, navDirection);

    if (carNum === null) {
      this.logger.warn("Could not find adjacent car by number");

      return;
    }

    const camera = getCommands().camera;
    const success = camera.switchNum(carNum, 0, 0);
    this.logger.info("Car number navigation executed");
    this.logger.debug(`Direction: ${navDirection}, carNum: ${carNum}, result: ${success}`);
  }

  /**
   * One Next / Previous Lap or Next / Previous Session press (#1426): a step
   * through the record (`replay-record-step.ts`), measured from where the
   * replay is headed, else the cursor (`replay-engine`'s `replay-record-walk.ts`).
   *
   * - **Outside a replay** nothing is sent: iRacing honours replay commands
   *   only out of the car. A standing target is a start either way
   *   (`resolveReplayWalkStart`).
   * - **No cursor** to step from — no standing target, and a tick still
   *   reading mid-seek once the exit grace is over (a seek not of the
   *   plugin's, or a rest state whose flag reads false in a saved replay) —
   *   is a miss like the record's own: a step from there would send the
   *   list's first entry, so the key's search goes instead, through the gate,
   *   which holds it while a seek shows.
   * - **A hit** is one waited record jump to the landing frame
   *   (`beginReplayJump` at the press, its frame recorded as the target before
   *   its pause, then `runReplayJump`, `jump.end()` in a `finally`), carrying
   *   this key's origin token. Claiming the cursor cancels a Jump to Fastest
   *   Lap walk in flight. No camera switch: a lap list is the viewed car's, a
   *   session belongs to everyone. The speeds the jump sends reach the keys
   *   through the engine's speed state (`onReplaySpeedChanged`).
   * - **A miss** sends iRacing's own search through the gate, as the key did
   *   before, with its origin token: the gate holds it behind a jump or a
   *   search of the plugin's that is still under way.
   */
  private pressRecordStep(
    contextId: string,
    mode: RecordStepMode,
    press: (command: ReplayGateCommand) => ReplayPressResult,
  ): void {
    const step = RECORD_STEPS[mode];
    const now = Date.now();
    const telemetry = this.sdkController.getCurrentTelemetry();
    const start = resolveReplayWalkStart(this.sdkController.getReplayState(now), telemetry, now);

    if (start.frame === null && start.reason === "not in a replay") {
      this.logger.debug(`${step.label}: ${start.reason}; nothing sent`);

      return;
    }

    /** A miss sends the key's own search through the gate, as the key did before. */
    const searchOnMiss = (reason: string): void => {
      this.logger.info(`${step.label} executed`);
      this.logger.debug(`${step.label}: record MISS (${reason})`);
      this.logger.debug(`Result: ${pressResult(press({ kind: "search", search: step.search }))}`);
    };

    if (start.frame === null) {
      searchOnMiss(start.reason);

      return;
    }

    const anchor = start.frame;
    const found = findRecordStep(step, anchor, this.recordStepSource(telemetry));

    if (!found.hit) {
      searchOnMiss(found.reason);

      return;
    }

    this.logger.info(`${step.label} executed`);

    const { frame } = found;

    this.logger.debug(`${step.label}: record HIT (${found.what}); from ${start.from} frame ${anchor} to ${frame}`);

    const jump = beginReplayJump(`replay-control-${mode}`, telemetry, undefined, now, { frame, origin: contextId });

    void (async () => {
      try {
        const outcome = await runJumpToFrame(jump, { frame, label: step.label });

        // A jump that stopped short was logged by `runJumpToFrame`.
        if (outcome.kind !== "stopped") {
          this.logger.debug(`${step.label}: ${describeReplayJump(outcome, frame).detail}`);
        }
      } catch (error) {
        this.logger.error(`${step.label}: jump failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        jump.end();
      }
    })();
  }

  /**
   * What a record step reads (#1426) besides its anchor, with the camera car
   * from `telemetry`: the store, the SubSessionID scope, the car numbers, the
   * lap approach and the event's last session, from the session info the SDK
   * holds now. The one source behind the keypad's Next / Previous Lap and
   * Session and the dial's Lap and Session modes (#801).
   */
  private recordStepSource(telemetry: TelemetryData | null): RecordStepSource {
    const sessionInfo = this.sdkController.getSessionInfo();
    const subSessionId = readSubSessionId(sessionInfo);

    return {
      store: isReplaySessionStoreInitialized() ? getReplaySessionStore() : null,
      scope: subSessionId === undefined ? undefined : { subSessionId },
      camCarIdx: telemetry?.CamCarIdx,
      carNumberRaw: (carIdx) => this.getCarNumberRawByIdx(carIdx),
      lapApproachFrames: LAP_START_APPROACH_FRAMES,
      lastSessionNum: lastListedSessionNum(sessionInfo),
    };
  }

  private executeMode(contextId: string, settings: ReplayControlSettings, repeat = false): void {
    const { mode } = settings;

    // Every replay command goes through the replay command gate (#1430),
    // which takes the replay cursor from an in-flight walk or jump itself and
    // decides whether the command goes out now, waits for the jump under way
    // to land, or is not sent. The camera and car keys send no replay command:
    // they go through the engine's camera-switch waiter (#1467), which stops
    // only a lap walk searching on the camera's car. A fastest-lap or
    // green-flag press takes the cursor itself, once its guards have passed:
    // a press that is ignored must not cancel the one in flight.

    /** One press through the gate, named for the mode and this key's context. */
    const press = (command: ReplayGateCommand): ReplayPressResult =>
      pressReplayCommand(command, { by: mode, origin: contextId, repeat });

    switch (mode) {
      case "play-pause": {
        const current = this.getCurrentSpeed();

        if (current.speed !== 0) {
          // Any non-zero speed → pause
          const success = pressResult(press({ kind: "pause" }));
          this.logger.info("Pause executed");
          this.logger.debug(`Result: ${success}, was speed: ${current.speed}`);
        } else {
          // Paused → play forward at 1x
          const success = pressResult(press({ kind: "speed", speed: 1, slowMotion: false, send: (r) => r.play() }));
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
          this.logger.info("Pause backward executed");
          this.logger.debug(`Result: ${success}, was speed: ${current.speed}`);
        } else {
          // Paused → play backward at -1x
          const success = pressResult(press({ kind: "speed", speed: -1, slowMotion: false }));
          this.logger.info("Play backward executed");
          this.logger.debug(`Result: ${success}`);
        }

        break;
      }
      case "stop": {
        const success = pressResult(press({ kind: "pause" }));
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
          this.logger.debug(`Speed increase: slow-mo 1/${absSpeed}x -> 1/${next}x`);
        } else if (current.slowMotion && absSpeed <= 2) {
          success = pressResult(press({ kind: "speed", speed: sign, slowMotion: false }));
          this.logger.debug(`Speed increase: exiting slow-mo to ${sign}x`);
        } else if (absSpeed === 0) {
          success = pressResult(press({ kind: "speed", speed: 1, slowMotion: false, send: (r) => r.play() }));
          this.logger.debug("Speed increase: from paused to 1x");
        } else if (absSpeed < 16) {
          success = pressResult(press({ kind: "speed", speed: (absSpeed + 1) * sign, slowMotion: false }));
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
          this.logger.debug(`Speed decrease: slow-mo 1/${absSpeed}x -> 1/${next}x`);
        } else if (current.slowMotion) {
          this.logger.debug("Speed decrease: already at min slow-mo speed");
          break;
        } else if (absSpeed === 0) {
          success = pressResult(press({ kind: "speed", speed: 2, slowMotion: true }));
          this.logger.debug("Speed decrease: from paused to 1/2x");
        } else if (absSpeed > 1) {
          success = pressResult(press({ kind: "speed", speed: (absSpeed - 1) * sign, slowMotion: false }));
          this.logger.debug(`Speed decrease: ${current.speed}x -> ${(absSpeed - 1) * sign}x`);
        } else {
          success = pressResult(press({ kind: "speed", speed: 2 * sign, slowMotion: true }));
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
        this.logger.info("Set speed executed");
        this.logger.debug(`Result: ${success}, speed: ${speed}, slowMotion: ${slowMotion}`);
        break;
      }
      case "speed-display": {
        // Read-only display — no action on press
        this.logger.debug("Speed display pressed — no action");
        break;
      }
      case "next-session":
      case "prev-session":
      case "next-lap":
      case "prev-lap": {
        // A step through the record, with iRacing's search behind a miss (#1426).
        this.pressRecordStep(contextId, mode, press);
        break;
      }
      case "next-incident":
      case "prev-incident": {
        const label = mode === "next-incident" ? "Next incident" : "Previous incident";
        const telemetry = this.sdkController.getCurrentTelemetry();
        const at = {
          label,
          frame: this.sdkController.getReplayState().frame,
          camCarIdx: typeof telemetry?.CamCarIdx === "number" ? telemetry.CamCarIdx : null,
        };
        const result = press({ kind: "search", search: mode === "next-incident" ? "nextIncident" : "prevIncident" });

        this.logger.info(`${label} executed`);
        this.logger.debug(`Result: ${pressResult(result)}`);
        // Where the search lands against the recorded incidents, at debug (#1426). It sends nothing.
        void observeIncidentSearch(result, at, {
          logger: this.logger,
          readTelemetry: () => this.sdkController.getCurrentTelemetry(),
          listIncidents: () => {
            if (!isReplaySessionStoreInitialized()) return { hit: false, reason: "no store" };

            const subSessionId = readSubSessionId(this.sdkController.getSessionInfo());

            return getReplaySessionStore().incidents.list(subSessionId === undefined ? undefined : { subSessionId });
          },
        });
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
        this.requestKeyCameraSwitch(contextId, mode, "my car", () => this.switchToMyCar());
        break;
      }
      case "jump-to-fastest-lap": {
        // The whole press is the replay engine's (#1467): its guards, the
        // record jump and the walk. The engine cannot reach the replay busy
        // indicator, so a press ignored behind one in flight is reported here.
        const result = pressJumpToFastestLap({ origin: contextId, target: settings.fastestLapTarget });

        if (result.kind === "ignored") reportReplayPressIgnored(contextId);

        break;
      }
      case "jump-to-race-start": {
        // The whole press is the replay engine's (#1467): its guards, the
        // record jumps and the search. The key and the dial's gesture both
        // press here, and a press ignored behind one in flight is reported to
        // the replay busy indicator, which the engine cannot reach.
        const result = pressJumpToRaceStart({ origin: contextId });

        if (result.kind === "ignored") reportReplayPressIgnored(contextId);

        break;
      }
      case "next-car": {
        // Send the configured keystroke (default: V) so iRacing's own car-ordering
        // drives the cycle. Telemetry-driven selection picks the wrong driver during
        // replay-while-towed, where CamCarIdx reflects the live field.
        this.requestKeyCameraSwitch(contextId, mode, "next car", () => {
          const tapped = this.tapBinding(CAR_CYCLE_BINDING_KEYS.next);

          this.logger.info("Next car executed (keystroke)");

          return tapped;
        });
        break;
      }
      case "prev-car": {
        this.requestKeyCameraSwitch(contextId, mode, "previous car", () => {
          const tapped = this.tapBinding(CAR_CYCLE_BINDING_KEYS.previous);

          this.logger.info("Previous car executed (keystroke)");

          return tapped;
        });
        break;
      }
      case "next-car-number":
      case "prev-car-number": {
        const navDirection = mode === "next-car-number" ? "next" : "prev";

        // The target is read from the camera when the switch goes out, not at
        // the press: behind a jump the camera may be on another car by then.
        this.requestKeyCameraSwitch(
          contextId,
          mode,
          navDirection === "next" ? "next car number" : "previous car number",
          () => this.switchToAdjacentCarNumber(navDirection),
        );
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
    current = this.getCurrentSpeed(),
  ): string {
    return generateReplayControlSvg(
      settings,
      this.shouldShowPause(current),
      current.speed,
      current.slowMotion,
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

    const current = this.getCurrentSpeed();

    if (TELEMETRY_DISPLAY_MODES.has(settings.mode)) {
      this.lastState.set(contextId, this.telemetryDisplayKey(settings, replayBusyKeyMark(look), current));
    }

    void this.updateKeyImage(contextId, this.keySvg(contextId, settings, look, current));
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

  /** Redraws every key whose icon follows the speed, from one read of it. */
  private updateAllTelemetryDisplays(): void {
    let current: { speed: number; slowMotion: boolean } | undefined;

    for (const [contextId, settings] of this.activeContexts) {
      if (TELEMETRY_DISPLAY_MODES.has(settings.mode)) {
        current ??= this.getCurrentSpeed();
        this.updateDisplayFromTelemetry(contextId, settings, current);
      }
    }
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    settings: ReplayControlSettings,
    current = this.getCurrentSpeed(),
  ): Promise<void> {
    if (!TELEMETRY_DISPLAY_MODES.has(settings.mode)) return;

    const look = getReplayBusyLook(contextId);
    const stateKey = this.telemetryDisplayKey(settings, replayBusyKeyMark(look), current);

    if (this.lastState.get(contextId) === stateKey) return;

    this.lastState.set(contextId, stateKey);

    const svgDataUri = this.keySvg(contextId, settings, look, current);
    await this.updateKeyImage(contextId, svgDataUri);
    this.setRegenerateCallback(contextId, () => this.keySvg(contextId, settings));
  }

  /**
   * What a telemetry-driven key last drew, for its redraw de-duplication: the
   * mode, the replay speed, the border overrides and the busy mark (#1437), so
   * a look that changed is never mistaken for the icon already on the key.
   */
  private telemetryDisplayKey(
    settings: ReplayControlSettings,
    mark: BusyMark | undefined,
    current = this.getCurrentSpeed(),
  ): string {
    const bo = settings.borderOverrides;
    const borderKey = `${bo?.enabled ?? ""}|${bo?.borderWidth ?? ""}|${bo?.borderColor ?? ""}|${bo?.glowEnabled ?? ""}|${bo?.glowWidth ?? ""}`;

    return `${settings.mode}:${this.buildTelemetryStateKey(current)}:${borderKey}:${replayBusyMarkKey(mark)}`;
  }
}
