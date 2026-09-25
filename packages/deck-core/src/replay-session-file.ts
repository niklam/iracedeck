/**
 * The per-session replay file (issue #1162): its envelope, its location and
 * the constants the sim facts settled. Persistence lives in
 * `replay-session-store.ts`; the sections' logic in `replay-markers.ts` and
 * `replay-laps.ts`. Design: docs/superpowers/specs/2026-09-13-issue-1162-replay-markers.md.
 *
 * `%LOCALAPPDATA%\iRaceDeck\Replay\session_<SubSessionID>.json` is not a
 * markers file: it is where iRaceDeck keeps anything it learns about one
 * session's replay, one section per feature under `sections`. The envelope's
 * `version` covers the envelope only — a section versions its own contents.
 */
import { join } from "node:path";

import { nonBlank, resolveLocalAppData, settingsStoreFolderName } from "./settings-store.js";

/** The envelope version this build writes. */
export const REPLAY_FILE_VERSION = 1;

/**
 * How many frames LATER a moment appears in a saved `.rpy` than the live
 * `ReplayFrameNumEnd` said (measured once: 59, about one second). Recorded,
 * NOT applied: a live frame is stored raw, and every consumer's window
 * tolerates a one-second-early landing. If the in-session replay is found to
 * carry the same lag, this becomes a one-constant correction at record time —
 * the #1203 manual test measures it.
 */
export const REPLAY_FILE_FRAME_LAG = 59;

/** What the plugin knows about the active session when it opens its record. */
export interface ReplaySessionHeader {
  /** `WeekendInfo.SubSessionID`; 0 for an offline session (held in memory, never written). */
  subSessionId: number;
  /** Track display name (with its configuration), for a person browsing the folder. */
  track: string;
  /** The series, for the same reader; the session YAML carries only `SeriesID`. */
  series: string;
  /**
   * ISO instant the session started. Optional: a file that already carries one
   * keeps it, and a new record is stamped with the moment the store first saw
   * the session when the caller supplies none.
   */
  sessionStart?: string;
}

/**
 * The file as written: the header plus every feature's section. The index
 * signature is forward compatibility: an envelope field this build does not
 * know (the spec's future `frameBase`) is carried through every write.
 */
export interface ReplaySessionFile {
  [key: string]: unknown;
  version: number;
  subSessionId: number;
  track: string;
  series: string;
  sessionStart: string;
  /** One key per feature. The store preserves every key it has no reader for. */
  sections: Record<string, unknown>;
}

/** `session_<SubSessionID>.json`. */
export function replaySessionFileName(subSessionId: number): string {
  return `session_${subSessionId}.json`;
}

export interface ResolveReplayStoreDirectoryOptions {
  /** `getPluginPlatform()` — "stream-deck" | "mirabox" | "ulanzi". */
  platform: string;
  env: Record<string, string | undefined>;
}

/**
 * `%LOCALAPPDATA%\iRaceDeck\Replay\<ecosystem>`, the ecosystem folder being
 * the settings store's (`settingsStoreFolderName`). Per ecosystem for the same
 * reason the settings file is: two deck hosts run two plugin processes at
 * once, each holding its own copy of the session's record, and one folder
 * would have them rename their copies over each other every debounce. The
 * cost — a marker set from one host is not seen by the other — is the lesser
 * one. `IRACEDECK_REPLAY_DIR` (development / testing) replaces the
 * `…\iRaceDeck\Replay` base; the ecosystem folder is still appended, so two
 * hosts under the same override stay apart too.
 */
export function resolveReplayStoreDirectory({ platform, env }: ResolveReplayStoreDirectoryOptions): string {
  const base = nonBlank(env.IRACEDECK_REPLAY_DIR) ?? join(resolveLocalAppData(env), "iRaceDeck", "Replay");

  return join(base, settingsStoreFolderName(platform));
}

/**
 * Read a loaded JSON value as a replay file, or undefined when its envelope is
 * not one — which the store treats as corrupt (moved aside, started fresh).
 * Lenient on the header fields: a missing or mistyped `track` reads as empty
 * rather than costing a user the sections beneath it.
 */
export function parseReplaySessionFile(value: unknown, subSessionId: number): ReplaySessionFile | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;

  const raw = value as Record<string, unknown>;
  const sections = raw.sections;

  if (sections === null || typeof sections !== "object" || Array.isArray(sections)) return undefined;

  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) return undefined;

  return {
    // Every envelope field this build does not read rides along, then the
    // known ones are normalized over it.
    ...raw,
    // Never downgrade a newer build's envelope on the way through.
    version: Math.max(raw.version, REPLAY_FILE_VERSION),
    subSessionId,
    track: typeof raw.track === "string" ? raw.track : "",
    series: typeof raw.series === "string" ? raw.series : "",
    sessionStart: typeof raw.sessionStart === "string" ? raw.sessionStart : "",
    sections: { ...(sections as Record<string, unknown>) },
  };
}
