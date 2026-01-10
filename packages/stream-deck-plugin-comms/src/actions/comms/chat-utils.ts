/**
 * Chat Message Utilities
 *
 * Pure functions for chat message display logic.
 */

/**
 * Generates an SVG chat bubble icon with configurable color.
 *
 * @param color - The stroke color for the chat bubble (e.g., "#4a90d9")
 * @returns A base64-encoded data URI for the SVG
 */
export function generateChatSvg(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <path d="M14 18
           h44
           a6 6 0 0 1 6 6
           v24
           a6 6 0 0 1-6 6
           H26
           l-4 8
           l-4 -8
           H14
           a6 6 0 0 1-6-6
           V24
           a6 6 0 0 1 6-6
           z"
        fill="none"
        stroke="${color}"
        stroke-width="2.5"
        stroke-linejoin="round"/>
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
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
