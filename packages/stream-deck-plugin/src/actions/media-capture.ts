import streamDeck, {
  action,
  DialDownEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import reloadAllTexturesIconSvg from "@iracedeck/icons/media-capture/reload-all-textures.svg";
import reloadCarTexturesIconSvg from "@iracedeck/icons/media-capture/reload-car-textures.svg";
import startStopVideoIconSvg from "@iracedeck/icons/media-capture/start-stop-video.svg";
import takeGiantScreenshotIconSvg from "@iracedeck/icons/media-capture/take-giant-screenshot.svg";
import takeScreenshotIconSvg from "@iracedeck/icons/media-capture/take-screenshot.svg";
import toggleVideoCaptureIconSvg from "@iracedeck/icons/media-capture/toggle-video-capture.svg";
import videoTimerIconSvg from "@iracedeck/icons/media-capture/video-timer.svg";
import z from "zod";

import {
  CommonSettings,
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  getCommands,
  getGlobalSettings,
  getKeyboard,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  LogLevel,
  parseKeyBinding,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";

const ACTION_VALUES = [
  "start-stop-video",
  "video-timer",
  "toggle-video-capture",
  "take-screenshot",
  "take-giant-screenshot",
  "reload-all-textures",
  "reload-car-textures",
] as const;

type MediaCaptureAction = (typeof ACTION_VALUES)[number];

const ACTION_ICONS: Record<MediaCaptureAction, string> = {
  "start-stop-video": startStopVideoIconSvg,
  "video-timer": videoTimerIconSvg,
  "toggle-video-capture": toggleVideoCaptureIconSvg,
  "take-screenshot": takeScreenshotIconSvg,
  "take-giant-screenshot": takeGiantScreenshotIconSvg,
  "reload-all-textures": reloadAllTexturesIconSvg,
  "reload-car-textures": reloadCarTexturesIconSvg,
};

/**
 * Label configuration for each media capture action
 */
const MEDIA_CAPTURE_LABELS: Record<MediaCaptureAction, { mainLabel: string; subLabel: string }> = {
  "start-stop-video": { mainLabel: "START/STOP", subLabel: "VIDEO" },
  "video-timer": { mainLabel: "TIMER", subLabel: "VIDEO" },
  "toggle-video-capture": { mainLabel: "TOGGLE", subLabel: "VIDEO" },
  "take-screenshot": { mainLabel: "SCREENSHOT", subLabel: "CAPTURE" },
  "take-giant-screenshot": { mainLabel: "GIANT", subLabel: "SCREENSHOT" },
  "reload-all-textures": { mainLabel: "RELOAD ALL", subLabel: "TEXTURES" },
  "reload-car-textures": { mainLabel: "RELOAD CAR", subLabel: "TEXTURES" },
};

/**
 * @internal Exported for testing
 *
 * Mapping from keyboard-based media capture actions to global settings keys.
 * SDK-based actions are NOT included.
 */
export const MEDIA_CAPTURE_GLOBAL_KEYS: Record<string, string> = {
  "take-giant-screenshot": "mediaCaptureGiantScreenshot",
};

const MediaCaptureSettings = CommonSettings.extend({
  action: z.enum(ACTION_VALUES).default("start-stop-video"),
});

type MediaCaptureSettings = z.infer<typeof MediaCaptureSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the media capture action.
 */
export function generateMediaCaptureSvg(settings: MediaCaptureSettings): string {
  const { action: actionType } = settings;

  const iconSvg = ACTION_ICONS[actionType] || ACTION_ICONS["start-stop-video"];
  const labels = MEDIA_CAPTURE_LABELS[actionType] || MEDIA_CAPTURE_LABELS["start-stop-video"];

  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
  });

  return svgToDataUri(svg);
}

/**
 * Media Capture Action
 * Video recording, screenshots, and texture management for iRacing.
 * SDK-based actions use media commands; Giant Screenshot uses a global key binding.
 */
@action({ UUID: "com.iracedeck.sd.core.media-capture" })
export class MediaCapture extends ConnectionStateAwareAction<MediaCaptureSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("MediaCapture"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<MediaCaptureSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<MediaCaptureSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<MediaCaptureSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<MediaCaptureSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAction(settings.action);
  }

  override async onDialDown(ev: DialDownEvent<MediaCaptureSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAction(settings.action);
  }

  private parseSettings(settings: unknown): MediaCaptureSettings {
    const parsed = MediaCaptureSettings.safeParse(settings);

    return parsed.success ? parsed.data : MediaCaptureSettings.parse({});
  }

  private async executeAction(actionType: MediaCaptureAction): Promise<void> {
    switch (actionType) {
      // SDK-based actions
      case "start-stop-video":
        this.executeSdkCommand(() => getCommands().videoCapture.toggle(), "Start/stop video");
        break;
      case "video-timer":
        this.executeSdkCommand(() => getCommands().videoCapture.showTimer(), "Video timer");
        break;
      case "toggle-video-capture":
        this.executeSdkCommand(() => getCommands().videoCapture.toggle(), "Toggle video capture");
        break;
      case "take-screenshot":
        this.executeSdkCommand(() => getCommands().videoCapture.screenshot(), "Take screenshot");
        break;
      case "reload-all-textures":
        this.executeSdkCommand(() => getCommands().texture.reloadAll(), "Reload all textures");
        break;
      case "reload-car-textures":
        this.executeSdkCommand(() => getCommands().texture.reloadCar(0), "Reload car textures");
        break;

      // Keyboard-based actions
      case "take-giant-screenshot":
        await this.executeKeyboardAction(actionType);
        break;
    }
  }

  private executeSdkCommand(command: () => boolean, label: string): void {
    const success = command();
    this.logger.info(`${label} executed`);
    this.logger.debug(`Result: ${success}`);
  }

  private async executeKeyboardAction(actionType: MediaCaptureAction): Promise<void> {
    const settingKey = MEDIA_CAPTURE_GLOBAL_KEYS[actionType];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for action: ${actionType}`);

      return;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return;
    }

    const combination: KeyCombination = {
      key: binding.key as KeyboardKey,
      modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
      code: binding.code,
    };

    const success = await getKeyboard().sendKeyCombination(combination);

    if (success) {
      this.logger.info("Key sent successfully");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to send key");
      this.logger.debug(`Failed key combination: ${formatKeyBinding(binding)}`);
    }
  }

  private async updateDisplay(
    ev: WillAppearEvent<MediaCaptureSettings> | DidReceiveSettingsEvent<MediaCaptureSettings>,
    settings: MediaCaptureSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateMediaCaptureSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
