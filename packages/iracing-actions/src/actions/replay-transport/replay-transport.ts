import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getGlobalBorderSettings,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import fastForwardIconSvg from "@iracedeck/icons/replay-transport/fast-forward.svg";
import frameBackwardIconSvg from "@iracedeck/icons/replay-transport/frame-backward.svg";
import frameForwardIconSvg from "@iracedeck/icons/replay-transport/frame-forward.svg";
import pauseIconSvg from "@iracedeck/icons/replay-transport/pause.svg";
import playIconSvg from "@iracedeck/icons/replay-transport/play.svg";
import rewindIconSvg from "@iracedeck/icons/replay-transport/rewind.svg";
import slowMotionIconSvg from "@iracedeck/icons/replay-transport/slow-motion.svg";
import stopIconSvg from "@iracedeck/icons/replay-transport/stop.svg";
import { type ReplayCommand } from "@iracedeck/iracing-sdk";
import { getGlobalColors } from "@iracedeck/settings";
import z from "zod";

import { pressReplayCommand, type ReplayGateCommand } from "../../shared/replay-command-gate.js";

type TransportAction =
  "play" | "pause" | "stop" | "fast-forward" | "rewind" | "slow-motion" | "frame-forward" | "frame-backward";

/**
 * Title text for each transport action (format: "subLabel\nmainLabel")
 */
const REPLAY_TRANSPORT_TITLES: Record<TransportAction, string> = {
  play: "PLAY",
  pause: "PAUSE",
  stop: "STOP",
  "fast-forward": "FAST\nFORWARD",
  rewind: "REWIND",
  "slow-motion": "SLOW\nMOTION",
  "frame-forward": "FRAME FWD",
  "frame-backward": "FRAME BACK",
};

/**
 * SVG icon templates for each transport action
 */
const REPLAY_TRANSPORT_ICONS: Record<TransportAction, string> = {
  play: playIconSvg,
  pause: pauseIconSvg,
  stop: stopIconSvg,
  "fast-forward": fastForwardIconSvg,
  rewind: rewindIconSvg,
  "slow-motion": slowMotionIconSvg,
  "frame-forward": frameForwardIconSvg,
  "frame-backward": frameBackwardIconSvg,
};

/**
 * @internal Exported for testing
 */
export const ReplayTransportSettings = CommonSettings.extend({
  transport: z
    .enum([
      "play",
      "pause",
      "stop",
      "fast-forward",
      "rewind",
      "slow-motion",
      "frame-forward",
      "frame-backward",
    ])
    .default("play"),
});

export type ReplayTransportSettings = z.infer<typeof ReplayTransportSettings>;

/** The gate command each transport action sends; the SDK call stays the one the action always made. */
const TRANSPORT_COMMANDS: Record<TransportAction, ReplayGateCommand> = {
  play: { kind: "speed", speed: 1, slowMotion: false, send: (r) => r.play() },
  pause: { kind: "pause" },
  stop: { kind: "pause" },
  "fast-forward": { kind: "speed", speed: 2, slowMotion: false, send: (r) => (r as ReplayCommand).fastForward() },
  rewind: { kind: "speed", speed: -2, slowMotion: false, send: (r) => (r as ReplayCommand).rewind() },
  "slow-motion": { kind: "speed", speed: 2, slowMotion: true, send: (r) => (r as ReplayCommand).slowMotion() },
  "frame-forward": { kind: "step", direction: 1 },
  "frame-backward": { kind: "step", direction: -1 },
};

const TRANSPORT_LOG_NAMES: Record<TransportAction, string> = {
  play: "Play",
  pause: "Pause",
  stop: "Stop",
  "fast-forward": "Fast forward",
  rewind: "Rewind",
  "slow-motion": "Slow motion",
  "frame-forward": "Frame forward",
  "frame-backward": "Frame backward",
};

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the replay transport action.
 */
export function generateReplayTransportSvg(settings: ReplayTransportSettings): string {
  const { transport } = settings;

  const iconSvg = REPLAY_TRANSPORT_ICONS[transport] || REPLAY_TRANSPORT_ICONS["play"];
  const defaultTitle = REPLAY_TRANSPORT_TITLES[transport] || REPLAY_TRANSPORT_TITLES["play"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
}

/**
 * Replay Transport
 * Provides playback controls during replays (play, pause, stop, fast forward,
 * rewind, slow motion, frame step) via iRacing SDK commands.
 */
export const REPLAY_TRANSPORT_UUID = "com.iracedeck.sd.core.replay-transport" as const;

export class ReplayTransport extends ConnectionStateAwareAction<ReplayTransportSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<ReplayTransportSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<ReplayTransportSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<ReplayTransportSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeTransport(settings.transport, ev.action.id);
  }

  override async onDialDown(_ev: IDeckDialDownEvent<ReplayTransportSettings>): Promise<void> {
    this.logger.info("Dial down received");
    this.executeTransport("play");
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<ReplayTransportSettings>): Promise<void> {
    this.logger.info("Dial rotated");

    // A zero-tick turn carries no direction; without this guard it would
    // read as counter-clockwise, send a command nobody asked for and take the
    // replay cursor from a running walk (the guard Replay Control applies).
    if (ev.payload.ticks === 0) return;

    const transport: TransportAction = ev.payload.ticks > 0 ? "frame-forward" : "frame-backward";
    // A detent is a repeat of the turn, never a second press: behind a search it waits (#1430).
    this.executeTransport(transport, undefined, true);
  }

  private parseSettings(settings: unknown): ReplayTransportSettings {
    const parsed = ReplayTransportSettings.safeParse(settings);

    return parsed.success ? parsed.data : ReplayTransportSettings.parse({});
  }

  private executeTransport(transport: TransportAction, origin?: string, repeat = false): void {
    // A pause or a frame step mid-walk breaks a running Jump to Fastest Lap
    // walk's probes as surely as a seek, so every transport command goes
    // through the replay command gate, which takes the cursor first and holds
    // or retargets the command behind a jump under way (#1334, #1430).
    const result = pressReplayCommand(TRANSPORT_COMMANDS[transport], {
      by: `replay-transport-${transport}`,
      origin,
      repeat,
    });
    const success = result.kind === "sent" ? result.ok : false;

    if (result.kind !== "sent") this.logger.debug(`Gate result: ${result.kind}`);

    this.logger.info(`${TRANSPORT_LOG_NAMES[transport]} executed`);
    this.logger.debug(`Result: ${success}`);
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<ReplayTransportSettings> | IDeckDidReceiveSettingsEvent<ReplayTransportSettings>,
    settings: ReplayTransportSettings,
  ): Promise<void> {
    const svgDataUri = generateReplayTransportSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateReplayTransportSvg(settings));
  }
}
