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
import requestFastRepairIconSvg from "@iracedeck/icons/pit-quick-actions/request-fast-repair.svg";
import windshieldTearoffIconSvg from "@iracedeck/icons/pit-quick-actions/windshield-tearoff.svg";
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

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<PitQuickActionsSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
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
        const success = pit.windshield();
        this.logger.info("Windshield tearoff executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "request-fast-repair": {
        const success = pit.fastRepair();
        this.logger.info("Fast repair executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
    }
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<PitQuickActionsSettings> | IDeckDidReceiveSettingsEvent<PitQuickActionsSettings>,
    settings: PitQuickActionsSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generatePitQuickActionsSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generatePitQuickActionsSvg(settings));
  }
}
