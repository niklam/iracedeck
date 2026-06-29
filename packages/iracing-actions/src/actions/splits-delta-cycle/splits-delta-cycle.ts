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
import { type ActiveSessionCar, getActiveSessionCars, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
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
  /**
   * 0-based index into the session car list sorted by car number.
   * Slot 0 = lowest car number, slot 1 = next lowest, etc.
   * The real carIdx for targeting is resolved at runtime from the sorted list.
   */
  slotIndex: z.coerce.number().int().min(0).default(0),
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
  isOffline = false,
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
    const baseColors = resolveIconColors(displayRefCarIconSvg, getGlobalColors(), settings.colorOverrides);
    // Dim the background when the driver is offline/disconnected so the user
    // knows the slot is occupied but unavailable.
    const colors = isOffline ? { ...baseColors, backgroundColor: "#333333" } : baseColors;
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
  private resolvedCarIdxs = new Map<string, number | null>();
  private resolvedOfflineStates = new Map<string, boolean>();
  private selectedCarUnsubscribers = new Map<string, () => void>();

  /**
   * Stable session car list sorted by car number.
   * Cars are never removed from this list — disconnected drivers remain
   * so that slot assignments don't shift unexpectedly.
   */
  private sessionCarList: ActiveSessionCar[] = [];
  /** Fast lookup set of carIdxs already present in sessionCarList. */
  private knownCarIdxSet = new Set<number>();

  override async onWillAppear(ev: IDeckWillAppearEvent<SplitsDeltaCycleSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.setActiveBinding(this.resolveSettingKey(settings));
    await this.updateDisplay(ev, settings);
    // Subscribe to telemetry to keep slot data current (car list + offline status)
    this.sdkController.subscribe(ev.action.id, (telemetry: TelemetryData | null) => {
      const currentSettings = this.activeContexts.get(ev.action.id);

      if (currentSettings?.mode !== "select-reference-car") return;

      const listChanged = this.updateSessionCarList(this.sdkController.getSessionInfo());

      if (listChanged) {
        // A new driver joined — refresh all visible select-reference-car buttons
        for (const [ctxId, ctxSettings] of this.activeContexts) {
          if (ctxSettings.mode === "select-reference-car") {
            this.updateCarFromSession(ctxId, ctxSettings, telemetry);
          }
        }
      } else {
        this.updateCarFromSession(ev.action.id, currentSettings, telemetry);
      }
    });
    // Subscribe to selected-car changes to refresh the active/inactive state
    const unsubscribe = onSelectedCarChange(() => {
      const currentSettings = this.activeContexts.get(ev.action.id);

      if (currentSettings?.mode !== "select-reference-car") return;

      const carNum = this.resolvedCarNumbers.get(ev.action.id) ?? null;
      const resolvedCarIdx = this.resolvedCarIdxs.get(ev.action.id) ?? null;
      const isSelected = resolvedCarIdx !== null && getSelectedCar()?.carIdx === resolvedCarIdx;
      const isOffline = this.resolvedOfflineStates.get(ev.action.id) ?? false;
      const svg = generateSplitsDeltaCycleSvg(currentSettings, false, carNum, isSelected, isOffline);
      void this.updateKeyImage(ev.action.id, svg);
    });
    this.selectedCarUnsubscribers.set(ev.action.id, unsubscribe);

    // Initial resolution: seed the car list from current session info
    if (settings.mode === "select-reference-car") {
      this.updateSessionCarList(this.sdkController.getSessionInfo());
      this.updateCarFromSession(ev.action.id, settings, null);
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
    this.resolvedCarIdxs.delete(ev.action.id);
    this.resolvedOfflineStates.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SplitsDeltaCycleSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.setActiveBinding(this.resolveSettingKey(settings));

    if (settings.mode === "select-reference-car") {
      this.updateCarFromSession(ev.action.id, settings, null);
    }

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<SplitsDeltaCycleSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.mode === "select-reference-car") {
      const carNumber = this.resolvedCarNumbers.get(ev.action.id) ?? null;
      const carNumberRaw = this.resolvedCarRaws.get(ev.action.id) ?? null;
      const resolvedCarIdx = this.resolvedCarIdxs.get(ev.action.id) ?? null;

      if (resolvedCarIdx === null || carNumber === null || carNumberRaw === null) {
        this.logger.warn("Cannot select reference car: no car assigned to this slot");

        return;
      }

      // Toggle: deselect if this car is already the active target
      if (getSelectedCar()?.carIdx === resolvedCarIdx) {
        clearSelectedCar();
        this.logger.info("Reference car deselected");

        return;
      }

      setSelectedCar({ carIdx: resolvedCarIdx, carNumber, carNumberRaw });
      this.logger.info("Reference car selected");
      this.logger.debug(
        `slotIndex: ${settings.slotIndex}, carIdx: ${resolvedCarIdx}, carNumber: ${carNumber}, carNumberRaw: ${carNumberRaw}`,
      );

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
    const resolvedCarIdx = this.resolvedCarIdxs.get(ev.action.id) ?? null;
    const isSelected =
      settings.mode === "select-reference-car"
        ? resolvedCarIdx !== null && getSelectedCar()?.carIdx === resolvedCarIdx
        : false;
    const isOffline = this.resolvedOfflineStates.get(ev.action.id) ?? false;
    const svgDataUri = generateSplitsDeltaCycleSvg(
      settings,
      this.isBindingMissing(this.resolveSettingKey(settings)),
      carNum,
      isSelected,
      isOffline,
    );
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => {
      const currentCarNum = this.resolveTargetCarNumber(ev.action.id, settings);
      const currentResolvedCarIdx = this.resolvedCarIdxs.get(ev.action.id) ?? null;
      const currentIsSelected =
        settings.mode === "select-reference-car"
          ? currentResolvedCarIdx !== null && getSelectedCar()?.carIdx === currentResolvedCarIdx
          : false;
      const currentIsOffline = this.resolvedOfflineStates.get(ev.action.id) ?? false;

      return generateSplitsDeltaCycleSvg(
        settings,
        this.isBindingMissing(this.resolveSettingKey(settings)),
        currentCarNum,
        currentIsSelected,
        currentIsOffline,
      );
    });
  }

  /**
   * Integrate new drivers from the latest session info into the stable car list.
   * Existing entries are never removed — disconnected drivers stay in place so
   * slot assignments remain stable throughout the session.
   *
   * @returns `true` when new drivers were added (callers should refresh all slots).
   */
  private updateSessionCarList(sessionInfo: unknown): boolean {
    const snapshot = getActiveSessionCars(sessionInfo);
    const newCars = snapshot.filter((c) => !this.knownCarIdxSet.has(c.carIdx));

    if (newCars.length === 0) return false;

    for (const car of newCars) {
      this.sessionCarList.push(car);
      this.knownCarIdxSet.add(car.carIdx);
    }

    // Re-sort the combined list by car number (numeric first, then alphabetic)
    this.sessionCarList.sort((a, b) => {
      const aNum = Number(a.carNumber);
      const bNum = Number(b.carNumber);
      const aIsNum = a.carNumber !== "" && !Number.isNaN(aNum);
      const bIsNum = b.carNumber !== "" && !Number.isNaN(bNum);

      if (aIsNum && bIsNum) return aNum - bNum;

      if (aIsNum) return -1;

      if (bIsNum) return 1;

      return a.carNumber.localeCompare(b.carNumber);
    });

    this.logger.debug(`Session car list updated: ${this.sessionCarList.length} cars (added ${newCars.length})`);

    return true;
  }

  /**
   * Resolve the car assigned to a button's slot, check its online status, and
   * re-render the button if anything has changed.
   */
  private updateCarFromSession(
    contextId: string,
    settings: SplitsDeltaCycleSettings,
    telemetry: TelemetryData | null,
  ): void {
    const car = this.sessionCarList[settings.slotIndex] ?? null;

    const carNumber = car?.carNumber ?? null;
    const carNumberRaw = car?.carNumberRaw ?? null;
    const carIdx = car?.carIdx ?? null;

    // Detect offline status: CarIdxTrackSurface is -1 (TrkLoc.NotInWorld) when
    // the car is not spawned / driver has disconnected.
    const trackSurfaces = telemetry?.CarIdxTrackSurface as number[] | undefined;
    const isOffline =
      carIdx !== null && trackSurfaces !== undefined ? trackSurfaces[carIdx] === TrkLoc.NotInWorld : false;

    const prevCarNumber = this.resolvedCarNumbers.get(contextId);
    const prevCarIdx = this.resolvedCarIdxs.get(contextId) ?? null;
    const prevIsOffline = this.resolvedOfflineStates.get(contextId) ?? false;

    this.resolvedCarNumbers.set(contextId, carNumber);
    this.resolvedCarRaws.set(contextId, carNumberRaw);
    this.resolvedCarIdxs.set(contextId, carIdx);
    this.resolvedOfflineStates.set(contextId, isOffline);

    // Only re-render when something visible has changed
    if (carNumber === prevCarNumber && carIdx === prevCarIdx && isOffline === prevIsOffline) return;

    const isSelected = carIdx !== null && getSelectedCar()?.carIdx === carIdx;
    const svg = generateSplitsDeltaCycleSvg(
      settings,
      this.isBindingMissing(this.resolveSettingKey(settings)),
      carNumber,
      isSelected,
      isOffline,
    );
    void this.updateKeyImage(contextId, svg);
  }
}
