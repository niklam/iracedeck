import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import driverHeightDecreaseIconSvg from "@iracedeck/icons/view-adjustment/driver-height-decrease.svg";
import driverHeightIncreaseIconSvg from "@iracedeck/icons/view-adjustment/driver-height-increase.svg";
import fovDecreaseIconSvg from "@iracedeck/icons/view-adjustment/fov-decrease.svg";
import fovIncreaseIconSvg from "@iracedeck/icons/view-adjustment/fov-increase.svg";
import horizonDecreaseIconSvg from "@iracedeck/icons/view-adjustment/horizon-decrease.svg";
import horizonIncreaseIconSvg from "@iracedeck/icons/view-adjustment/horizon-increase.svg";
import recenterVrIconSvg from "@iracedeck/icons/view-adjustment/recenter-vr.svg";
import uiSizeDecreaseIconSvg from "@iracedeck/icons/view-adjustment/ui-size-decrease.svg";
import uiSizeIncreaseIconSvg from "@iracedeck/icons/view-adjustment/ui-size-increase.svg";
import z from "zod";

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

type AdjustmentType = "fov" | "horizon" | "driver-height" | "recenter-vr" | "ui-size";
type DirectionType = "increase" | "decrease";

/**
 * Flat icon lookup record mapping adjustment + direction keys to imported SVGs.
 */
const VIEW_ADJUSTMENT_ICONS: Record<string, string> = {
  "fov-increase": fovIncreaseIconSvg,
  "fov-decrease": fovDecreaseIconSvg,
  "horizon-increase": horizonIncreaseIconSvg,
  "horizon-decrease": horizonDecreaseIconSvg,
  "driver-height-increase": driverHeightIncreaseIconSvg,
  "driver-height-decrease": driverHeightDecreaseIconSvg,
  "recenter-vr-increase": recenterVrIconSvg,
  "recenter-vr-decrease": recenterVrIconSvg,
  "ui-size-increase": uiSizeIncreaseIconSvg,
  "ui-size-decrease": uiSizeDecreaseIconSvg,
};

/**
 * Label configuration for each adjustment + direction combination.
 * Inverted layout: mainLabel = primary (bold, bottom), subLabel = secondary (subdued, top).
 */
const VIEW_ADJUSTMENT_LABELS: Record<AdjustmentType, Record<DirectionType, { mainLabel: string; subLabel: string }>> = {
  fov: {
    increase: { mainLabel: "INCREASE", subLabel: "FOV" },
    decrease: { mainLabel: "DECREASE", subLabel: "FOV" },
  },
  horizon: {
    increase: { mainLabel: "UP", subLabel: "HORIZON" },
    decrease: { mainLabel: "DOWN", subLabel: "HORIZON" },
  },
  "driver-height": {
    increase: { mainLabel: "UP", subLabel: "DRIVER HEIGHT" },
    decrease: { mainLabel: "DOWN", subLabel: "DRIVER HEIGHT" },
  },
  "recenter-vr": {
    increase: { mainLabel: "RECENTER", subLabel: "VR VIEW" },
    decrease: { mainLabel: "RECENTER", subLabel: "VR VIEW" },
  },
  "ui-size": {
    increase: { mainLabel: "INCREASE", subLabel: "UI SIZE" },
    decrease: { mainLabel: "DECREASE", subLabel: "UI SIZE" },
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

  const iconKey = `${adjustment}-${direction}`;
  const iconSvg = VIEW_ADJUSTMENT_ICONS[iconKey] || VIEW_ADJUSTMENT_ICONS["fov-increase"];
  const labels = VIEW_ADJUSTMENT_LABELS[adjustment]?.[direction] || VIEW_ADJUSTMENT_LABELS.fov.increase;

  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
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
    this.logger.info(`Executing ${adjustment} ${direction}`);

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
    ev: WillAppearEvent<ViewAdjustmentSettings> | DidReceiveSettingsEvent<ViewAdjustmentSettings>,
    settings: ViewAdjustmentSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateViewAdjustmentSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
