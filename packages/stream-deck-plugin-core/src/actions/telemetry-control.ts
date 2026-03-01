import streamDeck, {
  action,
  DialDownEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import z from "zod";

import telemetryControlTemplate from "../../icons/telemetry-control.svg";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  getCommands,
  getGlobalSettings,
  getKeyboard,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  LogLevel,
  parseKeyBinding,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";

const WHITE = "#ffffff";
const GRAY = "#888888";
const RED = "#e74c3c";
const GREEN = "#2ecc71";
const YELLOW = "#f1c40f";

const ACTION_VALUES = [
  "toggle-logging",
  "mark-event",
  "start-recording",
  "stop-recording",
  "restart-recording",
] as const;

type TelemetryControlAction = (typeof ACTION_VALUES)[number];

/**
 * Label configuration for each telemetry control action (line1 bold, line2 subdued)
 */
const TELEMETRY_CONTROL_LABELS: Record<TelemetryControlAction, { line1: string; line2: string }> = {
  "toggle-logging": { line1: "LOGGING", line2: "TOGGLE" },
  "mark-event": { line1: "MARK", line2: "EVENT" },
  "start-recording": { line1: "RECORDING", line2: "START" },
  "stop-recording": { line1: "RECORDING", line2: "STOP" },
  "restart-recording": { line1: "RECORDING", line2: "RESTART" },
};

/**
 * SVG icon content for each telemetry control action
 */
const TELEMETRY_CONTROL_ICONS: Record<TelemetryControlAction, string> = {
  // Toggle Logging: Chart line with toggle indicator
  "toggle-logging": `
    <polyline points="14,28 22,18 30,24 38,12 46,20 54,10" fill="none"
              stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="54" cy="10" r="3" fill="${GREEN}"/>
    <line x1="14" y1="34" x2="58" y2="34" stroke="${GRAY}" stroke-width="0.8"/>`,

  // Mark Event: Flag marker on timeline
  "mark-event": `
    <line x1="14" y1="34" x2="58" y2="34" stroke="${GRAY}" stroke-width="0.8"/>
    <polyline points="18,34 18,28 22,28 26,34 26,28 30,28 34,34" fill="none"
              stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>
    <line x1="36" y1="34" x2="36" y2="10" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polygon points="36,10 48,16 36,22" fill="${YELLOW}"/>`,

  // Start Recording: Record circle with data lines
  "start-recording": `
    <circle cx="36" cy="20" r="10" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="20" r="5" fill="${RED}"/>
    <line x1="14" y1="34" x2="58" y2="34" stroke="${GRAY}" stroke-width="0.8"/>`,

  // Stop Recording: Stop square with data lines
  "stop-recording": `
    <circle cx="36" cy="20" r="10" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="30" y="14" width="12" height="12" fill="${WHITE}"/>
    <line x1="14" y1="34" x2="58" y2="34" stroke="${GRAY}" stroke-width="0.8"/>`,

  // Restart Recording: Circular restart arrow with record dot
  "restart-recording": `
    <path d="M36 10 A14 14 0 1 1 22 24" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="20,20 22,24 26,22" fill="none" stroke="${WHITE}" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="36" cy="24" r="4" fill="${RED}"/>`,
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

const TelemetryControlSettings = z.object({
  action: z.enum(ACTION_VALUES).default("toggle-logging"),
});

type TelemetryControlSettings = z.infer<typeof TelemetryControlSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the telemetry control action.
 */
export function generateTelemetryControlSvg(settings: TelemetryControlSettings): string {
  const { action: actionType } = settings;

  const iconContent = TELEMETRY_CONTROL_ICONS[actionType] || TELEMETRY_CONTROL_ICONS["toggle-logging"];
  const labels = TELEMETRY_CONTROL_LABELS[actionType] || TELEMETRY_CONTROL_LABELS["toggle-logging"];

  const svg = renderIconTemplate(telemetryControlTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Telemetry Control Action
 * Telemetry logging and recording controls for iRacing.
 * Toggle Logging and Mark Event use global key bindings;
 * Toggle Recording and Restart Recording use SDK telemetry commands.
 */
@action({ UUID: "com.iracedeck.sd.core.telemetry-control" })
export class TelemetryControl extends ConnectionStateAwareAction<TelemetryControlSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("TelemetryControl"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<TelemetryControlSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<TelemetryControlSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TelemetryControlSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<TelemetryControlSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAction(settings.action);
  }

  override async onDialDown(ev: DialDownEvent<TelemetryControlSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAction(settings.action);
  }

  private parseSettings(settings: unknown): TelemetryControlSettings {
    const parsed = TelemetryControlSettings.safeParse(settings);

    return parsed.success ? parsed.data : TelemetryControlSettings.parse({});
  }

  private async executeAction(actionType: TelemetryControlAction): Promise<void> {
    switch (actionType) {
      // Keyboard-based actions
      case "toggle-logging":
      case "mark-event":
        await this.executeKeyboardAction(actionType);
        break;

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

  private async executeKeyboardAction(actionType: TelemetryControlAction): Promise<void> {
    const settingKey = TELEMETRY_CONTROL_GLOBAL_KEYS[actionType];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for action: ${actionType}`);

      return;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return;
    }

    const combination: KeyCombination = {
      key: binding.key as KeyboardKey,
      modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
      code: binding.code,
    };

    const success = await getKeyboard().sendKeyCombination(combination);

    if (success) {
      this.logger.info("Key sent successfully");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to send key");
      this.logger.debug(`Failed key combination: ${formatKeyBinding(binding)}`);
    }
  }

  private async updateDisplay(
    ev: WillAppearEvent<TelemetryControlSettings> | DidReceiveSettingsEvent<TelemetryControlSettings>,
    settings: TelemetryControlSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateTelemetryControlSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
