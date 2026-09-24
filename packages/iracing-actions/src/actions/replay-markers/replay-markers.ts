import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getCommands,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  getReplaySessionStore,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  isReplaySessionStoreInitialized,
  MARKER_DELETE_WINDOW_FRAMES,
  type ReplayMarker,
  type ReplaySessionStore,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
  type SubSessionScoped,
} from "@iracedeck/deck-core";
import addIconSvg from "@iracedeck/icons/replay-markers/add.svg";
import confirmAddedIconSvg from "@iracedeck/icons/replay-markers/confirm-added.svg";
import confirmDeletedIconSvg from "@iracedeck/icons/replay-markers/confirm-deleted.svg";
import deleteIconSvg from "@iracedeck/icons/replay-markers/delete.svg";
import nextIconSvg from "@iracedeck/icons/replay-markers/next.svg";
import previousIconSvg from "@iracedeck/icons/replay-markers/previous.svg";
import { ReplayPosMode, resolveReplayFrame, type TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import { cancelReplayCursorOwner } from "../../shared/replay-cursor.js";

/**
 * Replay Markers (issue #1162): mark a moment and jump back to it. A marker is
 * an absolute replay frame kept in the per-session replay store; Next and
 * Previous jump with one `setPlayPosition` broadcast. Design:
 * `docs/superpowers/specs/2026-09-13-issue-1162-replay-markers.md`.
 */

const REPLAY_MARKERS_MODES = ["add", "delete", "next", "previous"] as const;

type ReplayMarkersMode = (typeof REPLAY_MARKERS_MODES)[number];

/** Replay frames per second — the recording's fixed rate. */
const FRAMES_PER_SECOND = 60;

/** @internal Exported for testing */
export const SECONDS_BACK_DEFAULT = 5;
/** @internal Exported for testing */
export const SECONDS_BACK_MAX = 60;

/** How long the Added / Deleted confirmation stays on the key. */
/** @internal Exported for testing */
export const CONFIRMATION_FLASH_MS = 1_000;

/**
 * A number typed into the PI arrives as a string. Anything out of range is
 * brought into range, and anything unreadable reads as the default — a bad
 * value here must never fail the whole schema and reset the key's mode.
 */
function clampSecondsBack(value: number): number {
  if (!Number.isFinite(value)) return SECONDS_BACK_DEFAULT;

  return Math.min(SECONDS_BACK_MAX, Math.max(0, Math.round(value)));
}

/**
 * A cleared field arrives as "" (or whitespace, or null), which `z.coerce`
 * would read as 0 — silently marking the press moment itself. Blank reads as
 * unset, so the default applies.
 */
function blankToUndefined(value: unknown): unknown {
  if (value === null) return undefined;

  if (typeof value === "string" && value.trim() === "") return undefined;

  return value;
}

/** @internal Exported for testing */
export const ReplayMarkersSettings = CommonSettings.extend({
  mode: z.enum(REPLAY_MARKERS_MODES).default("add"),
  secondsBack: z
    .preprocess(blankToUndefined, z.coerce.number().default(SECONDS_BACK_DEFAULT))
    .transform(clampSecondsBack)
    .catch(SECONDS_BACK_DEFAULT),
});

/** @internal Exported for testing */
export type ReplayMarkersSettings = z.infer<typeof ReplayMarkersSettings>;

/** Title text for each mode (format: "subLabel\nmainLabel"). */
const REPLAY_MARKERS_TITLES: Record<ReplayMarkersMode, string> = {
  add: "MARKER\nADD",
  delete: "MARKER\nDELETE",
  next: "MARKER\nNEXT",
  previous: "MARKER\nPREVIOUS",
};

const REPLAY_MARKERS_ICONS: Record<ReplayMarkersMode, string> = {
  add: addIconSvg,
  delete: deleteIconSvg,
  next: nextIconSvg,
  previous: previousIconSvg,
};

/** The confirmation a successful Add or Delete flashes on the key. */
export type ReplayMarkerConfirmation = "added" | "deleted";

const CONFIRMATION_ICONS: Record<ReplayMarkerConfirmation, string> = {
  added: confirmAddedIconSvg,
  deleted: confirmDeletedIconSvg,
};

const CONFIRMATION_TITLES: Record<ReplayMarkerConfirmation, string> = {
  added: "MARKER\nADDED",
  deleted: "MARKER\nDELETED",
};

/**
 * @internal Exported for testing
 *
 * The key icon for a mode, or — with `confirmation` — the brief Added / Deleted
 * flash. The flash keeps the key's title styling but not its colour or title
 * text overrides: it is a fixed green / red signal, so it reads the same on
 * every key.
 */
export function generateReplayMarkersSvg(
  settings: ReplayMarkersSettings,
  confirmation?: ReplayMarkerConfirmation,
): string {
  if (confirmation) {
    const iconSvg = CONFIRMATION_ICONS[confirmation];
    const colors = resolveIconColors(iconSvg, getGlobalColors(), undefined);
    const { titleText: _ignored, ...titleStyle } = settings.titleOverrides ?? {};
    const title = resolveTitleSettings(
      iconSvg,
      getGlobalTitleSettings(),
      { ...titleStyle, showTitle: true },
      CONFIRMATION_TITLES[confirmation],
    );
    const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);
    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

    return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
  }

  const iconSvg = REPLAY_MARKERS_ICONS[settings.mode] ?? REPLAY_MARKERS_ICONS.add;
  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(
    iconSvg,
    getGlobalTitleSettings(),
    settings.titleOverrides,
    REPLAY_MARKERS_TITLES[settings.mode] ?? REPLAY_MARKERS_TITLES.add,
  );
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);
  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
}

/**
 * @internal Exported for testing
 *
 * The marker an Add press names: `secondsBack` before the current frame,
 * clamped at the recording's start. `pressFrame` keeps the frame the key was
 * pressed at, so Delete from the same spot reaches a marker set far back.
 * Session number and time are descriptive only (a person reading the file),
 * taken from the replay's own session while a replay plays and from the live
 * session otherwise.
 */
export function buildMarker(telemetry: TelemetryData, currentFrame: number, secondsBack: number): ReplayMarker {
  const inReplay = telemetry.IsReplayPlaying === true;
  const sessionNum = (inReplay ? telemetry.ReplaySessionNum : telemetry.SessionNum) ?? 0;
  const sessionTime = (inReplay ? telemetry.ReplaySessionTime : telemetry.SessionTime) ?? 0;

  return {
    frame: Math.max(0, currentFrame - secondsBack * FRAMES_PER_SECOND),
    pressFrame: currentFrame,
    sessionNum,
    sessionTimeMs: Math.max(0, Math.round((sessionTime - secondsBack) * 1000)),
  };
}

/**
 * @internal Exported for testing
 *
 * The marker a Delete press at `current` removes: the nearest one within
 * {@link MARKER_DELETE_WINDOW_FRAMES}, measured to the marker's frame or to
 * the frame its Add was pressed at (`pressFrame`), whichever is closer. The
 * second distance is what lets Delete from the car reach a marker set with a
 * long Seconds back — the car sits at the live edge, the marker well behind
 * it. Markers without a numeric `pressFrame` (older files) use the frame
 * alone. On a tie the earlier marker goes.
 */
export function pickMarkerToDelete(markers: readonly ReplayMarker[], current: number): ReplayMarker | null {
  let best: ReplayMarker | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const marker of markers) {
    const toFrame = Math.abs(current - marker.frame);
    const toPress =
      typeof marker.pressFrame === "number" && Number.isFinite(marker.pressFrame)
        ? Math.abs(current - marker.pressFrame)
        : Number.POSITIVE_INFINITY;
    const distance = Math.min(toFrame, toPress);

    if (distance <= MARKER_DELETE_WINDOW_FRAMES && distance < bestDistance) {
      best = marker;
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * @internal Exported for testing
 *
 * `WeekendInfo.SubSessionID` as a finite number, else undefined — the store
 * then takes the call for its active session.
 */
export function readSubSessionId(sessionInfo: unknown): number | undefined {
  const weekend = (sessionInfo as Record<string, unknown> | null | undefined)?.WeekendInfo as
    Record<string, unknown> | undefined;
  const raw = weekend?.SubSessionID;
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;

  return Number.isFinite(value) ? value : undefined;
}

export const REPLAY_MARKERS_UUID = "com.iracedeck.sd.core.replay-markers" as const;

export class ReplayMarkers extends ConnectionStateAwareAction<ReplayMarkersSettings> {
  private readonly activeContexts = new Map<string, ReplayMarkersSettings>();
  private readonly flashTimers = new Map<string, ReturnType<typeof setTimeout>>();

  override async onWillAppear(ev: IDeckWillAppearEvent<ReplayMarkersSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    await this.updateDisplay(ev, settings);
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<ReplayMarkersSettings>): Promise<void> {
    this.cancelFlash(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<ReplayMarkersSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.cancelFlash(ev.action.id);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<ReplayMarkersSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.logger.info(`Key down: ${settings.mode}`);

    const confirmation = this.execute(settings);

    if (confirmation) this.flash(ev.action.id, settings, confirmation);
  }

  private parseSettings(settings: unknown): ReplayMarkersSettings {
    const parsed = ReplayMarkersSettings.safeParse(settings);

    return parsed.success ? parsed.data : ReplayMarkersSettings.parse({});
  }

  /**
   * Run the mode. Returns the confirmation to flash for an Add or Delete that
   * changed the store, and undefined for everything else — a press that does
   * nothing shows nothing.
   */
  private execute(settings: ReplayMarkersSettings): ReplayMarkerConfirmation | undefined {
    if (!this.sdkController.getConnectionStatus()) {
      this.logger.debug("Not connected to iRacing; ignoring");

      return undefined;
    }

    if (!isReplaySessionStoreInitialized()) {
      this.logger.debug("Replay session store not initialized; ignoring");

      return undefined;
    }

    const telemetry = this.sdkController.getCurrentTelemetry();
    const frame = resolveReplayFrame(telemetry);

    if (!telemetry || frame === null) {
      this.logger.debug("No replay frame in telemetry; ignoring");

      return undefined;
    }

    const store: ReplaySessionStore = getReplaySessionStore();
    const subSessionId = readSubSessionId(this.sdkController.getSessionInfo());
    const scope: SubSessionScoped | undefined = subSessionId === undefined ? undefined : { subSessionId };

    switch (settings.mode) {
      case "add": {
        const marker = buildMarker(telemetry, frame, settings.secondsBack);
        const added = store.markers.add(marker, scope);
        this.logger.info(added ? "Marker added" : "Marker not added");
        this.logger.debug(`frame=${marker.frame} current=${frame} secondsBack=${settings.secondsBack}`);

        return added ? "added" : undefined;
      }
      case "delete": {
        const target = pickMarkerToDelete(store.markers.list(scope), frame);
        // Deleting at the chosen marker's own frame removes exactly that one:
        // it is at distance 0, and Add keeps any other more than 1 s away.
        const removed = target ? store.markers.deleteNearest(target.frame, scope) : null;
        this.logger.info(removed ? "Marker deleted" : "No marker near the current frame");
        this.logger.debug(`current=${frame} removed=${removed?.frame ?? "none"}`);

        return removed ? "deleted" : undefined;
      }
      case "next":
      case "previous": {
        // iRacing honours replay commands only out of the car (irsdk_defines.h:
        // "camera and replay commands only work when you are out of your car"),
        // so from the car a jump would be sent, ignored, and logged as done.
        if (telemetry.IsReplayPlaying !== true) {
          this.logger.debug(
            `${settings.mode}: replay not playing, and iRacing ignores replay commands from the car; open the replay first`,
          );

          return undefined;
        }

        const target =
          settings.mode === "next" ? store.markers.next(frame, scope) : store.markers.previous(frame, scope);

        if (!target) {
          this.logger.info(`No ${settings.mode} marker`);
          this.logger.debug(`current=${frame}`);

          return undefined;
        }

        // Takes the replay cursor from an in-flight Jump to Fastest Lap walk (#1203).
        cancelReplayCursorOwner(settings.mode);
        const success = getCommands().replay.setPlayPosition(ReplayPosMode.Begin, target.frame);
        this.logger.info(`Jumped to ${settings.mode} marker`);
        this.logger.debug(`Result: ${success}, current=${frame}, target=${target.frame}`);

        return undefined;
      }
    }
  }

  private flash(contextId: string, settings: ReplayMarkersSettings, confirmation: ReplayMarkerConfirmation): void {
    this.cancelFlash(contextId);
    void this.updateKeyImage(contextId, generateReplayMarkersSvg(settings, confirmation));

    const timer = setTimeout(() => {
      this.flashTimers.delete(contextId);
      const current = this.activeContexts.get(contextId);

      if (current) void this.updateKeyImage(contextId, generateReplayMarkersSvg(current));
    }, CONFIRMATION_FLASH_MS);

    this.flashTimers.set(contextId, timer);
  }

  private cancelFlash(contextId: string): void {
    const timer = this.flashTimers.get(contextId);

    if (timer) {
      clearTimeout(timer);
      this.flashTimers.delete(contextId);
    }
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<ReplayMarkersSettings> | IDeckDidReceiveSettingsEvent<ReplayMarkersSettings>,
    settings: ReplayMarkersSettings,
  ): Promise<void> {
    await ev.action.setTitle("");
    await this.setKeyImage(ev, generateReplayMarkersSvg(settings));
    this.setRegenerateCallback(ev.action.id, () =>
      generateReplayMarkersSvg(this.activeContexts.get(ev.action.id) ?? settings),
    );
  }
}
