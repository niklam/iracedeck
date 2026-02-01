import streamDeck, { action, KeyDownEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
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

import testAlphaTemplate from "../../icons/test-alpha.svg";

/**
 * @internal Exported for testing
 */
export const GLOBAL_KEY_NAME = "testAlphaActivate";

const ICON_CONTENT = `
    <text x="36" y="26" text-anchor="middle" dominant-baseline="central"
          fill="#ffffff" font-family="Arial, sans-serif" font-size="28" font-weight="bold">A</text>`;

/**
 * @internal Exported for testing
 */
export function generateTestAlphaSvg(): string {
  const svg = renderIconTemplate(testAlphaTemplate, {
    iconContent: ICON_CONTENT,
    labelLine1: "TEST",
    labelLine2: "ALPHA",
  });

  return svgToDataUri(svg);
}

/**
 * Test Alpha Action
 * Sends a configurable keyboard shortcut when pressed. This is a test action.
 */
@action({ UUID: "com.iracedeck.sd.core.test-alpha" })
export class TestAlpha extends ConnectionStateAwareAction<Record<string, never>> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("TestAlpha"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<Record<string, never>>): Promise<void> {
    await this.updateDisplay(ev);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<Record<string, never>>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onKeyDown(_ev: KeyDownEvent<Record<string, never>>): Promise<void> {
    this.logger.info("Key down received");

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[GLOBAL_KEY_NAME]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${GLOBAL_KEY_NAME}`);

      return;
    }

    await this.sendKeyBinding(binding);
  }

  private async updateDisplay(ev: WillAppearEvent<Record<string, never>>): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateTestAlphaSvg();
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }

  private async sendKeyBinding(binding: KeyBindingValue): Promise<void> {
    const combination: KeyCombination = {
      key: binding.key as KeyboardKey,
      modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
      code: binding.code,
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
