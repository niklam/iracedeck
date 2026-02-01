import streamDeck, {
  action,
  DialDownEvent,
  DialUpEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  KeyUpEvent,
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
const YELLOW = "#f1c40f";
const RED = "#e74c3c";

type CarControlType = "starter" | "ignition" | "pit-speed-limiter" | "enter-exit-tow" | "pause-sim";

/**
 * Label configuration for each car control (line1 bold, line2 subdued)
 */
const CAR_CONTROL_LABELS: Record<CarControlType, { line1: string; line2: string }> = {
  starter: { line1: "STARTER", line2: "HOLD" },
  ignition: { line1: "IGNITION", line2: "TOGGLE" },
  "pit-speed-limiter": { line1: "PIT", line2: "LIMITER" },
  "enter-exit-tow": { line1: "ENTER/EXIT", line2: "TOW" },
  "pause-sim": { line1: "PAUSE", line2: "SIM" },
};

/**
 * SVG icon content for each car control
 */
const CAR_CONTROL_ICONS: Record<CarControlType, string> = {
  // Starter: Circular keyhole with crank arrow
  starter: `
    <circle cx="36" cy="22" r="10" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="22" r="3" fill="${WHITE}"/>
    <path d="M46 22 A10 10 0 0 1 36 32" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>
    <path d="M36 32 L38 28 M36 32 L32 30" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,

  // Ignition: Power symbol
  ignition: `
    <circle cx="36" cy="24" r="11" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <rect x="33" y="10" width="6" height="6" fill="#2a3a2a"/>
    <line x1="36" y1="12" x2="36" y2="26" stroke="${WHITE}" stroke-width="2.5" stroke-linecap="round"/>`,

  // Pit Speed Limiter: Speed limit circle with "PIT"
  "pit-speed-limiter": `
    <circle cx="36" cy="22" r="12" fill="none" stroke="${RED}" stroke-width="2"/>
    <line x1="44" y1="14" x2="28" y2="30" stroke="${RED}" stroke-width="2"/>
    <text x="36" y="24" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">PIT</text>`,

  // Enter/Exit/Tow: Car body with bidirectional arrow
  "enter-exit-tow": `
    <rect x="20" y="16" width="32" height="14" rx="4" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="28" cy="30" r="3" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <circle cx="44" cy="30" r="3" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <path d="M24 38 L48 38" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M24 38 L28 35 M24 38 L28 41" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M48 38 L44 35 M48 38 L44 41" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,

  // Pause Sim: Pause bars
  "pause-sim": `
    <rect x="27" y="14" width="6" height="20" rx="1" fill="${WHITE}"/>
    <rect x="39" y="14" width="6" height="20" rx="1" fill="${WHITE}"/>`,
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
 * Provides core car operation controls (starter, ignition, pit limiter, enter/exit/tow, pause).
 * Starter uses long-press (hold to crank); all others use tap.
 */
@action({ UUID: "com.iracedeck.sd.core.car-control" })
export class CarControl extends ConnectionStateAwareAction<CarControlSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("CarControl"), LogLevel.Info);

  /** Currently held key combinations per action context, tracked for cleanup on release/disappear */
  private heldCombinations = new Map<string, KeyCombination>();

  override async onWillAppear(ev: WillAppearEvent<CarControlSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<CarControlSettings>): Promise<void> {
    await this.releaseHeldKey(ev.action.id);
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
    await this.executeControl(ev.action.id, settings);
  }

  override async onKeyUp(ev: KeyUpEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Key up received");
    await this.releaseHeldKey(ev.action.id);
  }

  override async onDialDown(ev: DialDownEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(ev.action.id, settings);
  }

  override async onDialUp(ev: DialUpEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Dial up received");
    await this.releaseHeldKey(ev.action.id);
  }

  private parseSettings(settings: unknown): CarControlSettings {
    const parsed = CarControlSettings.safeParse(settings);

    return parsed.success ? parsed.data : CarControlSettings.parse({});
  }

  private async executeControl(actionId: string, settings: CarControlSettings): Promise<void> {
    if (settings.control === "starter") {
      await this.pressAndHold(actionId, settings.control);
    } else {
      await this.tapControl(settings.control);
    }
  }

  private async pressAndHold(actionId: string, control: CarControlType): Promise<void> {
    const resolved = this.resolveCombination(control);

    if (!resolved) {
      return;
    }

    const { combination, binding } = resolved;

    const success = await getKeyboard().pressKeyCombination(combination);

    if (success) {
      this.heldCombinations.set(actionId, combination);
      this.logger.info("Key pressed (holding)");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to press key");
    }
  }

  private async tapControl(control: CarControlType): Promise<void> {
    const resolved = this.resolveCombination(control);

    if (!resolved) {
      return;
    }

    const { combination, binding } = resolved;

    const success = await getKeyboard().sendKeyCombination(combination);

    if (success) {
      this.logger.info("Key sent successfully");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to send key");
      this.logger.debug(`Failed key combination: ${formatKeyBinding(binding)}`);
    }
  }

  private async releaseHeldKey(actionId: string): Promise<void> {
    const combination = this.heldCombinations.get(actionId);

    if (!combination) {
      return;
    }

    this.heldCombinations.delete(actionId);

    const success = await getKeyboard().releaseKeyCombination(combination);

    if (success) {
      this.logger.info("Key released");
    } else {
      this.logger.warn("Failed to release key");
    }
  }

  private resolveCombination(
    control: CarControlType,
  ): { combination: KeyCombination; binding: KeyBindingValue } | null {
    const settingKey = CAR_CONTROL_GLOBAL_KEYS[control];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for control: ${control}`);

      return null;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return null;
    }

    return {
      combination: {
        key: binding.key as KeyboardKey,
        modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
        code: binding.code,
      },
      binding,
    };
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
