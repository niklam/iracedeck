import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getCommands,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  migrateLegacyActionToMode,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import reloadAllTexturesIconSvg from "@iracedeck/icons/media-capture/reload-all-textures.svg";
import reloadCarTexturesIconSvg from "@iracedeck/icons/media-capture/reload-car-textures.svg";
import startStopVideoIconSvg from "@iracedeck/icons/media-capture/start-stop-video.svg";
import takeGiantScreenshotIconSvg from "@iracedeck/icons/media-capture/take-giant-screenshot.svg";
import takeScreenshotIconSvg from "@iracedeck/icons/media-capture/take-screenshot.svg";
import toggleVideoCaptureIconSvg from "@iracedeck/icons/media-capture/toggle-video-capture.svg";
import videoTimerIconSvg from "@iracedeck/icons/media-capture/video-timer.svg";
import z from "zod";

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
 * Title text for each media capture action (format: "subLabel\nmainLabel")
 */
const MEDIA_CAPTURE_TITLES: Record<MediaCaptureAction, string> = {
  "start-stop-video": "VIDEO\nSTART/STOP",
  "video-timer": "VIDEO\nTIMER",
  "toggle-video-capture": "VIDEO\nTOGGLE",
  "take-screenshot": "CAPTURE\nSCREENSHOT",
  "take-giant-screenshot": "SCREENSHOT\nGIANT",
  "reload-all-textures": "TEXTURES\nRELOAD ALL",
  "reload-car-textures": "TEXTURES\nRELOAD CAR",
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
  mode: z.enum(ACTION_VALUES).default("start-stop-video"),
});

type MediaCaptureSettings = z.infer<typeof MediaCaptureSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the media capture action.
 */
export function generateMediaCaptureSvg(settings: MediaCaptureSettings): string {
  const { mode: actionType } = settings;

  const iconSvg = ACTION_ICONS[actionType] || ACTION_ICONS["start-stop-video"];
  const defaultTitle = MEDIA_CAPTURE_TITLES[actionType] || MEDIA_CAPTURE_TITLES["start-stop-video"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
}

/**
 * Media Capture Action
 * Video recording, screenshots, and texture management for iRacing.
 * SDK-based actions use media commands; Giant Screenshot uses a global key binding.
 */
export const MEDIA_CAPTURE_UUID = "com.iracedeck.sd.core.media-capture" as const;

export class MediaCapture extends ConnectionStateAwareAction<MediaCaptureSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<MediaCaptureSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const { migrated, changed } = migrateLegacyActionToMode(ev.payload.settings);

    if (changed) {
      try {
        await ev.action.setSettings(migrated);
      } catch (error) {
        this.logger.warn(`Failed to persist migrated settings: ${error instanceof Error ? error.message : error}`);
      }
    }

    const settings = this.parseSettings(migrated);
    const activeKey = MEDIA_CAPTURE_GLOBAL_KEYS[settings.mode];
    this.setActiveBinding(activeKey ?? null);

    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<MediaCaptureSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const activeKey = MEDIA_CAPTURE_GLOBAL_KEYS[settings.mode];
    this.setActiveBinding(activeKey ?? null);

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<MediaCaptureSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAction(settings.mode);
  }

  override async onDialDown(ev: IDeckDialDownEvent<MediaCaptureSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAction(settings.mode);
  }

  private parseSettings(settings: unknown): MediaCaptureSettings {
    const { migrated } = migrateLegacyActionToMode(settings);
    const parsed = MediaCaptureSettings.safeParse(migrated);

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
      case "take-giant-screenshot": {
        const settingKey = MEDIA_CAPTURE_GLOBAL_KEYS[actionType];

        if (!settingKey) {
          this.logger.warn(`No global key mapping for action: ${actionType}`);

          return;
        }

        await this.tapBinding(settingKey);
        break;
      }
    }
  }

  private executeSdkCommand(command: () => boolean, label: string): void {
    const success = command();
    this.logger.info(`${label} executed`);
    this.logger.debug(`Result: ${success}`);
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<MediaCaptureSettings> | IDeckDidReceiveSettingsEvent<MediaCaptureSettings>,
    settings: MediaCaptureSettings,
  ): Promise<void> {
    const svgDataUri = generateMediaCaptureSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateMediaCaptureSvg(settings));
  }
}
