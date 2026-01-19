import streamDeck, { action, KeyDownEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  generateIconText,
  getCommands,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import doChatMacroTemplate from "../icons/do-chat-macro.svg";

const DEFAULT_ICON_COLOR = "#4a90d9";

/**
 * Generates an SVG icon for the chat macro action.
 *
 * @param color - The stroke color for the chat bubble
 * @param macroNum - The macro number to display (1-15)
 * @param keyText - Optional custom text to display instead of macro number
 * @returns A base64-encoded data URI for the SVG
 */
function generateMacroSvg(color: string, macroNum: number, keyText?: string): string {
  const trimmedText = keyText?.trim();
  let displayText: string;
  let textElement: string;

  if (trimmedText) {
    // Normalize line endings and filter empty lines
    displayText = trimmedText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");

    textElement = generateIconText({ text: displayText, fontSize: 10, baseY: 40, lineHeightMultiplier: 1.2 });
  } else {
    displayText = `Macro ${macroNum}`;
    textElement = generateIconText({ text: "Macro", fontSize: 10, baseY: 30, lineHeightMultiplier: 1.2 });
    textElement =
      textElement + generateIconText({ text: "" + macroNum, fontSize: 25, baseY: 52, lineHeightMultiplier: 1.2 });
  }

  const svg = renderIconTemplate(doChatMacroTemplate, {
    color,
    textElement,
  });

  return svgToDataUri(svg);
}

/**
 * Do Chat Macro Action
 * Triggers a pre-configured chat macro (1-15) in iRacing when pressed
 */
@action({ UUID: "com.iracedeck.sd.comms.do-chat-macro" })
export class DoChatMacro extends ConnectionStateAwareAction<MacroSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("DoChatMacro"), LogLevel.Info);

  private get chatCommand() {
    return getCommands().chat;
  }

  private activeContexts = new Map<string, MacroSettings>();
  private lastIconColor = new Map<string, string>();
  private lastMacroNum = new Map<string, number>();
  private lastKeyText = new Map<string, string>();

  /**
   * When the action appears on the Stream Deck
   */
  override async onWillAppear(ev: WillAppearEvent<MacroSettings>): Promise<void> {
    const parsed = MacroSettings.safeParse(ev.payload.settings);
    const settings = parsed.success ? parsed.data : MacroSettings.parse({});

    const original = ev.payload.settings;
    const settingsChanged =
      settings.macroNum !== original.macroNum ||
      settings.iconColor !== original.iconColor ||
      settings.keyText !== original.keyText;

    ev.payload.settings = settings;
    this.activeContexts.set(ev.action.id, settings);

    if (settingsChanged) {
      await ev.action.setSettings(settings);
    }

    await this.updateDisplayWithEvent(ev);

    this.sdkController.subscribe(ev.action.id, (_telemetry, isConnected) => {
      this.updateConnectionState();

      const settings = this.activeContexts.get(ev.action.id);

      if (settings) {
        this.updateDisplay(ev.action.id, settings, isConnected);
      }
    });
  }

  /**
   * When the action disappears from the Stream Deck
   */
  override async onWillDisappear(ev: WillDisappearEvent<MacroSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastIconColor.delete(ev.action.id);
    this.lastMacroNum.delete(ev.action.id);
    this.lastKeyText.delete(ev.action.id);
  }

  /**
   * Update display using an event (for initial setup, stores action ref)
   */
  private async updateDisplayWithEvent(ev: WillAppearEvent<MacroSettings>): Promise<void> {
    const settings = ev.payload.settings;

    this.updateConnectionState();

    this.lastIconColor.set(ev.action.id, settings.iconColor);
    this.lastMacroNum.set(ev.action.id, settings.macroNum);
    this.lastKeyText.set(ev.action.id, settings.keyText);

    const svgDataUri = generateMacroSvg(settings.iconColor, settings.macroNum, settings.keyText);
    await this.setKeyImage(ev, svgDataUri);
  }

  /**
   * Update the display for a specific context (called from subscription callback)
   */
  private async updateDisplay(contextId: string, settings: MacroSettings, _isConnected: boolean): Promise<void> {
    const lastColor = this.lastIconColor.get(contextId);
    const lastNum = this.lastMacroNum.get(contextId);
    const lastText = this.lastKeyText.get(contextId);

    if (lastColor !== settings.iconColor || lastNum !== settings.macroNum || lastText !== settings.keyText) {
      this.lastIconColor.set(contextId, settings.iconColor);
      this.lastMacroNum.set(contextId, settings.macroNum);
      this.lastKeyText.set(contextId, settings.keyText);

      const svgDataUri = generateMacroSvg(settings.iconColor, settings.macroNum, settings.keyText);
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }

  /**
   * When settings are received or updated
   */
  override async onDidReceiveSettings(ev: any): Promise<void> {
    const parsed = MacroSettings.safeParse(ev.payload.settings);
    const settings = parsed.success ? parsed.data : MacroSettings.parse({});

    this.activeContexts.set(ev.action.id, settings);

    this.updateConnectionState();

    this.lastIconColor.set(ev.action.id, settings.iconColor);
    this.lastMacroNum.set(ev.action.id, settings.macroNum);
    this.lastKeyText.set(ev.action.id, settings.keyText);

    const svgDataUri = generateMacroSvg(settings.iconColor, settings.macroNum, settings.keyText);
    await this.setKeyImage(ev, svgDataUri);
  }

  /**
   * When the key is pressed
   */
  override async onKeyDown(ev: KeyDownEvent<MacroSettings>): Promise<void> {
    this.logger.info("Key down received");

    const macroNum = ev.payload.settings.macroNum;

    if (!this.sdkController.getConnectionStatus()) {
      this.logger.info("Not connected to iRacing");

      return;
    }

    const success = this.chatCommand.macro(macroNum);

    if (success) {
      this.logger.info(`Macro ${macroNum} triggered successfully`);
    } else {
      this.logger.warn(`Failed to trigger macro ${macroNum}`);
    }
  }
}

const MacroSettings = z.object({
  macroNum: z.coerce.number().min(1).max(15).default(1),
  keyText: z.string().default(""),
  iconColor: z.string().default(DEFAULT_ICON_COLOR),
});

/**
 * Settings for the chat macro action
 */
type MacroSettings = z.infer<typeof MacroSettings>;
