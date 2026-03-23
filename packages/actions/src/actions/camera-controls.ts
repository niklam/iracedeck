import {
  CommonSettings,
  ConnectionStateAwareAction,
  getCommands,
  getGlobalColors,
  getGlobalSettings,
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
// Cycle icons
import cameraNextSvg from "@iracedeck/icons/camera-cycle/camera-next.svg";
import cameraPreviousSvg from "@iracedeck/icons/camera-cycle/camera-previous.svg";
import carNextSvg from "@iracedeck/icons/camera-cycle/car-next.svg";
import carPreviousSvg from "@iracedeck/icons/camera-cycle/car-previous.svg";
import drivingNextSvg from "@iracedeck/icons/camera-cycle/driving-next.svg";
import drivingPreviousSvg from "@iracedeck/icons/camera-cycle/driving-previous.svg";
import subCameraNextSvg from "@iracedeck/icons/camera-cycle/sub-camera-next.svg";
import subCameraPreviousSvg from "@iracedeck/icons/camera-cycle/sub-camera-previous.svg";
// Focus icons
import focusOnExitingSvg from "@iracedeck/icons/camera-focus/focus-on-exiting.svg";
import focusOnIncidentSvg from "@iracedeck/icons/camera-focus/focus-on-incident.svg";
import focusOnLeaderSvg from "@iracedeck/icons/camera-focus/focus-on-leader.svg";
import focusYourCarSvg from "@iracedeck/icons/camera-focus/focus-your-car.svg";
import setCameraStateSvg from "@iracedeck/icons/camera-focus/set-camera-state.svg";
import switchByCarNumberSvg from "@iracedeck/icons/camera-focus/switch-by-car-number.svg";
import switchByPositionSvg from "@iracedeck/icons/camera-focus/switch-by-position.svg";
// Camera select icons (per-group icons for cycle-camera preview)
import blimpSvg from "@iracedeck/icons/camera-select/blimp.svg";
import chaseSvg from "@iracedeck/icons/camera-select/chase.svg";
import chopperSvg from "@iracedeck/icons/camera-select/chopper.svg";
import cockpitSvg from "@iracedeck/icons/camera-select/cockpit.svg";
import farChaseSvg from "@iracedeck/icons/camera-select/far-chase.svg";
import gearboxSvg from "@iracedeck/icons/camera-select/gearbox.svg";
import gyroSvg from "@iracedeck/icons/camera-select/gyro.svg";
import lfSuspSvg from "@iracedeck/icons/camera-select/lf-susp.svg";
import lrSuspSvg from "@iracedeck/icons/camera-select/lr-susp.svg";
import noseSvg from "@iracedeck/icons/camera-select/nose.svg";
import pitLane2Svg from "@iracedeck/icons/camera-select/pit-lane-2.svg";
import pitLaneSvg from "@iracedeck/icons/camera-select/pit-lane.svg";
import rearChaseSvg from "@iracedeck/icons/camera-select/rear-chase.svg";
import rfSuspSvg from "@iracedeck/icons/camera-select/rf-susp.svg";
import rollBarSvg from "@iracedeck/icons/camera-select/roll-bar.svg";
import rrSuspSvg from "@iracedeck/icons/camera-select/rr-susp.svg";
import scenicSvg from "@iracedeck/icons/camera-select/scenic.svg";
import tv1Svg from "@iracedeck/icons/camera-select/tv1.svg";
import tv2Svg from "@iracedeck/icons/camera-select/tv2.svg";
import tv3Svg from "@iracedeck/icons/camera-select/tv3.svg";
import {
  type CameraGroup,
  getCameraGroupsFromSessionInfo,
  getCarNumberRawFromSessionInfo,
} from "@iracedeck/iracing-sdk";
import z from "zod";

// --- Target types ---

const CYCLE_TARGET_VALUES = ["cycle-camera", "cycle-sub-camera", "cycle-car", "cycle-driving"] as const;

const FOCUS_TARGET_VALUES = [
  "focus-your-car",
  "focus-on-leader",
  "focus-on-incident",
  "focus-on-exiting",
  "switch-by-position",
  "switch-by-car-number",
  "set-camera-state",
] as const;

const TARGET_VALUES = [...CYCLE_TARGET_VALUES, ...FOCUS_TARGET_VALUES] as const;

type CycleTarget = (typeof CYCLE_TARGET_VALUES)[number];
type Target = (typeof TARGET_VALUES)[number];
type Direction = "next" | "previous";

function isCycleTarget(target: Target): target is CycleTarget {
  return (CYCLE_TARGET_VALUES as readonly string[]).includes(target);
}

// --- Camera group subset constants ---

/**
 * @internal Exported for testing
 *
 * Global settings key for camera group subset selection
 */
export const CAMERA_GROUPS_GLOBAL_KEY = "cameraGroupSubset";

/**
 * @internal Exported for testing
 *
 * All known iRacing camera group names
 */
export const DEFAULT_CAMERA_GROUPS = [
  "Nose",
  "Gearbox",
  "Roll Bar",
  "LF Susp",
  "LR Susp",
  "Gyro",
  "RF Susp",
  "RR Susp",
  "Cockpit",
  "Scenic",
  "TV1",
  "TV2",
  "TV3",
  "Pit Lane",
  "Pit Lane2",
  "Chopper",
  "Blimp",
  "Chase",
  "Far Chase",
  "Rear Chase",
];

/**
 * @internal Exported for testing
 *
 * Default enabled camera groups (used when no global setting is saved)
 */
export const DEFAULT_ENABLED_GROUPS = ["Nose", "Cockpit", "Chase", "TV1", "TV2", "TV3"];

// --- Settings schema ---

const CameraControlsSettings = CommonSettings.extend({
  target: z.enum(TARGET_VALUES).default("focus-your-car"),
  // Cycle-specific
  direction: z.enum(["next", "previous"]).default("next"),
  // Focus-specific
  position: z.coerce.number().int().min(1).default(1),
  carNumber: z.coerce.number().int().min(0).default(0),
  cameraState: z.coerce.number().int().min(0).default(0),
});

type CameraControlsSettings = z.infer<typeof CameraControlsSettings>;

// --- Icon maps ---

/**
 * @internal Exported for testing
 *
 * Cycle icon SVG lookup (target + direction → SVG)
 */
export const CYCLE_ICONS: Record<CycleTarget, Record<Direction, string>> = {
  "cycle-camera": { next: cameraNextSvg, previous: cameraPreviousSvg },
  "cycle-sub-camera": { next: subCameraNextSvg, previous: subCameraPreviousSvg },
  "cycle-car": { next: carNextSvg, previous: carPreviousSvg },
  "cycle-driving": { next: drivingNextSvg, previous: drivingPreviousSvg },
};

/**
 * @internal Exported for testing
 *
 * Cycle label configuration (target + direction → labels)
 */
export const CYCLE_LABELS: Record<CycleTarget, Record<Direction, { mainLabel: string; subLabel: string }>> = {
  "cycle-camera": {
    next: { mainLabel: "NEXT", subLabel: "CAMERA" },
    previous: { mainLabel: "PREV", subLabel: "CAMERA" },
  },
  "cycle-sub-camera": {
    next: { mainLabel: "NEXT", subLabel: "SUB CAM" },
    previous: { mainLabel: "PREV", subLabel: "SUB CAM" },
  },
  "cycle-car": {
    next: { mainLabel: "NEXT", subLabel: "CAR" },
    previous: { mainLabel: "PREV", subLabel: "CAR" },
  },
  "cycle-driving": {
    next: { mainLabel: "NEXT", subLabel: "DRIVING" },
    previous: { mainLabel: "PREV", subLabel: "DRIVING" },
  },
};

/**
 * Camera group name → camera-select SVG icon for cycle-camera preview.
 * Shows the icon of the next camera group that will be activated.
 */
const CAMERA_SELECT_ICONS: Record<string, string> = {
  Nose: noseSvg,
  Gearbox: gearboxSvg,
  "Roll Bar": rollBarSvg,
  "LF Susp": lfSuspSvg,
  "LR Susp": lrSuspSvg,
  Gyro: gyroSvg,
  "RF Susp": rfSuspSvg,
  "RR Susp": rrSuspSvg,
  Cockpit: cockpitSvg,
  Scenic: scenicSvg,
  TV1: tv1Svg,
  TV2: tv2Svg,
  TV3: tv3Svg,
  "Pit Lane": pitLaneSvg,
  "Pit Lane2": pitLane2Svg,
  Chopper: chopperSvg,
  Blimp: blimpSvg,
  Chase: chaseSvg,
  "Far Chase": farChaseSvg,
  "Rear Chase": rearChaseSvg,
};

const FOCUS_ICONS: Record<string, string> = {
  "focus-your-car": focusYourCarSvg,
  "focus-on-leader": focusOnLeaderSvg,
  "focus-on-incident": focusOnIncidentSvg,
  "focus-on-exiting": focusOnExitingSvg,
  "switch-by-position": switchByPositionSvg,
  "switch-by-car-number": switchByCarNumberSvg,
  "set-camera-state": setCameraStateSvg,
};

const FOCUS_LABELS: Record<string, { mainLabel: string; subLabel: string }> = {
  "focus-your-car": { mainLabel: "YOUR CAR", subLabel: "FOCUS" },
  "focus-on-leader": { mainLabel: "LEADER", subLabel: "FOCUS" },
  "focus-on-incident": { mainLabel: "INCIDENT", subLabel: "FOCUS" },
  "focus-on-exiting": { mainLabel: "EXITING", subLabel: "FOCUS" },
  "switch-by-position": { mainLabel: "POSITION", subLabel: "SWITCH" },
  "switch-by-car-number": { mainLabel: "CAR #", subLabel: "SWITCH" },
  "set-camera-state": { mainLabel: "CAM STATE", subLabel: "SET" },
};

// --- Icon generation ---

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the camera controls action.
 */
export function generateCameraControlsSvg(
  settings: { target: Target; direction?: Direction } & Partial<CommonSettings>,
): string {
  const { target, direction = "next" } = settings;

  let iconSvg: string;
  let labels: { mainLabel: string; subLabel: string };

  if (isCycleTarget(target)) {
    iconSvg = CYCLE_ICONS[target]?.[direction] || CYCLE_ICONS["cycle-camera"]["next"];
    labels = CYCLE_LABELS[target]?.[direction] || CYCLE_LABELS["cycle-camera"]["next"];
  } else {
    iconSvg = FOCUS_ICONS[target] || FOCUS_ICONS["focus-your-car"];
    labels = FOCUS_LABELS[target] || FOCUS_LABELS["focus-your-car"];
  }

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Generate an SVG data URI for a specific camera group icon.
 * Used to show which camera group will be activated next.
 */
function generateCameraSelectSvg(
  groupName: string,
  colorOverrides?: Partial<CommonSettings>["colorOverrides"],
): string {
  const iconSvg = CAMERA_SELECT_ICONS[groupName];

  if (!iconSvg) return generateCameraControlsSvg({ target: "cycle-camera", direction: "next" });

  const colors = resolveIconColors(iconSvg, getGlobalColors(), colorOverrides);
  const svg = renderIconTemplate(iconSvg, { mainLabel: groupName.toUpperCase(), ...colors });

  return svgToDataUri(svg);
}

// --- Camera group subset helpers ---

/**
 * @internal Exported for testing
 *
 * Get the list of enabled camera group names from global settings.
 * Falls back to DEFAULT_ENABLED_GROUPS when no setting is stored.
 */
export function getEnabledGroupNames(): string[] {
  const globalSettings = getGlobalSettings() as Record<string, unknown>;
  const raw = globalSettings[CAMERA_GROUPS_GLOBAL_KEY];

  // Value may be a JSON string (from PI) or an already-parsed object
  let subset: Record<string, unknown> | undefined;

  if (typeof raw === "string" && raw) {
    try {
      subset = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return DEFAULT_ENABLED_GROUPS;
    }
  } else if (typeof raw === "object" && raw !== null) {
    subset = raw as Record<string, unknown>;
  }

  if (!subset?.groups) {
    return DEFAULT_ENABLED_GROUPS;
  }

  const groups = subset.groups as Record<string, boolean>;
  const enabled = Object.entries(groups)
    .filter(([, isEnabled]) => isEnabled)
    .map(([name]) => name);

  return enabled.length > 0 ? enabled : DEFAULT_ENABLED_GROUPS;
}

/**
 * @internal Exported for testing
 *
 * Find the next camera group in the selected subset.
 */
export function getNextSelectedGroup(
  currentGroupNum: number,
  enabledGroupNames: string[],
  sessionGroups: CameraGroup[],
  direction: 1 | -1,
): number | null {
  return getNextSelectedGroupEntry(currentGroupNum, enabledGroupNames, sessionGroups, direction)?.groupNum ?? null;
}

/**
 * Find the next camera group entry in the selected subset.
 * Returns both groupNum and groupName, or null if no enabled groups exist.
 */
function getNextSelectedGroupEntry(
  currentGroupNum: number,
  enabledGroupNames: string[],
  sessionGroups: CameraGroup[],
  direction: 1 | -1,
): CameraGroup | null {
  const enabled = sessionGroups
    .filter((g) => enabledGroupNames.includes(g.groupName))
    .sort((a, b) => a.groupNum - b.groupNum);

  if (enabled.length === 0) return null;

  const currentIndex = enabled.findIndex((g) => g.groupNum === currentGroupNum);

  if (currentIndex === -1) {
    if (direction === 1) {
      return enabled.find((g) => g.groupNum > currentGroupNum) ?? enabled[0];
    } else {
      return [...enabled].reverse().find((g) => g.groupNum < currentGroupNum) ?? enabled[enabled.length - 1];
    }
  }

  const nextIndex = (currentIndex + direction + enabled.length) % enabled.length;

  return enabled[nextIndex];
}

// --- Action ---

/**
 * Camera Controls
 * Cycles through cameras, sub-cameras, cars, and driving cameras,
 * and focuses on specific targets (your car, leader, incidents,
 * exiting cars, positions, car numbers, camera state)
 * via iRacing SDK commands.
 */
export const CAMERA_FOCUS_UUID = "com.iracedeck.sd.core.camera-focus" as const;
export const CAMERA_CONTROLS_UUID = CAMERA_FOCUS_UUID;

export class CameraControls extends ConnectionStateAwareAction<CameraControlsSettings> {
  /** Settings per action context for telemetry-driven icon updates */
  private activeContexts = new Map<string, CameraControlsSettings>();

  /** Last displayed group name per context to avoid redundant re-renders */
  private lastDisplayedGroup = new Map<string, string>();

  override async onWillAppear(ev: IDeckWillAppearEvent<CameraControlsSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
      this.updateCycleIcon(ev.action.id);
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<CameraControlsSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastDisplayedGroup.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<CameraControlsSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.lastDisplayedGroup.delete(ev.action.id);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<CameraControlsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (isCycleTarget(settings.target)) {
      this.executeCycle(settings.target, settings.direction);
    } else {
      this.executeFocus(settings);
    }
  }

  override async onDialDown(ev: IDeckDialDownEvent<CameraControlsSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (isCycleTarget(settings.target)) {
      this.executeCycle(settings.target, settings.direction);
    } else {
      this.executeFocus(settings);
    }
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<CameraControlsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (!isCycleTarget(settings.target)) return;

    this.logger.info("Dial rotated");
    const direction: Direction = ev.payload.ticks > 0 ? "next" : "previous";
    this.executeCycle(settings.target, direction);
  }

  private parseSettings(settings: unknown): CameraControlsSettings {
    const parsed = CameraControlsSettings.safeParse(settings);

    return parsed.success ? parsed.data : CameraControlsSettings.parse({});
  }

  private executeCycle(target: CycleTarget, direction: Direction): void {
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

    switch (target) {
      case "cycle-camera": {
        const sessionInfo = this.sdkController.getSessionInfo();
        const sessionGroups = sessionInfo ? getCameraGroupsFromSessionInfo(sessionInfo) : [];

        if (sessionGroups.length === 0) {
          const success = camera.cycleCamera(carIdx, groupNum, dir);
          this.logger.info("Camera group cycled (fallback)");
          this.logger.debug(`Result: ${success}, direction: ${direction}`);
          break;
        }

        const enabledNames = getEnabledGroupNames();
        const nextEntry = getNextSelectedGroupEntry(groupNum, enabledNames, sessionGroups, dir);

        if (nextEntry === null) {
          this.logger.warn("No enabled camera groups found in session");
          break;
        }

        // Use switchNum with car number to keep focus on the same car.
        // switchPos takes race position (not carIdx), so using it would
        // switch to whatever car is at that position.
        const carNumberRaw = getCarNumberRawFromSessionInfo(sessionInfo, carIdx);

        if (carNumberRaw !== null) {
          const success = camera.switchNum(carNumberRaw, nextEntry.groupNum, 0);
          this.logger.info("Camera group switched");
          this.logger.debug(`Result: ${success}, direction: ${direction}, targetGroup: ${nextEntry.groupNum}`);
        } else {
          // Fallback if car number lookup fails
          const success = camera.cycleCamera(carIdx, groupNum, dir);
          this.logger.info("Camera group cycled (car number fallback)");
          this.logger.debug(`Result: ${success}, direction: ${direction}`);
        }

        break;
      }
      case "cycle-sub-camera": {
        const success = camera.cycleSubCamera(carIdx, groupNum, cameraNum, dir);
        this.logger.info("Sub-camera cycled");
        this.logger.debug(`Result: ${success}, direction: ${direction}`);
        break;
      }
      case "cycle-car": {
        const success = camera.cycleCar(carIdx, dir);
        this.logger.info("Car cycled");
        this.logger.debug(`Result: ${success}, direction: ${direction}`);
        break;
      }
      case "cycle-driving": {
        const success = camera.cycleDrivingCamera(carIdx, groupNum, dir);
        this.logger.info("Driving camera cycled");
        this.logger.debug(`Result: ${success}, direction: ${direction}`);
        break;
      }
    }
  }

  private executeFocus(settings: CameraControlsSettings): void {
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
        const sessionInfo = this.sdkController.getSessionInfo();
        const carNumberRaw = sessionInfo ? getCarNumberRawFromSessionInfo(sessionInfo, playerCarIdx) : null;

        if (carNumberRaw !== null) {
          const success = camera.switchNum(carNumberRaw, groupNum, cameraNum);
          this.logger.info("Focus on your car executed");
          this.logger.debug(`Result: ${success}, carNumberRaw: ${carNumberRaw}`);
        } else {
          const success = camera.switchPos(playerCarIdx, groupNum, cameraNum);
          this.logger.info("Focus on your car executed (fallback)");
          this.logger.debug(`Result: ${success}, playerCarIdx: ${playerCarIdx}`);
        }

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

  /**
   * Update the icon for cycle-camera contexts based on current telemetry.
   * Shows the icon of the next camera group that will be activated.
   */
  private async updateCycleIcon(contextId: string): Promise<void> {
    const settings = this.activeContexts.get(contextId);

    if (!settings || settings.target !== "cycle-camera") return;

    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) return;

    const sessionInfo = this.sdkController.getSessionInfo();
    const sessionGroups = sessionInfo ? getCameraGroupsFromSessionInfo(sessionInfo) : [];

    if (sessionGroups.length === 0) return;

    const groupNum = telemetry.CamGroupNumber ?? 1;
    const dir = settings.direction === "next" ? 1 : -1;
    const enabledNames = getEnabledGroupNames();
    const nextEntry = getNextSelectedGroupEntry(groupNum, enabledNames, sessionGroups, dir);

    if (!nextEntry) return;

    // Skip re-render if the next group hasn't changed
    if (this.lastDisplayedGroup.get(contextId) === nextEntry.groupName) return;

    this.lastDisplayedGroup.set(contextId, nextEntry.groupName);
    const svgDataUri = generateCameraSelectSvg(nextEntry.groupName, settings.colorOverrides);
    await this.updateKeyImage(contextId, svgDataUri);
    this.setRegenerateCallback(contextId, () => generateCameraSelectSvg(nextEntry.groupName, settings.colorOverrides));
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<CameraControlsSettings> | IDeckDidReceiveSettingsEvent<CameraControlsSettings>,
    settings: CameraControlsSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateCameraControlsSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateCameraControlsSvg(settings));
  }
}

// Backward-compatible alias
export { CameraControls as CameraFocus };
