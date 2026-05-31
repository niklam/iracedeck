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
import differentialEntryDecreaseIconSvg from "@iracedeck/icons/setup-chassis/differential-entry-decrease.svg";
import differentialEntryIncreaseIconSvg from "@iracedeck/icons/setup-chassis/differential-entry-increase.svg";
import differentialExitDecreaseIconSvg from "@iracedeck/icons/setup-chassis/differential-exit-decrease.svg";
import differentialExitIncreaseIconSvg from "@iracedeck/icons/setup-chassis/differential-exit-increase.svg";
import differentialMiddleDecreaseIconSvg from "@iracedeck/icons/setup-chassis/differential-middle-decrease.svg";
import differentialMiddleIncreaseIconSvg from "@iracedeck/icons/setup-chassis/differential-middle-increase.svg";
import differentialPreloadDecreaseIconSvg from "@iracedeck/icons/setup-chassis/differential-preload-decrease.svg";
import differentialPreloadIncreaseIconSvg from "@iracedeck/icons/setup-chassis/differential-preload-increase.svg";
import frontArbDecreaseIconSvg from "@iracedeck/icons/setup-chassis/front-arb-decrease.svg";
import frontArbIncreaseIconSvg from "@iracedeck/icons/setup-chassis/front-arb-increase.svg";
import leftSpringDecreaseIconSvg from "@iracedeck/icons/setup-chassis/left-spring-decrease.svg";
import leftSpringIncreaseIconSvg from "@iracedeck/icons/setup-chassis/left-spring-increase.svg";
import lfShockDecreaseIconSvg from "@iracedeck/icons/setup-chassis/lf-shock-decrease.svg";
import lfShockIncreaseIconSvg from "@iracedeck/icons/setup-chassis/lf-shock-increase.svg";
import lrShockDecreaseIconSvg from "@iracedeck/icons/setup-chassis/lr-shock-decrease.svg";
import lrShockIncreaseIconSvg from "@iracedeck/icons/setup-chassis/lr-shock-increase.svg";
import powerSteeringDecreaseIconSvg from "@iracedeck/icons/setup-chassis/power-steering-decrease.svg";
import powerSteeringIncreaseIconSvg from "@iracedeck/icons/setup-chassis/power-steering-increase.svg";
import rearArbDecreaseIconSvg from "@iracedeck/icons/setup-chassis/rear-arb-decrease.svg";
import rearArbIncreaseIconSvg from "@iracedeck/icons/setup-chassis/rear-arb-increase.svg";
import rfShockDecreaseIconSvg from "@iracedeck/icons/setup-chassis/rf-shock-decrease.svg";
import rfShockIncreaseIconSvg from "@iracedeck/icons/setup-chassis/rf-shock-increase.svg";
import rightSpringDecreaseIconSvg from "@iracedeck/icons/setup-chassis/right-spring-decrease.svg";
import rightSpringIncreaseIconSvg from "@iracedeck/icons/setup-chassis/right-spring-increase.svg";
import rrShockDecreaseIconSvg from "@iracedeck/icons/setup-chassis/rr-shock-decrease.svg";
import rrShockIncreaseIconSvg from "@iracedeck/icons/setup-chassis/rr-shock-increase.svg";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import {
  formatViewValue,
  generateSetupViewSvg,
  getAdjustmentModeForView,
  isViewSetting,
} from "../../shared/setup-view.js";

type DirectionType = "increase" | "decrease";

/**
 * Flat icon lookup record keyed by "{setting}-{direction}".
 */
const SETUP_CHASSIS_ICONS: Record<string, string> = {
  "differential-preload-increase": differentialPreloadIncreaseIconSvg,
  "differential-preload-decrease": differentialPreloadDecreaseIconSvg,
  "differential-entry-increase": differentialEntryIncreaseIconSvg,
  "differential-entry-decrease": differentialEntryDecreaseIconSvg,
  "differential-middle-increase": differentialMiddleIncreaseIconSvg,
  "differential-middle-decrease": differentialMiddleDecreaseIconSvg,
  "differential-exit-increase": differentialExitIncreaseIconSvg,
  "differential-exit-decrease": differentialExitDecreaseIconSvg,
  "front-arb-increase": frontArbIncreaseIconSvg,
  "front-arb-decrease": frontArbDecreaseIconSvg,
  "rear-arb-increase": rearArbIncreaseIconSvg,
  "rear-arb-decrease": rearArbDecreaseIconSvg,
  "left-spring-increase": leftSpringIncreaseIconSvg,
  "left-spring-decrease": leftSpringDecreaseIconSvg,
  "right-spring-increase": rightSpringIncreaseIconSvg,
  "right-spring-decrease": rightSpringDecreaseIconSvg,
  "lf-shock-increase": lfShockIncreaseIconSvg,
  "lf-shock-decrease": lfShockDecreaseIconSvg,
  "rf-shock-increase": rfShockIncreaseIconSvg,
  "rf-shock-decrease": rfShockDecreaseIconSvg,
  "lr-shock-increase": lrShockIncreaseIconSvg,
  "lr-shock-decrease": lrShockDecreaseIconSvg,
  "rr-shock-increase": rrShockIncreaseIconSvg,
  "rr-shock-decrease": rrShockDecreaseIconSvg,
  "power-steering-increase": powerSteeringIncreaseIconSvg,
  "power-steering-decrease": powerSteeringDecreaseIconSvg,
};

/**
 * Title text for each setting + direction combination (format: "subLabel\nmainLabel")
 */
const SETUP_CHASSIS_TITLES: Record<string, string> = {
  "differential-preload-increase": "INCREASE\nDIFF PRELOAD",
  "differential-preload-decrease": "DECREASE\nDIFF PRELOAD",
  "differential-entry-increase": "INCREASE\nDIFF ENTRY",
  "differential-entry-decrease": "DECREASE\nDIFF ENTRY",
  "differential-middle-increase": "INCREASE\nDIFF MIDDLE",
  "differential-middle-decrease": "DECREASE\nDIFF MIDDLE",
  "differential-exit-increase": "INCREASE\nDIFF EXIT",
  "differential-exit-decrease": "DECREASE\nDIFF EXIT",
  "front-arb-increase": "INCREASE\nFRONT ARB",
  "front-arb-decrease": "DECREASE\nFRONT ARB",
  "rear-arb-increase": "INCREASE\nREAR ARB",
  "rear-arb-decrease": "DECREASE\nREAR ARB",
  "left-spring-increase": "INCREASE\nLEFT SPRING",
  "left-spring-decrease": "DECREASE\nLEFT SPRING",
  "right-spring-increase": "INCREASE\nRIGHT SPRING",
  "right-spring-decrease": "DECREASE\nRIGHT SPRING",
  "lf-shock-increase": "INCREASE\nLF SHOCK",
  "lf-shock-decrease": "DECREASE\nLF SHOCK",
  "rf-shock-increase": "INCREASE\nRF SHOCK",
  "rf-shock-decrease": "DECREASE\nRF SHOCK",
  "lr-shock-increase": "INCREASE\nLR SHOCK",
  "lr-shock-decrease": "DECREASE\nLR SHOCK",
  "rr-shock-increase": "INCREASE\nRR SHOCK",
  "rr-shock-decrease": "DECREASE\nRR SHOCK",
  "power-steering-increase": "INCREASE\nPWR STEER",
  "power-steering-decrease": "DECREASE\nPWR STEER",
};

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * All chassis adjustment settings are directional, using composite keys (e.g., "differential-preload-increase").
 */
export const SETUP_CHASSIS_GLOBAL_KEYS: Record<string, string> = {
  "differential-preload-increase": "setupChassisDifferentialPreloadIncrease",
  "differential-preload-decrease": "setupChassisDifferentialPreloadDecrease",
  "differential-entry-increase": "setupChassisDifferentialEntryIncrease",
  "differential-entry-decrease": "setupChassisDifferentialEntryDecrease",
  "differential-middle-increase": "setupChassisDifferentialMiddleIncrease",
  "differential-middle-decrease": "setupChassisDifferentialMiddleDecrease",
  "differential-exit-increase": "setupChassisDifferentialExitIncrease",
  "differential-exit-decrease": "setupChassisDifferentialExitDecrease",
  "front-arb-increase": "setupChassisFrontArbIncrease",
  "front-arb-decrease": "setupChassisFrontArbDecrease",
  "rear-arb-increase": "setupChassisRearArbIncrease",
  "rear-arb-decrease": "setupChassisRearArbDecrease",
  "left-spring-increase": "setupChassisLeftSpringIncrease",
  "left-spring-decrease": "setupChassisLeftSpringDecrease",
  "right-spring-increase": "setupChassisRightSpringIncrease",
  "right-spring-decrease": "setupChassisRightSpringDecrease",
  "lf-shock-increase": "setupChassisLfShockIncrease",
  "lf-shock-decrease": "setupChassisLfShockDecrease",
  "rf-shock-increase": "setupChassisRfShockIncrease",
  "rf-shock-decrease": "setupChassisRfShockDecrease",
  "lr-shock-increase": "setupChassisLrShockIncrease",
  "lr-shock-decrease": "setupChassisLrShockDecrease",
  "rr-shock-increase": "setupChassisRrShockIncrease",
  "rr-shock-decrease": "setupChassisRrShockDecrease",
  "power-steering-increase": "setupChassisPowerSteeringIncrease",
  "power-steering-decrease": "setupChassisPowerSteeringDecrease",
  // Weight jacker entries are dual-press dispatch targets only — they don't
  // appear as user-selectable adjustment modes (issue #540). Drivers can
  // configure these keys in the PI and trigger them via the corresponding
  // view-weight-jacker-{left,right} View sub-mode.
  "weight-jacker-left-increase": "setupChassisWeightJackerLeftIncrease",
  "weight-jacker-left-decrease": "setupChassisWeightJackerLeftDecrease",
  "weight-jacker-right-increase": "setupChassisWeightJackerRightIncrease",
  "weight-jacker-right-decrease": "setupChassisWeightJackerRightDecrease",
};

const SetupChassisSettings = CommonSettings.extend({
  setting: z
    .enum([
      // View sub-modes (read-only telemetry display).
      "view-diff-preload",
      "view-diff-entry",
      "view-diff-middle",
      "view-diff-exit",
      "view-anti-roll-front",
      "view-anti-roll-rear",
      "view-power-steering",
      "view-weight-jacker-left",
      "view-weight-jacker-right",
      // Adjustment sub-modes.
      "differential-preload",
      "differential-entry",
      "differential-middle",
      "differential-exit",
      "front-arb",
      "rear-arb",
      "left-spring",
      "right-spring",
      "lf-shock",
      "rf-shock",
      "lr-shock",
      "rr-shock",
      "power-steering",
    ])
    .default("differential-preload"),
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

type SetupChassisSettings = z.infer<typeof SetupChassisSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup chassis action's adjustment sub-modes.
 * View sub-modes use the shared `generateSetupViewSvg` render path.
 */
export function generateSetupChassisSvg(settings: SetupChassisSettings, bindingMissing = false): string {
  if (isViewSetting(settings.setting)) {
    return generateSetupViewSvg({
      viewId: settings.setting,
      telemetry: null,
      colorSourceSvg: differentialPreloadIncreaseIconSvg,
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
      bindingMissing,
    });
  }

  const { setting, direction } = settings;
  const key = `${setting}-${direction}`;

  const iconSvg = SETUP_CHASSIS_ICONS[key] || SETUP_CHASSIS_ICONS["differential-preload-increase"];
  const defaultTitle = SETUP_CHASSIS_TITLES[key] || "SETUP\nCHASSIS";

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * Setup Chassis Action
 * Provides chassis-related in-car adjustments (differentials, anti-roll bars,
 * springs, shocks, power steering) via keyboard shortcuts.
 */
export const SETUP_CHASSIS_UUID = "com.iracedeck.sd.core.setup-chassis" as const;

export class SetupChassis extends ConnectionStateAwareAction<SetupChassisSettings> {
  /** Current settings per action context, used by the telemetry-tick callback for View sub-modes. */
  private readonly activeContexts = new Map<string, SetupChassisSettings>();

  /** Last rendered View value per context — memoizes the icon so we only re-emit on actual change. */
  private readonly lastRenderedValue = new Map<string, string>();

  /** Per-context key-down timestamps for dual-press dispatch on View sub-modes (#540). */
  private readonly dualPress = new DualPressTracker();

  override async onWillAppear(ev: IDeckWillAppearEvent<SetupChassisSettings>): Promise<void> {
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

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SetupChassisSettings>): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastRenderedValue.delete(ev.action.id);
    this.dualPress.clear(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SetupChassisSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.lastRenderedValue.delete(ev.action.id);
    this.applyActiveBinding(settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<SetupChassisSettings>): Promise<void> {
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

  override async onKeyUp(ev: IDeckKeyUpEvent<SetupChassisSettings>): Promise<void> {
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
    const settingKey = SETUP_CHASSIS_GLOBAL_KEYS[`${adjustMode}-${direction}`];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for dual-press ${adjustMode} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  override async onDialDown(ev: IDeckDialDownEvent<SetupChassisSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (isViewSetting(settings.setting)) return;

    this.logger.info("Dial down received");
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<SetupChassisSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (isViewSetting(settings.setting)) return;

    this.logger.info("Dial rotated");
    // Clockwise (ticks > 0) = increase, Counter-clockwise (ticks < 0) = decrease
    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.executeSetting(settings.setting, direction);
  }

  private parseSettings(settings: unknown): SetupChassisSettings {
    const parsed = SetupChassisSettings.safeParse(settings);

    return parsed.success ? parsed.data : SetupChassisSettings.parse({});
  }

  private applyActiveBinding(settings: SetupChassisSettings): void {
    if (isViewSetting(settings.setting)) {
      if (!settings.dualPressEnabled) {
        this.setActiveBinding(null);

        return;
      }

      const adjustMode = getAdjustmentModeForView(settings.setting);
      const tapDir: DirectionType = getDualPressDirections() === "tap-increases" ? "increase" : "decrease";
      const activeKey = adjustMode ? (SETUP_CHASSIS_GLOBAL_KEYS[`${adjustMode}-${tapDir}`] ?? null) : null;
      this.setActiveBinding(activeKey);

      return;
    }

    this.setActiveBinding(SETUP_CHASSIS_GLOBAL_KEYS[`${settings.setting}-${settings.direction}`]);
  }

  private async executeSetting(setting: string, direction: DirectionType): Promise<void> {
    const settingKey = SETUP_CHASSIS_GLOBAL_KEYS[`${setting}-${direction}`];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${setting} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  /**
   * Per-button missing-binding check for the icon warning overlay (#612).
   * Computed from THIS button's settings (not the shared `activeBindingKeys`).
   * - View sub-modes require both the adjustment's increase + decrease bindings
   *   (weight-jacker Views map to dispatch-only keys), but only while dual-press
   *   is enabled (read-only Views need no binding).
   * - Adjust modes (all directional here) require the single setting+direction binding.
   */
  private computeBindingMissing(settings: SetupChassisSettings): boolean {
    if (isViewSetting(settings.setting)) {
      if (!settings.dualPressEnabled) return false;

      const adjustMode = getAdjustmentModeForView(settings.setting);

      if (!adjustMode) return false;

      return this.isBindingMissing([
        SETUP_CHASSIS_GLOBAL_KEYS[`${adjustMode}-increase`],
        SETUP_CHASSIS_GLOBAL_KEYS[`${adjustMode}-decrease`],
      ]);
    }

    return this.isBindingMissing(SETUP_CHASSIS_GLOBAL_KEYS[`${settings.setting}-${settings.direction}`]);
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<SetupChassisSettings> | IDeckDidReceiveSettingsEvent<SetupChassisSettings>,
    settings: SetupChassisSettings,
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

  private renderIcon(settings: SetupChassisSettings): string {
    const bindingMissing = this.computeBindingMissing(settings);

    if (isViewSetting(settings.setting)) {
      return generateSetupViewSvg({
        viewId: settings.setting,
        telemetry: this.sdkController.getCurrentTelemetry(),
        colorSourceSvg: differentialPreloadIncreaseIconSvg,
        colorOverrides: settings.colorOverrides,
        titleOverrides: settings.titleOverrides,
        borderOverrides: settings.borderOverrides,
        bindingMissing,
      });
    }

    return generateSetupChassisSvg(settings, bindingMissing);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: SetupChassisSettings,
  ): Promise<void> {
    if (!isViewSetting(settings.setting)) return;

    const value = formatViewValue(settings.setting, telemetry);

    if (this.lastRenderedValue.get(contextId) === value) return;

    this.lastRenderedValue.set(contextId, value);
    const svgDataUri = generateSetupViewSvg({
      viewId: settings.setting,
      telemetry,
      colorSourceSvg: differentialPreloadIncreaseIconSvg,
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
      bindingMissing: this.computeBindingMissing(settings),
    });
    await this.updateKeyImage(contextId, svgDataUri);
  }
}
