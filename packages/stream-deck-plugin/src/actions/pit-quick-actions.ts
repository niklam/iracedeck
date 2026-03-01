import streamDeck, {
  action,
  DialDownEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import z from "zod";

import pitQuickActionsTemplate from "../../icons/pit-quick-actions.svg";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  getCommands,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";

const WHITE = "#ffffff";
const RED = "#e74c3c";
const GRAY = "#888888";

type PitQuickActionType = "clear-all-checkboxes" | "windshield-tearoff" | "request-fast-repair";

/**
 * Label configuration for each pit quick action (line1 bold, line2 subdued)
 */
const PIT_QUICK_ACTION_LABELS: Record<PitQuickActionType, { line1: string; line2: string }> = {
  "clear-all-checkboxes": { line1: "CLEAR ALL", line2: "PIT" },
  "windshield-tearoff": { line1: "WINDSHIELD", line2: "TEAROFF" },
  "request-fast-repair": { line1: "FAST", line2: "REPAIR" },
};

/**
 * SVG icon content for each pit quick action
 */
const PIT_QUICK_ACTION_ICONS: Record<PitQuickActionType, string> = {
  // Clear All Checkboxes: Checklist with checkmarks and X overlay
  "clear-all-checkboxes": `
    <rect x="22" y="10" width="12" height="10" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polyline points="25,15 27,18 31,12" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="22" y="24" width="12" height="10" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polyline points="25,29 27,32 31,26" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="38" y1="15" x2="50" y2="15" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="38" y1="29" x2="50" y2="29" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="40" y1="20" x2="52" y2="32" stroke="${RED}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="52" y1="20" x2="40" y2="32" stroke="${RED}" stroke-width="2.5" stroke-linecap="round"/>`,

  // Windshield Tearoff: Windshield shape with peel-away arrow
  "windshield-tearoff": `
    <path d="M18 30 Q36 8 54 30" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="26" y1="22" x2="46" y2="22" stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>
    <path d="M46 18 L54 10" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="50,10 54,10 54,14" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M20 32 Q36 14 52 32" fill="none" stroke="${GRAY}" stroke-width="1" stroke-dasharray="3,2" stroke-linecap="round"/>`,

  // Request Fast Repair: Wrench icon
  "request-fast-repair": `
    <path d="M24 34 L38 20" stroke="${WHITE}" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M38 20 A6 6 0 1 1 46 14" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <path d="M46 14 L50 10" stroke="${WHITE}" stroke-width="2.5" stroke-linecap="round"/>
    <rect x="20" y="34" width="8" height="4" rx="1" fill="${WHITE}" transform="rotate(-45 24 36)"/>`,
};

const PitQuickActionsSettings = z.object({
  action: z.enum(["clear-all-checkboxes", "windshield-tearoff", "request-fast-repair"]).default("clear-all-checkboxes"),
});

type PitQuickActionsSettings = z.infer<typeof PitQuickActionsSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the pit quick actions action.
 */
export function generatePitQuickActionsSvg(settings: PitQuickActionsSettings): string {
  const { action: actionType } = settings;

  const iconContent = PIT_QUICK_ACTION_ICONS[actionType] || PIT_QUICK_ACTION_ICONS["clear-all-checkboxes"];
  const labels = PIT_QUICK_ACTION_LABELS[actionType] || PIT_QUICK_ACTION_LABELS["clear-all-checkboxes"];

  const svg = renderIconTemplate(pitQuickActionsTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Pit Quick Actions
 * Provides quick pit stop toggles (clear all, windshield tearoff, fast repair)
 * via iRacing SDK commands.
 */
@action({ UUID: "com.iracedeck.sd.core.pit-quick-actions" })
export class PitQuickActions extends ConnectionStateAwareAction<PitQuickActionsSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("PitQuickActions"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<PitQuickActionsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<PitQuickActionsSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<PitQuickActionsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<PitQuickActionsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeAction(settings.action);
  }

  override async onDialDown(ev: DialDownEvent<PitQuickActionsSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeAction(settings.action);
  }

  private parseSettings(settings: unknown): PitQuickActionsSettings {
    const parsed = PitQuickActionsSettings.safeParse(settings);

    return parsed.success ? parsed.data : PitQuickActionsSettings.parse({});
  }

  private executeAction(actionType: PitQuickActionType): void {
    const pit = getCommands().pit;

    switch (actionType) {
      case "clear-all-checkboxes": {
        const success = pit.clear();
        this.logger.info("Clear all pit checkboxes executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "windshield-tearoff": {
        const success = pit.windshield();
        this.logger.info("Windshield tearoff executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "request-fast-repair": {
        const success = pit.fastRepair();
        this.logger.info("Fast repair executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
    }
  }

  private async updateDisplay(
    ev: WillAppearEvent<PitQuickActionsSettings> | DidReceiveSettingsEvent<PitQuickActionsSettings>,
    settings: PitQuickActionsSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generatePitQuickActionsSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
