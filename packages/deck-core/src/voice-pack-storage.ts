/**
 * The on-disk choreography around a voice-pack install (issue #1034, stage 2).
 *
 * Owns the layout of the packs directory beyond the packs themselves —
 * `<root>/.tmp/` for downloads and staging, `<root>/.trash/` for superseded
 * packs — and the one operation whose ORDER is the whole point: replacing an
 * installed pack with a staged one so that a failure at any step leaves the
 * pack that was there before untouched and playable. See {@link
 * VoicePackStorage.promote} for the ordering and the orderings it rejects.
 *
 * Both working directories are dot-directories because the scanner skips
 * anything starting with `.` (and says why): a half-extracted staging tree
 * must never be mistaken for a pack, and a superseded copy waiting in the
 * trash must never be scanned as a second `luca`.
 *
 * Nothing here decides what a pack IS — that is the scanner — and nothing here
 * talks to the network — that is `voice-pack-download.ts`. The filesystem is
 * injected behind {@link VoicePackStorageFileSystem}, in the shape
 * `voice-pack-fs.ts` established, so every ordering below is tested against a
 * fake that can fail at exactly the step under test. The single `node:fs`
 * implementation is {@link createVoicePackStorageFileSystem}, and it is the
 * only code in this module that can throw an I/O error — every method on the
 * storage itself returns a discriminated result.
 */
import type { ILogger } from "@iracedeck/logger";
import { type FileHandle, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SHA256_HEX_PATTERN, VOICE_PACK_PROVENANCE_FILE } from "./voice-pack-constants.js";
import type { VoicePackDownloadSink } from "./voice-pack-download.js";
import { packId } from "./voice-pack-manifest.js";
import { serializeVoicePackProvenance, type VoicePackProvenance } from "./voice-pack-provenance.js";

export const VOICE_PACK_TMP_DIR = ".tmp";
export const VOICE_PACK_TRASH_DIR = ".trash";

/**
 * The provenance record's file name — see `voice-pack-provenance.ts` for what
 * it is and why a pack cannot ship its own. Named here because this module is
 * what writes it, into the STAGED directory rather than the installed one: the
 * spec lists the write after the swap, but a record written before the swap is
 * inside the directory the moment it appears, so a crash between the two steps
 * cannot leave a verified pack that the next start mistakes for a sideload.
 */

/**
 * Lock liveness, in three numbers.
 *
 * A holder rewrites its lock every {@link VOICE_PACK_LOCK_HEARTBEAT_MS}; a lock
 * whose last beat is older than {@link VOICE_PACK_LOCK_STALE_MS} belongs to a
 * process that is gone, and is taken over. A heartbeat rather than a creation
 * timestamp because of what happens when the holder CRASHES: the deck host
 * restarts the plugin within seconds, the restarted plugin finds its own
 * predecessor's lock, and with a fixed stale window measured from creation it
 * would wait out that whole window — for itself. Six missed beats is a minute
 * and a half; a crash costs that, not ten minutes.
 *
 * A waiter polls every {@link VOICE_PACK_LOCK_POLL_MS} and gives up after
 * {@link VOICE_PACK_LOCK_MAX_WAIT_MS}, at which point it proceeds WITHOUT the
 * lock — see {@link VoicePackStorage.acquireLock} for why that is safe.
 */
export const VOICE_PACK_LOCK_HEARTBEAT_MS = 15_000;
export const VOICE_PACK_LOCK_STALE_MS = 90_000;
export const VOICE_PACK_LOCK_POLL_MS = 2_000;
export const VOICE_PACK_LOCK_MAX_WAIT_MS = 10 * 60_000;

export type VoicePackFsResult = { ok: true } | { ok: false; /** An errno code where there is one. */ code: string };

/** An open file being written by the downloader. */
export interface VoicePackWriteHandle {
  /** Rejects on failure — the downloader reports a rejecting sink as its own failure kind. */
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<VoicePackFsResult>;
}

/**
 * The disk operations the choreography needs, and nothing more.
 *
 * Narrow for the reason the scanner's port is narrow: the swap, the sweep and
 * the lock are then pure functions of this port, and their tests can make
 * exactly one step fail — the second rename, the trash mkdir, the removal of a
 * held file — which is the only way to prove what the previously installed
 * pack looks like after each failure. Every method reports rather than throws.
 */
export interface VoicePackStorageFileSystem {
  /** `mkdir -p`; an existing directory is success. */
  makeDirectory(dir: string): Promise<VoicePackFsResult>;
  /** Immediate entry names in `dir`, files and directories alike; empty when `dir` does not exist. */
  listEntries(dir: string): Promise<readonly string[]>;
  exists(path: string): Promise<boolean>;
  /** A plain `rename(2)`: atomic on one volume, and on Windows never over an existing directory. */
  rename(from: string, to: string): Promise<VoicePackFsResult>;
  /** `rm -rf`; a missing path is success. */
  remove(path: string): Promise<VoicePackFsResult>;
  readTextFile(file: string): Promise<string | undefined>;
  writeTextFile(file: string, text: string): Promise<VoicePackFsResult>;
  /** Create-exclusive (`O_EXCL`): `created: false` means the file already existed. */
  createExclusive(file: string, text: string): Promise<{ ok: true; created: boolean } | { ok: false; code: string }>;
  /** Open (truncating) for writing. */
  openWrite(file: string): Promise<{ ok: true; handle: VoicePackWriteHandle } | { ok: false; code: string }>;
}

export type OpenVoicePackDownloadResult =
  | {
      ok: true;
      /** The archive's path in `.tmp`, for the extractor. */
      path: string;
      /** What the downloader writes into. */
      sink: VoicePackDownloadSink;
      /** Must be awaited before the archive is read. Idempotent. */
      close(): Promise<VoicePackFsResult>;
      /** Close if still open and delete the file. Never fails; a leftover is the sweep's problem. */
      discard(): Promise<void>;
    }
  | { ok: false; code: string };

export type CreateVoicePackStagingResult =
  | { ok: true; /** An empty directory in `.tmp` for the extractor to fill. */ dir: string; discard(): Promise<void> }
  | { ok: false; code: string };

export type PromoteVoicePackResult =
  | { ok: true; /** Where the superseded pack went, when there was one. */ trashedAt?: string }
  | {
      ok: false;
      /** `prepare` — nothing was touched yet. `retire-old` / `install-new` — the two renames, in order. */
      step: "prepare" | "retire-old" | "install-new";
      code: string;
      /**
       * Where the previously installed pack is now. `untouched` — still at
       * `<root>/<id>`, nothing moved. `none` — there was no previous pack.
       * `restored` — it was moved aside and moved back. A path — it is in
       * `.trash` at that path and could NOT be moved back; the sweep will not
       * delete it while no installed copy exists.
       */
      previous: "untouched" | "none" | "restored" | { trashedAt: string };
    };

export type RetireVoicePackResult =
  | { ok: true; /** Absent when there was nothing installed to retire. */ trashedAt?: string }
  | { ok: false; code: string };

export type SweepVoicePacksResult = {
  removed: number;
  /** Could not be deleted — held open, most likely. Tried again next start. */
  failed: number;
  /** Deliberately left: another plugin's live download, or the only copy of a pack. */
  kept: number;
};

export interface VoicePackLock {
  /** `false` means "proceed anyway" — the caller must never wait on it. */
  acquired: boolean;
  /** Idempotent; a no-op when not acquired, so it can never delete another holder's lock. */
  release(): Promise<void>;
}

export interface VoicePackStorageDeps {
  /** The packs directory — see `resolveVoicePacksPath`. */
  root: string;
  fs: VoicePackStorageFileSystem;
  logger: ILogger;
}

export interface VoicePackStorage {
  readonly root: string;
  /** `<root>/<id>` — where an installed pack lives, and its audio root. */
  packDir(id: string): string;
  /** A truncated `.tmp/<id>.<sha256>.zip` opened for the downloader. */
  openDownload(id: string, sha256: string): Promise<OpenVoicePackDownloadResult>;
  /** An empty `.tmp/<id>.<sha256>/` for the extractor. */
  createStagingDir(id: string, sha256: string): Promise<CreateVoicePackStagingResult>;
  /** Write `.install.json` into `dir` — a staged directory, before it is promoted. */
  writeProvenance(dir: string, provenance: VoicePackProvenance): Promise<VoicePackFsResult>;
  /** The atomic swap: `stagedDir` becomes `<root>/<id>`; any previous pack goes to `.trash`. */
  promote(id: string, stagedDir: string): Promise<PromoteVoicePackResult>;
  /** The Remove command: `<root>/<id>` goes to `.trash`. */
  retire(id: string): Promise<RetireVoicePackResult>;
  /** Plugin start: empty `.tmp` and `.trash` of everything safe to delete. */
  sweep(): Promise<SweepVoicePacksResult>;
  /** Best-effort: wait for another plugin's install of `id`, then hold the lock. */
  acquireLock(id: string): Promise<VoicePackLock>;
}

/**
 * The archive digest, as the catalog pins it. Validated here as well because it
 * becomes part of a FILE NAME: a `sha256` argument with a separator in it would
 * otherwise turn `.tmp/<id>.<sha256>.zip` into a path somewhere else.
 */
const SHA256_HEX = SHA256_HEX_PATTERN;

/**
 * A `.trash` entry: `<id>.<stamp>`, plus `.removed` when the user asked for it.
 *
 * A dot separator rather than the spec's illustrative dash, because a pack id
 * may itself contain dashes and never a dot: `<id>` is then unambiguously the
 * first segment, of a trash entry, a staged archive and a lock file alike. The
 * `.removed` suffix is what separates a pack the user removed from one an
 * install superseded, and the sweep treats the two differently — see
 * {@link VoicePackStorage.sweep}.
 */
const TRASH_ENTRY = /^([a-z][a-z0-9-]*)\.(\d+)(\.removed)?$/;

const LOCK_SUFFIX = ".lock";

type LockRecord = { pid: number; acquiredAt: number; heartbeatAt: number };

function isPackId(id: string): boolean {
  return packId.safeParse(id).success;
}

/**
 * Whether a lock file's content says its holder is still alive.
 *
 * Unreadable or unparseable counts as stale: a lock nobody can read protects
 * nothing, and the swap is safe without it anyway. The comparison is absolute
 * so a beat from the FUTURE — a clock set back while a lock was held — reads
 * as stale too rather than as live for the rest of the day.
 */
function isLiveLock(text: string | undefined, now: number): boolean {
  if (text === undefined) return false;

  try {
    const record = JSON.parse(text) as Partial<LockRecord> | null;
    const beat = record?.heartbeatAt;

    return typeof beat === "number" && Math.abs(now - beat) < VOICE_PACK_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The storage choreography over an injected filesystem.
 */
export function createVoicePackStorage({ root, fs, logger }: VoicePackStorageDeps): VoicePackStorage {
  const tmpDir = join(root, VOICE_PACK_TMP_DIR);
  const trashDir = join(root, VOICE_PACK_TRASH_DIR);
  const packDir = (id: string): string => join(root, id);
  const lockFile = (id: string): string => join(tmpDir, `${id}${LOCK_SUFFIX}`);

  /**
   * Trash names carry a timestamp, and two promotes of one pack inside a single
   * millisecond would collide — a rename onto an existing directory fails, so
   * the collision is safe, but it is a spurious failure. Bumping within the
   * process makes the stamp strictly increasing here; a collision between two
   * PROCESSES in the same millisecond is left to fail safely.
   */
  let lastStamp = 0;
  const stamp = (): number => {
    lastStamp = Math.max(lastStamp + 1, Date.now());

    return lastStamp;
  };

  const lockText = (acquiredAt: number): string =>
    JSON.stringify({ pid: process.pid, acquiredAt, heartbeatAt: Date.now() } satisfies LockRecord);

  const invalid = (what: string, value: string): { ok: false; code: string } => {
    logger.debug(`Voice packs: refusing ${what} "${value}" — not a valid name`);

    return { ok: false, code: "EINVAL" };
  };

  return {
    root,
    packDir,

    async openDownload(id, sha256) {
      if (!isPackId(id)) return invalid("pack id", id);

      if (!SHA256_HEX.test(sha256)) return invalid("digest", sha256);

      const made = await fs.makeDirectory(tmpDir);

      if (!made.ok) return made;

      const path = join(tmpDir, `${id}.${sha256}.zip`);

      // A leftover from an interrupted run is removed rather than truncated: it
      // may be a directory of that name, which no open mode can overwrite.
      const cleared = await fs.remove(path);

      if (!cleared.ok) return cleared;

      const opened = await fs.openWrite(path);

      if (!opened.ok) return opened;

      const { handle } = opened;
      let closed = false;

      const close = async (): Promise<VoicePackFsResult> => {
        if (closed) return { ok: true };

        closed = true;

        return handle.close();
      };

      return {
        ok: true,
        path,
        sink: { write: (chunk) => handle.write(chunk) },
        close,
        async discard() {
          await close();
          const removed = await fs.remove(path);

          if (!removed.ok)
            logger.debug(`Voice packs: could not discard "${path}" (${removed.code}); left for the sweep`);
        },
      };
    },

    async createStagingDir(id, sha256) {
      if (!isPackId(id)) return invalid("pack id", id);

      if (!SHA256_HEX.test(sha256)) return invalid("digest", sha256);

      const dir = join(tmpDir, `${id}.${sha256}`);

      // Emptied first: an extractor writing into a directory that still holds
      // half of a previous attempt would produce a pack with files no archive
      // contains, and it would verify.
      const cleared = await fs.remove(dir);

      if (!cleared.ok) return cleared;

      const made = await fs.makeDirectory(dir);

      if (!made.ok) return made;

      return {
        ok: true,
        dir,
        async discard() {
          const removed = await fs.remove(dir);

          if (!removed.ok)
            logger.debug(`Voice packs: could not discard "${dir}" (${removed.code}); left for the sweep`);
        },
      };
    },

    writeProvenance(dir, provenance) {
      return fs.writeTextFile(join(dir, VOICE_PACK_PROVENANCE_FILE), serializeVoicePackProvenance(provenance));
    },

    /**
     * Two renames, in this order, and nothing else on the critical path:
     *
     *   1. `<root>/<id>`  ->  `.trash/<id>.<stamp>`   (skipped when there is no previous pack)
     *   2. `stagedDir`    ->  `<root>/<id>`
     *
     * A rename is atomic — it either happened or it did not — so after step 1
     * fails the previous pack is exactly where it was, and after step 2 fails
     * it is intact in the trash and is moved back. Only if THAT rename also
     * fails does the previous pack end up anywhere other than installed, and
     * even then it is intact, at a path the result names, and protected from
     * the sweep until an installed copy exists again.
     *
     * The orderings this replaces, and what each would have cost:
     *
     * - **Delete the old pack, then rename the new one in.** The audio engine
     *   may still hold one of the old pack's clips open, and on Windows the
     *   deletion then fails PARTWAY — a pack with half its clips gone, nothing
     *   to roll back to, and the new one not yet in place. Deletion is
     *   therefore not on this path at all; the trash is swept at the next
     *   start, when nothing is playing.
     * - **Rename the new pack over the old one.** `rename(2)` cannot replace a
     *   non-empty directory on Windows (nor on POSIX), so there is no single
     *   atomic replacement to be had; two renames is the minimum.
     * - **Extract straight into `<root>/<id>`.** A failure mid-extract leaves a
     *   broken pack in the one place the scanner will load it from.
     * - **Delete the trashed copy right after step 2.** Would work when it
     *   works, and when it does not — a held file — would turn a successful
     *   install into a reported failure. The sweep exists so success here means
     *   "the new pack is in place" and nothing more.
     *
     * The caller stops voice playback before calling this, so step 1 does not
     * fail on a held clip; if it fails anyway, the answer is `retire-old` with
     * the previous pack untouched, and the staged directory is left for the
     * caller to discard.
     */
    async promote(id, stagedDir) {
      if (!isPackId(id)) return { ok: false, step: "prepare", code: "EINVAL", previous: "untouched" };

      const target = packDir(id);
      const prepared = await fs.makeDirectory(trashDir);

      if (!prepared.ok) return { ok: false, step: "prepare", code: prepared.code, previous: "untouched" };

      const trashedAt = join(trashDir, `${id}.${stamp()}`);
      const retired = await fs.rename(target, trashedAt);

      // ENOENT is the first install of this pack, not a failure. Asked of the
      // rename itself rather than of an `exists` check beforehand: between a
      // check and the rename the other ecosystem's plugin may have moved the
      // same directory, and a rename that reports its own outcome has no
      // window in which to be wrong about it.
      if (!retired.ok && retired.code !== "ENOENT") {
        logger.warn(`Voice pack "${id}": could not move the installed pack aside (${retired.code})`);

        return { ok: false, step: "retire-old", code: retired.code, previous: "untouched" };
      }

      const hadPrevious = retired.ok;
      const installed = await fs.rename(stagedDir, target);

      if (installed.ok) {
        logger.info("Voice pack promoted");
        logger.debug(
          `Voice pack "${id}": "${stagedDir}" -> "${target}"${hadPrevious ? `; previous at "${trashedAt}"` : ""}`,
        );

        return hadPrevious ? { ok: true, trashedAt } : { ok: true };
      }

      logger.warn(`Voice pack "${id}": could not move the staged pack into place (${installed.code})`);

      if (!hadPrevious) return { ok: false, step: "install-new", code: installed.code, previous: "none" };

      const restored = await fs.rename(trashedAt, target);

      if (restored.ok) return { ok: false, step: "install-new", code: installed.code, previous: "restored" };

      // Two renames inside one directory failed within milliseconds of each
      // other. Either the volume is in real trouble, or — the benign case —
      // the other ecosystem's plugin promoted an identical, hash-verified
      // copy into `<root>/<id>` between our two renames, and both the install
      // and the restore now find it occupied. The pack is intact either way;
      // the log says where, and the sweep will not touch it.
      logger.error(
        `Voice pack "${id}": the previous pack is intact at "${trashedAt}" but could not be restored (${restored.code})`,
      );

      return { ok: false, step: "install-new", code: installed.code, previous: { trashedAt } };
    },

    async retire(id) {
      if (!isPackId(id)) return invalid("pack id", id);

      const prepared = await fs.makeDirectory(trashDir);

      if (!prepared.ok) return prepared;

      const trashedAt = join(trashDir, `${id}.${stamp()}.removed`);
      const moved = await fs.rename(packDir(id), trashedAt);

      if (!moved.ok && moved.code !== "ENOENT") {
        logger.warn(`Voice pack "${id}": could not move the installed pack to the trash (${moved.code})`);

        return moved;
      }

      // A copy an earlier install superseded during this run is still in the
      // trash under a plain name, and the sweep keeps a plain entry while no
      // installed copy exists — which, after this, is exactly the state. Marked
      // removed here so the user's decision covers every copy, not just the
      // latest, and the space comes back at the next start.
      for (const name of await fs.listEntries(trashDir)) {
        const entry = TRASH_ENTRY.exec(name);

        if (entry === null || entry[1] !== id || entry[3] !== undefined) continue;

        const marked = await fs.rename(join(trashDir, name), join(trashDir, `${name}.removed`));

        if (!marked.ok) logger.debug(`Voice packs: could not mark "${name}" removed (${marked.code})`);
      }

      if (!moved.ok) return { ok: true };

      logger.info("Voice pack retired");
      logger.debug(`Voice pack "${id}": moved to "${trashedAt}"`);

      return { ok: true, trashedAt };
    },

    /**
     * Two things are deliberately left alone, both of which would otherwise be
     * deleted by a start that knew nothing about them:
     *
     * - Everything in `.tmp` belonging to a LIVE lock. The packs folder is
     *   shared across the three ecosystems, so a `.tmp/luca.<sha>.zip` may be
     *   another plugin's download in progress right now. Deleting it would
     *   succeed — Node opens files with delete sharing — and that plugin's
     *   extractor would then open a file that no longer exists.
     * - A plain `.trash/<id>.<stamp>` entry while `<root>/<id>` does not
     *   exist. That is the shape a failed promote leaves when the restore also
     *   failed: the only copy of the pack. `.removed` entries are the user's
     *   own decision and go regardless.
     *
     * A file that cannot be deleted — held open by the audio engine, an AV
     * scanner, an Explorer window — is a debug line and a retry next start.
     * Never a warning: this runs on every plugin start, and a leftover a user
     * cannot see is not something they can act on.
     */
    async sweep() {
      const result: SweepVoicePacksResult = { removed: 0, failed: 0, kept: 0 };
      const now = Date.now();

      const remove = async (path: string): Promise<void> => {
        const removed = await fs.remove(path);

        if (removed.ok) {
          result.removed += 1;
        } else {
          result.failed += 1;
          logger.debug(`Voice packs: could not remove "${path}" (${removed.code}); will retry next start`);
        }
      };

      const tmpEntries = await fs.listEntries(tmpDir);
      const live = new Set<string>();

      for (const name of tmpEntries) {
        if (!name.endsWith(LOCK_SUFFIX)) continue;

        if (isLiveLock(await fs.readTextFile(join(tmpDir, name)), now)) live.add(name.slice(0, -LOCK_SUFFIX.length));
      }

      for (const name of tmpEntries) {
        const owner = name.split(".")[0];

        if (live.has(owner)) {
          result.kept += 1;
          logger.debug(`Voice packs: kept "${name}" — another install of "${owner}" is in progress`);
          continue;
        }

        await remove(join(tmpDir, name));
      }

      for (const name of await fs.listEntries(trashDir)) {
        const entry = TRASH_ENTRY.exec(name);

        if (entry !== null && entry[3] === undefined && !(await fs.exists(packDir(entry[1])))) {
          result.kept += 1;
          logger.debug(`Voice packs: kept "${name}" — it is the only copy of "${entry[1]}"`);
          continue;
        }

        await remove(join(trashDir, name));
      }

      logger.info("Voice pack working directories swept");
      logger.debug(`Voice packs sweep: removed ${result.removed}, failed ${result.failed}, kept ${result.kept}`);

      return result;
    },

    /**
     * Correctness NEVER depends on this lock. Two plugins installing the same
     * pack at once both download hash-verified, byte-identical content, and
     * {@link VoicePackStorage.promote} is safe under that race — the second to
     * arrive finds `<root>/<id>` occupied by exactly what it was about to put
     * there. What the lock buys is not safety but bandwidth: the second plugin
     * waits, then finds the work already done, instead of fetching 12.5 MB it
     * is about to throw away. So every way this can fail — the directory cannot
     * be created, the exclusive create errors, a stale lock cannot be removed,
     * the wait runs out — answers `acquired: false`, and the caller proceeds.
     *
     * The create-exclusive is the only atomic step; the stale check is a read
     * of a file another process may be rewriting under us. A reader that lands
     * between the holder's open and its first write sees an empty file, calls
     * it stale, and takes it over — two holders, and the swap absorbs it. That
     * window is microseconds wide and closing it would cost a second file; not
     * worth it for a lock that is allowed to fail. When it is two WAITERS doing
     * that to each other — each reading the other's fresh lock as empty and
     * removing it — the poll between retries is what breaks the tie, and the
     * deadline is what ends it if nothing does; see the takeover branch below.
     */
    async acquireLock(id) {
      const unlocked: VoicePackLock = { acquired: false, release: async () => undefined };

      if (!isPackId(id)) return unlocked;

      const made = await fs.makeDirectory(tmpDir);

      if (!made.ok) {
        logger.debug(`Voice packs: cannot create "${tmpDir}" for the install lock (${made.code}); proceeding without`);

        return unlocked;
      }

      const file = lockFile(id);
      const started = Date.now();
      const deadline = started + VOICE_PACK_LOCK_MAX_WAIT_MS;

      for (;;) {
        const acquiredAt = Date.now();
        const created = await fs.createExclusive(file, lockText(acquiredAt));

        if (!created.ok) {
          logger.debug(`Voice packs: cannot create the install lock for "${id}" (${created.code}); proceeding without`);

          return unlocked;
        }

        if (created.created) {
          const waited = acquiredAt - started;

          if (waited > 0) {
            logger.info("Waited for another plugin's voice pack install");
            logger.debug(`Voice packs: "${id}" lock acquired after ${Math.round(waited / 1000)} s`);
          }

          // `unref` so a heartbeat can never be the thing keeping the process
          // alive: if the plugin is otherwise done, the lock goes stale instead.
          let released = false;
          // The write in flight, not just the timer. `clearInterval` stops the
          // NEXT beat; it does nothing about one already writing, and that one
          // can land after `remove` and recreate the lock with a fresh
          // `heartbeatAt` and no holder — which another plugin then reads as
          // live and waits VOICE_PACK_LOCK_STALE_MS for a process that has
          // already finished. An install beats every 15 s and runs for
          // minutes, so the overlap is reachable on a slow disk.
          let beating: Promise<unknown> = Promise.resolve();
          const heartbeat = setInterval(() => {
            if (released) return;

            beating = fs.writeTextFile(file, lockText(acquiredAt));
          }, VOICE_PACK_LOCK_HEARTBEAT_MS);
          heartbeat.unref?.();

          return {
            acquired: true,
            async release() {
              if (released) return;

              released = true;
              clearInterval(heartbeat);
              // Ordering is the whole point: the flag stops a future beat, and
              // this awaits the one that may already be writing, so `remove`
              // is the last write to touch the file.
              await beating.catch(() => undefined);

              const removed = await fs.remove(file);

              if (!removed.ok)
                logger.debug(`Voice packs: could not release the install lock for "${id}" (${removed.code})`);
            },
          };
        }

        if (!isLiveLock(await fs.readTextFile(file), Date.now())) {
          const removed = await fs.remove(file);

          if (!removed.ok) {
            logger.debug(
              `Voice packs: stale install lock for "${id}" cannot be removed (${removed.code}); proceeding without`,
            );

            return unlocked;
          }

          logger.debug(`Voice packs: took over a stale install lock for "${id}"`);
          // Deliberately NO `continue` here: a takeover falls through to the
          // deadline check and the poll sleep like every other retry. Two
          // plugins racing a freshly-truncated lock can each read the other's
          // as empty, remove it, and land back here — a retry that skipped the
          // sleep would spin with no delay, and one that skipped the deadline
          // would spin for as long as both processes lived, with the documented
          // "polls every VOICE_PACK_LOCK_POLL_MS, gives up after
          // VOICE_PACK_LOCK_MAX_WAIT_MS" true of every path but this one. The
          // sleep is what lets one of them win the create; the deadline is what
          // ends it if neither does. One poll's delay on an honest takeover is
          // nothing against the stale window it just waited out.
        }

        if (Date.now() >= deadline) {
          logger.warn(
            `Voice packs: another install of "${id}" has held the lock for ${Math.round(VOICE_PACK_LOCK_MAX_WAIT_MS / 60_000)} minutes; proceeding without it`,
          );

          return unlocked;
        }

        await sleep(VOICE_PACK_LOCK_POLL_MS);
      }
    },
  };
}

/**
 * `node:fs/promises` implementation of the storage port — the only place in
 * this module that touches the disk.
 *
 * Every method swallows its own error and reports the errno code. The full
 * message, with its absolute path, goes to the log at debug; the code is what
 * the choreography branches on (`ENOENT` on a rename is "no previous pack") and
 * what the caller may show, since it carries no path.
 */
export function createVoicePackStorageFileSystem(logger: ILogger): VoicePackStorageFileSystem {
  const failed = (op: string, path: string, err: unknown): { ok: false; code: string } => {
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
    logger.debug(`Voice packs: ${op} "${path}" failed: ${err instanceof Error ? err.message : String(err)}`);

    return { ok: false, code };
  };

  return {
    async makeDirectory(dir) {
      try {
        await mkdir(dir, { recursive: true });

        return { ok: true };
      } catch (err) {
        return failed("mkdir", dir, err);
      }
    },

    async listEntries(dir) {
      try {
        return await readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") failed("readdir", dir, err);

        return [];
      }
    },

    async exists(path) {
      try {
        await stat(path);

        return true;
      } catch {
        return false;
      }
    },

    async rename(from, to) {
      try {
        await rename(from, to);

        return { ok: true };
      } catch (err) {
        return failed("rename", from, err);
      }
    },

    async remove(path) {
      try {
        // No retries: a held file is reported, not waited on. Whoever holds it
        // is the audio engine or another plugin, and neither is going to let
        // go inside the retry window `rm` would offer.
        await rm(path, { recursive: true, force: true, maxRetries: 0 });

        return { ok: true };
      } catch (err) {
        return failed("remove", path, err);
      }
    },

    async readTextFile(file) {
      try {
        return await readFile(file, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") failed("read", file, err);

        return undefined;
      }
    },

    async writeTextFile(file, text) {
      try {
        await writeFile(file, text, "utf-8");

        return { ok: true };
      } catch (err) {
        return failed("write", file, err);
      }
    },

    async createExclusive(file, text) {
      try {
        await writeFile(file, text, { encoding: "utf-8", flag: "wx" });

        return { ok: true, created: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code === "EEXIST") return { ok: true, created: false };

        return failed("create", file, err);
      }
    },

    async openWrite(file) {
      let handle: FileHandle;

      try {
        handle = await open(file, "w");
      } catch (err) {
        return failed("open", file, err);
      }

      return {
        ok: true,
        handle: {
          async write(chunk) {
            // `write` may land fewer bytes than asked, so loop rather than
            // trust one call. A zero-byte write on a regular file is not a
            // retry case — it is the disk refusing — so it throws rather
            // than spinning.
            let offset = 0;

            while (offset < chunk.byteLength) {
              const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);

              if (bytesWritten === 0) throw new Error(`short write to "${file}"`);

              offset += bytesWritten;
            }
          },
          async close() {
            try {
              await handle.close();

              return { ok: true };
            } catch (err) {
              return failed("close", file, err);
            }
          },
        },
      };
    },
  };
}
