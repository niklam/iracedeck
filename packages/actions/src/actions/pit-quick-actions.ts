import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  generateBorderParts,
  generateTitleText,
  getCommands,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  migrateLegacyActionToMode,
  renderIconTemplate,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
} from "@iracedeck/deck-core";
import clearAllCheckboxesIconSvg from "@iracedeck/icons/pit-quick-actions/clear-all-checkboxes.svg";
import { hasFlag, PitSvFlags, type TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import fastRepairTemplate from "../../icons/pit-quick-actions-fast-repair.svg";
import windshieldTemplate from "../../icons/pit-quick-actions-windshield.svg";
import { borderColorForState, statusBarNA, statusBarOff, statusBarOn } from "../icons/status-bar.js";

type PitQuickActionType = "clear-all-checkboxes" | "windshield-tearoff" | "request-fast-repair";

/**
 * Standalone SVG templates for static pit quick action modes (imported from @iracedeck/icons).
 * Telemetry-aware modes (windshield-tearoff, request-fast-repair) use the dynamic template instead.
 */
const STATIC_ACTION_ICONS: Partial<Record<PitQuickActionType, string>> = {
  "clear-all-checkboxes": clearAllCheckboxesIconSvg,
};

/**
 * Actions that use telemetry-driven dynamic icons.
 * Keep in sync with getTelemetryState() and buildStateKey().
 */
const TELEMETRY_AWARE_ACTIONS = new Set<PitQuickActionType>(["windshield-tearoff", "request-fast-repair"]);

const PitQuickActionsSettings = CommonSettings.extend({
  mode: z.enum(["clear-all-checkboxes", "windshield-tearoff", "request-fast-repair"]).default("clear-all-checkboxes"),
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
): string {
  switch (actionType) {
    case "windshield-tearoff":
      if (telemetryState.windshieldOn === undefined) return statusBarNA();

      return telemetryState.windshieldOn ? statusBarOn() : statusBarOff();
    case "request-fast-repair":
      if (telemetryState.fastRepairOn === undefined || telemetryState.fastRepairAvailable === false) {
        return statusBarNA();
      }

      return telemetryState.fastRepairOn ? statusBarOn() : statusBarOff();
    default:
      return "";
  }
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
  const { mode: actionType } = settings;

  // Static mode: clear-all-checkboxes (no telemetry)
  if (!TELEMETRY_AWARE_ACTIONS.has(actionType)) {
    const iconSvg = STATIC_ACTION_ICONS[actionType] ?? STATIC_ACTION_ICONS["clear-all-checkboxes"]!;
    const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
    const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, "PIT\nCLEAR ALL");

    const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

    return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
  }

  // Dynamic telemetry-driven modes — each has its own template with <desc> defaults
  const template = actionType === "request-fast-repair" ? fastRepairTemplate : windshieldTemplate;
  const state = telemetryState ?? {};

  const colors = resolveIconColors(template, getGlobalColors(), settings.colorOverrides) as Record<string, string>;
  const statusBarContent = pitQuickActionDynamicIcon(actionType, state);

  const resolvedTitle = resolveTitleSettings(template, getGlobalTitleSettings(), settings.titleOverrides);

  const titleContent = resolvedTitle.showTitle
    ? generateTitleText({
        text: resolvedTitle.titleText,
        fontSize: resolvedTitle.fontSize,
        bold: resolvedTitle.bold,
        position: resolvedTitle.position,
        customPosition: resolvedTitle.customPosition,
        fill: colors.textColor ?? WHITE,
      })
    : "";

  // Determine toggle state for border color
  let toggleState: "on" | "off" | "na";

  if (actionType === "request-fast-repair") {
    if (state.fastRepairOn === undefined || state.fastRepairAvailable === false) {
      toggleState = "na";
    } else {
      toggleState = state.fastRepairOn ? "on" : "off";
    }
  } else if (state.windshieldOn === undefined) {
    toggleState = "na";
  } else {
    toggleState = state.windshieldOn ? "on" : "off";
  }

  const border = resolveBorderSettings(
    template,
    getGlobalBorderSettings(),
    settings.borderOverrides,
    borderColorForState(toggleState),
  );
  const borderSvg = generateBorderParts(border);

  // Status bar is always visible, even when graphics are off
  const svg = renderIconTemplate(template, {
    iconContent: statusBarContent,
    titleContent,
    borderDefs: borderSvg.defs,
    borderContent: borderSvg.rects,
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
    const { migrated, changed } = migrateLegacyActionToMode(ev.payload.settings);

    if (changed) {
      try {
        await ev.action.setSettings(migrated);
      } catch (error) {
        this.logger.warn(`Failed to persist migrated settings: ${error instanceof Error ? error.message : error}`);
      }
    }

    const settings = this.parseSettings(migrated);
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
    this.executeAction(settings.mode);
  }

  override async onDialDown(ev: IDeckDialDownEvent<PitQuickActionsSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeAction(settings.mode);
  }

  private parseSettings(settings: unknown): PitQuickActionsSettings {
    const { migrated } = migrateLegacyActionToMode(settings);
    const parsed = PitQuickActionsSettings.safeParse(migrated);

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

    if (!telemetry) {
      return state;
    }

    if (actionType === "windshield-tearoff") {
      state.windshieldOn = isWindshieldOn(telemetry);
    } else if (actionType === "request-fast-repair") {
      state.fastRepairOn = isFastRepairOn(telemetry);
      state.fastRepairAvailable = isFastRepairAvailable(telemetry);
    }

    return state;
  }

  private buildStateKey(settings: PitQuickActionsSettings, telemetryState: PitQuickActionTelemetryState): string {
    const bo = settings.borderOverrides;
    const borderKey = `${bo?.enabled ?? ""}|${bo?.borderWidth ?? ""}|${bo?.borderColor ?? ""}|${bo?.glowEnabled ?? ""}|${bo?.glowWidth ?? ""}`;

    switch (settings.mode) {
      case "windshield-tearoff":
        return `windshield|${telemetryState.windshieldOn ?? "na"}|${borderKey}`;
      case "request-fast-repair":
        return `fast-repair|${telemetryState.fastRepairOn ?? "na"}|${telemetryState.fastRepairAvailable ?? true}|${borderKey}`;
      default:
        return settings.mode;
    }
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<PitQuickActionsSettings> | IDeckDidReceiveSettingsEvent<PitQuickActionsSettings>,
    settings: PitQuickActionsSettings,
  ): Promise<void> {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const telemetryState = this.getTelemetryState(telemetry, settings.mode);
    const svgDataUri = generatePitQuickActionsSvg(settings, telemetryState);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => {
      const currentTelemetry = this.sdkController.getCurrentTelemetry();
      const currentState = this.getTelemetryState(currentTelemetry, settings.mode);

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
    if (!TELEMETRY_AWARE_ACTIONS.has(settings.mode)) return;

    const telemetryState = this.getTelemetryState(telemetry, settings.mode);
    const stateKey = this.buildStateKey(settings, telemetryState);
    const lastStateKey = this.lastState.get(contextId);

    if (lastStateKey !== stateKey) {
      this.lastState.set(contextId, stateKey);
      const svgDataUri = generatePitQuickActionsSvg(settings, telemetryState);
      await this.updateKeyImage(contextId, svgDataUri);
      this.setRegenerateCallback(contextId, () => {
        const currentTelemetry = this.sdkController.getCurrentTelemetry();
        const currentState = this.getTelemetryState(currentTelemetry, settings.mode);

        return generatePitQuickActionsSvg(settings, currentState);
      });
    }
  }
}
