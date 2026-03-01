import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import z from "zod";

import setupEngineTemplate from "../../icons/setup-engine.svg";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  getGlobalSettings,
  getKeyboard,
  type KeyBindingValue,
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
const YELLOW = "#f1c40f";

type SetupEngineSetting = "engine-power" | "throttle-shaping" | "boost-level" | "launch-rpm";

type DirectionType = "increase" | "decrease";

/**
 * Label configuration for each setting + direction combination.
 * Standard layout: line1 = primary (bold, top), line2 = secondary (subdued, bottom).
 * All engine settings are directional (+/-).
 */
const SETUP_ENGINE_LABELS: Record<SetupEngineSetting, Record<DirectionType, { line1: string; line2: string }>> = {
  "engine-power": {
    increase: { line1: "ENG POWER", line2: "INCREASE" },
    decrease: { line1: "ENG POWER", line2: "DECREASE" },
  },
  "throttle-shaping": {
    increase: { line1: "THROTTLE", line2: "INCREASE" },
    decrease: { line1: "THROTTLE", line2: "DECREASE" },
  },
  "boost-level": {
    increase: { line1: "BOOST", line2: "INCREASE" },
    decrease: { line1: "BOOST", line2: "DECREASE" },
  },
  "launch-rpm": {
    increase: { line1: "LAUNCH RPM", line2: "INCREASE" },
    decrease: { line1: "LAUNCH RPM", line2: "DECREASE" },
  },
};

/**
 * SVG icon content for each setting.
 * All engine settings are directional with per-direction arrow variants.
 */
const SETUP_ENGINE_ICONS: Record<SetupEngineSetting, Record<DirectionType, string>> = {
  // Engine Power: Engine block with lightning bolt + directional arrow
  "engine-power": {
    increase: `
    <rect x="16" y="14" width="28" height="20" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="22" y1="14" x2="22" y2="10" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="30" y1="14" x2="30" y2="10" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="38" y1="14" x2="38" y2="10" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="27,20 30,26 27,26 30,32" fill="none" stroke="${YELLOW}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="16" y="14" width="28" height="20" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="22" y1="14" x2="22" y2="10" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="30" y1="14" x2="30" y2="10" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="38" y1="14" x2="38" y2="10" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="27,20 30,26 27,26 30,32" fill="none" stroke="${YELLOW}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Throttle Shaping: Throttle response curve + directional arrow
  "throttle-shaping": {
    increase: `
    <rect x="14" y="12" width="30" height="24" rx="2" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <path d="M16,34 Q28,32 32,18 L42,18" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="14" y="12" width="30" height="24" rx="2" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <path d="M16,34 Q28,32 32,18 L42,18" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Boost Level: Turbo gauge with needle + directional arrow
  "boost-level": {
    increase: `
    <path d="M18,34 A16,16 0 0,1 50,34" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="34" y1="34" x2="26" y2="20" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>
    <circle cx="34" cy="34" r="2" fill="${WHITE}"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <path d="M18,34 A16,16 0 0,1 50,34" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="34" y1="34" x2="26" y2="20" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>
    <circle cx="34" cy="34" r="2" fill="${WHITE}"/>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Launch RPM: Tachometer arc with RPM needle + directional arrow
  "launch-rpm": {
    increase: `
    <path d="M16,36 A20,20 0 0,1 52,36" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="20" y1="32" x2="20" y2="28" stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>
    <line x1="28" y1="22" x2="28" y2="18" stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>
    <line x1="38" y1="20" x2="38" y2="16" stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>
    <line x1="46" y1="26" x2="46" y2="22" stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>
    <line x1="34" y1="36" x2="42" y2="22" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <circle cx="34" cy="36" r="2" fill="${WHITE}"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <path d="M16,36 A20,20 0 0,1 52,36" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="20" y1="32" x2="20" y2="28" stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>
    <line x1="28" y1="22" x2="28" y2="18" stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>
    <line x1="38" y1="20" x2="38" y2="16" stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>
    <line x1="46" y1="26" x2="46" y2="22" stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>
    <line x1="34" y1="36" x2="42" y2="22" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <circle cx="34" cy="36" r="2" fill="${WHITE}"/>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
};

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * All engine settings are directional, using composite keys (e.g., "engine-power-increase").
 */
export const SETUP_ENGINE_GLOBAL_KEYS: Record<string, string> = {
  "engine-power-increase": "setupEngineEnginePowerIncrease",
  "engine-power-decrease": "setupEngineEnginePowerDecrease",
  "throttle-shaping-increase": "setupEngineThrottleShapingIncrease",
  "throttle-shaping-decrease": "setupEngineThrottleShapingDecrease",
  "boost-level-increase": "setupEngineBoostLevelIncrease",
  "boost-level-decrease": "setupEngineBoostLevelDecrease",
  "launch-rpm-increase": "setupEngineLaunchRpmIncrease",
  "launch-rpm-decrease": "setupEngineLaunchRpmDecrease",
};

const SetupEngineSettings = z.object({
  setting: z.enum(["engine-power", "throttle-shaping", "boost-level", "launch-rpm"]).default("engine-power"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type SetupEngineSettings = z.infer<typeof SetupEngineSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup engine action.
 */
export function generateSetupEngineSvg(settings: SetupEngineSettings): string {
  const { setting, direction } = settings;

  const iconContent = SETUP_ENGINE_ICONS[setting]?.[direction] ?? SETUP_ENGINE_ICONS["engine-power"].increase;

  const labels = SETUP_ENGINE_LABELS[setting]?.[direction] ?? { line1: "ENGINE", line2: "SETUP" };

  const svg = renderIconTemplate(setupEngineTemplate, {
    iconContent: iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Setup Engine Action
 * Provides engine-related in-car adjustments (engine power, throttle shaping,
 * boost level, launch RPM) via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.setup-engine" })
export class SetupEngine extends ConnectionStateAwareAction<SetupEngineSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("SetupEngine"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<SetupEngineSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<SetupEngineSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SetupEngineSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<SetupEngineSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialDown(ev: DialDownEvent<SetupEngineSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialRotate(ev: DialRotateEvent<SetupEngineSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);

    // Clockwise (ticks > 0) = increase, Counter-clockwise (ticks < 0) = decrease
    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.executeSetting(settings.setting, direction);
  }

  private parseSettings(settings: unknown): SetupEngineSettings {
    const parsed = SetupEngineSettings.safeParse(settings);

    return parsed.success ? parsed.data : SetupEngineSettings.parse({});
  }

  private async executeSetting(setting: SetupEngineSetting, direction: DirectionType): Promise<void> {
    this.logger.info("Setting executed");
    this.logger.debug(`Executing ${setting} ${direction}`);

    const settingKey = SETUP_ENGINE_GLOBAL_KEYS[`${setting}-${direction}`];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${setting} ${direction}`);

      return;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return;
    }

    this.logger.debug(`Key binding for ${settingKey}: ${formatKeyBinding(binding)} (code=${binding.code ?? "none"})`);

    await this.sendKeyBinding(binding);
  }

  private async sendKeyBinding(binding: KeyBindingValue): Promise<void> {
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
    ev: WillAppearEvent<SetupEngineSettings> | DidReceiveSettingsEvent<SetupEngineSettings>,
    settings: SetupEngineSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateSetupEngineSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
