import streamDeck, {
  action,
  DialRotateEvent,
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

import splitsDeltaCycleTemplate from "../../icons/splits-delta-cycle.svg";

const WHITE = "#ffffff";
const PURPLE = "#9b59b6";
const GREEN = "#2ecc71";
const YELLOW = "#f1c40f";

/**
 * SVG icon content for cycle directions (next/previous)
 * Uses F1-style sector time colors: purple (best overall), green (personal best), yellow (slower)
 */
const DIRECTION_ICONS: Record<string, string> = {
  // Next: F1 sector bars + right arrow
  next: `
    <rect x="13" y="10" width="14" height="10" rx="2" fill="${PURPLE}"/>
    <rect x="29" y="10" width="14" height="10" rx="2" fill="${GREEN}"/>
    <rect x="45" y="10" width="14" height="10" rx="2" fill="${YELLOW}"/>
    <path d="M56 33 l-14 -9 v5 h-24 v8 h24 v5 z" fill="${WHITE}"/>`,

  // Previous: F1 sector bars + left arrow
  previous: `
    <rect x="13" y="10" width="14" height="10" rx="2" fill="${PURPLE}"/>
    <rect x="29" y="10" width="14" height="10" rx="2" fill="${GREEN}"/>
    <rect x="45" y="10" width="14" height="10" rx="2" fill="${YELLOW}"/>
    <path d="M16 33 l14 -9 v5 h24 v8 h-24 v5 z" fill="${WHITE}"/>`,
};

const SplitsDeltaCycleSettings = z.object({
  direction: z.enum(["next", "previous"]).default("next"),
});

type SplitsDeltaCycleSettings = z.infer<typeof SplitsDeltaCycleSettings>;

/**
 * @internal Exported for testing
 */
export const GLOBAL_KEY_NAMES = {
  NEXT: "splitsDeltaNext",
  PREVIOUS: "splitsDeltaPrevious",
} as const;

/**
 * @internal Exported for testing
 */
export function generateSplitsDeltaCycleSvg(settings: SplitsDeltaCycleSettings): string {
  const { direction } = settings;

  const iconContent = DIRECTION_ICONS[direction] || DIRECTION_ICONS.next;
  const labels =
    direction === "next" ? { line1: "NEXT", line2: "SPLITS DELTA" } : { line1: "PREVIOUS", line2: "SPLITS DELTA" };

  const svg = renderIconTemplate(splitsDeltaCycleTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Splits Delta Cycle Action
 * Cycles through iRacing split-time delta display modes via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.splits-delta-cycle" })
export class SplitsDeltaCycle extends ConnectionStateAwareAction<SplitsDeltaCycleSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("SplitsDeltaCycle"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<SplitsDeltaCycleSettings>): Promise<void> {
    const parsed = SplitsDeltaCycleSettings.safeParse(ev.payload.settings);
    const settings = parsed.success ? parsed.data : SplitsDeltaCycleSettings.parse({});

    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<SplitsDeltaCycleSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SplitsDeltaCycleSettings>): Promise<void> {
    const parsed = SplitsDeltaCycleSettings.safeParse(ev.payload.settings);
    const settings = parsed.success ? parsed.data : SplitsDeltaCycleSettings.parse({});

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<SplitsDeltaCycleSettings>): Promise<void> {
    this.logger.info("Key down received");

    const parsed = SplitsDeltaCycleSettings.safeParse(ev.payload.settings);
    const settings = parsed.success ? parsed.data : SplitsDeltaCycleSettings.parse({});

    const settingKey = settings.direction === "next" ? GLOBAL_KEY_NAMES.NEXT : GLOBAL_KEY_NAMES.PREVIOUS;
    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return;
    }

    await this.sendKeyBinding(binding);
  }

  override async onDialRotate(ev: DialRotateEvent<SplitsDeltaCycleSettings>): Promise<void> {
    this.logger.info(`Dial rotated: ${ev.payload.ticks} ticks`);

    const globalSettings = getGlobalSettings() as Record<string, unknown>;

    // Clockwise (ticks > 0) = next, Counter-clockwise (ticks < 0) = previous
    const settingKey = ev.payload.ticks > 0 ? GLOBAL_KEY_NAMES.NEXT : GLOBAL_KEY_NAMES.PREVIOUS;

    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return;
    }

    await this.sendKeyBinding(binding);
  }

  private async updateDisplay(
    ev: WillAppearEvent<SplitsDeltaCycleSettings> | DidReceiveSettingsEvent<SplitsDeltaCycleSettings>,
    settings: SplitsDeltaCycleSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateSplitsDeltaCycleSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }

  private async sendKeyBinding(binding: KeyBindingValue): Promise<void> {
    const combination: KeyCombination = {
      key: binding.key as KeyboardKey,
      modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
      code: binding.code,
    };

    this.logger.debug(`Sending key combination: ${JSON.stringify(combination)}`);

    const keyboard = getKeyboard();

    if (!keyboard) {
      this.logger.error("Keyboard interface not available");

      return;
    }

    const success = await keyboard.sendKeyCombination(combination);

    if (success) {
      this.logger.info("Key sent successfully");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to send key");
      this.logger.debug(`Failed key combination: ${formatKeyBinding(binding)}`);
    }
  }
}
