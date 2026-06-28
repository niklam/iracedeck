/**
 * Race Admin Action
 *
 * Sends iRacing session admin chat commands from the Stream Deck.
 * Single action with 27 subcommands organized via optgroups.
 */
// ── Icon Imports ────────────────────────────────────────────────
import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getClipboard,
  getCommands,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalSettings,
  getGlobalTitleSettings,
  getKeyboard,
  getSelectedCar,
  type IDeckDialDownEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
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

import { migrateUseViewedCarToDriverTarget } from "./migrate-use-viewed-car.js";
import { buildAdminCommand, buildAdminCommandPrefix } from "./race-admin-commands.js";
import { RACE_ADMIN_MODE_META, RACE_ADMIN_MODES, type RaceAdminMode } from "./race-admin-modes.js";

// ── Settings Schema ─────────────────────────────────────────────

const RaceAdminSettings = CommonSettings.extend({
  mode: z.enum(RACE_ADMIN_MODES).default("yellow"),
  driverTarget: z.enum(["viewed-car", "selected-car", "specific", "type-in-chat"]).default("type-in-chat"),
  carNumber: z.string().default(""),
  message: z.string().default(""),
  penaltyType: z.enum(["time", "laps", "drivethrough"]).default("time"),
  penaltyValue: z.string().default("30"),
  paceLapsOperation: z.enum(["+", "-", "="]).default("+"),
  paceLapsValue: z.string().default("1"),
  gridSetMinutes: z.string().default("5"),
  trackStatePercent: z.string().default("50"),
});

type RaceAdminSettings = z.infer<typeof RaceAdminSettings>;

/**
 * @internal Exported for testing
 */
export const RACE_ADMIN_ICONS: Record<RaceAdminMode, string> = {
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
export function generateRaceAdminSvg(mode: RaceAdminMode, settings: RaceAdminSettings): string {
  const meta = RACE_ADMIN_MODE_META[mode];
  const iconSvg = RACE_ADMIN_ICONS[mode];

  // Build default title from meta labels (subLabel on top, mainLabel on bottom)
  let subLabel = meta.subLabel;

  // When a specific car number is configured, show it on the icon instead of the
  // generic subLabel. For the "viewed-car" and "type-in-chat" targets there's no
  // fixed number to display, so fall through to the default subLabel.
  if (meta.needsDriver && settings.driverTarget === "specific" && settings.carNumber?.trim()) {
    subLabel = `#${settings.carNumber.trim()}`;
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

    await this.updateDisplay(ev, settings);

    // Subscribe to telemetry for CamCarIdx (driver targeting)
    this.sdkController.subscribe(ev.action.id, (telemetry: TelemetryData | null) => {
      this.updateViewedCar(ev.action.id, telemetry);
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<RaceAdminSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.viewedCarNumbers.delete(ev.action.id);
    this.typeInChatInFlight.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<RaceAdminSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    await this.persistMigratedSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    await this.updateDisplay(ev, settings);
  }

  // ── Key/Dial Handlers ───────────────────────────────────────

  override async onKeyDown(ev: IDeckKeyDownEvent<RaceAdminSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
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
    const meta = RACE_ADMIN_MODE_META[mode];

    // "Type in chat" only applies to driver-targeted modes — for non-driver
    // modes a leftover `driverTarget: "type-in-chat"` setting is ignored and
    // the command is dispatched normally via the SDK.
    if (meta.needsDriver && settings.driverTarget === "type-in-chat") {
      await this.executeTypeInChat(contextId, mode);

      return;
    }

    // "Selected car" requires a prior selection via a Select Reference Car button.
    if (meta.needsDriver && settings.driverTarget === "selected-car" && !getSelectedCar()) {
      this.logger.warn("Cannot execute admin command: no car selected — press a Select Reference Car button first");

      return;
    }

    const viewedCarNumber = this.viewedCarNumbers.get(contextId) ?? null;
    const command = buildAdminCommand(mode, settings, viewedCarNumber, this.sdkController);

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
    const svg = generateRaceAdminSvg(settings.mode, settings);
    await this.setKeyImage(ev, svg);
    this.setRegenerateCallback(ev.action.id, () => generateRaceAdminSvg(settings.mode, settings));
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
