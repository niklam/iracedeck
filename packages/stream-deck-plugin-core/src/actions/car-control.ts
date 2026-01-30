import streamDeck, {
  action,
  DialDownEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
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
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import carControlTemplate from "../../icons/car-control.svg";

const WHITE = "#ffffff";
const GRAY = "#888888";
const RED = "#e74c3c";

type CarControlType = "starter" | "ignition" | "pit-speed-limiter" | "enter-exit-tow" | "pause-sim";

/**
 * Label configuration for each car control (line1 bold, line2 subdued)
 */
const CAR_CONTROL_LABELS: Record<CarControlType, { line1: string; line2: string }> = {
  starter: { line1: "STARTER", line2: "CONTROL" },
  ignition: { line1: "IGNITION", line2: "CONTROL" },
  "pit-speed-limiter": { line1: "PIT SPEED", line2: "LIMITER" },
  "enter-exit-tow": { line1: "ENTER/EXIT", line2: "TOW CAR" },
  "pause-sim": { line1: "PAUSE", line2: "SIM" },
};

/**
 * SVG icon content for each car control
 */
const CAR_CONTROL_ICONS: Record<CarControlType, string> = {
  // Starter: Key turning / engine crank symbol
  starter: `
    <circle cx="36" cy="22" r="10" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <path d="M36 22 L46 22" stroke="${WHITE}" stroke-width="2"/>
    <path d="M46 22 L50 18" stroke="${WHITE}" stroke-width="2"/>
    <path d="M46 22 L50 26" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="36" cy="22" r="3" fill="${WHITE}"/>
    <path d="M26 32 L46 32" stroke="${RED}" stroke-width="1.5" stroke-dasharray="2 2"/>`,

  // Ignition: Power symbol
  ignition: `
    <circle cx="36" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <line x1="36" y1="12" x2="36" y2="24" stroke="${WHITE}" stroke-width="2.5"/>
    <circle cx="36" cy="24" r="4" fill="none" stroke="${RED}" stroke-width="1" opacity="0.6"/>`,

  // Pit Speed Limiter: Speed gauge with limit line
  "pit-speed-limiter": `
    <circle cx="36" cy="24" r="13" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="36" y1="24" x2="42" y2="15" stroke="${WHITE}" stroke-width="2"/>
    <line x1="22" y1="20" x2="50" y2="20" stroke="${RED}" stroke-width="2"/>
    <text x="36" y="34" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="6">PIT</text>`,

  // Enter/Exit/Tow Car: Car with door open / tow hook
  "enter-exit-tow": `
    <rect x="16" y="16" width="40" height="16" rx="5" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="24" cy="34" r="4" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="48" cy="34" r="4" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="22" y="12" width="12" height="8" rx="3" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <path d="M14 24 L10 24 L10 20" stroke="${RED}" stroke-width="1.5" fill="none"/>`,

  // Pause Sim: Pause symbol
  "pause-sim": `
    <rect x="26" y="12" width="6" height="24" rx="1" fill="${WHITE}"/>
    <rect x="40" y="12" width="6" height="24" rx="1" fill="${WHITE}"/>`,
};

/**
 * @internal Exported for testing
 *
 * Mapping from car control setting values (kebab-case) to global settings keys.
 */
export const CAR_CONTROL_GLOBAL_KEYS: Record<CarControlType, string> = {
  starter: "carControlStarter",
  ignition: "carControlIgnition",
  "pit-speed-limiter": "carControlPitSpeedLimiter",
  "enter-exit-tow": "carControlEnterExitTow",
  "pause-sim": "carControlPauseSim",
};

const CarControlSettings = z.object({
  control: z.enum(["starter", "ignition", "pit-speed-limiter", "enter-exit-tow", "pause-sim"]).default("starter"),
});

type CarControlSettings = z.infer<typeof CarControlSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the car control action.
 */
export function generateCarControlSvg(settings: CarControlSettings): string {
  const { control } = settings;

  const iconContent = CAR_CONTROL_ICONS[control] || CAR_CONTROL_ICONS["starter"];
  const labels = CAR_CONTROL_LABELS[control] || CAR_CONTROL_LABELS["starter"];

  const svg = renderIconTemplate(carControlTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Car Control Action
 * Activates car controls (starter, ignition, pit limiter, etc.) via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.car-control" })
export class CarControl extends ConnectionStateAwareAction<CarControlSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("CarControl"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<CarControlSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<CarControlSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CarControlSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(settings.control);
  }

  override async onDialDown(ev: DialDownEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(settings.control);
  }

  private parseSettings(settings: unknown): CarControlSettings {
    const parsed = CarControlSettings.safeParse(settings);

    return parsed.success ? parsed.data : CarControlSettings.parse({});
  }

  private async executeControl(control: CarControlType): Promise<void> {
    const settingKey = CAR_CONTROL_GLOBAL_KEYS[control];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for control: ${control}`);

      return;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return;
    }

    await this.sendKeyBinding(binding);
  }

  private async sendKeyBinding(binding: KeyBindingValue): Promise<void> {
    const combination: KeyCombination = {
      key: binding.key as KeyboardKey,
      modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
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
    ev: WillAppearEvent<CarControlSettings> | DidReceiveSettingsEvent<CarControlSettings>,
    settings: CarControlSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateCarControlSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
