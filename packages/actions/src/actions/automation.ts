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
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  ICON_BASE_TEMPLATE,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveBorderSettings,
  resolveGraphicSettings,
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
const GRAY = "#888888";

/** Visual state of the automation rule: active/running, inactive, or paused by the engine (disconnected/replay/off-track). */
export type AutomationVisualState = "on" | "off" | "na";

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

function automationStatusBarNA(): string {
  return `
    <rect x="0" y="100" width="144" height="44" fill="${GRAY}"/>
    <text x="72" y="129" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="18" font-weight="bold">AUTO N/A</text>`;
}

// ─── Settings ───────────────────────────────────────────────────────

const booleanFieldOn = z
  .union([z.boolean(), z.string()])
  .transform((val) => val === true || val === "true")
  .default(true);

/** @internal Exported for testing */
export const AutomationSettings = CommonSettings.extend({
  command: z.enum(["tear-off-visor", "pit-limiter", "headlight-flash", "trigger-wipers"]).default("tear-off-visor"),
  trigger: z.enum(["lap", "pit-boundary", "interval"]).default("lap"),
  timesPerLap: z.coerce.number().min(1).max(20).default(1),
  intervalSeconds: z.coerce.number().min(1).max(300).default(5),
  // Default both to true: a fresh pit-limiter rule should toggle on entry and off on exit.
  // Either-off would render the rule a no-op without any visible cue.
  enableOnApproach: booleanFieldOn,
  disableOnExit: booleanFieldOn,
  flashCount: z.coerce.number().min(1).max(10).default(1),
  flashDuration: z.coerce.number().min(100).max(1000).default(200),
});

type AutomationSettings = z.infer<typeof AutomationSettings>;

// ─── Icon Generation ────────────────────────────────────────────────

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI for the automation action. The status bar and border
 * reflect the rule's visual state:
 *   "on"  — rule active and firing (green, AUTO ON)
 *   "off" — rule inactive, user toggled off (red, AUTO OFF)
 *   "na"  — rule active but engine is paused (disconnected/off-track/replay) (gray, AUTO N/A)
 */
export function generateAutomationSvg(settings: AutomationSettings, state: AutomationVisualState): string {
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

  const statusBar =
    state === "on" ? automationStatusBarOn() : state === "na" ? automationStatusBarNA() : automationStatusBarOff();

  let graphicContent = "";

  if (resolvedTitle.showGraphics) {
    const rawGraphic = extractGraphicContent(iconSvg);
    const coloredGraphic = renderIconTemplate(rawGraphic, { ...colors });
    const offsetY = COMMAND_GRAPHIC_OFFSET_Y[command];
    const scale = COMMAND_GRAPHIC_SCALE[command] ?? "";
    const baseGroup = `<g transform="translate(0, ${offsetY})${scale}">${coloredGraphic}</g>`;
    const userScale = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides).scale / 100;

    if (userScale === 1) {
      graphicContent = baseGroup;
    } else {
      // Pivot around the visual center of the content area (above the status bar).
      // Without the translate offsets a bare scale() would also shift the icon toward 0,0.
      graphicContent = `<g transform="translate(72 50) scale(${userScale}) translate(-72 -50)">${baseGroup}</g>`;
    }
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

  const border = resolveBorderSettings(
    AUTOMATION_META_SVG,
    getGlobalBorderSettings(),
    settings.borderOverrides,
    borderColorForState(state),
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

/** @internal Exported for testing */
export function settingsToConfig(settings: AutomationSettings): AutomationRuleConfig {
  return {
    command: settings.command,
    trigger: resolveEffectiveTrigger(settings.command, settings.trigger),
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
  private visibleSettings = new Map<string, AutomationSettings>();
  private engineUnsubscribes = new Map<string, () => void>();

  override async onWillAppear(ev: IDeckWillAppearEvent<AutomationSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.visibleSettings.set(ev.action.id, settings);

    const engine = getAutomationEngine();
    engine.registerRule(ev.action.id, this.buildConfig(settings));

    this.subscribeToEngineState(ev.action.id);
    await this.updateDisplay(ev, settings);
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<AutomationSettings>): Promise<void> {
    // Do NOT deactivate or remove the rule — it persists across page switches.
    // Only tear down this visible instance's display subscription.
    this.unsubscribeFromEngineState(ev.action.id);
    this.visibleSettings.delete(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<AutomationSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.visibleSettings.set(ev.action.id, settings);

    const engine = getAutomationEngine();
    engine.updateRule(ev.action.id, this.buildConfig(settings));

    await this.updateDisplay(ev, settings);
  }

  private subscribeToEngineState(actionId: string): void {
    // Replace any stale subscription for this action id (e.g. PI reopened without willDisappear).
    this.unsubscribeFromEngineState(actionId);

    const unsubscribe = getAutomationEngine().onStateChange(() => {
      void this.refreshDisplay(actionId);
    });

    this.engineUnsubscribes.set(actionId, unsubscribe);
  }

  private unsubscribeFromEngineState(actionId: string): void {
    const unsubscribe = this.engineUnsubscribes.get(actionId);

    if (!unsubscribe) return;

    unsubscribe();
    this.engineUnsubscribes.delete(actionId);
  }

  private computeVisualState(actionId: string): AutomationVisualState {
    const engine = getAutomationEngine();

    // Paused beats both on and off: if the engine can't fire (disconnected / off-track / replay),
    // showing AUTO OFF would be misleading — the button isn't usable regardless of user toggle.
    if (engine.isPaused()) return "na";

    return engine.isRuleActive(actionId) ? "on" : "off";
  }

  private async refreshDisplay(actionId: string): Promise<void> {
    const settings = this.visibleSettings.get(actionId);

    if (!settings) return;

    const svgDataUri = generateAutomationSvg(settings, this.computeVisualState(actionId));
    await this.updateKeyImage(actionId, svgDataUri);
  }

  /** Build the engine config and warn on legacy trigger/command combinations the PI no longer exposes. */
  private buildConfig(settings: AutomationSettings): AutomationRuleConfig {
    const config = settingsToConfig(settings);

    // pit-limiter intentionally always coerces to pit-boundary (by design, PI hides the trigger).
    // The warn is for the inverse case: a non-pit command persisted with pit-boundary
    // (stale settings from when the user previously had pit-limiter selected).
    if (settings.command !== "pit-limiter" && settings.trigger === "pit-boundary") {
      this.logger.warn(
        `Trigger 'pit-boundary' is not valid for command '${settings.command}'; coerced to '${config.trigger}'`,
      );
    }

    return config;
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

    // activateRule/deactivateRule fires the state-change listener which refreshes the icon;
    // still parse+cache the latest settings in case the PI hasn't sent onDidReceiveSettings yet.
    const settings = this.parseSettings(ev.payload.settings);
    this.visibleSettings.set(ev.action.id, settings);
    await this.updateDisplay(ev, settings);
  }

  private parseSettings(settings: unknown): AutomationSettings {
    const parsed = AutomationSettings.safeParse(settings);

    if (parsed.success) return parsed.data;

    this.logger.error(`Invalid automation settings; falling back to defaults: ${parsed.error.message}`);
    this.logger.debug(`Raw settings: ${JSON.stringify(settings)}`);

    return AutomationSettings.parse({});
  }

  private async updateDisplay(
    ev:
      | IDeckWillAppearEvent<AutomationSettings>
      | IDeckDidReceiveSettingsEvent<AutomationSettings>
      | IDeckKeyDownEvent<AutomationSettings>,
    settings: AutomationSettings,
  ): Promise<void> {
    const svgDataUri = generateAutomationSvg(settings, this.computeVisualState(ev.action.id));
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () =>
      generateAutomationSvg(settings, this.computeVisualState(ev.action.id)),
    );
  }
}
