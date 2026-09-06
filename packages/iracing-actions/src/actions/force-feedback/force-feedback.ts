import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckTouchTapEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  onGlobalSettingsChange,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import autoComputeFfbForceSvg from "@iracedeck/icons/force-feedback/auto-compute-ffb-force.svg";
import bassShakerLfeDecreaseSvg from "@iracedeck/icons/force-feedback/bass-shaker-lfe-decrease.svg";
import bassShakerLfeIncreaseSvg from "@iracedeck/icons/force-feedback/bass-shaker-lfe-increase.svg";
import ffbForceDecreaseSvg from "@iracedeck/icons/force-feedback/ffb-force-decrease.svg";
import ffbForceIncreaseSvg from "@iracedeck/icons/force-feedback/ffb-force-increase.svg";
import wheelLfeDecreaseSvg from "@iracedeck/icons/force-feedback/wheel-lfe-decrease.svg";
import wheelLfeIncreaseSvg from "@iracedeck/icons/force-feedback/wheel-lfe-increase.svg";
import z from "zod";

import { DialSettings, ForceFeedbackDialSurface, seedDialFromLegacySetting } from "./force-feedback-dial-surface.js";
import { migrateLfeIntensityModes } from "./migrate-lfe-intensity.js";

type ForceFeedbackMode = "auto-compute-ffb-force" | "ffb-force" | "wheel-lfe" | "bass-shaker-lfe";

type DirectionType = "increase" | "decrease";

/** Modes that have +/- direction */
const DIRECTIONAL_MODES: Set<ForceFeedbackMode> = new Set(["ffb-force", "wheel-lfe", "bass-shaker-lfe"]);

/**
 * Title text for each mode + direction combination (format: "subLabel\nmainLabel")
 */
const FORCE_FEEDBACK_TITLES: Record<string, string> = {
  "auto-compute-ffb-force": "AUTO\nFFB FORCE",
  "ffb-force-increase": "INCREASE\nFFB FORCE",
  "ffb-force-decrease": "DECREASE\nFFB FORCE",
  "wheel-lfe-increase": "LOUDER\nWHEEL LFE",
  "wheel-lfe-decrease": "QUIETER\nWHEEL LFE",
  "bass-shaker-lfe-increase": "LOUDER\nBASS SHAKER",
  "bass-shaker-lfe-decrease": "QUIETER\nBASS SHAKER",
};

/**
 * SVG templates for each mode + direction combination.
 * Non-directional modes use a single SVG for both directions.
 */
const FORCE_FEEDBACK_SVGS: Record<ForceFeedbackMode, Record<DirectionType, string> | string> = {
  "auto-compute-ffb-force": autoComputeFfbForceSvg,
  "ffb-force": {
    increase: ffbForceIncreaseSvg,
    decrease: ffbForceDecreaseSvg,
  },
  "wheel-lfe": {
    increase: wheelLfeIncreaseSvg,
    decrease: wheelLfeDecreaseSvg,
  },
  "bass-shaker-lfe": {
    increase: bassShakerLfeIncreaseSvg,
    decrease: bassShakerLfeDecreaseSvg,
  },
};

/**
 * @internal Exported for testing
 *
 * Mapping from mode + direction to global settings keys.
 * Directional modes use composite keys (e.g., "ffb-force-increase").
 * FFB Force keys are shared with cockpit-misc for backward compatibility.
 */
export const FORCE_FEEDBACK_GLOBAL_KEYS: Record<string, string> = {
  "auto-compute-ffb-force": "forceFeedbackAutoCompute",
  "ffb-force-increase": "cockpitMiscFfbForceIncrease",
  "ffb-force-decrease": "cockpitMiscFfbForceDecrease",
  "wheel-lfe-increase": "forceFeedbackWheelLfeLouder",
  "wheel-lfe-decrease": "forceFeedbackWheelLfeQuieter",
  "bass-shaker-lfe-increase": "forceFeedbackBassShakerLfeLouder",
  "bass-shaker-lfe-decrease": "forceFeedbackBassShakerLfeQuieter",
};

/**
 * @internal Exported for testing
 */
export const ForceFeedbackSettings = CommonSettings.extend({
  mode: z
    .enum(["auto-compute-ffb-force", "ffb-force", "wheel-lfe", "bass-shaker-lfe"])
    .default("auto-compute-ffb-force"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
  // Dial-surface settings (#802), under the `dial` root so keypad and dial keys
  // can't collide. catch: dial garbage degrades to dial defaults instead of
  // failing the whole parse (which would reset a keypad instance).
  dial: DialSettings.catch(() => DialSettings.parse({})),
});

export type ForceFeedbackSettings = z.infer<typeof ForceFeedbackSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the force feedback action.
 */
export function generateForceFeedbackSvg(settings: ForceFeedbackSettings, bindingMissing = false): string {
  const { mode, direction } = settings;

  const svgEntry = FORCE_FEEDBACK_SVGS[mode];
  const iconSvg =
    typeof svgEntry === "string" ? svgEntry : (svgEntry?.[direction] ?? FORCE_FEEDBACK_SVGS["auto-compute-ffb-force"]);

  const titleKey = DIRECTIONAL_MODES.has(mode) ? `${mode}-${direction}` : mode;
  const defaultTitle = FORCE_FEEDBACK_TITLES[titleKey] || "FORCE\nFEEDBACK";

  const colors = resolveIconColors(iconSvg as string, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(
    iconSvg as string,
    getGlobalTitleSettings(),
    settings.titleOverrides,
    defaultTitle,
  );

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg as string, colors, title, border, graphic, bindingMissing });
}

/**
 * Force Feedback Action
 * Controls force feedback and haptic settings (FFB force, wheel LFE, bass
 * shaker LFE) via keyboard shortcuts. iRacing's Options pages label the same
 * two LFE control pairs "More Intense / Less Intense" — the former separate
 * intensity modes were retired as duplicates (issue #848).
 */
export const FORCE_FEEDBACK_UUID = "com.iracedeck.sd.core.force-feedback" as const;

export class ForceFeedback extends ConnectionStateAwareAction<ForceFeedbackSettings> {
  /**
   * The dial half of the action; all IDeck dial events route here (#802). No
   * `setActiveBinding` is delegated — it would bleed onto the keypad buttons.
   */
  private readonly dialSurface = new ForceFeedbackDialSurface({
    logger: this.logger,
    getTelemetry: () => this.sdkController.getCurrentTelemetry(),
    tapBinding: (settingKey) => this.tapBinding(settingKey),
    isBindingMissing: (keys) => this.isBindingMissing(keys),
  });

  /** Keeps the dial strip's #612 missing-binding warning live while iRacing is offline (#802). */
  private readonly unsubscribeGlobalSettings = onGlobalSettingsChange(() => this.dialSurface.refreshAll());

  override async onWillAppear(ev: IDeckWillAppearEvent<ForceFeedbackSettings>): Promise<void> {
    await super.onWillAppear(ev);
    let settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      // #802 dial migration on top of the #848 intensity-mode migration: a
      // pre-dial-surface encoder placement drove the flat keypad `mode` — carry
      // a valid rotation value over to `dial.setting`, mapping a retired
      // intensity mode to its canonical LFE mode first so it still seeds.
      const { migrated } = migrateLfeIntensityModes(ev.payload.settings);
      const seededDial = seedDialFromLegacySetting(migrated);

      if (seededDial) {
        await ev.action.setSettings(seededDial);
        settings = this.parseSettings(seededDial);
      } else {
        await this.persistMigratedSettings(ev);
      }

      await this.dialSurface.willAppear(ev.action, settings.dial);
      this.sdkController.subscribe(ev.action.id, (telemetry) => {
        this.dialSurface.onTelemetry(ev.action.id, telemetry);
      });

      return;
    }

    await this.persistMigratedSettings(ev);
    const activeKey = this.resolveGlobalKey(settings.mode, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }

    await this.updateDisplay(ev, settings);
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<ForceFeedbackSettings>): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.dialSurface.willDisappear(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<ForceFeedbackSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    await this.persistMigratedSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      await this.dialSurface.didReceiveSettings(ev.action, settings.dial);

      return;
    }

    const activeKey = this.resolveGlobalKey(settings.mode, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<ForceFeedbackSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeMode(settings.mode, settings.direction);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<ForceFeedbackSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.rotate(ev.action, settings.dial, ev.payload.ticks, ev.payload.pressed === true);
  }

  override async onDialDown(ev: IDeckDialDownEvent<ForceFeedbackSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.down(ev.action, settings.dial);
  }

  override async onDialUp(ev: IDeckDialUpEvent<ForceFeedbackSettings>): Promise<void> {
    await this.dialSurface.up(ev.action.id);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<ForceFeedbackSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.touchTap(ev.action, settings.dial, ev.payload.hold === true);
  }

  private parseSettings(settings: unknown): ForceFeedbackSettings {
    const { migrated } = migrateLfeIntensityModes(settings);
    const parsed = ForceFeedbackSettings.safeParse(migrated);

    return parsed.success ? parsed.data : ForceFeedbackSettings.parse({});
  }

  /**
   * Detect a retired intensity mode in the persisted settings (keypad `mode` or
   * dial `dial.setting`, #848) and write the migrated shape back to storage so
   * the PI dropdowns show the canonical mode. Logs and swallows persist
   * failures — the runtime always reads via `parseSettings`, so a failed
   * persist doesn't block functionality.
   */
  private async persistMigratedSettings(
    ev: IDeckWillAppearEvent<ForceFeedbackSettings> | IDeckDidReceiveSettingsEvent<ForceFeedbackSettings>,
  ): Promise<void> {
    const { migrated, changed } = migrateLfeIntensityModes(ev.payload.settings);

    if (!changed) return;

    try {
      await ev.action.setSettings(migrated);
    } catch (err) {
      this.logger.warn(
        `Failed to persist migrated force-feedback settings: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async executeMode(mode: ForceFeedbackMode, direction: DirectionType): Promise<void> {
    const settingKey = this.resolveGlobalKey(mode, direction);

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${mode} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  private resolveGlobalKey(mode: ForceFeedbackMode, direction: DirectionType): string | null {
    if (DIRECTIONAL_MODES.has(mode)) {
      const key = `${mode}-${direction}`;

      return FORCE_FEEDBACK_GLOBAL_KEYS[key] ?? null;
    }

    return FORCE_FEEDBACK_GLOBAL_KEYS[mode] ?? null;
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<ForceFeedbackSettings> | IDeckDidReceiveSettingsEvent<ForceFeedbackSettings>,
    settings: ForceFeedbackSettings,
  ): Promise<void> {
    const activeKey = this.resolveGlobalKey(settings.mode, settings.direction);
    const svgDataUri = generateForceFeedbackSvg(settings, this.isBindingMissing(activeKey));
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () =>
      generateForceFeedbackSvg(
        settings,
        this.isBindingMissing(this.resolveGlobalKey(settings.mode, settings.direction)),
      ),
    );
  }
}
