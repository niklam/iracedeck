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

// Autocomplete Input - text input with dropdown suggestions
export { AutocompleteInput } from "./autocomplete-input.js";

// Audio Device Select - global audio output device dropdown populated from a device-list global
export { AudioDeviceSelect } from "./audio-device-select.js";

// Audio Test - button that bumps a hidden per-action timestamp to trigger preview playback
export { AudioTest } from "./audio-test.js";

// Color Picker - custom color picker with "not set" state and inline hex display
export { ColorPicker } from "./color-picker.js";

// Range Input - slider with synced number input for numeric settings
export { RangeInput } from "./range-input.js";

// Key Binding Input - click-to-record keyboard shortcut input
export {
  KeyBindingInput,
  formatKeyBinding,
  parseKeyBinding,
  parseSimpleDefault,
  type KeyBindingValue,
} from "./key-binding-input.js";
