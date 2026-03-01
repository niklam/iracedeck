import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import z from "zod";

import chatTemplate from "../../icons/chat.svg";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  generateIconText,
  getCommands,
  getGlobalSettings,
  getKeyboard,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  LogLevel,
  parseKeyBinding,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";

const WHITE = "#ffffff";
const COLOR_PLACEHOLDER = "{{color}}";

/**
 * SVG template for send-message mode: large chat bubble with text inside.
 * Has the same background as other chat modes, with a black-filled bubble for contrast.
 */
const SEND_MESSAGE_TEMPLATE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g filter="url(#activity-state)">
    <!-- Main background (matches other chat modes) -->
    <rect x="0" y="0" width="72" height="72" rx="8" fill="#2a3a4a"/>
    <!-- Chat bubble with black fill for text contrast -->
    <path d="M14 14 h45 a6 6 0 0 1 6 6 v34 a6 6 0 0 1-6 6 H29 l-4 8 l-4 -8 H13 a6 6 0 0 1-6-6 V20 a6 6 0 0 1 6-6 z"
          fill="#000000" stroke="{{color}}" stroke-width="2.5" stroke-linejoin="round"/>
    {{textElement}}
  </g>
</svg>`;

/**
 * SVG template for macro mode: large chat bubble with text inside (no background).
 * Matches the old do-chat-macro.svg style.
 */
const MACRO_TEMPLATE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g filter="url(#activity-state)">
    <path d="M14 14 h45 a6 6 0 0 1 6 6 v34 a6 6 0 0 1-6 6 H29 l-4 8 l-4 -8 H13 a6 6 0 0 1-6-6 V20 a6 6 0 0 1 6-6 z"
          fill="none" stroke="{{color}}" stroke-width="2.5" stroke-linejoin="round"/>
    {{textElement}}
  </g>
</svg>`;

type ChatMode = "open-chat" | "reply" | "whisper" | "respond-pm" | "cancel" | "send-message" | "macro";

/**
 * Label configuration for each chat mode (line1 bold, line2 subdued)
 */
const CHAT_LABELS: Record<ChatMode, { line1: string; line2: string }> = {
  "open-chat": { line1: "OPEN", line2: "CHAT" },
  reply: { line1: "REPLY", line2: "CHAT" },
  whisper: { line1: "WHISPER", line2: "CHAT" },
  "respond-pm": { line1: "RESPOND", line2: "LAST PM" },
  cancel: { line1: "CANCEL", line2: "CHAT" },
  "send-message": { line1: "SEND", line2: "MESSAGE" },
  macro: { line1: "CHAT", line2: "MACRO" },
};

/**
 * SVG icon content for each chat mode
 * Uses {{color}} placeholder for user-configurable accent color
 */
const CHAT_ICONS: Record<ChatMode, string> = {
  // Open Chat: Chat bubble with pencil icon
  "open-chat": `
    <path d="M16 10 h40 a4 4 0 0 1 4 4 v20 a4 4 0 0 1-4 4 H38 l-3 5 l-3-5 H16 a4 4 0 0 1-4-4 V14 a4 4 0 0 1 4-4 z"
          fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <line x1="28" y1="28" x2="40" y2="18" stroke="${COLOR_PLACEHOLDER}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="28" y1="28" x2="30" y2="26" stroke="${COLOR_PLACEHOLDER}" stroke-width="3" stroke-linecap="round"/>`,

  // Reply: Chat bubble with curved reply arrow
  reply: `
    <path d="M16 10 h40 a4 4 0 0 1 4 4 v20 a4 4 0 0 1-4 4 H38 l-3 5 l-3-5 H16 a4 4 0 0 1-4-4 V14 a4 4 0 0 1 4-4 z"
          fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M30 18 L24 23 L30 28" fill="none" stroke="${COLOR_PLACEHOLDER}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M24 23 H38 A4 4 0 0 1 42 27" fill="none" stroke="${COLOR_PLACEHOLDER}" stroke-width="2" stroke-linecap="round"/>`,

  // Whisper: Chat bubble with ear/wave icon
  whisper: `
    <path d="M16 10 h40 a4 4 0 0 1 4 4 v20 a4 4 0 0 1-4 4 H38 l-3 5 l-3-5 H16 a4 4 0 0 1-4-4 V14 a4 4 0 0 1 4-4 z"
          fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M30 18 A4 4 0 0 1 30 28" fill="none" stroke="${COLOR_PLACEHOLDER}" stroke-width="2" stroke-linecap="round"/>
    <path d="M34 15 A8 8 0 0 1 34 31" fill="none" stroke="${COLOR_PLACEHOLDER}" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M38 12 A12 12 0 0 1 38 34" fill="none" stroke="${COLOR_PLACEHOLDER}" stroke-width="1" stroke-linecap="round"/>`,

  // Respond to Last PM: Chat bubble with "/r" text
  "respond-pm": `
    <path d="M16 10 h40 a4 4 0 0 1 4 4 v20 a4 4 0 0 1-4 4 H38 l-3 5 l-3-5 H16 a4 4 0 0 1-4-4 V14 a4 4 0 0 1 4-4 z"
          fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <text x="36" y="24" text-anchor="middle" dominant-baseline="central"
          fill="${COLOR_PLACEHOLDER}" font-family="Arial, sans-serif" font-size="14" font-weight="bold">/r</text>`,

  // Cancel: Chat bubble with X overlay
  cancel: `
    <path d="M16 10 h40 a4 4 0 0 1 4 4 v20 a4 4 0 0 1-4 4 H38 l-3 5 l-3-5 H16 a4 4 0 0 1-4-4 V14 a4 4 0 0 1 4-4 z"
          fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <line x1="28" y1="17" x2="44" y2="29" stroke="${COLOR_PLACEHOLDER}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="44" y1="17" x2="28" y2="29" stroke="${COLOR_PLACEHOLDER}" stroke-width="2.5" stroke-linecap="round"/>`,

  // Send Message: Chat bubble with right-pointing arrow
  "send-message": `
    <path d="M16 10 h40 a4 4 0 0 1 4 4 v20 a4 4 0 0 1-4 4 H38 l-3 5 l-3-5 H16 a4 4 0 0 1-4-4 V14 a4 4 0 0 1 4-4 z"
          fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <line x1="24" y1="23" x2="42" y2="23" stroke="${COLOR_PLACEHOLDER}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="38,18 44,23 38,28" fill="none" stroke="${COLOR_PLACEHOLDER}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,

  // Macro: Chat bubble with # symbol
  macro: `
    <path d="M16 10 h40 a4 4 0 0 1 4 4 v20 a4 4 0 0 1-4 4 H38 l-3 5 l-3-5 H16 a4 4 0 0 1-4-4 V14 a4 4 0 0 1 4-4 z"
          fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <text x="36" y="24" text-anchor="middle" dominant-baseline="central"
          fill="${COLOR_PLACEHOLDER}" font-family="Arial, sans-serif" font-size="16" font-weight="bold">#</text>`,
};

/**
 * @internal Exported for testing
 *
 * Mapping from keyboard-based chat modes to global settings keys.
 * SDK-based modes are NOT included.
 */
export const CHAT_GLOBAL_KEYS: Record<string, string> = {
  whisper: "chatWhisper",
};

const ChatSettings = z.object({
  mode: z.enum(["open-chat", "reply", "whisper", "respond-pm", "cancel", "send-message", "macro"]).default("open-chat"),
  message: z.string().default(""),
  macroNumber: z.coerce.number().min(1).max(15).default(1),
  iconColor: z.string().default("#4a90d9"),
  keyText: z.string().default(""),
});

type ChatSettings = z.infer<typeof ChatSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the chat action.
 * Supports user-configurable icon color and key text.
 *
 * For "send-message" mode: renders a large chat bubble with message text inside.
 * For other modes: renders icon with accent color and labels below.
 */
export function generateChatSvg(settings: ChatSettings): string {
  const { mode, iconColor, keyText, message } = settings;

  // Special handling for send-message mode: render text inside the bubble
  if (mode === "send-message") {
    return generateSendMessageSvg(iconColor, keyText, message);
  }

  // Special handling for macro mode: bubble with "Macro" + number or custom text
  if (mode === "macro") {
    return generateMacroSvg(iconColor, keyText, settings.macroNumber);
  }

  // For other modes: standard icon + labels approach
  const baseIconContent = CHAT_ICONS[mode] || CHAT_ICONS["open-chat"];
  const iconContent = baseIconContent.replace(/\{\{color\}\}/g, iconColor);

  // Determine labels: use custom key text or default labels
  const trimmedKeyText = keyText?.trim();
  let labelLine1: string;
  let labelLine2: string;

  if (trimmedKeyText) {
    // Parse custom key text (supports newlines for two-line display)
    const lines = trimmedKeyText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length >= 2) {
      labelLine1 = lines[0];
      labelLine2 = lines[1];
    } else {
      labelLine1 = lines[0] || "";
      labelLine2 = "";
    }
  } else {
    // Use default labels for the mode
    const labels = CHAT_LABELS[mode] || CHAT_LABELS["open-chat"];
    labelLine1 = labels.line1;
    labelLine2 = labels.line2;
  }

  const svg = renderIconTemplate(chatTemplate, {
    iconContent,
    labelLine1,
    labelLine2,
  });

  return svgToDataUri(svg);
}

/**
 * @internal Exported for testing
 *
 * Generates SVG for send-message mode: large chat bubble with text inside.
 */
export function generateSendMessageSvg(iconColor: string, keyText: string, message: string): string {
  // Prefer keyText, fall back to message
  const displayText = keyText?.trim() || message?.trim() || "";

  // Normalize line endings and filter empty lines
  const normalizedText = displayText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

  // Generate text element positioned inside the bubble (centered around y=40)
  const textElement = normalizedText
    ? generateIconText({ text: normalizedText, fontSize: 11, baseY: 40, lineHeightMultiplier: 1.2 })
    : "";

  const svg = renderIconTemplate(SEND_MESSAGE_TEMPLATE, { color: iconColor, textElement });

  return svgToDataUri(svg);
}

/**
 * @internal Exported for testing
 *
 * Generates SVG for macro mode: chat bubble with "Macro" + number or custom text.
 * Matches the old do-chat-macro style.
 */
export function generateMacroSvg(iconColor: string, keyText: string, macroNumber: number): string {
  const trimmedText = keyText?.trim();
  let textElement: string;

  if (trimmedText) {
    // Custom text: normalize line endings and filter empty lines
    const normalizedText = trimmedText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");

    textElement = generateIconText({ text: normalizedText, fontSize: 10, baseY: 40, lineHeightMultiplier: 1.2 });
  } else {
    // Default: "Macro" text on top, large number below
    textElement = generateIconText({ text: "Macro", fontSize: 10, baseY: 30, lineHeightMultiplier: 1.2 });
    textElement += generateIconText({ text: String(macroNumber), fontSize: 25, baseY: 52, lineHeightMultiplier: 1.2 });
  }

  const svg = renderIconTemplate(MACRO_TEMPLATE, { color: iconColor, textElement });

  return svgToDataUri(svg);
}

/**
 * Chat Action
 * Provides text chat operations (open, reply, whisper, respond to last PM,
 * cancel, send message, macros).
 * SDK-based modes use chat commands; whisper uses global key binding.
 */
@action({ UUID: "com.iracedeck.sd.core.chat" })
export class Chat extends ConnectionStateAwareAction<ChatSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("Chat"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<ChatSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<ChatSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ChatSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<ChatSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeMode(settings.mode, settings);
  }

  override async onDialDown(ev: DialDownEvent<ChatSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeMode(settings.mode, settings);
  }

  override async onDialRotate(_ev: DialRotateEvent<ChatSettings>): Promise<void> {
    this.logger.debug("Dial rotation ignored for chat action");
  }

  private parseSettings(settings: unknown): ChatSettings {
    const parsed = ChatSettings.safeParse(settings);

    return parsed.success ? parsed.data : ChatSettings.parse({});
  }

  private async executeMode(mode: ChatMode, settings: ChatSettings): Promise<void> {
    switch (mode) {
      // SDK-based modes
      case "open-chat":
        this.executeSdkBeginChat();
        break;
      case "reply":
        this.executeSdkReply();
        break;
      case "respond-pm":
        this.executeSdkReply();
        break;
      case "cancel":
        this.executeSdkCancel();
        break;
      case "send-message":
        this.executeSdkSendMessage(settings.message);
        break;
      case "macro":
        this.executeSdkMacro(settings.macroNumber);
        break;

      // Keyboard-based mode
      case "whisper":
        await this.executeKeyboardMode(mode);
        break;
    }
  }

  private executeSdkBeginChat(): void {
    const chat = getCommands().chat;
    const success = chat.beginChat();
    this.logger.info("Open chat executed");
    this.logger.debug(`Result: ${success}`);
  }

  private executeSdkReply(): void {
    const chat = getCommands().chat;
    const success = chat.reply();
    this.logger.info("Reply executed");
    this.logger.debug(`Result: ${success}`);
  }

  private executeSdkCancel(): void {
    const chat = getCommands().chat;
    const success = chat.cancel();
    this.logger.info("Cancel chat executed");
    this.logger.debug(`Result: ${success}`);
  }

  private executeSdkSendMessage(message: string): void {
    const trimmed = message?.trim();

    if (!trimmed) {
      this.logger.warn("No message configured");

      return;
    }

    const chat = getCommands().chat;
    const success = chat.sendMessage(trimmed);
    this.logger.info("Send message executed");
    this.logger.debug(`Result: ${success}`);
  }

  private executeSdkMacro(macroNumber: number): void {
    const chat = getCommands().chat;
    const success = chat.macro(macroNumber);
    this.logger.info("Chat macro executed");
    this.logger.debug(`Macro number: ${macroNumber}, result: ${success}`);
  }

  private async executeKeyboardMode(mode: ChatMode): Promise<void> {
    const settingKey = CHAT_GLOBAL_KEYS[mode];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for mode: ${mode}`);

      return;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return;
    }

    const combination: KeyCombination = {
      key: binding.key as KeyboardKey,
      modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
      code: binding.code,
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
    ev: WillAppearEvent<ChatSettings> | DidReceiveSettingsEvent<ChatSettings>,
    settings: ChatSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateChatSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
