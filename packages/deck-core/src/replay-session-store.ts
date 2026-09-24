/**
 * The per-session replay store (issues #1162, #1203): a deck-core singleton
 * and the only owner of `%LOCALAPPDATA%\iRaceDeck\Replay\session_<SubSessionID>.json`.
 *
 * It keeps ONE active record — the session the SDK is connected to, fed by
 * `createReplaySessionSubscriber` — and serves it synchronously to the actions
 * through two section APIs, `markers` (#1162) and `laps` (#1203). Everything
 * else in the file is carried through untouched: a build that could delete
 * another feature's section by saving its own would make the second section a
 * data-loss bug.
 *
 * Write discipline follows the settings store (`settings-store.ts`): atomic
 * replace (temp file + rename), a trailing debounce so a crossing wave of a
 * 60-car field lands as one file, failed writes retried on a schedule and kept
 * for the shutdown flush, an immediate flush on session change and disconnect,
 * a synchronous `flushSync()` for `process.on("exit")`, and a file that fails
 * to parse moved aside as `session_<id>.corrupt-<iso>.json` and treated as no
 * file. The load is SYNCHRONOUS on purpose: the actions read the record in the
 * same tick the session appears, so there is no "still loading" state.
 *
 * `SubSessionID` 0 (offline: test drive, AI race) is held in memory only —
 * never written, dropped on disconnect or when another session key appears —
 * so `session_0.json` does not exist.
 */
import type { ILogger } from "@iracedeck/logger";
import { copyFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  findLapStartInSection,
  type LapStartLookup,
  type LapStartQuery,
  type LapStartRecord,
  type LapTimeRecord,
  normalizeLapsSection,
  recordLapStartInSection,
  recordLapTimeInSection,
  type ReplayLapsSection,
} from "./replay-laps.js";
import {
  addMarker,
  deleteNearestMarker,
  nextMarker,
  normalizeMarkers,
  previousMarker,
  type ReplayMarker,
} from "./replay-markers.js";
import {
  parseReplaySessionFile,
  REPLAY_FILE_VERSION,
  type ReplaySessionFile,
  replaySessionFileName,
  type ReplaySessionHeader,
} from "./replay-session-file.js";
import { WRITE_RETRY_DELAYS_MS } from "./settings-store.js";

/**
 * Trailing debounce for the file write: long enough that a crossing wave lands
 * as one file, short enough that a plugin killed by a deck-host update loses at
 * most a couple of seconds.
 */
export const REPLAY_STORE_WRITE_DEBOUNCE_MS = 2_000;

/** The section keys this build reads. Every other key is preserved verbatim. */
export const REPLAY_MARKERS_SECTION = "markers";
export const REPLAY_LAPS_SECTION = "laps";

/** The session identity an event may carry; a mismatch with the active record is ignored. */
export interface SubSessionScoped {
  /**
   * The event's `SubSessionID`. When present and different from the active
   * record's, the store ignores the call: an event from a session the store is
   * not holding (a bus event outrunning the session change, say) must not land
   * in the wrong file. Omitted, the call is taken for the active session.
   */
  subSessionId?: number;
}

export interface ReplayMarkersApi {
  /** Insert in frame order; false when a marker is already within `MARKER_DEDUPE_FRAMES`. */
  add(marker: ReplayMarker): boolean;
  /** Remove the nearest marker within `MARKER_DELETE_WINDOW_FRAMES` of `frame`; null when none. */
  deleteNearest(frame: number): ReplayMarker | null;
  /** The first marker more than `MARKER_NEXT_MIN_AHEAD_FRAMES` ahead; null when none. */
  next(frame: number): ReplayMarker | null;
  /** The last marker more than `MARKER_PREVIOUS_MIN_BEHIND_FRAMES` behind; null when none. */
  previous(frame: number): ReplayMarker | null;
  /** Every marker, ordered by frame. Empty with no active session. */
  list(): readonly ReplayMarker[];
}

export interface ReplayLapsApi {
  /**
   * A car started `lap` at `frame` (`replay.lapStarted`, or a converged walk).
   * A time that arrived for the lap before its start is paired now. Returns
   * false when there is no active session or the `subSessionId` differs.
   */
  recordLapStart(record: LapStartRecord & SubSessionScoped): boolean;
  /**
   * The time of a lap (`replay.lapTimed`). A time for a lap with no start yet
   * is kept in memory and paired when the start arrives. Returns false when
   * there is no active session or the `subSessionId` differs.
   */
  recordLapTime(record: LapTimeRecord & SubSessionScoped): boolean;
  /** The frame a car started a lap at, or why the record has none. */
  findLapStart(query: LapStartQuery & SubSessionScoped): LapStartLookup;
}

/** What the store holds right now; `path` is null for the ephemeral offline record. */
export interface ActiveReplaySession {
  subSessionId: number;
  path: string | null;
  track: string;
  series: string;
  sessionStart: string;
}

export interface ReplaySessionStore {
  readonly directory: string;
  readonly markers: ReplayMarkersApi;
  readonly laps: ReplayLapsApi;
  /**
   * The session the SDK is connected to appeared (or changed). Flushes the
   * previous session's pending write, then loads `session_<id>.json` — or opens
   * the in-memory record when `subSessionId` is 0. Calling it again for the
   * active session only refreshes the header.
   */
  setActiveSession(header: ReplaySessionHeader): void;
  /** The SDK disconnected: flush the pending write and drop the record. */
  clearActiveSession(): void;
  getActiveSession(): ActiveReplaySession | null;
  /** Hand every pending write to the disk now and wait for it. */
  flush(): Promise<void>;
  /**
   * Land every pending write SYNCHRONOUSLY, for `process.on("exit")`, where the
   * async `flush()` would never get its event-loop turn.
   */
  flushSync(): void;
}

export interface ReplaySessionStoreOptions {
  /** `resolveReplayStoreDirectory({ env: process.env })`. */
  directory: string;
  logger: ILogger;
  /** Trailing debounce; default {@link REPLAY_STORE_WRITE_DEBOUNCE_MS}. */
  debounceMs?: number;
  /** Retry schedule after a failed write; default the settings store's `WRITE_RETRY_DELAYS_MS`. */
  writeRetryDelaysMs?: readonly number[];
  /** Clock, for the `sessionStart` stamp and the corrupt-aside name (test hook). */
  now?: () => Date;
}

interface ActiveRecord {
  file: ReplaySessionFile;
  /** null: the ephemeral offline record. */
  path: string | null;
  markers: ReplayMarker[];
  /** Materialized on first use, so a file with no `laps` section stays without one until a lap is recorded. */
  laps: ReplayLapsSection | undefined;
}

interface WritePayload {
  path: string;
  text: string;
}

function isoStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function serialize(file: ReplaySessionFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}

export function createReplaySessionStore(opts: ReplaySessionStoreOptions): ReplaySessionStore {
  const { directory, logger } = opts;
  const debounceMs = opts.debounceMs ?? REPLAY_STORE_WRITE_DEBOUNCE_MS;
  const retryDelaysMs = opts.writeRetryDelaysMs ?? WRITE_RETRY_DELAYS_MS;
  const now = opts.now ?? (() => new Date());

  let active: ActiveRecord | null = null;
  /** Lap times that arrived before their start; key `sessionNum:sessionUniqueId:carIdx:lap`. Per active session. */
  let pendingLapTimes = new Map<string, number>();

  /** The active record has changes the disk does not. */
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let retryAttempt = 0;
  /**
   * The newest text handed to a write per path — debounced-and-taken, in
   * flight, or failed and awaiting retry — removed once that exact text lands.
   * Two jobs: `flushSync()` re-does every entry synchronously (process.exit()
   * abandons in-flight libuv work), and a session re-opened while its last
   * write is still in the air loads from here rather than from a stale disk.
   */
  const unlandedByPath = new Map<string, string>();
  /** A write that failed and is waiting for its retry timer. */
  let retryPending: WritePayload | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  async function writeNow({ path, text }: WritePayload): Promise<void> {
    await mkdir(directory, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;

    try {
      await writeFile(tmp, text, "utf-8");
      await rename(tmp, path);
    } catch (error: unknown) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }

    logger.debug(`Replay session saved: ${path}`);
  }

  function enqueue(payload: WritePayload): void {
    unlandedByPath.set(payload.path, payload.text);
    inFlight = inFlight
      .then(() => writeNow(payload))
      .then(
        () => {
          if (unlandedByPath.get(payload.path) === payload.text) unlandedByPath.delete(payload.path);

          retryAttempt = 0;
        },
        (error: unknown) => {
          logger.error(`Replay session save failed: ${String(error)}`);

          // Superseded by a newer text for the same path: that one carries the
          // data and retries on its own outcome.
          if (unlandedByPath.get(payload.path) !== payload.text) return;

          retryPending = payload;
          const delay = retryDelaysMs[retryAttempt];

          if (delay === undefined) {
            logger.error(
              "Replay session save keeps failing; the record is kept in memory and retried on the next save or at shutdown",
            );

            return;
          }

          retryAttempt++;
          logger.debug(`Retrying the replay session save in ${delay} ms (attempt ${retryAttempt})`);
          setTimeout(() => {
            if (retryPending === payload) {
              retryPending = undefined;
              enqueue(payload);
            }
          }, delay);
        },
      );
  }

  /** Serialize the active record now and hand it to a write; a no-op for a clean or ephemeral record. */
  function takeDirty(): WritePayload | undefined {
    clearTimer();

    if (!dirty || active === null || active.path === null) {
      dirty = false;

      return undefined;
    }

    dirty = false;

    return { path: active.path, text: serialize(active.file) };
  }

  function flushPending(): void {
    const payload = takeDirty();

    if (payload !== undefined) {
      retryAttempt = 0;
      enqueue(payload);
    }
  }

  function scheduleSave(): void {
    if (active === null || active.path === null) return;

    dirty = true;
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      flushPending();
    }, debounceMs);
  }

  /** The `sections` object with the live section objects written back into it. */
  function syncSections(record: ActiveRecord): void {
    record.file.sections[REPLAY_MARKERS_SECTION] = record.markers;

    if (record.laps !== undefined) record.file.sections[REPLAY_LAPS_SECTION] = record.laps;
  }

  function moveAside(path: string, subSessionId: number, error: unknown): void {
    const aside = join(directory, `session_${subSessionId}.corrupt-${isoStamp(now())}.json`);

    logger.error("Replay session file is not valid; moving it aside and starting the session fresh");
    logger.debug(`Corrupt replay session file ${path} → ${aside}: ${String(error)}`);

    try {
      renameSync(path, aside);
    } catch (renameError: unknown) {
      // Copy fallback (held open elsewhere, or no rename right on the folder),
      // then try to remove the original so the next start does not preserve it
      // again. A file that cannot be removed either stays where it is.
      try {
        copyFileSync(path, aside);
        logger.error("Replay session file could not be moved; preserved as a copy instead");
        logger.debug(`Copy fallback: ${String(renameError)}`);

        try {
          unlinkSync(path);
        } catch (unlinkError: unknown) {
          logger.debug(`Corrupt original could not be removed: ${String(unlinkError)}`);
        }
      } catch (copyError: unknown) {
        logger.error("Replay session file could not be preserved — moving on with a fresh record");
        logger.debug(`Copy also failed: ${String(copyError)}`);
      }
    }
  }

  /** The record on disk (or still in the air for that path), or undefined for no file. */
  function loadFile(path: string, subSessionId: number): ReplaySessionFile | undefined {
    let text = unlandedByPath.get(path);

    if (text === undefined) {
      try {
        text = readFileSync(path, "utf-8");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;

        // Unreadable for another reason (a lock, a permission): the session
        // runs on a fresh record and the write path will report its own
        // failure. Not moved aside — the bytes may be fine.
        logger.error("Replay session file could not be read; the session runs on a fresh record");
        logger.debug(`Read failed for ${path}: ${String(error)}`);

        return undefined;
      }
    }

    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    let parsed: ReplaySessionFile | undefined;
    let parseError: unknown;

    try {
      parsed = parseReplaySessionFile(JSON.parse(text), subSessionId);

      if (parsed === undefined) parseError = new Error("not a replay session file");
    } catch (error: unknown) {
      parseError = error;
    }

    if (parsed === undefined) {
      moveAside(path, subSessionId, parseError);

      return undefined;
    }

    return parsed;
  }

  function open(header: ReplaySessionHeader): ActiveRecord {
    const ephemeral = header.subSessionId === 0;
    const path = ephemeral ? null : join(directory, replaySessionFileName(header.subSessionId));
    const loaded = path === null ? undefined : loadFile(path, header.subSessionId);
    const file: ReplaySessionFile = loaded ?? {
      version: REPLAY_FILE_VERSION,
      subSessionId: header.subSessionId,
      track: "",
      series: "",
      sessionStart: "",
      sections: {},
    };

    applyHeader(file, header);

    const record: ActiveRecord = {
      file,
      path,
      markers: normalizeMarkers(file.sections[REPLAY_MARKERS_SECTION]),
      laps:
        file.sections[REPLAY_LAPS_SECTION] === undefined
          ? undefined
          : normalizeLapsSection(file.sections[REPLAY_LAPS_SECTION]),
    };

    syncSections(record);

    return record;
  }

  /** Header fields from the caller when it has them; a loaded `sessionStart` wins (the earlier observation). */
  function applyHeader(file: ReplaySessionFile, header: ReplaySessionHeader): void {
    if (header.track !== "") file.track = header.track;

    if (header.series !== "") file.series = header.series;

    if (file.sessionStart === "") file.sessionStart = header.sessionStart ?? now().toISOString();
  }

  /** The active record when it exists and the call's `subSessionId` (if any) is its own. */
  function activeFor(scope: SubSessionScoped): ActiveRecord | null {
    if (active === null) return null;

    if (scope.subSessionId !== undefined && scope.subSessionId !== active.file.subSessionId) {
      logger.debug(
        `Ignored a replay record call for SubSessionID ${scope.subSessionId}; the active session is ${active.file.subSessionId}`,
      );

      return null;
    }

    return active;
  }

  function lapsOf(record: ActiveRecord): ReplayLapsSection {
    if (record.laps === undefined) {
      record.laps = normalizeLapsSection(undefined);
      syncSections(record);
    }

    return record.laps;
  }

  const pendingKey = (r: { sessionNum: number; sessionUniqueId: number; carIdx: number; lap: number }): string =>
    `${r.sessionNum}:${r.sessionUniqueId}:${r.carIdx}:${r.lap}`;

  const markers: ReplayMarkersApi = {
    add(marker) {
      if (active === null) return false;

      const added = addMarker(active.markers, marker);

      if (added) {
        logger.info("Replay marker added");
        logger.debug(`Marker at frame ${marker.frame} (session ${marker.sessionNum}, ${marker.sessionTimeMs} ms)`);
        scheduleSave();
      } else {
        logger.debug(`Marker at frame ${marker.frame} not added: one is already within the dedupe window`);
      }

      return added;
    },

    deleteNearest(frame) {
      if (active === null) return null;

      const deleted = deleteNearestMarker(active.markers, frame);

      if (deleted !== null) {
        logger.info("Replay marker deleted");
        logger.debug(`Deleted the marker at frame ${deleted.frame} (pressed at ${frame})`);
        scheduleSave();
      }

      return deleted;
    },

    next: (frame) => (active === null ? null : nextMarker(active.markers, frame)),
    previous: (frame) => (active === null ? null : previousMarker(active.markers, frame)),
    list: () => (active === null ? [] : active.markers),
  };

  const laps: ReplayLapsApi = {
    recordLapStart(record) {
      const target = activeFor(record);

      if (target === null) return false;

      const section = lapsOf(target);
      const { carReplaced } = recordLapStartInSection(section, record);

      if (carReplaced) {
        logger.debug(
          `Car index ${record.carIdx} now carries car number ${record.carNumberRaw}; its earlier laps were dropped`,
        );
      }

      const pending = pendingLapTimes.get(pendingKey(record));

      if (pending !== undefined) {
        pendingLapTimes.delete(pendingKey(record));
        recordLapTimeInSection(section, { ...record, timeMs: pending });
      }

      scheduleSave();

      return true;
    },

    recordLapTime(record) {
      const target = activeFor(record);

      if (target === null) return false;

      if (recordLapTimeInSection(lapsOf(target), record)) {
        scheduleSave();
      } else {
        pendingLapTimes.set(pendingKey(record), record.timeMs);
      }

      return true;
    },

    findLapStart(query) {
      const target = activeFor(query);

      if (target === null) return { hit: false, reason: "no file" };

      return findLapStartInSection(target.laps, query);
    },
  };

  return {
    directory,
    markers,
    laps,

    setActiveSession(header) {
      if (active !== null && active.file.subSessionId === header.subSessionId) {
        applyHeader(active.file, header);

        return;
      }

      // The previous session's record goes to disk NOW, then is dropped; the
      // ephemeral record is simply dropped.
      flushPending();
      active = open(header);
      pendingLapTimes = new Map();

      if (active.path === null) {
        logger.info("Replay session opened in memory (offline session, nothing is written)");
      } else {
        logger.info("Replay session opened");
        logger.debug(
          `Replay session ${header.subSessionId}: ${active.path} (${active.markers.length} markers, laps section ${active.laps === undefined ? "absent" : "present"})`,
        );
      }
    },

    clearActiveSession() {
      if (active === null) return;

      flushPending();
      active = null;
      pendingLapTimes = new Map();
      logger.info("Replay session closed");
    },

    getActiveSession() {
      if (active === null) return null;

      return {
        subSessionId: active.file.subSessionId,
        path: active.path,
        track: active.file.track,
        series: active.file.series,
        sessionStart: active.file.sessionStart,
      };
    },

    async flush() {
      flushPending();

      if (retryPending !== undefined) {
        const payload = retryPending;

        retryPending = undefined;
        enqueue(payload);
      }

      await inFlight;
    },

    flushSync() {
      // Everything the disk does not have yet: every unlanded write (in flight,
      // or failed and awaiting its retry), overridden for the active path by
      // the record as it is now.
      const toWrite = new Map(unlandedByPath);
      const current = takeDirty();

      if (current !== undefined) toWrite.set(current.path, current.text);

      for (const [path, text] of toWrite) {
        const tmp = `${path}.${process.pid}.sync.tmp`;

        try {
          mkdirSync(directory, { recursive: true });
          writeFileSync(tmp, text, "utf-8");
          renameSync(tmp, path);
          unlandedByPath.delete(path);
          logger.debug(`Replay session flushed on shutdown: ${path}`);
        } catch (error: unknown) {
          try {
            unlinkSync(tmp);
          } catch {
            // best effort — the temp file may never have been created
          }

          logger.error(`Replay session shutdown flush failed: ${String(error)}`);
        }
      }
    },
  };
}

let replaySessionStore: ReplaySessionStore | null = null;

/**
 * Initialize the replay session store singleton. Should be called once at
 * plugin startup; every plugin also registers `process.on("exit", () => store.flushSync())`.
 *
 * @throws Error if called more than once
 */
export function initializeReplaySessionStore(options: ReplaySessionStoreOptions): ReplaySessionStore {
  if (replaySessionStore) {
    throw new Error(
      "Replay session store already initialized. initializeReplaySessionStore() should only be called once.",
    );
  }

  replaySessionStore = createReplaySessionStore(options);

  return replaySessionStore;
}

/**
 * Get the replay session store.
 *
 * @throws Error if the store hasn't been initialized
 */
export function getReplaySessionStore(): ReplaySessionStore {
  if (!replaySessionStore) {
    throw new Error(
      "Replay session store not initialized. Call initializeReplaySessionStore() first in your plugin entry point.",
    );
  }

  return replaySessionStore;
}

export function isReplaySessionStoreInitialized(): boolean {
  return replaySessionStore !== null;
}

/**
 * Reset the singleton (for testing purposes only).
 * @internal
 */
export function _resetReplaySessionStore(): void {
  replaySessionStore = null;
}
