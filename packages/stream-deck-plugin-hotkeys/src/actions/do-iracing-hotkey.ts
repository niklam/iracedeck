import streamDeck, { action, KeyDownEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  escapeXml,
  generateIconText,
  getKeyboard,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import doIRacingHotkeyTemplate from "../icons/do-iracing-hotkey.svg";

const DEFAULT_ICON_COLOR = "#d94a4a";

/**
 * Format a key combination for display (e.g., "Ctrl+Shift+F3")
 */
function formatKeyCombination(combination: KeyCombination): string {
  const parts: string[] = [];

  if (combination.modifiers) {
    if (combination.modifiers.includes("ctrl")) parts.push("Ctrl");

    if (combination.modifiers.includes("shift")) parts.push("Shift");

    if (combination.modifiers.includes("alt")) parts.push("Alt");
  }

  parts.push(combination.key.toUpperCase());

  return parts.join("+");
}

/**
 * Generates an SVG icon for the iRacing hotkey action.
 */
function generateIRacingHotkeySvg(color: string, hotkeyLabel: string): string {
  const textElement = generateIconText({
    text: escapeXml(hotkeyLabel),
    fontSize: 12,
  });

  const svg = renderIconTemplate(doIRacingHotkeyTemplate, {
    color,
    textElement,
  });

  return svgToDataUri(svg);
}

/**
 * Schema for the key binding value from ird-key-binding component
 */
const KeyBindingSchema = z.object({
  key: z.string(),
  modifiers: z.array(z.string()).default([]),
  code: z.string().optional(),
  displayKey: z.string().optional(),
  vk: z.number().optional(),
});

const IRacingHotkeySettings = z.object({
  /** Key binding from ird-key-binding component (JSON string or parsed object) */
  myHotkey: z
    .union([z.string(), KeyBindingSchema])
    .optional()
    .transform((val): z.infer<typeof KeyBindingSchema> | undefined => {
      if (typeof val === "string" && val) {
        try {
          return KeyBindingSchema.parse(JSON.parse(val));
        } catch {
          return undefined;
        }
      }

      if (typeof val === "object" && val !== null) {
        return val as z.infer<typeof KeyBindingSchema>;
      }

      return undefined;
    }),
  iconColor: z.string().default(DEFAULT_ICON_COLOR),
});

/**
 * Settings for the iRacing hotkey action
 */
type IRacingHotkeySettings = z.infer<typeof IRacingHotkeySettings>;

/**
 * Format a KeyBindingSchema value for display
 */
function formatKeyBinding(binding: z.infer<typeof KeyBindingSchema> | undefined): string {
  if (!binding || !binding.key) {
    return "Not Set";
  }

  const parts: string[] = [];

  if (binding.modifiers.includes("ctrl")) parts.push("Ctrl");

  if (binding.modifiers.includes("shift")) parts.push("Shift");

  if (binding.modifiers.includes("alt")) parts.push("Alt");

  const keyDisplay = binding.displayKey
    ? binding.displayKey.length === 1
      ? binding.displayKey.toUpperCase()
      : binding.displayKey
    : binding.key.toUpperCase();
  parts.push(keyDisplay);

  return parts.join("+");
}

/**
 * iRacing Hotkey Action
 * Sends a keyboard shortcut when pressed
 */
@action({ UUID: "com.iracedeck.sd.hotkeys.do-iracing-hotkey" })
export class DoIRacingHotkey extends ConnectionStateAwareAction<IRacingHotkeySettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("DoIRacingHotkey"), LogLevel.Info);

  private activeContexts = new Map<string, IRacingHotkeySettings>();
  private lastSettings = new Map<string, string>();

  /**
   * When the action appears on the Stream Deck
   */
  override async onWillAppear(ev: WillAppearEvent<IRacingHotkeySettings>): Promise<void> {
    const parsed = IRacingHotkeySettings.safeParse(ev.payload.settings);
    const settings = parsed.success ? parsed.data : IRacingHotkeySettings.parse({});

    ev.payload.settings = settings;
    this.activeContexts.set(ev.action.id, settings);

    await this.updateDisplayWithEvent(ev);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  /**
   * When the action disappears from the Stream Deck
   */
  override async onWillDisappear(ev: WillDisappearEvent<IRacingHotkeySettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastSettings.delete(ev.action.id);
  }

  /**
   * Update display using an event (for initial setup)
   */
  private async updateDisplayWithEvent(ev: WillAppearEvent<IRacingHotkeySettings>): Promise<void> {
    const settings = ev.payload.settings;

    this.updateConnectionState();

    const settingsKey = JSON.stringify(settings);
    this.lastSettings.set(ev.action.id, settingsKey);

    const hotkeyLabel = formatKeyBinding(settings.myHotkey);
    const svgDataUri = generateIRacingHotkeySvg(settings.iconColor, hotkeyLabel);
    await this.setKeyImage(ev, svgDataUri);
  }

  /**
   * When settings are received or updated
   */
  override async onDidReceiveSettings(ev: any): Promise<void> {
    const parsed = IRacingHotkeySettings.safeParse(ev.payload.settings);
    const settings = parsed.success ? parsed.data : IRacingHotkeySettings.parse({});

    this.activeContexts.set(ev.action.id, settings);

    this.updateConnectionState();

    const settingsKey = JSON.stringify(settings);
    this.lastSettings.set(ev.action.id, settingsKey);

    const hotkeyLabel = formatKeyBinding(settings.myHotkey);
    const svgDataUri = generateIRacingHotkeySvg(settings.iconColor, hotkeyLabel);
    await this.setKeyImage(ev, svgDataUri);
  }

  /**
   * When the key is pressed
   */
  override async onKeyDown(ev: KeyDownEvent<IRacingHotkeySettings>): Promise<void> {
    this.logger.info("Key down received");

    const parsed = IRacingHotkeySettings.safeParse(ev.payload.settings);
    const settings = parsed.success ? parsed.data : IRacingHotkeySettings.parse({});

    if (!settings.myHotkey || !settings.myHotkey.key) {
      this.logger.warn("No hotkey configured");

      return;
    }

    const combination: KeyCombination = {
      key: settings.myHotkey.key as KeyboardKey,
      modifiers:
        settings.myHotkey.modifiers.length > 0 ? (settings.myHotkey.modifiers as KeyboardModifier[]) : undefined,
      code: settings.myHotkey.code,
    };

    this.logger.debug(`Sending key combination: ${JSON.stringify(combination)}`);

    const keyboard = getKeyboard();
    const success = await keyboard.sendKeyCombination(combination);

    if (success) {
      this.logger.info(`Hotkey (${formatKeyCombination(combination)}) sent successfully`);
    } else {
      this.logger.warn(`Failed to send hotkey (${formatKeyCombination(combination)})`);
    }
  }
}
