import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  DualPressTracker,
  getDualPressDirections,
  getDualPressThresholdMs,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  IconUpdateThrottle,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckTouchTapEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  onGlobalSettingsChange,
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
import lfShockDecreaseIconSvg from "@iracedeck/icons/setup-chassis/lf-shock-decrease.svg";
import lfShockIncreaseIconSvg from "@iracedeck/icons/setup-chassis/lf-shock-increase.svg";
import lrShockDecreaseIconSvg from "@iracedeck/icons/setup-chassis/lr-shock-decrease.svg";
import lrShockIncreaseIconSvg from "@iracedeck/icons/setup-chassis/lr-shock-increase.svg";
import lrSpringDecreaseIconSvg from "@iracedeck/icons/setup-chassis/lr-spring-decrease.svg";
import lrSpringIncreaseIconSvg from "@iracedeck/icons/setup-chassis/lr-spring-increase.svg";
import powerSteeringDecreaseIconSvg from "@iracedeck/icons/setup-chassis/power-steering-decrease.svg";
import powerSteeringIncreaseIconSvg from "@iracedeck/icons/setup-chassis/power-steering-increase.svg";
import rearArbDecreaseIconSvg from "@iracedeck/icons/setup-chassis/rear-arb-decrease.svg";
import rearArbIncreaseIconSvg from "@iracedeck/icons/setup-chassis/rear-arb-increase.svg";
import rfShockDecreaseIconSvg from "@iracedeck/icons/setup-chassis/rf-shock-decrease.svg";
import rfShockIncreaseIconSvg from "@iracedeck/icons/setup-chassis/rf-shock-increase.svg";
import rrShockDecreaseIconSvg from "@iracedeck/icons/setup-chassis/rr-shock-decrease.svg";
import rrShockIncreaseIconSvg from "@iracedeck/icons/setup-chassis/rr-shock-increase.svg";
import rrSpringDecreaseIconSvg from "@iracedeck/icons/setup-chassis/rr-spring-decrease.svg";
import rrSpringIncreaseIconSvg from "@iracedeck/icons/setup-chassis/rr-spring-increase.svg";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import {
  ADJUST_REPEAT_INTERVAL_MS,
  ADJUST_REPEAT_SAFETY_MS,
  adjustStyleSettingsFields,
  hasPairedValueSource,
  pairedKeyNeedsTelemetry,
  renderPairedIconOrNull,
  seedFreshKeyStyle,
  telemetryMemoValue,
} from "../../shared/adjust-styles.js";
import { RepeatController } from "../../shared/repeat-controller.js";
import { generateSetupViewSvg, getAdjustmentModeForView, isViewSetting } from "../../shared/setup-view.js";
import { DialSettings, seedDialFromLegacySetting, SetupChassisDialSurface } from "./setup-chassis-dial-surface.js";

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
  "lr-spring-increase": lrSpringIncreaseIconSvg,
  "lr-spring-decrease": lrSpringDecreaseIconSvg,
  "rr-spring-increase": rrSpringIncreaseIconSvg,
  "rr-spring-decrease": rrSpringDecreaseIconSvg,
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
  "differential-preload-increase": "DIFF PRELOAD",
  "differential-preload-decrease": "DIFF PRELOAD",
  "differential-entry-increase": "DIFF ENTRY",
  "differential-entry-decrease": "DIFF ENTRY",
  "differential-middle-increase": "DIFF MIDDLE",
  "differential-middle-decrease": "DIFF MIDDLE",
  "differential-exit-increase": "DIFF EXIT",
  "differential-exit-decrease": "DIFF EXIT",
  "front-arb-increase": "FRONT ARB",
  "front-arb-decrease": "FRONT ARB",
  "rear-arb-increase": "REAR ARB",
  "rear-arb-decrease": "REAR ARB",
  "lr-spring-increase": "LR SPRING",
  "lr-spring-decrease": "LR SPRING",
  "rr-spring-increase": "RR SPRING",
  "rr-spring-decrease": "RR SPRING",
  "lf-shock-increase": "LF SHOCK",
  "lf-shock-decrease": "LF SHOCK",
  "rf-shock-increase": "RF SHOCK",
  "rf-shock-decrease": "RF SHOCK",
  "lr-shock-increase": "LR SHOCK",
  "lr-shock-decrease": "LR SHOCK",
  "rr-shock-increase": "RR SHOCK",
  "rr-shock-decrease": "RR SHOCK",
  "power-steering-increase": "PWR STEER",
  "power-steering-decrease": "PWR STEER",
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
  "lr-spring-increase": "setupChassisLrSpringIncrease",
  "lr-spring-decrease": "setupChassisLrSpringDecrease",
  "rr-spring-increase": "setupChassisRrSpringIncrease",
  "rr-spring-decrease": "setupChassisRrSpringDecrease",
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

/**
 * Pre-#953 → current global binding key renames. Every plugin passes this to
 * `migrateGlobalSettingsKeys` at startup so existing users' spring bindings
 * survive the Left/Right → LR/RR rename without reconfiguration.
 */
export const SETUP_CHASSIS_BINDING_KEY_RENAMES: Record<string, string> = {
  setupChassisLeftSpringIncrease: "setupChassisLrSpringIncrease",
  setupChassisLeftSpringDecrease: "setupChassisLrSpringDecrease",
  setupChassisRightSpringIncrease: "setupChassisRrSpringIncrease",
  setupChassisRightSpringDecrease: "setupChassisRrSpringDecrease",
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
      "view-lr-spring-offset",
      "view-rr-spring-offset",
      // Adjustment sub-modes.
      "differential-preload",
      "differential-entry",
      "differential-middle",
      "differential-exit",
      "front-arb",
      "rear-arb",
      "lr-spring",
      "rr-spring",
      "lf-shock",
      "rf-shock",
      "lr-shock",
      "rr-shock",
      "power-steering",
    ])
    .default("differential-preload"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
  ...adjustStyleSettingsFields,
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
  // Dial-surface settings (#800), under the `dial` root so keypad and dial keys
  // can't collide. catch: dial garbage degrades to dial defaults instead of
  // failing the whole parse (which would reset a keypad instance).
  dial: DialSettings.catch(() => DialSettings.parse({})),
});

type SetupChassisSettings = z.infer<typeof SetupChassisSettings>;

/** Pre-#953 spring sub-mode ids, persisted by older builds. */
const LEGACY_SPRING_IDS: Record<string, string> = {
  "left-spring": "lr-spring",
  "right-spring": "rr-spring",
};

/**
 * @internal Exported for testing
 *
 * Maps pre-#953 spring ids (`left-spring`/`right-spring`) to their renamed
 * `lr-spring`/`rr-spring` values in both the keypad `setting` and the nested
 * `dial.setting`. Returns the migrated object (for a `setSettings` write-back,
 * so the PI selects show the stored value) or `null` when nothing is legacy.
 * Must run before Zod parsing — an unknown enum value would otherwise fail the
 * whole parse and reset the key to defaults.
 */
export function migrateLegacySpringIds(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;
  const mappedSetting = typeof obj.setting === "string" ? LEGACY_SPRING_IDS[obj.setting] : undefined;

  const dial = obj.dial;
  let mappedDialSetting: string | undefined;

  if (dial && typeof dial === "object" && !Array.isArray(dial)) {
    const dialSetting = (dial as Record<string, unknown>).setting;
    mappedDialSetting = typeof dialSetting === "string" ? LEGACY_SPRING_IDS[dialSetting] : undefined;
  }

  if (mappedSetting === undefined && mappedDialSetting === undefined) return null;

  const migrated: Record<string, unknown> = { ...obj };

  if (mappedSetting !== undefined) migrated.setting = mappedSetting;

  if (mappedDialSetting !== undefined) {
    migrated.dial = { ...(dial as Record<string, unknown>), setting: mappedDialSetting };
  }

  return migrated;
}

/**
 * @internal Exported for testing
 *
 * Parses raw settings, falling back to full defaults when the whole parse fails.
 * Legacy spring ids are mapped first so pre-#953 settings keep their sub-mode.
 */
export function parseSetupChassisSettings(raw: unknown): SetupChassisSettings {
  const effective = migrateLegacySpringIds(raw) ?? raw;
  const parsed = SetupChassisSettings.safeParse(effective);

  return parsed.success ? parsed.data : SetupChassisSettings.parse({});
}

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

  /** Hold-to-repeat for paired-style directional keys (always on, spec 2026-07-07). */
  private readonly repeat = new RepeatController(this.logger);

  /** Coalesces telemetry-driven re-renders to ≤ 10/s per key (issue #493 pattern). */
  private readonly iconThrottle = new IconUpdateThrottle();

  /**
   * The dial half of the action; all IDeck dial events route here (#800). No
   * `setActiveBinding` is delegated — it would bleed onto the keypad buttons.
   */
  private readonly dialSurface = new SetupChassisDialSurface({
    logger: this.logger,
    getTelemetry: () => this.sdkController.getCurrentTelemetry(),
    tapBinding: (settingKey) => this.tapBinding(settingKey),
    isBindingMissing: (keys) => this.isBindingMissing(keys),
  });

  /** Keeps the dial strips' #612 missing-binding warning live while iRacing is offline (#800). */
  private readonly unsubscribeGlobalSettings = onGlobalSettingsChange(() => this.dialSurface.refreshAll());

  override async onWillAppear(ev: IDeckWillAppearEvent<SetupChassisSettings>): Promise<void> {
    await super.onWillAppear(ev);
    // #953 rename migration first, so the later seeds and the PI see the
    // current ids; write back so the stored settings converge.
    const migrated = migrateLegacySpringIds(ev.payload.settings);
    const rawSettings = migrated ?? ev.payload.settings;
    let settings = this.parseSettings(rawSettings);

    if (ev.action.isDial()) {
      // #800 dial migration: a pre-dial-surface encoder placement drove the flat
      // keypad `setting` — carry a valid rotation value over to `dial.setting`.
      const seededDial = seedDialFromLegacySetting(rawSettings) ?? migrated;

      if (seededDial) {
        await ev.action.setSettings(seededDial);
        settings = this.parseSettings(seededDial);
      }

      await this.dialSurface.willAppear(ev.action, settings.dial);
      this.sdkController.subscribe(ev.action.id, (telemetry) => {
        this.dialSurface.onTelemetry(ev.action.id, telemetry);
      });

      return;
    }

    // One-shot default seeding (spec 2026-07-07): a never-configured keypad key
    // gets the modern `split` style; keys with any persisted settings stay legacy.
    const seeded = seedFreshKeyStyle(rawSettings) ?? migrated;

    if (seeded) {
      await ev.action.setSettings(seeded);
      settings = this.parseSettings(seeded);
    }

    this.activeContexts.set(ev.action.id, settings);
    this.applyActiveBinding(settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      const stored = this.activeContexts.get(ev.action.id);

      if (stored && (isViewSetting(stored.setting) || pairedKeyNeedsTelemetry(stored))) {
        void this.updateDisplayFromTelemetry(ev.action.id, telemetry, stored);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SetupChassisSettings>): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.dialSurface.willDisappear(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastRenderedValue.delete(ev.action.id);
    this.dualPress.clear(ev.action.id);
    this.repeat.clear(ev.action.id);
    this.iconThrottle.clear(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SetupChassisSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      await this.dialSurface.didReceiveSettings(ev.action, settings.dial);

      return;
    }

    this.activeContexts.set(ev.action.id, settings);
    this.lastRenderedValue.delete(ev.action.id);
    this.repeat.clear(ev.action.id);
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

    // Hold-to-repeat for paired-style keys: arm SYNCHRONOUSLY before the first
    // execute so a racing keyUp always finds timers to clear (fuel-service pattern).
    if (settings.keyStyle !== "legacy" && hasPairedValueSource(settings.setting)) {
      const { setting, direction } = settings;
      this.repeat.onKeyDown(ev.action.id, {
        holdMs: getDualPressThresholdMs(),
        intervalMs: ADJUST_REPEAT_INTERVAL_MS,
        safetyMs: ADJUST_REPEAT_SAFETY_MS,
        execute: async () => {
          await this.executeSetting(setting, direction);

          return true;
        },
      });
    }

    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<SetupChassisSettings>): Promise<void> {
    this.repeat.onKeyUp(ev.action.id);
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

  override async onDialRotate(ev: IDeckDialRotateEvent<SetupChassisSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.rotate(ev.action, settings.dial, ev.payload.ticks, ev.payload.pressed === true);
  }

  override async onDialDown(ev: IDeckDialDownEvent<SetupChassisSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.down(ev.action, settings.dial);
  }

  override async onDialUp(ev: IDeckDialUpEvent<SetupChassisSettings>): Promise<void> {
    await this.dialSurface.up(ev.action.id);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<SetupChassisSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.touchTap(ev.action, settings.dial, ev.payload.hold === true);
  }

  private parseSettings(settings: unknown): SetupChassisSettings {
    return parseSetupChassisSettings(settings);
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

    const memo = telemetryMemoValue(settings, this.sdkController.getCurrentTelemetry());

    if (memo !== null) {
      this.lastRenderedValue.set(ev.action.id, memo);
    }

    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => this.renderIcon(settings));
  }

  private renderIcon(settings: SetupChassisSettings): string {
    const bindingMissing = this.computeBindingMissing(settings);

    const paired = renderPairedIconOrNull({
      setting: settings.setting,
      direction: settings.direction,
      keyStyle: settings.keyStyle,
      pairPosition: settings.pairPosition,
      telemetry: this.sdkController.getCurrentTelemetry(),
      colorSourceSvg: differentialPreloadIncreaseIconSvg,
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
      bindingMissing,
    });

    if (paired) return paired;

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
    const memo = telemetryMemoValue(settings, telemetry);

    if (memo === null) return;

    if (this.lastRenderedValue.get(contextId) === memo) return;

    this.lastRenderedValue.set(contextId, memo);
    this.iconThrottle.schedule(contextId, async () => {
      const stored = this.activeContexts.get(contextId);

      if (stored) await this.updateKeyImage(contextId, this.renderIcon(stored));
    });
  }
}
