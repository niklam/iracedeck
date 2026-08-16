/**
 * Plugin-owned global-settings store (issue #993).
 *
 * The plugin — not the deck host — owns plugin-global settings, in one JSON
 * file per ecosystem under the user's local app data. The host store is
 * read once (migration) and otherwise unused; see the design doc
 * docs/superpowers/specs/2026-08-16-issue-993-plugin-owned-settings-store-design.md.
 */
import type { ILogger } from "@iracedeck/logger";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
        await rename(path, aside);

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
  };
}
