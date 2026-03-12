import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import cancelIcon from "@iracedeck/icons/chat/cancel.svg";
import openChatIcon from "@iracedeck/icons/chat/open-chat.svg";
import replyIcon from "@iracedeck/icons/chat/reply.svg";
import respondPmIcon from "@iracedeck/icons/chat/respond-pm.svg";
import whisperIcon from "@iracedeck/icons/chat/whisper.svg";
import { buildTemplateContext, resolveTemplate } from "@iracedeck/iracing-sdk";
import z from "zod";

import {
  CommonSettings,
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
 * Standalone SVG templates for standard chat modes (imported from @iracedeck/icons).
 * Send-message and macro modes use separate inline templates with dynamic text.
 */
const CHAT_ICONS: Partial<Record<ChatMode, string>> = {
  "open-chat": openChatIcon,
  reply: replyIcon,
  whisper: whisperIcon,
  "respond-pm": respondPmIcon,
  cancel: cancelIcon,
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

const ChatSettings = CommonSettings.extend({
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

  // For other modes: use standalone SVG templates from @iracedeck/icons
  const iconSvg = CHAT_ICONS[mode] || CHAT_ICONS["open-chat"]!;

  // Determine labels: use custom key text or default labels
  const trimmedKeyText = keyText?.trim();
  let mainLabel: string;
  let subLabel: string;

  if (trimmedKeyText) {
    // Parse custom key text (supports newlines for two-line display)
    const lines = trimmedKeyText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length >= 2) {
      mainLabel = lines[0];
      subLabel = lines[1];
    } else {
      mainLabel = lines[0] || "";
      subLabel = "";
    }
  } else {
    // Use default labels for the mode
    const labels = CHAT_LABELS[mode] || CHAT_LABELS["open-chat"];
    mainLabel = labels.line1;
    subLabel = labels.line2;
  }

  const svg = renderIconTemplate(iconSvg, {
    color: iconColor,
    mainLabel,
    subLabel,
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

  private activeContexts = new Map<string, ChatSettings>();
  private lastRenderedIcon = new Map<string, string>();

  override async onWillAppear(ev: WillAppearEvent<ChatSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();

      const storedSettings = this.activeContexts.get(ev.action.id);

      if (storedSettings && this.hasTemplateVars(storedSettings)) {
        this.updateIconFromTelemetry(ev.action.id, storedSettings);
      }
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<ChatSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.activeContexts.delete(ev.action.id);
    this.lastRenderedIcon.delete(ev.action.id);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ChatSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.lastRenderedIcon.delete(ev.action.id);
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

    // Collapse newlines into spaces (textarea allows multiline editing but chat is single-line)
    let resolvedMessage = trimmed.replace(/\r?\n/g, " ").replace(/\s{2,}/g, " ");

    // Resolve template variables if message contains {{...}} placeholders
    if (resolvedMessage.includes("{{")) {
      const context = buildTemplateContext(this.sdkController);
      resolvedMessage = resolveTemplate(resolvedMessage, context);
      this.logger.debug(`Resolved template: "${resolvedMessage}"`);
    }

    const chat = getCommands().chat;
    const success = chat.sendMessage(resolvedMessage);
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

  private hasTemplateVars(settings: ChatSettings): boolean {
    return settings.keyText.includes("{{");
  }

  private resolveSettingsTemplates(settings: ChatSettings): ChatSettings {
    if (!this.hasTemplateVars(settings)) return settings;

    const context = buildTemplateContext(this.sdkController);
    const resolvedKeyText = resolveTemplate(settings.keyText, context);

    return { ...settings, keyText: resolvedKeyText };
  }

  private async updateIconFromTelemetry(contextId: string, settings: ChatSettings): Promise<void> {
    const resolved = this.resolveSettingsTemplates(settings);
    const svgDataUri = generateChatSvg(resolved);

    if (this.lastRenderedIcon.get(contextId) !== svgDataUri) {
      this.lastRenderedIcon.set(contextId, svgDataUri);
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }

  private async updateDisplay(
    ev: WillAppearEvent<ChatSettings> | DidReceiveSettingsEvent<ChatSettings>,
    settings: ChatSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const resolved = this.resolveSettingsTemplates(settings);
    const svgDataUri = generateChatSvg(resolved);
    this.lastRenderedIcon.set(ev.action.id, svgDataUri);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
