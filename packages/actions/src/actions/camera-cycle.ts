import {
  CommonSettings,
  ConnectionStateAwareAction,
  getCommands,
  getGlobalColors,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "@iracedeck/deck-core";
import cameraNextSvg from "@iracedeck/icons/camera-cycle/camera-next.svg";
import cameraPreviousSvg from "@iracedeck/icons/camera-cycle/camera-previous.svg";
import carNextSvg from "@iracedeck/icons/camera-cycle/car-next.svg";
import carPreviousSvg from "@iracedeck/icons/camera-cycle/car-previous.svg";
import drivingNextSvg from "@iracedeck/icons/camera-cycle/driving-next.svg";
import drivingPreviousSvg from "@iracedeck/icons/camera-cycle/driving-previous.svg";
import subCameraNextSvg from "@iracedeck/icons/camera-cycle/sub-camera-next.svg";
import subCameraPreviousSvg from "@iracedeck/icons/camera-cycle/sub-camera-previous.svg";
import z from "zod";

const CAMERA_TYPE_VALUES = ["camera", "sub-camera", "car", "driving"] as const;

type CameraType = (typeof CAMERA_TYPE_VALUES)[number];
type Direction = "next" | "previous";

/**
 * @internal Exported for testing
 *
 * Label configuration for each camera type + direction combination
 */
export const CAMERA_CYCLE_LABELS: Record<CameraType, Record<Direction, { mainLabel: string; subLabel: string }>> = {
  camera: {
    next: { mainLabel: "NEXT", subLabel: "CAMERA" },
    previous: { mainLabel: "PREV", subLabel: "CAMERA" },
  },
  "sub-camera": {
    next: { mainLabel: "NEXT", subLabel: "SUB CAM" },
    previous: { mainLabel: "PREV", subLabel: "SUB CAM" },
  },
  car: {
    next: { mainLabel: "NEXT", subLabel: "CAR" },
    previous: { mainLabel: "PREV", subLabel: "CAR" },
  },
  driving: {
    next: { mainLabel: "NEXT", subLabel: "DRIVING" },
    previous: { mainLabel: "PREV", subLabel: "DRIVING" },
  },
};

/**
 * @internal Exported for testing
 *
 * Icon SVG lookup for each camera type + direction combination
 */
export const CAMERA_CYCLE_ICONS: Record<CameraType, Record<Direction, string>> = {
  camera: { next: cameraNextSvg, previous: cameraPreviousSvg },
  "sub-camera": { next: subCameraNextSvg, previous: subCameraPreviousSvg },
  car: { next: carNextSvg, previous: carPreviousSvg },
  driving: { next: drivingNextSvg, previous: drivingPreviousSvg },
};

const CameraCycleSettings = CommonSettings.extend({
  cameraType: z.enum(CAMERA_TYPE_VALUES).default("camera"),
  direction: z.enum(["next", "previous"]).default("next"),
});

type CameraCycleSettings = z.infer<typeof CameraCycleSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the camera cycle action.
 */
export function generateCameraCycleSvg(
  settings: { cameraType: CameraType; direction: Direction } & Partial<CommonSettings>,
): string {
  const { cameraType, direction } = settings;

  const iconSvg = CAMERA_CYCLE_ICONS[cameraType]?.[direction] || CAMERA_CYCLE_ICONS["camera"]["next"];
  const labels = CAMERA_CYCLE_LABELS[cameraType]?.[direction] || CAMERA_CYCLE_LABELS["camera"]["next"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Camera Cycle
 * Cycles through cameras, sub-cameras, cars, and driving cameras
 * during replays or spectating via iRacing SDK commands.
 */
export const CAMERA_CYCLE_UUID = "com.iracedeck.sd.core.camera-cycle" as const;

export class CameraCycle extends ConnectionStateAwareAction<CameraCycleSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<CameraCycleSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<CameraCycleSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<CameraCycleSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<CameraCycleSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeCycle(settings.cameraType, settings.direction);
  }

  override async onDialDown(ev: IDeckDialDownEvent<CameraCycleSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeCycle(settings.cameraType, settings.direction);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<CameraCycleSettings>): Promise<void> {
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
    ev: IDeckWillAppearEvent<CameraCycleSettings> | IDeckDidReceiveSettingsEvent<CameraCycleSettings>,
    settings: CameraCycleSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateCameraCycleSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateCameraCycleSvg(settings));
  }
}
