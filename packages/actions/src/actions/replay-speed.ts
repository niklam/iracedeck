import {
  CommonSettings,
  ConnectionStateAwareAction,
  getCommands,
  getGlobalColors,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "@iracedeck/deck-core";
import decreaseIconSvg from "@iracedeck/icons/replay-speed/decrease.svg";
import increaseIconSvg from "@iracedeck/icons/replay-speed/increase.svg";
import z from "zod";

type SpeedDirection = "increase" | "decrease";

const DIRECTION_ICONS: Record<SpeedDirection, string> = {
  increase: increaseIconSvg,
  decrease: decreaseIconSvg,
};

/**
 * Label configuration for each speed direction
 */
const REPLAY_SPEED_LABELS: Record<SpeedDirection, { mainLabel: string; subLabel: string }> = {
  increase: { mainLabel: "FASTER", subLabel: "REPLAY" },
  decrease: { mainLabel: "SLOWER", subLabel: "REPLAY" },
};

const ReplaySpeedSettings = CommonSettings.extend({
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

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Replay Speed
 * Adjusts replay playback speed via iRacing SDK commands.
 * Supports increase/decrease directions, encoder rotation, and encoder press to reset.
 */
export const REPLAY_SPEED_UUID = "com.iracedeck.sd.core.replay-speed" as const;

export class ReplaySpeed extends ConnectionStateAwareAction<ReplaySpeedSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<ReplaySpeedSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<ReplaySpeedSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<ReplaySpeedSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeSpeed(settings.direction);
  }

  override async onDialDown(_ev: IDeckDialDownEvent<ReplaySpeedSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const replay = getCommands().replay;
    const success = replay.play();
    this.logger.info("Speed reset to normal");
    this.logger.debug(`Result: ${success}`);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<ReplaySpeedSettings>): Promise<void> {
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
    ev: IDeckWillAppearEvent<ReplaySpeedSettings> | IDeckDidReceiveSettingsEvent<ReplaySpeedSettings>,
    settings: ReplaySpeedSettings,
  ): Promise<void> {
    const svgDataUri = generateReplaySpeedSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateReplaySpeedSvg(settings));
  }
}
