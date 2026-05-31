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
import dashPage1DecreaseSvg from "@iracedeck/icons/cockpit-misc/dash-page-1-decrease.svg";
import dashPage1IncreaseSvg from "@iracedeck/icons/cockpit-misc/dash-page-1-increase.svg";
import dashPage2DecreaseSvg from "@iracedeck/icons/cockpit-misc/dash-page-2-decrease.svg";
import dashPage2IncreaseSvg from "@iracedeck/icons/cockpit-misc/dash-page-2-increase.svg";
import ffbMaxForceDecreaseSvg from "@iracedeck/icons/cockpit-misc/ffb-max-force-decrease.svg";
import ffbMaxForceIncreaseSvg from "@iracedeck/icons/cockpit-misc/ffb-max-force-increase.svg";
import inLapModeSvg from "@iracedeck/icons/cockpit-misc/in-lap-mode.svg";
import reportLatencySvg from "@iracedeck/icons/cockpit-misc/report-latency.svg";
import toggleWipersSvg from "@iracedeck/icons/cockpit-misc/toggle-wipers.svg";
import triggerWipersSvg from "@iracedeck/icons/cockpit-misc/trigger-wipers.svg";
import z from "zod";

type CockpitMiscControl =
  | "toggle-wipers"
  | "trigger-wipers"
  | "ffb-max-force"
  | "report-latency"
  | "dash-page-1"
  | "dash-page-2"
  | "in-lap-mode";

type DirectionType = "increase" | "decrease";

/** Controls that have +/- direction */
const DIRECTIONAL_CONTROLS: Set<CockpitMiscControl> = new Set(["ffb-max-force", "dash-page-1", "dash-page-2"]);

/**
 * Title text for each control + direction combination (format: "subLabel\nmainLabel")
 */
const COCKPIT_MISC_TITLES: Record<string, string> = {
  "toggle-wipers": "TOGGLE\nWIPERS",
  "trigger-wipers": "TRIGGER\nWIPERS",
  "ffb-max-force-increase": "INCREASE\nFFB FORCE",
  "ffb-max-force-decrease": "DECREASE\nFFB FORCE",
  "report-latency": "REPORT\nLATENCY",
  "dash-page-1-increase": "NEXT\nDASH PG 1",
  "dash-page-1-decrease": "PREVIOUS\nDASH PG 1",
  "dash-page-2-increase": "NEXT\nDASH PG 2",
  "dash-page-2-decrease": "PREVIOUS\nDASH PG 2",
  "in-lap-mode": "MODE\nIN LAP",
};

/**
 * SVG templates for each control + direction combination.
 * Non-directional controls use a single SVG for both directions.
 */
const COCKPIT_MISC_SVGS: Record<CockpitMiscControl, Record<DirectionType, string> | string> = {
  "toggle-wipers": toggleWipersSvg,
  "trigger-wipers": triggerWipersSvg,
  "ffb-max-force": {
    increase: ffbMaxForceIncreaseSvg,
    decrease: ffbMaxForceDecreaseSvg,
  },
  "report-latency": reportLatencySvg,
  "dash-page-1": {
    increase: dashPage1IncreaseSvg,
    decrease: dashPage1DecreaseSvg,
  },
  "dash-page-2": {
    increase: dashPage2IncreaseSvg,
    decrease: dashPage2DecreaseSvg,
  },
  "in-lap-mode": inLapModeSvg,
};

/**
 * @internal Exported for testing
 *
 * Mapping from control + direction to global settings keys.
 * Directional controls use composite keys (e.g., "ffb-max-force-increase").
 */
export const COCKPIT_MISC_GLOBAL_KEYS: Record<string, string> = {
  "toggle-wipers": "cockpitMiscToggleWipers",
  "trigger-wipers": "cockpitMiscTriggerWipers",
  "ffb-max-force-increase": "cockpitMiscFfbForceIncrease",
  "ffb-max-force-decrease": "cockpitMiscFfbForceDecrease",
  "report-latency": "cockpitMiscReportLatency",
  "dash-page-1-increase": "cockpitMiscDashPage1Increase",
  "dash-page-1-decrease": "cockpitMiscDashPage1Decrease",
  "dash-page-2-increase": "cockpitMiscDashPage2Increase",
  "dash-page-2-decrease": "cockpitMiscDashPage2Decrease",
  "in-lap-mode": "cockpitMiscInLapMode",
};

const CockpitMiscSettings = CommonSettings.extend({
  control: z
    .enum([
      "toggle-wipers",
      "trigger-wipers",
      "ffb-max-force",
      "report-latency",
      "dash-page-1",
      "dash-page-2",
      "in-lap-mode",
    ])
    .default("toggle-wipers"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type CockpitMiscSettings = z.infer<typeof CockpitMiscSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the cockpit misc action.
 */
export function generateCockpitMiscSvg(settings: CockpitMiscSettings, bindingMissing = false): string {
  const { control, direction } = settings;

  const svgEntry = COCKPIT_MISC_SVGS[control];
  const iconSvg =
    typeof svgEntry === "string" ? svgEntry : (svgEntry?.[direction] ?? COCKPIT_MISC_SVGS["trigger-wipers"]);

  const titleKey = DIRECTIONAL_CONTROLS.has(control) ? `${control}-${direction}` : control;
  const defaultTitle = COCKPIT_MISC_TITLES[titleKey] || "COCKPIT\nMISC";

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
 * Cockpit Misc Action
 * Provides miscellaneous cockpit controls (wipers, FFB force, latency reporting,
 * dash pages, in-lap mode) via keyboard shortcuts.
 */
export const COCKPIT_MISC_UUID = "com.iracedeck.sd.core.cockpit-misc" as const;

export class CockpitMisc extends ConnectionStateAwareAction<CockpitMiscSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<CockpitMiscSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const activeKey = this.resolveGlobalKey(settings.control, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }

    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<CockpitMiscSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const activeKey = this.resolveGlobalKey(settings.control, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<CockpitMiscSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(settings.control, settings.direction);
  }

  override async onDialDown(ev: IDeckDialDownEvent<CockpitMiscSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(settings.control, settings.direction);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<CockpitMiscSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);

    // Non-directional controls have no +/- adjustment — ignore rotation
    if (!DIRECTIONAL_CONTROLS.has(settings.control)) {
      this.logger.debug(`Rotation ignored for ${settings.control}`);

      return;
    }

    // Clockwise (ticks > 0) = increase, Counter-clockwise (ticks < 0) = decrease
    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.executeControl(settings.control, direction);
  }

  private parseSettings(settings: unknown): CockpitMiscSettings {
    const parsed = CockpitMiscSettings.safeParse(settings);

    return parsed.success ? parsed.data : CockpitMiscSettings.parse({});
  }

  private async executeControl(control: CockpitMiscControl, direction: DirectionType): Promise<void> {
    const settingKey = this.resolveGlobalKey(control, direction);

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${control} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  private resolveGlobalKey(control: CockpitMiscControl, direction: DirectionType): string | null {
    if (DIRECTIONAL_CONTROLS.has(control)) {
      const key = `${control}-${direction}`;

      return COCKPIT_MISC_GLOBAL_KEYS[key] ?? null;
    }

    return COCKPIT_MISC_GLOBAL_KEYS[control] ?? null;
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<CockpitMiscSettings> | IDeckDidReceiveSettingsEvent<CockpitMiscSettings>,
    settings: CockpitMiscSettings,
  ): Promise<void> {
    const activeKey = this.resolveGlobalKey(settings.control, settings.direction);
    const svgDataUri = generateCockpitMiscSvg(settings, this.isBindingMissing(activeKey));
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () =>
      generateCockpitMiscSvg(
        settings,
        this.isBindingMissing(this.resolveGlobalKey(settings.control, settings.direction)),
      ),
    );
  }
}
