import {
  CommonSettings,
  ConnectionStateAwareAction,
  formatKeyBinding,
  getGlobalColors,
  getGlobalSettings,
  getKeyboard,
  getSimHub,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  isSimHubBinding,
  isSimHubInitialized,
  type KeyBindingValue,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  parseBinding,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
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
 * Label configuration for each control + direction combination.
 * Standard layout: mainLabel = prominent (bold, bottom), subLabel = category/context (subdued, top).
 */
const COCKPIT_MISC_LABELS: Record<
  CockpitMiscControl,
  Record<DirectionType, { mainLabel: string; subLabel: string }> | { mainLabel: string; subLabel: string }
> = {
  "toggle-wipers": { mainLabel: "WIPERS", subLabel: "TOGGLE" },
  "trigger-wipers": { mainLabel: "WIPERS", subLabel: "TRIGGER" },
  "ffb-max-force": {
    increase: { mainLabel: "FFB FORCE", subLabel: "INCREASE" },
    decrease: { mainLabel: "FFB FORCE", subLabel: "DECREASE" },
  },
  "report-latency": { mainLabel: "LATENCY", subLabel: "REPORT" },
  "dash-page-1": {
    increase: { mainLabel: "DASH PG 1", subLabel: "NEXT" },
    decrease: { mainLabel: "DASH PG 1", subLabel: "PREVIOUS" },
  },
  "dash-page-2": {
    increase: { mainLabel: "DASH PG 2", subLabel: "NEXT" },
    decrease: { mainLabel: "DASH PG 2", subLabel: "PREVIOUS" },
  },
  "in-lap-mode": { mainLabel: "IN LAP", subLabel: "MODE" },
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
export function generateCockpitMiscSvg(settings: CockpitMiscSettings): string {
  const { control, direction } = settings;

  const svgEntry = COCKPIT_MISC_SVGS[control];
  const iconSvg =
    typeof svgEntry === "string" ? svgEntry : (svgEntry?.[direction] ?? COCKPIT_MISC_SVGS["trigger-wipers"]);

  const labelEntry = COCKPIT_MISC_LABELS[control];
  const labels: { mainLabel: string; subLabel: string } =
    "mainLabel" in labelEntry ? labelEntry : (labelEntry[direction] ?? { mainLabel: "COCKPIT", subLabel: "MISC" });

  const colors = resolveIconColors(iconSvg as string, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg as string, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
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
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<CockpitMiscSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<CockpitMiscSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
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
    this.logger.info("Control executed");
    this.logger.debug(`Executing ${control} ${direction}`);

    const settingKey = this.resolveGlobalKey(control, direction);

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${control} ${direction}`);

      return;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseBinding(globalSettings[settingKey]);

    if (!binding) {
      this.logger.warn(`No binding configured for ${settingKey}`);

      return;
    }

    if (isSimHubBinding(binding)) {
      this.logger.info("Triggering SimHub role");
      this.logger.debug(`SimHub role: ${binding.role}`);

      if (isSimHubInitialized()) {
        const simHub = getSimHub();
        await simHub.startRole(binding.role);
        await simHub.stopRole(binding.role);
      } else {
        this.logger.warn("SimHub service not initialized");
      }

      return;
    }

    this.logger.debug(`Key binding for ${settingKey}: ${formatKeyBinding(binding)} (code=${binding.code ?? "none"})`);

    await this.sendKeyBinding(binding);
  }

  private resolveGlobalKey(control: CockpitMiscControl, direction: DirectionType): string | null {
    if (DIRECTIONAL_CONTROLS.has(control)) {
      const key = `${control}-${direction}`;

      return COCKPIT_MISC_GLOBAL_KEYS[key] ?? null;
    }

    return COCKPIT_MISC_GLOBAL_KEYS[control] ?? null;
  }

  private async sendKeyBinding(binding: KeyBindingValue): Promise<void> {
    const combination: KeyCombination = {
      key: binding.key as KeyboardKey,
      modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
      code: binding.code,
    };

    const success = await getKeyboard().sendKeyCombination(combination);

    if (success) {
      this.logger.info("Key sent successfully");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to send key");
      this.logger.debug(`Failed key combination: ${formatKeyBinding(binding)}`);
    }
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<CockpitMiscSettings> | IDeckDidReceiveSettingsEvent<CockpitMiscSettings>,
    settings: CockpitMiscSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateCockpitMiscSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateCockpitMiscSvg(settings));
  }
}
