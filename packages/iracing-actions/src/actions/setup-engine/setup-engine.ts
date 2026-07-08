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
import boostLevelDecreaseIconSvg from "@iracedeck/icons/setup-engine/boost-level-decrease.svg";
import boostLevelIncreaseIconSvg from "@iracedeck/icons/setup-engine/boost-level-increase.svg";
import enginePowerDecreaseIconSvg from "@iracedeck/icons/setup-engine/engine-power-decrease.svg";
import enginePowerIncreaseIconSvg from "@iracedeck/icons/setup-engine/engine-power-increase.svg";
import launchRpmDecreaseIconSvg from "@iracedeck/icons/setup-engine/launch-rpm-decrease.svg";
import launchRpmIncreaseIconSvg from "@iracedeck/icons/setup-engine/launch-rpm-increase.svg";
import throttleShapingDecreaseIconSvg from "@iracedeck/icons/setup-engine/throttle-shaping-decrease.svg";
import throttleShapingIncreaseIconSvg from "@iracedeck/icons/setup-engine/throttle-shaping-increase.svg";
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
import { IconUpdateThrottle } from "../../shared/icon-update-throttle.js";
import { RepeatController } from "../../shared/repeat-controller.js";
import { generateSetupViewSvg, getAdjustmentModeForView, isViewSetting } from "../../shared/setup-view.js";
import { DialSettings, seedDialFromLegacySetting, SetupEngineDialSurface } from "./setup-engine-dial-surface.js";

type SetupEngineAdjustSetting = "engine-power" | "throttle-shaping" | "boost-level" | "launch-rpm";

/**
 * The combined `setting` type is the union of `SetupEngineAdjustSetting` and the three
 * View IDs in `setup-view.ts`. Code paths narrow back to `SetupEngineAdjustSetting`
 * after `isViewSetting` gates the View branch; nothing needs the full union as a name.
 */

type DirectionType = "increase" | "decrease";

/**
 * Flat icon lookup mapping setting + direction keys to standalone SVG templates.
 */
const SETUP_ENGINE_ICONS: Record<string, string> = {
  "engine-power-increase": enginePowerIncreaseIconSvg,
  "engine-power-decrease": enginePowerDecreaseIconSvg,
  "throttle-shaping-increase": throttleShapingIncreaseIconSvg,
  "throttle-shaping-decrease": throttleShapingDecreaseIconSvg,
  "boost-level-increase": boostLevelIncreaseIconSvg,
  "boost-level-decrease": boostLevelDecreaseIconSvg,
  "launch-rpm-increase": launchRpmIncreaseIconSvg,
  "launch-rpm-decrease": launchRpmDecreaseIconSvg,
};

/**
 * Title text for each setting + direction combination (format: "subLabel\nmainLabel")
 */
const SETUP_ENGINE_TITLES: Record<string, string> = {
  "engine-power-increase": "INCREASE\nENG POWER",
  "engine-power-decrease": "DECREASE\nENG POWER",
  "throttle-shaping-increase": "INCREASE\nTHROTTLE",
  "throttle-shaping-decrease": "DECREASE\nTHROTTLE",
  "boost-level-increase": "INCREASE\nBOOST",
  "boost-level-decrease": "DECREASE\nBOOST",
  "launch-rpm-increase": "INCREASE\nLAUNCH RPM",
  "launch-rpm-decrease": "DECREASE\nLAUNCH RPM",
};

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * All engine settings are directional, using composite keys (e.g., "engine-power-increase").
 */
export const SETUP_ENGINE_GLOBAL_KEYS: Record<string, string> = {
  "engine-power-increase": "setupEngineEnginePowerIncrease",
  "engine-power-decrease": "setupEngineEnginePowerDecrease",
  "throttle-shaping-increase": "setupEngineThrottleShapingIncrease",
  "throttle-shaping-decrease": "setupEngineThrottleShapingDecrease",
  "boost-level-increase": "setupEngineBoostLevelIncrease",
  "boost-level-decrease": "setupEngineBoostLevelDecrease",
  "launch-rpm-increase": "setupEngineLaunchRpmIncrease",
  "launch-rpm-decrease": "setupEngineLaunchRpmDecrease",
};

const SetupEngineSettings = CommonSettings.extend({
  setting: z
    .enum([
      // View sub-modes.
      "view-engine-power",
      "view-throttle-shape",
      "view-launch-rpm",
      // Adjustment sub-modes.
      "engine-power",
      "throttle-shaping",
      "boost-level",
      "launch-rpm",
    ])
    .default("engine-power"),
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
  // Dial-surface settings (#798), under the `dial` root so keypad and dial keys
  // can't collide. catch: dial garbage degrades to dial defaults instead of
  // failing the whole parse (which would reset a keypad instance).
  dial: DialSettings.catch(() => DialSettings.parse({})),
});

type SetupEngineSettings = z.infer<typeof SetupEngineSettings>;

/**
 * @internal Exported for testing
 *
 * Parses raw settings, falling back to full defaults when the whole parse fails.
 */
export function parseSetupEngineSettings(raw: unknown): SetupEngineSettings {
  const parsed = SetupEngineSettings.safeParse(raw);

  return parsed.success ? parsed.data : SetupEngineSettings.parse({});
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup engine action's adjustment sub-modes.
 * View sub-modes use the shared `generateSetupViewSvg` render path.
 */
export function generateSetupEngineSvg(settings: SetupEngineSettings, bindingMissing = false): string {
  if (isViewSetting(settings.setting)) {
    return generateSetupViewSvg({
      viewId: settings.setting,
      telemetry: null,
      colorSourceSvg: enginePowerIncreaseIconSvg,
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
      bindingMissing,
    });
  }

  const setting = settings.setting as SetupEngineAdjustSetting;
  const { direction } = settings;

  const iconKey = `${setting}-${direction}`;
  const iconSvg = SETUP_ENGINE_ICONS[iconKey] || SETUP_ENGINE_ICONS["engine-power-increase"];
  const defaultTitle = SETUP_ENGINE_TITLES[iconKey] || "SETUP\nENGINE";

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * Setup Engine Action
 * Provides engine-related in-car adjustments (engine power, throttle shaping,
 * boost level, launch RPM) via keyboard shortcuts.
 */
export const SETUP_ENGINE_UUID = "com.iracedeck.sd.core.setup-engine" as const;

export class SetupEngine extends ConnectionStateAwareAction<SetupEngineSettings> {
  /** Current settings per action context, used by the telemetry-tick callback for View sub-modes. */
  private readonly activeContexts = new Map<string, SetupEngineSettings>();

  /** Last rendered View value per context — memoizes the icon so we only re-emit on actual change. */
  private readonly lastRenderedValue = new Map<string, string>();

  /** Per-context key-down timestamps for dual-press dispatch on View sub-modes (#540). */
  private readonly dualPress = new DualPressTracker();

  /** Hold-to-repeat for paired-style directional keys (always on, spec 2026-07-07). */
  private readonly repeat = new RepeatController(this.logger);

  /** Coalesces telemetry-driven re-renders to ≤ 10/s per key (issue #493 pattern). */
  private readonly iconThrottle = new IconUpdateThrottle();

  /**
   * The dial half of the action; all IDeck dial events route here (#798). No
   * `setActiveBinding` is delegated — it would bleed onto the keypad buttons.
   */
  private readonly dialSurface = new SetupEngineDialSurface({
    logger: this.logger,
    getTelemetry: () => this.sdkController.getCurrentTelemetry(),
    tapBinding: (settingKey) => this.tapBinding(settingKey),
    isBindingMissing: (keys) => this.isBindingMissing(keys),
  });

  /** Keeps the dial strips' #612 missing-binding warning live while iRacing is offline (#798). */
  private readonly unsubscribeGlobalSettings = onGlobalSettingsChange(() => this.dialSurface.refreshAll());

  override async onWillAppear(ev: IDeckWillAppearEvent<SetupEngineSettings>): Promise<void> {
    await super.onWillAppear(ev);
    let settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      // #798 dial migration: a pre-dial-surface encoder placement drove the flat
      // keypad `setting` — carry a valid rotation value over to `dial.setting`.
      const seededDial = seedDialFromLegacySetting(ev.payload.settings);

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
    const seeded = seedFreshKeyStyle(ev.payload.settings);

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

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SetupEngineSettings>): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.dialSurface.willDisappear(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastRenderedValue.delete(ev.action.id);
    this.dualPress.clear(ev.action.id);
    this.repeat.clear(ev.action.id);
    this.iconThrottle.clear(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SetupEngineSettings>): Promise<void> {
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

  override async onKeyDown(ev: IDeckKeyDownEvent<SetupEngineSettings>): Promise<void> {
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
          await this.executeSetting(setting as SetupEngineAdjustSetting, direction);

          return true;
        },
      });
    }

    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<SetupEngineSettings>): Promise<void> {
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
    const settingKey = SETUP_ENGINE_GLOBAL_KEYS[`${adjustMode}-${direction}`];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for dual-press ${adjustMode} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<SetupEngineSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.rotate(ev.action, settings.dial, ev.payload.ticks, ev.payload.pressed === true);
  }

  override async onDialDown(ev: IDeckDialDownEvent<SetupEngineSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.down(ev.action, settings.dial);
  }

  override async onDialUp(ev: IDeckDialUpEvent<SetupEngineSettings>): Promise<void> {
    await this.dialSurface.up(ev.action.id);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<SetupEngineSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.touchTap(ev.action, settings.dial, ev.payload.hold === true);
  }

  private parseSettings(settings: unknown): SetupEngineSettings {
    return parseSetupEngineSettings(settings);
  }

  private applyActiveBinding(settings: SetupEngineSettings): void {
    if (isViewSetting(settings.setting)) {
      if (!settings.dualPressEnabled) {
        this.setActiveBinding(null);

        return;
      }

      const adjustMode = getAdjustmentModeForView(settings.setting);
      const tapDir: DirectionType = getDualPressDirections() === "tap-increases" ? "increase" : "decrease";
      const activeKey = adjustMode ? (SETUP_ENGINE_GLOBAL_KEYS[`${adjustMode}-${tapDir}`] ?? null) : null;
      this.setActiveBinding(activeKey);

      return;
    }

    this.setActiveBinding(SETUP_ENGINE_GLOBAL_KEYS[`${settings.setting}-${settings.direction}`]);
  }

  private async executeSetting(setting: SetupEngineAdjustSetting, direction: DirectionType): Promise<void> {
    const settingKey = SETUP_ENGINE_GLOBAL_KEYS[`${setting}-${direction}`];

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
   * - Adjust modes (all directional here) require the single setting+direction binding.
   */
  private computeBindingMissing(settings: SetupEngineSettings): boolean {
    if (isViewSetting(settings.setting)) {
      if (!settings.dualPressEnabled) return false;

      const adjustMode = getAdjustmentModeForView(settings.setting);

      if (!adjustMode) return false;

      return this.isBindingMissing([
        SETUP_ENGINE_GLOBAL_KEYS[`${adjustMode}-increase`],
        SETUP_ENGINE_GLOBAL_KEYS[`${adjustMode}-decrease`],
      ]);
    }

    return this.isBindingMissing(SETUP_ENGINE_GLOBAL_KEYS[`${settings.setting}-${settings.direction}`]);
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<SetupEngineSettings> | IDeckDidReceiveSettingsEvent<SetupEngineSettings>,
    settings: SetupEngineSettings,
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

  private renderIcon(settings: SetupEngineSettings): string {
    const bindingMissing = this.computeBindingMissing(settings);

    const paired = renderPairedIconOrNull({
      setting: settings.setting,
      direction: settings.direction,
      keyStyle: settings.keyStyle,
      pairPosition: settings.pairPosition,
      telemetry: this.sdkController.getCurrentTelemetry(),
      colorSourceSvg: enginePowerIncreaseIconSvg,
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
        colorSourceSvg: enginePowerIncreaseIconSvg,
        colorOverrides: settings.colorOverrides,
        titleOverrides: settings.titleOverrides,
        borderOverrides: settings.borderOverrides,
        bindingMissing,
      });
    }

    return generateSetupEngineSvg(settings, bindingMissing);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: SetupEngineSettings,
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
