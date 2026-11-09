/**
 * The per-track store (issue #1112): a process singleton and the only owner
 * of `%LOCALAPPDATA%\iRaceDeck\Track Data\track_<TrackID>.json`.
 *
 * It persists the pit-lane landmarks the translator learns. The translator
 * publishes each accepted edge as `pitLane.landmarkLearned`; the plugin hands
 * the payload to {@link TrackStore.recordSample}, which folds it with
 * `@iracedeck/track-data`'s `foldSample` — the same model the translator uses,
 * never a copy of it — and schedules a write. At session start the plugin
 * seeds the translator from {@link TrackStore.load}.
 *
 * The folder is shared by every deck host (spec decision 3), so two plugin
 * processes may write one file. Every write therefore re-reads the file and
 * re-folds this process's own recent samples into what it finds, instead of
 * writing its in-memory copy over the other process's: folding is idempotent
 * (a duplicate key under a minute apart is skipped, a sample older than a
 * full window is stale), so re-folding a sample already on disk changes
 * nothing. Nothing but a track rebuild ever removes a landmark sample, which
 * is what makes a merge on write safe here where the replay store had to go
 * per ecosystem. The same re-fold heals the one race left: another process
 * renaming its write between this process's read and its rename drops this
 * process's samples from the file; the settle check one debounce after every
 * write re-reads the file and writes again when any of its own samples is
 * missing.
 *
 * Write discipline follows `@iracedeck/settings`' `settings-store.ts`: atomic
 * replace (temp file + rename), a trailing debounce capped by a max wait,
 * failed writes retried on `WRITE_RETRY_DELAYS_MS` and kept for the shutdown
 * flush, a corrupt file moved aside as `track_<id>.corrupt-<iso>.json` and
 * never overwritten or deleted, a file written by a newer build never
 * written. IO is synchronous: the file is a few kilobytes, written at most a
 * few times a minute, and a synchronous read-merge-rename leaves no await in
 * which this process could interleave with itself. Compact JSON.
 */
import type { ILogger } from "@iracedeck/logger";
import { WRITE_RETRY_DELAYS_MS } from "@iracedeck/settings";
import {
  applyTrackLength,
  foldSample,
  PIT_LANE_LANDMARK_NAMES,
  PIT_LANE_WINDOW_CAP,
  type PitLaneLandmarkName,
  type PitLaneLandmarks,
  type PitLaneLandmarkSample,
  type PitLaneSection,
  type PitLaneTrackIdentity,
} from "@iracedeck/track-data";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  buildTrackFile,
  type ParsedTrackFile,
  readTrackFile,
  trackFileMismatch,
  trackFileName,
  type TrackFileRead,
} from "./track-file.js";

/** Trailing debounce for a track's write: a burst of edges (a pit cycle's four) lands as one file. */
export const TRACK_STORE_WRITE_DEBOUNCE_MS = 2_000;

/** The longest an unsaved sample waits for the disk, however many follow it. */
export const TRACK_STORE_WRITE_MAX_WAIT_MS = 10_000;

/**
 * This process's own samples kept per landmark for the re-fold on write.
 * Twice the window: a sample older than a full window is stale and could not
 * re-enter it anyway, and the margin covers another process's samples
 * interleaving with ours.
 */
export const TRACK_STORE_OWN_SAMPLES_CAP = 2 * PIT_LANE_WINDOW_CAP;

/**
 * A temp file older than this is removed on init even when its pid names a
 * running process: no write takes ten minutes, so the pid has been reused.
 */
export const TRACK_STORE_STALE_TEMP_MS = 10 * 60_000;

/** The `pitLane.landmarkLearned` payload as the store reads it; its `summary` is not read. */
export interface TrackStoreSampleInput {
  track: PitLaneTrackIdentity;
  landmark: PitLaneLandmarkName;
  sample: PitLaneLandmarkSample;
}

export interface TrackStore {
  /** The folder the store owns `track_*.json` in. */
  readonly directory: string;
  /**
   * The track's pit-lane section, for seeding the translator: the file
   * (read once per track, then cached) brought to the session's track length
   * (`applyTrackLength`, a rebuild when it differs) with this process's
   * samples not yet written folded in. A copy. `null` when nothing is known:
   * no file, a file of another track (logged once, never written over), a
   * newer build's file, or one that cannot be read or parsed — and no sample
   * recorded meanwhile. SYNCHRONOUS, and never throws.
   */
  load(track: PitLaneTrackIdentity): PitLaneSection | null;
  /**
   * Fold one accepted sample (the `pitLane.landmarkLearned` payload) into the
   * track's section and schedule a write. Returns whether the fold accepted
   * it; a duplicate, a stale or a malformed sample changes nothing. Never
   * throws.
   */
  recordSample(input: TrackStoreSampleInput): boolean;
  /**
   * Write every pending track SYNCHRONOUSLY, merged as any write is, for
   * `process.on("exit")`. Clears the timers; the store stays usable.
   */
  flushSync(): void;
}

/** The file operations the store uses; a seam so tests can fail or interleave them. */
export interface TrackStoreIo {
  readText(path: string): string;
  writeText(path: string, text: string): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  /** Copy that fails when `to` exists. */
  copyExclusive(from: string, to: string): void;
  mkdirp(path: string): void;
  readdir(path: string): string[];
  exists(path: string): boolean;
  mtimeMs(path: string): number;
  /** Whether a process with this pid is running. */
  isProcessAlive(pid: number): boolean;
}

export const nodeTrackStoreIo: TrackStoreIo = {
  readText: (path) => readFileSync(path, "utf-8"),
  writeText: (path, text) => writeFileSync(path, text, "utf-8"),
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
  copyExclusive: (from, to) => copyFileSync(from, to, constants.COPYFILE_EXCL),
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true });
  },
  readdir: (path) => readdirSync(path),
  exists: (path) => existsSync(path),
  mtimeMs: (path) => statSync(path).mtimeMs,
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0);

      return true;
    } catch (error: unknown) {
      // EPERM: the process exists but belongs to someone else.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
};

export interface TrackStoreOptions {
  /** `resolveTrackDataDirectory({ env: process.env })`. */
  directory: string;
  /** The simulator the TrackIDs belong to, written to every file's envelope (`"iracing"`). */
  sim: string;
  logger: ILogger;
  /** Clock, for `updatedAt`, the debounce and the corrupt-aside name (test hook). */
  now?: () => Date;
  /** Trailing debounce; default {@link TRACK_STORE_WRITE_DEBOUNCE_MS}. */
  debounceMs?: number;
  /** The most an unsaved sample waits; default {@link TRACK_STORE_WRITE_MAX_WAIT_MS}. */
  maxWaitMs?: number;
  /** Retry schedule after a failed write; default the settings store's `WRITE_RETRY_DELAYS_MS`. */
  retryDelaysMs?: readonly number[];
  /** File operations; default {@link nodeTrackStoreIo} (test hook). */
  io?: TrackStoreIo;
  /** The pid in this process's temp-file names; default `process.pid` (test hook: two stores as two processes). */
  pid?: number;
}

/** One of this process's own samples, with the track length it was learned under. */
interface OwnSample {
  sample: PitLaneLandmarkSample;
  trackLength: string;
}

/** Why a file is not used. */
type Refusal = "mismatch" | "newerVersion" | "newerSection";

interface TrackEntry {
  path: string;
  /** The session's identity, as last passed to `load` or `recordSample`. */
  identity: PitLaneTrackIdentity;
  /** The file as last read or written, when it is this track's and this build reads it. */
  base: ParsedTrackFile | undefined;
  /** A read has classified the file (anything but unreadable): `load` serves from memory. */
  read: boolean;
  /** Why the file on disk is not used, when it is not. */
  refusal: Refusal | null;
  /** In memory: the base's section at the session's track length plus this process's samples. */
  section: PitLaneSection;
  /** This process's own recent samples per landmark, oldest first, for the re-fold on write. */
  own: Map<PitLaneLandmarkName, OwnSample[]>;
  /** A sample not yet on disk. */
  dirty: boolean;
  firstDirtyAt: number;
  /** The settle check after a write is due. */
  verifyPending: boolean;
  retryAttempt: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Once-warnings already given for this track. */
  warned: Set<string>;
}

type WriteMode = "save" | "verify";
type WriteOutcome = "done" | "unchanged" | "refused" | "retry";

function isoStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** The temp files the atomic write uses, and nothing else: `track_<id>.json.<pid>.tmp`. */
const TEMP_FILE = /^track_\d+\.json\.(\d+)\.tmp$/;

function hasLandmarks(section: PitLaneSection): boolean {
  return PIT_LANE_LANDMARK_NAMES.some((name) => section.landmarks[name] !== undefined);
}

function sameIdentity(a: PitLaneTrackIdentity, b: PitLaneTrackIdentity): boolean {
  return (
    a.trackId === b.trackId &&
    a.trackName === b.trackName &&
    a.trackConfigName === b.trackConfigName &&
    a.trackLength === b.trackLength &&
    a.trackLengthM === b.trackLengthM &&
    a.trackVersion === b.trackVersion
  );
}

export function createTrackStore(opts: TrackStoreOptions): TrackStore {
  const { directory, sim, logger } = opts;
  const now = opts.now ?? (() => new Date());
  const debounceMs = opts.debounceMs ?? TRACK_STORE_WRITE_DEBOUNCE_MS;
  const maxWaitMs = opts.maxWaitMs ?? TRACK_STORE_WRITE_MAX_WAIT_MS;
  const retryDelaysMs = opts.retryDelaysMs ?? WRITE_RETRY_DELAYS_MS;
  const io = opts.io ?? nodeTrackStoreIo;
  const pid = opts.pid ?? process.pid;
  const entries = new Map<number, TrackEntry>();

  removeStaleTempFiles();

  /**
   * Remove temp files a crashed process left behind: only names of this
   * store's own pattern, and only when their pid is not a running process or
   * they are older than {@link TRACK_STORE_STALE_TEMP_MS} — another live
   * plugin process may be mid-write in the same folder. Our own pid at init
   * is a previous process's: this one has not written yet.
   */
  function removeStaleTempFiles(): void {
    let names: string[];

    try {
      names = io.readdir(directory);
    } catch {
      return; // no folder yet, or unreadable — nothing to clean
    }

    for (const name of names) {
      const match = TEMP_FILE.exec(name);

      if (!match) continue;

      const path = join(directory, name);
      const ownerPid = Number(match[1]);

      try {
        const ageMs = now().getTime() - io.mtimeMs(path);

        if (ownerPid !== pid && ageMs < TRACK_STORE_STALE_TEMP_MS && io.isProcessAlive(ownerPid)) continue;

        io.unlink(path);
        logger.debug(`Removed a stale track-data temp file: ${name}`);
      } catch (error: unknown) {
        logger.debug(`Stale track-data temp file ${name} could not be removed: ${String(error)}`);
      }
    }
  }

  function warnOnce(entry: TrackEntry, key: string, message: string): void {
    if (entry.warned.has(key)) {
      logger.debug(message);

      return;
    }

    entry.warned.add(key);
    logger.warn(message);
  }

  /**
   * `base` brought to the session's track length, with this process's own
   * samples of that length re-folded in (oldest first). `accepted` counts the
   * re-folds that changed something: zero when every own sample is already
   * there (or stale).
   */
  function mergeOwn(
    base: PitLaneSection | undefined,
    entry: TrackEntry,
  ): { section: PitLaneSection; accepted: number } {
    const { identity } = entry;
    const section = applyTrackLength(base, identity.trackLength, identity.trackLengthM);
    const landmarks: PitLaneLandmarks = { ...section.landmarks };
    const at = now().toISOString();
    let accepted = 0;

    for (const [name, samples] of entry.own) {
      for (const own of samples) {
        if (own.trackLength !== identity.trackLength) continue;

        const result = foldSample(landmarks[name], own.sample, at, identity.trackLengthM);

        if (result.accepted) {
          landmarks[name] = result.record;
          accepted++;
        }
      }
    }

    return { section: accepted === 0 ? section : { ...section, landmarks }, accepted };
  }

  function recompute(entry: TrackEntry): void {
    entry.section = mergeOwn(entry.base?.pitLane, entry).section;
  }

  /**
   * Take a read of the file into the entry: the base it now merges onto, and
   * why the file is refused when it is. A `corrupt` file is no base; only a
   * write moves it aside. An `unreadable` one changes nothing.
   */
  function absorb(entry: TrackEntry, result: TrackFileRead): "use" | "corrupt" | "unreadable" | "refused" {
    const name = trackFileName(entry.identity.trackId);
    let verdict: "use" | "corrupt" | "refused";

    switch (result.kind) {
      case "unreadable":
        logger.debug(`Track data file ${name} could not be read: ${String(result.error)}`);

        return "unreadable";
      case "absent":
        entry.base = undefined;
        entry.refusal = null;
        verdict = "use";
        break;
      case "corrupt":
        entry.base = undefined;
        entry.refusal = null;
        verdict = "corrupt";
        logger.debug(`Track data file ${name} is not valid: ${String(result.error)}`);
        break;
      case "newerVersion":
      case "newerSection":
        entry.base = undefined;
        entry.refusal = result.kind;
        verdict = "refused";
        warnOnce(
          entry,
          result.kind,
          `Track data file ${name} was written by a newer version of iRaceDeck (${result.kind === "newerVersion" ? "file" : "pit-lane section"} version ${result.version}); it is not read and never written`,
        );
        break;
      case "ok": {
        const mismatch = trackFileMismatch(result.file, entry.identity, sim);

        if (mismatch === null) {
          entry.base = result.file;
          entry.refusal = null;
          verdict = "use";
        } else {
          entry.base = undefined;
          entry.refusal = "mismatch";
          verdict = "refused";
          warnOnce(
            entry,
            `mismatch:${mismatch}`,
            `Track data file ${name} belongs to another track (${mismatch}); it is not read and never written`,
          );
        }

        break;
      }
    }

    entry.read = true;
    recompute(entry);

    return verdict;
  }

  /**
   * The entry for a track, created on first use; an identity that changed
   * (a rebuilt track's length, a renamed configuration) is taken and the file
   * is re-read on next use. Own samples of another track length are dropped:
   * they belong to the old geometry.
   */
  function entryFor(track: PitLaneTrackIdentity): TrackEntry {
    let entry = entries.get(track.trackId);

    if (entry === undefined) {
      entry = {
        path: join(directory, trackFileName(track.trackId)),
        identity: { ...track },
        base: undefined,
        read: false,
        refusal: null,
        section: applyTrackLength(undefined, track.trackLength, track.trackLengthM),
        own: new Map(),
        dirty: false,
        firstDirtyAt: 0,
        verifyPending: false,
        retryAttempt: 0,
        warned: new Set(),
      };
      entries.set(track.trackId, entry);

      return entry;
    }

    if (!sameIdentity(entry.identity, track)) {
      entry.identity = { ...track };

      for (const [name, samples] of entry.own) {
        entry.own.set(
          name,
          samples.filter((own) => own.trackLength === track.trackLength),
        );
      }

      entry.read = false;
      recompute(entry);
    }

    return entry;
  }

  function ensureRead(entry: TrackEntry): void {
    if (!entry.read) absorb(entry, readTrackFile(entry.path, io.readText));
  }

  function rememberOwn(entry: TrackEntry, landmark: PitLaneLandmarkName, sample: PitLaneLandmarkSample): void {
    const samples = entry.own.get(landmark) ?? [];

    samples.push({ sample: { ...sample }, trackLength: entry.identity.trackLength });
    samples.sort((a, b) => a.sample.at - b.sample.at);

    if (samples.length > TRACK_STORE_OWN_SAMPLES_CAP) samples.splice(0, samples.length - TRACK_STORE_OWN_SAMPLES_CAP);

    entry.own.set(landmark, samples);
  }

  /** A free `track_<id>.corrupt-<iso>.json` name; never one that exists. */
  function asidePath(trackId: number): string {
    const stem = `track_${trackId}.corrupt-${isoStamp(now())}`;
    let candidate = join(directory, `${stem}.json`);

    for (let n = 1; io.exists(candidate); n++) candidate = join(directory, `${stem}-${n}.json`);

    return candidate;
  }

  /**
   * An existing `track_<id>.corrupt-*.json` whose bytes equal the corrupt
   * file, so a file that survives every attempt (locked, undeletable) is
   * preserved once, not once per write — the settings store's rule.
   */
  function identicalAside(entry: TrackEntry): string | undefined {
    const prefix = `track_${entry.identity.trackId}.corrupt-`;
    const original = io.readText(entry.path);

    for (const name of io.readdir(directory)) {
      if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;

      try {
        if (io.readText(join(directory, name)) === original) return name;
      } catch {
        // an aside that cannot be read is no match
      }
    }

    return undefined;
  }

  /** Preserve a corrupt file under another name. Whether it is now safe to write over the original path. */
  function moveAside(entry: TrackEntry): boolean {
    const aside = asidePath(entry.identity.trackId);
    const name = trackFileName(entry.identity.trackId);

    try {
      io.rename(entry.path, aside);
      logger.warn(`Track data file ${name} is not valid; preserved as ${aside} and started fresh`);

      return true;
    } catch (renameError: unknown) {
      try {
        const existing = identicalAside(entry);

        if (existing === undefined) {
          io.copyExclusive(entry.path, aside);
          logger.warn(`Track data file ${name} is not valid and could not be moved; preserved as a copy, ${aside}`);
        } else {
          logger.debug(`Track data file ${name} is not valid; an identical copy is already preserved as ${existing}`);
        }

        logger.debug(`Move-aside rename failed: ${String(renameError)}`);

        try {
          io.unlink(entry.path);
        } catch (unlinkError: unknown) {
          logger.debug(`Corrupt original could not be removed: ${String(unlinkError)}`);
        }

        return true;
      } catch (copyError: unknown) {
        logger.error(`Track data file ${name} is not valid and could not be preserved; it is not written over`);
        logger.debug(`Copy also failed: ${String(copyError)}`);

        return false;
      }
    }
  }

  function writeAtomic(path: string, text: string): void {
    const tmp = `${path}.${pid}.tmp`;

    try {
      io.mkdirp(directory);
      io.writeText(tmp, text);
      io.rename(tmp, path);
    } catch (error: unknown) {
      try {
        io.unlink(tmp);
      } catch {
        // best effort — the temp file may never have been created
      }

      throw error;
    }
  }

  /**
   * Re-read the file, merge this process's samples into it, write it.
   * `verify` (the settle check) writes only when one of this process's
   * samples is missing from the file.
   */
  function writeEntry(entry: TrackEntry, mode: WriteMode): WriteOutcome {
    const name = trackFileName(entry.identity.trackId);
    const verdict = absorb(entry, readTrackFile(entry.path, io.readText));

    if (verdict === "unreadable") return "retry";

    if (verdict === "refused") return "refused";

    const existed = entry.base !== undefined;
    const { section, accepted } = mergeOwn(entry.base?.pitLane, entry);

    if (mode === "verify" && accepted === 0) return "unchanged";

    if (verdict === "corrupt" && !moveAside(entry)) return "retry";

    const pitLane: PitLaneSection = { ...section, trackVersion: entry.identity.trackVersion };
    const file = buildTrackFile(entry.base, entry.identity, sim, pitLane);

    try {
      writeAtomic(entry.path, JSON.stringify(file) + "\n");
    } catch (error: unknown) {
      logger.debug(`Track data write of ${name} failed: ${String(error)}`);

      return "retry";
    }

    entry.base = file;
    entry.section = pitLane;

    if (existed) {
      logger.debug(
        mode === "verify"
          ? `Track data ${name} rewritten: ${accepted} sample(s) another process's write had dropped`
          : `Track data ${name} written`,
      );
    } else {
      logger.info(`Track data file created: ${name}`);
    }

    return "done";
  }

  function arm(entry: TrackEntry, delayMs: number): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);

    entry.timer = setTimeout(() => {
      entry.timer = undefined;

      if (entry.dirty) attempt(entry, "save");
      else if (entry.verifyPending) attempt(entry, "verify");
    }, delayMs);
    entry.timer.unref?.();
  }

  function attempt(entry: TrackEntry, mode: WriteMode): void {
    entry.verifyPending = false;

    const outcome = writeEntry(entry, mode);

    switch (outcome) {
      case "done":
        entry.dirty = false;
        entry.retryAttempt = 0;
        entry.verifyPending = true;
        arm(entry, debounceMs);
        break;
      case "unchanged":
        break;
      case "refused":
        // Kept in memory for load(); a newer or foreign file is never written.
        entry.dirty = false;
        break;
      case "retry": {
        if (!entry.dirty) {
          entry.dirty = true;
          entry.firstDirtyAt = now().getTime();
        }

        const delay = retryDelaysMs[entry.retryAttempt];

        if (delay === undefined) {
          logger.warn(
            `Track data ${trackFileName(entry.identity.trackId)} could not be written; retrying on the next sample or at shutdown`,
          );
          break;
        }

        entry.retryAttempt++;
        logger.debug(`Retrying the track data write in ${delay} ms (attempt ${entry.retryAttempt})`);
        arm(entry, delay);
        break;
      }
    }
  }

  /** A new sample: debounce the write, but never past the max wait from the first unsaved one. */
  function scheduleSave(entry: TrackEntry): void {
    const nowMs = now().getTime();

    if (!entry.dirty) {
      entry.dirty = true;
      entry.firstDirtyAt = nowMs;
    }

    entry.retryAttempt = 0;
    entry.verifyPending = false;
    arm(entry, Math.max(0, Math.min(debounceMs, entry.firstDirtyAt + maxWaitMs - nowMs)));
  }

  return {
    directory,

    load(track) {
      try {
        const entry = entryFor(track);

        ensureRead(entry);

        return hasLandmarks(entry.section) ? structuredClone(entry.section) : null;
      } catch (error: unknown) {
        logger.error(`Track data for track ${track.trackId} could not be loaded: ${String(error)}`);

        return null;
      }
    },

    recordSample({ track, landmark, sample }) {
      try {
        if (!(PIT_LANE_LANDMARK_NAMES as readonly string[]).includes(landmark)) {
          logger.debug(`Track data sample for an unknown landmark ignored: ${String(landmark)}`);

          return false;
        }

        const entry = entryFor(track);

        ensureRead(entry);

        const result = foldSample(entry.section.landmarks[landmark], sample, now().toISOString(), track.trackLengthM);

        if (!result.accepted) {
          logger.debug(`Track data sample for ${landmark} not folded: ${result.reason}`);

          return false;
        }

        entry.section = { ...entry.section, landmarks: { ...entry.section.landmarks, [landmark]: result.record } };
        rememberOwn(entry, landmark, sample);
        scheduleSave(entry);

        return true;
      } catch (error: unknown) {
        logger.error(`Track data sample could not be recorded: ${String(error)}`);

        return false;
      }
    },

    flushSync() {
      for (const entry of entries.values()) {
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer);
          entry.timer = undefined;
        }

        const mode: WriteMode | undefined = entry.dirty ? "save" : entry.verifyPending ? "verify" : undefined;

        if (mode === undefined) continue;

        entry.verifyPending = false;

        try {
          const outcome = writeEntry(entry, mode);

          if (outcome === "done" || outcome === "refused") entry.dirty = false;
          else if (outcome === "retry") {
            logger.error(`Track data ${trackFileName(entry.identity.trackId)} could not be written at shutdown`);
          }
        } catch (error: unknown) {
          logger.error(`Track data shutdown flush failed: ${String(error)}`);
        }
      }
    },
  };
}

let trackStore: TrackStore | null = null;

/**
 * Initialize the track store singleton. Called once at plugin startup; the
 * plugin also registers `process.on("exit", () => store.flushSync())`.
 *
 * @throws Error if called more than once
 */
export function initializeTrackStore(options: TrackStoreOptions): TrackStore {
  if (trackStore) {
    throw new Error("Track store already initialized. initializeTrackStore() should only be called once.");
  }

  trackStore = createTrackStore(options);

  return trackStore;
}

/**
 * Get the track store.
 *
 * @throws Error if the store hasn't been initialized
 */
export function getTrackStore(): TrackStore {
  if (!trackStore) {
    throw new Error("Track store not initialized. Call initializeTrackStore() first in your plugin entry point.");
  }

  return trackStore;
}

export function isTrackStoreInitialized(): boolean {
  return trackStore !== null;
}

/**
 * Reset the singleton (for testing purposes only).
 * @internal
 */
export function _resetTrackStore(): void {
  trackStore = null;
}
