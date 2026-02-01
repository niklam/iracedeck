import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  getCommands,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import replayTransportTemplate from "../../icons/replay-transport.svg";

const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const RED = "#e74c3c";
const YELLOW = "#f1c40f";
const GRAY = "#888888";

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
 * Label configuration for each transport action (line1 bold, line2 subdued)
 */
const REPLAY_TRANSPORT_LABELS: Record<TransportAction, { line1: string; line2: string }> = {
  play: { line1: "PLAY", line2: "REPLAY" },
  pause: { line1: "PAUSE", line2: "REPLAY" },
  stop: { line1: "STOP", line2: "REPLAY" },
  "fast-forward": { line1: "FWD", line2: "REPLAY" },
  rewind: { line1: "REWIND", line2: "REPLAY" },
  "slow-motion": { line1: "SLOW MO", line2: "REPLAY" },
  "frame-forward": { line1: "FRAME", line2: "FWD" },
  "frame-backward": { line1: "FRAME", line2: "BACK" },
};

/**
 * SVG icon content for each transport action
 */
const REPLAY_TRANSPORT_ICONS: Record<TransportAction, string> = {
  // Play: Right-pointing triangle
  play: `
    <polygon points="28,14 52,26 28,38" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linejoin="round"/>`,

  // Pause: Two vertical bars
  pause: `
    <rect x="26" y="14" width="6" height="24" rx="1" fill="${WHITE}"/>
    <rect x="40" y="14" width="6" height="24" rx="1" fill="${WHITE}"/>`,

  // Stop: Square
  stop: `
    <rect x="26" y="14" width="20" height="20" rx="2" fill="none" stroke="${RED}" stroke-width="2"/>`,

  // Fast Forward: Double right-pointing triangles
  "fast-forward": `
    <polygon points="22,14 38,26 22,38" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linejoin="round"/>
    <polygon points="36,14 52,26 36,38" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linejoin="round"/>`,

  // Rewind: Double left-pointing triangles
  rewind: `
    <polygon points="50,14 34,26 50,38" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linejoin="round"/>
    <polygon points="36,14 20,26 36,38" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linejoin="round"/>`,

  // Slow Motion: Right-pointing triangle with "½" indicator
  "slow-motion": `
    <polygon points="24,14 46,26 24,38" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linejoin="round"/>
    <text x="54" y="18" text-anchor="middle" dominant-baseline="central"
          fill="${GRAY}" font-family="Arial, sans-serif" font-size="10" font-weight="bold">½</text>`,

  // Frame Forward: Right-pointing triangle with right bar
  "frame-forward": `
    <polygon points="24,14 42,26 24,38" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <line x1="48" y1="14" x2="48" y2="38" stroke="${WHITE}" stroke-width="2.5" stroke-linecap="round"/>`,

  // Frame Backward: Left-pointing triangle with left bar
  "frame-backward": `
    <polygon points="48,14 30,26 48,38" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <line x1="24" y1="14" x2="24" y2="38" stroke="${WHITE}" stroke-width="2.5" stroke-linecap="round"/>`,
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

  const iconContent = REPLAY_TRANSPORT_ICONS[transport] || REPLAY_TRANSPORT_ICONS["play"];
  const labels = REPLAY_TRANSPORT_LABELS[transport] || REPLAY_TRANSPORT_LABELS["play"];

  const svg = renderIconTemplate(replayTransportTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
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
