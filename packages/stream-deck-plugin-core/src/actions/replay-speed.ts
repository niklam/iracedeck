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

import replaySpeedTemplate from "../../icons/replay-speed.svg";

const GREEN = "#2ecc71";
const RED = "#e74c3c";

type SpeedDirection = "increase" | "decrease";

/**
 * Label configuration for each speed direction (line1 bold, line2 subdued)
 */
const REPLAY_SPEED_LABELS: Record<SpeedDirection, { line1: string; line2: string }> = {
  increase: { line1: "SPEED UP", line2: "REPLAY" },
  decrease: { line1: "SLOW DOWN", line2: "REPLAY" },
};

/**
 * SVG icon content for each speed direction
 */
const REPLAY_SPEED_ICONS: Record<SpeedDirection, string> = {
  // Double right-pointing chevrons (green)
  increase: `
    <polyline points="22,14 36,26 22,38" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="36,14 50,26 36,38" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,

  // Double left-pointing chevrons (red)
  decrease: `
    <polyline points="50,14 36,26 50,38" fill="none" stroke="${RED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="36,14 22,26 36,38" fill="none" stroke="${RED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
};

const ReplaySpeedSettings = z.object({
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type ReplaySpeedSettings = z.infer<typeof ReplaySpeedSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the replay speed action.
 */
export function generateReplaySpeedSvg(settings: ReplaySpeedSettings): string {
  const { direction } = settings;

  const iconContent = REPLAY_SPEED_ICONS[direction] || REPLAY_SPEED_ICONS["increase"];
  const labels = REPLAY_SPEED_LABELS[direction] || REPLAY_SPEED_LABELS["increase"];

  const svg = renderIconTemplate(replaySpeedTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Replay Speed
 * Adjusts replay playback speed via iRacing SDK commands.
 * Supports increase/decrease directions, encoder rotation, and encoder press to reset.
 */
@action({ UUID: "com.iracedeck.sd.core.replay-speed" })
export class ReplaySpeed extends ConnectionStateAwareAction<ReplaySpeedSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("ReplaySpeed"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<ReplaySpeedSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<ReplaySpeedSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ReplaySpeedSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<ReplaySpeedSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeSpeed(settings.direction);
  }

  override async onDialDown(_ev: DialDownEvent<ReplaySpeedSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const replay = getCommands().replay;
    const success = replay.play();
    this.logger.info("Speed reset to normal");
    this.logger.debug(`Result: ${success}`);
  }

  override async onDialRotate(ev: DialRotateEvent<ReplaySpeedSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const direction: SpeedDirection = ev.payload.ticks > 0 ? "increase" : "decrease";
    this.executeSpeed(direction);
  }

  private parseSettings(settings: unknown): ReplaySpeedSettings {
    const parsed = ReplaySpeedSettings.safeParse(settings);

    return parsed.success ? parsed.data : ReplaySpeedSettings.parse({});
  }

  private executeSpeed(direction: SpeedDirection): void {
    const replay = getCommands().replay;

    if (direction === "increase") {
      const success = replay.fastForward();
      this.logger.info("Speed increase executed");
      this.logger.debug(`Result: ${success}`);
    } else {
      const success = replay.rewind();
      this.logger.info("Speed decrease executed");
      this.logger.debug(`Result: ${success}`);
    }
  }

  private async updateDisplay(
    ev: WillAppearEvent<ReplaySpeedSettings> | DidReceiveSettingsEvent<ReplaySpeedSettings>,
    settings: ReplaySpeedSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateReplaySpeedSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
