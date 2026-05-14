import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  DualPressTracker,
  getDualPressDirections,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import disableFuelCutIconSvg from "@iracedeck/icons/setup-fuel/disable-fuel-cut.svg";
import fcyModeToggleIconSvg from "@iracedeck/icons/setup-fuel/fcy-mode-toggle.svg";
import fuelCutPositionDecreaseIconSvg from "@iracedeck/icons/setup-fuel/fuel-cut-position-decrease.svg";
import fuelCutPositionIncreaseIconSvg from "@iracedeck/icons/setup-fuel/fuel-cut-position-increase.svg";
import fuelMixtureDecreaseIconSvg from "@iracedeck/icons/setup-fuel/fuel-mixture-decrease.svg";
import fuelMixtureIncreaseIconSvg from "@iracedeck/icons/setup-fuel/fuel-mixture-increase.svg";
import lowFuelAcceptIconSvg from "@iracedeck/icons/setup-fuel/low-fuel-accept.svg";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import {
  formatViewValue,
  generateSetupViewSvg,
  getAdjustmentModeForView,
  isViewSetting,
} from "../../shared/setup-view.js";

type SetupFuelAdjustSetting =
  | "fuel-mixture"
  | "fuel-cut-position"
  | "disable-fuel-cut"
  | "low-fuel-accept"
  | "fcy-mode-toggle";

/**
 * The combined `setting` type is the union of `SetupFuelAdjustSetting` and the two View
 * IDs in `setup-view.ts`. Code paths narrow back to `SetupFuelAdjustSetting` after
 * `isViewSetting` gates the View branch; nothing needs the full union as a name.
 */

type DirectionType = "increase" | "decrease";

/** Controls that have +/- direction */
const DIRECTIONAL_CONTROLS: Set<SetupFuelAdjustSetting> = new Set(["fuel-mixture", "fuel-cut-position"]);

/**
 * Flat icon lookup record mapping setting + direction keys to imported SVGs.
 */
const SETUP_FUEL_ICONS: Record<string, string> = {
  "fuel-mixture-increase": fuelMixtureIncreaseIconSvg,
  "fuel-mixture-decrease": fuelMixtureDecreaseIconSvg,
  "fuel-cut-position-increase": fuelCutPositionIncreaseIconSvg,
  "fuel-cut-position-decrease": fuelCutPositionDecreaseIconSvg,
  "disable-fuel-cut": disableFuelCutIconSvg,
  "low-fuel-accept": lowFuelAcceptIconSvg,
  "fcy-mode-toggle": fcyModeToggleIconSvg,
};

/**
 * Title text for each setting + direction combination (format: "subLabel\nmainLabel")
 */
const SETUP_FUEL_TITLES: Record<string, string> = {
  "fuel-mixture-increase": "INCREASE\nFUEL MIX",
  "fuel-mixture-decrease": "DECREASE\nFUEL MIX",
  "fuel-cut-position-increase": "INCREASE\nFUEL CUT",
  "fuel-cut-position-decrease": "DECREASE\nFUEL CUT",
  "disable-fuel-cut": "DISABLE\nFUEL CUT",
  "low-fuel-accept": "ACCEPT\nLOW FUEL",
  "fcy-mode-toggle": "TOGGLE\nFCY MODE",
};

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * Directional controls use composite keys (e.g., "fuel-mixture-increase").
 */
export const SETUP_FUEL_GLOBAL_KEYS: Record<string, string> = {
  "fuel-mixture-increase": "setupFuelFuelMixtureIncrease",
  "fuel-mixture-decrease": "setupFuelFuelMixtureDecrease",
  "fuel-cut-position-increase": "setupFuelFuelCutPositionIncrease",
  "fuel-cut-position-decrease": "setupFuelFuelCutPositionDecrease",
  "disable-fuel-cut": "setupFuelDisableFuelCut",
  "low-fuel-accept": "setupFuelLowFuelAccept",
  "fcy-mode-toggle": "setupFuelFcyModeToggle",
};

const SetupFuelSettings = CommonSettings.extend({
  setting: z
    .enum([
      // View sub-modes.
      "view-fuel-mixture",
      "view-fuel-cut-position",
      // Adjustment sub-modes.
      "fuel-mixture",
      "fuel-cut-position",
      "disable-fuel-cut",
      "low-fuel-accept",
      "fcy-mode-toggle",
    ])
    .default("fuel-mixture"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
  /**
   * Dual-press opt-in for View sub-modes (issue #540). When `true` (default),
   * a View key fires the global tap direction on a short press and the
   * opposite on a long press (held ≥ `dualPressThresholdMs`). When `false`,
   * the View stays purely read-only. Ignored for adjustment / toggle
   * sub-modes. The tap direction itself is the plugin-wide
   * `dualPressDirections` global setting.
   */
  dualPressEnabled: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true")
    .default(true),
});

type SetupFuelSettings = z.infer<typeof SetupFuelSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup fuel action's adjustment sub-modes.
 * View sub-modes use the shared `generateSetupViewSvg` render path.
 */
export function generateSetupFuelSvg(settings: SetupFuelSettings): string {
  if (isViewSetting(settings.setting)) {
    return generateSetupViewSvg({
      viewId: settings.setting,
      telemetry: null,
      colorSourceSvg: fuelMixtureIncreaseIconSvg,
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
    });
  }

  const setting = settings.setting as SetupFuelAdjustSetting;
  const { direction } = settings;

  const iconKey = DIRECTIONAL_CONTROLS.has(setting) ? `${setting}-${direction}` : setting;
  const iconSvg = SETUP_FUEL_ICONS[iconKey] || SETUP_FUEL_ICONS["disable-fuel-cut"];
  const defaultTitle = SETUP_FUEL_TITLES[iconKey] || "SETUP\nFUEL";

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
}

/**
 * Setup Fuel Action
 * Provides fuel-related in-car adjustments (fuel mixture, fuel cut position,
 * disable fuel cut, low fuel accept, FCY mode) via keyboard shortcuts.
 */
export const SETUP_FUEL_UUID = "com.iracedeck.sd.core.setup-fuel" as const;

export class SetupFuel extends ConnectionStateAwareAction<SetupFuelSettings> {
  /** Current settings per action context, used by the telemetry-tick callback for View sub-modes. */
  private readonly activeContexts = new Map<string, SetupFuelSettings>();

  /** Last rendered View value per context — memoizes the icon so we only re-emit on actual change. */
  private readonly lastRenderedValue = new Map<string, string>();

  /** Per-context key-down timestamps for dual-press dispatch on View sub-modes (#540). */
  private readonly dualPress = new DualPressTracker();

  override async onWillAppear(ev: IDeckWillAppearEvent<SetupFuelSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.applyActiveBinding(settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      const stored = this.activeContexts.get(ev.action.id);

      if (stored && isViewSetting(stored.setting)) {
        void this.updateDisplayFromTelemetry(ev.action.id, telemetry, stored);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SetupFuelSettings>): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastRenderedValue.delete(ev.action.id);
    this.dualPress.clear(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SetupFuelSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.lastRenderedValue.delete(ev.action.id);
    this.applyActiveBinding(settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<SetupFuelSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (isViewSetting(settings.setting)) {
      if (settings.dualPressEnabled) {
        this.dualPress.recordKeyDown(ev.action.id);
      } else {
        this.logger.debug("View sub-mode is read-only (dual-press off), ignoring key press");
      }

      return;
    }

    this.logger.info("Key down received");
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<SetupFuelSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (!isViewSetting(settings.setting) || !settings.dualPressEnabled) {
      this.dualPress.clear(ev.action.id);

      return;
    }

    const adjustMode = getAdjustmentModeForView(settings.setting);

    if (!adjustMode) {
      this.dualPress.clear(ev.action.id);

      return;
    }

    const tapDir: DirectionType = getDualPressDirections() === "tap-increases" ? "increase" : "decrease";
    const longDir: DirectionType = tapDir === "increase" ? "decrease" : "increase";
    const direction = this.dualPress.computeOutcome(ev.action.id, tapDir, longDir);

    if (direction === undefined) return;

    this.logger.info("Dual-press dispatch");
    this.logger.debug(`Dual-press: ${adjustMode} ${direction}`);
    const settingKey = SETUP_FUEL_GLOBAL_KEYS[`${adjustMode}-${direction}`];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for dual-press ${adjustMode} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  override async onDialDown(ev: IDeckDialDownEvent<SetupFuelSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (isViewSetting(settings.setting)) return;

    this.logger.info("Dial down received");
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<SetupFuelSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (isViewSetting(settings.setting)) return;

    this.logger.info("Dial rotated");
    const adjustSetting = settings.setting as SetupFuelAdjustSetting;

    // Non-directional controls have no +/- adjustment — ignore rotation
    if (!DIRECTIONAL_CONTROLS.has(adjustSetting)) {
      this.logger.debug(`Rotation ignored for ${adjustSetting}`);

      return;
    }

    // Clockwise (ticks > 0) = increase, Counter-clockwise (ticks < 0) = decrease
    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.executeSetting(adjustSetting, direction);
  }

  private parseSettings(settings: unknown): SetupFuelSettings {
    const parsed = SetupFuelSettings.safeParse(settings);

    return parsed.success ? parsed.data : SetupFuelSettings.parse({});
  }

  private applyActiveBinding(settings: SetupFuelSettings): void {
    if (isViewSetting(settings.setting)) {
      if (!settings.dualPressEnabled) {
        this.setActiveBinding(null);

        return;
      }

      const adjustMode = getAdjustmentModeForView(settings.setting);
      const tapDir: DirectionType = getDualPressDirections() === "tap-increases" ? "increase" : "decrease";
      const activeKey = adjustMode ? (SETUP_FUEL_GLOBAL_KEYS[`${adjustMode}-${tapDir}`] ?? null) : null;
      this.setActiveBinding(activeKey);

      return;
    }

    const activeKey = this.resolveGlobalKey(settings.setting, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }
  }

  private async executeSetting(setting: SetupFuelAdjustSetting, direction: DirectionType): Promise<void> {
    const settingKey = this.resolveGlobalKey(setting, direction);

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${setting} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  private resolveGlobalKey(setting: SetupFuelAdjustSetting, direction: DirectionType): string | null {
    if (DIRECTIONAL_CONTROLS.has(setting)) {
      const key = `${setting}-${direction}`;

      return SETUP_FUEL_GLOBAL_KEYS[key] ?? null;
    }

    return SETUP_FUEL_GLOBAL_KEYS[setting] ?? null;
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<SetupFuelSettings> | IDeckDidReceiveSettingsEvent<SetupFuelSettings>,
    settings: SetupFuelSettings,
  ): Promise<void> {
    const svgDataUri = this.renderIcon(settings);

    if (isViewSetting(settings.setting)) {
      const telemetry = this.sdkController.getCurrentTelemetry();
      this.lastRenderedValue.set(ev.action.id, formatViewValue(settings.setting, telemetry));
    }

    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => this.renderIcon(settings));
  }

  private renderIcon(settings: SetupFuelSettings): string {
    if (isViewSetting(settings.setting)) {
      return generateSetupViewSvg({
        viewId: settings.setting,
        telemetry: this.sdkController.getCurrentTelemetry(),
        colorSourceSvg: fuelMixtureIncreaseIconSvg,
        colorOverrides: settings.colorOverrides,
        titleOverrides: settings.titleOverrides,
        borderOverrides: settings.borderOverrides,
      });
    }

    return generateSetupFuelSvg(settings);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: SetupFuelSettings,
  ): Promise<void> {
    if (!isViewSetting(settings.setting)) return;

    const value = formatViewValue(settings.setting, telemetry);

    if (this.lastRenderedValue.get(contextId) === value) return;

    this.lastRenderedValue.set(contextId, value);
    const svgDataUri = generateSetupViewSvg({
      viewId: settings.setting,
      telemetry,
      colorSourceSvg: fuelMixtureIncreaseIconSvg,
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
    });
    await this.updateKeyImage(contextId, svgDataUri);
  }
}
