import streamDeck, { action, DidReceiveSettingsEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { resolveTemplate } from "@iracedeck/iracing-sdk";
import z from "zod";

import telemetryDisplayTemplate from "../../icons/telemetry-display.svg";
import {
  CommonSettings,
  ConnectionStateAwareAction,
  createSDLogger,
  escapeXml,
  getGlobalColors,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";

const TELEMETRY_DISPLAY_DEFAULT_BG = "#2a3444";
const TELEMETRY_DISPLAY_DEFAULT_TEXT = "#ffffff";

const TelemetryDisplaySettings = CommonSettings.extend({
  template: z.string().default("{{sessionInfo.DriverInfo.DriverCarIdx}}"),
  title: z.string().default("CAR #"),
  backgroundColor: z.string().default(TELEMETRY_DISPLAY_DEFAULT_BG),
  textColor: z.string().default(TELEMETRY_DISPLAY_DEFAULT_TEXT),
  fontSize: z.coerce.number().default(18),
});

type TelemetryDisplaySettings = z.infer<typeof TelemetryDisplaySettings>;

/**
 * @internal Exported for testing
 */
export function generateValueContent(value: string, fontSize: number, textColor: string): string {
  const lines = value.split("\n").filter((line) => line.length > 0);
  const baseY = 102 + (fontSize - 44) / 3;
  const lineHeight = fontSize * 1.2;

  if (lines.length <= 1) {
    const text = lines[0] ?? "";

    return `<text x="72" y="${baseY}" text-anchor="middle" dominant-baseline="central" fill="${textColor}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold">${escapeXml(text)}</text>`;
  }

  const totalBlockHeight = (lines.length - 1) * lineHeight;
  const startY = baseY - totalBlockHeight / 2;

  return lines
    .map((line, i) => {
      const y = startY + i * lineHeight;

      return `<text x="72" y="${y}" text-anchor="middle" dominant-baseline="central" fill="${textColor}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold">${escapeXml(line)}</text>`;
    })
    .join("\n    ");
}

/**
 * @internal Exported for testing
 */
export function generateTelemetryDisplaySvg(title: string, value: string, settings: TelemetryDisplaySettings): string {
  const globalColors = getGlobalColors();

  // Use per-action color if user changed it from default, otherwise fall through to global → default
  const bgColor =
    settings.backgroundColor !== TELEMETRY_DISPLAY_DEFAULT_BG
      ? settings.backgroundColor
      : globalColors.backgroundColor || TELEMETRY_DISPLAY_DEFAULT_BG;
  const txtColor =
    settings.textColor !== TELEMETRY_DISPLAY_DEFAULT_TEXT
      ? settings.textColor
      : globalColors.textColor || TELEMETRY_DISPLAY_DEFAULT_TEXT;

  const valueContent = generateValueContent(value, settings.fontSize * 2, txtColor);

  const svg = renderIconTemplate(telemetryDisplayTemplate, {
    backgroundColor: bgColor,
    titleColor: txtColor,
    titleLabel: title,
    valueContent,
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
    await super.onWillAppear(ev);
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
    await super.onDidReceiveSettings(ev);
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
    this.setRegenerateCallback(ev.action.id, () => {
      const display = this.resolveDisplay(settings);

      return generateTelemetryDisplaySvg(display.title, display.value, settings);
    });

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
