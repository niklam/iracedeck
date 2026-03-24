import {
  CommonSettings,
  ConnectionStateAwareAction,
  generateIconText,
  getCommands,
  getGlobalColors,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "@iracedeck/deck-core";
import cancelIcon from "@iracedeck/icons/chat/cancel.svg";
import openChatIcon from "@iracedeck/icons/chat/open-chat.svg";
import replyIcon from "@iracedeck/icons/chat/reply.svg";
import respondPmIcon from "@iracedeck/icons/chat/respond-pm.svg";
import whisperIcon from "@iracedeck/icons/chat/whisper.svg";
import { buildTemplateContext, resolveTemplate } from "@iracedeck/iracing-sdk";
import z from "zod";

/**
 * SVG template for send-message mode: large chat bubble with text inside.
 * Has the same background as other chat modes, with a black-filled bubble for contrast.
 */
const SEND_MESSAGE_TEMPLATE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <desc>{"colors":{"backgroundColor":"#2a3a4a","textColor":"#ffffff","graphic1Color":"#4a90d9","graphic2Color":"#000000"}}</desc>
  <g filter="url(#activity-state)">
    <rect x="0" y="0" width="144" height="144" fill="{{backgroundColor}}"/>
    <path d="M28 28 h90 a12 12 0 0 1 12 12 v68 a12 12 0 0 1-12 12 H58 l-8 16 l-8 -16 H26 a12 12 0 0 1-12-12 V40 a12 12 0 0 1 12-12 z"
          fill="{{graphic2Color}}" stroke="{{graphic1Color}}" stroke-width="5" stroke-linejoin="round"/>
    {{textElement}}
  </g>
</svg>`;

/**
 * SVG template for macro mode: large chat bubble with text inside (no background).
 * Matches the old do-chat-macro.svg style.
 */
const MACRO_TEMPLATE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <desc>{"colors":{"backgroundColor":"#2a3a4a","textColor":"#ffffff","graphic1Color":"#4a90d9","graphic2Color":"none"}}</desc>
  <g filter="url(#activity-state)">
    <rect x="0" y="0" width="144" height="144" fill="{{backgroundColor}}"/>
    <path d="M28 28 h90 a12 12 0 0 1 12 12 v68 a12 12 0 0 1-12 12 H58 l-8 16 l-8 -16 H26 a12 12 0 0 1-12-12 V40 a12 12 0 0 1 12-12 z"
          fill="{{graphic2Color}}" stroke="{{graphic1Color}}" stroke-width="5" stroke-linejoin="round"/>
    {{textElement}}
  </g>
</svg>`;

type ChatMode = "send-message" | "macro" | "reply" | "respond-pm" | "whisper" | "open-chat" | "cancel";

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
  mode: z
    .enum(["send-message", "macro", "reply", "respond-pm", "whisper", "open-chat", "cancel"])
    .default("send-message"),
  message: z.string().default(""),
  macroNumber: z.coerce.number().min(1).max(15).default(1),
  iconColor: z.string().default("#4a90d9"),
  keyText: z.string().default(""),
  fontSize: z.coerce.number().min(5).max(36).default(11),
});

type ChatSettings = z.infer<typeof ChatSettings>;

/**
 * @internal Exported for testing
 *
 * Checks whether chat settings contain mustache template variables in keyText or message.
 */
export function hasTemplateVars(settings: { keyText: string; message: string }): boolean {
  return settings.keyText.includes("{{") || settings.message.includes("{{");
}

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
  const { mode, iconColor, keyText } = settings;

  // Special handling for send-message mode: render text inside the bubble
  if (mode === "send-message") {
    return generateSendMessageSvg(settings);
  }

  // Special handling for macro mode: bubble with "Macro" + number or custom text
  if (mode === "macro") {
    return generateMacroSvg(settings);
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

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    color: iconColor,
    mainLabel,
    subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * @internal Exported for testing
 *
 * Generates SVG for send-message mode: large chat bubble with text inside.
 */
export function generateSendMessageSvg(settings: ChatSettings): string {
  const { keyText, message, fontSize, iconColor } = settings;
  // Prefer keyText, fall back to message
  const displayText = keyText?.trim() || message?.trim() || "";

  // Normalize line endings and filter empty lines
  const normalizedText = displayText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

  // Resolve colors: map legacy iconColor to graphic1Color if no override set
  const colors = resolveIconColors(SEND_MESSAGE_TEMPLATE, getGlobalColors(), {
    ...settings.colorOverrides,
    graphic1Color: settings.colorOverrides?.graphic1Color || iconColor,
  });

  // Adjust vertical position based on font size (144x144 coordinates)
  const scaledFontSize = fontSize * 2;
  const baseY = 80 + ((fontSize - 11) / 3) * 2;

  // Generate text element positioned inside the bubble
  const textElement = normalizedText
    ? generateIconText({
        text: normalizedText,
        fontSize: scaledFontSize,
        baseY,
        centerX: 72,
        lineHeightMultiplier: 1.2,
        fill: colors.textColor,
      })
    : "";

  const svg = renderIconTemplate(SEND_MESSAGE_TEMPLATE, { ...colors, textElement });

  return svgToDataUri(svg);
}

/**
 * @internal Exported for testing
 *
 * Generates SVG for macro mode: chat bubble with "Macro" + number or custom text.
 * Matches the old do-chat-macro style.
 */
export function generateMacroSvg(settings: ChatSettings): string {
  const { keyText, macroNumber, fontSize, iconColor } = settings;
  const trimmedText = keyText?.trim();
  let textElement: string;

  // Resolve colors: map legacy iconColor to graphic1Color if no override set
  const colors = resolveIconColors(MACRO_TEMPLATE, getGlobalColors(), {
    ...settings.colorOverrides,
    graphic1Color: settings.colorOverrides?.graphic1Color || iconColor,
  });

  if (trimmedText) {
    // Custom text: normalize line endings and filter empty lines
    const normalizedText = trimmedText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");

    // Adjust vertical position based on font size (144x144 coordinates)
    const scaledFontSize = fontSize * 2;
    const baseY = 80 + ((fontSize - 10) / 3) * 2;

    textElement = generateIconText({
      text: normalizedText,
      fontSize: scaledFontSize,
      baseY,
      centerX: 72,
      lineHeightMultiplier: 1.2,
      fill: colors.textColor,
    });
  } else {
    // Default: "Macro" text on top, large number below (144x144 coordinates)
    textElement = generateIconText({
      text: "Macro",
      fontSize: 20,
      baseY: 60,
      centerX: 72,
      lineHeightMultiplier: 1.2,
      fill: colors.textColor,
    });
    textElement += generateIconText({
      text: String(macroNumber),
      fontSize: 50,
      baseY: 104,
      centerX: 72,
      lineHeightMultiplier: 1.2,
      fill: colors.textColor,
    });
  }

  const svg = renderIconTemplate(MACRO_TEMPLATE, { ...colors, textElement });

  return svgToDataUri(svg);
}

/**
 * Chat Action
 * Provides text chat operations (open, reply, whisper, respond to last PM,
 * cancel, send message, macros).
 * SDK-based modes use chat commands; whisper uses global key binding.
 */
export const CHAT_UUID = "com.iracedeck.sd.core.chat" as const;

export class Chat extends ConnectionStateAwareAction<ChatSettings> {
  private activeContexts = new Map<string, ChatSettings>();
  private lastRenderedIcon = new Map<string, string>();

  override async onWillAppear(ev: IDeckWillAppearEvent<ChatSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    const activeKey = CHAT_GLOBAL_KEYS[settings.mode];

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }

    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      const storedSettings = this.activeContexts.get(ev.action.id);

      if (storedSettings && hasTemplateVars(storedSettings)) {
        this.updateIconFromTelemetry(ev.action.id, storedSettings);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<ChatSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.activeContexts.delete(ev.action.id);
    this.lastRenderedIcon.delete(ev.action.id);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<ChatSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.lastRenderedIcon.delete(ev.action.id);
    const activeKey = CHAT_GLOBAL_KEYS[settings.mode];

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<ChatSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeMode(settings.mode, settings);
  }

  override async onDialDown(ev: IDeckDialDownEvent<ChatSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeMode(settings.mode, settings);
  }

  override async onDialRotate(_ev: IDeckDialRotateEvent<ChatSettings>): Promise<void> {
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
      case "whisper": {
        const settingKey = CHAT_GLOBAL_KEYS[mode];

        if (!settingKey) {
          this.logger.warn(`No global key mapping for mode: ${mode}`);

          return;
        }

        await this.tapBinding(settingKey);
        break;
      }
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

  /** Resolves template variables for display only (icon rendering).
   *  The send path in executeSdkSendMessage performs its own resolution at send time. */
  private resolveSettingsTemplates(settings: ChatSettings): ChatSettings {
    if (!hasTemplateVars(settings)) return settings;

    const context = buildTemplateContext(this.sdkController);
    const resolvedKeyText = resolveTemplate(settings.keyText, context);
    const resolvedMessage = resolveTemplate(settings.message, context);

    return { ...settings, keyText: resolvedKeyText, message: resolvedMessage };
  }

  private async updateIconFromTelemetry(contextId: string, settings: ChatSettings): Promise<void> {
    const resolved = this.resolveSettingsTemplates(settings);
    const svgDataUri = generateChatSvg(resolved);

    if (this.lastRenderedIcon.get(contextId) !== svgDataUri) {
      this.lastRenderedIcon.set(contextId, svgDataUri);
      await this.updateKeyImage(contextId, svgDataUri);
      this.setRegenerateCallback(contextId, () => generateChatSvg(resolved));
    }
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<ChatSettings> | IDeckDidReceiveSettingsEvent<ChatSettings>,
    settings: ChatSettings,
  ): Promise<void> {
    const resolved = this.resolveSettingsTemplates(settings);
    const svgDataUri = generateChatSvg(resolved);
    this.lastRenderedIcon.set(ev.action.id, svgDataUri);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateChatSvg(resolved));
  }
}
