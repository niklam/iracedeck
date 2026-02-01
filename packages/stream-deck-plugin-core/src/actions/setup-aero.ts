import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
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

import setupAeroTemplate from "../../icons/setup-aero.svg";

const WHITE = "#ffffff";
const GRAY = "#888888";
const YELLOW = "#f1c40f";

type SetupAeroSetting = "front-wing" | "rear-wing" | "qualifying-tape" | "rf-brake-attached";

type DirectionType = "increase" | "decrease";

/** Controls that have +/- direction */
const DIRECTIONAL_CONTROLS: Set<SetupAeroSetting> = new Set([
  "front-wing",
  "rear-wing",
  "qualifying-tape",
]);

/**
 * Label configuration for each setting + direction combination.
 * Standard layout: line1 = primary (bold, top), line2 = secondary (subdued, bottom).
 */
const SETUP_AERO_LABELS: Record<
  SetupAeroSetting,
  Record<DirectionType, { line1: string; line2: string }> | { line1: string; line2: string }
> = {
  "front-wing": {
    increase: { line1: "FRONT WING", line2: "INCREASE" },
    decrease: { line1: "FRONT WING", line2: "DECREASE" },
  },
  "rear-wing": {
    increase: { line1: "REAR WING", line2: "INCREASE" },
    decrease: { line1: "REAR WING", line2: "DECREASE" },
  },
  "qualifying-tape": {
    increase: { line1: "QUAL TAPE", line2: "INCREASE" },
    decrease: { line1: "QUAL TAPE", line2: "DECREASE" },
  },
  "rf-brake-attached": { line1: "RF BRAKE", line2: "TOGGLE" },
};

/**
 * SVG icon content for each setting.
 * Non-directional controls have a single icon; directional controls have per-direction variants.
 */
const SETUP_AERO_ICONS: Record<SetupAeroSetting, Record<DirectionType, string> | string> = {
  // Front Wing: wing/airfoil profile + directional arrow
  "front-wing": {
    increase: `
    <path d="M12,28 Q20,14 40,18 Q50,20 56,24" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="50" y1="22" x2="50" y2="34" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <path d="M12,28 Q20,14 40,18 Q50,20 56,24" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="50" y1="22" x2="50" y2="34" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="19,16 14,22 19,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Rear Wing: taller/steeper wing profile + directional arrow
  "rear-wing": {
    increase: `
    <path d="M16,30 Q20,10 36,14 Q46,16 52,22" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="48" y1="20" x2="48" y2="36" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="48" y1="36" x2="36" y2="36" stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <path d="M16,30 Q20,10 36,14 Q46,16 52,22" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="48" y1="20" x2="48" y2="36" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="48" y1="36" x2="36" y2="36" stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>
    <polyline points="19,16 14,22 19,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Qualifying Tape: horizontal tape strips over grille pattern + directional arrow
  "qualifying-tape": {
    increase: `
    <rect x="18" y="14" width="28" height="22" rx="3" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <line x1="18" y1="20" x2="46" y2="20" stroke="${GRAY}" stroke-width="0.5"/>
    <line x1="18" y1="26" x2="46" y2="26" stroke="${GRAY}" stroke-width="0.5"/>
    <line x1="18" y1="32" x2="46" y2="32" stroke="${GRAY}" stroke-width="0.5"/>
    <rect x="20" y="18" width="24" height="6" rx="1" fill="${YELLOW}" opacity="0.6"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="18" y="14" width="28" height="22" rx="3" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <line x1="18" y1="20" x2="46" y2="20" stroke="${GRAY}" stroke-width="0.5"/>
    <line x1="18" y1="26" x2="46" y2="26" stroke="${GRAY}" stroke-width="0.5"/>
    <line x1="18" y1="32" x2="46" y2="32" stroke="${GRAY}" stroke-width="0.5"/>
    <rect x="20" y="18" width="24" height="6" rx="1" fill="${YELLOW}" opacity="0.6"/>
    <polyline points="19,16 14,22 19,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // RF Brake Attached: Brake disc with "RF" text badge (no arrow)
  "rf-brake-attached": `
    <circle cx="36" cy="24" r="14" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="36" cy="24" r="7" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <text x="36" y="25" text-anchor="middle" dominant-baseline="central"
          fill="${YELLOW}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">RF</text>`,
};

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * Directional controls use composite keys (e.g., "front-wing-increase").
 */
export const SETUP_AERO_GLOBAL_KEYS: Record<string, string> = {
  "front-wing-increase": "setupAeroFrontWingIncrease",
  "front-wing-decrease": "setupAeroFrontWingDecrease",
  "rear-wing-increase": "setupAeroRearWingIncrease",
  "rear-wing-decrease": "setupAeroRearWingDecrease",
  "qualifying-tape-increase": "setupAeroQualifyingTapeIncrease",
  "qualifying-tape-decrease": "setupAeroQualifyingTapeDecrease",
  "rf-brake-attached": "setupAeroRfBrakeAttached",
};

const SetupAeroSettings = z.object({
  setting: z.enum(["front-wing", "rear-wing", "qualifying-tape", "rf-brake-attached"]).default("front-wing"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type SetupAeroSettings = z.infer<typeof SetupAeroSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup aero action.
 */
export function generateSetupAeroSvg(settings: SetupAeroSettings): string {
  const { setting, direction } = settings;

  const iconEntry = SETUP_AERO_ICONS[setting];
  const iconContent =
    typeof iconEntry === "string" ? iconEntry : (iconEntry?.[direction] ?? SETUP_AERO_ICONS["rf-brake-attached"]);

  const labelEntry = SETUP_AERO_LABELS[setting];
  const labels: { line1: string; line2: string } =
    "line1" in labelEntry ? labelEntry : (labelEntry[direction] ?? { line1: "AERO", line2: "SETUP" });

  const svg = renderIconTemplate(setupAeroTemplate, {
    iconContent: iconContent as string,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Setup Aero Action
 * Provides aerodynamic in-car adjustments (front wing, rear wing,
 * qualifying tape, RF brake attached) via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.setup-aero" })
export class SetupAero extends ConnectionStateAwareAction<SetupAeroSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("SetupAero"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<SetupAeroSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<SetupAeroSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SetupAeroSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<SetupAeroSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialDown(ev: DialDownEvent<SetupAeroSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialRotate(ev: DialRotateEvent<SetupAeroSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);

    // Non-directional controls have no +/- adjustment — ignore rotation
    if (!DIRECTIONAL_CONTROLS.has(settings.setting)) {
      this.logger.debug(`Rotation ignored for ${settings.setting}`);

      return;
    }

    // Clockwise (ticks > 0) = increase, Counter-clockwise (ticks < 0) = decrease
    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.executeSetting(settings.setting, direction);
  }

  private parseSettings(settings: unknown): SetupAeroSettings {
    const parsed = SetupAeroSettings.safeParse(settings);

    return parsed.success ? parsed.data : SetupAeroSettings.parse({});
  }

  private async executeSetting(setting: SetupAeroSetting, direction: DirectionType): Promise<void> {
    this.logger.info("Setting executed");
    this.logger.debug(`Executing ${setting} ${direction}`);

    const settingKey = this.resolveGlobalKey(setting, direction);

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

  private resolveGlobalKey(setting: SetupAeroSetting, direction: DirectionType): string | null {
    if (DIRECTIONAL_CONTROLS.has(setting)) {
      const key = `${setting}-${direction}`;

      return SETUP_AERO_GLOBAL_KEYS[key] ?? null;
    }

    return SETUP_AERO_GLOBAL_KEYS[setting] ?? null;
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
    ev: WillAppearEvent<SetupAeroSettings> | DidReceiveSettingsEvent<SetupAeroSettings>,
    settings: SetupAeroSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateSetupAeroSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
