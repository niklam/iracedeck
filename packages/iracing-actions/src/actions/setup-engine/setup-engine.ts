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
  type IDeckWillDisappearEvent,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import boostLevelDecreaseIconSvg from "@iracedeck/icons/setup-engine/boost-level-decrease.svg";
import boostLevelIncreaseIconSvg from "@iracedeck/icons/setup-engine/boost-level-increase.svg";
import enginePowerDecreaseIconSvg from "@iracedeck/icons/setup-engine/engine-power-decrease.svg";
import enginePowerIncreaseIconSvg from "@iracedeck/icons/setup-engine/engine-power-increase.svg";
import launchRpmDecreaseIconSvg from "@iracedeck/icons/setup-engine/launch-rpm-decrease.svg";
import launchRpmIncreaseIconSvg from "@iracedeck/icons/setup-engine/launch-rpm-increase.svg";
import throttleShapingDecreaseIconSvg from "@iracedeck/icons/setup-engine/throttle-shaping-decrease.svg";
import throttleShapingIncreaseIconSvg from "@iracedeck/icons/setup-engine/throttle-shaping-increase.svg";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import { formatViewValue, generateSetupViewSvg, isViewSetting } from "../../shared/setup-view.js";

type SetupEngineAdjustSetting = "engine-power" | "throttle-shaping" | "boost-level" | "launch-rpm";

/**
 * The combined `setting` type is the union of `SetupEngineAdjustSetting` and the three
 * View IDs in `setup-view.ts`. Code paths narrow back to `SetupEngineAdjustSetting`
 * after `isViewSetting` gates the View branch; nothing needs the full union as a name.
 */

type DirectionType = "increase" | "decrease";

/**
 * Flat icon lookup mapping setting + direction keys to standalone SVG templates.
 */
const SETUP_ENGINE_ICONS: Record<string, string> = {
  "engine-power-increase": enginePowerIncreaseIconSvg,
  "engine-power-decrease": enginePowerDecreaseIconSvg,
  "throttle-shaping-increase": throttleShapingIncreaseIconSvg,
  "throttle-shaping-decrease": throttleShapingDecreaseIconSvg,
  "boost-level-increase": boostLevelIncreaseIconSvg,
  "boost-level-decrease": boostLevelDecreaseIconSvg,
  "launch-rpm-increase": launchRpmIncreaseIconSvg,
  "launch-rpm-decrease": launchRpmDecreaseIconSvg,
};

/**
 * Title text for each setting + direction combination (format: "subLabel\nmainLabel")
 */
const SETUP_ENGINE_TITLES: Record<string, string> = {
  "engine-power-increase": "INCREASE\nENG POWER",
  "engine-power-decrease": "DECREASE\nENG POWER",
  "throttle-shaping-increase": "INCREASE\nTHROTTLE",
  "throttle-shaping-decrease": "DECREASE\nTHROTTLE",
  "boost-level-increase": "INCREASE\nBOOST",
  "boost-level-decrease": "DECREASE\nBOOST",
  "launch-rpm-increase": "INCREASE\nLAUNCH RPM",
  "launch-rpm-decrease": "DECREASE\nLAUNCH RPM",
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

const SetupEngineSettings = CommonSettings.extend({
  setting: z
    .enum([
      // View sub-modes.
      "view-engine-power",
      "view-throttle-shape",
      "view-launch-rpm",
      // Adjustment sub-modes.
      "engine-power",
      "throttle-shaping",
      "boost-level",
      "launch-rpm",
    ])
    .default("engine-power"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type SetupEngineSettings = z.infer<typeof SetupEngineSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup engine action's adjustment sub-modes.
 * View sub-modes use the shared `generateSetupViewSvg` render path.
 */
export function generateSetupEngineSvg(settings: SetupEngineSettings): string {
  if (isViewSetting(settings.setting)) {
    return generateSetupViewSvg({
      viewId: settings.setting,
      telemetry: null,
      colorSourceSvg: enginePowerIncreaseIconSvg,
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
    });
  }

  const setting = settings.setting as SetupEngineAdjustSetting;
  const { direction } = settings;

  const iconKey = `${setting}-${direction}`;
  const iconSvg = SETUP_ENGINE_ICONS[iconKey] || SETUP_ENGINE_ICONS["engine-power-increase"];
  const defaultTitle = SETUP_ENGINE_TITLES[iconKey] || "SETUP\nENGINE";

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
}

/**
 * Setup Engine Action
 * Provides engine-related in-car adjustments (engine power, throttle shaping,
 * boost level, launch RPM) via keyboard shortcuts.
 */
export const SETUP_ENGINE_UUID = "com.iracedeck.sd.core.setup-engine" as const;

export class SetupEngine extends ConnectionStateAwareAction<SetupEngineSettings> {
  /** Current settings per action context, used by the telemetry-tick callback for View sub-modes. */
  private readonly activeContexts = new Map<string, SetupEngineSettings>();

  /** Last rendered View value per context — memoizes the icon so we only re-emit on actual change. */
  private readonly lastRenderedValue = new Map<string, string>();

  override async onWillAppear(ev: IDeckWillAppearEvent<SetupEngineSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.applyActiveBinding(settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      const stored = this.activeContexts.get(ev.action.id);

      if (stored && isViewSetting(stored.setting)) {
        void this.updateDisplayFromTelemetry(ev.action.id, telemetry, stored);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SetupEngineSettings>): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastRenderedValue.delete(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SetupEngineSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.lastRenderedValue.delete(ev.action.id);
    this.applyActiveBinding(settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<SetupEngineSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (isViewSetting(settings.setting)) {
      this.logger.debug("View sub-mode is read-only, ignoring key press");

      return;
    }

    this.logger.info("Key down received");
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialDown(ev: IDeckDialDownEvent<SetupEngineSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (isViewSetting(settings.setting)) return;

    this.logger.info("Dial down received");
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<SetupEngineSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (isViewSetting(settings.setting)) return;

    this.logger.info("Dial rotated");
    // Clockwise (ticks > 0) = increase, Counter-clockwise (ticks < 0) = decrease
    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.executeSetting(settings.setting, direction);
  }

  private parseSettings(settings: unknown): SetupEngineSettings {
    const parsed = SetupEngineSettings.safeParse(settings);

    return parsed.success ? parsed.data : SetupEngineSettings.parse({});
  }

  private applyActiveBinding(settings: SetupEngineSettings): void {
    if (isViewSetting(settings.setting)) {
      this.setActiveBinding(null);

      return;
    }

    this.setActiveBinding(SETUP_ENGINE_GLOBAL_KEYS[`${settings.setting}-${settings.direction}`]);
  }

  private async executeSetting(setting: SetupEngineAdjustSetting, direction: DirectionType): Promise<void> {
    const settingKey = SETUP_ENGINE_GLOBAL_KEYS[`${setting}-${direction}`];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${setting} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<SetupEngineSettings> | IDeckDidReceiveSettingsEvent<SetupEngineSettings>,
    settings: SetupEngineSettings,
  ): Promise<void> {
    const svgDataUri = this.renderIcon(settings);

    if (isViewSetting(settings.setting)) {
      const telemetry = this.sdkController.getCurrentTelemetry();
      this.lastRenderedValue.set(ev.action.id, formatViewValue(settings.setting, telemetry));
    }

    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => this.renderIcon(settings));
  }

  private renderIcon(settings: SetupEngineSettings): string {
    if (isViewSetting(settings.setting)) {
      return generateSetupViewSvg({
        viewId: settings.setting,
        telemetry: this.sdkController.getCurrentTelemetry(),
        colorSourceSvg: enginePowerIncreaseIconSvg,
        colorOverrides: settings.colorOverrides,
        titleOverrides: settings.titleOverrides,
        borderOverrides: settings.borderOverrides,
      });
    }

    return generateSetupEngineSvg(settings);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: SetupEngineSettings,
  ): Promise<void> {
    if (!isViewSetting(settings.setting)) return;

    const value = formatViewValue(settings.setting, telemetry);

    if (this.lastRenderedValue.get(contextId) === value) return;

    this.lastRenderedValue.set(contextId, value);
    const svgDataUri = generateSetupViewSvg({
      viewId: settings.setting,
      telemetry,
      colorSourceSvg: enginePowerIncreaseIconSvg,
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
    });
    await this.updateKeyImage(contextId, svgDataUri);
  }
}
