import {
  CommonSettings,
  ConnectionStateAwareAction,
  getCommands,
  getGlobalColors,
  type IDeckDialDownEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "@iracedeck/deck-core";
import clearAllCheckboxesIconSvg from "@iracedeck/icons/pit-quick-actions/clear-all-checkboxes.svg";
import requestFastRepairIconSvg from "@iracedeck/icons/pit-quick-actions/request-fast-repair.svg";
import windshieldTearoffIconSvg from "@iracedeck/icons/pit-quick-actions/windshield-tearoff.svg";
import { hasFlag, PitSvFlags } from "@iracedeck/iracing-sdk";
import z from "zod";

type PitQuickActionType = "clear-all-checkboxes" | "windshield-tearoff" | "request-fast-repair";

const ACTION_ICONS: Record<PitQuickActionType, string> = {
  "clear-all-checkboxes": clearAllCheckboxesIconSvg,
  "windshield-tearoff": windshieldTearoffIconSvg,
  "request-fast-repair": requestFastRepairIconSvg,
};

/**
 * Label configuration for each pit quick action
 */
const PIT_QUICK_ACTION_LABELS: Record<PitQuickActionType, { mainLabel: string; subLabel: string }> = {
  "clear-all-checkboxes": { mainLabel: "CLEAR ALL", subLabel: "PIT" },
  "windshield-tearoff": { mainLabel: "WINDSHIELD", subLabel: "TEAROFF" },
  "request-fast-repair": { mainLabel: "FAST", subLabel: "REPAIR" },
};

const PitQuickActionsSettings = CommonSettings.extend({
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

  const iconSvg = ACTION_ICONS[actionType] || ACTION_ICONS["clear-all-checkboxes"];
  const labels = PIT_QUICK_ACTION_LABELS[actionType] || PIT_QUICK_ACTION_LABELS["clear-all-checkboxes"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Pit Quick Actions
 * Provides quick pit stop toggles (clear all, windshield tearoff, fast repair)
 * via iRacing SDK commands.
 */
export const PIT_QUICK_ACTIONS_UUID = "com.iracedeck.sd.core.pit-quick-actions" as const;

export class PitQuickActions extends ConnectionStateAwareAction<PitQuickActionsSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<PitQuickActionsSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<PitQuickActionsSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
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

        const isSet = hasFlag(telemetry.PitSvFlags, PitSvFlags.WindshieldTearoff);
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

        const isSet = hasFlag(telemetry.PitSvFlags, PitSvFlags.FastRepair);
        const success = isSet ? pit.clearFastRepair() : pit.fastRepair();
        this.logger.info("Fast repair toggled");
        this.logger.debug(`Action: ${isSet ? "cleared" : "requested"}, result: ${success}`);
        break;
      }
    }
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<PitQuickActionsSettings> | IDeckDidReceiveSettingsEvent<PitQuickActionsSettings>,
    settings: PitQuickActionsSettings,
  ): Promise<void> {
    const svgDataUri = generatePitQuickActionsSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generatePitQuickActionsSvg(settings));
  }
}
