import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  KeyUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import fastForwardIconSvg from "@iracedeck/icons/replay-control/fast-forward.svg";
import frameBackwardIconSvg from "@iracedeck/icons/replay-control/frame-backward.svg";
import frameForwardIconSvg from "@iracedeck/icons/replay-control/frame-forward.svg";
import jumpToBeginningIconSvg from "@iracedeck/icons/replay-control/jump-to-beginning.svg";
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
import slowMotionIconSvg from "@iracedeck/icons/replay-control/slow-motion.svg";
import speedDecreaseIconSvg from "@iracedeck/icons/replay-control/speed-decrease.svg";
import speedDisplayIconSvg from "@iracedeck/icons/replay-control/speed-display.svg";
import speedIncreaseIconSvg from "@iracedeck/icons/replay-control/speed-increase.svg";
import stopIconSvg from "@iracedeck/icons/replay-control/stop.svg";
import { getAllCarNumbers, getCarNumberFromSessionInfo, type TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import {
  CommonSettings,
  ConnectionStateAwareAction,
  createSDLogger,
  getCommands,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";

const REPLAY_CONTROL_MODES = [
  "play-pause",
  "play-backward",
  "stop",
  "fast-forward",
  "rewind",
  "slow-motion",
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
  "next-car": nextCarIconSvg,
  "prev-car": prevCarIconSvg,
  "next-car-number": nextCarNumberIconSvg,
  "prev-car-number": prevCarNumberIconSvg,
};

const REPLAY_CONTROL_LABELS: Record<ReplayControlMode, { mainLabel: string; subLabel: string }> = {
  "play-pause": { mainLabel: "PLAY", subLabel: "FORWARD" },
  "play-backward": { mainLabel: "PLAY", subLabel: "BACKWARD" },
  stop: { mainLabel: "STOP", subLabel: "" },
  "fast-forward": { mainLabel: "FORWARD", subLabel: "FAST" },
  rewind: { mainLabel: "REWIND", subLabel: "" },
  "slow-motion": { mainLabel: "MOTION", subLabel: "SLOW" },
  "frame-forward": { mainLabel: "FRAME FWD", subLabel: "" },
  "frame-backward": { mainLabel: "FRAME BACK", subLabel: "" },
  "speed-increase": { mainLabel: "FASTER", subLabel: "REPLAY" },
  "speed-decrease": { mainLabel: "SLOWER", subLabel: "REPLAY" },
  "set-speed": { mainLabel: "", subLabel: "SET SPEED" },
  "speed-display": { mainLabel: "SPEED", subLabel: "REPLAY" },
  "next-session": { mainLabel: "NEXT", subLabel: "SESSION" },
  "prev-session": { mainLabel: "PREVIOUS", subLabel: "SESSION" },
  "next-lap": { mainLabel: "LAP", subLabel: "NEXT" },
  "prev-lap": { mainLabel: "LAP", subLabel: "PREVIOUS" },
  "next-incident": { mainLabel: "NEXT", subLabel: "INCIDENT" },
  "prev-incident": { mainLabel: "PREVIOUS", subLabel: "INCIDENT" },
  "jump-to-beginning": { mainLabel: "BEGINNING", subLabel: "JUMP TO" },
  "jump-to-live": { mainLabel: "LIVE", subLabel: "JUMP TO" },
  "jump-to-my-car": { mainLabel: "MY CAR", subLabel: "JUMP TO" },
  "next-car": { mainLabel: "NEXT", subLabel: "CAR" },
  "prev-car": { mainLabel: "PREVIOUS", subLabel: "CAR" },
  "next-car-number": { mainLabel: "NEXT", subLabel: "CAR #" },
  "prev-car-number": { mainLabel: "PREVIOUS", subLabel: "CAR #" },
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
  "frame-forward",
  "frame-backward",
  "speed-increase",
  "speed-decrease",
]);

const LONG_PRESS_INITIAL_DELAY = 500;
const LONG_PRESS_REPEAT_INTERVAL = 250;

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
  settings: { mode: ReplayControlMode; speed?: string },
  isPlaying?: boolean,
  replaySpeed?: number,
  replaySlowMotion?: boolean,
): string {
  const { mode } = settings;

  let iconSvg = REPLAY_CONTROL_ICONS[mode] || REPLAY_CONTROL_ICONS["play-pause"];
  const labels = REPLAY_CONTROL_LABELS[mode] || REPLAY_CONTROL_LABELS["play-pause"];

  let mainLabel = labels.mainLabel;
  let subLabel = labels.subLabel;
  const templateData: Record<string, string> = {};

  if ((mode === "play-pause" || mode === "play-backward") && isPlaying) {
    iconSvg = pauseIconSvg;
    mainLabel = "PAUSE";
    subLabel = "";
  } else if (mode === "speed-display") {
    const speed = replaySpeed ?? 0;
    const slowMo = replaySlowMotion ?? false;
    templateData.speedText = formatSpeedDisplay(speed, slowMo);
  } else if (mode === "set-speed" && settings.speed) {
    mainLabel = formatSetSpeedLabel(settings.speed);
    templateData.needleAngle = String(calculateNeedleAngle(settings.speed));
  }

  templateData.mainLabel = mainLabel;
  templateData.subLabel = subLabel;

  const svg = renderIconTemplate(iconSvg, templateData);

  return svgToDataUri(svg);
}

/**
 * @internal Exported for testing
 *
 * Find the nearest car on track ahead or behind the currently viewed car (CamCarIdx).
 * Uses CarIdxLapCompleted + CarIdxLapDistPct for track progress.
 * Skips inactive cars (lap < 0) and cars on pit road.
 */
export function findAdjacentCarOnTrack(telemetry: TelemetryData | null, direction: "ahead" | "behind"): number | null {
  if (!telemetry?.CarIdxLapCompleted || !telemetry?.CarIdxLapDistPct) return null;

  const camCarIdx = (telemetry.CamCarIdx as number) ?? -1;

  if (camCarIdx < 0) return null;

  const lapCompleted = telemetry.CarIdxLapCompleted as number[];
  const lapDistPct = telemetry.CarIdxLapDistPct as number[];
  const onPitRoad = telemetry.CarIdxOnPitRoad as boolean[] | undefined;

  // Build sorted list of active on-track cars by track progress
  const activeCars: Array<{ carIdx: number; progress: number }> = [];

  for (let idx = 0; idx < lapCompleted.length; idx++) {
    if (lapCompleted[idx] === undefined || lapCompleted[idx] < 0) continue;

    if (onPitRoad?.[idx]) continue;

    if (lapDistPct[idx] === undefined || lapDistPct[idx] < 0) continue;

    const progress = lapCompleted[idx] + lapDistPct[idx];
    activeCars.push({ carIdx: idx, progress });
  }

  // Sort by progress descending (highest first = most laps/distance)
  activeCars.sort((a, b) => b.progress - a.progress);

  const currentIndex = activeCars.findIndex((c) => c.carIdx === camCarIdx);

  if (currentIndex === -1) return null;

  if (direction === "ahead") {
    // Car ahead = higher progress = lower index in sorted array (wraps around)
    const aheadIndex = currentIndex === 0 ? activeCars.length - 1 : currentIndex - 1;

    return activeCars[aheadIndex].carIdx;
  } else {
    // Car behind = lower progress = higher index in sorted array (wraps around)
    const behindIndex = currentIndex === activeCars.length - 1 ? 0 : currentIndex + 1;

    return activeCars[behindIndex].carIdx;
  }
}

/**
 * @internal Exported for testing
 *
 * Find the next or previous car by car number order.
 * Includes all cars (even in pits), skips the pace car.
 * Returns the car number to switch to, or null if not found.
 */
export function findAdjacentCarByNumber(
  sessionInfo: unknown,
  currentCarIdx: number,
  direction: "next" | "prev",
): number | null {
  const allCars = getAllCarNumbers(sessionInfo, true);

  if (allCars.length === 0) return null;

  const currentCarNumber = getCarNumberFromSessionInfo(sessionInfo, currentCarIdx);
  const fallback = direction === "next" ? allCars[0].carNumber : allCars[allCars.length - 1].carNumber;

  if (currentCarNumber === null) {
    return fallback;
  }

  const currentIndex = allCars.findIndex((c) => c.carNumber === currentCarNumber);

  if (currentIndex === -1) {
    return fallback;
  }

  if (direction === "next") {
    const nextIndex = (currentIndex + 1) % allCars.length;

    return allCars[nextIndex].carNumber;
  } else {
    const prevIndex = (currentIndex - 1 + allCars.length) % allCars.length;

    return allCars[prevIndex].carNumber;
  }
}

const ReplayControlSettings = CommonSettings.extend({
  mode: z.enum(REPLAY_CONTROL_MODES).default("play-pause"),
  speed: z.string().default("1"),
});

type ReplayControlSettings = z.infer<typeof ReplayControlSettings>;

/**
 * Replay Control
 * Unified replay action combining transport, speed, and navigation controls.
 * Provides progressive speed control for fast-forward, rewind, and slow-motion,
 * with speed memory across pause/resume and telemetry-driven display.
 */
@action({ UUID: "com.iracedeck.sd.core.replay-control" })
export class ReplayControl extends ConnectionStateAwareAction<ReplayControlSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("ReplayControl"), LogLevel.Info);

  /** Current replay speed from telemetry, keyed by action context ID */
  private replaySpeed = new Map<string, number>();

  /** Current slow-motion state from telemetry, keyed by action context ID */
  private replaySlowMotion = new Map<string, boolean>();

  /** Speed stored when pausing, restored on play (global, not per-context) */
  private pausedSpeed: { speed: number; slowMotion: boolean } | null = null;

  /** Active long-press repeat timers, keyed by action context ID */
  private repeatTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Cached settings per context for telemetry-driven display updates */
  private activeContexts = new Map<string, ReplayControlSettings>();

  /** Last rendered state key per context (prevents redundant re-renders) */
  private lastState = new Map<string, string>();

  override async onWillAppear(ev: WillAppearEvent<ReplayControlSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);

    // Seed initial state from current telemetry
    const current = this.sdkController.getCurrentTelemetry();
    this.seedTelemetryState(ev.action.id, current);

    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry: TelemetryData | null) => {
      this.updateConnectionState();
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

  override async onWillDisappear(ev: WillDisappearEvent<ReplayControlSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.replaySpeed.delete(ev.action.id);
    this.replaySlowMotion.delete(ev.action.id);
    this.stopRepeat(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ReplayControlSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<ReplayControlSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeMode(ev.action.id, settings);

    if (LONG_PRESS_REPEAT_MODES.has(settings.mode)) {
      this.startRepeat(ev.action.id, settings);
    }
  }

  override async onKeyUp(ev: KeyUpEvent<ReplayControlSettings>): Promise<void> {
    this.stopRepeat(ev.action.id);
  }

  override async onDialDown(ev: DialDownEvent<ReplayControlSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeDialDown(ev.action.id, settings);
  }

  override async onDialRotate(ev: DialRotateEvent<ReplayControlSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeDialRotate(ev.action.id, settings.mode, ev.payload.ticks);
  }

  private startRepeat(contextId: string, settings: ReplayControlSettings): void {
    this.stopRepeat(contextId);

    const timer = setTimeout(() => {
      this.executeMode(contextId, settings);

      const interval = setInterval(() => {
        this.executeMode(contextId, settings);
      }, LONG_PRESS_REPEAT_INTERVAL);

      this.repeatTimers.set(contextId, interval);
    }, LONG_PRESS_INITIAL_DELAY);

    this.repeatTimers.set(contextId, timer);
  }

  private stopRepeat(contextId: string): void {
    const timer = this.repeatTimers.get(contextId);

    if (timer) {
      clearTimeout(timer);
      clearInterval(timer);
      this.repeatTimers.delete(contextId);
    }
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
    if (!telemetry) return;

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
   * Determines if the play-pause/play-backward icon should show PAUSE.
   * Play-pause shows PAUSE when playing forward; play-backward shows PAUSE when playing backward.
   */
  private shouldShowPause(contextId: string, mode: ReplayControlMode): boolean {
    const speed = this.replaySpeed.get(contextId) ?? 0;

    if (mode === "play-pause") return speed > 0;

    if (mode === "play-backward") return speed < 0;

    return speed !== 0;
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

  private getCarNumberByIdx(carIdx: number): number | null {
    const sessionInfo = this.sdkController.getSessionInfo();

    return getCarNumberFromSessionInfo(sessionInfo, carIdx);
  }

  private findAdjacentCarOnTrack(direction: "ahead" | "behind"): number | null {
    const telemetry = this.sdkController.getCurrentTelemetry();

    return findAdjacentCarOnTrack(telemetry, direction);
  }

  private executeMode(contextId: string, settings: ReplayControlSettings): void {
    const replay = getCommands().replay;
    const { mode } = settings;

    switch (mode) {
      case "play-pause": {
        const current = this.getCurrentSpeed();

        if (current.speed > 0) {
          // Playing forward (any speed) → pause, remember slow-mo speeds
          if (current.slowMotion) {
            this.pausedSpeed = current;
          }

          const success = replay.pause();
          this.setLocalSpeed(0, false);
          this.logger.info("Pause executed");
          this.logger.debug(`Result: ${success}, stored speed: ${current.speed}`);
        } else if (current.speed === 0) {
          // Paused → play forward, restore slow-motion speed or 1x
          const stored = this.pausedSpeed;
          let success: boolean;

          if (stored) {
            success = replay.setPlaySpeed(stored.speed, stored.slowMotion);
            this.setLocalSpeed(stored.speed, stored.slowMotion);
            this.logger.info("Play executed with restored speed");
            this.logger.debug(`Result: ${success}, speed: ${stored.speed}, slowMotion: ${stored.slowMotion}`);
          } else {
            success = replay.play();
            this.setLocalSpeed(1, false);
            this.logger.info("Play executed");
            this.logger.debug(`Result: ${success}`);
          }

          this.pausedSpeed = null;
        } else if (current.slowMotion) {
          // Slow-mo backward → mirror to forward slow-mo
          const mirroredSpeed = Math.abs(current.speed);
          const success = replay.setPlaySpeed(mirroredSpeed, true);
          this.setLocalSpeed(mirroredSpeed, true);
          this.logger.info("Play executed (mirrored slow-mo)");
          this.logger.debug(`Result: ${success}, speed: ${mirroredSpeed}`);
        } else {
          // Rewind/backward at non-slow-mo → reset to 1x
          const success = replay.play();
          this.setLocalSpeed(1, false);
          this.logger.info("Play executed (reset to 1x)");
          this.logger.debug(`Result: ${success}, was speed: ${current.speed}`);
        }

        break;
      }
      case "play-backward": {
        const current = this.getCurrentSpeed();

        if (current.speed < 0) {
          // Playing backward (any speed) → pause, remember slow-mo speeds
          if (current.slowMotion) {
            this.pausedSpeed = current;
          }

          const success = replay.pause();
          this.setLocalSpeed(0, false);
          this.logger.info("Pause backward executed");
          this.logger.debug(`Result: ${success}, stored speed: ${current.speed}`);
        } else if (current.speed === 0) {
          // Paused → play backward, restore slow-motion reverse speed or -1x
          const stored = this.pausedSpeed;
          let success: boolean;

          if (stored) {
            success = replay.setPlaySpeed(stored.speed, stored.slowMotion);
            this.setLocalSpeed(stored.speed, stored.slowMotion);
            this.logger.info("Play backward executed with restored speed");
            this.logger.debug(`Result: ${success}, speed: ${stored.speed}, slowMotion: ${stored.slowMotion}`);
          } else {
            success = replay.setPlaySpeed(-1);
            this.setLocalSpeed(-1, false);
            this.logger.info("Play backward executed");
            this.logger.debug(`Result: ${success}`);
          }

          this.pausedSpeed = null;
        } else if (current.slowMotion) {
          // Slow-mo forward → mirror to backward slow-mo
          const mirroredSpeed = -Math.abs(current.speed);
          const success = replay.setPlaySpeed(mirroredSpeed, true);
          this.setLocalSpeed(mirroredSpeed, true);
          this.logger.info("Play backward executed (mirrored slow-mo)");
          this.logger.debug(`Result: ${success}, speed: ${mirroredSpeed}`);
        } else {
          // FF/forward at non-slow-mo → reset to -1x
          const success = replay.setPlaySpeed(-1);
          this.setLocalSpeed(-1, false);
          this.logger.info("Play backward executed (reset to -1x)");
          this.logger.debug(`Result: ${success}, was speed: ${current.speed}`);
        }

        break;
      }
      case "stop": {
        const success = replay.pause();
        this.setLocalSpeed(0, false);
        this.pausedSpeed = null;
        this.logger.info("Stop executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "fast-forward": {
        const current = this.getCurrentSpeed();
        let nextSpeed: number;

        if (!current.slowMotion && current.speed >= 2) {
          nextSpeed = Math.min(current.speed + 1, 16);
        } else {
          nextSpeed = 2;
        }

        const success = replay.setPlaySpeed(nextSpeed);
        this.setLocalSpeed(nextSpeed, false);
        this.logger.info("Fast forward executed");
        this.logger.debug(`Result: ${success}, speed: ${nextSpeed}`);
        break;
      }
      case "rewind": {
        const current = this.getCurrentSpeed();
        let nextSpeed: number;

        if (!current.slowMotion && current.speed <= -2) {
          nextSpeed = Math.max(current.speed - 1, -16);
        } else {
          nextSpeed = -2;
        }

        const success = replay.setPlaySpeed(nextSpeed);
        this.setLocalSpeed(nextSpeed, false);
        this.logger.info("Rewind executed");
        this.logger.debug(`Result: ${success}, speed: ${nextSpeed}`);
        break;
      }
      case "slow-motion": {
        const success = replay.setPlaySpeed(2, true);
        this.setLocalSpeed(2, true);
        this.logger.info("Slow motion executed");
        this.logger.debug(`Result: ${success}`);
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

        const carNum = this.getCarNumberByIdx(driverCarIdx);

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
      case "next-car": {
        const nextCarIdx = this.findAdjacentCarOnTrack("ahead");

        if (nextCarIdx === null) {
          this.logger.warn("No car found ahead on track");
          break;
        }

        const nextCarNum = this.getCarNumberByIdx(nextCarIdx);

        if (nextCarNum === null) {
          this.logger.warn("Could not find car number for next car");
          break;
        }

        const camera = getCommands().camera;
        const success = camera.switchNum(nextCarNum, 0, 0);
        this.logger.info("Next car executed");
        this.logger.debug(`Result: ${success}, carNum: ${nextCarNum}`);
        break;
      }
      case "prev-car": {
        const prevCarIdx = this.findAdjacentCarOnTrack("behind");

        if (prevCarIdx === null) {
          this.logger.warn("No car found behind on track");
          break;
        }

        const prevCarNum = this.getCarNumberByIdx(prevCarIdx);

        if (prevCarNum === null) {
          this.logger.warn("Could not find car number for previous car");
          break;
        }

        const camera = getCommands().camera;
        const success = camera.switchNum(prevCarNum, 0, 0);
        this.logger.info("Previous car executed");
        this.logger.debug(`Result: ${success}, carNum: ${prevCarNum}`);
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
  }

  private executeDialDown(contextId: string, settings: ReplayControlSettings): void {
    const replay = getCommands().replay;
    const { mode } = settings;

    if (mode === "speed-increase" || mode === "speed-decrease") {
      // Speed modes: encoder push resets to normal speed
      const success = replay.play();
      this.logger.info("Speed reset to normal");
      this.logger.debug(`Result: ${success}`);
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
    } else {
      // Transport modes: encoder push plays
      const success = replay.play();
      this.logger.info("Play executed (dial)");
      this.logger.debug(`Result: ${success}`);
    }
  }

  private executeDialRotate(contextId: string, mode: ReplayControlMode, ticks: number): void {
    const replay = getCommands().replay;

    if (mode === "speed-increase" || mode === "speed-decrease") {
      // Speed modes: rotate adjusts speed progressively
      const adjustedMode: ReplayControlMode = ticks > 0 ? "speed-increase" : "speed-decrease";
      this.executeMode(contextId, { mode: adjustedMode, speed: "1", flagsOverlay: false });
    } else if (DIRECTIONAL_PAIRS[mode]) {
      const pair = DIRECTIONAL_PAIRS[mode]!;
      const nav = ticks > 0 ? pair.next : pair.prev;
      this.executeMode("__dial__", { mode: nav, speed: "1", flagsOverlay: false });
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
        const carNum = this.getCarNumberByIdx(carIdx);

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
    ev: WillAppearEvent<ReplayControlSettings> | DidReceiveSettingsEvent<ReplayControlSettings>,
    settings: ReplayControlSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const isPlaying = this.shouldShowPause(ev.action.id, settings.mode);
    const speed = this.replaySpeed.get(ev.action.id);
    const slowMo = this.replaySlowMotion.get(ev.action.id);
    const svgDataUri = generateReplayControlSvg(settings, isPlaying, speed, slowMo);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }

  private async updateDisplayFromTelemetry(contextId: string, settings: ReplayControlSettings): Promise<void> {
    if (!TELEMETRY_DISPLAY_MODES.has(settings.mode)) return;

    const isPlaying = this.shouldShowPause(contextId, settings.mode);
    const speed = this.replaySpeed.get(contextId) ?? 0;
    const slowMo = this.replaySlowMotion.get(contextId) ?? false;
    const stateKey = `${settings.mode}:${speed}:${slowMo}`;

    if (this.lastState.get(contextId) === stateKey) return;

    this.lastState.set(contextId, stateKey);

    const svgDataUri = generateReplayControlSvg(settings, isPlaying, speed, slowMo);
    await this.updateKeyImage(contextId, svgDataUri);
  }
}
