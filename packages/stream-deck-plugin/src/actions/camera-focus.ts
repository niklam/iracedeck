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

import cameraFocusTemplate from "../../icons/camera-focus.svg";
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
const YELLOW = "#f1c40f";
const GRAY = "#888888";

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

const CameraFocusSettings = z.object({
  target: z.enum(FOCUS_TARGET_VALUES).default("focus-your-car"),
  position: z.coerce.number().int().min(1).default(1),
  carNumber: z.coerce.number().int().min(0).default(0),
  cameraState: z.coerce.number().int().min(0).default(0),
});

type CameraFocusSettings = z.infer<typeof CameraFocusSettings>;

/**
 * Label configuration for each focus target (line1 bold, line2 subdued)
 */
const CAMERA_FOCUS_LABELS: Record<FocusTarget, { line1: string; line2: string }> = {
  "focus-your-car": { line1: "FOCUS", line2: "YOUR CAR" },
  "focus-on-leader": { line1: "FOCUS", line2: "LEADER" },
  "focus-on-incident": { line1: "FOCUS", line2: "INCIDENT" },
  "focus-on-exiting": { line1: "FOCUS", line2: "EXITING" },
  "switch-by-position": { line1: "SWITCH", line2: "POSITION" },
  "switch-by-car-number": { line1: "SWITCH", line2: "CAR #" },
  "set-camera-state": { line1: "SET", line2: "CAM STATE" },
};

/**
 * SVG icon content for each focus target
 */
const CAMERA_FOCUS_ICONS: Record<FocusTarget, string> = {
  // Focus Your Car: Crosshair + small driver/helmet silhouette
  "focus-your-car": `
    <circle cx="36" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="36" cy="24" r="3" fill="${WHITE}"/>
    <line x1="36" y1="8" x2="36" y2="14" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="36" y1="34" x2="36" y2="40" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="20" y1="24" x2="26" y2="24" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="46" y1="24" x2="52" y2="24" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>`,

  // Focus on Leader: Crosshair + "P1" text in green
  "focus-on-leader": `
    <circle cx="30" cy="24" r="10" fill="none" stroke="${GREEN}" stroke-width="2"/>
    <circle cx="30" cy="24" r="2.5" fill="${GREEN}"/>
    <line x1="30" y1="10" x2="30" y2="16" stroke="${GREEN}" stroke-width="2" stroke-linecap="round"/>
    <line x1="30" y1="32" x2="30" y2="38" stroke="${GREEN}" stroke-width="2" stroke-linecap="round"/>
    <line x1="16" y1="24" x2="22" y2="24" stroke="${GREEN}" stroke-width="2" stroke-linecap="round"/>
    <line x1="38" y1="24" x2="44" y2="24" stroke="${GREEN}" stroke-width="2" stroke-linecap="round"/>
    <text x="54" y="18" text-anchor="middle" dominant-baseline="central"
          fill="${GREEN}" font-family="Arial, sans-serif" font-size="10" font-weight="bold">P1</text>`,

  // Focus on Incident: Crosshair + warning exclamation
  "focus-on-incident": `
    <circle cx="30" cy="24" r="10" fill="none" stroke="${YELLOW}" stroke-width="2"/>
    <circle cx="30" cy="24" r="2.5" fill="${YELLOW}"/>
    <line x1="30" y1="10" x2="30" y2="16" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>
    <line x1="30" y1="32" x2="30" y2="38" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>
    <line x1="16" y1="24" x2="22" y2="24" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>
    <line x1="38" y1="24" x2="44" y2="24" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>
    <text x="54" y="24" text-anchor="middle" dominant-baseline="central"
          fill="${YELLOW}" font-family="Arial, sans-serif" font-size="16" font-weight="bold">!</text>`,

  // Focus on Exiting: Crosshair + exit arrow
  "focus-on-exiting": `
    <circle cx="30" cy="24" r="10" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="30" cy="24" r="2.5" fill="${WHITE}"/>
    <line x1="30" y1="10" x2="30" y2="16" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="30" y1="32" x2="30" y2="38" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="16" y1="24" x2="22" y2="24" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="38" y1="24" x2="44" y2="24" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="50,18 56,24 50,30" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,

  // Switch by Position: Hash/number sign with position indicator
  "switch-by-position": `
    <text x="36" y="26" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">#</text>
    <text x="36" y="40" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="9">POS</text>`,

  // Switch by Car Number: Car badge with number
  "switch-by-car-number": `
    <rect x="20" y="14" width="32" height="20" rx="3" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <text x="36" y="25" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="14" font-weight="bold">00</text>
    <text x="36" y="40" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="9">CAR</text>`,

  // Set Camera State: Gear/settings icon
  "set-camera-state": `
    <circle cx="36" cy="24" r="8" fill="none" stroke="${GRAY}" stroke-width="2"/>
    <circle cx="36" cy="24" r="3" fill="${GRAY}"/>
    <line x1="36" y1="12" x2="36" y2="16" stroke="${GRAY}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="36" y1="32" x2="36" y2="36" stroke="${GRAY}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="24" y1="24" x2="28" y2="24" stroke="${GRAY}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="44" y1="24" x2="48" y2="24" stroke="${GRAY}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="27.5" y1="15.5" x2="30.3" y2="18.3" stroke="${GRAY}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="41.7" y1="29.7" x2="44.5" y2="32.5" stroke="${GRAY}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="44.5" y1="15.5" x2="41.7" y2="18.3" stroke="${GRAY}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="30.3" y1="29.7" x2="27.5" y2="32.5" stroke="${GRAY}" stroke-width="2.5" stroke-linecap="round"/>`,
};

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the camera focus action.
 */
export function generateCameraFocusSvg(settings: { target: FocusTarget }): string {
  const { target } = settings;

  const iconContent = CAMERA_FOCUS_ICONS[target] || CAMERA_FOCUS_ICONS["focus-your-car"];
  const labels = CAMERA_FOCUS_LABELS[target] || CAMERA_FOCUS_LABELS["focus-your-car"];

  const svg = renderIconTemplate(cameraFocusTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Camera Focus
 * Focuses the camera on specific targets (your car, leader, incidents,
 * exiting cars, specific positions/car numbers, camera state)
 * via iRacing SDK commands.
 */
@action({ UUID: "com.iracedeck.sd.core.camera-focus" })
export class CameraFocus extends ConnectionStateAwareAction<CameraFocusSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("CameraFocus"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<CameraFocusSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<CameraFocusSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CameraFocusSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<CameraFocusSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeFocus(settings);
  }

  override async onDialDown(ev: DialDownEvent<CameraFocusSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeFocus(settings);
  }

  override async onDialRotate(_ev: DialRotateEvent<CameraFocusSettings>): Promise<void> {
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
    ev: WillAppearEvent<CameraFocusSettings> | DidReceiveSettingsEvent<CameraFocusSettings>,
    settings: CameraFocusSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateCameraFocusSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
