import streamDeck, {
  action,
  DialDownEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import z from "zod";

import mediaCaptureTemplate from "../../icons/media-capture.svg";
import {
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

const WHITE = "#ffffff";
const GRAY = "#888888";
const RED = "#e74c3c";

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

/**
 * Label configuration for each media capture action (line1 bold, line2 subdued)
 */
const MEDIA_CAPTURE_LABELS: Record<MediaCaptureAction, { line1: string; line2: string }> = {
  "start-stop-video": { line1: "START/STOP", line2: "VIDEO" },
  "video-timer": { line1: "TIMER", line2: "VIDEO" },
  "toggle-video-capture": { line1: "TOGGLE", line2: "VIDEO" },
  "take-screenshot": { line1: "SCREENSHOT", line2: "CAPTURE" },
  "take-giant-screenshot": { line1: "GIANT", line2: "SCREENSHOT" },
  "reload-all-textures": { line1: "RELOAD ALL", line2: "TEXTURES" },
  "reload-car-textures": { line1: "RELOAD CAR", line2: "TEXTURES" },
};

/**
 * SVG icon content for each media capture action
 */
const MEDIA_CAPTURE_ICONS: Record<MediaCaptureAction, string> = {
  // Start/Stop Video: Video camera body with red record circle
  "start-stop-video": `
    <rect x="20" y="12" width="22" height="18" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="42,15 54,9 54,33 42,27" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="31" cy="21" r="5" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="31" cy="21" r="2.5" fill="${RED}"/>`,

  // Video Timer: Video camera with clock overlay
  "video-timer": `
    <rect x="16" y="12" width="22" height="18" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="38,15 48,10 48,32 38,27" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="52" cy="28" r="8" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="52" y1="28" x2="52" y2="23" stroke="${WHITE}" stroke-width="1" stroke-linecap="round"/>
    <line x1="52" y1="28" x2="56" y2="28" stroke="${WHITE}" stroke-width="1" stroke-linecap="round"/>`,

  // Toggle Video Capture: Video camera with power symbol
  "toggle-video-capture": `
    <rect x="20" y="12" width="22" height="18" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="42,15 54,9 54,33 42,27" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <line x1="31" y1="16" x2="31" y2="20" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M27 18 A5 5 0 1 0 35 18" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>`,

  // Take Screenshot: Still camera with flash
  "take-screenshot": `
    <rect x="20" y="14" width="28" height="20" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="30" y="10" width="8" height="6" rx="1" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="34" cy="24" r="6" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="34" cy="24" r="2" fill="${WHITE}"/>
    <line x1="52" y1="12" x2="56" y2="12" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="54" y1="10" x2="54" y2="14" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>`,

  // Take Giant Screenshot: Still camera with magnification frame
  "take-giant-screenshot": `
    <rect x="16" y="14" width="26" height="20" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="26" y="10" width="8" height="6" rx="1" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="29" cy="24" r="5" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="29" cy="24" r="2" fill="${WHITE}"/>
    <rect x="46" y="14" width="14" height="14" rx="1" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <line x1="48" y1="16" x2="50" y2="16" stroke="${WHITE}" stroke-width="1" stroke-linecap="round"/>
    <line x1="48" y1="16" x2="48" y2="18" stroke="${WHITE}" stroke-width="1" stroke-linecap="round"/>
    <line x1="58" y1="26" x2="56" y2="26" stroke="${WHITE}" stroke-width="1" stroke-linecap="round"/>
    <line x1="58" y1="26" x2="58" y2="24" stroke="${WHITE}" stroke-width="1" stroke-linecap="round"/>`,

  // Reload All Textures: Circular reload arrows with grid pattern
  "reload-all-textures": `
    <path d="M36 10 A14 14 0 1 1 22 24" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="20,20 22,24 26,22" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M36 38 A14 14 0 1 1 50 24" fill="none" stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>
    <polyline points="52,28 50,24 46,26" fill="none" stroke="${GRAY}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="30" y="18" width="5" height="5" fill="none" stroke="${GRAY}" stroke-width="0.8"/>
    <rect x="37" y="18" width="5" height="5" fill="none" stroke="${GRAY}" stroke-width="0.8"/>
    <rect x="30" y="25" width="5" height="5" fill="none" stroke="${GRAY}" stroke-width="0.8"/>
    <rect x="37" y="25" width="5" height="5" fill="none" stroke="${GRAY}" stroke-width="0.8"/>`,

  // Reload Car Textures: Car silhouette with reload arrow
  "reload-car-textures": `
    <path d="M18 28 L22 20 L32 18 L40 18 L50 20 L54 28 Z" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <line x1="16" y1="28" x2="56" y2="28" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="26" cy="28" r="3" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="46" cy="28" r="3" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <path d="M36 10 A6 6 0 1 1 30 16" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="28,14 30,16 32,14" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
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

const MediaCaptureSettings = z.object({
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

  const iconContent = MEDIA_CAPTURE_ICONS[actionType] || MEDIA_CAPTURE_ICONS["start-stop-video"];
  const labels = MEDIA_CAPTURE_LABELS[actionType] || MEDIA_CAPTURE_LABELS["start-stop-video"];

  const svg = renderIconTemplate(mediaCaptureTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
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
