import streamDeck, { action, DialRotateEvent, KeyDownEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
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

import testGammaTemplate from "../../icons/test-gamma.svg";

const ICON_CONTENT = `
    <text x="36" y="28" text-anchor="middle" dominant-baseline="central"
          font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="#ffffff">γ</text>`;

/**
 * @internal Exported for testing
 */
export const GLOBAL_KEY_NAME = "testGammaActivate";

/**
 * @internal Exported for testing
 */
export function generateTestGammaSvg(): string {
  const svg = renderIconTemplate(testGammaTemplate, {
    iconContent: ICON_CONTENT,
    labelLine1: "TEST",
    labelLine2: "GAMMA",
  });

  return svgToDataUri(svg);
}

/**
 * Test Gamma Action
 * Sends a configurable keyboard shortcut when the button is pressed.
 * This is a test action — will be reverted after validation.
 */
@action({ UUID: "com.iracedeck.sd.core.test-gamma" })
export class TestGamma extends ConnectionStateAwareAction<JsonObject> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("TestGamma"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<JsonObject>): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateTestGammaSvg();
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<JsonObject>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onKeyDown(_ev: KeyDownEvent<JsonObject>): Promise<void> {
    this.logger.info("Key down received");

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[GLOBAL_KEY_NAME]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${GLOBAL_KEY_NAME}`);

      return;
    }

    await this.sendKeyBinding(binding);
  }

  override async onDialRotate(_ev: DialRotateEvent<JsonObject>): Promise<void> {
    this.logger.info("Dial rotated");

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[GLOBAL_KEY_NAME]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${GLOBAL_KEY_NAME}`);

      return;
    }

    await this.sendKeyBinding(binding);
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
