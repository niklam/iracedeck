import {
  CommonSettings,
  ConnectionStateAwareAction,
  getGlobalColors,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "@iracedeck/deck-core";
import dashPage1DecreaseSvg from "@iracedeck/icons/cockpit-misc/dash-page-1-decrease.svg";
import dashPage1IncreaseSvg from "@iracedeck/icons/cockpit-misc/dash-page-1-increase.svg";
import dashPage2DecreaseSvg from "@iracedeck/icons/cockpit-misc/dash-page-2-decrease.svg";
import dashPage2IncreaseSvg from "@iracedeck/icons/cockpit-misc/dash-page-2-increase.svg";
import enterCarSvg from "@iracedeck/icons/cockpit-misc/enter-car.svg";
import exitCarSvg from "@iracedeck/icons/cockpit-misc/exit-car.svg";
import ffbMaxForceDecreaseSvg from "@iracedeck/icons/cockpit-misc/ffb-max-force-decrease.svg";
import ffbMaxForceIncreaseSvg from "@iracedeck/icons/cockpit-misc/ffb-max-force-increase.svg";
import inLapModeSvg from "@iracedeck/icons/cockpit-misc/in-lap-mode.svg";
import reportLatencySvg from "@iracedeck/icons/cockpit-misc/report-latency.svg";
import resetToPitsSvg from "@iracedeck/icons/cockpit-misc/reset-to-pits.svg";
import toggleWipersSvg from "@iracedeck/icons/cockpit-misc/toggle-wipers.svg";
import towSvg from "@iracedeck/icons/cockpit-misc/tow.svg";
import triggerWipersSvg from "@iracedeck/icons/cockpit-misc/trigger-wipers.svg";
import type { SessionInfo, TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

type CockpitMiscControl =
  | "toggle-wipers"
  | "trigger-wipers"
  | "ffb-max-force"
  | "report-latency"
  | "dash-page-1"
  | "dash-page-2"
  | "in-lap-mode"
  | "enter-exit-tow";

type DirectionType = "increase" | "decrease";

/** Controls that have +/- direction */
const DIRECTIONAL_CONTROLS: Set<CockpitMiscControl> = new Set(["ffb-max-force", "dash-page-1", "dash-page-2"]);

/** @internal Exported for testing */
export type EnterExitTowState = "enter-car" | "exit-car" | "reset-to-pits" | "tow";

const ENTER_EXIT_TOW_SVGS: Record<EnterExitTowState, string> = {
  "enter-car": enterCarSvg,
  "exit-car": exitCarSvg,
  "reset-to-pits": resetToPitsSvg,
  tow: towSvg,
};

const ENTER_EXIT_TOW_LABELS: Record<EnterExitTowState, string> = {
  "enter-car": "ENTER",
  "exit-car": "EXIT",
  "reset-to-pits": "RESET",
  tow: "TOW",
};

/**
 * Label configuration for each control + direction combination.
 * Standard layout: mainLabel = prominent (bold, bottom), subLabel = category/context (subdued, top).
 */
const COCKPIT_MISC_LABELS: Record<
  CockpitMiscControl,
  Record<DirectionType, { mainLabel: string; subLabel: string }> | { mainLabel: string; subLabel: string }
> = {
  "toggle-wipers": { mainLabel: "WIPERS", subLabel: "TOGGLE" },
  "trigger-wipers": { mainLabel: "WIPERS", subLabel: "TRIGGER" },
  "ffb-max-force": {
    increase: { mainLabel: "FFB FORCE", subLabel: "INCREASE" },
    decrease: { mainLabel: "FFB FORCE", subLabel: "DECREASE" },
  },
  "report-latency": { mainLabel: "LATENCY", subLabel: "REPORT" },
  "dash-page-1": {
    increase: { mainLabel: "DASH PG 1", subLabel: "NEXT" },
    decrease: { mainLabel: "DASH PG 1", subLabel: "PREVIOUS" },
  },
  "dash-page-2": {
    increase: { mainLabel: "DASH PG 2", subLabel: "NEXT" },
    decrease: { mainLabel: "DASH PG 2", subLabel: "PREVIOUS" },
  },
  "in-lap-mode": { mainLabel: "IN LAP", subLabel: "MODE" },
  "enter-exit-tow": { mainLabel: "ENTER", subLabel: "" },
};

/**
 * SVG templates for each control + direction combination.
 * Non-directional controls use a single SVG for both directions.
 */
const COCKPIT_MISC_SVGS: Record<CockpitMiscControl, Record<DirectionType, string> | string> = {
  "toggle-wipers": toggleWipersSvg,
  "trigger-wipers": triggerWipersSvg,
  "ffb-max-force": {
    increase: ffbMaxForceIncreaseSvg,
    decrease: ffbMaxForceDecreaseSvg,
  },
  "report-latency": reportLatencySvg,
  "dash-page-1": {
    increase: dashPage1IncreaseSvg,
    decrease: dashPage1DecreaseSvg,
  },
  "dash-page-2": {
    increase: dashPage2IncreaseSvg,
    decrease: dashPage2DecreaseSvg,
  },
  "in-lap-mode": inLapModeSvg,
  "enter-exit-tow": enterCarSvg,
};

/**
 * @internal Exported for testing
 *
 * Mapping from control + direction to global settings keys.
 * Directional controls use composite keys (e.g., "ffb-max-force-increase").
 */
export const COCKPIT_MISC_GLOBAL_KEYS: Record<string, string> = {
  "toggle-wipers": "cockpitMiscToggleWipers",
  "trigger-wipers": "cockpitMiscTriggerWipers",
  "ffb-max-force-increase": "cockpitMiscFfbForceIncrease",
  "ffb-max-force-decrease": "cockpitMiscFfbForceDecrease",
  "report-latency": "cockpitMiscReportLatency",
  "dash-page-1-increase": "cockpitMiscDashPage1Increase",
  "dash-page-1-decrease": "cockpitMiscDashPage1Decrease",
  "dash-page-2-increase": "cockpitMiscDashPage2Increase",
  "dash-page-2-decrease": "cockpitMiscDashPage2Decrease",
  "in-lap-mode": "cockpitMiscInLapMode",
  "enter-exit-tow": "cockpitMiscEnterExitTow",
};

const CockpitMiscSettings = CommonSettings.extend({
  control: z
    .enum([
      "toggle-wipers",
      "trigger-wipers",
      "ffb-max-force",
      "report-latency",
      "dash-page-1",
      "dash-page-2",
      "in-lap-mode",
      "enter-exit-tow",
    ])
    .default("toggle-wipers"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type CockpitMiscSettings = z.infer<typeof CockpitMiscSettings>;

/**
 * @internal Exported for testing
 *
 * Determines the Enter/Exit/Tow state based on telemetry and session info.
 * Priority order: enter-car → exit-car → reset-to-pits/tow (based on session type).
 */
export function getEnterExitTowState(
  telemetry: TelemetryData | null | Record<string, unknown>,
  sessionInfo: SessionInfo | null | Record<string, unknown>,
): EnterExitTowState {
  if (!telemetry || !(telemetry as Record<string, unknown>).IsOnTrack) {
    return "enter-car";
  }

  if ((telemetry as Record<string, unknown>).PlayerCarInPitStall) {
    return "exit-car";
  }

  // On track, not in pit stall — check session type
  const sessionNum = ((telemetry as Record<string, unknown>).SessionNum as number | undefined) ?? 0;
  const sessions = ((sessionInfo as Record<string, unknown> | null)?.SessionInfo as Record<string, unknown> | undefined)
    ?.Sessions as Array<Record<string, unknown>> | undefined;
  const currentSession = sessions?.find((s) => s.SessionNum === sessionNum);
  const sessionType = currentSession?.SessionType as string | undefined;

  if (sessionType === "Race") {
    return "tow";
  }

  return "reset-to-pits";
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for a specific Enter/Exit/Tow state.
 */
export function generateEnterExitTowSvg(
  state: EnterExitTowState,
  colorOverrides: Record<string, string> | undefined,
): string {
  const iconSvg = ENTER_EXIT_TOW_SVGS[state];
  const mainLabel = ENTER_EXIT_TOW_LABELS[state];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel,
    subLabel: "",
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the cockpit misc action.
 */
export function generateCockpitMiscSvg(settings: CockpitMiscSettings): string {
  const { control, direction } = settings;

  const svgEntry = COCKPIT_MISC_SVGS[control];
  const iconSvg =
    typeof svgEntry === "string" ? svgEntry : (svgEntry?.[direction] ?? COCKPIT_MISC_SVGS["trigger-wipers"]);

  const labelEntry = COCKPIT_MISC_LABELS[control];
  const labels: { mainLabel: string; subLabel: string } =
    "mainLabel" in labelEntry ? labelEntry : (labelEntry[direction] ?? { mainLabel: "COCKPIT", subLabel: "MISC" });

  const colors = resolveIconColors(iconSvg as string, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg as string, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Cockpit Misc Action
 * Provides miscellaneous cockpit controls (wipers, FFB force, latency reporting,
 * dash pages, in-lap mode) via keyboard shortcuts.
 */
export const COCKPIT_MISC_UUID = "com.iracedeck.sd.core.cockpit-misc" as const;

export class CockpitMisc extends ConnectionStateAwareAction<CockpitMiscSettings> {
  private subscribedContexts = new Set<string>();
  private activeContextSettings = new Map<string, CockpitMiscSettings>();
  private lastTelemetryState = new Map<string, EnterExitTowState>();

  override async onWillAppear(ev: IDeckWillAppearEvent<CockpitMiscSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const activeKey = this.resolveGlobalKey(settings.control, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }

    this.activeContextSettings.set(ev.action.id, settings);

    if (settings.control === "enter-exit-tow") {
      this.subscribeToTelemetry(ev.action.id);
    }

    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<CockpitMiscSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const activeKey = this.resolveGlobalKey(settings.control, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }

    this.activeContextSettings.set(ev.action.id, settings);

    // Manage subscription transitions
    if (settings.control === "enter-exit-tow" && !this.subscribedContexts.has(ev.action.id)) {
      this.subscribeToTelemetry(ev.action.id);
    } else if (settings.control !== "enter-exit-tow" && this.subscribedContexts.has(ev.action.id)) {
      this.unsubscribeFromTelemetry(ev.action.id);
    }

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<CockpitMiscSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.control === "enter-exit-tow") {
      const settingKey = COCKPIT_MISC_GLOBAL_KEYS["enter-exit-tow"];
      await this.holdBinding(ev.action.id, settingKey);

      return;
    }

    await this.executeControl(settings.control, settings.direction);
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<CockpitMiscSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.control === "enter-exit-tow") {
      await this.releaseBinding(ev.action.id);
    }
  }

  override async onDialDown(ev: IDeckDialDownEvent<CockpitMiscSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.control === "enter-exit-tow") {
      const settingKey = COCKPIT_MISC_GLOBAL_KEYS["enter-exit-tow"];
      await this.holdBinding(ev.action.id, settingKey);

      return;
    }

    await this.executeControl(settings.control, settings.direction);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<CockpitMiscSettings>): Promise<void> {
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

  override async onWillDisappear(ev: IDeckWillDisappearEvent<CockpitMiscSettings>): Promise<void> {
    const contextId = ev.action.id;

    if (this.subscribedContexts.has(contextId)) {
      await this.releaseBinding(contextId);
      this.unsubscribeFromTelemetry(contextId);
    }

    this.activeContextSettings.delete(contextId);
    this.lastTelemetryState.delete(contextId);

    await super.onWillDisappear(ev);
  }

  private parseSettings(settings: unknown): CockpitMiscSettings {
    const parsed = CockpitMiscSettings.safeParse(settings);

    return parsed.success ? parsed.data : CockpitMiscSettings.parse({});
  }

  private async executeControl(control: CockpitMiscControl, direction: DirectionType): Promise<void> {
    const settingKey = this.resolveGlobalKey(control, direction);

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${control} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  private resolveGlobalKey(control: CockpitMiscControl, direction: DirectionType): string | null {
    if (DIRECTIONAL_CONTROLS.has(control)) {
      const key = `${control}-${direction}`;

      return COCKPIT_MISC_GLOBAL_KEYS[key] ?? null;
    }

    return COCKPIT_MISC_GLOBAL_KEYS[control] ?? null;
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<CockpitMiscSettings> | IDeckDidReceiveSettingsEvent<CockpitMiscSettings>,
    settings: CockpitMiscSettings,
  ): Promise<void> {
    if (settings.control === "enter-exit-tow") {
      const telemetry = this.sdkController.getCurrentTelemetry();
      const sessionInfo = this.sdkController.getSessionInfo();
      const state = getEnterExitTowState(telemetry, sessionInfo);
      this.lastTelemetryState.set(ev.action.id, state);

      const svgDataUri = generateEnterExitTowSvg(state, settings.colorOverrides);
      await ev.action.setTitle("");
      await this.setKeyImage(ev, svgDataUri);
      this.setRegenerateCallback(ev.action.id, () => {
        const currentTelemetry = this.sdkController.getCurrentTelemetry();
        const currentSessionInfo = this.sdkController.getSessionInfo();
        const currentState = getEnterExitTowState(currentTelemetry, currentSessionInfo);

        return generateEnterExitTowSvg(currentState, settings.colorOverrides);
      });

      return;
    }

    const svgDataUri = generateCockpitMiscSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateCockpitMiscSvg(settings));
  }

  private subscribeToTelemetry(contextId: string): void {
    this.subscribedContexts.add(contextId);
    this.sdkController.subscribe(contextId, (telemetry: TelemetryData | null) => {
      void this.updateDisplayFromTelemetry(contextId, telemetry);
    });
  }

  private unsubscribeFromTelemetry(contextId: string): void {
    this.subscribedContexts.delete(contextId);
    this.sdkController.unsubscribe(contextId);
    this.lastTelemetryState.delete(contextId);
  }

  private async updateDisplayFromTelemetry(contextId: string, telemetry: TelemetryData | null): Promise<void> {
    const settings = this.activeContextSettings.get(contextId);

    if (!settings || settings.control !== "enter-exit-tow") return;

    const sessionInfo = this.sdkController.getSessionInfo();
    const state = getEnterExitTowState(telemetry, sessionInfo);
    const lastState = this.lastTelemetryState.get(contextId);

    if (state === lastState) return;

    this.lastTelemetryState.set(contextId, state);
    this.logger.info("Enter/Exit/Tow state changed");
    this.logger.debug(`New state: ${state}`);

    const svgDataUri = generateEnterExitTowSvg(state, settings.colorOverrides);
    await this.updateKeyImage(contextId, svgDataUri);
    this.setRegenerateCallback(contextId, () => {
      const currentTelemetry = this.sdkController.getCurrentTelemetry();
      const currentSessionInfo = this.sdkController.getSessionInfo();
      const currentState = getEnterExitTowState(currentTelemetry, currentSessionInfo);

      return generateEnterExitTowSvg(currentState, settings.colorOverrides);
    });
  }
}
