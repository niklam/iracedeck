/**
 * Feeds the replay session store the session the SDK is connected to (#1162).
 *
 * The `sdkController.subscribe` callback every plugin wires beside the
 * elevation check: on each tick it reads `WeekendInfo` off the (cached) session
 * info and opens the store's record when the `SubSessionID` first appears or
 * changes — live or in a replay, which is what lets a `.rpy` opened days later
 * find its markers — and closes it when the SDK disconnects. It carries no
 * sim semantics beyond the session identity: what happens INSIDE a session
 * (crossings, lap times) is the translator's to detect.
 */
import type { SessionInfo, TelemetryCallback } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";

import type { ReplaySessionHeader } from "./replay-session-file.js";
import type { ReplaySessionStore } from "./replay-session-store.js";

export interface ReplaySessionSubscriberOptions {
  store: Pick<ReplaySessionStore, "setActiveSession" | "clearActiveSession">;
  /** `() => getController().getSessionInfo()`; cached per session-info update, so a per-tick read is cheap. */
  getSessionInfo: () => SessionInfo | null;
  logger: ILogger;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;

  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);

    return Number.isFinite(n) ? n : undefined;
  }

  return undefined;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/**
 * The store's header for a session, from its `WeekendInfo`; undefined while
 * the session info carries no readable `SubSessionID` (nothing loaded yet).
 *
 * `track` is the display name with its configuration ("Watkins Glen
 * International — Boot"). `series` is the `SeriesID` as text: the session YAML
 * names no series, and the id is what a person browsing the folder can look
 * up; it is empty for an offline session (id 0).
 */
export function replaySessionHeaderFromSessionInfo(sessionInfo: SessionInfo | null): ReplaySessionHeader | undefined {
  const weekend = sessionInfo?.WeekendInfo;

  if (weekend === null || typeof weekend !== "object") return undefined;

  const info = weekend as Record<string, unknown>;
  const subSessionId = asFiniteNumber(info.SubSessionID);

  if (subSessionId === undefined) return undefined;

  const trackName = asText(info.TrackDisplayName) || asText(info.TrackName);
  const config = asText(info.TrackConfigName);
  const seriesId = asFiniteNumber(info.SeriesID);

  return {
    subSessionId,
    track: config === "" ? trackName : `${trackName} — ${config}`,
    series: seriesId === undefined || seriesId === 0 ? "" : String(seriesId),
  };
}

/**
 * Create the `sdkController.subscribe` callback. Opens the store's record when
 * a `SubSessionID` appears or changes and closes it on disconnect; a session
 * info without one yet (the first ticks of a connection) leaves the store as
 * it is. Throws from the store are caught: the controller iterates its
 * subscribers unguarded, and a file problem must not starve the rest.
 */
export function createReplaySessionSubscriber(options: ReplaySessionSubscriberOptions): TelemetryCallback {
  const { store, getSessionInfo, logger } = options;
  let current: number | undefined;

  return (_telemetry, isConnected) => {
    try {
      if (!isConnected) {
        if (current !== undefined) {
          current = undefined;
          store.clearActiveSession();
        }

        return;
      }

      const header = replaySessionHeaderFromSessionInfo(getSessionInfo());

      if (header === undefined || header.subSessionId === current) return;

      current = header.subSessionId;
      store.setActiveSession(header);
    } catch (error: unknown) {
      logger.error("Replay session store failed to follow the session");
      logger.debug(
        `Replay session subscriber error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  };
}
