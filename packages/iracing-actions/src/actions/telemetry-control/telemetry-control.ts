import {
  assembleIcon,
  CommonSettings,
  getGlobalBorderSettings,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  migrateLegacyActionToMode,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import { getCommands, SimIRacingAction } from "@iracedeck/deck-iracing";
import {
  collectStateSections,
  getCpuProfileCapture,
  isCpuProfileCaptureInitialized,
  type ProfileCaptureStatus,
} from "@iracedeck/diagnostics";
import captureProfileIconSvg from "@iracedeck/icons/telemetry-control/capture-profile.svg";
import markEventIconSvg from "@iracedeck/icons/telemetry-control/mark-event.svg";
import restartRecordingIconSvg from "@iracedeck/icons/telemetry-control/restart-recording.svg";
import snapshotIconSvg from "@iracedeck/icons/telemetry-control/snapshot.svg";
import startRecordingIconSvg from "@iracedeck/icons/telemetry-control/start-recording.svg";
import stopRecordingIconSvg from "@iracedeck/icons/telemetry-control/stop-recording.svg";
import toggleLoggingIconSvg from "@iracedeck/icons/telemetry-control/toggle-logging.svg";
import { buildSnapshotEnvelope, formatSnapshotJson, generateMarkdown, snapshotBaseName } from "@iracedeck/iracing-sdk";
import { getGlobalColors } from "@iracedeck/settings";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import z from "zod";

const ACTION_VALUES = [
  "toggle-logging",
  "mark-event",
  "start-recording",
  "stop-recording",
  "restart-recording",
  "snapshot",
  "capture-profile",
] as const;

type TelemetryControlAction = (typeof ACTION_VALUES)[number];

const ACTION_ICONS: Record<TelemetryControlAction, string> = {
  "toggle-logging": toggleLoggingIconSvg,
  "mark-event": markEventIconSvg,
  "start-recording": startRecordingIconSvg,
  "stop-recording": stopRecordingIconSvg,
  "restart-recording": restartRecordingIconSvg,
  snapshot: snapshotIconSvg,
  "capture-profile": captureProfileIconSvg,
};

/**
 * Title configuration for each telemetry control action
 */
const TELEMETRY_CONTROL_TITLES: Record<TelemetryControlAction, string> = {
  "toggle-logging": "TOGGLE\nLOGGING",
  "mark-event": "EVENT\nMARK",
  "start-recording": "RECORDING\nSTART",
  "stop-recording": "RECORDING\nSTOP",
  "restart-recording": "RECORDING\nRESTART",
  snapshot: "TAKE\nSNAPSHOT",
  "capture-profile": "CAPTURE\nPROFILE",
};

/** How long `SAVED` / `FAILED` stays on a Capture Profile key before its normal icon returns (#1338). */
export const CAPTURE_PROFILE_RESULT_HOLD_MS = 3000;

/** How often a Capture Profile key's countdown is redrawn. */
const CAPTURE_PROFILE_TICK_MS = 1000;

/**
 * @internal Exported for testing
 *
 * What a Capture Profile key shows, derived from the shared capture service's
 * state: the countdown while a capture runs, the outcome for a few seconds,
 * otherwise the normal icon.
 */
export type CaptureProfileDisplay =
  { kind: "idle" } | { kind: "capturing"; endsAt: number } | { kind: "saved" } | { kind: "failed" };

/**
 * @internal Exported for testing
 *
 * The title a Capture Profile key shows instead of its default, or undefined
 * for its normal title.
 */
export function captureProfileStatusTitle(display: CaptureProfileDisplay, now: number): string | undefined {
  switch (display.kind) {
    case "capturing":
      return `PROFILING\n${Math.max(0, Math.ceil((display.endsAt - now) / 1000))} s`;
    case "saved":
      return "SAVED";
    case "failed":
      return "FAILED";
    default:
      return undefined;
  }
}

/**
 * @internal Exported for testing
 *
 * Default output directory for telemetry snapshots: <home>/iRaceDeck/telemetry-snapshots.
 *
 * Deliberately rooted at the home directory rather than the "Documents" known
 * folder: on Windows, Documents is frequently redirected to OneDrive and/or
 * localized (e.g. "Tiedostot"), so `homedir()/Documents` points at a stale or
 * non-existent path. `homedir()/iRaceDeck` is predictable and always writable.
 */
export function defaultSnapshotDir(): string {
  return join(homedir(), "iRaceDeck", "telemetry-snapshots");
}

/**
 * Expands a leading `~` and Windows `%VAR%` environment placeholders in a path
 * string. Unknown `%VAR%` tokens are left intact.
 */
function expandPath(input: string): string {
  let expanded = input;

  if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(homedir(), expanded.slice(1));
  }

  return expanded.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match);
}

/**
 * @internal Exported for testing
 *
 * Resolves the effective snapshot output directory. Blank/whitespace falls back
 * to the default. The configured value has `~`/`%VAR%` expanded, and a relative
 * path is resolved against the user's home directory — NOT the plugin process
 * cwd, which is the Stream Deck plugin install folder.
 */
export function resolveSnapshotDir(outputDir: string | undefined): string {
  const trimmed = outputDir?.trim();

  if (!trimmed) return defaultSnapshotDir();

  const expanded = expandPath(trimmed);

  return isAbsolute(expanded) ? expanded : resolve(homedir(), expanded);
}

/**
 * The text of a thrown value, for a log line or an error entry. Total: the
 * value may not be an `Error`, its message may not be a string, and turning it
 * into one may itself throw.
 */
function describeThrown(error: unknown): string {
  try {
    const message: unknown = error instanceof Error ? error.message : error;

    return typeof message === "string" ? message : String(message);
  } catch {
    return "unknown error (it could not be described)";
  }
}

/**
 * @internal Exported for testing
 *
 * Mapping from keyboard-based telemetry control actions to global settings keys.
 * SDK-based actions are NOT included.
 */
export const TELEMETRY_CONTROL_GLOBAL_KEYS: Record<string, string> = {
  "toggle-logging": "telemetryControlToggleLogging",
  "mark-event": "telemetryControlMarkEvent",
};

/**
 * @internal Exported for testing
 */
export const TelemetryControlSettings = CommonSettings.extend({
  mode: z.enum(ACTION_VALUES).default("toggle-logging"),
  // Output directory for the "snapshot" mode (blank = default folder).
  outputDir: z.string().default(""),
});

export type TelemetryControlSettings = z.infer<typeof TelemetryControlSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the telemetry control action.
 */
export function generateTelemetryControlSvg(
  settings: TelemetryControlSettings,
  bindingMissing = false,
  statusTitle?: string,
): string {
  const { mode: actionType } = settings;

  const iconSvg = ACTION_ICONS[actionType] || ACTION_ICONS["toggle-logging"];
  const defaultTitle = TELEMETRY_CONTROL_TITLES[actionType] || TELEMETRY_CONTROL_TITLES["toggle-logging"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  // A status (Capture Profile's countdown, SAVED, FAILED) replaces the title
  // text, the user's own included, while it lasts; every other title setting
  // still applies.
  const title = statusTitle
    ? resolveTitleSettings(
        iconSvg,
        getGlobalTitleSettings(),
        { ...settings.titleOverrides, titleText: undefined },
        statusTitle,
      )
    : resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * Telemetry Control Action
 * Telemetry logging and recording controls for iRacing.
 * Toggle Logging and Mark Event use global key bindings;
 * Toggle Recording and Restart Recording use SDK telemetry commands.
 */
export const TELEMETRY_CONTROL_UUID = "com.iracedeck.sd.core.telemetry-control" as const;

export class TelemetryControl extends SimIRacingAction<TelemetryControlSettings> {
  /** Visible Capture Profile keys and their settings (#1338). */
  private readonly captureContexts = new Map<string, TelemetryControlSettings>();
  private captureDisplay: CaptureProfileDisplay = { kind: "idle" };
  private captureTick: ReturnType<typeof setInterval> | undefined;
  private captureHold: ReturnType<typeof setTimeout> | undefined;
  private unsubscribeCaptureStatus: (() => void) | undefined;

  override async onWillAppear(ev: IDeckWillAppearEvent<TelemetryControlSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const { migrated, changed } = migrateLegacyActionToMode(ev.payload.settings);

    if (changed) {
      try {
        await ev.action.setSettings(migrated);
      } catch (error) {
        this.logger.warn(`Failed to persist migrated settings: ${error instanceof Error ? error.message : error}`);
      }
    }

    const settings = this.parseSettings(migrated);
    const activeKey = TELEMETRY_CONTROL_GLOBAL_KEYS[settings.mode];
    this.setActiveBinding(activeKey ?? null);
    this.trackCaptureContext(ev.action.id, settings);

    await this.updateDisplay(ev, settings);
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<TelemetryControlSettings>): Promise<void> {
    this.untrackCaptureContext(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<TelemetryControlSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const activeKey = TELEMETRY_CONTROL_GLOBAL_KEYS[settings.mode];
    this.setActiveBinding(activeKey ?? null);
    this.trackCaptureContext(ev.action.id, settings);

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<TelemetryControlSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAction(settings);
  }

  override async onDialDown(ev: IDeckDialDownEvent<TelemetryControlSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAction(settings);
  }

  private parseSettings(settings: unknown): TelemetryControlSettings {
    const { migrated } = migrateLegacyActionToMode(settings);
    const parsed = TelemetryControlSettings.safeParse(migrated);

    return parsed.success ? parsed.data : TelemetryControlSettings.parse({});
  }

  private async executeAction(settings: TelemetryControlSettings): Promise<void> {
    const actionType = settings.mode;

    switch (actionType) {
      // Keyboard-based actions
      case "toggle-logging":
      case "mark-event": {
        const settingKey = TELEMETRY_CONTROL_GLOBAL_KEYS[actionType];

        if (!settingKey) {
          this.logger.warn(`No global key mapping for action: ${actionType}`);

          return;
        }

        await this.tapBinding(settingKey);
        break;
      }

      // SDK-based actions
      case "start-recording":
        this.executeSdkCommand(() => getCommands().telem.start(), "Start recording");
        break;
      case "stop-recording":
        this.executeSdkCommand(() => getCommands().telem.stop(), "Stop recording");
        break;
      case "restart-recording":
        this.executeSdkCommand(() => getCommands().telem.restart(), "Restart recording");
        break;

      // Disk-write action (developer tool) — reads live telemetry, no iRacing command.
      case "snapshot":
        this.captureSnapshot(settings);
        break;

      // The plugin's own CPU profile (#1338): sends nothing to iRacing.
      case "capture-profile":
        this.startCpuProfileCapture();
        break;
    }
  }

  /**
   * Start a capture on the shared service. A press while one runs (from
   * another key or the settings window) is refused by the service; the key
   * already shows that capture's countdown. The outcome reaches the key
   * through the status listener, and the service logs a failure's reason.
   */
  private startCpuProfileCapture(): void {
    if (!isCpuProfileCaptureInitialized()) {
      this.logger.warn("CPU profile capture is not available in this plugin");

      return;
    }

    void getCpuProfileCapture()
      .capture()
      .then((result) => {
        if (!result.ok && result.busy) this.logger.info("CPU profile capture already running");
      });
  }

  /** Follow (or stop following) a context, depending on whether it is a Capture Profile key. */
  private trackCaptureContext(contextId: string, settings: TelemetryControlSettings): void {
    if (settings.mode !== "capture-profile") {
      this.untrackCaptureContext(contextId);

      return;
    }

    this.captureContexts.set(contextId, settings);

    if (this.unsubscribeCaptureStatus || !isCpuProfileCaptureInitialized()) return;

    const capture = getCpuProfileCapture();
    this.unsubscribeCaptureStatus = capture.onStatus((status) => this.applyCaptureStatus(status));

    // A key that appears mid-capture picks the countdown up; an older outcome
    // is not news to it.
    const current = capture.status();

    if (current.state === "capturing") this.applyCaptureStatus(current);
  }

  private untrackCaptureContext(contextId: string): void {
    if (!this.captureContexts.delete(contextId) || this.captureContexts.size > 0) return;

    this.stopCaptureTimers();
    this.unsubscribeCaptureStatus?.();
    this.unsubscribeCaptureStatus = undefined;
    this.captureDisplay = { kind: "idle" };
  }

  private stopCaptureTimers(): void {
    if (this.captureTick !== undefined) clearInterval(this.captureTick);

    if (this.captureHold !== undefined) clearTimeout(this.captureHold);

    this.captureTick = undefined;
    this.captureHold = undefined;
  }

  private applyCaptureStatus(status: ProfileCaptureStatus): void {
    this.stopCaptureTimers();

    switch (status.state) {
      case "capturing":
        this.captureDisplay = { kind: "capturing", endsAt: status.startedAt + status.durationMs };
        this.captureTick = setInterval(() => this.renderCaptureContexts(), CAPTURE_PROFILE_TICK_MS);
        break;
      case "saved":
      case "failed":
        this.captureDisplay = { kind: status.state };
        this.captureHold = setTimeout(() => {
          this.captureHold = undefined;
          this.captureDisplay = { kind: "idle" };
          this.renderCaptureContexts();
        }, CAPTURE_PROFILE_RESULT_HOLD_MS);
        break;
      default:
        this.captureDisplay = { kind: "idle" };
    }

    this.renderCaptureContexts();
  }

  /** The SVG a context shows now: its status title when it is a Capture Profile key with something to say. */
  private renderTelemetryControlSvg(settings: TelemetryControlSettings): string {
    const statusTitle =
      settings.mode === "capture-profile" ? captureProfileStatusTitle(this.captureDisplay, Date.now()) : undefined;

    return generateTelemetryControlSvg(
      settings,
      this.isBindingMissing(TELEMETRY_CONTROL_GLOBAL_KEYS[settings.mode]),
      statusTitle,
    );
  }

  /**
   * Redraw every Capture Profile key through the same function its regenerate
   * callback runs, so a global-settings change mid-capture and the countdown
   * tick produce the same image.
   */
  private renderCaptureContexts(): void {
    for (const [contextId, settings] of this.captureContexts) {
      void this.updateKeyImage(contextId, this.renderTelemetryControlSvg(settings)).catch((error: unknown) => {
        this.logger.debug(`Capture Profile key update failed: ${error instanceof Error ? error.message : error}`);
      });
    }
  }

  private executeSdkCommand(command: () => boolean, label: string): void {
    const success = command();
    this.logger.info(`${label} executed`);
    this.logger.debug(`Result: ${success}`);
  }

  /**
   * Reads the current telemetry + session info and the plugin's own state
   * (#1387), and writes a timestamped JSON snapshot plus a Markdown companion
   * report. Feedback is log-only: success at info level, failures at warn/error
   * level.
   *
   * The JSON file is what a user sends in, so nothing optional can cost it: a
   * failure collecting the plugin's state becomes an error entry inside it, and
   * the report is generated and written only after it is on disk.
   */
  private captureSnapshot(settings: TelemetryControlSettings): void {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("Telemetry snapshot skipped: no telemetry available (is iRacing running?)");

      return;
    }

    const sessionInfo = this.sdkController.getSessionInfo() ?? null;

    // Collected straight after the telemetry read, in the same synchronous run:
    // the press is handled between SDK ticks, so the plugin's state and the
    // telemetry beside it describe the same tick. An `await` anywhere between
    // the two reads would let a tick land in between, so this method stays
    // synchronous.
    const pluginState = this.collectPluginState();

    const telemetryRecord = telemetry as unknown as Record<string, unknown>;
    const sessionRecord = sessionInfo as Record<string, unknown> | null;
    let now: Date;
    let jsonPath: string;
    let mdPath: string;

    // Everything below — including the pure envelope/markdown builders — runs
    // inside a try so a throw on malformed telemetry can never escape onto the
    // Stream Deck event loop as an unhandled rejection.
    try {
      now = new Date();

      const dir = resolveSnapshotDir(settings.outputDir);
      // snapshotBaseName includes milliseconds, so two presses within the same
      // second don't collide and silently overwrite each other.
      const baseName = snapshotBaseName(now);
      jsonPath = join(dir, `${baseName}.json`);
      mdPath = join(dir, `${baseName}.md`);

      const json = this.formatSnapshot(telemetryRecord, sessionRecord, now, pluginState.state);

      mkdirSync(dir, { recursive: true });
      writeFileSync(jsonPath, json, "utf-8");
    } catch (error) {
      this.logger.error(`Failed to write telemetry snapshot: ${describeThrown(error)}`);

      return;
    }

    // The report comes second and on its own: it walks the session info far
    // more than the envelope does, and a throw there must leave the JSON file.
    try {
      const markdown = generateMarkdown(
        telemetryRecord,
        sessionRecord,
        now,
        pluginState.rows.length > 0 ? [{ title: "Plugin State", rows: pluginState.rows }] : [],
      );

      writeFileSync(mdPath, markdown, "utf-8");
    } catch (error) {
      this.logger.warn("Telemetry snapshot saved without its Markdown report");
      this.logger.debug(`Snapshot written to ${jsonPath}; the report failed: ${describeThrown(error)}`);

      return;
    }

    this.logger.info("Telemetry snapshot saved");
    this.logger.debug(`Snapshot written to ${jsonPath} and ${mdPath}`);
  }

  /**
   * The plugin's own state for the snapshot (#1387), and its rows for the
   * report's Plugin State section. The collector isolates each section and puts
   * a row in place for one that failed; this covers the collector failing as a
   * whole, which becomes an error entry and no rows. It never throws, because a
   * failure here must not cost the telemetry.
   */
  private collectPluginState(): { state: unknown; rows: ReadonlyArray<readonly [string, string]> } {
    try {
      const collected = collectStateSections(this.logger);

      return { state: collected.state, rows: collected.headline };
    } catch (error) {
      const message = describeThrown(error);

      this.reportPluginStateFailure("Plugin state unavailable for the telemetry snapshot", message);

      return { state: { error: message }, rows: [] };
    }
  }

  /**
   * One WARN for a plugin-state failure, with the reason at debug. Guarded,
   * because both callers run before the JSON file is written and a logger that
   * throws is one way the collector fails: the report is lost, never the file.
   */
  private reportPluginStateFailure(summary: string, reason: string): void {
    try {
      this.logger.warn(summary);
      this.logger.debug(`Reason: ${reason}`);
    } catch {
      // Nothing left to report through; the snapshot is still written.
    }
  }

  /**
   * The JSON file's content. The collector's output is JSON-safe by
   * construction, so the fallback is for what should not happen: if the
   * envelope cannot be written with the plugin's state in it, it is written
   * with an error entry there instead. A throw from the fallback (the telemetry
   * itself is not JSON) reaches the caller, as it always did.
   */
  private formatSnapshot(
    telemetry: Record<string, unknown>,
    sessionInfo: Record<string, unknown> | null,
    now: Date,
    pluginState: unknown,
  ): string {
    try {
      return formatSnapshotJson(buildSnapshotEnvelope(telemetry, sessionInfo, true, now, pluginState));
    } catch (error) {
      const message = describeThrown(error);
      const json = formatSnapshotJson(buildSnapshotEnvelope(telemetry, sessionInfo, true, now, { error: message }));

      // Reported only once the fallback has formatted, so the plugin's state is
      // never blamed for telemetry that is itself not JSON.
      this.reportPluginStateFailure("Plugin state left out of the telemetry snapshot", message);

      return json;
    }
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<TelemetryControlSettings> | IDeckDidReceiveSettingsEvent<TelemetryControlSettings>,
    settings: TelemetryControlSettings,
  ): Promise<void> {
    const svgDataUri = this.renderTelemetryControlSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => this.renderTelemetryControlSvg(settings));
  }
}
