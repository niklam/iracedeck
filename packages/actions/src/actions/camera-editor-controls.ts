import {
  CommonSettings,
  ConnectionStateAwareAction,
  formatKeyBinding,
  getGlobalColors,
  getGlobalSettings,
  getKeyboard,
  getSimHub,
  type IDeckDialDownEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  isSimHubBinding,
  isSimHubInitialized,
  type KeyBindingValue,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  parseBinding,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "@iracedeck/deck-core";
import acquireEndIconSvg from "@iracedeck/icons/camera-editor-controls/acquire-end.svg";
import acquireStartIconSvg from "@iracedeck/icons/camera-editor-controls/acquire-start.svg";
import beyondFenceToggleIconSvg from "@iracedeck/icons/camera-editor-controls/beyond-fence-toggle.svg";
import copyCameraIconSvg from "@iracedeck/icons/camera-editor-controls/copy-camera.svg";
import copyGroupIconSvg from "@iracedeck/icons/camera-editor-controls/copy-group.svg";
import cycleAimTypeIconSvg from "@iracedeck/icons/camera-editor-controls/cycle-aim-type.svg";
import cyclePositionTypeIconSvg from "@iracedeck/icons/camera-editor-controls/cycle-position-type.svg";
import dampeningToggleIconSvg from "@iracedeck/icons/camera-editor-controls/dampening-toggle.svg";
import inCockpitToggleIconSvg from "@iracedeck/icons/camera-editor-controls/in-cockpit-toggle.svg";
import insertCameraIconSvg from "@iracedeck/icons/camera-editor-controls/insert-camera.svg";
import key10xToggleIconSvg from "@iracedeck/icons/camera-editor-controls/key-10x-toggle.svg";
import keyAccelerationToggleIconSvg from "@iracedeck/icons/camera-editor-controls/key-acceleration-toggle.svg";
import limitShotRangeToggleIconSvg from "@iracedeck/icons/camera-editor-controls/limit-shot-range-toggle.svg";
import loadCarCameraIconSvg from "@iracedeck/icons/camera-editor-controls/load-car-camera.svg";
import loadTrackCameraIconSvg from "@iracedeck/icons/camera-editor-controls/load-track-camera.svg";
import manualFocusToggleIconSvg from "@iracedeck/icons/camera-editor-controls/manual-focus-toggle.svg";
import mouseNavigationToggleIconSvg from "@iracedeck/icons/camera-editor-controls/mouse-navigation-toggle.svg";
import openCameraToolIconSvg from "@iracedeck/icons/camera-editor-controls/open-camera-tool.svg";
import parabolicMicToggleIconSvg from "@iracedeck/icons/camera-editor-controls/parabolic-mic-toggle.svg";
import pasteCameraIconSvg from "@iracedeck/icons/camera-editor-controls/paste-camera.svg";
import pasteGroupIconSvg from "@iracedeck/icons/camera-editor-controls/paste-group.svg";
import pitchGyroToggleIconSvg from "@iracedeck/icons/camera-editor-controls/pitch-gyro-toggle.svg";
import removeCameraIconSvg from "@iracedeck/icons/camera-editor-controls/remove-camera.svg";
import rollGyroToggleIconSvg from "@iracedeck/icons/camera-editor-controls/roll-gyro-toggle.svg";
import saveCarCameraIconSvg from "@iracedeck/icons/camera-editor-controls/save-car-camera.svg";
import saveTrackCameraIconSvg from "@iracedeck/icons/camera-editor-controls/save-track-camera.svg";
import shotSelectionToggleIconSvg from "@iracedeck/icons/camera-editor-controls/shot-selection-toggle.svg";
import showCameraToggleIconSvg from "@iracedeck/icons/camera-editor-controls/show-camera-toggle.svg";
import temporaryEditsToggleIconSvg from "@iracedeck/icons/camera-editor-controls/temporary-edits-toggle.svg";
import zoomToggleIconSvg from "@iracedeck/icons/camera-editor-controls/zoom-toggle.svg";
import z from "zod";

const CONTROL_VALUES = [
  "open-camera-tool",
  "key-acceleration-toggle",
  "key-10x-toggle",
  "parabolic-mic-toggle",
  "cycle-position-type",
  "cycle-aim-type",
  "acquire-start",
  "acquire-end",
  "temporary-edits-toggle",
  "dampening-toggle",
  "zoom-toggle",
  "beyond-fence-toggle",
  "in-cockpit-toggle",
  "mouse-navigation-toggle",
  "pitch-gyro-toggle",
  "roll-gyro-toggle",
  "limit-shot-range-toggle",
  "show-camera-toggle",
  "shot-selection-toggle",
  "manual-focus-toggle",
  "insert-camera",
  "remove-camera",
  "copy-camera",
  "paste-camera",
  "copy-group",
  "paste-group",
  "save-track-camera",
  "load-track-camera",
  "save-car-camera",
  "load-car-camera",
] as const;

type ControlType = (typeof CONTROL_VALUES)[number];

const CONTROL_ICONS: Record<ControlType, string> = {
  "open-camera-tool": openCameraToolIconSvg,
  "key-acceleration-toggle": keyAccelerationToggleIconSvg,
  "key-10x-toggle": key10xToggleIconSvg,
  "parabolic-mic-toggle": parabolicMicToggleIconSvg,
  "cycle-position-type": cyclePositionTypeIconSvg,
  "cycle-aim-type": cycleAimTypeIconSvg,
  "acquire-start": acquireStartIconSvg,
  "acquire-end": acquireEndIconSvg,
  "temporary-edits-toggle": temporaryEditsToggleIconSvg,
  "dampening-toggle": dampeningToggleIconSvg,
  "zoom-toggle": zoomToggleIconSvg,
  "beyond-fence-toggle": beyondFenceToggleIconSvg,
  "in-cockpit-toggle": inCockpitToggleIconSvg,
  "mouse-navigation-toggle": mouseNavigationToggleIconSvg,
  "pitch-gyro-toggle": pitchGyroToggleIconSvg,
  "roll-gyro-toggle": rollGyroToggleIconSvg,
  "limit-shot-range-toggle": limitShotRangeToggleIconSvg,
  "show-camera-toggle": showCameraToggleIconSvg,
  "shot-selection-toggle": shotSelectionToggleIconSvg,
  "manual-focus-toggle": manualFocusToggleIconSvg,
  "insert-camera": insertCameraIconSvg,
  "remove-camera": removeCameraIconSvg,
  "copy-camera": copyCameraIconSvg,
  "paste-camera": pasteCameraIconSvg,
  "copy-group": copyGroupIconSvg,
  "paste-group": pasteGroupIconSvg,
  "save-track-camera": saveTrackCameraIconSvg,
  "load-track-camera": loadTrackCameraIconSvg,
  "save-car-camera": saveCarCameraIconSvg,
  "load-car-camera": loadCarCameraIconSvg,
};

/**
 * Label configuration for each control.
 */
const CAMERA_EDITOR_CONTROLS_LABELS: Record<ControlType, { mainLabel: string; subLabel: string }> = {
  "open-camera-tool": { mainLabel: "OPEN", subLabel: "CAM TOOL" },
  "key-acceleration-toggle": { mainLabel: "KEY ACCEL", subLabel: "TOGGLE" },
  "key-10x-toggle": { mainLabel: "KEY 10X", subLabel: "TOGGLE" },
  "parabolic-mic-toggle": { mainLabel: "PARA MIC", subLabel: "TOGGLE" },
  "cycle-position-type": { mainLabel: "POS TYPE", subLabel: "CYCLE" },
  "cycle-aim-type": { mainLabel: "AIM TYPE", subLabel: "CYCLE" },
  "acquire-start": { mainLabel: "ACQ START", subLabel: "ACQUIRE" },
  "acquire-end": { mainLabel: "ACQ END", subLabel: "ACQUIRE" },
  "temporary-edits-toggle": { mainLabel: "TEMP EDIT", subLabel: "TOGGLE" },
  "dampening-toggle": { mainLabel: "DAMPEN", subLabel: "TOGGLE" },
  "zoom-toggle": { mainLabel: "ZOOM", subLabel: "TOGGLE" },
  "beyond-fence-toggle": { mainLabel: "BND FENCE", subLabel: "TOGGLE" },
  "in-cockpit-toggle": { mainLabel: "IN COCKPIT", subLabel: "TOGGLE" },
  "mouse-navigation-toggle": { mainLabel: "MOUSE NAV", subLabel: "TOGGLE" },
  "pitch-gyro-toggle": { mainLabel: "PITCH GYRO", subLabel: "TOGGLE" },
  "roll-gyro-toggle": { mainLabel: "ROLL GYRO", subLabel: "TOGGLE" },
  "limit-shot-range-toggle": { mainLabel: "SHOT RNG", subLabel: "TOGGLE" },
  "show-camera-toggle": { mainLabel: "SHOW CAM", subLabel: "TOGGLE" },
  "shot-selection-toggle": { mainLabel: "SHOT SEL", subLabel: "TOGGLE" },
  "manual-focus-toggle": { mainLabel: "MAN FOCUS", subLabel: "TOGGLE" },
  "insert-camera": { mainLabel: "INSERT", subLabel: "CAMERA" },
  "remove-camera": { mainLabel: "REMOVE", subLabel: "CAMERA" },
  "copy-camera": { mainLabel: "COPY", subLabel: "CAMERA" },
  "paste-camera": { mainLabel: "PASTE", subLabel: "CAMERA" },
  "copy-group": { mainLabel: "COPY", subLabel: "GROUP" },
  "paste-group": { mainLabel: "PASTE", subLabel: "GROUP" },
  "save-track-camera": { mainLabel: "SAVE", subLabel: "TRACK CAM" },
  "load-track-camera": { mainLabel: "LOAD", subLabel: "TRACK CAM" },
  "save-car-camera": { mainLabel: "SAVE", subLabel: "CAR CAM" },
  "load-car-camera": { mainLabel: "LOAD", subLabel: "CAR CAM" },
};

/**
 * @internal Exported for testing
 *
 * Mapping from control setting values (kebab-case) to global settings keys.
 */
export const CAMERA_EDITOR_CONTROLS_GLOBAL_KEYS: Record<ControlType, string> = {
  "open-camera-tool": "camCtrlOpenCameraTool",
  "key-acceleration-toggle": "camCtrlKeyAccelerationToggle",
  "key-10x-toggle": "camCtrlKey10xToggle",
  "parabolic-mic-toggle": "camCtrlParabolicMicToggle",
  "cycle-position-type": "camCtrlCyclePositionType",
  "cycle-aim-type": "camCtrlCycleAimType",
  "acquire-start": "camCtrlAcquireStart",
  "acquire-end": "camCtrlAcquireEnd",
  "temporary-edits-toggle": "camCtrlTemporaryEditsToggle",
  "dampening-toggle": "camCtrlDampeningToggle",
  "zoom-toggle": "camCtrlZoomToggle",
  "beyond-fence-toggle": "camCtrlBeyondFenceToggle",
  "in-cockpit-toggle": "camCtrlInCockpitToggle",
  "mouse-navigation-toggle": "camCtrlMouseNavigationToggle",
  "pitch-gyro-toggle": "camCtrlPitchGyroToggle",
  "roll-gyro-toggle": "camCtrlRollGyroToggle",
  "limit-shot-range-toggle": "camCtrlLimitShotRangeToggle",
  "show-camera-toggle": "camCtrlShowCameraToggle",
  "shot-selection-toggle": "camCtrlShotSelectionToggle",
  "manual-focus-toggle": "camCtrlManualFocusToggle",
  "insert-camera": "camCtrlInsertCamera",
  "remove-camera": "camCtrlRemoveCamera",
  "copy-camera": "camCtrlCopyCamera",
  "paste-camera": "camCtrlPasteCamera",
  "copy-group": "camCtrlCopyGroup",
  "paste-group": "camCtrlPasteGroup",
  "save-track-camera": "camCtrlSaveTrackCamera",
  "load-track-camera": "camCtrlLoadTrackCamera",
  "save-car-camera": "camCtrlSaveCarCamera",
  "load-car-camera": "camCtrlLoadCarCamera",
};

const CameraEditorControlsSettings = CommonSettings.extend({
  control: z.enum(CONTROL_VALUES).default("open-camera-tool"),
});

type CameraEditorControlsSettings = z.infer<typeof CameraEditorControlsSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the camera editor controls action.
 */
export function generateCameraEditorControlsSvg(settings: CameraEditorControlsSettings): string {
  const { control } = settings;

  const iconSvg = CONTROL_ICONS[control] || CONTROL_ICONS["open-camera-tool"];
  const labels = CAMERA_EDITOR_CONTROLS_LABELS[control] || CAMERA_EDITOR_CONTROLS_LABELS["open-camera-tool"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Camera Editor Controls Action
 * Camera editor toggles and management controls for broadcasters and content creators.
 */
export const CAMERA_EDITOR_CONTROLS_UUID = "com.iracedeck.sd.core.camera-editor-controls" as const;

export class CameraEditorControls extends ConnectionStateAwareAction<CameraEditorControlsSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<CameraEditorControlsSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<CameraEditorControlsSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<CameraEditorControlsSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<CameraEditorControlsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(settings.control);
  }

  override async onDialDown(ev: IDeckDialDownEvent<CameraEditorControlsSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(settings.control);
  }

  private parseSettings(settings: unknown): CameraEditorControlsSettings {
    const parsed = CameraEditorControlsSettings.safeParse(settings);

    return parsed.success ? parsed.data : CameraEditorControlsSettings.parse({});
  }

  private async executeControl(control: ControlType): Promise<void> {
    this.logger.info("Control triggered");
    this.logger.debug(`Executing ${control}`);

    const settingKey = CAMERA_EDITOR_CONTROLS_GLOBAL_KEYS[control];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${control}`);

      return;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseBinding(globalSettings[settingKey]);

    if (!binding) {
      this.logger.warn(`No binding configured for ${settingKey}`);

      return;
    }

    if (isSimHubBinding(binding)) {
      this.logger.info("Triggering SimHub role");
      this.logger.debug(`SimHub role: ${binding.role}`);

      if (isSimHubInitialized()) {
        const simHub = getSimHub();
        await simHub.startRole(binding.role);
        await simHub.stopRole(binding.role);
      } else {
        this.logger.warn("SimHub service not initialized");
      }

      return;
    }

    this.logger.debug(`Key binding for ${settingKey}: ${formatKeyBinding(binding)} (code=${binding.code ?? "none"})`);

    await this.sendKeyBinding(binding);
  }

  private async sendKeyBinding(binding: KeyBindingValue): Promise<void> {
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
    ev: IDeckWillAppearEvent<CameraEditorControlsSettings> | IDeckDidReceiveSettingsEvent<CameraEditorControlsSettings>,
    settings: CameraEditorControlsSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateCameraEditorControlsSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateCameraEditorControlsSvg(settings));
  }
}
