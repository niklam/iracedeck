import {
  CommonSettings,
  ConnectionStateAwareAction,
  getCommands,
  getGlobalColors,
  type IDeckDialDownEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "@iracedeck/deck-core";
import clearAllCheckboxesIconSvg from "@iracedeck/icons/pit-quick-actions/clear-all-checkboxes.svg";
import { hasFlag, PitSvFlags, type TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import pitQuickActionsTemplate from "../../icons/pit-quick-actions.svg";
import { statusBarNA, statusBarOff, statusBarOn } from "../icons/status-bar.js";

type PitQuickActionType = "clear-all-checkboxes" | "windshield-tearoff" | "request-fast-repair";

/**
 * Standalone SVG templates for static pit quick action modes (imported from @iracedeck/icons)
 */
/**
 * Standalone SVG templates for static pit quick action modes (imported from @iracedeck/icons).
 * Telemetry-aware modes (windshield-tearoff, request-fast-repair) use the dynamic template instead.
 */
const STATIC_ACTION_ICONS: Partial<Record<PitQuickActionType, string>> = {
  "clear-all-checkboxes": clearAllCheckboxesIconSvg,
};

/**
 * Label configuration for each pit quick action
 */
const PIT_QUICK_ACTION_LABELS: Record<PitQuickActionType, { mainLabel: string; subLabel: string }> = {
  "clear-all-checkboxes": { mainLabel: "CLEAR ALL", subLabel: "PIT" },
  "windshield-tearoff": { mainLabel: "WINDSHIELD", subLabel: "TEAROFF" },
  "request-fast-repair": { mainLabel: "FAST", subLabel: "REPAIR" },
};

/**
 * Actions that use telemetry-driven dynamic icons.
 * Keep in sync with getTelemetryState() and buildStateKey().
 */
const TELEMETRY_AWARE_ACTIONS = new Set<PitQuickActionType>(["windshield-tearoff", "request-fast-repair"]);

const PitQuickActionsSettings = CommonSettings.extend({
  action: z.enum(["clear-all-checkboxes", "windshield-tearoff", "request-fast-repair"]).default("clear-all-checkboxes"),
});

type PitQuickActionsSettings = z.infer<typeof PitQuickActionsSettings>;

/**
 * @internal Exported for testing
 */
export type PitQuickActionTelemetryState = {
  windshieldOn?: boolean;
  fastRepairOn?: boolean;
  fastRepairAvailable?: boolean;
};

/**
 * @internal Exported for testing
 */
export function isWindshieldOn(telemetry: TelemetryData | null): boolean {
  if (!telemetry || telemetry.PitSvFlags === undefined) return false;

  return hasFlag(telemetry.PitSvFlags, PitSvFlags.WindshieldTearoff);
}

/**
 * @internal Exported for testing
 */
export function isFastRepairOn(telemetry: TelemetryData | null): boolean {
  if (!telemetry || telemetry.PitSvFlags === undefined) return false;

  return hasFlag(telemetry.PitSvFlags, PitSvFlags.FastRepair);
}

/**
 * @internal Exported for testing
 */
export function isFastRepairAvailable(telemetry: TelemetryData | null): boolean {
  if (!telemetry || telemetry.FastRepairAvailable === undefined) return true;

  return telemetry.FastRepairAvailable > 0;
}

const WHITE = "#ffffff";

/**
 * Generates dynamic icon content (text labels + status bar) for telemetry-aware modes.
 */
function pitQuickActionDynamicIcon(
  actionType: PitQuickActionType,
  telemetryState: PitQuickActionTelemetryState,
  graphic1Color: string,
): string {
  const labels = PIT_QUICK_ACTION_LABELS[actionType];
  let statusBar: string;

  switch (actionType) {
    case "windshield-tearoff":
      statusBar = telemetryState.windshieldOn ? statusBarOn() : statusBarOff();
      break;
    case "request-fast-repair":
      if (telemetryState.fastRepairAvailable === false) {
        statusBar = statusBarNA();
      } else {
        statusBar = telemetryState.fastRepairOn ? statusBarOn() : statusBarOff();
      }

      break;
    default:
      statusBar = "";
  }

  return `
    <text x="72" y="44" text-anchor="middle" dominant-baseline="central"
          fill="${graphic1Color}" font-family="Arial, sans-serif" font-size="22" font-weight="bold">${labels.mainLabel}</text>
    <text x="72" y="74" text-anchor="middle" dominant-baseline="central"
          fill="${graphic1Color}" font-family="Arial, sans-serif" font-size="22" font-weight="bold">${labels.subLabel}</text>
    ${statusBar}`;
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the pit quick actions action.
 */
export function generatePitQuickActionsSvg(
  settings: PitQuickActionsSettings,
  telemetryState?: PitQuickActionTelemetryState,
): string {
  const { action: actionType } = settings;

  // Static mode: clear-all-checkboxes (no telemetry)
  if (!TELEMETRY_AWARE_ACTIONS.has(actionType)) {
    const iconSvg = STATIC_ACTION_ICONS[actionType] ?? STATIC_ACTION_ICONS["clear-all-checkboxes"]!;
    const labels = PIT_QUICK_ACTION_LABELS[actionType] || PIT_QUICK_ACTION_LABELS["clear-all-checkboxes"];
    const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
    const svg = renderIconTemplate(iconSvg, {
      mainLabel: labels.mainLabel,
      subLabel: labels.subLabel,
      ...colors,
    });

    return svgToDataUri(svg);
  }

  // Dynamic telemetry-driven modes
  const colors = resolveIconColors(pitQuickActionsTemplate, getGlobalColors(), settings.colorOverrides) as Record<
    string,
    string
  >;
  const graphic1 = colors.graphic1Color || WHITE;
  const iconContent = pitQuickActionDynamicIcon(actionType, telemetryState ?? {}, graphic1);

  const svg = renderIconTemplate(pitQuickActionsTemplate, {
    iconContent,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Pit Quick Actions
 * Provides quick pit stop toggles (clear all, windshield tearoff, fast repair)
 * via iRacing SDK commands. Toggle modes show live ON/OFF status via telemetry.
 */
export const PIT_QUICK_ACTIONS_UUID = "com.iracedeck.sd.core.pit-quick-actions" as const;

export class PitQuickActions extends ConnectionStateAwareAction<PitQuickActionsSettings> {
  private activeContexts = new Map<string, PitQuickActionsSettings>();
  private lastState = new Map<string, string>();

  override async onWillAppear(ev: IDeckWillAppearEvent<PitQuickActionsSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      const storedSettings = this.activeContexts.get(ev.action.id);

      if (storedSettings) {
        this.updateDisplayFromTelemetry(ev.action.id, telemetry, storedSettings);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<PitQuickActionsSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<PitQuickActionsSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.lastState.delete(ev.action.id);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<PitQuickActionsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeAction(settings.action);
  }

  override async onDialDown(ev: IDeckDialDownEvent<PitQuickActionsSettings>): Promise<void> {
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
        const telemetry = this.sdkController.getCurrentTelemetry();

        if (!telemetry) {
          this.logger.warn("No telemetry available for windshield tearoff toggle");
          break;
        }

        const isSet = isWindshieldOn(telemetry);
        const success = isSet ? pit.clearWindshield() : pit.windshield();
        this.logger.info("Windshield tearoff toggled");
        this.logger.debug(`Action: ${isSet ? "cleared" : "requested"}, result: ${success}`);
        break;
      }
      case "request-fast-repair": {
        const telemetry = this.sdkController.getCurrentTelemetry();

        if (!telemetry) {
          this.logger.warn("No telemetry available for fast repair toggle");
          break;
        }

        const isSet = isFastRepairOn(telemetry);
        const success = isSet ? pit.clearFastRepair() : pit.fastRepair();
        this.logger.info("Fast repair toggled");
        this.logger.debug(`Action: ${isSet ? "cleared" : "requested"}, result: ${success}`);
        break;
      }
    }
  }

  private getTelemetryState(
    telemetry: TelemetryData | null,
    actionType: PitQuickActionType,
  ): PitQuickActionTelemetryState {
    const state: PitQuickActionTelemetryState = {};

    if (actionType === "windshield-tearoff") {
      state.windshieldOn = isWindshieldOn(telemetry);
    } else if (actionType === "request-fast-repair") {
      state.fastRepairOn = isFastRepairOn(telemetry);
      state.fastRepairAvailable = isFastRepairAvailable(telemetry);
    }

    return state;
  }

  private buildStateKey(settings: PitQuickActionsSettings, telemetryState: PitQuickActionTelemetryState): string {
    switch (settings.action) {
      case "windshield-tearoff":
        return `windshield|${telemetryState.windshieldOn ?? false}`;
      case "request-fast-repair":
        return `fast-repair|${telemetryState.fastRepairOn ?? false}|${telemetryState.fastRepairAvailable ?? true}`;
      default:
        return settings.action;
    }
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<PitQuickActionsSettings> | IDeckDidReceiveSettingsEvent<PitQuickActionsSettings>,
    settings: PitQuickActionsSettings,
  ): Promise<void> {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const telemetryState = this.getTelemetryState(telemetry, settings.action);
    const svgDataUri = generatePitQuickActionsSvg(settings, telemetryState);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => {
      const currentTelemetry = this.sdkController.getCurrentTelemetry();
      const currentState = this.getTelemetryState(currentTelemetry, settings.action);

      return generatePitQuickActionsSvg(settings, currentState);
    });
    const stateKey = this.buildStateKey(settings, telemetryState);
    this.lastState.set(ev.action.id, stateKey);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: PitQuickActionsSettings,
  ): Promise<void> {
    if (!TELEMETRY_AWARE_ACTIONS.has(settings.action)) return;

    const telemetryState = this.getTelemetryState(telemetry, settings.action);
    const stateKey = this.buildStateKey(settings, telemetryState);
    const lastStateKey = this.lastState.get(contextId);

    if (lastStateKey !== stateKey) {
      this.lastState.set(contextId, stateKey);
      const svgDataUri = generatePitQuickActionsSvg(settings, telemetryState);
      await this.updateKeyImage(contextId, svgDataUri);
      this.setRegenerateCallback(contextId, () => {
        const currentTelemetry = this.sdkController.getCurrentTelemetry();
        const currentState = this.getTelemetryState(currentTelemetry, settings.action);

        return generatePitQuickActionsSvg(settings, currentState);
      });
    }
  }
}
