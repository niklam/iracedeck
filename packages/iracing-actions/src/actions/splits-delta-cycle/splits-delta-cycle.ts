import {
  assembleIcon,
  clearSelectedCar,
  CommonSettings,
  ConnectionStateAwareAction,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  getSelectedCar,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  onSelectedCarChange,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
  setSelectedCar,
} from "@iracedeck/deck-core";
import activeResetRunIconSvg from "@iracedeck/icons/splits-delta-cycle/active-reset-run.svg";
import activeResetSetIconSvg from "@iracedeck/icons/splits-delta-cycle/active-reset-set.svg";
import customSectorEndIconSvg from "@iracedeck/icons/splits-delta-cycle/custom-sector-end.svg";
import customSectorStartIconSvg from "@iracedeck/icons/splits-delta-cycle/custom-sector-start.svg";
import displayRefCarIconSvg from "@iracedeck/icons/splits-delta-cycle/display-ref-car.svg";
import nextIconSvg from "@iracedeck/icons/splits-delta-cycle/next.svg";
import previousIconSvg from "@iracedeck/icons/splits-delta-cycle/previous.svg";
import {
  getCarNumberFromSessionInfo,
  getCarNumberRawFromSessionInfo,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import z from "zod";

const DIRECTION_ICONS: Record<string, string> = {
  next: nextIconSvg,
  previous: previousIconSvg,
};

const MODE_ICONS: Record<string, string> = {
  "custom-sector-start": customSectorStartIconSvg,
  "custom-sector-end": customSectorEndIconSvg,
  "active-reset-set": activeResetSetIconSvg,
  "active-reset-run": activeResetRunIconSvg,
  "select-reference-car": displayRefCarIconSvg,
};

const MODE_TITLES: Record<string, string> = {
  "custom-sector-start": "SECTOR\nSTART",
  "custom-sector-end": "SECTOR\nEND",
  "active-reset-set": "RESET POINT\nSET",
  "active-reset-run": "TO START\nRESET",
};

const SplitsDeltaCycleSettings = CommonSettings.extend({
  mode: z
    .enum([
      "cycle",
      "toggle-ref-car",
      "select-reference-car",
      "custom-sector-start",
      "custom-sector-end",
      "active-reset-set",
      "active-reset-run",
    ])
    .default("cycle"),
  direction: z.enum(["next", "previous"]).default("next"),
  carIdx: z.coerce.number().int().min(0).max(63).default(0),
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
export function generateSplitsDeltaCycleSvg(
  settings: SplitsDeltaCycleSettings,
  bindingMissing = false,
  resolvedCarNumber: string | null = null,
  isSelected = false,
): string {
  const { mode, direction } = settings;

  // toggle-ref-car uses a dedicated icon from splits-delta-cycle
  if (mode === "toggle-ref-car") {
    const colors = resolveIconColors(displayRefCarIconSvg, getGlobalColors(), settings.colorOverrides);
    const title = resolveTitleSettings(
      displayRefCarIconSvg,
      getGlobalTitleSettings(),
      settings.titleOverrides,
      "CAR\nREFERENCE",
    );

    const border = resolveBorderSettings(displayRefCarIconSvg, getGlobalBorderSettings(), settings.borderOverrides);

    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

    return assembleIcon({ graphicSvg: displayRefCarIconSvg, colors, title, border, graphic, bindingMissing });
  }

  if (mode === "select-reference-car") {
    const colors = resolveIconColors(displayRefCarIconSvg, getGlobalColors(), settings.colorOverrides);
    const defaultTitle = resolvedCarNumber?.trim() ? `#${resolvedCarNumber.trim()}` : "—";
    const title = resolveTitleSettings(
      displayRefCarIconSvg,
      getGlobalTitleSettings(),
      settings.titleOverrides,
      defaultTitle,
    );

    // Green border forced on when this button is the active selected target
    const stateColor = isSelected ? "#2ecc71" : undefined;
    const resolvedBorder = resolveBorderSettings(
      displayRefCarIconSvg,
      getGlobalBorderSettings(),
      settings.borderOverrides,
      stateColor,
    );
    const border = isSelected ? { ...resolvedBorder, enabled: true } : resolvedBorder;

    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

    return assembleIcon({ graphicSvg: displayRefCarIconSvg, colors, title, border, graphic, bindingMissing });
  }

  const modeIconSvg = MODE_ICONS[mode];

  if (modeIconSvg) {
    const colors = resolveIconColors(modeIconSvg, getGlobalColors(), settings.colorOverrides);
    const title = resolveTitleSettings(
      modeIconSvg,
      getGlobalTitleSettings(),
      settings.titleOverrides,
      MODE_TITLES[mode],
    );

    const border = resolveBorderSettings(modeIconSvg, getGlobalBorderSettings(), settings.borderOverrides);

    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

    return assembleIcon({ graphicSvg: modeIconSvg, colors, title, border, graphic, bindingMissing });
  }

  const iconSvg = DIRECTION_ICONS[direction] || DIRECTION_ICONS.next;
  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const defaultTitle = direction === "next" ? "SPLITS DELTA\nNEXT" : "SPLITS DELTA\nPREVIOUS";
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * Splits & Reference Action
 * Cycles through iRacing split-time delta display modes or toggles the reference car display.
 */
export const SPLITS_DELTA_CYCLE_UUID = "com.iracedeck.sd.core.splits-delta-cycle" as const;

export class SplitsDeltaCycle extends ConnectionStateAwareAction<SplitsDeltaCycleSettings> {
  private activeContexts = new Map<string, SplitsDeltaCycleSettings>();
  private resolvedCarNumbers = new Map<string, string | null>();
  private resolvedCarRaws = new Map<string, number | null>();
  private selectedCarUnsubscribers = new Map<string, () => void>();

  override async onWillAppear(ev: IDeckWillAppearEvent<SplitsDeltaCycleSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.setActiveBinding(this.resolveSettingKey(settings));
    await this.updateDisplay(ev, settings);
    // Subscribe to session info updates to resolve car number for select-reference-car mode
    this.sdkController.subscribe(ev.action.id, (_telemetry: TelemetryData | null) => {
      if (settings.mode === "select-reference-car") {
        this.updateCarFromSession(ev.action.id, settings);
      }
    });
    // Subscribe to selected-car changes to refresh the active/inactive state
    const unsubscribe = onSelectedCarChange(() => {
      const currentSettings = this.activeContexts.get(ev.action.id);

      if (currentSettings?.mode !== "select-reference-car") return;

      const carNum = this.resolvedCarNumbers.get(ev.action.id) ?? null;
      const isSelected = getSelectedCar()?.carIdx === currentSettings.carIdx;
      const svg = generateSplitsDeltaCycleSvg(currentSettings, false, carNum, isSelected);
      void this.updateKeyImage(ev.action.id, svg);
    });
    this.selectedCarUnsubscribers.set(ev.action.id, unsubscribe);

    // Initial resolution
    if (settings.mode === "select-reference-car") {
      this.updateCarFromSession(ev.action.id, settings);
    }
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SplitsDeltaCycleSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.selectedCarUnsubscribers.get(ev.action.id)?.();
    this.selectedCarUnsubscribers.delete(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.resolvedCarNumbers.delete(ev.action.id);
    this.resolvedCarRaws.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SplitsDeltaCycleSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.setActiveBinding(this.resolveSettingKey(settings));

    if (settings.mode === "select-reference-car") {
      this.updateCarFromSession(ev.action.id, settings);
    }

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<SplitsDeltaCycleSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.mode === "select-reference-car") {
      const carNumber = this.resolvedCarNumbers.get(ev.action.id) ?? null;
      const carNumberRaw = this.resolvedCarRaws.get(ev.action.id) ?? null;

      if (carNumber === null || carNumberRaw === null) {
        this.logger.warn("Cannot select reference car: car number not yet resolved from session info");

        return;
      }

      // Toggle: deselect if this car is already the active target
      if (getSelectedCar()?.carIdx === settings.carIdx) {
        clearSelectedCar();
        this.logger.info("Reference car deselected");

        return;
      }

      setSelectedCar({ carIdx: settings.carIdx, carNumber, carNumberRaw });
      this.logger.info("Reference car selected");
      this.logger.debug(`carIdx: ${settings.carIdx}, carNumber: ${carNumber}, carNumberRaw: ${carNumberRaw}`);

      return;
    }

    const settingKey = this.resolveSettingKey(settings);

    if (settingKey) {
      await this.tapBinding(settingKey);
    }
  }

  override async onDialDown(ev: IDeckDialDownEvent<SplitsDeltaCycleSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.mode === "select-reference-car") return;

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

  private resolveSettingKey(settings: SplitsDeltaCycleSettings): string | null {
    if (settings.mode === "select-reference-car") return null;

    return (
      MODE_KEY_MAP[settings.mode] ?? (settings.direction === "next" ? GLOBAL_KEY_NAMES.NEXT : GLOBAL_KEY_NAMES.PREVIOUS)
    );
  }

  private resolveTargetCarNumber(contextId: string, settings: SplitsDeltaCycleSettings): string | null {
    if (settings.mode !== "select-reference-car") return null;

    return this.resolvedCarNumbers.get(contextId) ?? null;
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<SplitsDeltaCycleSettings> | IDeckDidReceiveSettingsEvent<SplitsDeltaCycleSettings>,
    settings: SplitsDeltaCycleSettings,
  ): Promise<void> {
    const carNum = this.resolveTargetCarNumber(ev.action.id, settings);
    const isSelected = settings.mode === "select-reference-car" ? getSelectedCar()?.carIdx === settings.carIdx : false;
    const svgDataUri = generateSplitsDeltaCycleSvg(
      settings,
      this.isBindingMissing(this.resolveSettingKey(settings)),
      carNum,
      isSelected,
    );
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => {
      const currentCarNum = this.resolveTargetCarNumber(ev.action.id, settings);
      const currentIsSelected =
        settings.mode === "select-reference-car" ? getSelectedCar()?.carIdx === settings.carIdx : false;

      return generateSplitsDeltaCycleSvg(
        settings,
        this.isBindingMissing(this.resolveSettingKey(settings)),
        currentCarNum,
        currentIsSelected,
      );
    });
  }

  private updateCarFromSession(contextId: string, settings: SplitsDeltaCycleSettings): void {
    const sessionInfo = this.sdkController.getSessionInfo();
    const carNumber = getCarNumberFromSessionInfo(sessionInfo, settings.carIdx);
    const carNumberRaw = getCarNumberRawFromSessionInfo(sessionInfo, settings.carIdx);

    const prev = this.resolvedCarNumbers.get(contextId);
    this.resolvedCarNumbers.set(contextId, carNumber);
    this.resolvedCarRaws.set(contextId, carNumberRaw);

    // Only re-render if the displayed number changed
    if (carNumber === prev) return;

    const isSelected = getSelectedCar()?.carIdx === settings.carIdx;
    const svg = generateSplitsDeltaCycleSvg(
      settings,
      this.isBindingMissing(this.resolveSettingKey(settings)),
      carNumber,
      isSelected,
    );
    void this.updateKeyImage(contextId, svg);
  }
}
