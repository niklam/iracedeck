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
import frontWingDecreaseIconSvg from "@iracedeck/icons/setup-aero/front-wing-decrease.svg";
import frontWingIncreaseIconSvg from "@iracedeck/icons/setup-aero/front-wing-increase.svg";
import qualifyingTapeDecreaseIconSvg from "@iracedeck/icons/setup-aero/qualifying-tape-decrease.svg";
import qualifyingTapeIncreaseIconSvg from "@iracedeck/icons/setup-aero/qualifying-tape-increase.svg";
import rearWingDecreaseIconSvg from "@iracedeck/icons/setup-aero/rear-wing-decrease.svg";
import rearWingIncreaseIconSvg from "@iracedeck/icons/setup-aero/rear-wing-increase.svg";
import rfBrakeAttachedIconSvg from "@iracedeck/icons/setup-aero/rf-brake-attached.svg";
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
import { DialSettings, seedDialFromLegacySetting, SetupAeroDialSurface } from "./setup-aero-dial-surface.js";

type SetupAeroAdjustSetting = "front-wing" | "rear-wing" | "qualifying-tape" | "rf-brake-attached";

/**
 * The combined `setting` type is the union of `SetupAeroAdjustSetting` and the two View
 * IDs in `setup-view.ts`. Code paths narrow back to `SetupAeroAdjustSetting` after
 * `isViewSetting` gates the View branch; nothing needs the full union as a name.
 */

type DirectionType = "increase" | "decrease";

/** Controls that have +/- direction */
const DIRECTIONAL_CONTROLS: Set<SetupAeroAdjustSetting> = new Set(["front-wing", "rear-wing", "qualifying-tape"]);

/**
 * Flat icon lookup record mapping setting + direction keys to imported SVGs.
 */
const SETUP_AERO_ICONS: Record<string, string> = {
  "front-wing-increase": frontWingIncreaseIconSvg,
  "front-wing-decrease": frontWingDecreaseIconSvg,
  "rear-wing-increase": rearWingIncreaseIconSvg,
  "rear-wing-decrease": rearWingDecreaseIconSvg,
  "qualifying-tape-increase": qualifyingTapeIncreaseIconSvg,
  "qualifying-tape-decrease": qualifyingTapeDecreaseIconSvg,
  "rf-brake-attached": rfBrakeAttachedIconSvg,
};

/**
 * Title text for each setting + direction combination (format: "subLabel\nmainLabel")
 */
const SETUP_AERO_TITLES: Record<string, string> = {
  "front-wing-increase": "INCREASE\nFRONT WING",
  "front-wing-decrease": "DECREASE\nFRONT WING",
  "rear-wing-increase": "INCREASE\nREAR WING",
  "rear-wing-decrease": "DECREASE\nREAR WING",
  "qualifying-tape-increase": "INCREASE\nQUAL TAPE",
  "qualifying-tape-decrease": "DECREASE\nQUAL TAPE",
  "rf-brake-attached": "TOGGLE\nRF BRAKE",
};

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * Directional controls use composite keys (e.g., "front-wing-increase").
 */
export const SETUP_AERO_GLOBAL_KEYS: Record<string, string> = {
  "front-wing-increase": "setupAeroFrontWingIncrease",
  "front-wing-decrease": "setupAeroFrontWingDecrease",
  "rear-wing-increase": "setupAeroRearWingIncrease",
  "rear-wing-decrease": "setupAeroRearWingDecrease",
  "qualifying-tape-increase": "setupAeroQualifyingTapeIncrease",
  "qualifying-tape-decrease": "setupAeroQualifyingTapeDecrease",
  "rf-brake-attached": "setupAeroRfBrakeAttached",
};

const SetupAeroSettings = CommonSettings.extend({
  setting: z
    .enum([
      // View sub-modes.
      "view-front-wing",
      "view-rear-wing",
      // Adjustment sub-modes.
      "front-wing",
      "rear-wing",
      "qualifying-tape",
      "rf-brake-attached",
    ])
    .default("front-wing"),
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
  // Dial-surface settings (#799), under the `dial` root so keypad and dial keys
  // can't collide. catch: dial garbage degrades to dial defaults instead of
  // failing the whole parse (which would reset a keypad instance).
  dial: DialSettings.catch(() => DialSettings.parse({})),
});

type SetupAeroSettings = z.infer<typeof SetupAeroSettings>;

/**
 * @internal Exported for testing
 *
 * Parses raw settings, falling back to full defaults when the whole parse fails.
 */
export function parseSetupAeroSettings(raw: unknown): SetupAeroSettings {
  const parsed = SetupAeroSettings.safeParse(raw);

  return parsed.success ? parsed.data : SetupAeroSettings.parse({});
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup aero action's adjustment sub-modes.
 * View sub-modes use the shared `generateSetupViewSvg` render path.
 */
export function generateSetupAeroSvg(settings: SetupAeroSettings, bindingMissing = false): string {
  if (isViewSetting(settings.setting)) {
    return generateSetupViewSvg({
      viewId: settings.setting,
      telemetry: null,
      colorSourceSvg: frontWingIncreaseIconSvg,
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
      bindingMissing,
    });
  }

  const setting = settings.setting as SetupAeroAdjustSetting;
  const { direction } = settings;

  const iconKey = DIRECTIONAL_CONTROLS.has(setting) ? `${setting}-${direction}` : setting;
  const iconSvg = SETUP_AERO_ICONS[iconKey] || SETUP_AERO_ICONS["rf-brake-attached"];
  const defaultTitle = SETUP_AERO_TITLES[iconKey] || "SETUP\nAERO";

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * Setup Aero Action
 * Provides aerodynamic in-car adjustments (front wing, rear wing,
 * qualifying tape, RF brake attached) via keyboard shortcuts.
 */
export const SETUP_AERO_UUID = "com.iracedeck.sd.core.setup-aero" as const;

export class SetupAero extends ConnectionStateAwareAction<SetupAeroSettings> {
  /** Current settings per action context, used by the telemetry-tick callback for View sub-modes. */
  private readonly activeContexts = new Map<string, SetupAeroSettings>();

  /** Last rendered View value per context — memoizes the icon so we only re-emit on actual change. */
  private readonly lastRenderedValue = new Map<string, string>();

  /** Per-context key-down timestamps for dual-press dispatch on View sub-modes (#540). */
  private readonly dualPress = new DualPressTracker();

  /** Hold-to-repeat for paired-style directional keys (always on, spec 2026-07-07). */
  private readonly repeat = new RepeatController(this.logger);

  /** Coalesces telemetry-driven re-renders to ≤ 10/s per key (issue #493 pattern). */
  private readonly iconThrottle = new IconUpdateThrottle();

  /**
   * The dial half of the action; all IDeck dial events route here (#799). No
   * `setActiveBinding` is delegated — it would bleed onto the keypad buttons.
   */
  private readonly dialSurface = new SetupAeroDialSurface({
    logger: this.logger,
    getTelemetry: () => this.sdkController.getCurrentTelemetry(),
    tapBinding: (settingKey) => this.tapBinding(settingKey),
    isBindingMissing: (keys) => this.isBindingMissing(keys),
  });

  /** Keeps the dial strips' #612 missing-binding warning live while iRacing is offline (#799). */
  private readonly unsubscribeGlobalSettings = onGlobalSettingsChange(() => this.dialSurface.refreshAll());

  override async onWillAppear(ev: IDeckWillAppearEvent<SetupAeroSettings>): Promise<void> {
    await super.onWillAppear(ev);
    let settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      // #799 dial migration: a pre-dial-surface encoder placement drove the flat
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

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SetupAeroSettings>): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.dialSurface.willDisappear(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastRenderedValue.delete(ev.action.id);
    this.dualPress.clear(ev.action.id);
    this.repeat.clear(ev.action.id);
    this.iconThrottle.clear(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SetupAeroSettings>): Promise<void> {
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

  override async onKeyDown(ev: IDeckKeyDownEvent<SetupAeroSettings>): Promise<void> {
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
          await this.executeSetting(setting as SetupAeroAdjustSetting, direction);

          return true;
        },
      });
    }

    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<SetupAeroSettings>): Promise<void> {
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
    const settingKey = SETUP_AERO_GLOBAL_KEYS[`${adjustMode}-${direction}`];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for dual-press ${adjustMode} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<SetupAeroSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.rotate(ev.action, settings.dial, ev.payload.ticks, ev.payload.pressed === true);
  }

  override async onDialDown(ev: IDeckDialDownEvent<SetupAeroSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.down(ev.action, settings.dial);
  }

  override async onDialUp(ev: IDeckDialUpEvent<SetupAeroSettings>): Promise<void> {
    await this.dialSurface.up(ev.action.id);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<SetupAeroSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.touchTap(ev.action, settings.dial, ev.payload.hold === true);
  }

  private parseSettings(settings: unknown): SetupAeroSettings {
    return parseSetupAeroSettings(settings);
  }

  private applyActiveBinding(settings: SetupAeroSettings): void {
    if (isViewSetting(settings.setting)) {
      if (!settings.dualPressEnabled) {
        this.setActiveBinding(null);

        return;
      }

      const adjustMode = getAdjustmentModeForView(settings.setting);
      const tapDir: DirectionType = getDualPressDirections() === "tap-increases" ? "increase" : "decrease";
      const activeKey = adjustMode ? (SETUP_AERO_GLOBAL_KEYS[`${adjustMode}-${tapDir}`] ?? null) : null;
      this.setActiveBinding(activeKey);

      return;
    }

    const activeKey = this.resolveGlobalKey(settings.setting, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }
  }

  private async executeSetting(setting: SetupAeroAdjustSetting, direction: DirectionType): Promise<void> {
    const settingKey = this.resolveGlobalKey(setting, direction);

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${setting} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  private resolveGlobalKey(setting: SetupAeroAdjustSetting, direction: DirectionType): string | null {
    if (DIRECTIONAL_CONTROLS.has(setting)) {
      const key = `${setting}-${direction}`;

      return SETUP_AERO_GLOBAL_KEYS[key] ?? null;
    }

    return SETUP_AERO_GLOBAL_KEYS[setting] ?? null;
  }

  /**
   * Per-button missing-binding check for the icon warning overlay (#612).
   * Computed from THIS button's settings (not the shared `activeBindingKeys`).
   * - View sub-modes require both the adjustment's increase + decrease bindings,
   *   but only while dual-press is enabled (read-only Views need no binding).
   * - Directional adjust modes require the single setting+direction binding.
   * - Non-directional constants require the single setting binding.
   */
  private computeBindingMissing(settings: SetupAeroSettings): boolean {
    if (isViewSetting(settings.setting)) {
      if (!settings.dualPressEnabled) return false;

      const adjustMode = getAdjustmentModeForView(settings.setting);

      if (!adjustMode) return false;

      return this.isBindingMissing([
        SETUP_AERO_GLOBAL_KEYS[`${adjustMode}-increase`],
        SETUP_AERO_GLOBAL_KEYS[`${adjustMode}-decrease`],
      ]);
    }

    return this.isBindingMissing(this.resolveGlobalKey(settings.setting as SetupAeroAdjustSetting, settings.direction));
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<SetupAeroSettings> | IDeckDidReceiveSettingsEvent<SetupAeroSettings>,
    settings: SetupAeroSettings,
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

  private renderIcon(settings: SetupAeroSettings): string {
    const bindingMissing = this.computeBindingMissing(settings);

    const paired = renderPairedIconOrNull({
      setting: settings.setting,
      direction: settings.direction,
      keyStyle: settings.keyStyle,
      pairPosition: settings.pairPosition,
      telemetry: this.sdkController.getCurrentTelemetry(),
      colorSourceSvg: frontWingIncreaseIconSvg,
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
        colorSourceSvg: frontWingIncreaseIconSvg,
        colorOverrides: settings.colorOverrides,
        titleOverrides: settings.titleOverrides,
        borderOverrides: settings.borderOverrides,
        bindingMissing,
      });
    }

    return generateSetupAeroSvg(settings, bindingMissing);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: SetupAeroSettings,
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
