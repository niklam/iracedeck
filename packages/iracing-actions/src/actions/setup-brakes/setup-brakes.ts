import {
  assembleIcon,
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

import absToggleTemplate from "../../../icons/setup-brakes-abs-toggle.svg";
import {
  generateToggleStateSvg,
  type ToggleState,
  toggleStateFromLevel,
  toggleStateMemoKey,
} from "../../icons/status-bar.js";
import {
  ADJUST_REPEAT_INTERVAL_MS,
  ADJUST_REPEAT_SAFETY_MS,
  hasPairedValueSource,
  pairedKeyNeedsTelemetry,
  renderPairedIconOrNull,
  seedFreshKeyStyle,
  telemetryMemoValue,
} from "../../shared/adjust-styles.js";
import { IconUpdateThrottle } from "../../shared/icon-update-throttle.js";
import { RepeatController } from "../../shared/repeat-controller.js";
import { generateSetupViewSvg, getAdjustmentModeForView, isViewSetting } from "../../shared/setup-view.js";
import { SetupBrakesDialSurface } from "./setup-brakes-dial-surface.js";
import {
  parseSetupBrakesSettings,
  seedDialFromLegacySetting,
  SETUP_BRAKES_GLOBAL_KEYS,
  type SetupBrakesDirection,
  type SetupBrakesSettings,
} from "./setup-brakes-settings.js";

export { SETUP_BRAKES_GLOBAL_KEYS } from "./setup-brakes-settings.js";

type SetupBrakesAdjustSetting =
  "abs-toggle" | "abs-adjust" | "brake-bias" | "brake-bias-fine" | "peak-brake-bias" | "brake-misc" | "engine-braking";

/**
 * The combined `setting` type is the union of `SetupBrakesAdjustSetting` and the six View
 * IDs in `setup-view.ts`. Code paths narrow back to `SetupBrakesAdjustSetting` after
 * `isViewSetting` gates the View branch; nothing needs the full union as a name.
 */

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
  "abs-adjust-increase": "ABS",
  "abs-adjust-decrease": "ABS",
  "brake-bias-increase": "BRAKE BIAS",
  "brake-bias-decrease": "BRAKE BIAS",
  "brake-bias-fine-increase": "BIAS FINE",
  "brake-bias-fine-decrease": "BIAS FINE",
  "peak-brake-bias-increase": "PEAK BIAS",
  "peak-brake-bias-decrease": "PEAK BIAS",
  "brake-misc-increase": "BRAKE MISC",
  "brake-misc-decrease": "BRAKE MISC",
  "engine-braking-increase": "ENG BRAKE",
  "engine-braking-decrease": "ENG BRAKE",
};

/**
 * Resolves the flat icon lookup key for a given adjustment setting and direction.
 * View sub-modes use a separate render path (`generateSetupViewSvg`) and never reach this.
 */
function resolveIconKey(setting: SetupBrakesAdjustSetting, direction: SetupBrakesDirection): string {
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
export function generateSetupBrakesSvg(settings: SetupBrakesSettings, bindingMissing = false): string {
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
      bindingMissing,
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

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * ISO ABS symbol drawn above the status bar. Lives here (not baked into the
 * chrome template) so `generateToggleStateSvg` can dim it together with the
 * bar under the binding-missing warning — the DRS pattern. Rendered with the
 * icon's resolved colors, so the placeholders resolve at compose time.
 */
const ABS_TOGGLE_ARTWORK = `
    <defs>
      <linearGradient id="abs-mtl" x1="0" y1="0" x2="0" y2="1"><stop stop-color="{{graphic1Color}}"/><stop offset="1" stop-color="{{graphic1Color}}" stop-opacity="0.55"/></linearGradient>
    </defs>
    <path d="M40.5 25.5 A31.5 31.5 0 0 0 40.5 70.5" fill="none" stroke="url(#abs-mtl)" stroke-width="5.25" stroke-linecap="round"/>
    <path d="M103.5 25.5 A31.5 31.5 0 0 1 103.5 70.5" fill="none" stroke="url(#abs-mtl)" stroke-width="5.25" stroke-linecap="round"/>
    <circle cx="72" cy="48" r="25.5" fill="none" stroke="url(#abs-mtl)" stroke-width="5.25"/>
    <text x="72" y="54.75" font-family="Arial, sans-serif" font-size="17.25" font-weight="bold" fill="{{graphic1Color}}" text-anchor="middle">ABS</text>`;

/**
 * @internal Exported for testing
 *
 * Maps dcABS telemetry to the tri-state shown on the ABS Toggle key: no
 * telemetry -> N/A; dcABS > 0 -> on; otherwise off. dcABS carries the ABS
 * level, which the toggle binding flips between off and the configured level.
 */
export function absToggleState(telemetry: TelemetryData | null): ToggleState {
  return toggleStateFromLevel(telemetry?.dcABS);
}

/**
 * @internal Exported for testing
 *
 * ABS Toggle renders through the shared tri-state toggle path (the DRS
 * pattern, #827): the ISO ABS symbol above a full-width ON/OFF/N-A status
 * bar, with the key border tracking the same state color.
 */
export function generateAbsToggleSvg(
  settings: SetupBrakesSettings,
  state: ToggleState,
  bindingMissing = false,
): string {
  return generateToggleStateSvg({
    template: absToggleTemplate,
    artwork: ABS_TOGGLE_ARTWORK,
    state,
    colorOverrides: settings.colorOverrides,
    titleOverrides: settings.titleOverrides,
    borderOverrides: settings.borderOverrides,
    bindingMissing,
  });
}

/**
 * Setup Brakes Action
 *
 * One action, two surfaces (#775, the Fuel Service pattern): on a keypad
 * button it provides brake-related in-car adjustments (ABS, brake bias, peak
 * bias, engine braking) via keyboard shortcuts, including live-telemetry View
 * sub-modes; on a Stream Deck+ dial (or Mirabox knob) it routes every dial
 * event to {@link SetupBrakesDialSurface} — rotate adjusts one brake setting,
 * press/touch gestures are configurable, and the touch strip shows the live
 * value in a color-coded dash box.
 */
export const SETUP_BRAKES_UUID = "com.iracedeck.sd.core.setup-brakes" as const;

export class SetupBrakes extends ConnectionStateAwareAction<SetupBrakesSettings> {
  /** Current settings per action context, used by the telemetry-tick callback for View sub-modes. */
  private readonly activeContexts = new Map<string, SetupBrakesSettings>();

  /** Last rendered View value per context — memoizes the icon so we only re-emit on actual change. */
  private readonly lastRenderedValue = new Map<string, string>();

  /** Per-context key-down timestamps for dual-press dispatch on View sub-modes (#540). */
  private readonly dualPress = new DualPressTracker();

  /** Hold-to-repeat for paired-style directional keys (always on, spec 2026-07-07). */
  private readonly repeat = new RepeatController(this.logger);

  /** Coalesces telemetry-driven re-renders to ≤ 10/s per key (issue #493 pattern). */
  private readonly iconThrottle = new IconUpdateThrottle();

  /**
   * The dial half of the action; all IDeck dial events route here. No
   * `setActiveBinding` is delegated — readiness state is one value per
   * action-class instance and a dial context setting it would bleed onto the
   * keypad buttons (mirrors the Fuel Service dial surface).
   */
  private readonly dialSurface = new SetupBrakesDialSurface({
    logger: this.logger,
    getTelemetry: () => this.sdkController.getCurrentTelemetry(),
    tapBinding: (settingKey) => this.tapBinding(settingKey),
    isBindingMissing: (keys) => this.isBindingMissing(keys),
  });

  /**
   * Keeps the dial strips' #612 missing-binding warning live: telemetry ticks
   * only arrive while iRacing is connected, so without this a binding
   * configured (or removed) with the sim closed would leave the strip's
   * warning state frozen until the next connect or settings change. The
   * subscription lives for the plugin's lifetime, like the action instance.
   */
  private readonly unsubscribeGlobalSettings = onGlobalSettingsChange(() => this.dialSurface.refreshAll());

  override async onWillAppear(ev: IDeckWillAppearEvent<SetupBrakesSettings>): Promise<void> {
    await super.onWillAppear(ev);
    let settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      // One-shot #775 migration: a pre-merge encoder placement (Ulanzi 2.0
      // alphas) drove the flat keypad `setting` — carry a valid rotation value
      // over to `dial.setting` so the knob keeps adjusting what the user
      // configured, and persist so the PI shows it.
      const seeded = seedDialFromLegacySetting(ev.payload.settings);

      if (seeded) {
        await ev.action.setSettings(seeded);
        settings = this.parseSettings(seeded);
      }

      await this.dialSurface.willAppear(ev.action, settings);
      this.sdkController.subscribe(ev.action.id, (telemetry) => {
        this.dialSurface.onTelemetry(ev.action.id, telemetry);
      });

      return;
    }

    // One-shot default seeding (spec 2026-07-07): a never-configured key gets
    // the modern `split` style; keys with any persisted settings stay legacy.
    const seeded = seedFreshKeyStyle(ev.payload.settings);

    if (seeded) {
      await ev.action.setSettings(seeded);
      settings = this.parseSettings(seeded);
    }

    this.activeContexts.set(ev.action.id, settings);
    this.applyActiveBinding(settings);
    await this.updateDisplay(ev, settings);

    // Subscribe always; the callback no-ops for non-View settings. View entries can be
    // toggled in / out via `onDidReceiveSettings` without resubscribing.
    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      const stored = this.activeContexts.get(ev.action.id);

      if (
        stored &&
        (stored.setting === "abs-toggle" || isViewSetting(stored.setting) || pairedKeyNeedsTelemetry(stored))
      ) {
        void this.updateDisplayFromTelemetry(ev.action.id, telemetry, stored);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SetupBrakesSettings>): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.dialSurface.willDisappear(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastRenderedValue.delete(ev.action.id);
    this.dualPress.clear(ev.action.id);
    this.repeat.clear(ev.action.id);
    this.iconThrottle.clear(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SetupBrakesSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      await this.dialSurface.didReceiveSettings(ev.action, settings);

      return;
    }

    this.activeContexts.set(ev.action.id, settings);
    // Bust the memo cache so the next tick re-renders even if the new mode happens to
    // resolve to the same display string as the previous mode.
    this.lastRenderedValue.delete(ev.action.id);
    this.repeat.clear(ev.action.id);
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

    // Hold-to-repeat for paired-style keys: arm SYNCHRONOUSLY before the first
    // execute so a racing keyUp always finds timers to clear (fuel-service pattern).
    if (settings.keyStyle !== "legacy" && hasPairedValueSource(settings.setting)) {
      const { setting, direction } = settings;
      this.repeat.onKeyDown(ev.action.id, {
        holdMs: getDualPressThresholdMs(),
        intervalMs: ADJUST_REPEAT_INTERVAL_MS,
        safetyMs: ADJUST_REPEAT_SAFETY_MS,
        execute: async () => {
          await this.executeSetting(setting as SetupBrakesAdjustSetting, direction);

          return true;
        },
      });
    }

    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<SetupBrakesSettings>): Promise<void> {
    this.repeat.onKeyUp(ev.action.id);
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

    const tapDir: SetupBrakesDirection = getDualPressDirections() === "tap-increases" ? "increase" : "decrease";
    const longDir: SetupBrakesDirection = tapDir === "increase" ? "decrease" : "increase";
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

  override async onDialRotate(ev: IDeckDialRotateEvent<SetupBrakesSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.rotate(ev.action, settings, ev.payload.ticks, ev.payload.pressed === true);
  }

  override async onDialDown(ev: IDeckDialDownEvent<SetupBrakesSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.down(ev.action, settings);
  }

  override async onDialUp(ev: IDeckDialUpEvent<SetupBrakesSettings>): Promise<void> {
    await this.dialSurface.up(ev.action.id);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<SetupBrakesSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.touchTap(ev.action, settings, ev.payload.hold === true);
  }

  private parseSettings(settings: unknown): SetupBrakesSettings {
    return parseSetupBrakesSettings(settings);
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
      const tapDir: SetupBrakesDirection = getDualPressDirections() === "tap-increases" ? "increase" : "decrease";
      const activeKey = adjustMode ? (SETUP_BRAKES_GLOBAL_KEYS[`${adjustMode}-${tapDir}`] ?? null) : null;
      this.setActiveBinding(activeKey);

      return;
    }

    const activeKey = this.resolveGlobalKey(settings.setting, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }
  }

  private async executeSetting(setting: SetupBrakesAdjustSetting, direction: SetupBrakesDirection): Promise<void> {
    const settingKey = this.resolveGlobalKey(setting, direction);

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${setting} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  private resolveGlobalKey(setting: SetupBrakesAdjustSetting, direction: SetupBrakesDirection): string | null {
    if (DIRECTIONAL_CONTROLS.has(setting)) {
      const key = `${setting}-${direction}`;

      return SETUP_BRAKES_GLOBAL_KEYS[key] ?? null;
    }

    return SETUP_BRAKES_GLOBAL_KEYS[setting] ?? null;
  }

  /**
   * Per-button missing-binding check for the icon warning overlay (#612).
   * Computed from THIS button's settings (not the shared `activeBindingKeys`).
   * - View sub-modes require both the adjustment's increase + decrease bindings,
   *   but only while dual-press is enabled (read-only Views need no binding).
   * - Directional adjust modes require the single setting+direction binding.
   * - Non-directional constants require the single setting binding.
   */
  private computeBindingMissing(settings: SetupBrakesSettings): boolean {
    if (isViewSetting(settings.setting)) {
      if (!settings.dualPressEnabled) return false;

      const adjustMode = getAdjustmentModeForView(settings.setting);

      if (!adjustMode) return false;

      return this.isBindingMissing([
        SETUP_BRAKES_GLOBAL_KEYS[`${adjustMode}-increase`],
        SETUP_BRAKES_GLOBAL_KEYS[`${adjustMode}-decrease`],
      ]);
    }

    return this.isBindingMissing(
      this.resolveGlobalKey(settings.setting as SetupBrakesAdjustSetting, settings.direction),
    );
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<SetupBrakesSettings> | IDeckDidReceiveSettingsEvent<SetupBrakesSettings>,
    settings: SetupBrakesSettings,
  ): Promise<void> {
    const svgDataUri = this.renderIcon(settings);

    const memo = this.telemetryMemo(settings, this.sdkController.getCurrentTelemetry());

    if (memo !== null) {
      this.lastRenderedValue.set(ev.action.id, memo);
    }

    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => this.renderIcon(settings));
  }

  private renderIcon(settings: SetupBrakesSettings): string {
    const bindingMissing = this.computeBindingMissing(settings);

    if (settings.setting === "abs-toggle") {
      return generateAbsToggleSvg(settings, absToggleState(this.sdkController.getCurrentTelemetry()), bindingMissing);
    }

    const paired = renderPairedIconOrNull({
      setting: settings.setting,
      direction: settings.direction,
      keyStyle: settings.keyStyle,
      pairPosition: settings.pairPosition,
      telemetry: this.sdkController.getCurrentTelemetry(),
      colorSourceSvg: brakeBiasIncreaseIconSvg,
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
        colorSourceSvg: brakeBiasIncreaseIconSvg,
        colorOverrides: settings.colorOverrides,
        titleOverrides: settings.titleOverrides,
        borderOverrides: settings.borderOverrides,
        bindingMissing,
      });
    }

    return generateSetupBrakesSvg(settings, bindingMissing);
  }

  /**
   * Memo value that decides whether a telemetry tick changes what the key
   * shows. abs-toggle keys memo their tri-state; everything else defers to
   * the shared adjust-styles/View memo.
   */
  private telemetryMemo(settings: SetupBrakesSettings, telemetry: TelemetryData | null): string | null {
    if (settings.setting === "abs-toggle") {
      return toggleStateMemoKey("abs-toggle", absToggleState(telemetry));
    }

    return telemetryMemoValue(settings, telemetry);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: SetupBrakesSettings,
  ): Promise<void> {
    const memo = this.telemetryMemo(settings, telemetry);

    if (memo === null) return;

    if (this.lastRenderedValue.get(contextId) === memo) return;

    this.lastRenderedValue.set(contextId, memo);
    this.iconThrottle.schedule(contextId, async () => {
      const stored = this.activeContexts.get(contextId);

      if (stored) await this.updateKeyImage(contextId, this.renderIcon(stored));
    });
  }
}
