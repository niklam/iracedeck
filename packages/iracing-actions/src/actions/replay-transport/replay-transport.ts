import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getCommands,
  getGlobalBorderSettings,
  getGlobalColors,
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
import z from "zod";

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

const ReplayTransportSettings = CommonSettings.extend({
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

type ReplayTransportSettings = z.infer<typeof ReplayTransportSettings>;

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
    this.executeTransport(settings.transport);
  }

  override async onDialDown(_ev: IDeckDialDownEvent<ReplayTransportSettings>): Promise<void> {
    this.logger.info("Dial down received");
    this.executeTransport("play");
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<ReplayTransportSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const transport: TransportAction = ev.payload.ticks > 0 ? "frame-forward" : "frame-backward";
    this.executeTransport(transport);
  }

  private parseSettings(settings: unknown): ReplayTransportSettings {
    const parsed = ReplayTransportSettings.safeParse(settings);

    return parsed.success ? parsed.data : ReplayTransportSettings.parse({});
  }

  private executeTransport(transport: TransportAction): void {
    const replay = getCommands().replay;

    switch (transport) {
      case "play": {
        const success = replay.play();
        this.logger.info("Play executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "pause": {
        const success = replay.pause();
        this.logger.info("Pause executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "stop": {
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
    }
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
