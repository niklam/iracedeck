import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getCommands,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  migrateLegacyActionToMode,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import markEventIconSvg from "@iracedeck/icons/telemetry-control/mark-event.svg";
import restartRecordingIconSvg from "@iracedeck/icons/telemetry-control/restart-recording.svg";
import startRecordingIconSvg from "@iracedeck/icons/telemetry-control/start-recording.svg";
import stopRecordingIconSvg from "@iracedeck/icons/telemetry-control/stop-recording.svg";
import toggleLoggingIconSvg from "@iracedeck/icons/telemetry-control/toggle-logging.svg";
import z from "zod";

const ACTION_VALUES = [
  "toggle-logging",
  "mark-event",
  "start-recording",
  "stop-recording",
  "restart-recording",
] as const;

type TelemetryControlAction = (typeof ACTION_VALUES)[number];

const ACTION_ICONS: Record<TelemetryControlAction, string> = {
  "toggle-logging": toggleLoggingIconSvg,
  "mark-event": markEventIconSvg,
  "start-recording": startRecordingIconSvg,
  "stop-recording": stopRecordingIconSvg,
  "restart-recording": restartRecordingIconSvg,
};

/**
 * Title configuration for each telemetry control action
 */
const TELEMETRY_CONTROL_TITLES: Record<TelemetryControlAction, string> = {
  "toggle-logging": "TOGGLE\nLOGGING",
  "mark-event": "EVENT\nMARK",
  "start-recording": "RECORDING\nSTART",
  "stop-recording": "RECORDING\nSTOP",
  "restart-recording": "RECORDING\nRESTART",
};

/**
 * @internal Exported for testing
 *
 * Mapping from keyboard-based telemetry control actions to global settings keys.
 * SDK-based actions are NOT included.
 */
export const TELEMETRY_CONTROL_GLOBAL_KEYS: Record<string, string> = {
  "toggle-logging": "telemetryControlToggleLogging",
  "mark-event": "telemetryControlMarkEvent",
};

const TelemetryControlSettings = CommonSettings.extend({
  mode: z.enum(ACTION_VALUES).default("toggle-logging"),
});

type TelemetryControlSettings = z.infer<typeof TelemetryControlSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the telemetry control action.
 */
export function generateTelemetryControlSvg(settings: TelemetryControlSettings): string {
  const { mode: actionType } = settings;

  const iconSvg = ACTION_ICONS[actionType] || ACTION_ICONS["toggle-logging"];
  const defaultTitle = TELEMETRY_CONTROL_TITLES[actionType] || TELEMETRY_CONTROL_TITLES["toggle-logging"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
}

/**
 * Telemetry Control Action
 * Telemetry logging and recording controls for iRacing.
 * Toggle Logging and Mark Event use global key bindings;
 * Toggle Recording and Restart Recording use SDK telemetry commands.
 */
export const TELEMETRY_CONTROL_UUID = "com.iracedeck.sd.core.telemetry-control" as const;

export class TelemetryControl extends ConnectionStateAwareAction<TelemetryControlSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<TelemetryControlSettings>): Promise<void> {
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
    const activeKey = TELEMETRY_CONTROL_GLOBAL_KEYS[settings.mode];
    this.setActiveBinding(activeKey ?? null);

    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<TelemetryControlSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const activeKey = TELEMETRY_CONTROL_GLOBAL_KEYS[settings.mode];
    this.setActiveBinding(activeKey ?? null);

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<TelemetryControlSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAction(settings.mode);
  }

  override async onDialDown(ev: IDeckDialDownEvent<TelemetryControlSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAction(settings.mode);
  }

  private parseSettings(settings: unknown): TelemetryControlSettings {
    const { migrated } = migrateLegacyActionToMode(settings);
    const parsed = TelemetryControlSettings.safeParse(migrated);

    return parsed.success ? parsed.data : TelemetryControlSettings.parse({});
  }

  private async executeAction(actionType: TelemetryControlAction): Promise<void> {
    switch (actionType) {
      // Keyboard-based actions
      case "toggle-logging":
      case "mark-event": {
        const settingKey = TELEMETRY_CONTROL_GLOBAL_KEYS[actionType];

        if (!settingKey) {
          this.logger.warn(`No global key mapping for action: ${actionType}`);

          return;
        }

        await this.tapBinding(settingKey);
        break;
      }

      // SDK-based actions
      case "start-recording":
        this.executeSdkCommand(() => getCommands().telem.start(), "Start recording");
        break;
      case "stop-recording":
        this.executeSdkCommand(() => getCommands().telem.stop(), "Stop recording");
        break;
      case "restart-recording":
        this.executeSdkCommand(() => getCommands().telem.restart(), "Restart recording");
        break;
    }
  }

  private executeSdkCommand(command: () => boolean, label: string): void {
    const success = command();
    this.logger.info(`${label} executed`);
    this.logger.debug(`Result: ${success}`);
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<TelemetryControlSettings> | IDeckDidReceiveSettingsEvent<TelemetryControlSettings>,
    settings: TelemetryControlSettings,
  ): Promise<void> {
    const svgDataUri = generateTelemetryControlSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateTelemetryControlSvg(settings));
  }
}
