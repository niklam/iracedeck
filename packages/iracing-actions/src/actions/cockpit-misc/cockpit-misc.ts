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
import dashPage1DecreaseSvg from "@iracedeck/icons/cockpit-misc/dash-page-1-decrease.svg";
import dashPage1IncreaseSvg from "@iracedeck/icons/cockpit-misc/dash-page-1-increase.svg";
import dashPage2DecreaseSvg from "@iracedeck/icons/cockpit-misc/dash-page-2-decrease.svg";
import dashPage2IncreaseSvg from "@iracedeck/icons/cockpit-misc/dash-page-2-increase.svg";
import inLapModeSvg from "@iracedeck/icons/cockpit-misc/in-lap-mode.svg";
import reportLatencySvg from "@iracedeck/icons/cockpit-misc/report-latency.svg";
import toggleWipersSvg from "@iracedeck/icons/cockpit-misc/toggle-wipers.svg";
import triggerWipersSvg from "@iracedeck/icons/cockpit-misc/trigger-wipers.svg";
// ffb-max-force is a hidden legacy alias of Force Feedback's ffb-force mode (#827) —
// it shares that mode's bindings and now its icons too.
import ffbMaxForceDecreaseSvg from "@iracedeck/icons/force-feedback/ffb-force-decrease.svg";
import ffbMaxForceIncreaseSvg from "@iracedeck/icons/force-feedback/ffb-force-increase.svg";
import z from "zod";

import { CockpitMiscDialSurface, DialSettings, seedDialFromLegacySetting } from "./cockpit-misc-dial-surface.js";

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

/**
 * @internal Exported for testing
 */
export const CockpitMiscSettings = CommonSettings.extend({
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
  // Dial-surface settings (#805), under the `dial` root so keypad and dial keys
  // can't collide. catch: dial garbage degrades to dial defaults instead of
  // failing the whole parse (which would reset a keypad instance).
  dial: DialSettings.catch(() => DialSettings.parse({})),
});

export type CockpitMiscSettings = z.infer<typeof CockpitMiscSettings>;

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
  /**
   * The dial half of the action; all IDeck dial events route here (#805). No
   * `setActiveBinding` is delegated — it would bleed onto the keypad buttons.
   */
  private readonly dialSurface = new CockpitMiscDialSurface({
    logger: this.logger,
    getTelemetry: () => this.sdkController.getCurrentTelemetry(),
    tapBinding: (settingKey) => this.tapBinding(settingKey),
    isBindingMissing: (keys) => this.isBindingMissing(keys),
  });

  /** Keeps the dial strips' #612 missing-binding warning live while iRacing is offline (#805). */
  private readonly unsubscribeGlobalSettings = onGlobalSettingsChange(() => this.dialSurface.refreshAll());

  override async onWillAppear(ev: IDeckWillAppearEvent<CockpitMiscSettings>): Promise<void> {
    await super.onWillAppear(ev);
    let settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      // #805 dial migration: a pre-dial-surface encoder placement drove the flat
      // keypad `control` — carry a valid dash-page value over to `dial.setting`.
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

    const activeKey = this.resolveGlobalKey(settings.control, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }

    await this.updateDisplay(ev, settings);
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<CockpitMiscSettings>): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.dialSurface.willDisappear(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<CockpitMiscSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      await this.dialSurface.didReceiveSettings(ev.action, settings.dial);

      return;
    }

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

  override async onDialRotate(ev: IDeckDialRotateEvent<CockpitMiscSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.rotate(ev.action, settings.dial, ev.payload.ticks, ev.payload.pressed === true);
  }

  override async onDialDown(ev: IDeckDialDownEvent<CockpitMiscSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.down(ev.action, settings.dial);
  }

  override async onDialUp(ev: IDeckDialUpEvent<CockpitMiscSettings>): Promise<void> {
    await this.dialSurface.up(ev.action.id);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<CockpitMiscSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.touchTap(ev.action, settings.dial, ev.payload.hold === true);
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
