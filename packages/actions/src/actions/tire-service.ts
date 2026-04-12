import {
  applyGraphicTransform,
  assembleIcon,
  CommonSettings,
  computeGraphicArea,
  ConnectionStateAwareAction,
  extractGraphicContent,
  generateBorderParts,
  generateIconText,
  generateTitleText,
  getCommands,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  getSDK,
  ICON_BASE_TEMPLATE,
  type IDeckDialDownEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  migrateLegacyActionToMode,
  parseIconArtworkBounds,
  renderIconTemplate,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
} from "@iracedeck/deck-core";
import changeAllTiresIconSvg from "@iracedeck/icons/tire-service/change-all-tires.svg";
import clearTiresIconSvg from "@iracedeck/icons/tire-service/clear-tires.svg";
import toggleTiresCarSvg from "@iracedeck/icons/tire-service/toggle-tires.svg";
import { hasFlag, PitSvFlags, TelemetryData } from "@iracedeck/iracing-sdk";
import { lt } from "semver";
import z from "zod";

import tireServiceTemplate from "../../icons/tire-service.svg";

const GRAY = "#888888";
const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const YELLOW = "#f1c40f";
const RED = "#e74c3c";
const BLUE = "#3498db";

/** F1-style compound color mapping */
const COMPOUND_COLORS: Record<string, string> = {
  hard: WHITE,
  medium: YELLOW,
  soft: RED,
  intermediate: GREEN,
  wet: BLUE,
};

const DEFAULT_TIRES: DriverTire[] = [{ TireIndex: 0, TireCompoundType: "Dry" }];

type DriverTire = { TireIndex: number; TireCompoundType: string };

const TireCode = z.enum(["lf", "rf", "lr", "rr"]);

/** Version threshold: instances added before this default to "toggle" mode */
const TOGGLE_MODE_INTRODUCED = "1.13.0";

const TireServiceSettings = CommonSettings.extend({
  mode: z.enum(["change-all-tires", "clear-tires", "toggle-tires", "change-compound"]).default("change-all-tires"),
  toggleMode: z.enum(["select", "toggle"]).optional(),
  tires: z
    .array(TireCode)
    .default(["lf", "rf", "lr", "rr"])
    .transform((arr) => [...new Set(arr)]),
  // Legacy boolean fields — kept for backward-compatible migration only
  lf: z.coerce.boolean().optional(),
  rf: z.coerce.boolean().optional(),
  lr: z.coerce.boolean().optional(),
  rr: z.coerce.boolean().optional(),
});

type TireServiceSettings = z.infer<typeof TireServiceSettings>;

/**
 * @internal Exported for testing
 *
 * Resolve the effective toggle mode. If the user has explicitly set it, use that.
 * Otherwise, default based on when the action was added:
 *   - Added before TOGGLE_MODE_INTRODUCED → "toggle" (legacy behavior)
 *   - Added at or after → "select" (clear-first behavior)
 */
export function resolveToggleMode(settings: TireServiceSettings): "select" | "toggle" {
  if (settings.toggleMode) return settings.toggleMode;

  return lt(settings.addedWithVersion, TOGGLE_MODE_INTRODUCED) ? "toggle" : "select";
}

/**
 * @internal Exported for testing
 *
 * Migrates legacy boolean tire settings (lf/rf/lr/rr) to the new tires array,
 * and renames the legacy `action` field to `mode`. Tires migration only runs
 * when the tires key is absent from the raw settings and legacy booleans are present.
 */
export function migrateTireSettings(raw: unknown): TireServiceSettings {
  const { migrated: rawWithMode } = migrateLegacyActionToMode(raw);
  const parsed = TireServiceSettings.safeParse(rawWithMode);
  const data = parsed.success ? parsed.data : TireServiceSettings.parse({});

  if (!raw || typeof raw !== "object") return data;

  const rawRecord = raw as Record<string, unknown>;

  if (rawRecord.tires !== undefined) {
    return data;
  }

  const hasLegacy =
    rawRecord.lf !== undefined ||
    rawRecord.rf !== undefined ||
    rawRecord.lr !== undefined ||
    rawRecord.rr !== undefined;

  if (hasLegacy) {
    const migrated: Array<"lf" | "rf" | "lr" | "rr"> = [];

    if (data.lf !== false) migrated.push("lf");

    if (data.rf !== false) migrated.push("rf");

    if (data.lr !== false) migrated.push("lr");

    if (data.rr !== false) migrated.push("rr");

    return { ...data, tires: migrated };
  }

  return data;
}

/**
 * @internal Exported for testing
 *
 * Returns whether a tire position is selected in the tires array.
 */
export function isTireSelected(settings: TireServiceSettings, tire: "lf" | "rf" | "lr" | "rr"): boolean {
  return settings.tires.includes(tire);
}

/**
 * @internal Exported for testing
 *
 * Get available tire compounds from session info.
 * Returns the DriverTires array from the first driver, or a single "Hard" fallback.
 */
export function getDriverTires(): DriverTire[] {
  try {
    const sessionInfo = getSDK().sdk.getSessionInfo();
    const driverInfo = sessionInfo?.DriverInfo as Record<string, unknown> | undefined;
    const tires = driverInfo?.DriverTires as DriverTire[] | undefined;

    return tires && tires.length > 0 ? tires : DEFAULT_TIRES;
  } catch {
    return DEFAULT_TIRES;
  }
}

/**
 * @internal Exported for testing
 *
 * Get F1-style color for a compound type. Case-insensitive. Falls back to gray.
 */
export function getCompoundColor(compoundType: string): string {
  return COMPOUND_COLORS[compoundType.toLowerCase()] ?? GRAY;
}

/**
 * @internal Exported for testing
 *
 * Get display name for a compound index.
 * - 1 compound: use its actual name, uppercased
 * - 2 compounds with one "Wet": the non-wet compound is "DRY", the wet is "WET"
 * - 3+ compounds: use the actual compound type name
 */
export function getCompoundName(compound: number): string {
  const tires = getDriverTires();
  const tire = tires.find((t) => t.TireIndex === compound);
  const typeName = tire?.TireCompoundType ?? "Dry";

  if (tires.length === 1) {
    return typeName.toUpperCase();
  }

  if (tires.length === 2 && tires.some((t) => t.TireCompoundType.toLowerCase() === "wet")) {
    return typeName.toLowerCase() === "wet" ? "WET" : "DRY";
  }

  return typeName;
}

/**
 * @internal Exported for testing
 *
 * Generate a simple colored tire icon for a compound type.
 */
export function generateTireIcon(compoundType: string): string {
  const color = getCompoundColor(compoundType);

  return `
    <circle cx="72" cy="44" r="24" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="4"/>
    <circle cx="72" cy="44" r="10" fill="${GRAY}" stroke="${GRAY}" stroke-width="2"/>`;
}

/**
 * Get tire fill color based on settings and current state.
 * Black: not configured (nothing happens on press).
 * Red: configured and currently OFF (will turn ON on press).
 * Green: configured and currently ON (will turn OFF on press).
 */
function getTireColor(isConfigured: boolean, isCurrentlyOn: boolean): string {
  if (!isConfigured) return "#000000ff";

  if (isCurrentlyOn) return "#44FF44";

  return "#FF4444";
}

/**
 * Get current tire change state from telemetry flags.
 */
function getTireState(telemetry: TelemetryData | null): {
  lf: boolean;
  rf: boolean;
  lr: boolean;
  rr: boolean;
} {
  if (!telemetry || telemetry.PitSvFlags === undefined) {
    return { lf: false, rf: false, lr: false, rr: false };
  }

  const flags = telemetry.PitSvFlags;

  return {
    lf: hasFlag(flags, PitSvFlags.LFTireChange),
    rf: hasFlag(flags, PitSvFlags.RFTireChange),
    lr: hasFlag(flags, PitSvFlags.LRTireChange),
    rr: hasFlag(flags, PitSvFlags.RRTireChange),
  };
}

/**
 * Get tire compound info from telemetry.
 * playerCompound: tires currently on the car.
 * pitSvCompound: compound selected for the next pit stop.
 */
function getCompoundState(telemetry: TelemetryData | null): { player: number; pitSv: number } {
  return {
    player: telemetry?.PlayerTireCompound ?? 0,
    pitSv: telemetry?.PitSvTireCompound ?? 0,
  };
}

/**
 * @internal Exported for testing
 *
 * Check if all four tires are selected.
 */
export function areAllTiresOn(settings: Pick<TireServiceSettings, "tires">): boolean {
  return new Set(settings.tires).size === 4;
}

/**
 * @internal Exported for testing
 *
 * Check if exactly the left-side tires (LF + LR) are selected.
 */
export function areLeftTiresOn(settings: Pick<TireServiceSettings, "tires">): boolean {
  return settings.tires.length === 2 && settings.tires.includes("lf") && settings.tires.includes("lr");
}

/**
 * @internal Exported for testing
 *
 * Check if exactly the right-side tires (RF + RR) are selected.
 */
export function areRightTiresOn(settings: Pick<TireServiceSettings, "tires">): boolean {
  return settings.tires.length === 2 && settings.tires.includes("rf") && settings.tires.includes("rr");
}

/**
 * @internal Exported for testing
 *
 * Check if the current tire change flags exactly match the configured tires.
 */
export function doCurrentTiresMatch(
  settings: Pick<TireServiceSettings, "tires">,
  tireState: { lf: boolean; rf: boolean; lr: boolean; rr: boolean },
): boolean {
  const configured = new Set(settings.tires);

  return (
    tireState.lf === configured.has("lf") &&
    tireState.rf === configured.has("rf") &&
    tireState.lr === configured.has("lr") &&
    tireState.rr === configured.has("rr")
  );
}

/**
 * @internal Exported for testing
 *
 * Builds a pit macro string to toggle the configured tires.
 * Uses shorthand macros (#!t, #!l, #!r) when tires match a recognized group pattern.
 * Returns null if no tires are configured.
 */
export function buildTireToggleMacro(settings: TireServiceSettings): string | null {
  if (areAllTiresOn(settings)) return "#!t";

  if (areLeftTiresOn(settings)) return "#!l";

  if (areRightTiresOn(settings)) return "#!r";

  const parts = settings.tires.map((t) => `!${t}`);

  return parts.length > 0 ? `#${parts.join(" ")}` : null;
}

/**
 * @internal Exported for testing
 *
 * Generates dynamic tire indicator SVG rectangles for the toggle-tires action.
 * Uses native 144x144 coordinates matching the pre-rotated car body graphic.
 */
export function generateToggleTiresIconContent(
  settings: TireServiceSettings,
  currentState: { lf: boolean; rf: boolean; lr: boolean; rr: boolean },
): string {
  const lfColor = getTireColor(isTireSelected(settings, "lf"), currentState.lf);
  const rfColor = getTireColor(isTireSelected(settings, "rf"), currentState.rf);
  const lrColor = getTireColor(isTireSelected(settings, "lr"), currentState.lr);
  const rrColor = getTireColor(isTireSelected(settings, "rr"), currentState.rr);

  return [
    `<rect x="39.57" y="22.94" width="14.88" height="16.13" rx="2" fill="${lfColor}" stroke="${GRAY}" stroke-width="1"/>`,
    `<rect x="89.56" y="22.94" width="14.88" height="16.13" rx="2" fill="${rfColor}" stroke="${GRAY}" stroke-width="1"/>`,
    `<rect x="37.89" y="71.07" width="15.79" height="19.48" rx="2" fill="${lrColor}" stroke="${GRAY}" stroke-width="1"/>`,
    `<rect x="90.33" y="71.07" width="15.79" height="19.48" rx="2" fill="${rrColor}" stroke="${GRAY}" stroke-width="1"/>`,
  ].join("\n    ");
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the tire service based on settings and current tire state.
 */
export function generateTireServiceSvg(
  settings: TireServiceSettings,
  currentState: { lf: boolean; rf: boolean; lr: boolean; rr: boolean },
  compoundState: { player: number; pitSv: number } = { player: 0, pitSv: 0 },
): string {
  switch (settings.mode) {
    case "change-all-tires": {
      const colors = resolveIconColors(changeAllTiresIconSvg, getGlobalColors(), settings.colorOverrides);
      const title = resolveTitleSettings(
        changeAllTiresIconSvg,
        getGlobalTitleSettings(),
        settings.titleOverrides,
        "ALL TIRES\nCHANGE",
      );

      const border = resolveBorderSettings(changeAllTiresIconSvg, getGlobalBorderSettings(), settings.borderOverrides);

      const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

      return assembleIcon({
        graphicSvg: changeAllTiresIconSvg,
        colors,
        title,
        border,
        graphic,
      });
    }
    case "change-compound": {
      let iconContent: string;
      let textElement: string;
      const compoundType = getCompoundName(compoundState.pitSv);
      const isChanging = compoundState.player !== compoundState.pitSv;

      iconContent = generateTireIcon(compoundType);

      if (isChanging) {
        textElement = [
          generateIconText({ text: `Change to`, fontSize: 18, fill: YELLOW, baseY: 112, centerX: 72 }),
          generateIconText({ text: compoundType, fontSize: 24, fill: YELLOW, baseY: 138, centerX: 72 }),
        ].join("\n");
      } else {
        textElement = [
          generateIconText({ text: `Stay on`, fontSize: 18, fill: "#ffffff", baseY: 112, centerX: 72 }),
          generateIconText({ text: compoundType, fontSize: 24, fill: "#ffffff", baseY: 138, centerX: 72 }),
        ].join("\n");
      }

      const compoundColors = resolveIconColors(tireServiceTemplate, getGlobalColors(), settings.colorOverrides);
      const border = resolveBorderSettings(tireServiceTemplate, getGlobalBorderSettings(), settings.borderOverrides);
      const borderSvg = generateBorderParts(border);

      const compoundSvg = renderIconTemplate(tireServiceTemplate, {
        iconContent,
        textElement,
        borderDefs: borderSvg.defs,
        borderContent: borderSvg.rects,
        ...compoundColors,
      });

      return svgToDataUri(compoundSvg);
    }
    case "clear-tires": {
      const colors = resolveIconColors(clearTiresIconSvg, getGlobalColors(), settings.colorOverrides);
      const title = resolveTitleSettings(
        clearTiresIconSvg,
        getGlobalTitleSettings(),
        settings.titleOverrides,
        "TIRES\nCLEAR",
      );

      const border = resolveBorderSettings(clearTiresIconSvg, getGlobalBorderSettings(), settings.borderOverrides);

      const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

      return assembleIcon({ graphicSvg: clearTiresIconSvg, colors, title, border, graphic });
    }
    default: {
      const tireElements = generateToggleTiresIconContent(settings, currentState);

      const colors = resolveIconColors(toggleTiresCarSvg, getGlobalColors(), settings.colorOverrides);
      const title = resolveTitleSettings(toggleTiresCarSvg, getGlobalTitleSettings(), settings.titleOverrides, "TIRES");
      const border = resolveBorderSettings(toggleTiresCarSvg, getGlobalBorderSettings(), settings.borderOverrides);

      const rawCarGraphic = extractGraphicContent(toggleTiresCarSvg);
      const colorizedCar = title.showGraphics ? renderIconTemplate(rawCarGraphic, colors) : "";
      let graphicContent = title.showGraphics ? colorizedCar + "\n" + tireElements : "";

      const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);
      const artworkBounds = parseIconArtworkBounds(toggleTiresCarSvg);

      if (graphicContent && artworkBounds) {
        graphicContent = applyGraphicTransform(graphicContent, artworkBounds, computeGraphicArea(title), graphic.scale);
      }

      const titleContent = title.showTitle
        ? generateTitleText({
            text: title.titleText,
            fontSize: title.fontSize,
            bold: title.bold,
            position: title.position,
            customPosition: title.customPosition,
            fill: colors.textColor ?? "#ffffff",
          })
        : "";

      const borderSvg = generateBorderParts(border);
      const borderContent = borderSvg.defs + borderSvg.rects;

      const svg = renderIconTemplate(ICON_BASE_TEMPLATE, {
        backgroundColor: colors.backgroundColor ?? "#000000",
        borderContent,
        graphicContent,
        titleContent,
      });

      return svgToDataUri(svg);
    }
  }
}

/**
 * Tire Service
 * Manages tire pit service: toggle tire changes, change compound, or clear tire selections.
 * Toggle mode: dynamic icon shows car with tire colors based on current iRacing state.
 * Green = will be changed, Red = configured but not active, Black = not configured.
 */
export const TIRE_SERVICE_UUID = "com.iracedeck.sd.core.tire-service" as const;

export class TireService extends ConnectionStateAwareAction<TireServiceSettings> {
  private activeContexts = new Map<string, TireServiceSettings>();
  private lastState = new Map<string, string>();

  override async onWillAppear(ev: IDeckWillAppearEvent<TireServiceSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const raw = ev.payload.settings as Record<string, unknown> | undefined;
    const { migrated: rawWithMode, changed: actionMigrated } = migrateLegacyActionToMode(ev.payload.settings);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);

    // Persist defaults on fresh instances so the PI sees correct values,
    // and persist the action -> mode rename for legacy instances
    const needsTires = !raw || raw.tires === undefined;
    const needsToggleMode = !raw?.toggleMode;

    if (needsTires || needsToggleMode || actionMigrated) {
      const updates: Record<string, unknown> = { ...rawWithMode };

      if (needsTires) updates.tires = settings.tires;

      if (needsToggleMode) {
        // Determine toggle mode default: raw settings without addedWithVersion
        // means first appear after the feature was added. Check if other settings
        // exist to distinguish pre-existing instances (have data) from new ones (empty).
        const isPreExisting = raw && Object.keys(raw).length > 0 && !raw.addedWithVersion;
        updates.toggleMode = isPreExisting ? "toggle" : "select";
      }

      try {
        await ev.action.setSettings(updates);
      } catch (error) {
        this.logger.warn(
          `Failed to persist default settings: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await this.updateDisplayWithEvent(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      const storedSettings = this.activeContexts.get(ev.action.id);

      if (storedSettings) {
        this.updateDisplayFromTelemetry(ev.action.id, telemetry, storedSettings);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<TireServiceSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<TireServiceSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);

    const telemetry = this.sdkController.getCurrentTelemetry();
    const tireState = getTireState(telemetry);
    const compound = getCompoundState(telemetry);

    const svgDataUri = generateTireServiceSvg(settings, tireState, compound);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateTireServiceSvg(settings, tireState, compound));

    const stateKey = this.buildStateKey(settings, tireState, compound);
    this.lastState.set(ev.action.id, stateKey);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<TireServiceSettings>): Promise<void> {
    this.logger.info("Key down received");
    this.executeAction(ev.payload.settings);
  }

  override async onDialDown(ev: IDeckDialDownEvent<TireServiceSettings>): Promise<void> {
    this.logger.info("Dial down received");
    this.executeAction(ev.payload.settings);
  }

  private parseSettings(settings: unknown): TireServiceSettings {
    return migrateTireSettings(settings);
  }

  private async updateDisplayWithEvent(
    ev: IDeckWillAppearEvent<TireServiceSettings>,
    settings: TireServiceSettings,
  ): Promise<void> {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const tireState = getTireState(telemetry);
    const compound = getCompoundState(telemetry);

    const svgDataUri = generateTireServiceSvg(settings, tireState, compound);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateTireServiceSvg(settings, tireState, compound));

    const stateKey = this.buildStateKey(settings, tireState, compound);
    this.lastState.set(ev.action.id, stateKey);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: TireServiceSettings,
  ): Promise<void> {
    const tireState = getTireState(telemetry);
    const compound = getCompoundState(telemetry);
    const stateKey = this.buildStateKey(settings, tireState, compound);
    const lastStateKey = this.lastState.get(contextId);

    if (lastStateKey !== stateKey) {
      this.lastState.set(contextId, stateKey);
      const svgDataUri = generateTireServiceSvg(settings, tireState, compound);
      await this.updateKeyImage(contextId, svgDataUri);
      this.setRegenerateCallback(contextId, () => generateTireServiceSvg(settings, tireState, compound));
    }
  }

  private buildStateKey(
    settings: TireServiceSettings,
    tireState: { lf: boolean; rf: boolean; lr: boolean; rr: boolean },
    compound: { player: number; pitSv: number },
  ): string {
    // Static-icon modes don't depend on telemetry — avoid unnecessary re-renders
    if (settings.mode === "change-all-tires" || settings.mode === "clear-tires") {
      return settings.mode;
    }

    const tires = getDriverTires();
    const compoundType = getCompoundName(compound.pitSv);
    const bo = settings.borderOverrides;
    const borderKey = `${bo?.enabled ?? ""}|${bo?.borderWidth ?? ""}|${bo?.borderColor ?? ""}|${bo?.glowEnabled ?? ""}|${bo?.glowWidth ?? ""}`;

    return `${settings.mode}|${settings.tires.join(",")}|${tireState.lf}|${tireState.rf}|${tireState.lr}|${tireState.rr}|${compound.player}|${compound.pitSv}|${tires.length}|${compoundType}|${borderKey}`;
  }

  private executeAction(rawSettings: unknown): void {
    if (!this.sdkController.getConnectionStatus()) {
      this.logger.info("Not connected to iRacing");

      return;
    }

    const settings = this.parseSettings(rawSettings);

    switch (settings.mode) {
      case "change-all-tires": {
        this.logger.debug("Sending change all tires macro");
        const success = getCommands().chat.sendMessage("#t");

        if (success) {
          this.logger.info("Change all tires sent");
        } else {
          this.logger.warn("Failed to send change all tires");
        }

        break;
      }
      case "change-compound": {
        const telemetry = this.sdkController.getCurrentTelemetry();
        const { pitSv } = getCompoundState(telemetry);
        const compounds = getDriverTires();
        const currentArrayIdx = compounds.findIndex((t) => t.TireIndex === pitSv);
        const nextArrayIdx = (currentArrayIdx + 1) % compounds.length;
        const nextTire = compounds[nextArrayIdx];

        this.logger.debug(`Changing compound from ${getCompoundName(pitSv)} to ${getCompoundName(nextTire.TireIndex)}`);
        const success = getCommands().pit.tireCompound(nextTire.TireIndex);

        if (success) {
          this.logger.info("Tire compound change sent");
        } else {
          this.logger.warn("Failed to send tire compound change");
        }

        break;
      }
      case "clear-tires": {
        this.logger.debug("Sending clear tires");
        const success = getCommands().pit.clearTires();

        if (success) {
          this.logger.info("Clear tires sent");
        } else {
          this.logger.warn("Failed to send clear tires");
        }

        break;
      }
      default: {
        const macro = buildTireToggleMacro(settings);

        if (!macro) {
          this.logger.warn("No tires configured");

          return;
        }

        const toggleMode = resolveToggleMode(settings);

        if (toggleMode === "select") {
          const telemetry = this.sdkController.getCurrentTelemetry();
          const tireState = getTireState(telemetry);

          if (!doCurrentTiresMatch(settings, tireState)) {
            this.logger.debug("Current tires don't match configured — clearing first");
            getCommands().pit.clearTires();
          }
        }

        this.logger.debug(`Sending pit macro: ${macro} (toggleMode=${toggleMode})`);
        const success = getCommands().chat.sendMessage(macro);

        if (success) {
          this.logger.info("Tire toggle sent");
        } else {
          this.logger.warn("Failed to send tire toggle");
        }

        break;
      }
    }
  }
}
