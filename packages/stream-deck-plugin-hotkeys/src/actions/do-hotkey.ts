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

import doHotkeyTemplate from "../icons/do-hotkey.svg";

const DEFAULT_ICON_COLOR = "#4a90d9";

/**
 * Format a key combination for display (e.g., "Ctrl+Shift+F3")
 */
function formatKeyCombination(key: string, ctrl: boolean, shift: boolean, alt: boolean): string {
  const parts: string[] = [];

  if (ctrl) parts.push("Ctrl");

  if (shift) parts.push("Shift");

  if (alt) parts.push("Alt");

  parts.push(key.toUpperCase());

  return parts.join("+");
}

/**
 * Generates an SVG icon for the hotkey action.
 */
function generateHotkeySvg(
  color: string,
  key: string,
  ctrl: boolean,
  shift: boolean,
  alt: boolean,
  label?: string,
): string {
  const trimmedLabel = label?.trim();
  let textElement: string;

  if (trimmedLabel) {
    // Use custom label
    const displayText = trimmedLabel
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");

    textElement = generateIconText({
      text: escapeXml(displayText),
      fontSize: 12,
    });
  } else {
    // Show key combination
    const keyDisplay = formatKeyCombination(key, ctrl, shift, alt);
    textElement = generateIconText({ text: escapeXml(keyDisplay), fontSize: 12 });
  }

  const svg = renderIconTemplate(doHotkeyTemplate, {
    color,
    textElement,
  });

  return svgToDataUri(svg);
}

/**
 * Build a KeyCombination from settings
 */
function buildKeyCombination(key: string, ctrl: boolean, shift: boolean, alt: boolean): KeyCombination {
  const modifiers: KeyboardModifier[] = [];

  if (ctrl) modifiers.push("ctrl");

  if (shift) modifiers.push("shift");

  if (alt) modifiers.push("alt");

  return {
    key: key as KeyboardKey,
    modifiers: modifiers.length > 0 ? modifiers : undefined,
  };
}

/**
 * Do Hotkey Action
 * Sends a configurable keyboard hotkey when pressed
 */
@action({ UUID: "com.iracedeck.sd.hotkeys.do-hotkey" })
export class DoHotkey extends ConnectionStateAwareAction<HotkeySettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("DoHotkey"), LogLevel.Info);

  private activeContexts = new Map<string, HotkeySettings>();
  private lastSettings = new Map<string, string>();

  /**
   * When the action appears on the Stream Deck
   */
  override async onWillAppear(ev: WillAppearEvent<HotkeySettings>): Promise<void> {
    const parsed = HotkeySettings.safeParse(ev.payload.settings);
    const settings = parsed.success ? parsed.data : HotkeySettings.parse({});

    const original = ev.payload.settings;
    const settingsChanged =
      settings.key !== original.key ||
      settings.ctrl !== original.ctrl ||
      settings.shift !== original.shift ||
      settings.alt !== original.alt ||
      settings.label !== original.label ||
      settings.iconColor !== original.iconColor;

    ev.payload.settings = settings;
    this.activeContexts.set(ev.action.id, settings);

    if (settingsChanged) {
      await ev.action.setSettings(settings);
    }

    await this.updateDisplayWithEvent(ev);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  /**
   * When the action disappears from the Stream Deck
   */
  override async onWillDisappear(ev: WillDisappearEvent<HotkeySettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastSettings.delete(ev.action.id);
  }

  /**
   * Update display using an event (for initial setup)
   */
  private async updateDisplayWithEvent(ev: WillAppearEvent<HotkeySettings>): Promise<void> {
    const settings = ev.payload.settings;

    this.updateConnectionState();

    const settingsKey = JSON.stringify(settings);
    this.lastSettings.set(ev.action.id, settingsKey);

    const svgDataUri = generateHotkeySvg(
      settings.iconColor,
      settings.key,
      settings.ctrl,
      settings.shift,
      settings.alt,
      settings.label,
    );
    await this.setKeyImage(ev, svgDataUri);
  }

  /**
   * When settings are received or updated
   */
  override async onDidReceiveSettings(ev: any): Promise<void> {
    const parsed = HotkeySettings.safeParse(ev.payload.settings);
    const settings = parsed.success ? parsed.data : HotkeySettings.parse({});

    this.activeContexts.set(ev.action.id, settings);

    this.updateConnectionState();

    const settingsKey = JSON.stringify(settings);
    this.lastSettings.set(ev.action.id, settingsKey);

    const svgDataUri = generateHotkeySvg(
      settings.iconColor,
      settings.key,
      settings.ctrl,
      settings.shift,
      settings.alt,
      settings.label,
    );
    await this.setKeyImage(ev, svgDataUri);
  }

  /**
   * When the key is pressed
   */
  override async onKeyDown(ev: KeyDownEvent<HotkeySettings>): Promise<void> {
    this.logger.info("Key down received");

    const settings = ev.payload.settings;
    const combination = buildKeyCombination(settings.key, settings.ctrl, settings.shift, settings.alt);

    this.logger.debug(`Sending key combination: ${JSON.stringify(combination)}`);

    const keyboard = getKeyboard();
    const success = await keyboard.sendKeyCombination(combination);

    if (success) {
      this.logger.info(
        `Hotkey ${formatKeyCombination(settings.key, settings.ctrl, settings.shift, settings.alt)} sent successfully`,
      );
    } else {
      this.logger.warn(
        `Failed to send hotkey ${formatKeyCombination(settings.key, settings.ctrl, settings.shift, settings.alt)}`,
      );
    }
  }
}

const HotkeySettings = z.object({
  key: z.string().default("f1"),
  ctrl: z.coerce.boolean().default(false),
  shift: z.coerce.boolean().default(false),
  alt: z.coerce.boolean().default(false),
  label: z.string().default(""),
  iconColor: z.string().default(DEFAULT_ICON_COLOR),
});

/**
 * Settings for the hotkey action
 */
type HotkeySettings = z.infer<typeof HotkeySettings>;
