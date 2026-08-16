// External links - reroute external http(s) PI link clicks to the OS default browser
import { installExternalLinkHandler } from "./external-links.js";
// Shared page poller - single per-page interval behind window.irdPoll (issue #903)
import { installSharedPoller } from "./poller.js";

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

// Voice Select - global Race Engineer voice dropdown populated from a voices-list global
export { VoiceSelect } from "./voice-select.js";

// Name Select - global Race Engineer driver-name dropdown populated from a names-list global
export { NameSelect } from "./name-select.js";

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

// Warnings Banner - global PI warning banner driven by the _warnings global setting
export { WarningsBanner } from "./warnings.js";

// Binding Status - per-mode communication / binding status line under the Mode selector
export { BindingStatus } from "./binding-status.js";

// Black Box Caveat - explains when "Show black box" can't work with the current bindings
export { BlackBoxCaveat } from "./black-box-caveat.js";

// Profile Switch - button that asks the plugin to switch to a bundled Stream Deck profile
export { ProfileSwitch } from "./profile-switch.js";

// Profile Select - dropdown of bundled profiles available for the action's device
export { ProfileSelect } from "./profile-select.js";

// Open Settings - button that asks the plugin to open the dedicated settings window (#992)
export { OpenSettings } from "./open-settings.js";

// Deck Device Select - settings-window picker for which Stream Deck a profile switch targets (#992)
export { DeckDeviceSelect } from "./deck-device-select.js";

// Shared Poller - one per-page polling interval with page-lifecycle cleanup
export { createSharedPoller, installSharedPoller, POLL_INTERVAL_MS } from "./poller.js";

// Side effect on bundle load: reroute external PI links to the default browser (issue #243).
installExternalLinkHandler();

// Side effect on bundle load: expose window.irdPoll — the shared per-page poller
// that inline PI scripts register their sdpi polling fallbacks on (issue #903).
installSharedPoller();
