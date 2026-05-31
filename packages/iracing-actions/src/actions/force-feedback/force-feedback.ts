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
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
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
import hapticLfeIntensityDecreaseSvg from "@iracedeck/icons/force-feedback/haptic-lfe-intensity-decrease.svg";
import hapticLfeIntensityIncreaseSvg from "@iracedeck/icons/force-feedback/haptic-lfe-intensity-increase.svg";
import wheelLfeDecreaseSvg from "@iracedeck/icons/force-feedback/wheel-lfe-decrease.svg";
import wheelLfeIncreaseSvg from "@iracedeck/icons/force-feedback/wheel-lfe-increase.svg";
import wheelLfeIntensityDecreaseSvg from "@iracedeck/icons/force-feedback/wheel-lfe-intensity-decrease.svg";
import wheelLfeIntensityIncreaseSvg from "@iracedeck/icons/force-feedback/wheel-lfe-intensity-increase.svg";
import z from "zod";

type ForceFeedbackMode =
  | "auto-compute-ffb-force"
  | "ffb-force"
  | "wheel-lfe"
  | "bass-shaker-lfe"
  | "wheel-lfe-intensity"
  | "haptic-lfe-intensity";

type DirectionType = "increase" | "decrease";

/** Modes that have +/- direction */
const DIRECTIONAL_MODES: Set<ForceFeedbackMode> = new Set([
  "ffb-force",
  "wheel-lfe",
  "bass-shaker-lfe",
  "wheel-lfe-intensity",
  "haptic-lfe-intensity",
]);

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
  "wheel-lfe-intensity-increase": "MORE INTENSE\nWHEEL LFE",
  "wheel-lfe-intensity-decrease": "LESS INTENSE\nWHEEL LFE",
  "haptic-lfe-intensity-increase": "MORE INTENSE\nHAPTIC LFE",
  "haptic-lfe-intensity-decrease": "LESS INTENSE\nHAPTIC LFE",
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
  "wheel-lfe-intensity": {
    increase: wheelLfeIntensityIncreaseSvg,
    decrease: wheelLfeIntensityDecreaseSvg,
  },
  "haptic-lfe-intensity": {
    increase: hapticLfeIntensityIncreaseSvg,
    decrease: hapticLfeIntensityDecreaseSvg,
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
  "wheel-lfe-intensity-increase": "forceFeedbackWheelLfeIntensityIncrease",
  "wheel-lfe-intensity-decrease": "forceFeedbackWheelLfeIntensityDecrease",
  "haptic-lfe-intensity-increase": "forceFeedbackHapticLfeIntensityIncrease",
  "haptic-lfe-intensity-decrease": "forceFeedbackHapticLfeIntensityDecrease",
};

const ForceFeedbackSettings = CommonSettings.extend({
  mode: z
    .enum([
      "auto-compute-ffb-force",
      "ffb-force",
      "wheel-lfe",
      "bass-shaker-lfe",
      "wheel-lfe-intensity",
      "haptic-lfe-intensity",
    ])
    .default("auto-compute-ffb-force"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type ForceFeedbackSettings = z.infer<typeof ForceFeedbackSettings>;

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
 * Controls force feedback and haptic settings (FFB force, wheel LFE, bass shaker LFE,
 * wheel/haptic LFE intensity) via keyboard shortcuts.
 */
export const FORCE_FEEDBACK_UUID = "com.iracedeck.sd.core.force-feedback" as const;

export class ForceFeedback extends ConnectionStateAwareAction<ForceFeedbackSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<ForceFeedbackSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const activeKey = this.resolveGlobalKey(settings.mode, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }

    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<ForceFeedbackSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
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

  override async onDialDown(ev: IDeckDialDownEvent<ForceFeedbackSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);

    // Auto Compute FFB Force is too disruptive to toggle accidentally via dial press
    if (settings.mode === "auto-compute-ffb-force") {
      this.logger.debug("Dial down ignored for auto-compute-ffb-force");

      return;
    }

    await this.executeMode(settings.mode, settings.direction);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<ForceFeedbackSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);

    // Non-directional mode (auto-compute) has no +/- adjustment — ignore rotation
    if (!DIRECTIONAL_MODES.has(settings.mode)) {
      this.logger.debug(`Rotation ignored for ${settings.mode}`);

      return;
    }

    // Clockwise (ticks > 0) = increase, Counter-clockwise (ticks < 0) = decrease
    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.executeMode(settings.mode, direction);
  }

  private parseSettings(settings: unknown): ForceFeedbackSettings {
    const parsed = ForceFeedbackSettings.safeParse(settings);

    return parsed.success ? parsed.data : ForceFeedbackSettings.parse({});
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
