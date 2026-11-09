/**
 * The per-track file (issue #1112): its envelope, its location, and how a
 * file read from disk is classified. Persistence lives in `track-store.ts`;
 * the pit-lane section's model (fold, median, rebuild, the section reader) is
 * `@iracedeck/track-data`'s and is never reimplemented here.
 *
 * `%LOCALAPPDATA%\iRaceDeck\Track Data\<sim>\track_<TrackID>.json` holds
 * what iRaceDeck learns about one track of one simulator: the folder is the
 * identity's `sim` (`iracing`), so two sims' track ids never share a name.
 * Today the file holds the `pitLane` section; the envelope carries the track
 * identity as it was when written (the #1081 re-keying rule: the raw names
 * let a file be re-keyed rather than orphaned if the identity scheme
 * changes). The envelope's `version` covers the envelope only — the section
 * versions its own contents.
 *
 * Design: `docs/superpowers/specs/2026-09-04-issue-1112-pit-lane-landmarks.md`
 * and its 2026-11-09 amendments.
 */
import { nonBlank, resolveLocalAppData } from "@iracedeck/settings";
import {
  isNewerPitLaneSection,
  normalizePitLaneSection,
  type PitLaneSection,
  type PitLaneTrackIdentity,
} from "@iracedeck/track-data";
import { join } from "node:path";

/** The envelope version this build writes. */
export const TRACK_FILE_VERSION = 1;

/** The environment variable that replaces the whole track-data directory (development / testing). */
export const TRACK_DATA_DIR_ENV = "IRACEDECK_TRACK_DATA_DIR";

/** The envelope fields every track file carries, plus any key a newer build added. */
export interface TrackFileEnvelope {
  [key: string]: unknown;
  version: number;
  /** The identity's `sim` (`"iracing"`), the same as the folder the file is in. */
  sim: string;
  trackId: number;
  trackName: string;
  trackConfigName: string;
  /** The identity's raw `trackLength` when last written. */
  trackLength: string;
  /** The identity's raw `trackVersion` when last written; informational only. */
  trackVersion: string | null;
}

/** The file as written. Every key this build does not read is carried through every write. */
export interface TrackFile extends TrackFileEnvelope {
  pitLane: PitLaneSection;
}

/** A file as read: a file another feature wrote first may carry no `pitLane` section yet. */
export interface ParsedTrackFile extends TrackFileEnvelope {
  pitLane: PitLaneSection | undefined;
}

/**
 * What a read of the track file found.
 *
 * - `absent` — no file.
 * - `unreadable` — the file exists but could not be read (a lock, a
 *   permission): never write over it, try again later.
 * - `corrupt` — not JSON, or not a track file: preserve it aside, never
 *   overwrite or delete it.
 * - `newerVersion` — the envelope is a newer build's: never write.
 * - `newerSection` — the `pitLane` section is a newer build's
 *   (`isNewerPitLaneSection`): never write, never move aside.
 * - `ok` — a file this build reads.
 */
export type TrackFileRead =
  | { kind: "absent" }
  | { kind: "unreadable"; error: unknown }
  | { kind: "corrupt"; error: unknown }
  | { kind: "newerVersion"; version: number }
  | { kind: "newerSection"; version: number }
  | { kind: "ok"; file: ParsedTrackFile };

/** `track_<TrackID>.json`. */
export function trackFileName(trackId: number): string {
  return `track_${trackId}.json`;
}

/**
 * What a `sim` must look like to name a folder: lowercase letters, digits and
 * hyphens, starting with a letter or digit, at most 32 characters. No
 * separator, dot or space can reach the path, and the case is fixed, so a
 * case-insensitive file system never folds two sims into one folder.
 */
const TRACK_SIM_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Names Windows reserves for devices, in any folder. */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/**
 * Whether `sim` is safe as the one path segment of its folder under the track
 * data directory ({@link TRACK_SIM_PATTERN}, and not a Windows device name).
 * The store refuses an identity whose `sim` is not.
 */
export function isTrackDataSim(sim: unknown): sim is string {
  return typeof sim === "string" && TRACK_SIM_PATTERN.test(sim) && !WINDOWS_RESERVED_NAMES.test(sim);
}

/**
 * The folder of one sim's track files: `<directory>\<sim>`.
 *
 * @throws RangeError when `sim` is not {@link isTrackDataSim}.
 */
export function trackSimDirectory(directory: string, sim: string): string {
  if (!isTrackDataSim(sim)) throw new RangeError(`Not a track data sim: ${JSON.stringify(sim)}`);

  return join(directory, sim);
}

/**
 * `<directory>\<sim>\track_<TrackID>.json`.
 *
 * @throws RangeError when `sim` is not {@link isTrackDataSim}.
 */
export function trackFilePath(directory: string, sim: string, trackId: number): string {
  return join(trackSimDirectory(directory, sim), trackFileName(trackId));
}

export interface ResolveTrackDataDirectoryOptions {
  env: Record<string, string | undefined>;
}

/**
 * `%LOCALAPPDATA%\iRaceDeck\Track Data`, one folder for every deck host; the
 * store keeps each sim's files in a subfolder named for it.
 * Deliberately NOT per ecosystem, unlike the settings and replay stores: a pit
 * lane is a fact about a track, not about which deck is attached, and per-host
 * copies would relearn it on every switch (spec decision 3). Two plugin
 * processes may therefore write one file; the store merges on every write.
 * Hence no `platform` option. `IRACEDECK_TRACK_DATA_DIR` replaces the whole
 * directory.
 */
export function resolveTrackDataDirectory({ env }: ResolveTrackDataDirectoryOptions): string {
  return nonBlank(env[TRACK_DATA_DIR_ENV]) ?? join(resolveLocalAppData(env), "iRaceDeck", "Track Data");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/**
 * Classify the text of a track file (everything {@link TrackFileRead} names
 * but `absent` and `unreadable`, which only IO can tell). A leading BOM is
 * tolerated. Lenient on the informational envelope fields (`sim`,
 * `trackLength`, `trackVersion`), which the store rewrites from the session's
 * identity anyway; strict on the identity it checks (`trackId`, `trackName`,
 * `trackConfigName`), since a file it cannot identify is one it must not merge.
 */
export function parseTrackFile(text: string): Exclude<TrackFileRead, { kind: "absent" } | { kind: "unreadable" }> {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let raw: unknown;

  try {
    raw = JSON.parse(body);
  } catch (error: unknown) {
    return { kind: "corrupt", error };
  }

  if (!isPlainObject(raw)) return { kind: "corrupt", error: new Error("not a JSON object") };

  const { version } = raw;

  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { kind: "corrupt", error: new Error("no envelope version") };
  }

  if (version > TRACK_FILE_VERSION) return { kind: "newerVersion", version };

  if (typeof raw.trackId !== "number" || !Number.isInteger(raw.trackId)) {
    return { kind: "corrupt", error: new Error("no trackId") };
  }

  if (typeof raw.trackName !== "string" || typeof raw.trackConfigName !== "string") {
    return { kind: "corrupt", error: new Error("no track name") };
  }

  let pitLane: PitLaneSection | undefined;

  if (raw.pitLane !== undefined) {
    if (isNewerPitLaneSection(raw.pitLane)) {
      return { kind: "newerSection", version: (raw.pitLane as { version: number }).version };
    }

    const section = normalizePitLaneSection(raw.pitLane);

    if (section === null) return { kind: "corrupt", error: new Error("malformed pitLane section") };

    pitLane = section;
  }

  return {
    kind: "ok",
    file: {
      // Every envelope key this build does not read rides along; the known
      // ones are normalized over it.
      ...raw,
      version,
      sim: typeof raw.sim === "string" ? raw.sim : "",
      trackId: raw.trackId,
      trackName: raw.trackName,
      trackConfigName: raw.trackConfigName,
      trackLength: typeof raw.trackLength === "string" ? raw.trackLength : "",
      trackVersion: typeof raw.trackVersion === "string" ? raw.trackVersion : null,
      pitLane,
    },
  };
}

/**
 * Read and classify the track file at `path`. `readText` is the IO seam
 * (`readFileSync(path, "utf-8")`); an `ENOENT` is `absent`, any other error
 * `unreadable`.
 */
export function readTrackFile(path: string, readText: (path: string) => string): TrackFileRead {
  let text: string;

  try {
    text = readText(path);
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", error };
  }

  return parseTrackFile(text);
}

/**
 * Why a file must not be merged with the session's track.
 *
 * - `foreign` — its own key fields name another track: the envelope's
 *   TrackID, or a non-empty envelope `sim`, differs from the identity's. It
 *   is not this track's file at all, whatever its folder and name say: never
 *   read as data, never written over.
 * - `renamed` — the same sim and TrackID under another `trackName` or
 *   `trackConfigName`: the sim renamed the track or its configuration. Not
 *   read as data, since its landmarks were learned under the old names; the
 *   store's next write preserves it aside and starts the file afresh, so a
 *   renamed track keeps learning and the old file can still be re-keyed by
 *   hand (the raw names in the envelope exist for that).
 */
export type TrackFileMismatch = { kind: "foreign" | "renamed"; reason: string };

/**
 * Why a file must not be merged with the session's track
 * ({@link TrackFileMismatch}), or `null` when it may. An envelope with no
 * `sim` (read as `""`) is judged by the rest: the folder already names the
 * sim. The key fields are checked first, so a file that differs in those and
 * in a name is `foreign`.
 */
export function trackFileMismatch(file: ParsedTrackFile, track: PitLaneTrackIdentity): TrackFileMismatch | null {
  if (file.trackId !== track.trackId) {
    return { kind: "foreign", reason: `trackId ${file.trackId} is not ${track.trackId}` };
  }

  if (file.sim !== "" && file.sim !== track.sim) {
    return { kind: "foreign", reason: `sim "${file.sim}" is not "${track.sim}"` };
  }

  if (file.trackName !== track.trackName) {
    return { kind: "renamed", reason: `trackName "${file.trackName}" is not "${track.trackName}"` };
  }

  if (file.trackConfigName !== track.trackConfigName) {
    return {
      kind: "renamed",
      reason: `trackConfigName "${file.trackConfigName}" is not "${track.trackConfigName}"`,
    };
  }

  return null;
}

/** The envelope keys this build writes, in the order it writes them. */
const ENVELOPE_KEYS = new Set([
  "version",
  "sim",
  "trackId",
  "trackName",
  "trackConfigName",
  "trackLength",
  "trackVersion",
  "pitLane",
]);

/**
 * The file to write: the envelope from the session's identity (its `sim`
 * included), the section (whose `trackVersion` the store stamps from the
 * identity), and every key of `base` this build does not read, carried
 * through after them.
 */
export function buildTrackFile(
  base: ParsedTrackFile | undefined,
  track: PitLaneTrackIdentity,
  pitLane: PitLaneSection,
): TrackFile {
  const file: TrackFile = {
    version: TRACK_FILE_VERSION,
    sim: track.sim,
    trackId: track.trackId,
    trackName: track.trackName,
    trackConfigName: track.trackConfigName,
    trackLength: track.trackLength,
    trackVersion: track.trackVersion,
    pitLane,
  };

  if (base !== undefined) {
    for (const [key, value] of Object.entries(base)) {
      if (!ENVELOPE_KEYS.has(key)) file[key] = value;
    }
  }

  return file;
}
