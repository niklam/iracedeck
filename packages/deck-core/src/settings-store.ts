/**
 * Plugin-owned global-settings store (issue #993).
 *
 * The plugin — not the deck host — owns plugin-global settings, in one JSON
 * file per ecosystem under the user's local app data. The host store is
 * read once (migration) and otherwise unused; see the design doc
 * docs/superpowers/specs/2026-08-16-issue-993-plugin-owned-settings-store-design.md.
 *
 * Writes are debounced, so a shutdown can strand the last one: every plugin
 * registers `process.on("exit", () => store.flushSync())` to land it. Only the
 * synchronous variant works there — `exit` handlers get no event-loop turn, so
 * the async `flush()` would never run.
 */
import type { ILogger } from "@iracedeck/logger";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const FOLDER_NAMES: Record<string, string> = {
  "stream-deck": "Stream Deck",
  mirabox: "Mirabox",
  ulanzi: "Ulanzi",
};

/** Human-readable per-ecosystem folder; unknown ids pass through so ecosystems never share a file. */
export function settingsStoreFolderName(platform: string): string {
  return FOLDER_NAMES[platform] ?? platform;
}

export interface ResolveSettingsStorePathOptions {
  /** `getPluginPlatform()` — "stream-deck" | "mirabox" | "ulanzi". */
  platform: string;
  env: Record<string, string | undefined>;
}

/**
 * `%LOCALAPPDATA%\iRaceDeck\Settings\<ecosystem>\global-settings.json`, or the
 * full path in `IRACEDECK_SETTINGS_PATH` (development / fresh-install testing).
 */
export function resolveSettingsStorePath({ platform, env }: ResolveSettingsStorePathOptions): string {
  const override = nonBlank(env.IRACEDECK_SETTINGS_PATH);

  if (override !== undefined) return override;

  // A set-but-blank variable must count as unset, same as the override above:
  // `join("", "iRaceDeck", …)` would be a RELATIVE path resolved against the
  // deck host's working directory (Program Files, the plugin bundle, …).
  const base = nonBlank(env.LOCALAPPDATA) ?? join(nonBlank(env.USERPROFILE) ?? ".", "AppData", "Local");

  return join(base, "iRaceDeck", "Settings", settingsStoreFolderName(platform), "global-settings.json");
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

export interface SettingsStore {
  readonly path: string;
  load(): Promise<Record<string, unknown> | undefined>;
  save(settings: Record<string, unknown>): void;
  flush(): Promise<void>;
  /**
   * Write any debounced save immediately and SYNCHRONOUSLY. For shutdown paths
   * that cannot await — `process.on("exit")` runs handlers synchronously, and
   * the Mirabox/Ulanzi clients terminate via `process.exit(0)` on socket close
   * — where the async `flush()` would never get its turn on the event loop.
   */
  flushSync(): void;
}

export interface FileSettingsStoreOptions {
  path: string;
  logger: ILogger;
  /** Trailing debounce for save(); default 250 ms. */
  debounceMs?: number;
  /** Retry schedule after a failed write; default {@link WRITE_RETRY_DELAYS_MS} (test hook). */
  writeRetryDelaysMs?: readonly number[];
}

const DEFAULT_DEBOUNCE_MS = 250;

/**
 * A failed write (Windows EPERM/EBUSY on the rename while an AV scanner,
 * backup agent or indexer holds the file) is retried on this schedule, then
 * the payload stays PENDING — a later save() supersedes it and the shutdown
 * flushSync() still gets one last try — so a transient lock never silently
 * loses the newest settings.
 */
export const WRITE_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * File-backed store: JSON, pretty-printed, ATOMIC (temp + rename) so a reader
 * never sees a partial file, DEBOUNCED so slider drags and key-binding
 * recording don't hammer the disk, and RETRIED on failure (a transient
 * Windows file lock must not lose the newest change — see
 * {@link WRITE_RETRY_DELAYS_MS}). A malformed file is moved aside as
 * `global-settings.corrupt-<iso>.json` and reported as "no file" — a user's
 * file is never silently discarded; a UTF-8 BOM is tolerated.
 */
export function createFileSettingsStore(opts: FileSettingsStoreOptions): SettingsStore {
  const { path, logger } = opts;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const retryDelaysMs = opts.writeRetryDelaysMs ?? WRITE_RETRY_DELAYS_MS;
  /** Debounced: saved but not yet handed to a write. */
  let pending: Record<string, unknown> | undefined;
  /**
   * Handed to an async write that has not yet landed on disk. Tracked so
   * flushSync() at shutdown can land it synchronously — process.exit() abandons
   * in-flight libuv work, so an async rename still awaiting its turn would be
   * lost — and so a failed write can be re-queued instead of dropped.
   */
  let inFlightPayload: Record<string, unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let retryAttempt = 0;

  const serialize = (settings: Record<string, unknown>): string => JSON.stringify(settings, null, 2) + "\n";

  async function writeNow(settings: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;

    try {
      await writeFile(tmp, serialize(settings), "utf-8");
      await rename(tmp, path);
    } catch (error: unknown) {
      // Never leave a half-written temp file behind for the user to find.
      await unlink(tmp).catch(() => undefined);
      throw error;
    }

    logger.debug(`Settings saved: ${path}`);
  }

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  /** Take the debounced payload (clearing its timer); undefined when nothing is pending. */
  const takePending = (): Record<string, unknown> | undefined => {
    clearTimer();
    const toWrite = pending;

    pending = undefined;

    return toWrite;
  };

  const scheduleIn = (delayMs: number): void => {
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      const toWrite = pending;

      pending = undefined;

      if (toWrite !== undefined) enqueue(toWrite);
    }, delayMs);
  };

  function enqueue(toWrite: Record<string, unknown>): void {
    inFlightPayload = toWrite;
    inFlight = inFlight
      .then(() => writeNow(toWrite))
      .then(
        () => {
          if (inFlightPayload === toWrite) inFlightPayload = undefined;

          retryAttempt = 0;
        },
        (error: unknown) => {
          logger.error(`Settings save failed: ${String(error)}`);

          if (inFlightPayload === toWrite) inFlightPayload = undefined;

          // Keep the payload unless a newer save has already superseded it —
          // debounced in `pending`, or enqueued behind this one (then
          // `inFlightPayload` is that newer payload, not ours): re-queuing the
          // older snapshot would let its retry overwrite the newer write. Kept,
          // it goes back to `pending`, where a later save() replaces it, the
          // shutdown flushSync() lands it, and the retry timer below re-tries.
          if (pending !== undefined || inFlightPayload !== undefined) return;

          pending = toWrite;
          const delay = retryDelaysMs[retryAttempt];

          if (delay === undefined) {
            logger.error(
              "Settings save keeps failing; the last change is kept in memory and retried on the next save or at shutdown",
            );

            return;
          }

          retryAttempt++;
          logger.debug(`Retrying the settings save in ${delay} ms (attempt ${retryAttempt})`);
          scheduleIn(delay);
        },
      );
  }

  return {
    path,

    async load() {
      let text: string;

      try {
        text = await readFile(path, "utf-8");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;

        throw error;
      }

      // Node keeps a UTF-8 byte-order mark in the decoded string and JSON.parse
      // rejects it — and PowerShell 5.1's Set-Content/Out-File and several
      // editors write one. A BOM must not make a user's backup "corrupt".
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

      try {
        const parsed: unknown = JSON.parse(text);

        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");

        return parsed as Record<string, unknown>;
      } catch (error: unknown) {
        const aside = path.replace(/\.json$/, "") + `.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

        logger.error("Settings file is not valid JSON; moving it aside and starting fresh");
        logger.debug(`Corrupt settings file ${path} → ${aside}: ${String(error)}`);

        try {
          await rename(path, aside);
        } catch (renameError: unknown) {
          try {
            await copyFile(path, aside);
            logger.error("Settings file could not be moved; preserving as copy instead");
            logger.debug(`Copy fallback: ${String(renameError)}`);
          } catch (copyError: unknown) {
            logger.error("Settings file could not be preserved — moving on with fresh defaults");
            logger.debug(`Copy also failed: ${String(copyError)}`);
          }
        }

        return undefined;
      }
    },

    save(settings) {
      pending = settings;
      // A fresh save resets any failure back-off: it is a new payload.
      retryAttempt = 0;
      scheduleIn(debounceMs);
    },

    async flush() {
      const toWrite = takePending();

      if (toWrite !== undefined) enqueue(toWrite);

      await inFlight;
    },

    flushSync() {
      // The newest payload wins: a still-debounced save supersedes an
      // in-flight one; with nothing debounced, an async write that has not
      // confirmed yet is re-done synchronously — process.exit() would
      // otherwise abandon its rename mid-way and lose it.
      const toWrite = takePending() ?? inFlightPayload;

      if (toWrite === undefined) return;

      // Same atomic shape as writeNow(), synchronously: a shutdown must not be
      // the one write that can leave a half-written settings file behind. The
      // only caller is process.on("exit"), where the async chain never gets
      // another turn — so this sync write is the last one; an in-flight
      // async rename either already landed (then this rewrites the same
      // bytes) or never will.
      const tmp = `${path}.${process.pid}.sync.tmp`;

      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tmp, serialize(toWrite), "utf-8");
        renameSync(tmp, path);
        logger.debug(`Settings flushed on shutdown: ${path}`);
      } catch (error: unknown) {
        try {
          unlinkSync(tmp);
        } catch {
          // best effort — the temp file may never have been created
        }

        logger.error(`Settings shutdown flush failed: ${String(error)}`);
      }
    },
  };
}

/** Test / harness store: no disk. `saved` records every save() payload in order. */
export function createMemorySettingsStore(
  initial?: Record<string, unknown>,
): SettingsStore & { readonly saved: Array<Record<string, unknown>> } {
  const saved: Array<Record<string, unknown>> = [];

  return {
    path: "<memory>",
    saved,
    load: async () => (initial === undefined ? undefined : { ...initial }),
    save: (settings) => {
      saved.push({ ...settings });
    },
    flush: async () => {},
    // save() records immediately, so there is never anything pending to land.
    flushSync: () => {},
  };
}
