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
 * Label configuration for each adjustment + direction combination (line1 bold, line2 subdued)
 */
const VIEW_ADJUSTMENT_LABELS: Record<AdjustmentType, Record<DirectionType, { line1: string; line2: string }>> = {
  fov: {
    increase: { line1: "FOV", line2: "INCREASE" },
    decrease: { line1: "FOV", line2: "DECREASE" },
  },
  horizon: {
    increase: { line1: "HORIZON", line2: "UP" },
    decrease: { line1: "HORIZON", line2: "DOWN" },
  },
  "driver-height": {
    increase: { line1: "DRIVER", line2: "HEIGHT UP" },
    decrease: { line1: "DRIVER", line2: "HEIGHT DN" },
  },
  "recenter-vr": {
    increase: { line1: "RECENTER", line2: "VR" },
    decrease: { line1: "RECENTER", line2: "VR" },
  },
  "ui-size": {
    increase: { line1: "UI SIZE", line2: "INCREASE" },
    decrease: { line1: "UI SIZE", line2: "DECREASE" },
  },
};

/**
 * SVG icon content for each adjustment type.
 * FOV, Horizon, and Driver Height show directional arrows; Recenter VR and UI Size are non-directional.
 */
const VIEW_ADJUSTMENT_ICONS: Record<AdjustmentType, Record<DirectionType, string>> = {
  // FOV: Camera lens with zoom in/out arrows
  fov: {
    increase: `
    <circle cx="36" cy="22" r="12" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="22" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="36" cy="22" r="2" fill="${WHITE}"/>
    <path d="M52 30 L58 36" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="54" y1="38" x2="60" y2="38" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="57" y1="35" x2="57" y2="41" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>`,
    decrease: `
    <circle cx="36" cy="22" r="12" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="22" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="36" cy="22" r="2" fill="${WHITE}"/>
    <path d="M52 30 L58 36" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="54" y1="38" x2="60" y2="38" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>`,
  },
  // Horizon: Horizon line with up/down arrow
  horizon: {
    increase: `
    <line x1="10" y1="24" x2="62" y2="24" stroke="${GRAY}" stroke-width="1.5"/>
    <line x1="14" y1="30" x2="58" y2="30" stroke="${GRAY}" stroke-width="1" opacity="0.5"/>
    <path d="M36 20 L32 16 M36 20 L40 16" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="36" y1="20" x2="36" y2="36" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>`,
    decrease: `
    <line x1="10" y1="24" x2="62" y2="24" stroke="${GRAY}" stroke-width="1.5"/>
    <line x1="14" y1="18" x2="58" y2="18" stroke="${GRAY}" stroke-width="1" opacity="0.5"/>
    <path d="M36 32 L32 36 M36 32 L40 36" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="36" y1="16" x2="36" y2="32" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>`,
  },
  // Driver Height: Seat silhouette with up/down arrow
  "driver-height": {
    increase: `
    <rect x="26" y="18" width="20" height="20" rx="3" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <circle cx="36" cy="14" r="4" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="36" y1="18" x2="36" y2="30" stroke="${WHITE}" stroke-width="1.5"/>
    <path d="M14 20 L10 16 M14 20 L18 16" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="14" y1="20" x2="14" y2="36" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>`,
    decrease: `
    <rect x="26" y="18" width="20" height="20" rx="3" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <circle cx="36" cy="14" r="4" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="36" y1="18" x2="36" y2="30" stroke="${WHITE}" stroke-width="1.5"/>
    <path d="M14 32 L10 36 M14 32 L18 36" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="14" y1="16" x2="14" y2="32" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>`,
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
  // UI Size: Window frame with scale arrows
  "ui-size": {
    increase: `
    <rect x="16" y="12" width="40" height="26" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="16" y1="18" x2="56" y2="18" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="20" cy="15" r="1" fill="${GRAY}"/>
    <circle cx="24" cy="15" r="1" fill="${GRAY}"/>
    <path d="M54 36 L60 42 M60 36 L60 42 L54 42" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="16" y="12" width="40" height="26" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="16" y1="18" x2="56" y2="18" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="20" cy="15" r="1" fill="${GRAY}"/>
    <circle cx="24" cy="15" r="1" fill="${GRAY}"/>
    <path d="M60 42 L54 36 M54 42 L54 36 L60 36" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
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
