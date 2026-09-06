import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getCommands,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  migrateLegacyActionToMode,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import markEventIconSvg from "@iracedeck/icons/telemetry-control/mark-event.svg";
import restartRecordingIconSvg from "@iracedeck/icons/telemetry-control/restart-recording.svg";
import snapshotIconSvg from "@iracedeck/icons/telemetry-control/snapshot.svg";
import startRecordingIconSvg from "@iracedeck/icons/telemetry-control/start-recording.svg";
import stopRecordingIconSvg from "@iracedeck/icons/telemetry-control/stop-recording.svg";
import toggleLoggingIconSvg from "@iracedeck/icons/telemetry-control/toggle-logging.svg";
import { buildSnapshotEnvelope, generateMarkdown, snapshotBaseName } from "@iracedeck/iracing-sdk";
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
] as const;

type TelemetryControlAction = (typeof ACTION_VALUES)[number];

const ACTION_ICONS: Record<TelemetryControlAction, string> = {
  "toggle-logging": toggleLoggingIconSvg,
  "mark-event": markEventIconSvg,
  "start-recording": startRecordingIconSvg,
  "stop-recording": stopRecordingIconSvg,
  "restart-recording": restartRecordingIconSvg,
  snapshot: snapshotIconSvg,
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
};

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
export function generateTelemetryControlSvg(settings: TelemetryControlSettings, bindingMissing = false): string {
  const { mode: actionType } = settings;

  const iconSvg = ACTION_ICONS[actionType] || ACTION_ICONS["toggle-logging"];
  const defaultTitle = TELEMETRY_CONTROL_TITLES[actionType] || TELEMETRY_CONTROL_TITLES["toggle-logging"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

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

export class TelemetryControl extends ConnectionStateAwareAction<TelemetryControlSettings> {
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

    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<TelemetryControlSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const activeKey = TELEMETRY_CONTROL_GLOBAL_KEYS[settings.mode];
    this.setActiveBinding(activeKey ?? null);

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
    }
  }

  private executeSdkCommand(command: () => boolean, label: string): void {
    const success = command();
    this.logger.info(`${label} executed`);
    this.logger.debug(`Result: ${success}`);
  }

  /**
   * Reads the current telemetry + session info and writes a timestamped JSON
   * snapshot plus a Markdown companion report. Feedback is log-only: success at
   * info level, failures at warn/error level.
   */
  private captureSnapshot(settings: TelemetryControlSettings): void {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("Telemetry snapshot skipped: no telemetry available (is iRacing running?)");

      return;
    }

    const sessionInfo = this.sdkController.getSessionInfo() ?? null;

    // Everything below — including the pure envelope/markdown builders — runs
    // inside the try so a throw on malformed telemetry can never escape onto the
    // Stream Deck event loop as an unhandled rejection.
    try {
      const now = new Date();
      const envelope = buildSnapshotEnvelope(
        telemetry as unknown as Record<string, unknown>,
        sessionInfo as Record<string, unknown> | null,
        true,
        now,
      );
      const markdown = generateMarkdown(
        telemetry as unknown as Record<string, unknown>,
        sessionInfo as Record<string, unknown> | null,
        now,
      );

      const dir = resolveSnapshotDir(settings.outputDir);
      // snapshotBaseName includes milliseconds, so two presses within the same
      // second don't collide and silently overwrite each other.
      const baseName = snapshotBaseName(now);
      const jsonPath = join(dir, `${baseName}.json`);
      const mdPath = join(dir, `${baseName}.md`);

      mkdirSync(dir, { recursive: true });
      writeFileSync(jsonPath, JSON.stringify(envelope, null, 2), "utf-8");
      writeFileSync(mdPath, markdown, "utf-8");
      this.logger.info("Telemetry snapshot saved");
      this.logger.debug(`Snapshot written to ${jsonPath} and ${mdPath}`);
    } catch (error) {
      this.logger.error(`Failed to write telemetry snapshot: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<TelemetryControlSettings> | IDeckDidReceiveSettingsEvent<TelemetryControlSettings>,
    settings: TelemetryControlSettings,
  ): Promise<void> {
    const svgDataUri = generateTelemetryControlSvg(
      settings,
      this.isBindingMissing(TELEMETRY_CONTROL_GLOBAL_KEYS[settings.mode]),
    );
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () =>
      generateTelemetryControlSvg(settings, this.isBindingMissing(TELEMETRY_CONTROL_GLOBAL_KEYS[settings.mode])),
    );
  }
}
