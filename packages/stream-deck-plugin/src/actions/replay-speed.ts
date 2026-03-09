import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import decreaseIconSvg from "@iracedeck/icons/replay-speed/decrease.svg";
import increaseIconSvg from "@iracedeck/icons/replay-speed/increase.svg";
import z from "zod";

import {
  ConnectionStateAwareAction,
  createSDLogger,
  getCommands,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";

type SpeedDirection = "increase" | "decrease";

const DIRECTION_ICONS: Record<SpeedDirection, string> = {
  increase: increaseIconSvg,
  decrease: decreaseIconSvg,
};

/**
 * Label configuration for each speed direction
 */
const REPLAY_SPEED_LABELS: Record<SpeedDirection, { mainLabel: string; subLabel: string }> = {
  increase: { mainLabel: "SPEED UP", subLabel: "REPLAY" },
  decrease: { mainLabel: "SLOW DOWN", subLabel: "REPLAY" },
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

  const iconSvg = DIRECTION_ICONS[direction] || DIRECTION_ICONS["increase"];
  const labels = REPLAY_SPEED_LABELS[direction] || REPLAY_SPEED_LABELS["increase"];

  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
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
