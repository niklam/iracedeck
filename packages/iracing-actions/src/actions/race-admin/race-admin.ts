/**
 * Race Admin Action
 *
 * Sends iRacing session admin chat commands from the Stream Deck.
 * Single action with 28 modes organized via optgroups: 27 admin chat commands
 * plus a car selector (select-car, #732) that picks the shared admin target.
 */
// ── Icon Imports ────────────────────────────────────────────────
import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getClipboard,
  getCommands,
  getDeviceSpec,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalSettings,
  getGlobalTitleSettings,
  getKeyboard,
  type IDeckDialDownEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  requestProfileSwitch,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
  updateGlobalSettings,
} from "@iracedeck/deck-core";
import advanceSessionIconSvg from "@iracedeck/icons/race-admin/advance-session.svg";
import blackFlagIconSvg from "@iracedeck/icons/race-admin/black-flag.svg";
import clearAllIconSvg from "@iracedeck/icons/race-admin/clear-all.svg";
import clearPenaltiesIconSvg from "@iracedeck/icons/race-admin/clear-penalties.svg";
import disableChatAllIconSvg from "@iracedeck/icons/race-admin/disable-chat-all.svg";
import disableChatDriverIconSvg from "@iracedeck/icons/race-admin/disable-chat-driver.svg";
import doubleFileRestartIconSvg from "@iracedeck/icons/race-admin/double-file-restart.svg";
import dqDriverIconSvg from "@iracedeck/icons/race-admin/dq-driver.svg";
import enableChatAllIconSvg from "@iracedeck/icons/race-admin/enable-chat-all.svg";
import enableChatDriverIconSvg from "@iracedeck/icons/race-admin/enable-chat-driver.svg";
import eolIconSvg from "@iracedeck/icons/race-admin/eol.svg";
import grantAdminIconSvg from "@iracedeck/icons/race-admin/grant-admin.svg";
import gridSetIconSvg from "@iracedeck/icons/race-admin/grid-set.svg";
import gridStartIconSvg from "@iracedeck/icons/race-admin/grid-start.svg";
import messageAllIconSvg from "@iracedeck/icons/race-admin/message-all.svg";
import paceLapsIconSvg from "@iracedeck/icons/race-admin/pace-laps.svg";
import pitCloseIconSvg from "@iracedeck/icons/race-admin/pit-close.svg";
import pitOpenIconSvg from "@iracedeck/icons/race-admin/pit-open.svg";
import rcMessageIconSvg from "@iracedeck/icons/race-admin/rc-message.svg";
import removeDriverIconSvg from "@iracedeck/icons/race-admin/remove-driver.svg";
import revokeAdminIconSvg from "@iracedeck/icons/race-admin/revoke-admin.svg";
import showDqsDriverIconSvg from "@iracedeck/icons/race-admin/show-dqs-driver.svg";
import showDqsFieldIconSvg from "@iracedeck/icons/race-admin/show-dqs-field.svg";
import singleFileRestartIconSvg from "@iracedeck/icons/race-admin/single-file-restart.svg";
import trackStateIconSvg from "@iracedeck/icons/race-admin/track-state.svg";
import waveAroundIconSvg from "@iracedeck/icons/race-admin/wave-around.svg";
import yellowIconSvg from "@iracedeck/icons/race-admin/yellow.svg";
import { getCarNumberFromSessionInfo, type TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import { IconUpdateThrottle } from "../../shared/icon-update-throttle.js";
import { migrateUseViewedCarToDriverTarget } from "./migrate-use-viewed-car.js";
import { buildAdminCommand, buildAdminCommandPrefix } from "./race-admin-commands.js";
import { RACE_ADMIN_MODE_META, RACE_ADMIN_MODES, type RaceAdminMode } from "./race-admin-modes.js";
import {
  availableProfilesForDevice,
  computeCarSlotIndex,
  DEFAULT_SELECTOR_TARGET_PROFILE,
  generateSelectorSvg,
  resolveSelectedCar,
  resolveSlotCar,
  SELECTED_CAR_KEY,
  type SelectorDisplayCar,
} from "./race-admin-selector.js";

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ── Settings Schema ─────────────────────────────────────────────

const RaceAdminSettings = CommonSettings.extend({
  mode: z.enum(RACE_ADMIN_MODES).default("yellow"),
  driverTarget: z.enum(["viewed-car", "specific", "type-in-chat", "selected-car"]).default("type-in-chat"),
  carNumber: z.string().default(""),
  message: z.string().default(""),
  penaltyType: z.enum(["time", "laps", "drivethrough"]).default("time"),
  penaltyValue: z.string().default("30"),
  paceLapsOperation: z.enum(["+", "-", "="]).default("+"),
  paceLapsValue: z.string().default("1"),
  gridSetMinutes: z.string().default("5"),
  trackStatePercent: z.string().default("50"),
  // Car selector (select-car mode, #732). Which page of the selector this button
  // is on (0-based); the field slot is derived from the grid position + page.
  // Stored as a string like every other numeric textfield here — a coercing
  // number schema would fail the WHOLE settings parse on stray non-digit input
  // and silently reset the button to the default "yellow" mode.
  selectorPage: z.string().default("0"),
  // Bundled profile to switch to after a car is picked ("" = the default).
  selectorTargetProfile: z.string().default(DEFAULT_SELECTOR_TARGET_PROFILE),
  /**
   * Runtime-populated list of profiles available for this button's device,
   * pushed for the Target Profile PI dropdown. Not user-editable.
   */
  _deviceProfiles: z.array(z.string()).optional(),
});

type RaceAdminSettings = z.infer<typeof RaceAdminSettings>;

/**
 * Static per-mode icons. The `select-car` mode renders a dynamic big-number
 * icon (see `generateSelectorSvg`) instead, so it is excluded here.
 *
 * @internal Exported for testing
 */
export const RACE_ADMIN_ICONS: Record<Exclude<RaceAdminMode, "select-car">, string> = {
  yellow: yellowIconSvg,
  "black-flag": blackFlagIconSvg,
  "dq-driver": dqDriverIconSvg,
  "show-dqs-field": showDqsFieldIconSvg,
  "show-dqs-driver": showDqsDriverIconSvg,
  "clear-penalties": clearPenaltiesIconSvg,
  "clear-all": clearAllIconSvg,
  "wave-around": waveAroundIconSvg,
  eol: eolIconSvg,
  "pit-close": pitCloseIconSvg,
  "pit-open": pitOpenIconSvg,
  "pace-laps": paceLapsIconSvg,
  "single-file-restart": singleFileRestartIconSvg,
  "double-file-restart": doubleFileRestartIconSvg,
  "advance-session": advanceSessionIconSvg,
  "grid-set": gridSetIconSvg,
  "grid-start": gridStartIconSvg,
  "track-state": trackStateIconSvg,
  "grant-admin": grantAdminIconSvg,
  "revoke-admin": revokeAdminIconSvg,
  "remove-driver": removeDriverIconSvg,
  "enable-chat-all": enableChatAllIconSvg,
  "enable-chat-driver": enableChatDriverIconSvg,
  "disable-chat-all": disableChatAllIconSvg,
  "disable-chat-driver": disableChatDriverIconSvg,
  "message-all": messageAllIconSvg,
  "rc-message": rcMessageIconSvg,
};

// ── Icon Generation ─────────────────────────────────────────────

/**
 * @internal Exported for testing
 */
export function generateRaceAdminSvg(
  mode: RaceAdminMode,
  settings: RaceAdminSettings,
  resolvedCar: SelectorDisplayCar | null = null,
): string {
  // The select-car mode renders a dynamic selector icon; the resolved car is
  // the one occupying this button's slot (null → blank black key).
  if (mode === "select-car") {
    return generateSelectorSvg(resolvedCar, settings);
  }

  const meta = RACE_ADMIN_MODE_META[mode];
  const iconSvg = RACE_ADMIN_ICONS[mode];

  // Build default title from meta labels (subLabel on top, mainLabel on bottom)
  let subLabel = meta.subLabel;

  // When a specific car number is configured, show it on the icon instead of the
  // generic subLabel. For the "viewed-car" and "type-in-chat" targets there's no
  // fixed number to display, so fall through to the default subLabel.
  if (meta.needsDriver && settings.driverTarget === "specific" && settings.carNumber?.trim()) {
    subLabel = `#${settings.carNumber.trim()}`;
  } else if (meta.needsDriver && settings.driverTarget === "selected-car") {
    // The shared admin target, resolved to the current session number.
    subLabel = resolvedCar ? `#${resolvedCar.carNumber}` : "NO CAR";
  }

  const defaultTitle = subLabel ? `${subLabel}\n${meta.mainLabel}` : meta.mainLabel;

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
}

// ── Action Class ────────────────────────────────────────────────

export const RACE_ADMIN_UUID = "com.iracedeck.sd.core.race-admin" as const;

export class RaceAdmin extends ConnectionStateAwareAction<RaceAdminSettings> {
  private activeContexts = new Map<string, RaceAdminSettings>();
  private viewedCarNumbers = new Map<string, string | null>();
  private typeInChatInFlight = new Set<string>();
  /** Per-context grid position + device type, for the select-car slot math. */
  private selectorContexts = new Map<string, { column: number; row: number; deviceType?: number }>();
  /**
   * Display key (car number + driver name) last successfully rendered per
   * dynamic-icon context (`null` = empty slot / no selection). The telemetry
   * refresh dedupes on this BEFORE assembling the SVG, and only records it
   * AFTER `setImage` succeeds — so a transient failure retries on the next
   * tick instead of poisoning the cache.
   */
  private lastDynamicCar = new Map<string, string | null>();

  /** Stable dedupe key for a resolved display car. */
  private static displayCarKey(car: SelectorDisplayCar | null): string | null {
    return car ? `${car.carNumber} ${car.lastName ?? ""}` : null;
  }
  /** Caps live icon re-renders (select-car / selected-car) at ~10 Hz. */
  private readonly imageThrottle = new IconUpdateThrottle();

  private parseSettings(raw: unknown): RaceAdminSettings {
    const { migrated } = migrateUseViewedCarToDriverTarget(raw);
    const result = RaceAdminSettings.safeParse(migrated);

    return result.success ? result.data : RaceAdminSettings.parse({});
  }

  /**
   * Detect a legacy `useViewedCar` setting and persist the migrated shape to
   * Stream Deck storage so the legacy key is permanently dropped. Logs and
   * swallows persist failures — the runtime always reads via `parseSettings`,
   * so a failed persist doesn't block functionality.
   */
  private async persistMigratedSettings(
    ev: IDeckWillAppearEvent<RaceAdminSettings> | IDeckDidReceiveSettingsEvent<RaceAdminSettings>,
  ): Promise<void> {
    const { migrated, changed } = migrateUseViewedCarToDriverTarget(ev.payload.settings);

    if (!changed) return;

    try {
      await ev.action.setSettings(migrated);
    } catch (err) {
      this.logger.warn(`Failed to persist migrated race-admin settings: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────

  override async onWillAppear(ev: IDeckWillAppearEvent<RaceAdminSettings>): Promise<void> {
    await super.onWillAppear(ev);
    await this.persistMigratedSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.rememberContext(ev);
    await this.pushDeviceProfiles(ev, settings);

    await this.updateDisplay(ev, settings);

    // Subscribe to telemetry: track the viewed car (viewed-car target) and keep
    // the dynamic select-car / selected-car icon in sync with the live field.
    this.sdkController.subscribe(ev.action.id, (telemetry: TelemetryData | null) => {
      this.updateViewedCar(ev.action.id, telemetry);
      this.refreshDynamicIcon(ev.action.id);
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<RaceAdminSettings>): Promise<void> {
    // Clear the pending throttle BEFORE awaiting super so a trailing flush can't
    // fire against a context that's mid-teardown.
    this.imageThrottle.clear(ev.action.id);
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.viewedCarNumbers.delete(ev.action.id);
    this.typeInChatInFlight.delete(ev.action.id);
    this.selectorContexts.delete(ev.action.id);
    this.lastDynamicCar.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<RaceAdminSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    await this.persistMigratedSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.rememberContext(ev);
    await this.pushDeviceProfiles(ev, settings);
    await this.updateDisplay(ev, settings);
  }

  // ── Key/Dial Handlers ───────────────────────────────────────

  override async onKeyDown(ev: IDeckKeyDownEvent<RaceAdminSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);

    // The car selector needs the key's grid coordinates, so it's handled from
    // the event rather than the coordinate-less executeMode path.
    if (settings.mode === "select-car") {
      await this.executeSelect(ev, settings);

      return;
    }

    await this.executeMode(ev.action.id, settings);
  }

  override async onDialDown(ev: IDeckDialDownEvent<RaceAdminSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeMode(ev.action.id, settings);
  }

  // ── Command Execution ───────────────────────────────────────

  private async executeMode(contextId: string, settings: RaceAdminSettings): Promise<void> {
    const { mode } = settings;

    // select-car is keypad-only (needs grid coordinates) and is handled in
    // onKeyDown; ignore it here (e.g. a dial press) — it has no chat command.
    if (mode === "select-car") return;

    const meta = RACE_ADMIN_MODE_META[mode];

    // "Type in chat" only applies to driver-targeted modes — for non-driver
    // modes a leftover `driverTarget: "type-in-chat"` setting is ignored and
    // the command is dispatched normally via the SDK.
    if (meta.needsDriver && settings.driverTarget === "type-in-chat") {
      await this.executeTypeInChat(contextId, mode);

      return;
    }

    const viewedCarNumber = this.viewedCarNumbers.get(contextId) ?? null;
    const selectedCarNumber = this.resolveSelectedCarNumber();
    const command = buildAdminCommand(mode, settings, viewedCarNumber, this.sdkController, selectedCarNumber);

    if (!command) {
      this.logger.warn(`Could not build command for mode: ${mode}`);

      return;
    }

    const chat = getCommands().chat;
    const success = await chat.sendMessage(command);

    if (success) {
      this.logger.info("Admin command executed");
    } else {
      this.logger.warn("Failed to send admin command");
    }

    this.logger.debug(`Command: "${command}", result: ${success}`);
  }

  /**
   * "Type in chat" driver-target mode (issue #491).
   *
   * Writes the command prefix (e.g. `"!clear "` with trailing space) to the
   * OS clipboard, opens iRacing chat via the SDK, waits ~100ms for the input
   * box to focus, and sends Ctrl+V to paste. **Does NOT send Enter** — the
   * admin types the driver number themselves and submits manually.
   *
   * Re-entrancy: a per-context guard drops back-to-back fires while one is
   * still in flight, preventing the second fire from clobbering the clipboard
   * before the first paste lands.
   */
  private async executeTypeInChat(contextId: string, mode: RaceAdminMode): Promise<void> {
    if (this.typeInChatInFlight.has(contextId)) {
      this.logger.debug(`type-in-chat: dropping concurrent fire for ${contextId}`);

      return;
    }

    this.typeInChatInFlight.add(contextId);

    try {
      const prefix = buildAdminCommandPrefix(mode);

      if (!prefix) {
        this.logger.warn(`type-in-chat: no command prefix for mode: ${mode}`);

        return;
      }

      if (!getClipboard().setClipboardText(prefix)) {
        this.logger.warn(`type-in-chat: clipboard write failed, aborting (mode: ${mode})`);

        return;
      }

      const opened = getCommands().chat.beginChat();

      if (!opened) {
        this.logger.warn("type-in-chat: chat.beginChat() failed, aborting");

        return;
      }

      // Give iRacing a couple frames to actually focus the chat input box
      // before pasting. Without this, Ctrl+V lands on an empty viewport. The
      // wait is the shared `chatOpenToPasteDelayMs` global setting (issue
      // #581) so every paste-into-chat flow tunes from one place; Race Admin
      // doesn't press Enter, so the paste→enter delay doesn't apply here.
      const openToPasteDelayMs = getGlobalSettings().chatOpenToPasteDelayMs ?? 200;
      await new Promise<void>((resolve) => setTimeout(resolve, openToPasteDelayMs));

      await getKeyboard().sendKeyCombination({ key: "v", code: "KeyV", modifiers: ["ctrl"] });

      this.logger.info("Type-in-chat prefix pasted");
      this.logger.debug(`Prefix: "${prefix}" (${prefix.length} chars)`);
    } finally {
      this.typeInChatInFlight.delete(contextId);
    }
  }

  // ── Display ─────────────────────────────────────────────────

  private async updateDisplay(
    ev: IDeckWillAppearEvent<RaceAdminSettings> | IDeckDidReceiveSettingsEvent<RaceAdminSettings>,
    settings: RaceAdminSettings,
  ): Promise<void> {
    // Drop the dedupe entry first: if the render below fails, the next
    // telemetry tick re-renders instead of matching a stale cache entry.
    this.lastDynamicCar.delete(ev.action.id);
    const car = this.resolveIconCar(ev.action.id, settings);
    const svg = generateRaceAdminSvg(settings.mode, settings, car);
    await this.setKeyImage(ev, svg);
    this.lastDynamicCar.set(ev.action.id, RaceAdmin.displayCarKey(car));
    this.setRegenerateCallback(ev.action.id, () =>
      generateRaceAdminSvg(settings.mode, settings, this.resolveIconCar(ev.action.id, settings)),
    );
  }

  // ── Car Selector (issue #732) ───────────────────────────────

  /** Remember this button's grid position + device type for the selector slot math. */
  private rememberContext(
    ev: IDeckWillAppearEvent<RaceAdminSettings> | IDeckDidReceiveSettingsEvent<RaceAdminSettings>,
  ): void {
    this.selectorContexts.set(ev.action.id, {
      column: ev.payload.coordinates?.column ?? 0,
      row: ev.payload.coordinates?.row ?? 0,
      deviceType: ev.action.deviceType,
    });
  }

  /**
   * Push the device-filtered profile list for the Target Profile PI dropdown
   * (select-car mode only; guarded against the setSettings→onDidReceiveSettings
   * echo loop by only writing on change — same pattern as Switch Profile).
   */
  private async pushDeviceProfiles(
    ev: IDeckWillAppearEvent<RaceAdminSettings> | IDeckDidReceiveSettingsEvent<RaceAdminSettings>,
    settings: RaceAdminSettings,
  ): Promise<void> {
    if (settings.mode !== "select-car") return;

    const available = availableProfilesForDevice(ev.action.deviceType);
    const raw = (ev.payload.settings ?? {}) as Record<string, unknown>;
    const current = Array.isArray(raw._deviceProfiles) ? (raw._deviceProfiles as string[]) : [];

    if (arraysEqual(current, available)) return;

    try {
      await ev.action.setSettings({ ...raw, _deviceProfiles: available });
    } catch (err) {
      this.logger.warn(`Failed to push device profiles: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * select-car press: resolve the car occupying this key's slot, store its
   * CarIdx as the shared admin target, and switch to the per-car commands
   * profile. An empty slot is a no-op.
   */
  private async executeSelect(ev: IDeckKeyDownEvent<RaceAdminSettings>, settings: RaceAdminSettings): Promise<void> {
    const grid = getDeviceSpec(ev.action.deviceType ?? -1)?.grid ?? null;
    const slot = computeCarSlotIndex(
      ev.payload.coordinates?.column ?? -1,
      ev.payload.coordinates?.row ?? -1,
      grid,
      Number(settings.selectorPage),
    );
    const car = resolveSlotCar(this.sdkController.getSessionInfo(), slot);

    if (!car) {
      this.logger.info("Select car pressed on an empty slot");

      return;
    }

    // A cleared PI textfield persists "" (bypassing the Zod default) — fall
    // back to the bundled per-car profile, mirroring SwitchProfile's guard.
    const targetProfile = settings.selectorTargetProfile.trim() || DEFAULT_SELECTOR_TARGET_PROFILE;

    this.logger.info("Admin target car selected");
    this.logger.debug(`Selected CarIdx ${car.carIdx} (#${car.carNumber}); switching to "${targetProfile}"`);
    updateGlobalSettings({ [SELECTED_CAR_KEY]: { carIdx: car.carIdx, carNumber: car.carNumber } });
    await requestProfileSwitch(ev.action.deviceId, targetProfile);
  }

  /**
   * Car number of the shared admin target, or null when nothing is selected or
   * the stored CarIdx no longer resolves to the number it was selected as
   * (session changed — CarIdx assignments are session-scoped).
   */
  private resolveSelectedCarNumber(): string | null {
    const raw = (getGlobalSettings() as Record<string, unknown>)[SELECTED_CAR_KEY];

    return resolveSelectedCar(raw, (carIdx) =>
      getCarNumberFromSessionInfo(this.sdkController.getSessionInfo(), carIdx),
    );
  }

  /**
   * The car this button's icon should show: the slot car (number + driver last
   * name) for select-car, or the shared admin target for a selected-car command
   * mode. `null` for every other (static) mode.
   */
  private resolveIconCar(contextId: string, settings: RaceAdminSettings): SelectorDisplayCar | null {
    if (settings.mode === "select-car") {
      const ctx = this.selectorContexts.get(contextId);

      if (!ctx) return null;

      const grid = getDeviceSpec(ctx.deviceType ?? -1)?.grid ?? null;
      const slot = computeCarSlotIndex(ctx.column, ctx.row, grid, Number(settings.selectorPage));

      return resolveSlotCar(this.sdkController.getSessionInfo(), slot);
    }

    if (RACE_ADMIN_MODE_META[settings.mode].needsDriver && settings.driverTarget === "selected-car") {
      const carNumber = this.resolveSelectedCarNumber();

      return carNumber ? { carNumber } : null;
    }

    return null;
  }

  /**
   * Re-render the icon for dynamic modes (select-car and the selected-car
   * target) as the live field changes. No-op for static modes; throttled, and
   * deduped on the RESOLVED car number before any SVG assembly — a selector
   * page full of keys would otherwise do ~10 full renders/second per key just
   * to conclude nothing changed.
   */
  private refreshDynamicIcon(contextId: string): void {
    const settings = this.activeContexts.get(contextId);

    if (!settings) return;

    const isSelector = settings.mode === "select-car";
    const isSelectedTarget =
      RACE_ADMIN_MODE_META[settings.mode].needsDriver && settings.driverTarget === "selected-car";

    if (!isSelector && !isSelectedTarget) return;

    this.imageThrottle.schedule(contextId, async () => {
      const current = this.activeContexts.get(contextId);

      if (!current) return;

      const car = this.resolveIconCar(contextId, current);
      const key = RaceAdmin.displayCarKey(car);

      if (this.lastDynamicCar.has(contextId) && this.lastDynamicCar.get(contextId) === key) return;

      const svg = generateRaceAdminSvg(current.mode, current, car);
      await this.updateKeyImage(contextId, svg);
      // Record only after the image update succeeded — a rejection above
      // leaves the cache unset so the next tick retries.
      this.lastDynamicCar.set(contextId, key);
    });
  }

  // ── Telemetry ───────────────────────────────────────────────

  private updateViewedCar(contextId: string, telemetry: TelemetryData | null): void {
    const camCarIdx = (telemetry?.CamCarIdx as number) ?? -1;

    if (camCarIdx < 0) {
      this.viewedCarNumbers.set(contextId, null);

      return;
    }

    const sessionInfo = this.sdkController.getSessionInfo();
    const carNum = getCarNumberFromSessionInfo(sessionInfo, camCarIdx);
    this.viewedCarNumbers.set(contextId, carNum);
  }
}
