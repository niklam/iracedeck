import streamDeck, {
  action,
  DialRotateEvent,
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

import blackBoxSelectorTemplate from "../../icons/black-box-selector.svg";

const WHITE = "#ffffff";
const GRAY = "#888888";
const YELLOW = "#f39c12";
const ORANGE = "#e67e22";
const GREEN = "#2ecc71";
const BLUE = "#3498db";
const RED = "#e74c3c";

/**
 * Black box label configuration (line1, line2)
 */
const BLACK_BOX_LABELS: Record<string, { line1: string; line2: string }> = {
  "lap-timing": { line1: "LAP TIMING", line2: "TOGGLE" },
  standings: { line1: "STANDINGS", line2: "TOGGLE" },
  relative: { line1: "RELATIVE", line2: "TOGGLE" },
  fuel: { line1: "FUEL", line2: "ADJUSTMENTS" },
  tires: { line1: "TIRES", line2: "ADJUSTMENTS" },
  "tire-info": { line1: "TIRE INFO", line2: "TOGGLE" },
  "pit-stop": { line1: "PIT-STOP", line2: "ADJUSTMENTS" },
  "in-car": { line1: "IN-CAR", line2: "ADJUSTMENTS" },
  mirror: { line1: "GRAPHICS", line2: "ADJUSTMENTS" },
  radio: { line1: "RADIO", line2: "CHANNELS" },
  weather: { line1: "WEATHER", line2: "FORECAST" },
};

/**
 * SVG icon content for each black box type
 * Styled to match THK reference icons
 */
const BLACK_BOX_ICONS: Record<string, string> = {
  // Lap Timing: Time display rows inside black box frame
  "lap-timing": `
    <rect x="8" y="8" width="56" height="28" rx="3" fill="#2d2510" stroke="#4a3728" stroke-width="2"/>
    <text x="12" y="15" fill="${GRAY}" font-family="Arial, sans-serif" font-size="5">LAP</text>
    <text x="32" y="15" fill="${YELLOW}" font-family="Arial, sans-serif" font-size="6" font-weight="bold">1:23.456</text>
    <text x="12" y="22" fill="${GRAY}" font-family="Arial, sans-serif" font-size="5">LAST</text>
    <text x="32" y="22" fill="${WHITE}" font-family="Arial, sans-serif" font-size="6">1:24.012</text>
    <text x="12" y="29" fill="${GRAY}" font-family="Arial, sans-serif" font-size="5">BEST</text>
    <text x="32" y="29" fill="${GREEN}" font-family="Arial, sans-serif" font-size="6" font-weight="bold">1:22.891</text>
    <rect x="12" y="32" width="48" height="1" fill="${WHITE}" opacity="0.3"/>`,

  // Standings: List with horizontal lines and position dots inside a black box frame
  // Icon area: y=9 to y=43
  standings: `
    <rect x="8" y="8" width="56" height="28" rx="3" fill="#2d2510" stroke="#4a3728" stroke-width="2"/>
    <circle cx="14" cy="12" r="1.5" fill="${YELLOW}"/>
    <rect x="18" y="11" width="42" height="1.5" rx="0.5" fill="${WHITE}"/>
    <circle cx="14" cy="16" r="1.5" fill="${YELLOW}" opacity="0.85"/>
    <rect x="18" y="15" width="36" height="1.5" rx="0.5" fill="${WHITE}"/>
    <circle cx="14" cy="20" r="1.5" fill="${YELLOW}" opacity="0.7"/>
    <rect x="18" y="19" width="40" height="1.5" rx="0.5" fill="${WHITE}"/>
    <circle cx="14" cy="24" r="1.5" fill="${YELLOW}" opacity="0.55"/>
    <rect x="18" y="23" width="32" height="1.5" rx="0.5" fill="${WHITE}"/>
    <circle cx="14" cy="28" r="1.5" fill="${YELLOW}" opacity="0.4"/>
    <rect x="18" y="27" width="38" height="1.5" rx="0.5" fill="${WHITE}"/>
    <circle cx="14" cy="32" r="1.5" fill="${YELLOW}" opacity="0.25"/>
    <rect x="18" y="31" width="34" height="1.5" rx="0.5" fill="${WHITE}"/>`,

  // Relative: Colored position rows inside black box frame (yellow/orange ahead, white=you, green behind)
  relative: `
    <rect x="8" y="8" width="56" height="28" rx="3" fill="#2d2510" stroke="#4a3728" stroke-width="2"/>
    <rect x="12" y="11" width="4" height="3" rx="0.5" fill="${YELLOW}"/>
    <rect x="18" y="11" width="42" height="3" rx="0.5" fill="${WHITE}" opacity="0.7"/>
    <rect x="12" y="16" width="4" height="3" rx="0.5" fill="${ORANGE}"/>
    <rect x="18" y="16" width="38" height="3" rx="0.5" fill="${WHITE}" opacity="0.7"/>
    <rect x="12" y="21" width="4" height="3" rx="0.5" fill="${WHITE}"/>
    <rect x="18" y="21" width="44" height="3" rx="0.5" fill="${WHITE}"/>
    <rect x="12" y="26" width="4" height="3" rx="0.5" fill="${GREEN}"/>
    <rect x="18" y="26" width="36" height="3" rx="0.5" fill="${WHITE}" opacity="0.7"/>
    <rect x="12" y="31" width="4" height="3" rx="0.5" fill="${GREEN}" opacity="0.7"/>
    <rect x="18" y="31" width="40" height="3" rx="0.5" fill="${WHITE}" opacity="0.5"/>`,

  // Fuel: Fuel pump icon inside black box frame
  fuel: `
    <rect x="8" y="8" width="56" height="28" rx="3" fill="#2d2510" stroke="#4a3728" stroke-width="2"/>
    <rect x="18" y="14" width="12" height="16" rx="1" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <rect x="20" y="16" width="8" height="5" fill="${GRAY}"/>
    <path d="M30 18 h6 a2 2 0 0 1 2 2 v7 a2.5 2.5 0 0 1 -5 0 v-3" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <circle cx="34" cy="19" r="1.5" fill="${GRAY}"/>
    <rect x="22" y="12" width="4" height="2" fill="${GRAY}"/>
    <text x="46" y="20" fill="${YELLOW}" font-family="Arial, sans-serif" font-size="6" font-weight="bold">12.5</text>
    <text x="46" y="28" fill="${GRAY}" font-family="Arial, sans-serif" font-size="5">GAL</text>`,

  // Tires: Tire icon inside black box frame
  tires: `
    <rect x="8" y="8" width="56" height="28" rx="3" fill="#2d2510" stroke="#4a3728" stroke-width="2"/>
    <circle cx="28" cy="22" r="10" fill="none" stroke="${GRAY}" stroke-width="2"/>
    <circle cx="28" cy="22" r="5" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <circle cx="28" cy="22" r="2" fill="${GRAY}"/>
    <text x="46" y="18" fill="${WHITE}" font-family="Arial, sans-serif" font-size="5">FL</text>
    <text x="46" y="26" fill="${GREEN}" font-family="Arial, sans-serif" font-size="6" font-weight="bold">98%</text>
    <text x="46" y="33" fill="${GRAY}" font-family="Arial, sans-serif" font-size="4">WEAR</text>`,

  // Tire Info: Tire with colored temperature arc inside black box frame
  "tire-info": `
    <rect x="8" y="8" width="56" height="28" rx="3" fill="#2d2510" stroke="#4a3728" stroke-width="2"/>
    <circle cx="28" cy="22" r="10" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <circle cx="28" cy="22" r="5" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <path d="M18 22 A10 10 0 0 1 21 14" fill="none" stroke="${BLUE}" stroke-width="3" stroke-linecap="round"/>
    <path d="M21 14 A10 10 0 0 1 28 12" fill="none" stroke="${GREEN}" stroke-width="3" stroke-linecap="round"/>
    <path d="M28 12 A10 10 0 0 1 35 14" fill="none" stroke="${YELLOW}" stroke-width="3" stroke-linecap="round"/>
    <path d="M35 14 A10 10 0 0 1 38 22" fill="none" stroke="${RED}" stroke-width="3" stroke-linecap="round"/>
    <text x="48" y="18" fill="${WHITE}" font-family="Arial, sans-serif" font-size="5">TEMP</text>
    <text x="48" y="27" fill="${GREEN}" font-family="Arial, sans-serif" font-size="7" font-weight="bold">85°</text>`,

  // Pit-stop: Wrench icon inside black box frame
  "pit-stop": `
    <rect x="8" y="8" width="56" height="28" rx="3" fill="#2d2510" stroke="#4a3728" stroke-width="2"/>
    <path d="M16 28 l4 -4 l-2 -2 l8 -8 l3 3 l-8 8 l2 2 l-4 4 z" fill="${GRAY}"/>
    <circle cx="30" cy="14" r="4" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <path d="M27 14 h6 M30 11 v6" stroke="${GRAY}" stroke-width="1"/>
    <text x="42" y="16" fill="${WHITE}" font-family="Arial, sans-serif" font-size="5">FUEL</text>
    <text x="42" y="23" fill="${YELLOW}" font-family="Arial, sans-serif" font-size="5" font-weight="bold">+10.5</text>
    <text x="42" y="30" fill="${GREEN}" font-family="Arial, sans-serif" font-size="5">TIRES ✓</text>`,

  // In-car: Steering wheel with gear inside black box frame
  "in-car": `
    <rect x="8" y="8" width="56" height="28" rx="3" fill="#2d2510" stroke="#4a3728" stroke-width="2"/>
    <circle cx="24" cy="22" r="9" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <circle cx="24" cy="22" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="24" y1="18" x2="24" y2="13" stroke="${GRAY}" stroke-width="1.5"/>
    <line x1="20" y1="25" x2="16" y2="28" stroke="${GRAY}" stroke-width="1.5"/>
    <line x1="28" y1="25" x2="32" y2="28" stroke="${GRAY}" stroke-width="1.5"/>
    <text x="42" y="16" fill="${WHITE}" font-family="Arial, sans-serif" font-size="5">BIAS</text>
    <text x="42" y="24" fill="${YELLOW}" font-family="Arial, sans-serif" font-size="6" font-weight="bold">52.0%</text>
    <text x="42" y="31" fill="${GRAY}" font-family="Arial, sans-serif" font-size="4">FRONT</text>`,

  // Mirror: Rearview mirror inside black box frame (attached from top)
  mirror: `
    <rect x="8" y="8" width="56" height="28" rx="3" fill="#2d2510" stroke="#4a3728" stroke-width="2"/>
    <rect x="34" y="11" width="4" height="4" fill="${GRAY}"/>
    <rect x="14" y="15" width="44" height="14" rx="2" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <rect x="16" y="17" width="40" height="10" rx="1" fill="${GRAY}" opacity="0.2"/>
    <line x1="20" y1="18" x2="26" y2="24" stroke="${WHITE}" stroke-width="1.5" opacity="0.5"/>
    <line x1="24" y1="18" x2="30" y2="24" stroke="${WHITE}" stroke-width="1" opacity="0.3"/>
    <line x1="42" y1="18" x2="48" y2="24" stroke="${WHITE}" stroke-width="1.5" opacity="0.5"/>
    <line x1="46" y1="18" x2="52" y2="24" stroke="${WHITE}" stroke-width="1" opacity="0.3"/>`,

  // Radio: Headset inside black box frame
  radio: `
    <rect x="8" y="8" width="56" height="28" rx="3" fill="#2d2510" stroke="#4a3728" stroke-width="2"/>
    <path d="M14 22 a10 10 0 0 1 20 0" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <rect x="12" y="20" width="5" height="9" rx="2" fill="${GRAY}"/>
    <rect x="31" y="20" width="5" height="9" rx="2" fill="${GRAY}"/>
    <path d="M14 29 q0 4 5 4 h2" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <ellipse cx="22" cy="33" rx="2" ry="1.5" fill="${GRAY}"/>
    <text x="44" y="16" fill="${WHITE}" font-family="Arial, sans-serif" font-size="5">CH</text>
    <text x="44" y="25" fill="${GREEN}" font-family="Arial, sans-serif" font-size="6" font-weight="bold">ALL</text>`,

  // Weather: Sun and cloud inside black box frame
  weather: `
    <rect x="8" y="8" width="56" height="28" rx="3" fill="#2d2510" stroke="#4a3728" stroke-width="2"/>
    <circle cx="20" cy="18" r="5" fill="${YELLOW}"/>
    <circle cx="24" cy="26" r="4" fill="${GRAY}"/>
    <circle cx="30" cy="24" r="5" fill="${GRAY}"/>
    <circle cx="36" cy="26" r="4" fill="${GRAY}"/>
    <rect x="22" y="26" width="16" height="5" fill="${GRAY}"/>
    <text x="48" y="18" fill="${WHITE}" font-family="Arial, sans-serif" font-size="5">TRACK</text>
    <text x="48" y="27" fill="${GREEN}" font-family="Arial, sans-serif" font-size="6" font-weight="bold">24°C</text>`,
};

/**
 * SVG icon content for cycle modes (next/previous)
 */
const CYCLE_MODE_ICONS: Record<string, string> = {
  // Next: Up arrow with screen rows
  next: `
    <rect x="18" y="32" width="36" height="4" rx="1" fill="${WHITE}" opacity="0.4"/>
    <rect x="18" y="38" width="36" height="4" rx="1" fill="${WHITE}" opacity="0.5"/>
    <rect x="18" y="44" width="36" height="4" rx="1" fill="${WHITE}" opacity="0.6"/>
    <path d="M36 10 l-14 16 h9 v6 h10 v-6 h9 z" fill="${WHITE}"/>`,

  // Previous: Down arrow with screen rows
  previous: `
    <rect x="18" y="10" width="36" height="4" rx="1" fill="${WHITE}" opacity="0.4"/>
    <rect x="18" y="16" width="36" height="4" rx="1" fill="${WHITE}" opacity="0.5"/>
    <rect x="18" y="22" width="36" height="4" rx="1" fill="${WHITE}" opacity="0.6"/>
    <path d="M36 48 l-14 -16 h9 v-6 h10 v6 h9 z" fill="${WHITE}"/>`,
};

/**
 * Mapping from blackBox setting values (kebab-case) to global settings keys
 */
const BLACK_BOX_GLOBAL_KEYS: Record<string, string> = {
  "lap-timing": "blackBoxLapTiming",
  standings: "blackBoxStandings",
  relative: "blackBoxRelative",
  fuel: "blackBoxFuel",
  tires: "blackBoxTires",
  "tire-info": "blackBoxTireInfo",
  "pit-stop": "blackBoxPitStop",
  "in-car": "blackBoxInCar",
  mirror: "blackBoxMirror",
  radio: "blackBoxRadio",
  weather: "blackBoxWeather",
};

const BlackBoxSelectorSettings = z.object({
  mode: z.enum(["direct", "next", "previous"]).default("direct"),
  blackBox: z
    .enum([
      "lap-timing",
      "standings",
      "relative",
      "fuel",
      "tires",
      "tire-info",
      "pit-stop",
      "in-car",
      "mirror",
      "radio",
      "weather",
    ])
    .default("lap-timing"),
});

type BlackBoxSelectorSettings = z.infer<typeof BlackBoxSelectorSettings>;

/**
 * Global settings keys for cycle actions
 */
const GLOBAL_KEYS = {
  CYCLE_NEXT: "blackBoxCycleNext",
  CYCLE_PREVIOUS: "blackBoxCyclePrevious",
} as const;

/**
 * Get icon content based on mode and black box selection
 */
function getIconContent(mode: string, blackBox: string): string {
  if (mode === "next") {
    return CYCLE_MODE_ICONS.next;
  } else if (mode === "previous") {
    return CYCLE_MODE_ICONS.previous;
  } else {
    return BLACK_BOX_ICONS[blackBox] || BLACK_BOX_ICONS["lap-timing"];
  }
}

/**
 * Get label text based on mode and black box selection
 */
function getLabels(mode: string, blackBox: string): { line1: string; line2: string } {
  if (mode === "next") {
    return { line1: "NEXT", line2: "BLACK BOX" };
  } else if (mode === "previous") {
    return { line1: "PREVIOUS", line2: "BLACK BOX" };
  } else {
    return BLACK_BOX_LABELS[blackBox] || { line1: "BLACK BOX", line2: "TOGGLE" };
  }
}

/**
 * Generates an SVG icon for the black box selector action.
 */
function generateBlackBoxSelectorSvg(settings: BlackBoxSelectorSettings): string {
  const { mode, blackBox } = settings;

  const iconContent = getIconContent(mode, blackBox);
  const labels = getLabels(mode, blackBox);

  const svg = renderIconTemplate(blackBoxSelectorTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Black Box Selector Action
 * Cycles through or directly selects iRacing black box screens via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.black-box-selector" })
export class BlackBoxSelector extends ConnectionStateAwareAction<BlackBoxSelectorSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("BlackBoxSelector"), LogLevel.Info);

  /**
   * When the action appears on the Stream Deck
   */
  override async onWillAppear(ev: WillAppearEvent<BlackBoxSelectorSettings>): Promise<void> {
    const parsed = BlackBoxSelectorSettings.safeParse(ev.payload.settings);
    const settings = parsed.success ? parsed.data : BlackBoxSelectorSettings.parse({});

    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  /**
   * When the action disappears from the Stream Deck
   */
  override async onWillDisappear(ev: WillDisappearEvent<BlackBoxSelectorSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  /**
   * Update display with current settings
   */
  private async updateDisplay(
    ev: WillAppearEvent<BlackBoxSelectorSettings> | any,
    settings: BlackBoxSelectorSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateBlackBoxSelectorSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }

  /**
   * When settings are received or updated
   */
  override async onDidReceiveSettings(ev: any): Promise<void> {
    const parsed = BlackBoxSelectorSettings.safeParse(ev.payload.settings);
    const settings = parsed.success ? parsed.data : BlackBoxSelectorSettings.parse({});

    await this.updateDisplay(ev, settings);
  }

  /**
   * When the key is pressed
   */
  override async onKeyDown(ev: KeyDownEvent<BlackBoxSelectorSettings>): Promise<void> {
    this.logger.info("Key down received");

    const parsed = BlackBoxSelectorSettings.safeParse(ev.payload.settings);
    const settings = parsed.success ? parsed.data : BlackBoxSelectorSettings.parse({});

    const { mode, blackBox } = settings;
    const globalSettings = getGlobalSettings() as Record<string, unknown>;

    let settingKey: string;

    if (mode === "direct") {
      settingKey = BLACK_BOX_GLOBAL_KEYS[blackBox];
    } else if (mode === "next") {
      settingKey = GLOBAL_KEYS.CYCLE_NEXT;
    } else {
      settingKey = GLOBAL_KEYS.CYCLE_PREVIOUS;
    }

    const binding = parseKeyBinding(globalSettings[settingKey]);

    this.logger.info(`Looking for key: ${settingKey}, found: ${JSON.stringify(binding)}`);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return;
    }

    await this.sendKeyBinding(binding);
  }

  /**
   * Send a key binding via the keyboard interface
   */
  private async sendKeyBinding(binding: KeyBindingValue): Promise<void> {
    const combination: KeyCombination = {
      key: binding.key as KeyboardKey,
      modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
    };

    this.logger.debug(`Sending key combination: ${JSON.stringify(combination)}`);

    const keyboard = getKeyboard();

    if (!keyboard) {
      this.logger.error("Keyboard interface not available");

      return;
    }

    const success = await keyboard.sendKeyCombination(combination);

    if (success) {
      this.logger.info("Key sent successfully");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to send key");
      this.logger.debug(`Failed key combination: ${formatKeyBinding(binding)}`);
    }
  }

  /**
   * When the encoder dial is rotated (Stream Deck+)
   */
  override async onDialRotate(ev: DialRotateEvent<BlackBoxSelectorSettings>): Promise<void> {
    this.logger.info(`Dial rotated: ${ev.payload.ticks} ticks`);

    const globalSettings = getGlobalSettings() as Record<string, unknown>;

    // Clockwise (ticks > 0) = next, Counter-clockwise (ticks < 0) = previous
    const settingKey = ev.payload.ticks > 0 ? GLOBAL_KEYS.CYCLE_NEXT : GLOBAL_KEYS.CYCLE_PREVIOUS;

    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return;
    }

    await this.sendKeyBinding(binding);
  }
}
