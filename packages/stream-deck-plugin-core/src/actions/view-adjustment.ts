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

import viewAdjustmentTemplate from "../../icons/view-adjustment.svg";

const WHITE = "#ffffff";
const GRAY = "#888888";

type AdjustmentType = "fov" | "horizon" | "driver-height" | "recenter-vr" | "ui-size";
type DirectionType = "increase" | "decrease";

/**
 * Label configuration for each adjustment + direction combination.
 * Inverted layout: line1 = primary (bold, bottom), line2 = secondary (subdued, top).
 */
const VIEW_ADJUSTMENT_LABELS: Record<AdjustmentType, Record<DirectionType, { line1: string; line2: string }>> = {
  fov: {
    increase: { line1: "INCREASE", line2: "FOV" },
    decrease: { line1: "DECREASE", line2: "FOV" },
  },
  horizon: {
    increase: { line1: "UP", line2: "HORIZON" },
    decrease: { line1: "DOWN", line2: "HORIZON" },
  },
  "driver-height": {
    increase: { line1: "UP", line2: "DRIVER HEIGHT" },
    decrease: { line1: "DOWN", line2: "DRIVER HEIGHT" },
  },
  "recenter-vr": {
    increase: { line1: "RECENTER", line2: "VR VIEW" },
    decrease: { line1: "RECENTER", line2: "VR VIEW" },
  },
  "ui-size": {
    increase: { line1: "INCREASE", line2: "UI SIZE" },
    decrease: { line1: "DECREASE", line2: "UI SIZE" },
  },
};

/**
 * SVG icon content for each adjustment type.
 * FOV, Horizon, and Driver Height show directional variants; Recenter VR and UI Size are non-directional.
 */
const VIEW_ADJUSTMENT_ICONS: Record<AdjustmentType, Record<DirectionType, string>> = {
  // FOV: Upward-opening viewing angle — wide for increase, narrow for decrease
  fov: {
    increase: `
    <circle cx="36" cy="34" r="3" fill="${WHITE}"/>
    <line x1="36" y1="31" x2="14" y2="12" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="36" y1="31" x2="58" y2="12" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="14" y1="12" x2="58" y2="12" stroke="${GRAY}" stroke-width="1" stroke-dasharray="2,2"/>`,
    decrease: `
    <circle cx="36" cy="34" r="3" fill="${WHITE}"/>
    <line x1="36" y1="31" x2="24" y2="12" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="36" y1="31" x2="48" y2="12" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="24" y1="12" x2="48" y2="12" stroke="${GRAY}" stroke-width="1" stroke-dasharray="2,2"/>`,
  },
  // Horizon: Viewport frame with horizon line positioned high (up) or low (down)
  horizon: {
    increase: `
    <rect x="14" y="10" width="44" height="30" rx="3" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <line x1="16" y1="18" x2="56" y2="18" stroke="${WHITE}" stroke-width="2"/>
    <line x1="52" y1="30" x2="52" y2="22" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="49,25 52,22 55,25" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="14" y="10" width="44" height="30" rx="3" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <line x1="16" y1="32" x2="56" y2="32" stroke="${WHITE}" stroke-width="2"/>
    <line x1="52" y1="16" x2="52" y2="24" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="49,21 52,24 55,21" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  // Driver Height: Short→tall figures for up, tall→short for down
  "driver-height": {
    increase: `
    <circle cx="18" cy="20" r="2.5" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <line x1="18" y1="23" x2="18" y2="29" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="14" y1="25" x2="22" y2="25" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="18" y1="29" x2="15" y2="34" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="18" y1="29" x2="21" y2="34" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="32" y1="24" x2="40" y2="24" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="37,21 40,24 37,27" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="54" cy="14" r="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="54" y1="17" x2="54" y2="28" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="49" y1="22" x2="59" y2="22" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="54" y1="28" x2="50" y2="34" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="54" y1="28" x2="58" y2="34" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>`,
    decrease: `
    <circle cx="18" cy="14" r="3" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <line x1="18" y1="17" x2="18" y2="28" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="22" x2="23" y2="22" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="18" y1="28" x2="14" y2="34" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="18" y1="28" x2="22" y2="34" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="32" y1="24" x2="40" y2="24" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="37,21 40,24 37,27" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="54" cy="20" r="2.5" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="54" y1="23" x2="54" y2="29" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="50" y1="25" x2="58" y2="25" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="54" y1="29" x2="51" y2="34" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="54" y1="29" x2="57" y2="34" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>`,
  },
  // Recenter VR: VR headset with crosshair (same for both directions)
  "recenter-vr": {
    increase: `
    <rect x="16" y="14" width="40" height="20" rx="6" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="36" y1="14" x2="36" y2="34" stroke="${GRAY}" stroke-width="0.5"/>
    <circle cx="28" cy="24" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="44" cy="24" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="8" x2="36" y2="12" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="36" y1="36" x2="36" y2="40" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="10" y1="24" x2="14" y2="24" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="58" y1="24" x2="62" y2="24" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>`,
    decrease: `
    <rect x="16" y="14" width="40" height="20" rx="6" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="36" y1="14" x2="36" y2="34" stroke="${GRAY}" stroke-width="0.5"/>
    <circle cx="28" cy="24" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="44" cy="24" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="8" x2="36" y2="12" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="36" y1="36" x2="36" y2="40" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="10" y1="24" x2="14" y2="24" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="58" y1="24" x2="62" y2="24" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>`,
  },
  // UI Size: Window frame with scale arrows inside bottom-right corner
  "ui-size": {
    increase: `
    <rect x="16" y="12" width="40" height="26" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="16" y1="18" x2="56" y2="18" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="20" cy="15" r="1" fill="${GRAY}"/>
    <circle cx="24" cy="15" r="1" fill="${GRAY}"/>
    <path d="M45 27 L53 35 M53 30 L53 35 L48 35" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="16" y="12" width="40" height="26" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="16" y1="18" x2="56" y2="18" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="20" cy="15" r="1" fill="${GRAY}"/>
    <circle cx="24" cy="15" r="1" fill="${GRAY}"/>
    <path d="M53 35 L45 27 M45 32 L45 27 L50 27" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
};

/**
 * @internal Exported for testing
 *
 * Mapping from adjustment + direction to global settings keys.
 */
export const VIEW_ADJUSTMENT_GLOBAL_KEYS: Record<AdjustmentType, Record<DirectionType, string>> = {
  fov: {
    increase: "viewAdjustFovIncrease",
    decrease: "viewAdjustFovDecrease",
  },
  horizon: {
    increase: "viewAdjustHorizonUp",
    decrease: "viewAdjustHorizonDown",
  },
  "driver-height": {
    increase: "viewAdjustDriverHeightUp",
    decrease: "viewAdjustDriverHeightDown",
  },
  "recenter-vr": {
    increase: "viewAdjustRecenterVr",
    decrease: "viewAdjustRecenterVr",
  },
  "ui-size": {
    increase: "viewAdjustUiSizeIncrease",
    decrease: "viewAdjustUiSizeDecrease",
  },
};

const ViewAdjustmentSettings = z.object({
  adjustment: z.enum(["fov", "horizon", "driver-height", "recenter-vr", "ui-size"]).default("fov"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type ViewAdjustmentSettings = z.infer<typeof ViewAdjustmentSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the view adjustment action.
 */
export function generateViewAdjustmentSvg(settings: ViewAdjustmentSettings): string {
  const { adjustment, direction } = settings;

  const iconContent = VIEW_ADJUSTMENT_ICONS[adjustment]?.[direction] || VIEW_ADJUSTMENT_ICONS.fov.increase;
  const labels = VIEW_ADJUSTMENT_LABELS[adjustment]?.[direction] || VIEW_ADJUSTMENT_LABELS.fov.increase;

  const svg = renderIconTemplate(viewAdjustmentTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * View Adjustment Action
 * Adjusts camera/view settings (FOV, horizon, driver height, VR recentering, UI size) via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.view-adjustment" })
export class ViewAdjustment extends ConnectionStateAwareAction<ViewAdjustmentSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("ViewAdjustment"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<ViewAdjustmentSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<ViewAdjustmentSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ViewAdjustmentSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<ViewAdjustmentSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAdjustment(settings.adjustment, settings.direction);
  }

  override async onDialDown(ev: DialDownEvent<ViewAdjustmentSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAdjustment(settings.adjustment, settings.direction);
  }

  override async onDialRotate(ev: DialRotateEvent<ViewAdjustmentSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);

    // Recenter VR has no directional adjustment — ignore rotation
    if (settings.adjustment === "recenter-vr") {
      this.logger.debug("Rotation ignored for Recenter VR");

      return;
    }

    // Clockwise (ticks > 0) = increase, Counter-clockwise (ticks < 0) = decrease
    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.executeAdjustment(settings.adjustment, direction);
  }

  private parseSettings(settings: unknown): ViewAdjustmentSettings {
    const parsed = ViewAdjustmentSettings.safeParse(settings);

    return parsed.success ? parsed.data : ViewAdjustmentSettings.parse({});
  }

  private async executeAdjustment(adjustment: AdjustmentType, direction: DirectionType): Promise<void> {
    const settingKey = VIEW_ADJUSTMENT_GLOBAL_KEYS[adjustment]?.[direction];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${adjustment} ${direction}`);

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
    ev: WillAppearEvent<ViewAdjustmentSettings> | DidReceiveSettingsEvent<ViewAdjustmentSettings>,
    settings: ViewAdjustmentSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateViewAdjustmentSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
