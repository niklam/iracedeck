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
import focusOnExitingSvg from "@iracedeck/icons/camera-focus/focus-on-exiting.svg";
import focusOnIncidentSvg from "@iracedeck/icons/camera-focus/focus-on-incident.svg";
import focusOnLeaderSvg from "@iracedeck/icons/camera-focus/focus-on-leader.svg";
import focusYourCarSvg from "@iracedeck/icons/camera-focus/focus-your-car.svg";
import setCameraStateSvg from "@iracedeck/icons/camera-focus/set-camera-state.svg";
import switchByCarNumberSvg from "@iracedeck/icons/camera-focus/switch-by-car-number.svg";
import switchByPositionSvg from "@iracedeck/icons/camera-focus/switch-by-position.svg";
import z from "zod";

const FOCUS_TARGET_VALUES = [
  "focus-your-car",
  "focus-on-leader",
  "focus-on-incident",
  "focus-on-exiting",
  "switch-by-position",
  "switch-by-car-number",
  "set-camera-state",
] as const;

type FocusTarget = (typeof FOCUS_TARGET_VALUES)[number];

const CameraFocusSettings = CommonSettings.extend({
  target: z.enum(FOCUS_TARGET_VALUES).default("focus-your-car"),
  position: z.coerce.number().int().min(1).default(1),
  carNumber: z.coerce.number().int().min(0).default(0),
  cameraState: z.coerce.number().int().min(0).default(0),
});

type CameraFocusSettings = z.infer<typeof CameraFocusSettings>;

const CAMERA_FOCUS_ICONS: Record<FocusTarget, string> = {
  "focus-your-car": focusYourCarSvg,
  "focus-on-leader": focusOnLeaderSvg,
  "focus-on-incident": focusOnIncidentSvg,
  "focus-on-exiting": focusOnExitingSvg,
  "switch-by-position": switchByPositionSvg,
  "switch-by-car-number": switchByCarNumberSvg,
  "set-camera-state": setCameraStateSvg,
};

/**
 * Label configuration for each focus target (mainLabel prominent, subLabel subdued)
 */
const CAMERA_FOCUS_LABELS: Record<FocusTarget, { mainLabel: string; subLabel: string }> = {
  "focus-your-car": { mainLabel: "YOUR CAR", subLabel: "FOCUS" },
  "focus-on-leader": { mainLabel: "LEADER", subLabel: "FOCUS" },
  "focus-on-incident": { mainLabel: "INCIDENT", subLabel: "FOCUS" },
  "focus-on-exiting": { mainLabel: "EXITING", subLabel: "FOCUS" },
  "switch-by-position": { mainLabel: "POSITION", subLabel: "SWITCH" },
  "switch-by-car-number": { mainLabel: "CAR #", subLabel: "SWITCH" },
  "set-camera-state": { mainLabel: "CAM STATE", subLabel: "SET" },
};

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the camera focus action.
 */
export function generateCameraFocusSvg(settings: { target: FocusTarget } & Partial<CommonSettings>): string {
  const { target } = settings;

  const iconSvg = CAMERA_FOCUS_ICONS[target] || CAMERA_FOCUS_ICONS["focus-your-car"];
  const labels = CAMERA_FOCUS_LABELS[target] || CAMERA_FOCUS_LABELS["focus-your-car"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Camera Focus
 * Focuses the camera on specific targets (your car, leader, incidents,
 * exiting cars, specific positions/car numbers, camera state)
 * via iRacing SDK commands.
 */
export const CAMERA_FOCUS_UUID = "com.iracedeck.sd.core.camera-focus" as const;

export class CameraFocus extends ConnectionStateAwareAction<CameraFocusSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<CameraFocusSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<CameraFocusSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<CameraFocusSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<CameraFocusSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeFocus(settings);
  }

  override async onDialDown(ev: IDeckDialDownEvent<CameraFocusSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeFocus(settings);
  }

  override async onDialRotate(_ev: IDeckDialRotateEvent<CameraFocusSettings>): Promise<void> {
    // Rotation is no-op for camera focus
    return;
  }

  private parseSettings(settings: unknown): CameraFocusSettings {
    const parsed = CameraFocusSettings.safeParse(settings);

    return parsed.success ? parsed.data : CameraFocusSettings.parse({});
  }

  private executeFocus(settings: CameraFocusSettings): void {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("No telemetry available for camera focus");

      return;
    }

    const camera = getCommands().camera;
    const groupNum = telemetry.CamGroupNumber ?? 1;
    const cameraNum = telemetry.CamCameraNumber ?? 1;

    switch (settings.target) {
      case "focus-your-car": {
        const playerCarIdx = telemetry.PlayerCarIdx ?? 0;
        const success = camera.switchPos(playerCarIdx, groupNum, cameraNum);
        this.logger.info("Focus on your car executed");
        this.logger.debug(`Result: ${success}, playerCarIdx: ${playerCarIdx}`);
        break;
      }
      case "focus-on-leader": {
        const success = camera.focusOnLeader(groupNum, cameraNum);
        this.logger.info("Focus on leader executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "focus-on-incident": {
        const success = camera.focusOnIncident(groupNum, cameraNum);
        this.logger.info("Focus on incident executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "focus-on-exiting": {
        const success = camera.focusOnExiting(groupNum, cameraNum);
        this.logger.info("Focus on exiting executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "switch-by-position": {
        const success = camera.switchPos(settings.position, groupNum, cameraNum);
        this.logger.info("Switch by position executed");
        this.logger.debug(`Result: ${success}, position: ${settings.position}`);
        break;
      }
      case "switch-by-car-number": {
        const success = camera.switchNum(settings.carNumber, groupNum, cameraNum);
        this.logger.info("Switch by car number executed");
        this.logger.debug(`Result: ${success}, carNumber: ${settings.carNumber}`);
        break;
      }
      case "set-camera-state": {
        const success = camera.setState(settings.cameraState);
        this.logger.info("Set camera state executed");
        this.logger.debug(`Result: ${success}, state: ${settings.cameraState}`);
        break;
      }
    }
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<CameraFocusSettings> | IDeckDidReceiveSettingsEvent<CameraFocusSettings>,
    settings: CameraFocusSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateCameraFocusSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateCameraFocusSvg(settings));
  }
}
