import streamDeck, {
  action,
  DialDownEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  getGlobalSettings,
  getKeyboard,
  type KeyBindingValue,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  LogLevel,
  parseKeyBinding,
  renderIconTemplate,
  svgToDataUri,
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import lookDirectionTemplate from "../../icons/look-direction.svg";

const WHITE = "#ffffff";
const GRAY = "#888888";

type LookDirectionType = "look-left" | "look-right" | "look-up" | "look-down";

/**
 * Label configuration for each look direction (line1 bold, line2 subdued)
 */
const LOOK_DIRECTION_LABELS: Record<LookDirectionType, { line1: string; line2: string }> = {
  "look-left": { line1: "LOOK", line2: "LEFT" },
  "look-right": { line1: "LOOK", line2: "RIGHT" },
  "look-up": { line1: "LOOK", line2: "UP" },
  "look-down": { line1: "LOOK", line2: "DOWN" },
};

/**
 * SVG icon content for each look direction
 */
const LOOK_DIRECTION_ICONS: Record<LookDirectionType, string> = {
  // Look Left: Eye with left arrow
  "look-left": `
    <path d="M18 24 Q36 12 54 24 Q36 36 18 24 Z" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="24" r="5" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="34" cy="24" r="2" fill="${WHITE}"/>
    <path d="M16 38 L10 38 L14 34" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M10 38 L14 42" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,

  // Look Right: Eye with right arrow
  "look-right": `
    <path d="M18 24 Q36 12 54 24 Q36 36 18 24 Z" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="24" r="5" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="38" cy="24" r="2" fill="${WHITE}"/>
    <path d="M56 38 L62 38 L58 34" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M62 38 L58 42" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,

  // Look Up: Eye with up arrow
  "look-up": `
    <path d="M18 26 Q36 14 54 26 Q36 38 18 26 Z" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="26" r="5" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="24" r="2" fill="${WHITE}"/>
    <path d="M54 14 L54 8 L50 12" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M54 8 L58 12" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,

  // Look Down: Eye with down arrow
  "look-down": `
    <path d="M18 22 Q36 10 54 22 Q36 34 18 22 Z" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="22" r="5" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="24" r="2" fill="${WHITE}"/>
    <path d="M54 34 L54 40 L50 36" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M54 40 L58 36" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
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

const LookDirectionSettings = z.object({
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

  const iconContent = LOOK_DIRECTION_ICONS[direction] || LOOK_DIRECTION_ICONS["look-left"];
  const labels = LOOK_DIRECTION_LABELS[direction] || LOOK_DIRECTION_LABELS["look-left"];

  const svg = renderIconTemplate(lookDirectionTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Look Direction Action
 * Changes the driver's view direction via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.look-direction" })
export class LookDirection extends ConnectionStateAwareAction<LookDirectionSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("LookDirection"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<LookDirectionSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<LookDirectionSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<LookDirectionSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<LookDirectionSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeLook(settings.direction);
  }

  override async onDialDown(ev: DialDownEvent<LookDirectionSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeLook(settings.direction);
  }

  private parseSettings(settings: unknown): LookDirectionSettings {
    const parsed = LookDirectionSettings.safeParse(settings);

    return parsed.success ? parsed.data : LookDirectionSettings.parse({});
  }

  private async executeLook(direction: LookDirectionType): Promise<void> {
    const settingKey = LOOK_DIRECTION_GLOBAL_KEYS[direction];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for direction: ${direction}`);

      return;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return;
    }

    await this.sendKeyBinding(binding);
  }

  private async sendKeyBinding(binding: KeyBindingValue): Promise<void> {
    const combination: KeyCombination = {
      key: binding.key as KeyboardKey,
      modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
    };

    const success = await getKeyboard().sendKeyCombination(combination);

    if (success) {
      this.logger.info("Key sent successfully");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to send key");
      this.logger.debug(`Failed key combination: ${formatKeyBinding(binding)}`);
    }
  }

  private async updateDisplay(
    ev: WillAppearEvent<LookDirectionSettings> | DidReceiveSettingsEvent<LookDirectionSettings>,
    settings: LookDirectionSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateLookDirectionSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
