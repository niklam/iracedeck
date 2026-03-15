/**
 * Race Admin Action
 *
 * Sends iRacing session admin chat commands from the Stream Deck.
 * Single action with 28 subcommands organized via optgroups.
 */
import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
// ── Icon Imports ────────────────────────────────────────────────

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
import nextCarNumberIconSvg from "@iracedeck/icons/race-admin/next-car-number.svg";
import paceLapsIconSvg from "@iracedeck/icons/race-admin/pace-laps.svg";
import pitCloseIconSvg from "@iracedeck/icons/race-admin/pit-close.svg";
import pitOpenIconSvg from "@iracedeck/icons/race-admin/pit-open.svg";
import prevCarNumberIconSvg from "@iracedeck/icons/race-admin/prev-car-number.svg";
import rcMessageIconSvg from "@iracedeck/icons/race-admin/rc-message.svg";
import removeDriverIconSvg from "@iracedeck/icons/race-admin/remove-driver.svg";
import revokeAdminIconSvg from "@iracedeck/icons/race-admin/revoke-admin.svg";
import showDqsIconSvg from "@iracedeck/icons/race-admin/show-dqs.svg";
import singleFileRestartIconSvg from "@iracedeck/icons/race-admin/single-file-restart.svg";
import trackStateIconSvg from "@iracedeck/icons/race-admin/track-state.svg";
import waveAroundIconSvg from "@iracedeck/icons/race-admin/wave-around.svg";
import yellowIconSvg from "@iracedeck/icons/race-admin/yellow.svg";
import { getCarNumberFromSessionInfo, type TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import {
  CommonSettings,
  ConnectionStateAwareAction,
  createSDLogger,
  getCommands,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";
import { buildAdminCommand, findAdjacentCarByNumber } from "./race-admin-commands.js";
import { RACE_ADMIN_MODE_META, RACE_ADMIN_MODES, type RaceAdminMode } from "./race-admin-modes.js";

// ── Settings Schema ─────────────────────────────────────────────

const RaceAdminSettings = CommonSettings.extend({
  mode: z.enum(RACE_ADMIN_MODES).default("yellow"),
  useViewedCar: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(true),
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

const RACE_ADMIN_ICONS: Record<RaceAdminMode, string> = {
  yellow: yellowIconSvg,
  "black-flag": blackFlagIconSvg,
  "dq-driver": dqDriverIconSvg,
  "show-dqs": showDqsIconSvg,
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
  "next-car-number": nextCarNumberIconSvg,
  "prev-car-number": prevCarNumberIconSvg,
};

// ── Icon Generation ─────────────────────────────────────────────

/**
 * @internal Exported for testing
 */
export function generateRaceAdminSvg(mode: RaceAdminMode, settings: RaceAdminSettings): string {
  const meta = RACE_ADMIN_MODE_META[mode];
  const iconSvg = RACE_ADMIN_ICONS[mode];

  let { mainLabel, subLabel } = meta;

  // When pre-defined car number is set, show it on the icon
  if (meta.needsDriver && !settings.useViewedCar && settings.carNumber?.trim()) {
    subLabel = `#${settings.carNumber.trim()}`;
  }

  const svg = renderIconTemplate(iconSvg, { mainLabel, subLabel });

  return svgToDataUri(svg);
}

// ── Action Class ────────────────────────────────────────────────

@action({ UUID: "com.iracedeck.sd.core.race-admin" })
export class RaceAdmin extends ConnectionStateAwareAction<RaceAdminSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("RaceAdmin"), LogLevel.Info);

  private activeContexts = new Map<string, RaceAdminSettings>();
  private viewedCarNumbers = new Map<string, string | null>();

  private parseSettings(raw: unknown): RaceAdminSettings {
    const result = RaceAdminSettings.safeParse(raw);

    return result.success ? result.data : RaceAdminSettings.parse({});
  }

  // ── Lifecycle ───────────────────────────────────────────────

  override async onWillAppear(ev: WillAppearEvent<RaceAdminSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);

    await this.updateDisplay(ev, settings);

    // Subscribe to telemetry for CamCarIdx (driver targeting)
    this.sdkController.subscribe(ev.action.id, (telemetry: TelemetryData | null) => {
      this.updateConnectionState();
      this.updateViewedCar(ev.action.id, telemetry);
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<RaceAdminSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.viewedCarNumbers.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<RaceAdminSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    await this.updateDisplay(ev, settings);
  }

  // ── Key/Dial Handlers ───────────────────────────────────────

  override async onKeyDown(ev: KeyDownEvent<RaceAdminSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeMode(ev.action.id, settings);
  }

  override async onDialDown(ev: DialDownEvent<RaceAdminSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeMode(ev.action.id, settings);
  }

  override async onDialRotate(ev: DialRotateEvent<RaceAdminSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    const { mode } = settings;

    // Only car navigation modes respond to dial rotation
    if (mode === "next-car-number" || mode === "prev-car-number") {
      const direction = ev.payload.ticks > 0 ? "next" : "prev";
      this.executeCarNavigation(ev.action.id, direction);
    }
  }

  // ── Command Execution ───────────────────────────────────────

  private executeMode(contextId: string, settings: RaceAdminSettings): void {
    const { mode } = settings;

    // Car navigation modes use camera SDK, not chat
    if (mode === "next-car-number" || mode === "prev-car-number") {
      this.executeCarNavigation(contextId, mode === "next-car-number" ? "next" : "prev");

      return;
    }

    const viewedCarNumber = this.viewedCarNumbers.get(contextId) ?? null;
    const command = buildAdminCommand(mode, settings, viewedCarNumber, this.sdkController);

    if (!command) {
      this.logger.warn(`Could not build command for mode: ${mode}`);

      return;
    }

    const chat = getCommands().chat;
    const success = chat.sendMessage(command);
    this.logger.info("Admin command executed");
    this.logger.debug(`Command: "${command}", result: ${success}`);
  }

  private executeCarNavigation(contextId: string, direction: "next" | "prev"): void {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const camCarIdx = (telemetry?.CamCarIdx as number) ?? -1;

    if (camCarIdx < 0) {
      this.logger.warn("No camera target available for car navigation");

      return;
    }

    const sessionInfo = this.sdkController.getSessionInfo();
    const carNum = findAdjacentCarByNumber(sessionInfo, camCarIdx, direction);

    if (carNum === null) {
      this.logger.warn("Could not find adjacent car by number");

      return;
    }

    const camera = getCommands().camera;
    const success = camera.switchNum(carNum, 0, 0);
    this.logger.info("Car navigation executed");
    this.logger.debug(`Direction: ${direction}, carNum: ${carNum}, result: ${success}`);
  }

  // ── Display ─────────────────────────────────────────────────

  private async updateDisplay(
    ev: WillAppearEvent<RaceAdminSettings> | DidReceiveSettingsEvent<RaceAdminSettings>,
    settings: RaceAdminSettings,
  ): Promise<void> {
    const svg = generateRaceAdminSvg(settings.mode, settings);
    await this.setKeyImage(ev, svg);
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
    this.viewedCarNumbers.set(contextId, carNum !== null ? String(carNum) : null);
  }
}
