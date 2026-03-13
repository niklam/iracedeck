import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import fastForwardIconSvg from "@iracedeck/icons/replay-control/fast-forward.svg";
import frameBackwardIconSvg from "@iracedeck/icons/replay-control/frame-backward.svg";
import frameForwardIconSvg from "@iracedeck/icons/replay-control/frame-forward.svg";
import jumpToBeginningIconSvg from "@iracedeck/icons/replay-control/jump-to-beginning.svg";
import jumpToLiveIconSvg from "@iracedeck/icons/replay-control/jump-to-live.svg";
import nextIncidentIconSvg from "@iracedeck/icons/replay-control/next-incident.svg";
import nextLapIconSvg from "@iracedeck/icons/replay-control/next-lap.svg";
import nextSessionIconSvg from "@iracedeck/icons/replay-control/next-session.svg";
import playPauseIconSvg from "@iracedeck/icons/replay-control/play-pause.svg";
import prevIncidentIconSvg from "@iracedeck/icons/replay-control/prev-incident.svg";
import prevLapIconSvg from "@iracedeck/icons/replay-control/prev-lap.svg";
import prevSessionIconSvg from "@iracedeck/icons/replay-control/prev-session.svg";
import rewindIconSvg from "@iracedeck/icons/replay-control/rewind.svg";
import slowMotionIconSvg from "@iracedeck/icons/replay-control/slow-motion.svg";
import speedDecreaseIconSvg from "@iracedeck/icons/replay-control/speed-decrease.svg";
import speedIncreaseIconSvg from "@iracedeck/icons/replay-control/speed-increase.svg";
import stopIconSvg from "@iracedeck/icons/replay-control/stop.svg";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
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
  "stop",
  "fast-forward",
  "rewind",
  "slow-motion",
  "frame-forward",
  "frame-backward",
  "speed-increase",
  "speed-decrease",
  "next-session",
  "prev-session",
  "next-lap",
  "prev-lap",
  "next-incident",
  "prev-incident",
  "jump-to-beginning",
  "jump-to-live",
] as const;

type ReplayControlMode = (typeof REPLAY_CONTROL_MODES)[number];

const REPLAY_CONTROL_ICONS: Record<ReplayControlMode, string> = {
  "play-pause": playPauseIconSvg,
  stop: stopIconSvg,
  "fast-forward": fastForwardIconSvg,
  rewind: rewindIconSvg,
  "slow-motion": slowMotionIconSvg,
  "frame-forward": frameForwardIconSvg,
  "frame-backward": frameBackwardIconSvg,
  "speed-increase": speedIncreaseIconSvg,
  "speed-decrease": speedDecreaseIconSvg,
  "next-session": nextSessionIconSvg,
  "prev-session": prevSessionIconSvg,
  "next-lap": nextLapIconSvg,
  "prev-lap": prevLapIconSvg,
  "next-incident": nextIncidentIconSvg,
  "prev-incident": prevIncidentIconSvg,
  "jump-to-beginning": jumpToBeginningIconSvg,
  "jump-to-live": jumpToLiveIconSvg,
};

const REPLAY_CONTROL_LABELS: Record<ReplayControlMode, { mainLabel: string; subLabel: string }> = {
  "play-pause": { mainLabel: "PLAY", subLabel: "" },
  stop: { mainLabel: "STOP", subLabel: "" },
  "fast-forward": { mainLabel: "FORWARD", subLabel: "FAST" },
  rewind: { mainLabel: "REWIND", subLabel: "" },
  "slow-motion": { mainLabel: "MOTION", subLabel: "SLOW" },
  "frame-forward": { mainLabel: "FRAME FWD", subLabel: "" },
  "frame-backward": { mainLabel: "FRAME BACK", subLabel: "" },
  "speed-increase": { mainLabel: "FASTER", subLabel: "REPLAY" },
  "speed-decrease": { mainLabel: "SLOWER", subLabel: "REPLAY" },
  "next-session": { mainLabel: "NEXT", subLabel: "SESSION" },
  "prev-session": { mainLabel: "PREVIOUS", subLabel: "SESSION" },
  "next-lap": { mainLabel: "LAP", subLabel: "NEXT" },
  "prev-lap": { mainLabel: "LAP", subLabel: "PREVIOUS" },
  "next-incident": { mainLabel: "NEXT", subLabel: "INCIDENT" },
  "prev-incident": { mainLabel: "PREVIOUS", subLabel: "INCIDENT" },
  "jump-to-beginning": { mainLabel: "BEGINNING", subLabel: "JUMP TO" },
  "jump-to-live": { mainLabel: "LIVE", subLabel: "JUMP TO" },
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
};

const ReplayControlSettings = CommonSettings.extend({
  mode: z.enum(REPLAY_CONTROL_MODES).default("play-pause"),
});

type ReplayControlSettings = z.infer<typeof ReplayControlSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the replay control action.
 * When mode is "play-pause", the label toggles based on isPlaying state.
 */
export function generateReplayControlSvg(settings: { mode: ReplayControlMode }, isPlaying?: boolean): string {
  const { mode } = settings;

  const iconSvg = REPLAY_CONTROL_ICONS[mode] || REPLAY_CONTROL_ICONS["play-pause"];
  const labels = REPLAY_CONTROL_LABELS[mode] || REPLAY_CONTROL_LABELS["play-pause"];

  // For play-pause mode, toggle label based on actual playback state
  const mainLabel = mode === "play-pause" && isPlaying ? "PAUSE" : labels.mainLabel;

  const svg = renderIconTemplate(iconSvg, {
    mainLabel,
    subLabel: labels.subLabel,
  });

  return svgToDataUri(svg);
}

/**
 * Replay Control
 * Unified replay action combining transport, speed, and navigation controls.
 * Provides 17 modes covering play/pause toggle, speed adjustment, and replay
 * navigation via iRacing SDK commands.
 */
@action({ UUID: "com.iracedeck.sd.core.replay-control" })
export class ReplayControl extends ConnectionStateAwareAction<ReplayControlSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("ReplayControl"), LogLevel.Info);

  /** Cached telemetry for play/pause toggle, keyed by action context ID */
  private isReplayPlaying = new Map<string, boolean>();

  /** Cached settings per context for telemetry-driven display updates */
  private activeContexts = new Map<string, ReplayControlSettings>();

  /** Last rendered state key per context (prevents redundant re-renders) */
  private lastState = new Map<string, string>();

  override async onWillAppear(ev: WillAppearEvent<ReplayControlSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);

    // Seed initial play state from current telemetry
    const current = this.sdkController.getCurrentTelemetry();

    if (current?.IsReplayPlaying !== undefined) {
      this.isReplayPlaying.set(ev.action.id, current.IsReplayPlaying as boolean);
    }

    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry: TelemetryData | null) => {
      this.updateConnectionState();
      const wasPlaying = this.isReplayPlaying.get(ev.action.id);
      this.updateTelemetryState(ev.action.id, telemetry);
      const nowPlaying = this.isReplayPlaying.get(ev.action.id);

      // Re-render when play state changes (for play-pause mode icon toggle)
      const storedSettings = this.activeContexts.get(ev.action.id);

      if (storedSettings && wasPlaying !== nowPlaying) {
        this.updateDisplayFromTelemetry(ev.action.id, storedSettings);
      }
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<ReplayControlSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.isReplayPlaying.delete(ev.action.id);
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
    this.executeMode(ev.action.id, settings.mode);
  }

  override async onDialDown(ev: DialDownEvent<ReplayControlSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeDialDown(ev.action.id, settings.mode);
  }

  override async onDialRotate(ev: DialRotateEvent<ReplayControlSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeDialRotate(settings.mode, ev.payload.ticks);
  }

  private parseSettings(settings: unknown): ReplayControlSettings {
    const parsed = ReplayControlSettings.safeParse(settings);

    return parsed.success ? parsed.data : ReplayControlSettings.parse({});
  }

  private updateTelemetryState(contextId: string, telemetry: TelemetryData | null): void {
    if (telemetry && telemetry.IsReplayPlaying !== undefined) {
      this.isReplayPlaying.set(contextId, telemetry.IsReplayPlaying as boolean);
    }
  }

  private executeMode(contextId: string, mode: ReplayControlMode): void {
    const replay = getCommands().replay;

    switch (mode) {
      case "play-pause": {
        const isPlaying = this.isReplayPlaying.get(contextId) ?? false;
        const success = isPlaying ? replay.pause() : replay.play();
        this.logger.info(isPlaying ? "Pause executed" : "Play executed");
        this.logger.debug(`Result: ${success}, wasPlaying: ${isPlaying}`);
        break;
      }
      case "stop": {
        // iRacing SDK has no separate "stop" command; pause is the closest equivalent
        const success = replay.pause();
        this.logger.info("Stop executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "fast-forward": {
        const success = replay.fastForward();
        this.logger.info("Fast forward executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "rewind": {
        const success = replay.rewind();
        this.logger.info("Rewind executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "slow-motion": {
        const success = replay.slowMotion();
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
        const success = replay.fastForward();
        this.logger.info("Speed increase executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "speed-decrease": {
        const success = replay.rewind();
        this.logger.info("Speed decrease executed");
        this.logger.debug(`Result: ${success}`);
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
    }
  }

  private executeDialDown(contextId: string, mode: ReplayControlMode): void {
    const replay = getCommands().replay;

    if (mode === "speed-increase" || mode === "speed-decrease") {
      // Speed modes: encoder push resets to normal speed
      const success = replay.play();
      this.logger.info("Speed reset to normal");
      this.logger.debug(`Result: ${success}`);
    } else if (mode === "play-pause") {
      // Play/pause toggle based on telemetry state
      this.executeMode(contextId, mode);
    } else if (DIRECTIONAL_PAIRS[mode]) {
      // Navigation directional pairs: encoder push executes the selected action
      this.executeMode(contextId, mode);
    } else if (mode === "jump-to-beginning" || mode === "jump-to-live") {
      // Navigation non-directional: encoder push executes the action
      this.executeMode(contextId, mode);
    } else {
      // Transport modes: encoder push plays
      const success = replay.play();
      this.logger.info("Play executed (dial)");
      this.logger.debug(`Result: ${success}`);
    }
  }

  private executeDialRotate(mode: ReplayControlMode, ticks: number): void {
    const replay = getCommands().replay;

    if (mode === "speed-increase" || mode === "speed-decrease") {
      // Speed modes: rotate adjusts speed
      if (ticks > 0) {
        replay.fastForward();
        this.logger.info("Speed increase (dial)");
      } else {
        replay.rewind();
        this.logger.info("Speed decrease (dial)");
      }
    } else if (DIRECTIONAL_PAIRS[mode]) {
      // Navigation directional pairs: rotate cycles next/prev
      const pair = DIRECTIONAL_PAIRS[mode]!;
      const nav = ticks > 0 ? pair.next : pair.prev;
      this.executeMode("__dial__", nav);
    } else if (mode === "jump-to-beginning" || mode === "jump-to-live") {
      // Navigation non-directional: rotate does next/prev incident
      if (ticks > 0) {
        replay.nextIncident();
        this.logger.info("Next incident (dial)");
      } else {
        replay.prevIncident();
        this.logger.info("Previous incident (dial)");
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

    const isPlaying = this.isReplayPlaying.get(ev.action.id) ?? false;
    const svgDataUri = generateReplayControlSvg(settings, isPlaying);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }

  private async updateDisplayFromTelemetry(contextId: string, settings: ReplayControlSettings): Promise<void> {
    if (settings.mode !== "play-pause") return;

    const isPlaying = this.isReplayPlaying.get(contextId) ?? false;
    const stateKey = `${settings.mode}:${isPlaying}`;

    if (this.lastState.get(contextId) === stateKey) return;

    this.lastState.set(contextId, stateKey);

    const svgDataUri = generateReplayControlSvg(settings, isPlaying);
    await this.updateKeyImage(contextId, svgDataUri);
  }
}
