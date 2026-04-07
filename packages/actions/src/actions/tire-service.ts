import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  generateBorderParts,
  generateIconText,
  getCommands,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalTitleSettings,
  getSDK,
  type IDeckDialDownEvent,
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
import changeAllTiresIconSvg from "@iracedeck/icons/tire-service/change-all-tires.svg";
import clearTiresIconSvg from "@iracedeck/icons/tire-service/clear-tires.svg";
import { hasFlag, PitSvFlags, TelemetryData } from "@iracedeck/iracing-sdk";
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

const TireServiceSettings = CommonSettings.extend({
  action: z.enum(["change-all-tires", "clear-tires", "toggle-tires", "change-compound"]).default("change-all-tires"),
  tires: z.array(TireCode).default(["lf", "rf", "lr", "rr"]),
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
 * Migrates legacy boolean tire settings (lf/rf/lr/rr) to the new tires array.
 * Only runs when tires key is absent from the raw settings and legacy booleans are present.
 */
export function migrateTireSettings(raw: unknown): TireServiceSettings {
  const parsed = TireServiceSettings.safeParse(raw);
  const data = parsed.success ? parsed.data : TireServiceSettings.parse({});

  const rawRecord = raw as Record<string, unknown> | undefined;

  if (!rawRecord || rawRecord.tires !== undefined) {
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
 * Builds a pit macro string to toggle the configured tires.
 * Returns null if no tires are configured.
 */
export function buildTireToggleMacro(settings: TireServiceSettings): string | null {
  const parts = settings.tires.map((t) => `!${t}`);

  return parts.length > 0 ? `#${parts.join(" ")}` : null;
}

/**
 * @internal Exported for testing
 *
 * Generates dynamic tire indicator SVG paths for the toggle-tires action.
 * Uses the same coordinate space as the car body with per-tire scaling for visibility.
 */
export function generateToggleTiresIconContent(
  settings: TireServiceSettings,
  currentState: { lf: boolean; rf: boolean; lr: boolean; rr: boolean },
  bodyColor: string,
): string {
  const lfColor = getTireColor(isTireSelected(settings, "lf"), currentState.lf);
  const rfColor = getTireColor(isTireSelected(settings, "rf"), currentState.rf);
  const lrColor = getTireColor(isTireSelected(settings, "lr"), currentState.lr);
  const rrColor = getTireColor(isTireSelected(settings, "rr"), currentState.rr);

  return `
  <path d="M59.91,45.74l-8.02-3.5v1.06c0,.96.47,1.82,1.22,2.16l7.92,3.67.12-.87c.14-1.08-.38-2.14-1.24-2.52ZM61.79,38.44h-8.93c-.53,0-.97.43-.97.97v.38c0,.54.44.97.97.97h8.87c.48,0,.88-.34.95-.81l.06-.39c.11-.59-.35-1.12-.95-1.12ZM58.07,112.1h-8.11c-.54,0-.98.43-.98.97v.78c0,.54.44.97.98.97h8.11c.53,0,.96-.43.96-.97v-.78c0-.54-.43-.97-.96-.97ZM66.88,10.06l-2.44-1.73-18.03,3.98-5.6,3.78-2.36,5.65h2.89l3.56-3.98,11.75-1.19,7.61,8.37.7-3.66-4.89-5.3,5.93-.66.88-5.26ZM57.84,121.03l-8.86-4.34v.66c0,1,.59,1.9,1.49,2.32l6.52,3.1c.33.15.69.12.98-.08.6-.43.52-1.34-.13-1.66ZM68.05,127.28l-6.72-9.64c-.42-.6-1.36-.3-1.36.43v4.74c0,.95-.77,1.71-1.72,1.71h-6.21s-.02.02-.06.03c-.01.01-.02.01-.03.01h-.03c-.16.01-.33.03-.5.08-.03.01-.07.02-.12.04-.04.01-.09.03-.14.05-.07.02-.14.05-.2.09-.05.01-.11.04-.17.08-.07.04-.14.09-.21.14-.51.35-.87.87-1.09,1.47-.04.11-.07.23-.1.34-.04.14-.07.28-.09.42,0,.01-.01.03-.01.05-.02.22-.05.44-.05.67h.03l.02,2.15v1.52c0,.41.32.75.74.75h17.41c.41,0,.74-.34.74-.75v-3.95c0-.15-.04-.3-.13-.43ZM86.18,121.03c-.66.32-.73,1.23-.13,1.66.28.2.65.23.97.08l6.53-3.1c.9-.42,1.48-1.32,1.48-2.32v-.66l-8.85,4.34ZM103.21,16.09l-5.6-3.78-18.04-3.98-2.43,1.73.88,5.26,5.93.66-4.9,5.3.71,3.66,7.61-8.37,11.75,1.19,3.56,3.98h2.89l-2.36-5.65ZM84.11,45.74c-.86.38-1.38,1.44-1.24,2.52l.12.87,7.92-3.67c.74-.34,1.22-1.2,1.22-2.16v-1.06l-8.02,3.5ZM94.75,127.99h.02c0-.23-.02-.45-.05-.67,0-.02,0-.04,0-.05-.01-.14-.04-.28-.08-.42-.03-.11-.06-.23-.11-.34-.21-.6-.57-1.12-1.08-1.47-.07-.05-.14-.1-.22-.14-.05-.04-.11-.07-.16-.08-.06-.04-.13-.07-.2-.09-.05-.02-.1-.04-.15-.05-.04-.02-.08-.03-.12-.04-.16-.05-.33-.07-.5-.08h-.02s-.02,0-.03-.01c-.04-.01-.07-.03-.07-.03h-6.2c-.95,0-1.72-.76-1.72-1.71v-4.74c0-.73-.94-1.03-1.36-.43l-6.72,9.64c-.09.13-.14.28-.14.43v3.95c0,.41.34.75.75.75h17.41c.42,0,.75-.34.75-.75v-1.33s-.01-.19-.01-.19l.02-2.15ZM94.06,112.1h-8.11c-.53,0-.96.43-.96.97v.78c0,.54.43.97.96.97h8.11c.53,0,.97-.43.97-.97v-.78c0-.54-.44-.97-.97-.97ZM82.97,49.14h.02s-.02,0-.02,0ZM91.16,38.44h-8.94c-.59,0-1.05.53-.95,1.12l.06.39c.08.47.48.81.96.81h8.87c.53,0,.97-.43.97-.97v-.38c0-.54-.44-.97-.97-.97ZM94.76,133.25h-45.5l-.02,3.15c0,.12.05.24.06.34.09.8.43,1.54,1.06,2.08.44.38,1.03.66,1.65.66h5.18c.65,0,1.19-.53,1.19-1.19s.53-1.18,1.18-1.18h24.9c.65,0,1.18.53,1.18,1.18s.53,1.19,1.19,1.19h5.18c.62,0,1.2-.28,1.64-.66.64-.54.98-1.28,1.06-2.08.02-.1.06-.22.06-.34v-3.15ZM72.04,130.11h-.06c-1.1,0-2.09-.48-2.8-1.29v3.59h5.65v-3.59c-.71.81-1.69,1.29-2.79,1.29ZM72.04,69.28h-.06c-3.04,0-5.51,2.79-5.51,6.23s2.47,6.24,5.51,6.24h.06c3.04,0,5.51-2.79,5.51-6.24s-2.47-6.23-5.51-6.23ZM76.83,59.43h-9.65c-.26,0-.46.21-.46.48v.55c0,.26.2.48.46.48h9.65c.26,0,.47-.22.47-.48v-.55c0-.27-.21-.48-.47-.48ZM67.18,60.94h9.65c.26,0,.47-.22.47-.48v-.55c0-.27-.21-.48-.47-.48h-9.65c-.26,0-.46.21-.46.48v.55c0,.26.2.48.46.48ZM72.04,69.28h-.06c-3.04,0-5.51,2.79-5.51,6.23s2.47,6.24,5.51,6.24h.06c3.04,0,5.51-2.79,5.51-6.24s-2.47-6.23-5.51-6.23ZM72.1,47.47h-.18c-3.35.01-10.95,5.03-10.96,25.34.08,8.83.66,17.74,3.01,26.31.98,3.53,2.96,6.97,5.37,9.72,1.01,1.14,1.99,2.02,2.64,2.02.01,0,.02-.01.03-.01s.02.01.03.01c.65,0,1.63-.88,2.64-2.02,2.41-2.75,4.39-6.19,5.37-9.72,2.35-8.57,2.93-17.48,3.01-26.31-.01-20.31-7.61-25.33-10.96-25.34ZM78.47,77.78c0,2.84-2.31,5.15-5.15,5.15h-2.62c-2.84,0-5.16-2.31-5.16-5.15v-18.92c0-.67.56-1.22,1.23-1.22h10.48c.67,0,1.22.55,1.22,1.22v18.92ZM67.18,60.94h9.65c.26,0,.47-.22.47-.48v-.55c0-.27-.21-.48-.47-.48h-9.65c-.26,0-.46.21-.46.48v.55c0,.26.2.48.46.48ZM72.04,69.28h-.06c-3.04,0-5.51,2.79-5.51,6.23s2.47,6.24,5.51,6.24h.06c3.04,0,5.51-2.79,5.51-6.24s-2.47-6.23-5.51-6.23ZM72.04,69.28h-.06c-3.04,0-5.51,2.79-5.51,6.23s2.47,6.24,5.51,6.24h.06c3.04,0,5.51-2.79,5.51-6.24s-2.47-6.23-5.51-6.23ZM76.83,59.43h-9.65c-.26,0-.46.21-.46.48v.55c0,.26.2.48.46.48h9.65c.26,0,.47-.22.47-.48v-.55c0-.27-.21-.48-.47-.48ZM76.83,59.43h-9.65c-.26,0-.46.21-.46.48v.55c0,.26.2.48.46.48h9.65c.26,0,.47-.22.47-.48v-.55c0-.27-.21-.48-.47-.48ZM72.04,69.28h-.06c-3.04,0-5.51,2.79-5.51,6.23s2.47,6.24,5.51,6.24h.06c3.04,0,5.51-2.79,5.51-6.24s-2.47-6.23-5.51-6.23ZM95.03,110.2v.66l-7.96-3.9c-2.04,4.69-4.54,9.17-7.47,13.37l-5.3,7.6c-.52.74-1.36,1.18-2.26,1.18h-.06c-.9,0-1.75-.44-2.26-1.18l-5.3-7.6c-2.93-4.2-5.43-8.68-7.48-13.37l-7.96,3.9v-.66c0-1,.59-1.9,1.49-2.32l5.73-2.72c-1.13-3-3.54-10.13-5.15-17.48-1.49-6.8-1.75-11.71-1.71-14.57.02-1.88.32-3.74.92-5.51,2.75-8.13,7.28-8.32,8.77-10.69,6.46-10.37,10.44-50.77,10.44-50.77,0-.01,0-.02.01-.03.08-1.14.93-2.07,2.03-2.28v34.14c-.01,4.05-1.94,7.84-5.2,10.23-5.89,4.34-6.87,18.14-6.87,18.14-.92,13.76-1.79,29.25,5.39,41.92,1.25,2.59,5.37,8.84,7.01,11.23,0,0,.09.01.17.01s.16-.01.17-.01c1.64-2.39,5.76-8.64,7.01-11.23,7.17-12.67,6.31-28.16,5.39-41.92,0,0-.98-13.8-6.87-18.14-3.26-2.39-5.19-6.18-5.19-10.23V3.83c1.09.21,1.94,1.14,2.02,2.28.01.01.01.02.01.03,0,0,3.97,40.4,10.44,50.77,1.49,2.37,6.02,2.56,8.77,10.69.6,1.77.9,3.63.92,5.51.04,2.86-.22,7.77-1.71,14.57-1.61,7.35-4.02,14.48-5.15,17.48l5.73,2.72c.9.42,1.48,1.32,1.48,2.32Z" fill="${bodyColor}"/>
  <rect x="34.02" y="24.94" width="16.28" height="32.7" rx="3" fill="${lfColor}" stroke="${GRAY}" stroke-width="2"/>
  <rect x="93.76" y="24.94" width="16.28" height="32.7" rx="3" fill="${rfColor}" stroke="${GRAY}" stroke-width="2"/>
  <rect x="30.16" y="95.56" width="16.28" height="34" rx="3" fill="${lrColor}" stroke="${GRAY}" stroke-width="2"/>
  <rect x="97.32" y="95.56" width="16.28" height="34" rx="3" fill="${rrColor}" stroke="${GRAY}" stroke-width="2"/>`;
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
  switch (settings.action) {
    case "change-all-tires": {
      const colors = resolveIconColors(changeAllTiresIconSvg, getGlobalColors(), settings.colorOverrides);
      const title = resolveTitleSettings(
        changeAllTiresIconSvg,
        getGlobalTitleSettings(),
        settings.titleOverrides,
        "ALL TIRES\nCHANGE",
      );

      const border = resolveBorderSettings(changeAllTiresIconSvg, getGlobalBorderSettings(), settings.borderOverrides);

      return assembleIcon({
        graphicSvg: changeAllTiresIconSvg,
        colors,
        title,
        border,
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

      return assembleIcon({ graphicSvg: clearTiresIconSvg, colors, title, border });
    }
    default: {
      const toggleColors = resolveIconColors(tireServiceTemplate, getGlobalColors(), settings.colorOverrides);
      const bodyColor = (toggleColors as Record<string, string>).graphic1Color || WHITE;
      const toggleIconContent = generateToggleTiresIconContent(settings, currentState, bodyColor);

      const border = resolveBorderSettings(tireServiceTemplate, getGlobalBorderSettings(), settings.borderOverrides);
      const borderSvg = generateBorderParts(border);

      const svg = renderIconTemplate(tireServiceTemplate, {
        iconContent: toggleIconContent,
        textElement: "",
        borderDefs: borderSvg.defs,
        borderContent: borderSvg.rects,
        ...toggleColors,
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
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);

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
    if (settings.action === "change-all-tires" || settings.action === "clear-tires") {
      return settings.action;
    }

    const tires = getDriverTires();
    const compoundType = getCompoundName(compound.pitSv);
    const bo = settings.borderOverrides;
    const borderKey = `${bo?.enabled ?? ""}|${bo?.borderWidth ?? ""}|${bo?.borderColor ?? ""}|${bo?.glowEnabled ?? ""}|${bo?.glowWidth ?? ""}`;

    return `${settings.action}|${settings.tires.join(",")}|${tireState.lf}|${tireState.rf}|${tireState.lr}|${tireState.rr}|${compound.player}|${compound.pitSv}|${tires.length}|${compoundType}|${borderKey}`;
  }

  private executeAction(rawSettings: unknown): void {
    if (!this.sdkController.getConnectionStatus()) {
      this.logger.info("Not connected to iRacing");

      return;
    }

    const settings = this.parseSettings(rawSettings);

    switch (settings.action) {
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

        this.logger.debug(`Sending pit macro: ${macro}`);
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
