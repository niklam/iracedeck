/**
 * The per-session replay store (issues #1162, #1203): a deck-core singleton
 * and the only owner of `%LOCALAPPDATA%\iRaceDeck\Replay\session_<SubSessionID>.json`.
 *
 * It keeps ONE active record — the session the SDK is connected to, fed by
 * `createReplaySessionSubscriber` — and serves it synchronously to the actions
 * through two section APIs, `markers` (#1162) and `laps` (#1203). Everything
 * else in the file is carried through untouched: a build that could delete
 * another feature's section by saving its own would make the second section a
 * data-loss bug. That includes a `laps` section a NEWER build wrote (its
 * `version` above this build's) and any `markers` entry this build cannot
 * read: both ride through every write verbatim.
 *
 * Write discipline follows the settings store (`settings-store.ts`): atomic
 * replace (temp file + rename), a trailing debounce so a crossing wave of a
 * 60-car field lands as one file — capped by a max wait, so a field that never
 * goes quiet still lands every ten seconds — failed writes retried on a
 * schedule and kept for the shutdown flush, with the record itself as the
 * pending payload so a retry never writes anything older than the newest save;
 * an immediate flush on session change and disconnect; a synchronous
 * `flushSync()` for `process.on("exit")`; and a file that fails to parse moved
 * aside as `session_<id>.corrupt-<iso>.json` and treated as no file. The load
 * is SYNCHRONOUS on purpose: the actions read the record in the same tick the
 * session appears, so there is no "still loading" state. A file that cannot be
 * READ at that moment (a lock, a permission) opens the session in memory and is
 * re-read on the write-retry schedule; when it becomes readable the in-memory
 * record is merged into it and written. The file is compact JSON: an endurance
 * race's record reaches megabytes, and it is rewritten every few seconds.
 *
 * `SubSessionID` 0 (offline: test drive, AI race) is held in memory only —
 * never written, dropped on disconnect or when another session key appears —
 * so `session_0.json` does not exist.
 */
import type { ILogger } from "@iracedeck/logger";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  findLapStartInSection,
  isNewerLapsSection,
  type LapStartLookup,
  type LapStartQuery,
  type LapStartRecord,
  type LapTimeRecord,
  mergeLapsSectionInto,
  normalizeLapsSection,
  recordLapStartInSection,
  recordLapTimeInSection,
  type ReplayLapsSection,
} from "./replay-laps.js";
import {
  addMarker,
  deleteNearestMarker,
  nextMarker,
  partitionMarkers,
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

/**
 * The longest an unsaved change waits for the disk. A pure trailing debounce
 * never fires while changes keep coming, and a 60-car field's crossings and
 * lap times can keep coming for minutes; a change is written no later than
 * this after the first unsaved one, whatever arrives meanwhile.
 */
export const REPLAY_STORE_WRITE_MAX_WAIT_MS = 10_000;

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

/**
 * Every call takes an optional `scope`: a caller that knows which
 * `SubSessionID` it is acting for passes it, and a call for another session
 * than the active record's is ignored (false / null / empty), as the laps
 * calls are.
 */
export interface ReplayMarkersApi {
  /** Insert in frame order; false when a marker is already within `MARKER_DEDUPE_FRAMES`. */
  add(marker: ReplayMarker, scope?: SubSessionScoped): boolean;
  /** Remove the nearest marker within `MARKER_DELETE_WINDOW_FRAMES` of `frame`; null when none. */
  deleteNearest(frame: number, scope?: SubSessionScoped): ReplayMarker | null;
  /** The first marker more than `MARKER_NEXT_MIN_AHEAD_FRAMES` ahead; null when none. */
  next(frame: number, scope?: SubSessionScoped): ReplayMarker | null;
  /** The last marker more than `MARKER_PREVIOUS_MIN_BEHIND_FRAMES` behind; null when none. */
  previous(frame: number, scope?: SubSessionScoped): ReplayMarker | null;
  /** A copy of every marker, ordered by frame. Empty with no active session. */
  list(scope?: SubSessionScoped): ReplayMarker[];
}

export interface ReplayLapsApi {
  /**
   * A car started `lap` at `frame` (`replay.lapStarted`, or a converged walk).
   * A time that arrived for the lap before its start is paired now. Returns
   * false when there is no active session, the `subSessionId` differs, or the
   * file's `laps` section is a newer build's (carried through, not written).
   */
  recordLapStart(record: LapStartRecord & SubSessionScoped): boolean;
  /**
   * The time of a lap (`replay.lapTimed`). A time for a lap with no start yet
   * is kept in memory and paired when the start arrives. Returns false in the
   * same cases as `recordLapStart`.
   */
  recordLapTime(record: LapTimeRecord & SubSessionScoped): boolean;
  /** The frame a car started a lap at, or why the record has none. */
  findLapStart(query: LapStartQuery & SubSessionScoped): LapStartLookup;
}

/**
 * What the store holds right now. `path` is null for a record that is not
 * written: the offline (SubSessionID 0) one, a session whose file could not be
 * read (until it can — the load is retried), and one whose corrupt file could
 * not be preserved — writing there would replace bytes the store never saw.
 */
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
   * active session refreshes the header and, for a record whose file could
   * not be read at open, tries the load again.
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
  /** The most an unsaved change waits; default {@link REPLAY_STORE_WRITE_MAX_WAIT_MS}. */
  maxWaitMs?: number;
  /** Retry schedule after a failed write; default the settings store's `WRITE_RETRY_DELAYS_MS`. */
  writeRetryDelaysMs?: readonly number[];
  /** Retry schedule for a file that could not be read at open; default the same `WRITE_RETRY_DELAYS_MS`. */
  loadRetryDelaysMs?: readonly number[];
  /** Clock, for the `sessionStart` stamp and the corrupt-aside name (test hook). */
  now?: () => Date;
}

interface ActiveRecord {
  file: ReplaySessionFile;
  /** null: not written — the offline record, a file not yet readable, or one that could not be preserved. */
  path: string | null;
  /** The record was read from an existing file (or the write still in the air for it). */
  loadedFromDisk: boolean;
  markers: ReplayMarker[];
  /** Entries of the loaded `markers` section this build could not read; re-emitted verbatim after the markers. */
  unreadableMarkers: unknown[];
  /** Materialized on first use, so a file with no `laps` section stays without one until a lap is recorded. */
  laps: ReplayLapsSection | undefined;
  /** The file's `laps` section is a newer build's: carried through, neither read nor written into. */
  lapsNewerFormat: boolean;
  /** Present while the file could not be READ: the load is retried on `loadRetryDelaysMs`, then on demand. */
  reload?: { attempt: number; timer?: ReturnType<typeof setTimeout> };
}

interface WritePayload {
  path: string;
  text: string;
}

/** A failed write for a path that is no longer the active record's, retried on its own schedule. */
interface OrphanRetry {
  payload: WritePayload;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
}

function isoStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** The temp files the atomic write uses, and nothing else: `session_<id>.json.<pid>.tmp` / `.<pid>.sync.tmp`. */
const STALE_TEMP_FILE = /^session_\d+\.json\.\d+(?:\.sync)?\.tmp$/;

/**
 * Remove temp files a crashed process left behind. Only names matching the
 * store's own temp pattern are touched; a failure is logged and ignored.
 */
function removeStaleTempFiles(directory: string, logger: ILogger): void {
  let names: string[];

  try {
    names = readdirSync(directory);
  } catch {
    return; // no folder yet, or unreadable — nothing to clean
  }

  for (const name of names) {
    if (!STALE_TEMP_FILE.test(name)) continue;

    try {
      unlinkSync(join(directory, name));
      logger.debug(`Removed a stale replay temp file: ${name}`);
    } catch (error: unknown) {
      logger.debug(`Stale replay temp file ${name} could not be removed: ${String(error)}`);
    }
  }
}

/**
 * The name of an existing `session_<id>.corrupt-*.json` sibling whose bytes
 * equal the (corrupt) file at `path`, or undefined. Used by the copy fallback
 * of the load so a corrupt file that survives every open (locked, undeletable)
 * is preserved once, not once per open — the settings store's rule.
 */
function findIdenticalAside(directory: string, path: string, subSessionId: number): string | undefined {
  const prefix = `session_${subSessionId}.corrupt-`;
  const original = readFileSync(path);

  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;

    if (original.equals(readFileSync(join(directory, name)))) return name;
  }

  return undefined;
}

export function createReplaySessionStore(opts: ReplaySessionStoreOptions): ReplaySessionStore {
  const { directory, logger } = opts;
  const debounceMs = opts.debounceMs ?? REPLAY_STORE_WRITE_DEBOUNCE_MS;
  const maxWaitMs = opts.maxWaitMs ?? REPLAY_STORE_WRITE_MAX_WAIT_MS;
  const retryDelaysMs = opts.writeRetryDelaysMs ?? WRITE_RETRY_DELAYS_MS;
  const loadRetryDelaysMs = opts.loadRetryDelaysMs ?? WRITE_RETRY_DELAYS_MS;
  const now = opts.now ?? (() => new Date());

  removeStaleTempFiles(directory, logger);

  let active: ActiveRecord | null = null;
  /** Lap times that arrived before their start; key `sessionNum:sessionUniqueId:carIdx:lap`. Per active session. */
  let pendingLapTimes = new Map<string, number>();
  /** The one-time warning that a newer build's `laps` section is not written into. */
  let warnedNewerLaps = false;

  /**
   * The active record has changes the disk does not — including a write that
   * failed: the record IS the pending payload, so what the retry writes is
   * whatever the record holds by then, never an older snapshot.
   */
  let dirty = false;
  /** `Date.now()` when `dirty` last went true; the max wait counts from here. */
  let firstDirtyAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  /** Consecutive failures of the active record's write; reset by a landed write or a fresh change. */
  let retryAttempt = 0;
  /**
   * The newest text handed to a write per path — debounced-and-taken, in
   * flight, or failed and awaiting retry — removed once that exact text lands.
   * Two jobs: `flushSync()` re-does every entry synchronously (process.exit()
   * abandons in-flight libuv work), and a session re-opened while its last
   * write is still in the air loads from here rather than from a stale disk.
   */
  const unlandedByPath = new Map<string, string>();
  /** Failed writes for paths the store no longer holds a record for (the session changed), one per path. */
  const orphanRetries = new Map<string, OrphanRetry>();

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

  /** The active record has changes the disk does not; the max wait counts from the first of them. */
  function markDirty(): void {
    if (dirty) return;

    dirty = true;
    firstDirtyAt = Date.now();
  }

  /** (Re)arm the one timer that hands the active record to a write. */
  function armTimer(delayMs: number): void {
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      flushPending();
    }, delayMs);
  }

  function dropOrphan(path: string): void {
    const orphan = orphanRetries.get(path);

    if (orphan === undefined) return;

    if (orphan.timer !== undefined) clearTimeout(orphan.timer);

    orphanRetries.delete(path);
  }

  /**
   * A write failed for a path that is not the active record's. Its text stays
   * the newest for the path in `unlandedByPath`, so the retry timer re-checks
   * that before writing: a session re-opened and saved meanwhile supersedes it.
   */
  function scheduleOrphanRetry(payload: WritePayload): void {
    const prior = orphanRetries.get(payload.path);
    const attempt = prior !== undefined && prior.payload.text === payload.text ? prior.attempt : 0;

    dropOrphan(payload.path);

    const delay = retryDelaysMs[attempt];

    if (delay === undefined) {
      logger.error(
        "Replay session save keeps failing; the record is kept in memory and retried on the next flush or at shutdown",
      );
      orphanRetries.set(payload.path, { payload, attempt });

      return;
    }

    logger.debug(`Retrying the replay session save in ${delay} ms (attempt ${attempt + 1})`);
    orphanRetries.set(payload.path, {
      payload,
      attempt: attempt + 1,
      timer: setTimeout(() => retryOrphan(payload.path), delay),
    });
  }

  function retryOrphan(path: string): void {
    const orphan = orphanRetries.get(path);

    if (orphan === undefined) return;

    orphan.timer = undefined;

    // Superseded: a newer text for the path was handed to a write since (in
    // flight or landed), or the session is active again and carries the data.
    if (unlandedByPath.get(path) !== orphan.payload.text || (active !== null && active.path === path)) {
      orphanRetries.delete(path);

      return;
    }

    enqueue(orphan.payload);
  }

  function enqueue(payload: WritePayload): void {
    unlandedByPath.set(payload.path, payload.text);
    inFlight = inFlight
      .then(() => writeNow(payload))
      .then(
        () => {
          if (unlandedByPath.get(payload.path) === payload.text) unlandedByPath.delete(payload.path);

          if (orphanRetries.get(payload.path)?.payload.text === payload.text) dropOrphan(payload.path);

          if (active !== null && active.path === payload.path) retryAttempt = 0;
        },
        (error: unknown) => {
          logger.error(`Replay session save failed: ${String(error)}`);

          // Superseded by a newer text for the same path: that one carries the
          // data and retries on its own outcome.
          if (unlandedByPath.get(payload.path) !== payload.text) return;

          if (active === null || active.path !== payload.path) {
            scheduleOrphanRetry(payload);

            return;
          }

          // The failed payload goes back to pending — and pending is the
          // record itself, so a newer change made meanwhile is what the retry
          // writes. One already waiting for its timer supersedes this outright.
          if (dirty) return;

          const delay = retryDelaysMs[retryAttempt];

          markDirty();

          if (delay === undefined) {
            logger.error(
              "Replay session save keeps failing; the record is kept in memory and retried on the next save or at shutdown",
            );
            clearTimer();

            return;
          }

          retryAttempt++;
          logger.debug(`Retrying the replay session save in ${delay} ms (attempt ${retryAttempt})`);
          armTimer(delay);
        },
      );
  }

  /** Serialize the active record now and hand it to a write; a no-op for a clean or unwritable record. */
  function takeDirty(): WritePayload | undefined {
    clearTimer();

    if (!dirty || active === null || active.path === null) {
      dirty = false;

      return undefined;
    }

    dirty = false;

    return { path: active.path, text: serialize(active) };
  }

  function flushPending(): void {
    const payload = takeDirty();

    if (payload !== undefined) enqueue(payload);
  }

  /** A change to the active record: debounce it, but never past the max wait from the first unsaved change. */
  function scheduleSave(): void {
    if (active === null || active.path === null) return;

    // A fresh change resets any failure back-off: it is a new payload.
    retryAttempt = 0;
    markDirty();
    armTimer(Math.max(0, Math.min(debounceMs, firstDirtyAt + maxWaitMs - Date.now())));
  }

  /** The `sections` object with the live sections written into it, then the file as text. */
  function serialize(record: ActiveRecord): string {
    record.file.sections[REPLAY_MARKERS_SECTION] =
      record.unreadableMarkers.length === 0 ? record.markers : [...record.markers, ...record.unreadableMarkers];

    if (record.laps !== undefined && !record.lapsNewerFormat) record.file.sections[REPLAY_LAPS_SECTION] = record.laps;

    return JSON.stringify(record.file) + "\n";
  }

  /** Whether the corrupt file is now preserved under another name (and so may be written over). */
  function moveAside(path: string, subSessionId: number, error: unknown): boolean {
    const aside = join(directory, `session_${subSessionId}.corrupt-${isoStamp(now())}.json`);

    logger.error("Replay session file is not valid; moving it aside and starting the session fresh");
    logger.debug(`Corrupt replay session file ${path} → ${aside}: ${String(error)}`);

    try {
      renameSync(path, aside);

      return true;
    } catch (renameError: unknown) {
      // Copy fallback (held open elsewhere, or no rename right on the folder)
      // — unless an aside with the very same bytes already exists, which is
      // what open-after-open of one stuck file produces — then try to remove
      // the original so the next open does not preserve it again. A file that
      // cannot be removed either stays where it is; the identical-aside check
      // is what keeps that case from growing one copy per open.
      try {
        const existing = findIdenticalAside(directory, path, subSessionId);

        if (existing === undefined) {
          copyFileSync(path, aside);
          logger.error("Replay session file could not be moved; preserved as a copy instead");
        } else {
          logger.error("Replay session file could not be moved; an identical copy is already preserved");
          logger.debug(`Identical aside: ${existing}`);
        }

        logger.debug(`Copy fallback: ${String(renameError)}`);

        try {
          unlinkSync(path);
        } catch (unlinkError: unknown) {
          logger.debug(`Corrupt original could not be removed: ${String(unlinkError)}`);
        }

        return true;
      } catch (copyError: unknown) {
        logger.error("Replay session file could not be preserved; the session runs in memory and nothing is written");
        logger.debug(`Copy also failed: ${String(copyError)}`);

        return false;
      }
    }
  }

  /**
   * `file`: the record on disk (or still in the air for that path).
   * `"none"`: no file. `"unreadable"`: a file exists but could not be read (a
   * lock, a permission) — the session runs in memory and the read is retried.
   * `"unwritable"`: a file exists that is corrupt and could not be preserved,
   * so the session must run in memory for good: the next write would otherwise
   * rename a near-empty record over bytes the store never saw.
   */
  function loadFile(
    path: string,
    subSessionId: number,
  ): { file: ReplaySessionFile } | "none" | "unreadable" | "unwritable" {
    let text = unlandedByPath.get(path);

    if (text === undefined) {
      try {
        text = readFileSync(path, "utf-8");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";

        logger.debug(`Read failed for ${path}: ${String(error)}`);

        return "unreadable";
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

    if (parsed === undefined) return moveAside(path, subSessionId, parseError) ? "none" : "unwritable";

    return { file: parsed };
  }

  function emptyFile(subSessionId: number): ReplaySessionFile {
    return { version: REPLAY_FILE_VERSION, subSessionId, track: "", series: "", sessionStart: "", sections: {} };
  }

  /** The live view of a file's sections this build reads; the rest stays in `file.sections` untouched. */
  function recordOf(file: ReplaySessionFile, path: string | null, loadedFromDisk: boolean): ActiveRecord {
    const { markers, unreadable } = partitionMarkers(file.sections[REPLAY_MARKERS_SECTION]);
    const rawLaps = file.sections[REPLAY_LAPS_SECTION];
    const lapsNewerFormat = isNewerLapsSection(rawLaps);

    return {
      file,
      path,
      loadedFromDisk,
      markers,
      unreadableMarkers: unreadable,
      laps: rawLaps === undefined || lapsNewerFormat ? undefined : normalizeLapsSection(rawLaps),
      lapsNewerFormat,
    };
  }

  function open(header: ReplaySessionHeader): ActiveRecord {
    const ephemeral = header.subSessionId === 0;
    const filePath = ephemeral ? null : join(directory, replaySessionFileName(header.subSessionId));
    const loaded = filePath === null ? "none" : loadFile(filePath, header.subSessionId);
    const file = typeof loaded === "object" ? loaded.file : emptyFile(header.subSessionId);

    applyHeader(file, header);

    const record = recordOf(
      file,
      loaded === "unreadable" || loaded === "unwritable" ? null : filePath,
      typeof loaded === "object",
    );

    if (loaded === "unreadable") {
      record.reload = { attempt: 0 };
      scheduleReload(record);
    } else if (filePath !== null && orphanRetries.has(filePath)) {
      // The record loaded from the failed write's text, so it carries that
      // data itself now; its own save supersedes the orphan's retry.
      dropOrphan(filePath);
      markDirty();
      armTimer(debounceMs);
    }

    return record;
  }

  /** Header fields from the caller when it has them; a loaded `sessionStart` wins (the earlier observation). */
  function applyHeader(file: ReplaySessionFile, header: ReplaySessionHeader): void {
    if (header.track !== "") file.track = header.track;

    if (header.series !== "") file.series = header.series;

    if (file.sessionStart === "") file.sessionStart = header.sessionStart ?? now().toISOString();
  }

  function clearReloadTimer(record: ActiveRecord): void {
    if (record.reload?.timer !== undefined) {
      clearTimeout(record.reload.timer);
      record.reload.timer = undefined;
    }
  }

  /** Arm the next timed re-read of a file that could not be read at open; past the schedule, on demand only. */
  function scheduleReload(record: ActiveRecord): void {
    if (record.reload === undefined) return;

    const delay = loadRetryDelaysMs[record.reload.attempt];

    if (delay === undefined) {
      logger.error(
        "Replay session file could not be read; the session runs in memory and nothing is written until it can be",
      );

      return;
    }

    record.reload.attempt++;
    logger.debug(`Retrying the replay session read in ${delay} ms (attempt ${record.reload.attempt})`);
    record.reload.timer = setTimeout(() => {
      if (record.reload === undefined) return;

      record.reload.timer = undefined;

      if (active !== record) return;

      if (!tryReload(record)) scheduleReload(record);
    }, delay);
  }

  /**
   * Re-read the active record's file after a failed read. Still unreadable:
   * false, nothing changes. Readable: the in-memory record is merged INTO what
   * the disk holds — markers as a union under the dedupe rule, laps as a union
   * keeping the disk's entry where both have one — and the result is written
   * normally. Gone or corrupt-and-preserved: the in-memory record is the file
   * now. Corrupt and not preservable: memory-only for good.
   */
  function tryReload(record: ActiveRecord): boolean {
    if (record.reload === undefined || active !== record) return false;

    const filePath = join(directory, replaySessionFileName(record.file.subSessionId));
    const loaded = loadFile(filePath, record.file.subSessionId);

    if (loaded === "unreadable") return false;

    clearReloadTimer(record);
    record.reload = undefined;

    if (loaded === "unwritable") return false;

    const hadContent = record.markers.length > 0 || record.laps !== undefined;

    if (loaded === "none") {
      record.path = filePath;
      logger.info("Replay session file became writable; the session's record is written");
    } else {
      const merged = recordOf(loaded.file, filePath, true);

      applyHeader(merged.file, {
        subSessionId: record.file.subSessionId,
        track: record.file.track,
        series: record.file.series,
        sessionStart: record.file.sessionStart,
      });

      for (const marker of record.markers) addMarker(merged.markers, marker);

      if (record.laps !== undefined) {
        if (merged.lapsNewerFormat) {
          logger.warn(
            "Replay session file carries a newer laps section; the laps recorded while it was unreadable are dropped",
          );
        } else {
          mergeLapsSectionInto(lapsOf(merged), record.laps);
        }
      }

      Object.assign(record, merged);
      logger.info("Replay session file became readable; the session's record is merged into it");
      logger.debug(
        `Replay session ${record.file.subSessionId}: ${filePath} (${record.markers.length} markers after the merge)`,
      );
    }

    if (hadContent) scheduleSave();

    return true;
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

  /** The record's writable laps section, or null (with a one-time warning) when the file's is a newer build's. */
  function writableLapsOf(record: ActiveRecord): ReplayLapsSection | null {
    if (record.lapsNewerFormat) {
      if (!warnedNewerLaps) {
        warnedNewerLaps = true;
        logger.warn(
          "Replay session file carries a laps section from a newer iRaceDeck; laps are not recorded into it by this version",
        );
      }

      return null;
    }

    return lapsOf(record);
  }

  function lapsOf(record: ActiveRecord): ReplayLapsSection {
    record.laps ??= normalizeLapsSection(undefined);

    return record.laps;
  }

  const pendingKey = (r: { sessionNum: number; sessionUniqueId: number; carIdx: number; lap: number }): string =>
    `${r.sessionNum}:${r.sessionUniqueId}:${r.carIdx}:${r.lap}`;

  /** Flush the active record — after one last try at a file that could not be read — and drop it. */
  function dropActive(): void {
    if (active === null) return;

    if (active.reload !== undefined) {
      clearReloadTimer(active);
      tryReload(active);
    }

    flushPending();
    active = null;
    pendingLapTimes = new Map();
  }

  const markers: ReplayMarkersApi = {
    add(marker, scope = {}) {
      const target = activeFor(scope);

      if (target === null) return false;

      const added = addMarker(target.markers, marker);

      if (added) {
        logger.info("Replay marker added");
        logger.debug(`Marker at frame ${marker.frame} (session ${marker.sessionNum}, ${marker.sessionTimeMs} ms)`);
        scheduleSave();
      } else {
        logger.debug(`Marker at frame ${marker.frame} not added: one is already within the dedupe window`);
      }

      return added;
    },

    deleteNearest(frame, scope = {}) {
      const target = activeFor(scope);

      if (target === null) return null;

      const deleted = deleteNearestMarker(target.markers, frame);

      if (deleted !== null) {
        logger.info("Replay marker deleted");
        logger.debug(`Deleted the marker at frame ${deleted.frame} (pressed at ${frame})`);
        scheduleSave();
      }

      return deleted;
    },

    next: (frame, scope = {}) => nextMarker(activeFor(scope)?.markers ?? [], frame),
    previous: (frame, scope = {}) => previousMarker(activeFor(scope)?.markers ?? [], frame),
    // A copy: the live list is the store's, and a caller holding it across a
    // session change would be reading the wrong session's markers.
    list: (scope = {}) => (activeFor(scope)?.markers ?? []).map((m) => ({ ...m })),
  };

  const laps: ReplayLapsApi = {
    recordLapStart(record) {
      const target = activeFor(record);

      if (target === null) return false;

      const section = writableLapsOf(target);

      if (section === null) return false;

      const { carReplaced, joinedBySessionNum } = recordLapStartInSection(section, record);

      if (carReplaced) {
        logger.debug(
          `Car index ${record.carIdx} now carries car number ${record.carNumberRaw}; its earlier laps were dropped`,
        );
      }

      if (joinedBySessionNum) {
        logger.debug(
          `Lap ${record.lap} of car index ${record.carIdx} (session ${record.sessionNum}, unique id ${record.sessionUniqueId}) joined the one recorded session ${record.sessionNum} by its frame`,
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

      const section = writableLapsOf(target);

      if (section === null) return false;

      if (recordLapTimeInSection(section, record)) {
        scheduleSave();
      } else {
        pendingLapTimes.set(pendingKey(record), record.timeMs);
      }

      return true;
    },

    findLapStart(query) {
      const target = activeFor(query);

      if (target === null) return { hit: false, reason: "no file" };

      if (target.lapsNewerFormat) return { hit: false, reason: "newer format" };

      // Nothing came from disk and nothing has been recorded: the plugin was
      // not running for this session (someone else's .rpy, an offline replay
      // opened later). "no session" is for a record that exists but holds no
      // matching session.
      if (!target.loadedFromDisk && target.laps === undefined) return { hit: false, reason: "no file" };

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

        if (active.reload !== undefined && tryReload(active)) {
          logger.debug("Replay session file read on the session's re-announcement");
        }

        return;
      }

      // The previous session's record goes to disk NOW, then is dropped; the
      // ephemeral record is simply dropped.
      dropActive();
      active = open(header);

      if (active.path === null) {
        logger.info(
          header.subSessionId === 0
            ? "Replay session opened in memory (offline session, nothing is written)"
            : active.reload !== undefined
              ? "Replay session opened in memory (its file cannot be read right now; the read is retried)"
              : "Replay session opened in memory (its file cannot be written over)",
        );
      } else {
        logger.info("Replay session opened");
        logger.debug(
          `Replay session ${header.subSessionId}: ${active.path} (${active.markers.length} markers, laps section ${active.lapsNewerFormat ? "newer format" : active.laps === undefined ? "absent" : "present"})`,
        );
      }
    },

    clearActiveSession() {
      if (active === null) return;

      dropActive();
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

      for (const [path, orphan] of [...orphanRetries]) {
        if (orphan.timer !== undefined) clearTimeout(orphan.timer);

        orphan.timer = undefined;

        if (unlandedByPath.get(path) === orphan.payload.text) enqueue(orphan.payload);
        else orphanRetries.delete(path);
      }

      await inFlight;
    },

    flushSync() {
      // One last try at a file that could not be read: readable now, the
      // record is merged into it and is the write below.
      if (active?.reload !== undefined) {
        clearReloadTimer(active);
        tryReload(active);
      }

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
          dropOrphan(path);
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
