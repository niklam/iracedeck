import streamDeck, {
  action,
  DialDownEvent,
  DialUpEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  KeyUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import lookDownIconSvg from "@iracedeck/icons/look-direction/look-down.svg";
import lookLeftIconSvg from "@iracedeck/icons/look-direction/look-left.svg";
import lookRightIconSvg from "@iracedeck/icons/look-direction/look-right.svg";
import lookUpIconSvg from "@iracedeck/icons/look-direction/look-up.svg";
import z from "zod";

import {
  CommonSettings,
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  getGlobalColors,
  getGlobalSettings,
  getKeyboard,
  type KeyBindingValue,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  LogLevel,
  parseKeyBinding,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "../shared/index.js";

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
@action({ UUID: "com.iracedeck.sd.core.look-direction" })
export class LookDirection extends ConnectionStateAwareAction<LookDirectionSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("LookDirection"), LogLevel.Info);

  /** Currently held key combinations per action context, tracked for cleanup on release/disappear */
  private heldCombinations = new Map<string, KeyCombination>();

  override async onWillAppear(ev: WillAppearEvent<LookDirectionSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<LookDirectionSettings>): Promise<void> {
    await this.releaseHeldKey(ev.action.id);
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<LookDirectionSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<LookDirectionSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.pressLook(ev.action.id, settings.direction);
  }

  override async onKeyUp(ev: KeyUpEvent<LookDirectionSettings>): Promise<void> {
    this.logger.info("Key up received");
    await this.releaseHeldKey(ev.action.id);
  }

  override async onDialDown(ev: DialDownEvent<LookDirectionSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.pressLook(ev.action.id, settings.direction);
  }

  override async onDialUp(ev: DialUpEvent<LookDirectionSettings>): Promise<void> {
    this.logger.info("Dial up received");
    await this.releaseHeldKey(ev.action.id);
  }

  private parseSettings(settings: unknown): LookDirectionSettings {
    const parsed = LookDirectionSettings.safeParse(settings);

    return parsed.success ? parsed.data : LookDirectionSettings.parse({});
  }

  private async pressLook(actionId: string, direction: LookDirectionType): Promise<void> {
    const { combination, binding } = this.resolveCombination(direction) ?? {};

    if (!combination || !binding) {
      return;
    }

    const success = await getKeyboard().pressKeyCombination(combination);

    if (success) {
      this.heldCombinations.set(actionId, combination);
      this.logger.info("Key pressed (holding)");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to press key");
    }
  }

  private async releaseHeldKey(actionId: string): Promise<void> {
    const combination = this.heldCombinations.get(actionId);

    if (!combination) {
      return;
    }

    this.heldCombinations.delete(actionId);

    const success = await getKeyboard().releaseKeyCombination(combination);

    if (success) {
      this.logger.info("Key released");
    } else {
      this.logger.warn("Failed to release key");
    }
  }

  private resolveCombination(
    direction: LookDirectionType,
  ): { combination: KeyCombination; binding: KeyBindingValue } | null {
    const settingKey = LOOK_DIRECTION_GLOBAL_KEYS[direction];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for direction: ${direction}`);

      return null;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return null;
    }

    return {
      combination: {
        key: binding.key as KeyboardKey,
        modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
        code: binding.code,
      },
      binding,
    };
  }

  private async updateDisplay(
    ev: WillAppearEvent<LookDirectionSettings> | DidReceiveSettingsEvent<LookDirectionSettings>,
    settings: LookDirectionSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateLookDirectionSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateLookDirectionSvg(settings));
  }
}
