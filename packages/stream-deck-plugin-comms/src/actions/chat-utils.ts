/**
 * Chat Message Utilities
 *
 * Pure functions for chat message display logic.
 */
import { generateIconText, renderIconTemplate, svgToDataUri } from "@iracedeck/stream-deck-shared";

import doChatMessageTemplate from "../icons/do-chat-message.svg";

/**
 * Generates an SVG chat bubble icon with configurable color and optional text.
 *
 * @param color - The stroke color for the chat bubble (e.g., "#4a90d9")
 * @param keyText - Optional text to display centered in the bubble
 * @returns A base64-encoded data URI for the SVG
 */
export function generateChatSvg(color: string, keyText?: string): string {
  const trimmedText = keyText?.trim();
  // Normalize line endings and filter empty lines
  const normalizedText = trimmedText
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

  const textElement = normalizedText
    ? generateIconText({ text: normalizedText, fontSize: 11, baseY: 40, lineHeightMultiplier: 1.2 })
    : "";

  const svg = renderIconTemplate(doChatMessageTemplate, { color, textElement });

  return svgToDataUri(svg);
}

/**
 * Formats a chat message for display on a Stream Deck button.
 * Truncates long messages and shows a preview.
 *
 * @param message - The chat message (may be undefined or empty)
 * @param isConnected - Whether iRacing is connected
 * @returns The title to display on the button
 */
export function formatChatTitle(message: string | undefined, isConnected: boolean): string {
  if (!isConnected) {
    return "iRacing\nnot\nconnected";
  }

  const trimmed = message?.trim();

  if (!trimmed) {
    return "";
  }

  // Truncate long messages for display
  return trimmed.length > 20 ? trimmed.substring(0, 17) + "..." : trimmed;
}

/**
 * Default icon color for chat messages.
 */
export const DEFAULT_ICON_COLOR = "#4a90d9";

/**
 * Debug helper to inspect keyText value and its character codes.
 * Useful for debugging newline handling issues.
 *
 * @param keyText - The text to inspect
 * @returns Debug info string
 */
export function debugKeyText(keyText: string): string {
  const chars = [...keyText].map((c) => c.charCodeAt(0));

  return `keyText: ${JSON.stringify(keyText)}, chars: [${chars.join(", ")}]`;
}
