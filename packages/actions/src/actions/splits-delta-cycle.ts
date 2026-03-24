import {
  CommonSettings,
  ConnectionStateAwareAction,
  getGlobalColors,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "@iracedeck/deck-core";
import activeResetRunIconSvg from "@iracedeck/icons/splits-delta-cycle/active-reset-run.svg";
import activeResetSetIconSvg from "@iracedeck/icons/splits-delta-cycle/active-reset-set.svg";
import customSectorEndIconSvg from "@iracedeck/icons/splits-delta-cycle/custom-sector-end.svg";
import customSectorStartIconSvg from "@iracedeck/icons/splits-delta-cycle/custom-sector-start.svg";
import nextIconSvg from "@iracedeck/icons/splits-delta-cycle/next.svg";
import previousIconSvg from "@iracedeck/icons/splits-delta-cycle/previous.svg";
import displayRefCarIconSvg from "@iracedeck/icons/toggle-ui-elements/display-ref-car.svg";
import z from "zod";

const DIRECTION_ICONS: Record<string, string> = {
  next: nextIconSvg,
  previous: previousIconSvg,
};

const MODE_ICONS: Record<string, { svg: string; mainLabel: string; subLabel: string }> = {
  "custom-sector-start": { svg: customSectorStartIconSvg, mainLabel: "START", subLabel: "SECTOR" },
  "custom-sector-end": { svg: customSectorEndIconSvg, mainLabel: "END", subLabel: "SECTOR" },
  "active-reset-set": { svg: activeResetSetIconSvg, mainLabel: "SET", subLabel: "RESET POINT" },
  "active-reset-run": { svg: activeResetRunIconSvg, mainLabel: "RESET", subLabel: "TO START" },
};

const SplitsDeltaCycleSettings = CommonSettings.extend({
  mode: z
    .enum([
      "cycle",
      "toggle-ref-car",
      "custom-sector-start",
      "custom-sector-end",
      "active-reset-set",
      "active-reset-run",
    ])
    .default("cycle"),
  direction: z.enum(["next", "previous"]).default("next"),
});

type SplitsDeltaCycleSettings = z.infer<typeof SplitsDeltaCycleSettings>;

/**
 * @internal Exported for testing
 */
export const GLOBAL_KEY_NAMES = {
  NEXT: "splitsDeltaNext",
  PREVIOUS: "splitsDeltaPrevious",
  TOGGLE_REF_CAR: "toggleUiDisplayRefCar",
  CUSTOM_SECTOR_START: "splitsDeltaCustomSectorStart",
  CUSTOM_SECTOR_END: "splitsDeltaCustomSectorEnd",
  ACTIVE_RESET_SET: "splitsDeltaActiveResetSet",
  ACTIVE_RESET_RUN: "splitsDeltaActiveResetRun",
} as const;

const MODE_KEY_MAP: Record<string, string> = {
  "custom-sector-start": GLOBAL_KEY_NAMES.CUSTOM_SECTOR_START,
  "custom-sector-end": GLOBAL_KEY_NAMES.CUSTOM_SECTOR_END,
  "active-reset-set": GLOBAL_KEY_NAMES.ACTIVE_RESET_SET,
  "active-reset-run": GLOBAL_KEY_NAMES.ACTIVE_RESET_RUN,
  "toggle-ref-car": GLOBAL_KEY_NAMES.TOGGLE_REF_CAR,
};

/**
 * @internal Exported for testing
 */
export function generateSplitsDeltaCycleSvg(settings: SplitsDeltaCycleSettings): string {
  const { mode, direction } = settings;

  // toggle-ref-car uses an icon from toggle-ui-elements, not splits-delta-cycle
  if (mode === "toggle-ref-car") {
    const colors = resolveIconColors(displayRefCarIconSvg, getGlobalColors(), settings.colorOverrides);
    const svg = renderIconTemplate(displayRefCarIconSvg, {
      mainLabel: "REFERENCE",
      subLabel: "CAR",
      ...colors,
    });

    return svgToDataUri(svg);
  }

  const modeIcon = MODE_ICONS[mode];

  if (modeIcon) {
    const colors = resolveIconColors(modeIcon.svg, getGlobalColors(), settings.colorOverrides);
    const svg = renderIconTemplate(modeIcon.svg, {
      mainLabel: modeIcon.mainLabel,
      subLabel: modeIcon.subLabel,
      ...colors,
    });

    return svgToDataUri(svg);
  }

  const iconSvg = DIRECTION_ICONS[direction] || DIRECTION_ICONS.next;
  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: direction === "next" ? "NEXT" : "PREVIOUS",
    subLabel: "SPLITS DELTA",
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Splits & Reference Action
 * Cycles through iRacing split-time delta display modes or toggles the reference car display.
 */
export const SPLITS_DELTA_CYCLE_UUID = "com.iracedeck.sd.core.splits-delta-cycle" as const;

export class SplitsDeltaCycle extends ConnectionStateAwareAction<SplitsDeltaCycleSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<SplitsDeltaCycleSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.setActiveBinding(this.resolveSettingKey(settings));
    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SplitsDeltaCycleSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.setActiveBinding(this.resolveSettingKey(settings));
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<SplitsDeltaCycleSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.tapBinding(this.resolveSettingKey(settings));
  }

  override async onDialDown(ev: IDeckDialDownEvent<SplitsDeltaCycleSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);

    const settingKey = MODE_KEY_MAP[settings.mode];

    if (!settingKey) return;

    await this.tapBinding(settingKey);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<SplitsDeltaCycleSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.mode !== "cycle") return;

    this.logger.info(`Dial rotated: ${ev.payload.ticks} ticks`);
    const settingKey = ev.payload.ticks > 0 ? GLOBAL_KEY_NAMES.NEXT : GLOBAL_KEY_NAMES.PREVIOUS;
    await this.tapBinding(settingKey);
  }

  private parseSettings(settings: unknown): SplitsDeltaCycleSettings {
    const parsed = SplitsDeltaCycleSettings.safeParse(settings);

    return parsed.success ? parsed.data : SplitsDeltaCycleSettings.parse({});
  }

  private resolveSettingKey(settings: SplitsDeltaCycleSettings): string {
    return settings.mode === "toggle-ref-car"
      ? GLOBAL_KEY_NAMES.TOGGLE_REF_CAR
      : settings.direction === "next"
        ? GLOBAL_KEY_NAMES.NEXT
        : GLOBAL_KEY_NAMES.PREVIOUS;
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<SplitsDeltaCycleSettings> | IDeckDidReceiveSettingsEvent<SplitsDeltaCycleSettings>,
    settings: SplitsDeltaCycleSettings,
  ): Promise<void> {
    const svgDataUri = generateSplitsDeltaCycleSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateSplitsDeltaCycleSvg(settings));
  }
}
