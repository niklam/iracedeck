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
  CommonSettings,
  ConnectionStateAwareAction,
  createSDLogger,
  getCommands,
  getGlobalColors,
  LogLevel,
  renderIconTemplate,
  resolveIconColors,
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
  play: { mainLabel: "PLAY", subLabel: "" },
  pause: { mainLabel: "PAUSE", subLabel: "" },
  stop: { mainLabel: "STOP", subLabel: "" },
  "fast-forward": { mainLabel: "FORWARD", subLabel: "FAST" },
  rewind: { mainLabel: "REWIND", subLabel: "" },
  "slow-motion": { mainLabel: "MOTION", subLabel: "SLOW" },
  "frame-forward": { mainLabel: "FRAME FWD", subLabel: "" },
  "frame-backward": { mainLabel: "FRAME BACK", subLabel: "" },
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
  const labels = REPLAY_TRANSPORT_LABELS[transport] || REPLAY_TRANSPORT_LABELS["play"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
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
    await super.onWillAppear(ev);
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
    await super.onDidReceiveSettings(ev);
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
    this.setRegenerateCallback(ev.action.id, () => generateReplayTransportSvg(settings));
  }
}
