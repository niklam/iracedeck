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
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckTouchTapEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  onGlobalSettingsChange,
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

import { DialSettings, seedDialFromLegacySetting, ViewAdjustmentDialSurface } from "./view-adjustment-dial-surface.js";

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
  // Dial-surface settings (#806), under the `dial` root so keypad and dial keys
  // can't collide. catch: dial garbage degrades to dial defaults instead of
  // failing the whole parse (which would reset a keypad instance).
  dial: DialSettings.catch(() => DialSettings.parse({})),
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
 *
 * Dual-surface (#806): on a keypad button it is the modal view-adjustment action;
 * on a Stream Deck+ dial (Elgato Encoder only per #786) rotation adjusts one view
 * value and the press can recenter VR. All dial events route to
 * {@link ViewAdjustmentDialSurface} behind a host interface; the keypad path is
 * unchanged.
 */
export const VIEW_ADJUSTMENT_UUID = "com.iracedeck.sd.core.view-adjustment" as const;

export class ViewAdjustment extends ConnectionStateAwareAction<ViewAdjustmentSettings> {
  /**
   * The dial half of the action; all IDeck dial events route here (#806). No
   * `setActiveBinding` is delegated — it would bleed onto the keypad buttons.
   */
  private readonly dialSurface = new ViewAdjustmentDialSurface({
    logger: this.logger,
    getTelemetry: () => this.sdkController.getCurrentTelemetry(),
    tapBinding: (settingKey) => this.tapBinding(settingKey),
    isBindingMissing: (keys) => this.isBindingMissing(keys),
  });

  /** Keeps the dial strips' #612 missing-binding warning live while iRacing is offline (#806). */
  private readonly unsubscribeGlobalSettings = onGlobalSettingsChange(() => this.dialSurface.refreshAll());

  override async onWillAppear(ev: IDeckWillAppearEvent<ViewAdjustmentSettings>): Promise<void> {
    await super.onWillAppear(ev);
    let settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      // #806 dial migration: a pre-dial-surface encoder placement drove the flat
      // keypad `adjustment` — carry a valid rotation value over to `dial.setting`.
      const seededDial = seedDialFromLegacySetting(ev.payload.settings);

      if (seededDial) {
        await ev.action.setSettings(seededDial);
        settings = this.parseSettings(seededDial);
      }

      await this.dialSurface.willAppear(ev.action, settings.dial);
      this.sdkController.subscribe(ev.action.id, (telemetry) => {
        this.dialSurface.onTelemetry(ev.action.id, telemetry);
      });

      return;
    }

    this.setActiveBinding(VIEW_ADJUSTMENT_GLOBAL_KEYS[settings.adjustment]?.[settings.direction]);
    await this.updateDisplay(ev, settings);
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<ViewAdjustmentSettings>): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.dialSurface.willDisappear(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<ViewAdjustmentSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      await this.dialSurface.didReceiveSettings(ev.action, settings.dial);

      return;
    }

    this.setActiveBinding(VIEW_ADJUSTMENT_GLOBAL_KEYS[settings.adjustment]?.[settings.direction]);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<ViewAdjustmentSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAdjustment(settings.adjustment, settings.direction);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<ViewAdjustmentSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.rotate(ev.action, settings.dial, ev.payload.ticks, ev.payload.pressed === true);
  }

  override async onDialDown(ev: IDeckDialDownEvent<ViewAdjustmentSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.down(ev.action, settings.dial);
  }

  override async onDialUp(ev: IDeckDialUpEvent<ViewAdjustmentSettings>): Promise<void> {
    await this.dialSurface.up(ev.action.id);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<ViewAdjustmentSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.touchTap(ev.action, settings.dial, ev.payload.hold === true);
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
