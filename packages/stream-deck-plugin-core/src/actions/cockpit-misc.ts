import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  getGlobalSettings,
  getKeyboard,
  type KeyBindingValue,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  LogLevel,
  parseKeyBinding,
  renderIconTemplate,
  svgToDataUri,
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import cockpitMiscTemplate from "../../icons/cockpit-misc.svg";

const WHITE = "#ffffff";
const GRAY = "#888888";
const YELLOW = "#f1c40f";
const GREEN = "#2ecc71";

type CockpitMiscControl =
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
 * Standard layout: line1 = primary (bold, top), line2 = secondary (subdued, bottom).
 */
const COCKPIT_MISC_LABELS: Record<
  CockpitMiscControl,
  Record<DirectionType, { line1: string; line2: string }> | { line1: string; line2: string }
> = {
  "trigger-wipers": { line1: "WIPERS", line2: "TRIGGER" },
  "ffb-max-force": {
    increase: { line1: "FFB FORCE", line2: "INCREASE" },
    decrease: { line1: "FFB FORCE", line2: "DECREASE" },
  },
  "report-latency": { line1: "LATENCY", line2: "REPORT" },
  "dash-page-1": {
    increase: { line1: "DASH PG 1", line2: "NEXT" },
    decrease: { line1: "DASH PG 1", line2: "PREVIOUS" },
  },
  "dash-page-2": {
    increase: { line1: "DASH PG 2", line2: "NEXT" },
    decrease: { line1: "DASH PG 2", line2: "PREVIOUS" },
  },
  "in-lap-mode": { line1: "IN LAP", line2: "MODE" },
};

/**
 * SVG icon content for each control.
 * Non-directional controls have a single icon; directional controls have per-direction variants.
 */
const COCKPIT_MISC_ICONS: Record<CockpitMiscControl, Record<DirectionType, string> | string> = {
  // Trigger Wipers: Windshield wiper arc with blade
  "trigger-wipers": `
    <path d="M16 34 A22 22 0 0 1 56 34" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <line x1="36" y1="34" x2="22" y2="14" stroke="${WHITE}" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="36" cy="34" r="2.5" fill="${WHITE}"/>
    <path d="M22 14 A20 20 0 0 1 44 12" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="3,2"/>`,

  // FFB Max Force: Steering wheel with directional arrow
  "ffb-max-force": {
    increase: `
    <circle cx="36" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="36" cy="24" r="4" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <line x1="36" y1="20" x2="36" y2="12" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="32" y1="26" x2="24" y2="28" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="40" y1="26" x2="48" y2="28" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="52,22 56,16 60,22" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="36" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="36" cy="24" r="4" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <line x1="36" y1="20" x2="36" y2="12" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="32" y1="26" x2="24" y2="28" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="40" y1="26" x2="48" y2="28" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="52,16 56,22 60,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Report Latency: Signal bars / network icon
  "report-latency": `
    <rect x="20" y="30" width="6" height="6" rx="1" fill="${GRAY}"/>
    <rect x="29" y="24" width="6" height="12" rx="1" fill="${GRAY}"/>
    <rect x="38" y="18" width="6" height="18" rx="1" fill="${WHITE}"/>
    <rect x="47" y="12" width="6" height="24" rx="1" fill="${WHITE}"/>`,

  // Dash Page 1: Dashboard rectangle with "1"
  "dash-page-1": {
    increase: `
    <rect x="16" y="12" width="40" height="24" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <text x="36" y="26" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="14" font-weight="bold">1</text>
    <polyline points="53,30 58,24 53,18" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="16" y="12" width="40" height="24" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <text x="36" y="26" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="14" font-weight="bold">1</text>
    <polyline points="19,18 14,24 19,30" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Dash Page 2: Dashboard rectangle with "2"
  "dash-page-2": {
    increase: `
    <rect x="16" y="12" width="40" height="24" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <text x="36" y="26" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="14" font-weight="bold">2</text>
    <polyline points="53,30 58,24 53,18" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="16" y="12" width="40" height="24" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <text x="36" y="26" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="14" font-weight="bold">2</text>
    <polyline points="19,18 14,24 19,30" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // In Lap Mode: Pit lane entry arrow
  "in-lap-mode": `
    <rect x="14" y="16" width="44" height="20" rx="3" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <line x1="36" y1="16" x2="36" y2="36" stroke="${GRAY}" stroke-width="0.5"/>
    <path d="M24 32 L24 22 L34 22" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="30,19 34,22 30,25" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="46" y="27" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="7" font-weight="bold">IN</text>`,
};

/**
 * @internal Exported for testing
 *
 * Mapping from control + direction to global settings keys.
 * Directional controls use composite keys (e.g., "ffb-max-force-increase").
 */
export const COCKPIT_MISC_GLOBAL_KEYS: Record<string, string> = {
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

const CockpitMiscSettings = z.object({
  control: z
    .enum(["trigger-wipers", "ffb-max-force", "report-latency", "dash-page-1", "dash-page-2", "in-lap-mode"])
    .default("trigger-wipers"),
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

  const iconEntry = COCKPIT_MISC_ICONS[control];
  const iconContent =
    typeof iconEntry === "string" ? iconEntry : (iconEntry?.[direction] ?? COCKPIT_MISC_ICONS["trigger-wipers"]);

  const labelEntry = COCKPIT_MISC_LABELS[control];
  const labels: { line1: string; line2: string } =
    "line1" in labelEntry ? labelEntry : (labelEntry[direction] ?? { line1: "COCKPIT", line2: "MISC" });

  const svg = renderIconTemplate(cockpitMiscTemplate, {
    iconContent: iconContent as string,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Cockpit Misc Action
 * Provides miscellaneous cockpit controls (wipers, FFB force, latency reporting,
 * dash pages, in-lap mode) via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.cockpit-misc" })
export class CockpitMisc extends ConnectionStateAwareAction<CockpitMiscSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("CockpitMisc"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<CockpitMiscSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<CockpitMiscSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CockpitMiscSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<CockpitMiscSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(settings.control, settings.direction);
  }

  override async onDialDown(ev: DialDownEvent<CockpitMiscSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(settings.control, settings.direction);
  }

  override async onDialRotate(ev: DialRotateEvent<CockpitMiscSettings>): Promise<void> {
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
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

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
    ev: WillAppearEvent<CockpitMiscSettings> | DidReceiveSettingsEvent<CockpitMiscSettings>,
    settings: CockpitMiscSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateCockpitMiscSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
