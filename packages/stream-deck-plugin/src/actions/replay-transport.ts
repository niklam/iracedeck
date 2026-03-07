import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import fastForwardIconSvg from "@iracedeck/icons/replay-transport/fast-forward.svg";
import frameBackwardIconSvg from "@iracedeck/icons/replay-transport/frame-backward.svg";
import frameForwardIconSvg from "@iracedeck/icons/replay-transport/frame-forward.svg";
import pauseIconSvg from "@iracedeck/icons/replay-transport/pause.svg";
import playIconSvg from "@iracedeck/icons/replay-transport/play.svg";
import rewindIconSvg from "@iracedeck/icons/replay-transport/rewind.svg";
import slowMotionIconSvg from "@iracedeck/icons/replay-transport/slow-motion.svg";
import stopIconSvg from "@iracedeck/icons/replay-transport/stop.svg";
import z from "zod";

import {
  ConnectionStateAwareAction,
  createSDLogger,
  getCommands,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";

type TransportAction =
  | "play"
  | "pause"
  | "stop"
  | "fast-forward"
  | "rewind"
  | "slow-motion"
  | "frame-forward"
  | "frame-backward";

/**
 * Label configuration for each transport action (mainLabel prominent, subLabel subdued)
 */
const REPLAY_TRANSPORT_LABELS: Record<TransportAction, { mainLabel: string; subLabel: string }> = {
  play: { mainLabel: "PLAY", subLabel: "REPLAY" },
  pause: { mainLabel: "PAUSE", subLabel: "REPLAY" },
  stop: { mainLabel: "STOP", subLabel: "REPLAY" },
  "fast-forward": { mainLabel: "FWD", subLabel: "REPLAY" },
  rewind: { mainLabel: "REWIND", subLabel: "REPLAY" },
  "slow-motion": { mainLabel: "SLOW MO", subLabel: "REPLAY" },
  "frame-forward": { mainLabel: "FRAME", subLabel: "FWD" },
  "frame-backward": { mainLabel: "FRAME", subLabel: "BACK" },
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

const ReplayTransportSettings = z.object({
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
  const labels = REPLAY_TRANSPORT_LABELS[transport] || REPLAY_TRANSPORT_LABELS["play"];

  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
  });

  return svgToDataUri(svg);
}

/**
 * Replay Transport
 * Provides playback controls during replays (play, pause, stop, fast forward,
 * rewind, slow motion, frame step) via iRacing SDK commands.
 */
@action({ UUID: "com.iracedeck.sd.core.replay-transport" })
export class ReplayTransport extends ConnectionStateAwareAction<ReplayTransportSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("ReplayTransport"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<ReplayTransportSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<ReplayTransportSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ReplayTransportSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<ReplayTransportSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeTransport(settings.transport);
  }

  override async onDialDown(_ev: DialDownEvent<ReplayTransportSettings>): Promise<void> {
    this.logger.info("Dial down received");
    this.executeTransport("play");
  }

  override async onDialRotate(ev: DialRotateEvent<ReplayTransportSettings>): Promise<void> {
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
    ev: WillAppearEvent<ReplayTransportSettings> | DidReceiveSettingsEvent<ReplayTransportSettings>,
    settings: ReplayTransportSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateReplayTransportSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
