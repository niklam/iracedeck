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
import absAdjustDecreaseIconSvg from "@iracedeck/icons/setup-brakes/abs-adjust-decrease.svg";
import absAdjustIncreaseIconSvg from "@iracedeck/icons/setup-brakes/abs-adjust-increase.svg";
import absToggleIconSvg from "@iracedeck/icons/setup-brakes/abs-toggle.svg";
import brakeBiasDecreaseIconSvg from "@iracedeck/icons/setup-brakes/brake-bias-decrease.svg";
import brakeBiasFineDecreaseIconSvg from "@iracedeck/icons/setup-brakes/brake-bias-fine-decrease.svg";
import brakeBiasFineIncreaseIconSvg from "@iracedeck/icons/setup-brakes/brake-bias-fine-increase.svg";
import brakeBiasIncreaseIconSvg from "@iracedeck/icons/setup-brakes/brake-bias-increase.svg";
import brakeMiscDecreaseIconSvg from "@iracedeck/icons/setup-brakes/brake-misc-decrease.svg";
import brakeMiscIncreaseIconSvg from "@iracedeck/icons/setup-brakes/brake-misc-increase.svg";
import engineBrakingDecreaseIconSvg from "@iracedeck/icons/setup-brakes/engine-braking-decrease.svg";
import engineBrakingIncreaseIconSvg from "@iracedeck/icons/setup-brakes/engine-braking-increase.svg";
import peakBrakeBiasDecreaseIconSvg from "@iracedeck/icons/setup-brakes/peak-brake-bias-decrease.svg";
import peakBrakeBiasIncreaseIconSvg from "@iracedeck/icons/setup-brakes/peak-brake-bias-increase.svg";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import {
  formatViewValue,
  generateSetupViewSvg,
  getAdjustmentModeForView,
  isViewSetting,
} from "../../shared/setup-view.js";

type SetupBrakesAdjustSetting =
  | "abs-toggle"
  | "abs-adjust"
  | "brake-bias"
  | "brake-bias-fine"
  | "peak-brake-bias"
  | "brake-misc"
  | "engine-braking";

/**
 * The combined `setting` type is the union of `SetupBrakesAdjustSetting` and the six View
 * IDs in `setup-view.ts`. Code paths narrow back to `SetupBrakesAdjustSetting` after
 * `isViewSetting` gates the View branch; nothing needs the full union as a name.
 */

type DirectionType = "increase" | "decrease";

/** Controls that have +/- direction */
const DIRECTIONAL_CONTROLS: Set<SetupBrakesAdjustSetting> = new Set([
  "abs-adjust",
  "brake-bias",
  "brake-bias-fine",
  "peak-brake-bias",
  "brake-misc",
  "engine-braking",
]);

/**
 * Flat icon lookup mapping setting + direction keys to standalone SVG templates.
 */
const SETUP_BRAKES_ICONS: Record<string, string> = {
  "abs-toggle": absToggleIconSvg,
  "abs-adjust-increase": absAdjustIncreaseIconSvg,
  "abs-adjust-decrease": absAdjustDecreaseIconSvg,
  "brake-bias-increase": brakeBiasIncreaseIconSvg,
  "brake-bias-decrease": brakeBiasDecreaseIconSvg,
  "brake-bias-fine-increase": brakeBiasFineIncreaseIconSvg,
  "brake-bias-fine-decrease": brakeBiasFineDecreaseIconSvg,
  "peak-brake-bias-increase": peakBrakeBiasIncreaseIconSvg,
  "peak-brake-bias-decrease": peakBrakeBiasDecreaseIconSvg,
  "brake-misc-increase": brakeMiscIncreaseIconSvg,
  "brake-misc-decrease": brakeMiscDecreaseIconSvg,
  "engine-braking-increase": engineBrakingIncreaseIconSvg,
  "engine-braking-decrease": engineBrakingDecreaseIconSvg,
};

/**
 * Title text for each setting + direction combination (format: "subLabel\nmainLabel")
 */
const SETUP_BRAKES_TITLES: Record<string, string> = {
  "abs-toggle": "TOGGLE\nABS",
  "abs-adjust-increase": "INCREASE\nABS",
  "abs-adjust-decrease": "DECREASE\nABS",
  "brake-bias-increase": "INCREASE\nBRAKE BIAS",
  "brake-bias-decrease": "DECREASE\nBRAKE BIAS",
  "brake-bias-fine-increase": "INCREASE\nBIAS FINE",
  "brake-bias-fine-decrease": "DECREASE\nBIAS FINE",
  "peak-brake-bias-increase": "INCREASE\nPEAK BIAS",
  "peak-brake-bias-decrease": "DECREASE\nPEAK BIAS",
  "brake-misc-increase": "INCREASE\nBRAKE MISC",
  "brake-misc-decrease": "DECREASE\nBRAKE MISC",
  "engine-braking-increase": "INCREASE\nENG BRAKE",
  "engine-braking-decrease": "DECREASE\nENG BRAKE",
};

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * Directional controls use composite keys (e.g., "brake-bias-increase").
 */
export const SETUP_BRAKES_GLOBAL_KEYS: Record<string, string> = {
  "abs-toggle": "setupBrakesAbsToggle",
  "abs-adjust-increase": "setupBrakesAbsAdjustIncrease",
  "abs-adjust-decrease": "setupBrakesAbsAdjustDecrease",
  "brake-bias-increase": "setupBrakesBrakeBiasIncrease",
  "brake-bias-decrease": "setupBrakesBrakeBiasDecrease",
  "brake-bias-fine-increase": "setupBrakesBrakeBiasFineIncrease",
  "brake-bias-fine-decrease": "setupBrakesBrakeBiasFineDecrease",
  "peak-brake-bias-increase": "setupBrakesPeakBrakeBiasIncrease",
  "peak-brake-bias-decrease": "setupBrakesPeakBrakeBiasDecrease",
  "brake-misc-increase": "setupBrakesBrakeMiscIncrease",
  "brake-misc-decrease": "setupBrakesBrakeMiscDecrease",
  "engine-braking-increase": "setupBrakesEngineBrakingIncrease",
  "engine-braking-decrease": "setupBrakesEngineBrakingDecrease",
};

const SetupBrakesSettings = CommonSettings.extend({
  setting: z
    .enum([
      // View sub-modes (read-only telemetry display) — listed first to appear at the top of the PI dropdown.
      "view-brake-bias",
      "view-brake-bias-fine",
      "view-peak-brake-bias",
      "view-brake-misc",
      "view-engine-braking",
      "view-abs-adjust",
      // Adjustment sub-modes (existing).
      "abs-toggle",
      "abs-adjust",
      "brake-bias",
      "brake-bias-fine",
      "peak-brake-bias",
      "brake-misc",
      "engine-braking",
    ])
    .default("brake-bias"),
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

type SetupBrakesSettings = z.infer<typeof SetupBrakesSettings>;

/**
 * Resolves the flat icon lookup key for a given adjustment setting and direction.
 * View sub-modes use a separate render path (`generateSetupViewSvg`) and never reach this.
 */
function resolveIconKey(setting: SetupBrakesAdjustSetting, direction: DirectionType): string {
  if (DIRECTIONAL_CONTROLS.has(setting)) {
    return `${setting}-${direction}`;
  }

  return setting;
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup brakes action's adjustment sub-modes.
 * View sub-modes call `generateSetupViewSvg` via `renderSettingIcon` instead.
 */
export function generateSetupBrakesSvg(settings: SetupBrakesSettings): string {
  if (isViewSetting(settings.setting)) {
    // View sub-modes have no static icon — they render telemetry through the shared template.
    // Return a placeholder so callers that ignore telemetry get a stable string.
    return generateSetupViewSvg({
      viewId: settings.setting,
      telemetry: null,
      colorSourceSvg: brakeBiasIncreaseIconSvg,
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
    });
  }

  const setting = settings.setting as SetupBrakesAdjustSetting;
  const { direction } = settings;

  const iconKey = resolveIconKey(setting, direction);
  const iconSvg = SETUP_BRAKES_ICONS[iconKey] || SETUP_BRAKES_ICONS["abs-toggle"];
  const defaultTitle = SETUP_BRAKES_TITLES[iconKey] || "SETUP\nBRAKE";

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
}

/**
 * Setup Brakes Action
 * Provides brake-related in-car adjustments (ABS, brake bias, peak bias,
 * engine braking) via keyboard shortcuts.
 */
export const SETUP_BRAKES_UUID = "com.iracedeck.sd.core.setup-brakes" as const;

export class SetupBrakes extends ConnectionStateAwareAction<SetupBrakesSettings> {
  /** Current settings per action context, used by the telemetry-tick callback for View sub-modes. */
  private readonly activeContexts = new Map<string, SetupBrakesSettings>();

  /** Last rendered View value per context — memoizes the icon so we only re-emit on actual change. */
  private readonly lastRenderedValue = new Map<string, string>();

  /** Per-context key-down timestamps for dual-press dispatch on View sub-modes (#540). */
  private readonly dualPress = new DualPressTracker();

  override async onWillAppear(ev: IDeckWillAppearEvent<SetupBrakesSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.applyActiveBinding(settings);
    await this.updateDisplay(ev, settings);

    // Subscribe always; the callback no-ops for non-View settings. View entries can be
    // toggled in / out via `onDidReceiveSettings` without resubscribing.
    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      const stored = this.activeContexts.get(ev.action.id);

      if (stored && isViewSetting(stored.setting)) {
        void this.updateDisplayFromTelemetry(ev.action.id, telemetry, stored);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SetupBrakesSettings>): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastRenderedValue.delete(ev.action.id);
    this.dualPress.clear(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SetupBrakesSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    // Bust the memo cache so the next tick re-renders even if the new mode happens to
    // resolve to the same display string as the previous mode.
    this.lastRenderedValue.delete(ev.action.id);
    this.applyActiveBinding(settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<SetupBrakesSettings>): Promise<void> {
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

  override async onKeyUp(ev: IDeckKeyUpEvent<SetupBrakesSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (!isViewSetting(settings.setting) || !settings.dualPressEnabled) {
      // Non-View modes already fired on key-down; dual-press disabled means read-only.
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

    if (direction === undefined) {
      // Stray key-up with no matching key-down (e.g. dual-press just enabled mid-press).
      return;
    }

    this.logger.info("Dual-press dispatch");
    this.logger.debug(`Dual-press: ${adjustMode} ${direction}`);
    const settingKey = SETUP_BRAKES_GLOBAL_KEYS[`${adjustMode}-${direction}`];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for dual-press ${adjustMode} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  override async onDialDown(ev: IDeckDialDownEvent<SetupBrakesSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (isViewSetting(settings.setting)) return;

    this.logger.info("Dial down received");
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<SetupBrakesSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (isViewSetting(settings.setting)) return;

    this.logger.info("Dial rotated");
    const adjustSetting = settings.setting as SetupBrakesAdjustSetting;

    // Non-directional controls have no +/- adjustment — ignore rotation
    if (!DIRECTIONAL_CONTROLS.has(adjustSetting)) {
      this.logger.debug(`Rotation ignored for ${adjustSetting}`);

      return;
    }

    // Clockwise (ticks > 0) = increase, Counter-clockwise (ticks < 0) = decrease
    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.executeSetting(adjustSetting, direction);
  }

  private parseSettings(settings: unknown): SetupBrakesSettings {
    const parsed = SetupBrakesSettings.safeParse(settings);

    return parsed.success ? parsed.data : SetupBrakesSettings.parse({});
  }

  private applyActiveBinding(settings: SetupBrakesSettings): void {
    if (isViewSetting(settings.setting)) {
      if (!settings.dualPressEnabled) {
        // Read-only View — no binding drives the key, so clear the readiness overlay.
        this.setActiveBinding(null);

        return;
      }

      // Dual-press is active: the tap direction is the primary action, so the
      // readiness overlay tracks that binding. (Long-press fires the opposite,
      // but a single chip can only show one — pick the tap.)
      const adjustMode = getAdjustmentModeForView(settings.setting);
      const tapDir: DirectionType = getDualPressDirections() === "tap-increases" ? "increase" : "decrease";
      const activeKey = adjustMode ? (SETUP_BRAKES_GLOBAL_KEYS[`${adjustMode}-${tapDir}`] ?? null) : null;
      this.setActiveBinding(activeKey);

      return;
    }

    const activeKey = this.resolveGlobalKey(settings.setting, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }
  }

  private async executeSetting(setting: SetupBrakesAdjustSetting, direction: DirectionType): Promise<void> {
    const settingKey = this.resolveGlobalKey(setting, direction);

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${setting} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  private resolveGlobalKey(setting: SetupBrakesAdjustSetting, direction: DirectionType): string | null {
    if (DIRECTIONAL_CONTROLS.has(setting)) {
      const key = `${setting}-${direction}`;

      return SETUP_BRAKES_GLOBAL_KEYS[key] ?? null;
    }

    return SETUP_BRAKES_GLOBAL_KEYS[setting] ?? null;
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<SetupBrakesSettings> | IDeckDidReceiveSettingsEvent<SetupBrakesSettings>,
    settings: SetupBrakesSettings,
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

  private renderIcon(settings: SetupBrakesSettings): string {
    if (isViewSetting(settings.setting)) {
      return generateSetupViewSvg({
        viewId: settings.setting,
        telemetry: this.sdkController.getCurrentTelemetry(),
        colorSourceSvg: brakeBiasIncreaseIconSvg,
        colorOverrides: settings.colorOverrides,
        titleOverrides: settings.titleOverrides,
        borderOverrides: settings.borderOverrides,
      });
    }

    return generateSetupBrakesSvg(settings);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: SetupBrakesSettings,
  ): Promise<void> {
    if (!isViewSetting(settings.setting)) return;

    const value = formatViewValue(settings.setting, telemetry);

    if (this.lastRenderedValue.get(contextId) === value) return;

    this.lastRenderedValue.set(contextId, value);
    const svgDataUri = generateSetupViewSvg({
      viewId: settings.setting,
      telemetry,
      colorSourceSvg: brakeBiasIncreaseIconSvg,
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
    });
    await this.updateKeyImage(contextId, svgDataUri);
  }
}
