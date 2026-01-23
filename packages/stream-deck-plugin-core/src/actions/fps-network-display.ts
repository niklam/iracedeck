import streamDeck, {
  action,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  generateIconText,
  getGlobalSettings,
  getKeyboard,
  type KeyBindingValue,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  LogLevel,
  parseKeyBinding,
  renderIconTemplate,
  svgToDataUri,
} from "@iracedeck/stream-deck-shared";

import fpsNetworkDisplayTemplate from "../../icons/fps-network-display.svg";

/**
 * Default icon color for the FPS/Network display action.
 * @internal Exported for testing
 */
export const DEFAULT_ICON_COLOR = "#ffffff";

/**
 * Global settings key for FPS/Network display toggle.
 * @internal Exported for testing
 */
export const GLOBAL_KEY_FPS_NETWORK = "fpsNetworkDisplay";

/**
 * Generates an SVG icon for the FPS/Network display action.
 * @internal Exported for testing
 */
export function generateFpsNetworkDisplaySvg(): string {
  const color = DEFAULT_ICON_COLOR;

  const textElement = generateIconText({
    text: "FPS/Net",
    fontSize: 11,
    baseY: 58,
    lineHeightMultiplier: 1.2,
  });

  const svg = renderIconTemplate(fpsNetworkDisplayTemplate, {
    color,
    textElement,
  });

  return svgToDataUri(svg);
}

/**
 * FPS/Network Display Action
 * Toggles the FPS and network statistics overlay via keyboard shortcut.
 */
@action({ UUID: "com.iracedeck.sd.core.fps-network-display" })
export class FpsNetworkDisplay extends ConnectionStateAwareAction<Record<string, never>> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("FpsNetworkDisplay"), LogLevel.Info);

  /**
   * When the action appears on the Stream Deck
   */
  override async onWillAppear(ev: WillAppearEvent<Record<string, never>>): Promise<void> {
    await this.updateDisplay(ev);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  /**
   * When the action disappears from the Stream Deck
   */
  override async onWillDisappear(ev: WillDisappearEvent<Record<string, never>>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  /**
   * When settings are received or updated
   */
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Record<string, never>>): Promise<void> {
    await this.updateDisplay(ev);
  }

  /**
   * Update display with current settings
   */
  private async updateDisplay(
    ev: WillAppearEvent<Record<string, never>> | DidReceiveSettingsEvent<Record<string, never>>,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateFpsNetworkDisplaySvg();
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }

  /**
   * When the key is pressed
   */
  override async onKeyDown(_ev: KeyDownEvent<Record<string, never>>): Promise<void> {
    this.logger.info("FPS/Network display toggle triggered");

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[GLOBAL_KEY_FPS_NETWORK]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${GLOBAL_KEY_FPS_NETWORK}`);

      return;
    }

    await this.sendKeyBinding(binding);
  }

  /**
   * Send a key binding via the keyboard interface
   */
  private async sendKeyBinding(binding: KeyBindingValue): Promise<void> {
    const combination: KeyCombination = {
      key: binding.key as KeyboardKey,
      modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
    };

    this.logger.debug(`Sending key combination: ${JSON.stringify(combination)}`);

    const keyboard = getKeyboard();

    if (!keyboard) {
      this.logger.error("Keyboard interface not available");

      return;
    }

    const success = await keyboard.sendKeyCombination(combination);

    if (success) {
      this.logger.info("Key sent successfully");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to send key");
      this.logger.debug(`Failed key combination: ${formatKeyBinding(binding)}`);
    }
  }
}
