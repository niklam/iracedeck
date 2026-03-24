import {
  CommonSettings,
  ConnectionStateAwareAction,
  getGlobalColors,
  type IDeckDialDownEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "@iracedeck/deck-core";
import lookDownIconSvg from "@iracedeck/icons/look-direction/look-down.svg";
import lookLeftIconSvg from "@iracedeck/icons/look-direction/look-left.svg";
import lookRightIconSvg from "@iracedeck/icons/look-direction/look-right.svg";
import lookUpIconSvg from "@iracedeck/icons/look-direction/look-up.svg";
import z from "zod";

type LookDirectionType = "look-left" | "look-right" | "look-up" | "look-down";

const DIRECTION_ICONS: Record<LookDirectionType, string> = {
  "look-left": lookLeftIconSvg,
  "look-right": lookRightIconSvg,
  "look-up": lookUpIconSvg,
  "look-down": lookDownIconSvg,
};

/**
 * Label configuration for each look direction
 */
const LOOK_DIRECTION_LABELS: Record<LookDirectionType, { mainLabel: string; subLabel: string }> = {
  "look-left": { mainLabel: "LEFT", subLabel: "LOOK" },
  "look-right": { mainLabel: "RIGHT", subLabel: "LOOK" },
  "look-up": { mainLabel: "UP", subLabel: "LOOK" },
  "look-down": { mainLabel: "DOWN", subLabel: "LOOK" },
};

/**
 * @internal Exported for testing
 *
 * Mapping from look direction setting values (kebab-case) to global settings keys.
 */
export const LOOK_DIRECTION_GLOBAL_KEYS: Record<LookDirectionType, string> = {
  "look-left": "lookDirectionLeft",
  "look-right": "lookDirectionRight",
  "look-up": "lookDirectionUp",
  "look-down": "lookDirectionDown",
};

const LookDirectionSettings = CommonSettings.extend({
  direction: z.enum(["look-left", "look-right", "look-up", "look-down"]).default("look-left"),
});

type LookDirectionSettings = z.infer<typeof LookDirectionSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the look direction action.
 */
export function generateLookDirectionSvg(settings: LookDirectionSettings): string {
  const { direction } = settings;

  const iconSvg = DIRECTION_ICONS[direction] || DIRECTION_ICONS["look-left"];
  const labels = LOOK_DIRECTION_LABELS[direction] || LOOK_DIRECTION_LABELS["look-left"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Look Direction Action
 * Holds the driver's view in a direction while the button/dial is pressed.
 * Uses long-press: key is held on press, released on release.
 */
export const LOOK_DIRECTION_UUID = "com.iracedeck.sd.core.look-direction" as const;

export class LookDirection extends ConnectionStateAwareAction<LookDirectionSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<LookDirectionSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.setActiveBinding(LOOK_DIRECTION_GLOBAL_KEYS[settings.direction]);
    await this.updateDisplay(ev, settings);
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<LookDirectionSettings>): Promise<void> {
    await this.releaseBinding(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<LookDirectionSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.setActiveBinding(LOOK_DIRECTION_GLOBAL_KEYS[settings.direction]);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<LookDirectionSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    const settingKey = LOOK_DIRECTION_GLOBAL_KEYS[settings.direction];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for direction: ${settings.direction}`);

      return;
    }

    await this.holdBinding(ev.action.id, settingKey);
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<LookDirectionSettings>): Promise<void> {
    this.logger.info("Key up received");
    await this.releaseBinding(ev.action.id);
  }

  override async onDialDown(ev: IDeckDialDownEvent<LookDirectionSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    const settingKey = LOOK_DIRECTION_GLOBAL_KEYS[settings.direction];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for direction: ${settings.direction}`);

      return;
    }

    await this.holdBinding(ev.action.id, settingKey);
  }

  override async onDialUp(ev: IDeckDialUpEvent<LookDirectionSettings>): Promise<void> {
    this.logger.info("Dial up received");
    await this.releaseBinding(ev.action.id);
  }

  private parseSettings(settings: unknown): LookDirectionSettings {
    const parsed = LookDirectionSettings.safeParse(settings);

    return parsed.success ? parsed.data : LookDirectionSettings.parse({});
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<LookDirectionSettings> | IDeckDidReceiveSettingsEvent<LookDirectionSettings>,
    settings: LookDirectionSettings,
  ): Promise<void> {
    const svgDataUri = generateLookDirectionSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateLookDirectionSvg(settings));
  }
}
