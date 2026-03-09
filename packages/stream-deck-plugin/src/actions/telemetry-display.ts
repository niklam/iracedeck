import streamDeck, { action, DidReceiveSettingsEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { resolveTemplate } from "@iracedeck/iracing-sdk";
import z from "zod";

import sessionInfoTemplate from "../../icons/session-info.svg";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";

const TelemetryDisplaySettings = z.object({
  template: z.string().default("{{telemetry.Speed}}"),
  title: z.string().default("TELEMETRY"),
  backgroundColor: z.string().default("#2a3444"),
  textColor: z.string().default("#ffffff"),
  fontSize: z.coerce.number().default(18),
});

type TelemetryDisplaySettings = z.infer<typeof TelemetryDisplaySettings>;

/**
 * @internal Exported for testing
 */
export function generateTelemetryDisplaySvg(title: string, value: string, settings: TelemetryDisplaySettings): string {
  const svg = renderIconTemplate(sessionInfoTemplate, {
    backgroundColor: settings.backgroundColor,
    titleLabel: title,
    value,
    valueFontSize: String(settings.fontSize),
    valueY: "50",
    textColor: settings.textColor,
  });

  return svgToDataUri(svg);
}

/**
 * Telemetry Display Action
 * Displays live telemetry values on the Stream Deck key using mustache templates.
 */
@action({ UUID: "com.iracedeck.sd.core.telemetry-display" })
export class TelemetryDisplay extends ConnectionStateAwareAction<TelemetryDisplaySettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("TelemetryDisplay"), LogLevel.Info);

  private activeContexts = new Map<string, TelemetryDisplaySettings>();
  private lastState = new Map<string, string>();

  override async onWillAppear(ev: WillAppearEvent<TelemetryDisplaySettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();

      const storedSettings = this.activeContexts.get(ev.action.id);

      if (storedSettings) {
        this.updateDisplayFromTelemetry(ev.action.id, storedSettings);
      }
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<TelemetryDisplaySettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TelemetryDisplaySettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.lastState.delete(ev.action.id);
    await this.updateDisplay(ev, settings);
  }

  private parseSettings(settings: unknown): TelemetryDisplaySettings {
    const parsed = TelemetryDisplaySettings.safeParse(settings);

    return parsed.success ? parsed.data : TelemetryDisplaySettings.parse({});
  }

  private async updateDisplay(
    ev: WillAppearEvent<TelemetryDisplaySettings> | DidReceiveSettingsEvent<TelemetryDisplaySettings>,
    settings: TelemetryDisplaySettings,
  ): Promise<void> {
    this.updateConnectionState();

    const { title, value } = this.resolveDisplay(settings);

    const svgDataUri = generateTelemetryDisplaySvg(title, value, settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);

    const stateKey = this.buildStateKey(title, value, settings);
    this.lastState.set(ev.action.id, stateKey);
  }

  private resolveDisplay(settings: TelemetryDisplaySettings): { title: string; value: string } {
    const context = this.sdkController.getCurrentTemplateContext();

    if (!context) return { title: settings.title, value: "---" };

    const value = resolveTemplate(settings.template, context);

    return { title: settings.title, value: value || "---" };
  }

  private buildStateKey(title: string, value: string, settings: TelemetryDisplaySettings): string {
    return `${title}|${value}|${settings.backgroundColor}|${settings.textColor}|${settings.fontSize}`;
  }

  private async updateDisplayFromTelemetry(contextId: string, settings: TelemetryDisplaySettings): Promise<void> {
    const { title, value } = this.resolveDisplay(settings);
    const stateKey = this.buildStateKey(title, value, settings);
    const lastStateKey = this.lastState.get(contextId);

    if (lastStateKey !== stateKey) {
      this.lastState.set(contextId, stateKey);
      const svgDataUri = generateTelemetryDisplaySvg(title, value, settings);
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }
}
