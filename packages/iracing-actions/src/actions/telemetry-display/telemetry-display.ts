import {
  CommonSettings,
  escapeXml,
  generateBorderParts,
  generateTitleText,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalTitleSettings,
  IconUpdateThrottle,
  type IDeckDidReceiveSettingsEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveBorderSettings,
  resolveIconColors,
  resolveTitleSettings,
  resolveTitleTemplate,
  svgToDataUri,
} from "@iracedeck/deck-core";
import { IRacingAction } from "@iracedeck/deck-iracing";
import { resolveTemplate } from "@iracedeck/iracing-sdk";
import z from "zod";

import telemetryDisplayTemplate from "../../../icons/telemetry-display.svg";

/**
 * @internal Exported for testing
 */
export const TelemetryDisplaySettings = CommonSettings.extend({
  template: z.string().default("#{{self.car_number}}\n{{self.first_name}}"),
  title: z.string().default("I AM"),
  fontSize: z.coerce.number().default(15),
});

export type TelemetryDisplaySettings = z.infer<typeof TelemetryDisplaySettings>;

/**
 * @internal Exported for testing
 */
export function generateValueContent(value: string, fontSize: number, textColor: string): string {
  const lines = value.split("\n").filter((line) => line.length > 0);
  const baseY = 88 + (fontSize - 44) / 3;
  const lineHeight = fontSize * 1.2;

  if (lines.length <= 1) {
    const text = lines[0] ?? "";

    return `<text x="72" y="${baseY}" text-anchor="middle" fill="${textColor}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold">${escapeXml(text)}</text>`;
  }

  const totalBlockHeight = (lines.length - 1) * lineHeight;
  const startY = baseY - totalBlockHeight / 2;

  return lines
    .map((line, i) => {
      const y = startY + i * lineHeight;

      return `<text x="72" y="${y}" text-anchor="middle" fill="${textColor}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold">${escapeXml(line)}</text>`;
    })
    .join("\n    ");
}

/**
 * @internal Exported for testing
 */
export function generateTelemetryDisplaySvg(title: string, value: string, settings: TelemetryDisplaySettings): string {
  const colors = resolveIconColors(telemetryDisplayTemplate, getGlobalColors(), settings.colorOverrides);
  const textColor = colors.textColor;

  const valueContent = generateValueContent(value, settings.fontSize * 2, textColor);

  const resolvedTitle = resolveTitleSettings(
    telemetryDisplayTemplate,
    getGlobalTitleSettings(),
    settings.titleOverrides,
    title,
  );

  const titleContent = resolvedTitle.showTitle
    ? generateTitleText({
        text: resolvedTitle.titleText,
        fontSize: resolvedTitle.fontSize,
        bold: resolvedTitle.bold,
        position: resolvedTitle.position,
        customPosition: resolvedTitle.customPosition,
        fill: textColor,
      })
    : "";

  const border = resolveBorderSettings(telemetryDisplayTemplate, getGlobalBorderSettings(), settings.borderOverrides);
  const borderSvg = generateBorderParts(border);

  const svg = renderIconTemplate(telemetryDisplayTemplate, {
    ...colors,
    titleContent,
    borderDefs: borderSvg.defs,
    borderContent: borderSvg.rects,
    valueContent,
  });

  return svgToDataUri(svg);
}

/**
 * Telemetry Display Action
 * Displays live telemetry values on the Stream Deck key using mustache templates.
 *
 * A telemetry tick does no work of its own: it schedules a refresh through the
 * per-key throttle, and the refresh resolves the template, compares the result
 * with the last rendered state and pushes an image only when it changed. Asking
 * for the template context per tick rebuilt the shared context every frame for
 * every templated key, which was most of the plugin's allocation (about 92 MB/s
 * in a 35-car race, #1339).
 */
export const TELEMETRY_DISPLAY_UUID = "com.iracedeck.sd.core.telemetry-display" as const;

export class TelemetryDisplay extends IRacingAction<TelemetryDisplaySettings> {
  private activeContexts = new Map<string, TelemetryDisplaySettings>();
  private lastState = new Map<string, string>();
  /**
   * Caps each key's telemetry refresh at 10 Hz with a trailing-edge coalescer.
   * It first capped `setKeyImage` calls (#493): the SDK delivers up to ~60
   * unique frames per second, and a fast-changing template like RPM would
   * otherwise flood them. Since #1339 it also gates template resolution, so a
   * key asks for a template context at most on the leading and trailing edge
   * of each window rather than on every tick.
   */
  private readonly imageThrottle = new IconUpdateThrottle();

  override async onWillAppear(ev: IDeckWillAppearEvent<TelemetryDisplaySettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    await this.updateDisplay(ev, settings);

    const contextId = ev.action.id;

    this.sdkController.subscribe(contextId, () => {
      // Schedule the whole refresh, template resolution included (#1339): the
      // tick itself never asks for a template context.
      if (this.activeContexts.has(contextId)) {
        this.imageThrottle.schedule(contextId, () => this.refreshFromTelemetry(contextId));
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<TelemetryDisplaySettings>): Promise<void> {
    // Clear pending throttle + per-context state BEFORE awaiting super so a
    // queued trailing flush (up to 100 ms) can't fire and call
    // `updateKeyImage` for a context that's mid-teardown.
    this.imageThrottle.clear(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);

    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<TelemetryDisplaySettings>): Promise<void> {
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
    ev: IDeckWillAppearEvent<TelemetryDisplaySettings> | IDeckDidReceiveSettingsEvent<TelemetryDisplaySettings>,
    settings: TelemetryDisplaySettings,
  ): Promise<void> {
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
    // The title setting is user-entered text, so it resolves {{…}} templates
    // too (issue #899) — including against the empty context when disconnected.
    const title = resolveTitleTemplate(settings.title);

    if (!context) return { title, value: "---" };

    const value = resolveTemplate(settings.template, context);

    return { title, value: value || "---" };
  }

  private buildStateKey(title: string, value: string, settings: TelemetryDisplaySettings): string {
    const co = settings.colorOverrides;
    const bo = settings.borderOverrides;
    const borderKey = `${bo?.enabled ?? ""}|${bo?.borderWidth ?? ""}|${bo?.borderColor ?? ""}|${bo?.glowEnabled ?? ""}|${bo?.glowWidth ?? ""}`;

    return `${title}|${value}|${co?.backgroundColor || ""}|${co?.textColor || ""}|${settings.fontSize}|${borderKey}`;
  }

  /**
   * Throttled refresh for a telemetry tick. Re-reads the key's settings at
   * flush time, so a trailing flush uses the latest settings and a key that has
   * since disappeared renders nothing; resolves the template once, and pushes
   * an image only when the resolved state differs from the last one rendered.
   */
  private async refreshFromTelemetry(contextId: string): Promise<void> {
    const settings = this.activeContexts.get(contextId);

    if (!settings) return;

    const { title, value } = this.resolveDisplay(settings);
    const stateKey = this.buildStateKey(title, value, settings);

    if (this.lastState.get(contextId) === stateKey) return;

    this.lastState.set(contextId, stateKey);

    const svgDataUri = generateTelemetryDisplaySvg(title, value, settings);
    await this.updateKeyImage(contextId, svgDataUri);
  }
}
