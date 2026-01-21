/**
 * Property Inspector Components for iRaceDeck Stream Deck plugins
 *
 * This module provides custom UI components for use in Property Inspector HTML files.
 * Include the built pi-components.js in your PI HTML:
 *
 * ```html
 * <script src="sdpi-components.js"></script>
 * <script src="pi-components.js"></script>
 * ```
 */

// Key Binding Input - click-to-record keyboard shortcut input
export {
  KeyBindingInput,
  formatKeyBinding,
  parseKeyBinding,
  type KeyBindingValue,
} from "./key-binding-input.js";
