/**
 * Chat Message Utilities
 *
 * Pure functions for chat message display logic.
 */
import { escapeXml, renderIconTemplate, svgToDataUri } from "@iracedeck/stream-deck-shared";

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
  const textElement = trimmedText ? generateTextElement(trimmedText) : "";

  const svg = renderIconTemplate(doChatMessageTemplate, { color, textElement });

  return svgToDataUri(svg);
}

/**
 * Generates SVG text element with support for multiple lines.
 * Uses tspan elements for each line, centered vertically.
 */
function generateTextElement(text: string): string {
  // Handle both Windows (\r\n) and Unix (\n) line endings
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return "";
  }

  const firstLineEm = 40 - (lines.length - 1) * 6;

  return lines
    .map((line, i) => {
      let y = i === 0 ? firstLineEm : firstLineEm + 12 * i;

      return `<text x="36" y="${y}" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-family="sans-serif" font-size="10" font-weight="bold">${escapeXml(line)}</text>\n`;
    })
    .join("");
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
