/**
 * The camera catalog's file and its in-memory copy (#1653): `cameras.json`
 * beside the settings file, loaded once at startup, saved when an
 * observation or a removal changes it.
 *
 * The file goes through `@iracedeck/settings`' `createFileSettingsStore`,
 * unchanged, for its write discipline: atomic temp-and-rename, a debounced
 * save, retried failed writes, the synchronous exit flush and a tolerated
 * byte-order mark. Around it this service adds what is the catalog's own:
 *
 * - **Missing file** — an empty catalog, saved on its first change.
 * - **Unparseable file** — the store moves it aside as
 *   `cameras.corrupt-<iso>.json` and calls `onRejected` (the
 *   `camera-catalog-rejected` banner); the catalog starts empty and is saved.
 * - **Unreadable file** (any read error but a missing file) — retried on the
 *   settings load's back-off (`LOAD_ATTEMPTS` reads, the first retry after
 *   `LOAD_RETRY_DELAY_MS`, doubling), then the catalog runs **in memory only**
 *   for the run and is never saved: writing over a file we failed to read
 *   would destroy it (the settings store's fail-closed rule).
 * - **A file this build does not understand** (another `version`, or a
 *   top-level shape that is not version 1's) — memory only as well, and the
 *   file is kept as it is. This deliberately differs from the spec's "treated
 *   as unparseable": moving it aside would leave a newer build, after a
 *   downgrade and an upgrade back, with an empty catalog and its own file
 *   renamed; keeping it means the newer build finds it again.
 *
 * Observations that arrive before the load finishes are kept (the latest per
 * track) and recorded once it has, so a session that was running at startup
 * is not lost.
 */
import type { ILogger } from "@iracedeck/logger";
import {
  createFileSettingsStore,
  LOAD_ATTEMPTS,
  LOAD_RETRY_DELAY_MS,
  type SettingsFileRejection,
  type SettingsStore,
} from "@iracedeck/settings";
import { dirname, join } from "node:path";

import {
  type CameraCatalog,
  type CameraGroupObservation,
  emptyCameraCatalog,
  parseCameraCatalog,
  recordCameraGroups,
  removeCameraGroup,
} from "./camera-catalog.js";

/** The catalog's file name, in the settings file's folder. */
export const CAMERA_CATALOG_FILE_NAME = "cameras.json";

/**
 * `cameras.json` in the folder of the settings file at `settingsPath` — the
 * path `resolveSettingsStorePath()` gives, so the per-ecosystem folder and the
 * `IRACEDECK_SETTINGS_PATH` override move it too (same folder, fixed name).
 */
export function resolveCameraCatalogPath(settingsPath: string): string {
  return join(dirname(settingsPath), CAMERA_CATALOG_FILE_NAME);
}

/**
 * Where the catalog stands with its file:
 * - `loading` — before the load has finished; observations are queued.
 * - `file` — loaded (or the file was missing or set aside); changes are saved.
 * - `memory-only` — the file could not be read or is not one this build
 *   understands; changes live in memory for the run and the file is never written.
 */
export type CameraCatalogPersistence = "loading" | "file" | "memory-only";

export interface CameraCatalogService {
  /** The catalog file's path. */
  readonly path: string;
  /**
   * Load the file. Idempotent: every call returns the one load's promise.
   * Never rejects; every failure is logged and decides the persistence.
   * Listeners are notified once it has finished, whatever the outcome.
   */
  start(): Promise<void>;
  /** Whether the load has finished. */
  isLoaded(): boolean;
  persistence(): CameraCatalogPersistence;
  /** The current catalog: empty until the load has finished. Never mutated; a change replaces it. */
  getCatalog(): CameraCatalog;
  /**
   * Record one observation (see `recordCameraGroups`). Before the load has
   * finished it is queued, the latest per track, and false is returned.
   * Returns whether the catalog changed; a change is saved (unless memory
   * only) and notified.
   */
  observe(observation: CameraGroupObservation): boolean;
  /**
   * Remove a remembered group by its exact (canonical) name — the settings
   * window's Remove button. False, changing nothing, before the load has
   * finished or for a name the catalog does not hold. A removal is saved
   * (unless memory only) and notified.
   */
  remove(name: string): boolean;
  /**
   * Call `listener` after every change: the load finishing (once), an
   * observation that changed the catalog, a removal. Never on subscription.
   * A listener's throw is logged and does not stop the others. Returns the
   * unsubscribe.
   */
  subscribe(listener: () => void): () => void;
  /** Write a pending save now (tests, and an orderly shutdown that can await). */
  flush(): Promise<void>;
  /** Write a pending save synchronously, for `process.on("exit")`. */
  flushSync(): void;
}

export interface CameraCatalogServiceOptions {
  /** `cameras.json`; see {@link resolveCameraCatalogPath}. */
  path: string;
  logger: ILogger;
  /** Raised when the store sets an unparseable file aside; the plugin passes the banner reporter. */
  onRejected?: (rejection: SettingsFileRejection) => void;
  /** Test hook: the store to use instead of a file store at `path` (then `onRejected` is the store's business). */
  store?: SettingsStore;
  /** Test hook; production debounces saves by the store's default. */
  debounceMs?: number;
  /** Test hook; production uses `LOAD_ATTEMPTS`. */
  loadAttempts?: number;
  /** Test hook; production uses `LOAD_RETRY_DELAY_MS` (doubling per retry). */
  loadRetryDelayMs?: number;
  /** Test hook: the clock observations are stamped with. */
  now?: () => Date;
}

const UNREADABLE = Symbol("unreadable");

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCameraCatalogService(options: CameraCatalogServiceOptions): CameraCatalogService {
  const { path, logger } = options;
  const now = options.now ?? (() => new Date());
  const attempts = Math.max(1, options.loadAttempts ?? LOAD_ATTEMPTS);
  const retryDelayMs = options.loadRetryDelayMs ?? LOAD_RETRY_DELAY_MS;
  const store =
    options.store ??
    createFileSettingsStore({
      path,
      logger,
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
      ...(options.onRejected === undefined ? {} : { onRejected: options.onRejected }),
    });
  const listeners = new Set<() => void>();
  /** Observations made before the load finished: the latest per track key, with the time it was made. */
  const queued = new Map<number, { observation: CameraGroupObservation; at: Date }>();
  let catalog = emptyCameraCatalog();
  let state: CameraCatalogPersistence = "loading";
  let loading: Promise<void> | undefined;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error: unknown) {
        logger.error("A camera catalog listener failed");
        logger.debug(
          `Camera catalog listener error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }
    }
  };

  /** Replace the catalog and save it unless memory only. */
  const commit = (next: CameraCatalog): void => {
    catalog = next;

    if (state === "file") store.save(next as unknown as Record<string, unknown>);
  };

  async function readWithRetries(): Promise<Record<string, unknown> | undefined | typeof UNREADABLE> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await store.load();
      } catch (error: unknown) {
        if (attempt >= attempts) {
          logger.error(
            "The camera catalog file could not be read; remembered camera groups are kept in memory for this run and the file is left untouched",
          );
          logger.debug(`Last read of ${path} failed: ${describeError(error)}`);

          return UNREADABLE;
        }

        const delayMs = retryDelayMs * 2 ** (attempt - 1);

        logger.warn("The camera catalog file could not be read; trying again");
        logger.debug(
          `Read attempt ${attempt}/${attempts} of ${path} failed: ${describeError(error)}; next try in ${delayMs} ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  async function load(): Promise<void> {
    let loaded = emptyCameraCatalog();
    let persistence: CameraCatalogPersistence = "file";

    try {
      const raw = await readWithRetries();

      if (raw === UNREADABLE) {
        persistence = "memory-only";
      } else if (raw === undefined) {
        logger.debug(`No camera catalog at ${path} (or it was set aside); starting an empty one`);
      } else {
        const parsed = parseCameraCatalog(raw);

        if (parsed.kind === "ok") {
          loaded = parsed.catalog;

          if (parsed.dropped > 0)
            logger.warn(`The camera catalog had ${parsed.dropped} malformed entries; they were left out`);

          logger.debug(
            `Camera catalog loaded from ${path}: ${Object.keys(loaded.tracks).length} tracks, ${Object.keys(loaded.groups).length} groups`,
          );
        } else {
          persistence = "memory-only";
          logger.warn(
            "The camera catalog file is not one this version understands; it is kept as it is, and camera groups seen in this run are not saved",
          );
          logger.debug(`Unusable camera catalog ${path}: ${parsed.reason}`);
        }
      }
    } catch (error: unknown) {
      // readWithRetries catches every read error; this is a defect elsewhere
      // (a parse that threw). Fail closed like an unreadable file.
      persistence = "memory-only";
      logger.error("The camera catalog could not be loaded; camera groups seen in this run are not saved");
      logger.debug(`Camera catalog load error: ${describeError(error)}`);
    }

    state = persistence;
    catalog = loaded;

    let changed = false;

    for (const { observation, at } of queued.values()) {
      const update = recordCameraGroups(catalog, observation, at);

      if (update.changed) {
        catalog = update.catalog;
        changed = true;
      }
    }

    queued.clear();

    if (changed && state === "file") store.save(catalog as unknown as Record<string, unknown>);

    notify();
  }

  return {
    path,

    start() {
      loading ??= load();

      return loading;
    },

    isLoaded: () => state !== "loading",

    persistence: () => state,

    getCatalog: () => catalog,

    observe(observation) {
      if (state === "loading") {
        queued.set(observation.trackId, { observation, at: now() });

        return false;
      }

      const update = recordCameraGroups(catalog, observation, now());

      if (!update.changed) return false;

      commit(update.catalog);
      notify();

      return true;
    },

    remove(name) {
      if (state === "loading" || typeof name !== "string") return false;

      const update = removeCameraGroup(catalog, name);

      if (!update.changed) return false;

      commit(update.catalog);
      logger.info("Removed a remembered camera group");
      logger.debug(`Removed camera group: ${name}`);
      notify();

      return true;
    },

    subscribe(listener) {
      const entry = (): void => listener();

      listeners.add(entry);

      return () => {
        listeners.delete(entry);
      };
    },

    flush: () => store.flush(),

    flushSync: () => store.flushSync(),
  };
}
