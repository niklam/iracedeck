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
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  const override = env.IRACEDECK_SETTINGS_PATH;

  if (override && override.trim().length > 0) return override;

  const base = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? ".", "AppData", "Local");

  return join(base, "iRaceDeck", "Settings", settingsStoreFolderName(platform), "global-settings.json");
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
}

const DEFAULT_DEBOUNCE_MS = 250;

/**
 * File-backed store: JSON, pretty-printed, ATOMIC (temp + rename) so a reader
 * never sees a partial file, DEBOUNCED so slider drags and key-binding
 * recording don't hammer the disk. A malformed file is moved aside as
 * `global-settings.corrupt-<iso>.json` and reported as "no file" — a user's
 * file is never silently discarded.
 */
export function createFileSettingsStore(opts: FileSettingsStoreOptions): SettingsStore {
  const { path, logger } = opts;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let pending: Record<string, unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  async function writeNow(settings: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;

    await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    await rename(tmp, path);
    logger.debug(`Settings saved: ${path}`);
  }

  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);

    timer = setTimeout(() => {
      timer = undefined;
      const toWrite = pending;

      pending = undefined;

      if (toWrite === undefined) return;

      inFlight = inFlight
        .then(() => writeNow(toWrite))
        .catch((error: unknown) => {
          logger.error(`Settings save failed: ${String(error)}`);
        });
    }, debounceMs);
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
      schedule();
    },

    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }

      const toWrite = pending;

      pending = undefined;

      if (toWrite !== undefined) {
        inFlight = inFlight
          .then(() => writeNow(toWrite))
          .catch((error: unknown) => {
            logger.error(`Settings save failed: ${String(error)}`);
          });
      }

      await inFlight;
    },

    flushSync() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }

      const toWrite = pending;

      pending = undefined;

      if (toWrite === undefined) return;

      // Same atomic shape as writeNow(), synchronously: a shutdown must not be
      // the one write that can leave a half-written settings file behind. An
      // already-in-flight async write is left alone (it cannot be awaited
      // here): its rename landing after ours would win with an older payload,
      // but the only caller is process.on("exit"), where the async chain never
      // gets another turn — so in practice this sync write is the last one.
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.sync.tmp`;

        writeFileSync(tmp, JSON.stringify(toWrite, null, 2) + "\n", "utf-8");
        renameSync(tmp, path);
        logger.debug(`Settings flushed on shutdown: ${path}`);
      } catch (error: unknown) {
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
