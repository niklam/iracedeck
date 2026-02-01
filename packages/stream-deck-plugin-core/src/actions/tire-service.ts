import streamDeck, {
  action,
  DialDownEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  getCommands,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import tireServiceTemplate from "../../icons/tire-service.svg";

const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const RED = "#e74c3c";
const YELLOW = "#f1c40f";
const GRAY = "#888888";

type TireServiceAction =
  | "request-lf"
  | "request-rf"
  | "request-lr"
  | "request-rr"
  | "request-all"
  | "change-compound"
  | "clear-tires";

/**
 * Label configuration for each tire service action (line1 bold, line2 subdued)
 */
const TIRE_SERVICE_LABELS: Record<TireServiceAction, { line1: string; line2: string }> = {
  "request-lf": { line1: "LEFT", line2: "FRONT" },
  "request-rf": { line1: "RIGHT", line2: "FRONT" },
  "request-lr": { line1: "LEFT", line2: "REAR" },
  "request-rr": { line1: "RIGHT", line2: "REAR" },
  "request-all": { line1: "ALL", line2: "TIRES" },
  "change-compound": { line1: "TIRE", line2: "COMPOUND" },
  "clear-tires": { line1: "CLEAR", line2: "TIRES" },
};

/**
 * SVG icon content for each tire service action.
 * Uses a bird's-eye car outline with tire positions to distinguish from fuel service icons.
 */
const TIRE_SERVICE_ICONS: Record<TireServiceAction, string> = {
  // Request Left Front: car body with LF tire highlighted
  "request-lf": `
    <rect x="26" y="12" width="20" height="28" rx="3" fill="none" stroke="${GRAY}" stroke-width="1.2"/>
    <circle cx="23" cy="16" r="4" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="49" cy="16" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="23" cy="36" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="49" cy="36" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>`,

  // Request Right Front: car body with RF tire highlighted
  "request-rf": `
    <rect x="26" y="12" width="20" height="28" rx="3" fill="none" stroke="${GRAY}" stroke-width="1.2"/>
    <circle cx="23" cy="16" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="49" cy="16" r="4" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="23" cy="36" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="49" cy="36" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>`,

  // Request Left Rear: car body with LR tire highlighted
  "request-lr": `
    <rect x="26" y="12" width="20" height="28" rx="3" fill="none" stroke="${GRAY}" stroke-width="1.2"/>
    <circle cx="23" cy="16" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="49" cy="16" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="23" cy="36" r="4" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="49" cy="36" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>`,

  // Request Right Rear: car body with RR tire highlighted
  "request-rr": `
    <rect x="26" y="12" width="20" height="28" rx="3" fill="none" stroke="${GRAY}" stroke-width="1.2"/>
    <circle cx="23" cy="16" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="49" cy="16" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="23" cy="36" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="49" cy="36" r="4" fill="none" stroke="${WHITE}" stroke-width="2"/>`,

  // Request All Tires: car body with all tires highlighted in green
  "request-all": `
    <rect x="26" y="12" width="20" height="28" rx="3" fill="none" stroke="${GRAY}" stroke-width="1.2"/>
    <circle cx="23" cy="16" r="4" fill="none" stroke="${GREEN}" stroke-width="2"/>
    <circle cx="49" cy="16" r="4" fill="none" stroke="${GREEN}" stroke-width="2"/>
    <circle cx="23" cy="36" r="4" fill="none" stroke="${GREEN}" stroke-width="2"/>
    <circle cx="49" cy="36" r="4" fill="none" stroke="${GREEN}" stroke-width="2"/>`,

  // Change Compound: tire circle with swap arrows in yellow
  "change-compound": `
    <circle cx="36" cy="24" r="10" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="24" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <path d="M28 36 L24 40 L28 44" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="24" y1="40" x2="48" y2="40" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>
    <path d="M44 36 L48 32 L44 28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="48" y1="32" x2="24" y2="32" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>`,

  // Clear Tires: tire circle with X overlay in red
  "clear-tires": `
    <circle cx="36" cy="26" r="10" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="26" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="29" y1="19" x2="43" y2="33" stroke="${RED}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="43" y1="19" x2="29" y2="33" stroke="${RED}" stroke-width="2.5" stroke-linecap="round"/>`,
};

const TireServiceSettings = z.object({
  action: z
    .enum([
      "request-lf",
      "request-rf",
      "request-lr",
      "request-rr",
      "request-all",
      "change-compound",
      "clear-tires",
    ])
    .default("request-all"),
});

type TireServiceSettings = z.infer<typeof TireServiceSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the tire service action.
 */
export function generateTireServiceSvg(settings: TireServiceSettings): string {
  const { action: actionType } = settings;

  const iconContent = TIRE_SERVICE_ICONS[actionType] || TIRE_SERVICE_ICONS["request-all"];
  const labels = TIRE_SERVICE_LABELS[actionType] || TIRE_SERVICE_LABELS["request-all"];

  const svg = renderIconTemplate(tireServiceTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Tire Service
 * Provides tire management for pit stops (request tires, change compound, clear)
 * via iRacing SDK commands.
 */
@action({ UUID: "com.iracedeck.sd.core.tire-service" })
export class TireService extends ConnectionStateAwareAction<TireServiceSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("TireService"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<TireServiceSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<TireServiceSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TireServiceSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<TireServiceSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeAction(settings.action);
  }

  override async onDialDown(ev: DialDownEvent<TireServiceSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeAction(settings.action);
  }

  private parseSettings(settings: unknown): TireServiceSettings {
    const parsed = TireServiceSettings.safeParse(settings);

    return parsed.success ? parsed.data : TireServiceSettings.parse({});
  }

  private executeAction(actionType: TireServiceAction): void {
    const pit = getCommands().pit;

    switch (actionType) {
      case "request-lf": {
        const success = pit.leftFront();
        this.logger.info("Request left front tire executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "request-rf": {
        const success = pit.rightFront();
        this.logger.info("Request right front tire executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "request-lr": {
        const success = pit.leftRear();
        this.logger.info("Request left rear tire executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "request-rr": {
        const success = pit.rightRear();
        this.logger.info("Request right rear tire executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "request-all": {
        const success = pit.allTires();
        this.logger.info("Request all tires executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "change-compound": {
        const success = pit.tireCompound(0);
        this.logger.info("Change tire compound executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "clear-tires": {
        const success = pit.clearTires();
        this.logger.info("Clear tires checkbox executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
    }
  }

  private async updateDisplay(
    ev: WillAppearEvent<TireServiceSettings> | DidReceiveSettingsEvent<TireServiceSettings>,
    settings: TireServiceSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateTireServiceSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
