import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
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
 * Title configuration for each adjustment + direction combination.
 */
const VIEW_ADJUSTMENT_TITLES: Record<AdjustmentType, Record<DirectionType, string>> = {
  fov: {
    increase: "FOV\nINCREASE",
    decrease: "FOV\nDECREASE",
  },
  horizon: {
    increase: "HORIZON\nUP",
    decrease: "HORIZON\nDOWN",
  },
  "driver-height": {
    increase: "DRIVER HEIGHT\nUP",
    decrease: "DRIVER HEIGHT\nDOWN",
  },
  "recenter-vr": {
    increase: "VR VIEW\nRECENTER",
    decrease: "VR VIEW\nRECENTER",
  },
  "ui-size": {
    increase: "UI SIZE\nINCREASE",
    decrease: "UI SIZE\nDECREASE",
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

const ViewAdjustmentSettings = CommonSettings.extend({
  adjustment: z.enum(["fov", "horizon", "driver-height", "recenter-vr", "ui-size"]).default("fov"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type ViewAdjustmentSettings = z.infer<typeof ViewAdjustmentSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the view adjustment action.
 */
export function generateViewAdjustmentSvg(settings: ViewAdjustmentSettings, bindingMissing = false): string {
  const { adjustment, direction } = settings;

  const iconKey = `${adjustment}-${direction}`;
  const iconSvg = VIEW_ADJUSTMENT_ICONS[iconKey] || VIEW_ADJUSTMENT_ICONS["fov-increase"];
  const defaultTitle = VIEW_ADJUSTMENT_TITLES[adjustment]?.[direction] || VIEW_ADJUSTMENT_TITLES.fov.increase;

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * View Adjustment Action
 * Adjusts camera/view settings (FOV, horizon, driver height, VR recentering, UI size) via keyboard shortcuts.
 */
export const VIEW_ADJUSTMENT_UUID = "com.iracedeck.sd.core.view-adjustment" as const;

export class ViewAdjustment extends ConnectionStateAwareAction<ViewAdjustmentSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<ViewAdjustmentSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.setActiveBinding(VIEW_ADJUSTMENT_GLOBAL_KEYS[settings.adjustment]?.[settings.direction]);
    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<ViewAdjustmentSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.setActiveBinding(VIEW_ADJUSTMENT_GLOBAL_KEYS[settings.adjustment]?.[settings.direction]);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<ViewAdjustmentSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAdjustment(settings.adjustment, settings.direction);
  }

  override async onDialDown(ev: IDeckDialDownEvent<ViewAdjustmentSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAdjustment(settings.adjustment, settings.direction);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<ViewAdjustmentSettings>): Promise<void> {
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

    await this.tapBinding(settingKey);
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<ViewAdjustmentSettings> | IDeckDidReceiveSettingsEvent<ViewAdjustmentSettings>,
    settings: ViewAdjustmentSettings,
  ): Promise<void> {
    const activeKey = VIEW_ADJUSTMENT_GLOBAL_KEYS[settings.adjustment]?.[settings.direction];
    const svgDataUri = generateViewAdjustmentSvg(settings, this.isBindingMissing(activeKey));
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () =>
      generateViewAdjustmentSvg(settings, this.isBindingMissing(activeKey)),
    );
  }
}
