import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import z from "zod";

import cameraCycleTemplate from "../../icons/camera-cycle.svg";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  getCommands,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";

const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const RED = "#e74c3c";

const CAMERA_TYPE_VALUES = ["camera", "sub-camera", "car", "driving"] as const;

type CameraType = (typeof CAMERA_TYPE_VALUES)[number];
type Direction = "next" | "previous";

/**
 * Label configuration for each camera type + direction combination
 */
const CAMERA_CYCLE_LABELS: Record<CameraType, Record<Direction, { line1: string; line2: string }>> = {
  camera: { next: { line1: "NEXT", line2: "CAMERA" }, previous: { line1: "PREV", line2: "CAMERA" } },
  "sub-camera": { next: { line1: "NEXT", line2: "SUB CAM" }, previous: { line1: "PREV", line2: "SUB CAM" } },
  car: { next: { line1: "NEXT", line2: "CAR" }, previous: { line1: "PREV", line2: "CAR" } },
  driving: { next: { line1: "NEXT", line2: "DRIVING" }, previous: { line1: "PREV", line2: "DRIVING" } },
};

/**
 * SVG icon content for each camera type + direction combination
 */
const CAMERA_CYCLE_ICONS: Record<CameraType, Record<Direction, string>> = {
  camera: {
    // Movie camera + right chevron
    next: `
    <rect x="18" y="14" width="22" height="18" rx="2" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <polygon points="40,17 52,12 52,36 40,31" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <polyline points="56,20 62,24 56,28" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    // Movie camera + left chevron
    previous: `
    <rect x="22" y="14" width="22" height="18" rx="2" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <polygon points="44,17 56,12 56,36 44,31" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <polyline points="16,20 10,24 16,28" fill="none" stroke="${RED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  "sub-camera": {
    // Small camera with inner frame + right chevron
    next: `
    <rect x="18" y="14" width="22" height="18" rx="2" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <rect x="22" y="18" width="14" height="10" rx="1" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polyline points="56,20 62,24 56,28" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    // Small camera with inner frame + left chevron
    previous: `
    <rect x="22" y="14" width="22" height="18" rx="2" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <rect x="26" y="18" width="14" height="10" rx="1" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polyline points="16,20 10,24 16,28" fill="none" stroke="${RED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  car: {
    // Car silhouette + right chevron
    next: `
    <path d="M 16,30 L 20,20 L 44,20 L 50,30 Z" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="24" cy="32" r="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="42" cy="32" r="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polyline points="56,20 62,24 56,28" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    // Car silhouette + left chevron
    previous: `
    <path d="M 20,30 L 24,20 L 48,20 L 54,30 Z" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="28" cy="32" r="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="46" cy="32" r="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polyline points="16,20 10,24 16,28" fill="none" stroke="${RED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  driving: {
    // Steering wheel + right chevron
    next: `
    <circle cx="33" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="33" cy="24" r="4" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="33" y1="28" x2="33" y2="36" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="21" y1="24" x2="29" y2="24" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="37" y1="24" x2="45" y2="24" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="56,20 62,24 56,28" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    // Steering wheel + left chevron
    previous: `
    <circle cx="37" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="37" cy="24" r="4" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="37" y1="28" x2="37" y2="36" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="25" y1="24" x2="33" y2="24" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="41" y1="24" x2="49" y2="24" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="16,20 10,24 16,28" fill="none" stroke="${RED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
};

const CameraCycleSettings = z.object({
  cameraType: z.enum(CAMERA_TYPE_VALUES).default("camera"),
  direction: z.enum(["next", "previous"]).default("next"),
});

type CameraCycleSettings = z.infer<typeof CameraCycleSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the camera cycle action.
 */
export function generateCameraCycleSvg(settings: { cameraType: CameraType; direction: Direction }): string {
  const { cameraType, direction } = settings;

  const iconContent = CAMERA_CYCLE_ICONS[cameraType]?.[direction] || CAMERA_CYCLE_ICONS["camera"]["next"];
  const labels = CAMERA_CYCLE_LABELS[cameraType]?.[direction] || CAMERA_CYCLE_LABELS["camera"]["next"];

  const svg = renderIconTemplate(cameraCycleTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Camera Cycle
 * Cycles through cameras, sub-cameras, cars, and driving cameras
 * during replays or spectating via iRacing SDK commands.
 */
@action({ UUID: "com.iracedeck.sd.core.camera-cycle" })
export class CameraCycle extends ConnectionStateAwareAction<CameraCycleSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("CameraCycle"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<CameraCycleSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<CameraCycleSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CameraCycleSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<CameraCycleSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeCycle(settings.cameraType, settings.direction);
  }

  override async onDialDown(ev: DialDownEvent<CameraCycleSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeCycle(settings.cameraType, settings.direction);
  }

  override async onDialRotate(ev: DialRotateEvent<CameraCycleSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);
    const direction: Direction = ev.payload.ticks > 0 ? "next" : "previous";
    this.executeCycle(settings.cameraType, direction);
  }

  private parseSettings(settings: unknown): CameraCycleSettings {
    const parsed = CameraCycleSettings.safeParse(settings);

    return parsed.success ? parsed.data : CameraCycleSettings.parse({});
  }

  private executeCycle(cameraType: CameraType, direction: Direction): void {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("No telemetry available for camera cycle");

      return;
    }

    const camera = getCommands().camera;
    const carIdx = telemetry.CamCarIdx ?? 0;
    const groupNum = telemetry.CamGroupNumber ?? 1;
    const cameraNum = telemetry.CamCameraNumber ?? 1;
    const dir = direction === "next" ? 1 : -1;

    switch (cameraType) {
      case "camera": {
        const success = camera.cycleCamera(carIdx, groupNum, dir);
        this.logger.info("Camera group cycled");
        this.logger.debug(`Result: ${success}, direction: ${direction}`);
        break;
      }
      case "sub-camera": {
        const success = camera.cycleSubCamera(carIdx, groupNum, cameraNum, dir);
        this.logger.info("Sub-camera cycled");
        this.logger.debug(`Result: ${success}, direction: ${direction}`);
        break;
      }
      case "car": {
        const success = camera.cycleCar(carIdx, dir);
        this.logger.info("Car cycled");
        this.logger.debug(`Result: ${success}, direction: ${direction}`);
        break;
      }
      case "driving": {
        const success = camera.cycleDrivingCamera(carIdx, groupNum, dir);
        this.logger.info("Driving camera cycled");
        this.logger.debug(`Result: ${success}, direction: ${direction}`);
        break;
      }
    }
  }

  private async updateDisplay(
    ev: WillAppearEvent<CameraCycleSettings> | DidReceiveSettingsEvent<CameraCycleSettings>,
    settings: CameraCycleSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateCameraCycleSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
