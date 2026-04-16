import {
  type AutomationCommand,
  type AutomationRuleConfig,
  CommonSettings,
  ConnectionStateAwareAction,
  extractGraphicContent,
  generateBorderParts,
  generateTitleText,
  getAutomationEngine,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalTitleSettings,
  ICON_BASE_TEMPLATE,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveBorderSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
} from "@iracedeck/deck-core";
import headlightFlashIcon from "@iracedeck/icons/car-control/headlight-flash.svg";
import tearOffVisorIcon from "@iracedeck/icons/car-control/tear-off-visor.svg";
import triggerWipersIcon from "@iracedeck/icons/cockpit-misc/trigger-wipers.svg";
import z from "zod";

import { borderColorForState } from "../icons/status-bar.js";

// ─── Constants ──────────────────────────────────────────────────────

const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const RED = "#e74c3c";

/**
 * @internal Exported for testing
 *
 * Inline pit limiter graphic — speed limit sign circle with "PIT" text.
 */
export const PIT_LIMITER_GRAPHIC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <desc>{"colors":{"backgroundColor":"#2a3444","graphic1Color":"#ffffff"}}</desc>
  <circle cx="72" cy="52" r="30" fill="none" stroke="{{graphic1Color}}" stroke-width="5"/>
  <text x="72" y="62" text-anchor="middle" dominant-baseline="central"
        fill="{{graphic1Color}}" font-family="Arial, sans-serif" font-size="28" font-weight="bold">PIT</text>
</svg>`;

/** @internal Exported for testing */
export const COMMAND_ICONS: Record<AutomationCommand, string> = {
  "tear-off-visor": tearOffVisorIcon,
  "pit-limiter": PIT_LIMITER_GRAPHIC,
  "headlight-flash": headlightFlashIcon,
  "trigger-wipers": triggerWipersIcon,
};

/** @internal Exported for testing */
export const COMMAND_TITLES: Record<AutomationCommand, string> = {
  "tear-off-visor": "VISOR",
  "pit-limiter": "LIMITER",
  "headlight-flash": "FLASH",
  "trigger-wipers": "WIPERS",
};

/** Per-command vertical offset (px) for the graphic inside the icon */
const COMMAND_GRAPHIC_OFFSET_Y: Record<AutomationCommand, number> = {
  "tear-off-visor": 13,
  "pit-limiter": 10,
  "headlight-flash": 18,
  "trigger-wipers": 15,
};

/** Per-command scale transform (empty string = no scaling) */
const COMMAND_GRAPHIC_SCALE: Record<AutomationCommand, string> = {
  "tear-off-visor": "",
  "pit-limiter": " scale(0.85) translate(8, 8)",
  "headlight-flash": "",
  "trigger-wipers": "",
};

/**
 * Resolves the effective trigger for a command.
 * Pit limiter always uses pit-boundary; others use the user-selected trigger.
 * @internal Exported for testing
 */
export function resolveEffectiveTrigger(
  command: AutomationCommand,
  trigger: "lap" | "pit-boundary" | "interval",
): "lap" | "pit-boundary" | "interval" {
  if (command === "pit-limiter") return "pit-boundary";

  if (trigger === "pit-boundary") return "lap"; // Fallback: non-pit commands can't use pit-boundary

  return trigger;
}

/**
 * Meta SVG with <desc> color metadata and locked title settings for the automation action.
 * Title is locked to top position with fixed font size to leave room for the command icon and status bar.
 * @internal Exported for testing
 */
export const AUTOMATION_META_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <desc>{"colors":{"backgroundColor":"#2a3444","textColor":"#ffffff","graphic1Color":"#ffffff"},"title":{"position":"top","fontSize":9,"showTitle":true,"showGraphics":true,"locked":["position","fontSize","showTitle","showGraphics"]}}</desc>
</svg>`;

// ─── Status Bar ─────────────────────────────────────────────────────

function automationStatusBarOn(): string {
  return `
    <rect x="0" y="100" width="144" height="44" fill="${GREEN}"/>
    <text x="72" y="129" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="18" font-weight="bold">AUTO ON</text>`;
}

function automationStatusBarOff(): string {
  return `
    <rect x="0" y="100" width="144" height="44" fill="${RED}"/>
    <text x="72" y="129" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="18" font-weight="bold">AUTO OFF</text>`;
}

// ─── Settings ───────────────────────────────────────────────────────

const booleanField = z
  .union([z.boolean(), z.string()])
  .transform((val) => val === true || val === "true")
  .default(false);

/** @internal Exported for testing */
export const AutomationSettings = CommonSettings.extend({
  command: z.enum(["tear-off-visor", "pit-limiter", "headlight-flash", "trigger-wipers"]).default("tear-off-visor"),
  trigger: z.enum(["lap", "pit-boundary", "interval"]).default("lap"),
  timesPerLap: z.coerce.number().min(1).max(20).default(1),
  intervalSeconds: z.coerce.number().min(1).max(300).default(5),
  enableOnApproach: booleanField,
  disableOnExit: booleanField,
  flashCount: z.coerce.number().min(1).max(10).default(1),
  flashDuration: z.coerce.number().min(100).max(1000).default(200),
});

type AutomationSettings = z.infer<typeof AutomationSettings>;

// ─── Icon Generation ────────────────────────────────────────────────

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI for the automation action.
 */
export function generateAutomationSvg(settings: AutomationSettings, active: boolean): string {
  const command = settings.command;
  const iconSvg = COMMAND_ICONS[command];
  const defaultTitle = COMMAND_TITLES[command];

  const colors = resolveIconColors(AUTOMATION_META_SVG, getGlobalColors(), settings.colorOverrides) as Record<
    string,
    string
  >;
  const resolvedTitle = resolveTitleSettings(
    AUTOMATION_META_SVG,
    getGlobalTitleSettings(),
    settings.titleOverrides,
    defaultTitle,
  );

  // Status bar (AUTO ON / AUTO OFF) at the bottom — always visible
  const statusBar = active ? automationStatusBarOn() : automationStatusBarOff();

  // Extract the command icon artwork (strip <svg> wrapper, <desc>, background, labels)
  // then apply color variables and position in the content area between title and status bar
  let graphicContent = "";

  if (resolvedTitle.showGraphics) {
    const rawGraphic = extractGraphicContent(iconSvg);
    const coloredGraphic = renderIconTemplate(rawGraphic, { ...colors });
    const offsetY = COMMAND_GRAPHIC_OFFSET_Y[command];
    const scale = COMMAND_GRAPHIC_SCALE[command] ?? "";
    graphicContent = `<g transform="translate(0, ${offsetY})${scale}">${coloredGraphic}</g>`;
  }

  graphicContent += statusBar;

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

  const toggleState: "on" | "off" = active ? "on" : "off";
  const border = resolveBorderSettings(
    AUTOMATION_META_SVG,
    getGlobalBorderSettings(),
    settings.borderOverrides,
    borderColorForState(toggleState),
  );
  const borderSvg = generateBorderParts(border);
  const borderContent = borderSvg.defs + borderSvg.rects;

  const svg = renderIconTemplate(ICON_BASE_TEMPLATE, {
    backgroundColor: colors.backgroundColor ?? "#2a3444",
    graphicContent,
    titleContent,
    borderContent,
  });

  return svgToDataUri(svg);
}

// ─── Action ─────────────────────────────────────────────────────────

function settingsToConfig(settings: AutomationSettings): AutomationRuleConfig {
  const effectiveTrigger = resolveEffectiveTrigger(settings.command, settings.trigger);

  return {
    command: settings.command,
    trigger: effectiveTrigger,
    timesPerLap: settings.timesPerLap,
    intervalSeconds: settings.intervalSeconds,
    enableOnApproach: settings.enableOnApproach,
    disableOnExit: settings.disableOnExit,
    flashCount: settings.flashCount,
    flashDuration: settings.flashDuration,
  };
}

export const AUTOMATION_UUID = "com.iracedeck.sd.core.automation" as const;

export class Automation extends ConnectionStateAwareAction<AutomationSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<AutomationSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);

    const engine = getAutomationEngine();
    engine.registerRule(ev.action.id, settingsToConfig(settings));

    await this.updateDisplay(ev, settings);
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<AutomationSettings>): Promise<void> {
    // Do NOT deactivate or remove the rule — it persists across page switches
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<AutomationSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);

    const engine = getAutomationEngine();
    engine.updateRule(ev.action.id, settingsToConfig(settings));

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<AutomationSettings>): Promise<void> {
    this.logger.info("Key down received");
    const engine = getAutomationEngine();
    const isActive = engine.isRuleActive(ev.action.id);

    if (isActive) {
      engine.deactivateRule(ev.action.id);
      this.logger.info("Automation deactivated");
    } else {
      engine.activateRule(ev.action.id);
      this.logger.info("Automation activated");
    }

    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  private parseSettings(settings: unknown): AutomationSettings {
    const parsed = AutomationSettings.safeParse(settings);

    return parsed.success ? parsed.data : AutomationSettings.parse({});
  }

  private async updateDisplay(
    ev:
      | IDeckWillAppearEvent<AutomationSettings>
      | IDeckDidReceiveSettingsEvent<AutomationSettings>
      | IDeckKeyDownEvent<AutomationSettings>,
    settings: AutomationSettings,
  ): Promise<void> {
    const engine = getAutomationEngine();
    const active = engine.isRuleActive(ev.action.id);
    const svgDataUri = generateAutomationSvg(settings, active);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => {
      const currentActive = engine.isRuleActive(ev.action.id);

      return generateAutomationSvg(settings, currentActive);
    });
  }
}
