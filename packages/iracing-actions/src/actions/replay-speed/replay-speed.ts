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
import decreaseIconSvg from "@iracedeck/icons/replay-speed/decrease.svg";
import increaseIconSvg from "@iracedeck/icons/replay-speed/increase.svg";
import { type ReplayCommand } from "@iracedeck/iracing-sdk";
import { getGlobalColors } from "@iracedeck/settings";
import z from "zod";

import { pressReplayCommand, type ReplayGateCommand } from "../../shared/replay-command-gate.js";

type SpeedDirection = "increase" | "decrease";

const DIRECTION_ICONS: Record<SpeedDirection, string> = {
  increase: increaseIconSvg,
  decrease: decreaseIconSvg,
};

/**
 * Title text for each speed direction (format: "subLabel\nmainLabel")
 */
const REPLAY_SPEED_TITLES: Record<SpeedDirection, string> = {
  increase: "REPLAY\nFASTER",
  decrease: "REPLAY\nSLOWER",
};

/**
 * @internal Exported for testing
 */
export const ReplaySpeedSettings = CommonSettings.extend({
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

export type ReplaySpeedSettings = z.infer<typeof ReplaySpeedSettings>;

/** The gate command each speed command sends; the SDK call stays the one the action always made. */
const SPEED_COMMANDS: Record<SpeedDirection | "reset", ReplayGateCommand> = {
  increase: { kind: "speed", speed: 2, slowMotion: false, send: (r) => (r as ReplayCommand).fastForward() },
  decrease: { kind: "speed", speed: -2, slowMotion: false, send: (r) => (r as ReplayCommand).rewind() },
  reset: { kind: "speed", speed: 1, slowMotion: false, send: (r) => r.play() },
};

const SPEED_LOG_MESSAGES: Record<SpeedDirection | "reset", string> = {
  increase: "Speed increase executed",
  decrease: "Speed decrease executed",
  reset: "Speed reset to normal",
};

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the replay speed action.
 */
export function generateReplaySpeedSvg(settings: ReplaySpeedSettings): string {
  const { direction } = settings;

  const iconSvg = DIRECTION_ICONS[direction] || DIRECTION_ICONS["increase"];
  const defaultTitle = REPLAY_SPEED_TITLES[direction] || REPLAY_SPEED_TITLES["increase"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
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
    this.executeSpeed(settings.direction, ev.action.id);
  }

  override async onDialDown(_ev: IDeckDialDownEvent<ReplaySpeedSettings>): Promise<void> {
    this.logger.info("Dial down received");
    this.executeSpeed("reset");
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<ReplaySpeedSettings>): Promise<void> {
    this.logger.info("Dial rotated");

    // A zero-tick turn carries no direction; without this guard it would
    // read as counter-clockwise, send a command nobody asked for and take the
    // replay cursor from a running walk (the guard Replay Control applies).
    if (ev.payload.ticks === 0) return;

    const direction: SpeedDirection = ev.payload.ticks > 0 ? "increase" : "decrease";
    this.executeSpeed(direction);
  }

  private parseSettings(settings: unknown): ReplaySpeedSettings {
    const parsed = ReplaySpeedSettings.safeParse(settings);

    return parsed.success ? parsed.data : ReplaySpeedSettings.parse({});
  }

  /** Sends a speed command: a direction from a key or a turn, or the dial press's reset to normal speed. */
  private executeSpeed(command: SpeedDirection | "reset", origin?: string): void {
    // A speed change breaks a running Jump to Fastest Lap walk's probes as
    // surely as a seek, so it goes through the replay command gate, which
    // takes the cursor first and waits behind a jump under way (#1334, #1430).
    const result = pressReplayCommand(SPEED_COMMANDS[command], { by: `replay-speed-${command}`, origin });
    const success = result.kind === "sent" ? result.ok : false;

    if (result.kind !== "sent") this.logger.debug(`Gate result: ${result.kind}`);

    this.logger.info(SPEED_LOG_MESSAGES[command]);
    this.logger.debug(`Result: ${success}`);
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
