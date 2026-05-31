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
  type IDeckDialUpEvent,
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
import hysBoostIconSvg from "@iracedeck/icons/setup-hybrid/hys-boost.svg";
import hysNoBoostIconSvg from "@iracedeck/icons/setup-hybrid/hys-no-boost.svg";
import hysRegenIconSvg from "@iracedeck/icons/setup-hybrid/hys-regen.svg";
import mgukDeployModeDecreaseIconSvg from "@iracedeck/icons/setup-hybrid/mguk-deploy-mode-decrease.svg";
import mgukDeployModeIncreaseIconSvg from "@iracedeck/icons/setup-hybrid/mguk-deploy-mode-increase.svg";
import mgukFixedDeployDecreaseIconSvg from "@iracedeck/icons/setup-hybrid/mguk-fixed-deploy-decrease.svg";
import mgukFixedDeployIncreaseIconSvg from "@iracedeck/icons/setup-hybrid/mguk-fixed-deploy-increase.svg";
import mgukRegenGainDecreaseIconSvg from "@iracedeck/icons/setup-hybrid/mguk-regen-gain-decrease.svg";
import mgukRegenGainIncreaseIconSvg from "@iracedeck/icons/setup-hybrid/mguk-regen-gain-increase.svg";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import {
  formatViewValue,
  generateSetupViewSvg,
  getAdjustmentModeForView,
  isViewSetting,
} from "../../shared/setup-view.js";

type SetupHybridAdjustSetting =
  | "mguk-regen-gain"
  | "mguk-deploy-mode"
  | "mguk-fixed-deploy"
  | "hys-boost"
  | "hys-regen"
  | "hys-no-boost";

/**
 * The combined `setting` type is the union of `SetupHybridAdjustSetting` and the three
 * View IDs in `setup-view.ts`. Code paths narrow back to `SetupHybridAdjustSetting`
 * after `isViewSetting` gates the View branch; nothing needs the full union as a name.
 */

type DirectionType = "increase" | "decrease";

/** Controls that have +/- direction */
const DIRECTIONAL_CONTROLS: Set<SetupHybridAdjustSetting> = new Set([
  "mguk-regen-gain",
  "mguk-deploy-mode",
  "mguk-fixed-deploy",
]);

/** Controls that use long-press hold behavior */
const HOLD_CONTROLS: Set<SetupHybridAdjustSetting> = new Set(["hys-boost", "hys-regen"]);

/**
 * Flat icon lookup record mapping setting + direction keys to standalone SVG templates.
 */
const SETUP_HYBRID_ICONS: Record<string, string> = {
  "mguk-regen-gain-increase": mgukRegenGainIncreaseIconSvg,
  "mguk-regen-gain-decrease": mgukRegenGainDecreaseIconSvg,
  "mguk-deploy-mode-increase": mgukDeployModeIncreaseIconSvg,
  "mguk-deploy-mode-decrease": mgukDeployModeDecreaseIconSvg,
  "mguk-fixed-deploy-increase": mgukFixedDeployIncreaseIconSvg,
  "mguk-fixed-deploy-decrease": mgukFixedDeployDecreaseIconSvg,
  "hys-boost": hysBoostIconSvg,
  "hys-regen": hysRegenIconSvg,
  "hys-no-boost": hysNoBoostIconSvg,
};

/**
 * Title text for each setting + direction combination (format: "subLabel\nmainLabel")
 */
const SETUP_HYBRID_TITLES: Record<string, string> = {
  "mguk-regen-gain-increase": "INCREASE\nREGEN GAIN",
  "mguk-regen-gain-decrease": "DECREASE\nREGEN GAIN",
  "mguk-deploy-mode-increase": "INCREASE\nDEPLOY MODE",
  "mguk-deploy-mode-decrease": "DECREASE\nDEPLOY MODE",
  "mguk-fixed-deploy-increase": "INCREASE\nFIXED DEPLOY",
  "mguk-fixed-deploy-decrease": "DECREASE\nFIXED DEPLOY",
  "hys-boost": "BOOST\nHYS",
  "hys-regen": "REGEN\nHYS",
  "hys-no-boost": "NO BOOST\nHYS",
};

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * Directional controls use composite keys (e.g., "mguk-regen-gain-increase").
 */
export const SETUP_HYBRID_GLOBAL_KEYS: Record<string, string> = {
  "mguk-regen-gain-increase": "setupHybridMgukRegenGainIncrease",
  "mguk-regen-gain-decrease": "setupHybridMgukRegenGainDecrease",
  "mguk-deploy-mode-increase": "setupHybridMgukDeployModeIncrease",
  "mguk-deploy-mode-decrease": "setupHybridMgukDeployModeDecrease",
  "mguk-fixed-deploy-increase": "setupHybridMgukFixedDeployIncrease",
  "mguk-fixed-deploy-decrease": "setupHybridMgukFixedDeployDecrease",
  "hys-boost": "setupHybridHysBoost",
  "hys-regen": "setupHybridHysRegen",
  "hys-no-boost": "setupHybridHysNoBoost",
};

const SetupHybridSettings = CommonSettings.extend({
  setting: z
    .enum([
      // View sub-modes.
      "view-mguk-deploy-mode",
      "view-mguk-regen-gain",
      "view-mguk-deploy-fixed",
      // Adjustment sub-modes.
      "mguk-regen-gain",
      "mguk-deploy-mode",
      "mguk-fixed-deploy",
      "hys-boost",
      "hys-regen",
      "hys-no-boost",
    ])
    .default("mguk-regen-gain"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
  /**
   * Dual-press opt-in for View sub-modes (issue #540). When `true` (default),
   * a View key fires the global tap direction on a short press and the
   * opposite on a long press (held ≥ `dualPressThresholdMs`). When `false`,
   * the View stays purely read-only. Ignored for adjustment / toggle / hold
   * sub-modes. The tap direction itself is the plugin-wide
   * `dualPressDirections` global setting.
   */
  dualPressEnabled: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true")
    .default(true),
});

type SetupHybridSettings = z.infer<typeof SetupHybridSettings>;

/**
 * Resolves the flat icon lookup key from adjustment setting and direction.
 * View sub-modes use a separate render path.
 */
function resolveIconKey(setting: SetupHybridAdjustSetting, direction: DirectionType): string {
  if (DIRECTIONAL_CONTROLS.has(setting)) {
    return `${setting}-${direction}`;
  }

  return setting;
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup hybrid action's adjustment sub-modes.
 * View sub-modes use the shared `generateSetupViewSvg` render path.
 */
export function generateSetupHybridSvg(settings: SetupHybridSettings, bindingMissing = false): string {
  if (isViewSetting(settings.setting)) {
    return generateSetupViewSvg({
      viewId: settings.setting,
      telemetry: null,
      colorSourceSvg: mgukRegenGainIncreaseIconSvg,
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
      bindingMissing,
    });
  }

  const setting = settings.setting as SetupHybridAdjustSetting;
  const iconKey = resolveIconKey(setting, settings.direction);

  const iconSvg = SETUP_HYBRID_ICONS[iconKey] || SETUP_HYBRID_ICONS["hys-boost"];
  const defaultTitle = SETUP_HYBRID_TITLES[iconKey] || "SETUP\nHYBRID";

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * Setup Hybrid Action
 * Provides hybrid/ERS system adjustments (MGU-K regen gain, deploy modes,
 * HYS boost/regen) via keyboard shortcuts.
 * Supports three behavior types: directional tap, long-press hold, and toggle.
 */
export const SETUP_HYBRID_UUID = "com.iracedeck.sd.core.setup-hybrid" as const;

export class SetupHybrid extends ConnectionStateAwareAction<SetupHybridSettings> {
  /** Current settings per action context, used by the telemetry-tick callback for View sub-modes. */
  private readonly activeContexts = new Map<string, SetupHybridSettings>();

  /** Last rendered View value per context — memoizes the icon so we only re-emit on actual change. */
  private readonly lastRenderedValue = new Map<string, string>();

  /** Per-context key-down timestamps for dual-press dispatch on View sub-modes (#540). */
  private readonly dualPress = new DualPressTracker();

  override async onWillAppear(ev: IDeckWillAppearEvent<SetupHybridSettings>): Promise<void> {
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

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SetupHybridSettings>): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastRenderedValue.delete(ev.action.id);
    this.dualPress.clear(ev.action.id);
    await this.releaseBinding(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SetupHybridSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.lastRenderedValue.delete(ev.action.id);
    this.applyActiveBinding(settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<SetupHybridSettings>): Promise<void> {
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
    const adjustSetting = settings.setting as SetupHybridAdjustSetting;

    if (HOLD_CONTROLS.has(adjustSetting)) {
      const settingKey = this.resolveGlobalKey(adjustSetting, "increase");

      if (settingKey) {
        await this.holdBinding(ev.action.id, settingKey);
      }
    } else {
      await this.executeTap(adjustSetting, settings.direction);
    }
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<SetupHybridSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (isViewSetting(settings.setting)) {
      if (!settings.dualPressEnabled) {
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
      const settingKey = SETUP_HYBRID_GLOBAL_KEYS[`${adjustMode}-${direction}`];

      if (!settingKey) {
        this.logger.warn(`No global key mapping for dual-press ${adjustMode} ${direction}`);

        return;
      }

      await this.tapBinding(settingKey);

      return;
    }

    this.logger.info("Key up received");
    await this.releaseBinding(ev.action.id);
  }

  override async onDialDown(ev: IDeckDialDownEvent<SetupHybridSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (isViewSetting(settings.setting)) return;

    this.logger.info("Dial down received");
    const adjustSetting = settings.setting as SetupHybridAdjustSetting;

    if (HOLD_CONTROLS.has(adjustSetting)) {
      const settingKey = this.resolveGlobalKey(adjustSetting, "increase");

      if (settingKey) {
        await this.holdBinding(ev.action.id, settingKey);
      }
    } else {
      await this.executeTap(adjustSetting, settings.direction);
    }
  }

  override async onDialUp(ev: IDeckDialUpEvent<SetupHybridSettings>): Promise<void> {
    this.logger.info("Dial up received");
    await this.releaseBinding(ev.action.id);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<SetupHybridSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (isViewSetting(settings.setting)) return;

    this.logger.info("Dial rotated");
    const adjustSetting = settings.setting as SetupHybridAdjustSetting;

    if (!DIRECTIONAL_CONTROLS.has(adjustSetting)) {
      this.logger.debug(`Rotation ignored for ${adjustSetting}`);

      return;
    }

    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.executeTap(adjustSetting, direction);
  }

  private parseSettings(settings: unknown): SetupHybridSettings {
    const parsed = SetupHybridSettings.safeParse(settings);

    return parsed.success ? parsed.data : SetupHybridSettings.parse({});
  }

  private applyActiveBinding(settings: SetupHybridSettings): void {
    if (isViewSetting(settings.setting)) {
      if (!settings.dualPressEnabled) {
        this.setActiveBinding(null);

        return;
      }

      const adjustMode = getAdjustmentModeForView(settings.setting);
      const tapDir: DirectionType = getDualPressDirections() === "tap-increases" ? "increase" : "decrease";
      const activeKey = adjustMode ? (SETUP_HYBRID_GLOBAL_KEYS[`${adjustMode}-${tapDir}`] ?? null) : null;
      this.setActiveBinding(activeKey);

      return;
    }

    const activeKey = this.resolveGlobalKey(settings.setting, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }
  }

  private resolveGlobalKey(setting: SetupHybridAdjustSetting, direction: DirectionType): string | null {
    if (DIRECTIONAL_CONTROLS.has(setting)) {
      const key = `${setting}-${direction}`;

      return SETUP_HYBRID_GLOBAL_KEYS[key] ?? null;
    }

    return SETUP_HYBRID_GLOBAL_KEYS[setting] ?? null;
  }

  private async executeTap(setting: SetupHybridAdjustSetting, direction: DirectionType): Promise<void> {
    const settingKey = this.resolveGlobalKey(setting, direction);

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${setting} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  /**
   * Per-button missing-binding check for the icon warning overlay (#612).
   * Computed from THIS button's settings (not the shared `activeBindingKeys`).
   * - View sub-modes require both the adjustment's increase + decrease bindings,
   *   but only while dual-press is enabled (read-only Views need no binding).
   * - Directional adjust modes require the single setting+direction binding.
   * - Hold/constant modes require the single setting binding (direction ignored
   *   by `resolveGlobalKey` for non-directional controls).
   */
  private computeBindingMissing(settings: SetupHybridSettings): boolean {
    if (isViewSetting(settings.setting)) {
      if (!settings.dualPressEnabled) return false;

      const adjustMode = getAdjustmentModeForView(settings.setting);

      if (!adjustMode) return false;

      return this.isBindingMissing([
        SETUP_HYBRID_GLOBAL_KEYS[`${adjustMode}-increase`],
        SETUP_HYBRID_GLOBAL_KEYS[`${adjustMode}-decrease`],
      ]);
    }

    return this.isBindingMissing(
      this.resolveGlobalKey(settings.setting as SetupHybridAdjustSetting, settings.direction),
    );
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<SetupHybridSettings> | IDeckDidReceiveSettingsEvent<SetupHybridSettings>,
    settings: SetupHybridSettings,
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

  private renderIcon(settings: SetupHybridSettings): string {
    const bindingMissing = this.computeBindingMissing(settings);

    if (isViewSetting(settings.setting)) {
      return generateSetupViewSvg({
        viewId: settings.setting,
        telemetry: this.sdkController.getCurrentTelemetry(),
        colorSourceSvg: mgukRegenGainIncreaseIconSvg,
        colorOverrides: settings.colorOverrides,
        titleOverrides: settings.titleOverrides,
        borderOverrides: settings.borderOverrides,
        bindingMissing,
      });
    }

    return generateSetupHybridSvg(settings, bindingMissing);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: SetupHybridSettings,
  ): Promise<void> {
    if (!isViewSetting(settings.setting)) return;

    const value = formatViewValue(settings.setting, telemetry);

    if (this.lastRenderedValue.get(contextId) === value) return;

    this.lastRenderedValue.set(contextId, value);
    const svgDataUri = generateSetupViewSvg({
      viewId: settings.setting,
      telemetry,
      colorSourceSvg: mgukRegenGainIncreaseIconSvg,
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
      bindingMissing: this.computeBindingMissing(settings),
    });
    await this.updateKeyImage(contextId, svgDataUri);
  }
}
