import {
  applyBindingWarning,
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  DualPressTracker,
  generateBorderParts,
  generateTitleText,
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
  renderIconTemplate,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
} from "@iracedeck/deck-core";
import tcSlot1DecreaseIconSvg from "@iracedeck/icons/setup-traction/tc-slot-1-decrease.svg";
import tcSlot1IncreaseIconSvg from "@iracedeck/icons/setup-traction/tc-slot-1-increase.svg";
import tcSlot2DecreaseIconSvg from "@iracedeck/icons/setup-traction/tc-slot-2-decrease.svg";
import tcSlot2IncreaseIconSvg from "@iracedeck/icons/setup-traction/tc-slot-2-increase.svg";
import tcSlot3DecreaseIconSvg from "@iracedeck/icons/setup-traction/tc-slot-3-decrease.svg";
import tcSlot3IncreaseIconSvg from "@iracedeck/icons/setup-traction/tc-slot-3-increase.svg";
import tcSlot4DecreaseIconSvg from "@iracedeck/icons/setup-traction/tc-slot-4-decrease.svg";
import tcSlot4IncreaseIconSvg from "@iracedeck/icons/setup-traction/tc-slot-4-increase.svg";
import tcToggleIconSvg from "@iracedeck/icons/setup-traction/tc-toggle.svg";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import tcToggleTemplate from "../../../icons/setup-traction-tc-toggle.svg";
import {
  borderColorForState,
  statusBarNA,
  statusBarOff,
  statusBarOn,
  type ToggleState,
} from "../../icons/status-bar.js";
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
import { DialSettings, seedDialFromLegacySetting, SetupTractionDialSurface } from "./setup-traction-dial-surface.js";

type SetupTractionAdjustSetting = "tc-toggle" | "tc-slot-1" | "tc-slot-2" | "tc-slot-3" | "tc-slot-4";

const STATUS_BARS: Record<ToggleState, () => string> = { on: statusBarOn, off: statusBarOff, na: statusBarNA };

/**
 * @internal Exported for testing
 *
 * Maps dcTractionControl telemetry to the tri-state shown on the TC Toggle
 * key: no telemetry -> N/A; dcTractionControl > 0 -> on; otherwise off.
 */
export function tcToggleState(telemetry: TelemetryData | null): ToggleState {
  const value = telemetry?.dcTractionControl;

  if (typeof value !== "number") return "na";

  return value > 0 ? "on" : "off";
}

/**
 * The combined `setting` type is the union of `SetupTractionAdjustSetting` and the two
 * View IDs in `setup-view.ts`. Code paths narrow back to `SetupTractionAdjustSetting`
 * after `isViewSetting` gates the View branch; nothing needs the full union as a name.
 */

type DirectionType = "increase" | "decrease";

/** Controls that have +/- direction */
const DIRECTIONAL_CONTROLS: Set<SetupTractionAdjustSetting> = new Set([
  "tc-slot-1",
  "tc-slot-2",
  "tc-slot-3",
  "tc-slot-4",
]);

/**
 * Flat icon lookup record mapping setting + direction keys to standalone SVG templates.
 */
const SETUP_TRACTION_ICONS: Record<string, string> = {
  "tc-toggle": tcToggleIconSvg,
  "tc-slot-1-increase": tcSlot1IncreaseIconSvg,
  "tc-slot-1-decrease": tcSlot1DecreaseIconSvg,
  "tc-slot-2-increase": tcSlot2IncreaseIconSvg,
  "tc-slot-2-decrease": tcSlot2DecreaseIconSvg,
  "tc-slot-3-increase": tcSlot3IncreaseIconSvg,
  "tc-slot-3-decrease": tcSlot3DecreaseIconSvg,
  "tc-slot-4-increase": tcSlot4IncreaseIconSvg,
  "tc-slot-4-decrease": tcSlot4DecreaseIconSvg,
};

/**
 * Title text for each setting + direction combination (format: "subLabel\nmainLabel")
 */
const SETUP_TRACTION_TITLES: Record<string, string> = {
  "tc-toggle": "TOGGLE\nTC",
  "tc-slot-1-increase": "INCREASE\nTC1",
  "tc-slot-1-decrease": "DECREASE\nTC1",
  "tc-slot-2-increase": "INCREASE\nTC2",
  "tc-slot-2-decrease": "DECREASE\nTC2",
  "tc-slot-3-increase": "INCREASE\nTC3",
  "tc-slot-3-decrease": "DECREASE\nTC3",
  "tc-slot-4-increase": "INCREASE\nTC4",
  "tc-slot-4-decrease": "DECREASE\nTC4",
};

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * Directional controls use composite keys (e.g., "tc-slot-1-increase").
 */
export const SETUP_TRACTION_GLOBAL_KEYS: Record<string, string> = {
  "tc-toggle": "setupTractionTcToggle",
  "tc-slot-1-increase": "setupTractionTcSlot1Increase",
  "tc-slot-1-decrease": "setupTractionTcSlot1Decrease",
  "tc-slot-2-increase": "setupTractionTcSlot2Increase",
  "tc-slot-2-decrease": "setupTractionTcSlot2Decrease",
  "tc-slot-3-increase": "setupTractionTcSlot3Increase",
  "tc-slot-3-decrease": "setupTractionTcSlot3Decrease",
  "tc-slot-4-increase": "setupTractionTcSlot4Increase",
  "tc-slot-4-decrease": "setupTractionTcSlot4Decrease",
};

const SetupTractionSettings = CommonSettings.extend({
  setting: z
    .enum([
      // View sub-modes (read-only telemetry display) — one per TC slot, paired with the
      // matching `tc-slot-N` adjustment entry in the PI dropdown.
      "view-tc-slot-1",
      "view-tc-slot-2",
      "view-tc-slot-3",
      "view-tc-slot-4",
      // Adjustment sub-modes.
      "tc-toggle",
      "tc-slot-1",
      "tc-slot-2",
      "tc-slot-3",
      "tc-slot-4",
    ])
    .default("tc-toggle"),
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
  // Dial-surface settings (#795), under the `dial` root so keypad and dial keys
  // can't collide. catch: dial garbage degrades to dial defaults instead of
  // failing the whole parse (which would reset a keypad instance).
  dial: DialSettings.catch(() => DialSettings.parse({})),
});

type SetupTractionSettings = z.infer<typeof SetupTractionSettings>;

/**
 * @internal Exported for testing
 *
 * Parses raw settings, falling back to full defaults when the whole parse fails.
 */
export function parseSetupTractionSettings(raw: unknown): SetupTractionSettings {
  const parsed = SetupTractionSettings.safeParse(raw);

  return parsed.success ? parsed.data : SetupTractionSettings.parse({});
}

/**
 * Resolves the flat icon lookup key from setting and direction.
 */
function resolveIconKey(setting: SetupTractionAdjustSetting, direction: DirectionType): string {
  if (DIRECTIONAL_CONTROLS.has(setting)) {
    return `${setting}-${direction}`;
  }

  return setting;
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup traction action's adjustment sub-modes.
 * View sub-modes use the shared `generateSetupViewSvg` render path.
 */
export function generateSetupTractionSvg(settings: SetupTractionSettings, bindingMissing = false): string {
  if (isViewSetting(settings.setting)) {
    return generateSetupViewSvg({
      viewId: settings.setting,
      telemetry: null,
      colorSourceSvg: tcSlot1IncreaseIconSvg,
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
      bindingMissing,
    });
  }

  const setting = settings.setting as SetupTractionAdjustSetting;
  const iconKey = resolveIconKey(setting, settings.direction);

  const iconSvg = SETUP_TRACTION_ICONS[iconKey] || SETUP_TRACTION_ICONS["tc-toggle"];
  const defaultTitle = SETUP_TRACTION_TITLES[iconKey] || "SETUP\nTC";

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * @internal Exported for testing
 *
 * TC Toggle renders through a dedicated tri-state template (the DRS pattern,
 * #827): a big locked "TC" title above a full-width ON/OFF/N-A status bar,
 * with the key border tracking the same state color.
 */
export function generateTcToggleSvg(
  settings: SetupTractionSettings,
  state: ToggleState,
  bindingMissing = false,
): string {
  const colors = resolveIconColors(tcToggleTemplate, getGlobalColors(), settings.colorOverrides) as Record<
    string,
    string
  >;
  const resolvedTitle = resolveTitleSettings(tcToggleTemplate, getGlobalTitleSettings(), settings.titleOverrides);

  const titleContent = resolvedTitle.showTitle
    ? generateTitleText({
        text: resolvedTitle.titleText,
        fontSize: resolvedTitle.fontSize,
        bold: resolvedTitle.bold,
        position: resolvedTitle.position,
        customPosition: resolvedTitle.customPosition,
        fill: colors.textColor ?? "#ffffff",
      })
    : "";

  const border = resolveBorderSettings(
    tcToggleTemplate,
    getGlobalBorderSettings(),
    settings.borderOverrides,
    borderColorForState(state),
  );
  const borderSvg = generateBorderParts(border);

  const baseIconContent = STATUS_BARS[state]();
  const iconContent = bindingMissing ? applyBindingWarning(baseIconContent) : baseIconContent;

  const svg = renderIconTemplate(tcToggleTemplate, {
    iconContent,
    titleContent,
    borderDefs: borderSvg.defs,
    borderContent: borderSvg.rects,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Setup Traction Action
 * Provides traction control in-car adjustments (TC Toggle, TC1–TC4)
 * via keyboard shortcuts.
 */
export const SETUP_TRACTION_UUID = "com.iracedeck.sd.core.setup-traction" as const;

export class SetupTraction extends ConnectionStateAwareAction<SetupTractionSettings> {
  /** Current settings per action context, used by the telemetry-tick callback for View sub-modes. */
  private readonly activeContexts = new Map<string, SetupTractionSettings>();

  /** Last rendered View value per context — memoizes the icon so we only re-emit on actual change. */
  private readonly lastRenderedValue = new Map<string, string>();

  /** Per-context key-down timestamps for dual-press dispatch on View sub-modes (#540). */
  private readonly dualPress = new DualPressTracker();

  /** Hold-to-repeat for paired-style directional keys (always on, spec 2026-07-07). */
  private readonly repeat = new RepeatController(this.logger);

  /** Coalesces telemetry-driven re-renders to ≤ 10/s per key (issue #493 pattern). */
  private readonly iconThrottle = new IconUpdateThrottle();

  /**
   * The dial half of the action; all IDeck dial events route here (#795). No
   * `setActiveBinding` is delegated — it is one value per action-class instance
   * and a dial context setting it would bleed onto the keypad buttons.
   */
  private readonly dialSurface = new SetupTractionDialSurface({
    logger: this.logger,
    getTelemetry: () => this.sdkController.getCurrentTelemetry(),
    tapBinding: (settingKey) => this.tapBinding(settingKey),
    isBindingMissing: (keys) => this.isBindingMissing(keys),
  });

  /** Keeps the dial strips' #612 missing-binding warning live while iRacing is offline (#795). */
  private readonly unsubscribeGlobalSettings = onGlobalSettingsChange(() => this.dialSurface.refreshAll());

  override async onWillAppear(ev: IDeckWillAppearEvent<SetupTractionSettings>): Promise<void> {
    await super.onWillAppear(ev);
    let settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      // #795 dial migration: a pre-dial-surface encoder placement drove the flat
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

      if (
        stored &&
        (stored.setting === "tc-toggle" || isViewSetting(stored.setting) || pairedKeyNeedsTelemetry(stored))
      ) {
        void this.updateDisplayFromTelemetry(ev.action.id, telemetry, stored);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SetupTractionSettings>): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.dialSurface.willDisappear(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastRenderedValue.delete(ev.action.id);
    this.dualPress.clear(ev.action.id);
    this.repeat.clear(ev.action.id);
    this.iconThrottle.clear(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SetupTractionSettings>): Promise<void> {
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

  override async onKeyDown(ev: IDeckKeyDownEvent<SetupTractionSettings>): Promise<void> {
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
          await this.executeSetting(setting as SetupTractionAdjustSetting, direction);

          return true;
        },
      });
    }

    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<SetupTractionSettings>): Promise<void> {
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
    const settingKey = SETUP_TRACTION_GLOBAL_KEYS[`${adjustMode}-${direction}`];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for dual-press ${adjustMode} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<SetupTractionSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.rotate(ev.action, settings.dial, ev.payload.ticks, ev.payload.pressed === true);
  }

  override async onDialDown(ev: IDeckDialDownEvent<SetupTractionSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.down(ev.action, settings.dial);
  }

  override async onDialUp(ev: IDeckDialUpEvent<SetupTractionSettings>): Promise<void> {
    await this.dialSurface.up(ev.action.id);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<SetupTractionSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.touchTap(ev.action, settings.dial, ev.payload.hold === true);
  }

  private parseSettings(settings: unknown): SetupTractionSettings {
    return parseSetupTractionSettings(settings);
  }

  private applyActiveBinding(settings: SetupTractionSettings): void {
    if (isViewSetting(settings.setting)) {
      if (!settings.dualPressEnabled) {
        this.setActiveBinding(null);

        return;
      }

      const adjustMode = getAdjustmentModeForView(settings.setting);
      const tapDir: DirectionType = getDualPressDirections() === "tap-increases" ? "increase" : "decrease";
      const activeKey = adjustMode ? (SETUP_TRACTION_GLOBAL_KEYS[`${adjustMode}-${tapDir}`] ?? null) : null;
      this.setActiveBinding(activeKey);

      return;
    }

    const activeKey = this.resolveGlobalKey(settings.setting, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }
  }

  private async executeSetting(setting: SetupTractionAdjustSetting, direction: DirectionType): Promise<void> {
    const settingKey = this.resolveGlobalKey(setting, direction);

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${setting} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  private resolveGlobalKey(setting: SetupTractionAdjustSetting, direction: DirectionType): string | null {
    if (DIRECTIONAL_CONTROLS.has(setting)) {
      const key = `${setting}-${direction}`;

      return SETUP_TRACTION_GLOBAL_KEYS[key] ?? null;
    }

    return SETUP_TRACTION_GLOBAL_KEYS[setting] ?? null;
  }

  /**
   * Per-button missing-binding check for the icon warning overlay (#612).
   * Computed from THIS button's settings (not the shared `activeBindingKeys`).
   * - View sub-modes require both the adjustment's increase + decrease bindings,
   *   but only while dual-press is enabled (read-only Views need no binding).
   * - Directional adjust modes require the single setting+direction binding.
   * - Non-directional constants require the single setting binding.
   */
  private computeBindingMissing(settings: SetupTractionSettings): boolean {
    if (isViewSetting(settings.setting)) {
      if (!settings.dualPressEnabled) return false;

      const adjustMode = getAdjustmentModeForView(settings.setting);

      if (!adjustMode) return false;

      return this.isBindingMissing([
        SETUP_TRACTION_GLOBAL_KEYS[`${adjustMode}-increase`],
        SETUP_TRACTION_GLOBAL_KEYS[`${adjustMode}-decrease`],
      ]);
    }

    return this.isBindingMissing(
      this.resolveGlobalKey(settings.setting as SetupTractionAdjustSetting, settings.direction),
    );
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<SetupTractionSettings> | IDeckDidReceiveSettingsEvent<SetupTractionSettings>,
    settings: SetupTractionSettings,
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

  private renderIcon(settings: SetupTractionSettings): string {
    const bindingMissing = this.computeBindingMissing(settings);

    if (settings.setting === "tc-toggle") {
      return generateTcToggleSvg(settings, tcToggleState(this.sdkController.getCurrentTelemetry()), bindingMissing);
    }

    const paired = renderPairedIconOrNull({
      setting: settings.setting,
      direction: settings.direction,
      keyStyle: settings.keyStyle,
      pairPosition: settings.pairPosition,
      telemetry: this.sdkController.getCurrentTelemetry(),
      colorSourceSvg: tcSlot1IncreaseIconSvg,
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
        colorSourceSvg: tcSlot1IncreaseIconSvg,
        colorOverrides: settings.colorOverrides,
        titleOverrides: settings.titleOverrides,
        borderOverrides: settings.borderOverrides,
        bindingMissing,
      });
    }

    return generateSetupTractionSvg(settings, bindingMissing);
  }

  /**
   * Memo value that decides whether a telemetry tick changes what the key
   * shows. tc-toggle keys memo their tri-state; everything else defers to
   * the shared adjust-styles/View memo.
   */
  private telemetryMemo(settings: SetupTractionSettings, telemetry: TelemetryData | null): string | null {
    if (settings.setting === "tc-toggle") {
      return `tc-toggle|${tcToggleState(telemetry)}`;
    }

    return telemetryMemoValue(settings, telemetry);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: SetupTractionSettings,
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
