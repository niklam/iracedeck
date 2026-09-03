/**
 * The plugin's voice-pack catalog check (issue #1034, stage 2).
 *
 * Composes the pure pieces around the one network call exactly the way
 * `update-check-service.ts` composes the changelog feed: read a live gate,
 * fetch the catalog at most once per TTL, and hand back a status the caller
 * renders directly. This module produces the `catalog` half of
 * `VOICE_PACK_STATUS_KEY`'s payload — see `voice-pack-status.ts` — never the
 * whole thing; the `installs` half comes from the (separately owned) install
 * pipeline, and whatever composes them into one `_voicePackStatus` write is a
 * caller of `get()`, not a concern of this module.
 *
 * Same three properties its sibling keeps, restated for a feed of packs rather
 * than a feed of releases, plus one of its own:
 *
 * - **The gate is read live, on every call.** Not captured at construction, so
 *   switching the setting off stops outbound requests immediately, with no
 *   restart — and the caller never gets to force a request past it.
 * - **It cannot fail loudly.** Every path returns a `VoicePackCatalogState`;
 *   nothing throws, nothing rejects. A machine that cannot reach iracedeck.com
 *   sees the same "unknown" state a machine with this feature disabled would.
 * - **The comparison against what is installed is redone on every call, never
 *   cached.** The cache holds the fetched ENTRIES, not the derived offers, so
 *   installing or removing a pack while the window is open changes its
 *   verdict on the very next `get()` — the network round trip is the
 *   expensive part; comparing a hash is not, and re-running it costs nothing.
 *   The same goes for the voices the plugin bundles: an entry the plugin
 *   already provides is never offered, and that is decided per call from the
 *   injected list rather than baked into the cache.
 * - **A failed re-check never costs the entries a successful one delivered.**
 *   The last catalog the server actually gave us stays cached, with its ETag,
 *   through any number of failures after it; a failure only shortens the wait
 *   before the next attempt. One dropped packet while the window is open used
 *   to replace a good list with "could not check" for five minutes — and the
 *   installer re-asks the catalog after every install, so the reward for
 *   installing a pack over flaky Wi-Fi was watching the list vanish.
 */
import type { ILogger } from "@iracedeck/logger";

import { resolveVoicePackCatalogUrl } from "./voice-pack-catalog-base.js";
import { fetchVoicePackCatalog } from "./voice-pack-catalog-client.js";
import { isVoicePackOfferable, type VoicePackCatalogEntry } from "./voice-pack-catalog.js";
import type { VoicePackCatalogState, VoicePackOffer, VoicePackOfferVerdict } from "./voice-pack-status.js";

/** How long a successful fetch is reused before asking again (conditionally). */
export const VOICE_PACK_CATALOG_SUCCESS_TTL_MS = 60 * 60 * 1000;

/**
 * How long a FAILED fetch is reused. Much shorter than the success TTL, for
 * the same reason `update-check-service.ts` gives its own: the likely cause is
 * a machine that was briefly offline, and reopening the settings window a
 * minute later should not mean waiting an hour to see the catalog again.
 */
export const VOICE_PACK_CATALOG_FAILURE_TTL_MS = 5 * 60 * 1000;

export interface VoicePackCatalogServiceDeps {
  /**
   * Whatever setting gates this feature talking to iracedeck.com, read live —
   * an injected predicate rather than a direct read of the global-settings
   * singleton, so this module stays testable with no settings machinery at
   * all and agnostic about which setting key ends up owning the gate.
   */
  isEnabled: () => boolean;
  /** The running plugin version (`getPluginVersion()`), for `isVoicePackOfferable`. */
  getPluginVersion: () => string;
  /**
   * The archive hash the installed copy of `packId` was verified against, or
   * `undefined` when the pack is not installed. Backed by `.install.json` (see
   * `voice-pack-provenance.ts`), but this module never reads a filesystem
   * itself — the lookup is injected so a test can be a plain object and the
   * plugin can wire in whatever the scan already produced, with no second copy
   * of "what does 'installed' mean" living here.
   */
  getInstalledSha: (packId: string) => string | undefined;
  /**
   * The voice ids the plugin itself ships inside its distributable —
   * `scanRaceEngineerVoices` over the compiled-in manifest, the same list the
   * scanner reserves. A catalog entry whose voices are ALL in here is not
   * something to install: plugin-root-first resolution means the bundle
   * provides every one of those clips whatever is in the packs folder, and
   * the scanner drops a downloaded copy of a bundled voice as a broken pack.
   * Offering it would sell the user an 8 MB download whose only result is an
   * error row. Injected rather than read from any manifest here, and never a
   * hard-coded id: the release that stops bundling audio passes an empty list
   * and this rule goes inert on its own, with no edit to make.
   */
  bundledVoices: readonly string[];
  /** Override the artifact URL. Tests only; never taken from a request. */
  url?: string;
  /**
   * The raw `_devBaseUrl` value from the plugin's settings file, if any (#1100).
   *
   * Read fresh on every fetch rather than captured once, and INJECTED rather
   * than read from the settings singleton here — which keeps this module
   * testable with no settings machinery and agnostic about where the value
   * lives. Validated by `resolveVoicePackCatalogUrl`; an unusable value falls
   * back to the published URL with a warning rather than failing the fetch.
   */
  getDevBaseUrl?: () => string | undefined;
  /** Injected `fetch`, so tests never touch the network. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  successTtlMs?: number;
  failureTtlMs?: number;
  logger: ILogger;
}

export interface VoicePackCatalogGetOptions {
  /**
   * Ask the server now, whatever the cache's age. The cached ETag still goes
   * with the request, so an unchanged catalog costs a 304 and no body.
   *
   * For the one caller that is a person pressing a button. The failure TTL
   * exists so a machine that was briefly offline does not keep asking a server
   * that is not answering — and a user who has just fixed their Wi-Fi and
   * pressed Rescan is the opposite case. Refusing THEM for five minutes made
   * the button do nothing exactly when it was reached for. Everything the
   * plugin asks on its own — opening the window, the refresh after an install
   * — still respects both TTLs.
   */
  bypassTtl?: boolean;
}

export interface VoicePackCatalogService {
  /** The current catalog state. Never rejects. */
  get(options?: VoicePackCatalogGetOptions): Promise<VoicePackCatalogState>;
  /**
   * The full catalog entry for `packId` — including the `url` and `sha256` an
   * install needs — or `undefined` when the catalog does not list it or could
   * not be read. Never rejects.
   *
   * Separate from `get()` because an offer deliberately carries neither: a
   * `VoicePackOffer` is what a page renders, and a page has no business holding
   * a download URL. The installer asks here instead, and asks the SAME cache
   * `get()` answered from, so the entry a user pressed Install on and the entry
   * that is fetched are one document. An installer keeping its own copy could
   * download a version the button never offered.
   */
  entry(packId: string): Promise<VoicePackCatalogEntry | undefined>;
}

/** The last catalog the server actually delivered, and when — see `checkedAt`. */
type CachedCatalog = {
  readonly entries: VoicePackCatalogEntry[];
  readonly etag: string | undefined;
  readonly at: number;
};

export function createVoicePackCatalogService(deps: VoicePackCatalogServiceDeps): VoicePackCatalogService {
  const {
    isEnabled,
    getPluginVersion,
    getInstalledSha,
    bundledVoices,
    url,
    getDevBaseUrl,
    fetchImpl,
    now = () => Date.now(),
    successTtlMs = VOICE_PACK_CATALOG_SUCCESS_TTL_MS,
    failureTtlMs = VOICE_PACK_CATALOG_FAILURE_TTL_MS,
    logger,
  } = deps;

  // Two records, deliberately not one. `good` is what the server last gave
  // us and is only ever REPLACED by a newer answer — a failure does not touch
  // it. `lastAttempt` is what decides when to ask again, and a failure moves
  // only that. Folding them into one record is exactly what let a failed
  // re-check overwrite a good catalog with `undefined`.
  let good: CachedCatalog | undefined;
  let lastAttempt: { at: number; ok: boolean } | undefined;
  // One request at a time: two panes asking at once, or a reopened window
  // racing itself, must not become two outbound requests. Cleared in `finally`
  // on EVERY outcome — left set by a throw it would pin one failed promise
  // there forever, and every later call would re-await that same failure with
  // nothing short of a plugin restart able to clear it.
  let inFlight: Promise<CachedCatalog | undefined> | undefined;

  function isFresh(attempt: { at: number; ok: boolean }): boolean {
    return now() - attempt.at < (attempt.ok ? successTtlMs : failureTtlMs);
  }

  /** A failed attempt: only the retry clock moves; whatever was good stays good. */
  function failed(): CachedCatalog | undefined {
    lastAttempt = { at: now(), ok: false };

    return good;
  }

  async function fetchCatalog(bypassTtl: boolean): Promise<CachedCatalog | undefined> {
    if (!bypassTtl && lastAttempt !== undefined && isFresh(lastAttempt)) return good;

    if (inFlight === undefined) {
      const attempt = (async () => {
        try {
          // The ETag vouches for `good.entries`, which a failure since then has
          // not touched — so it is offered whenever there is a good catalog
          // behind it, and only then. With nothing cached there is no document
          // for the server to confirm.
          // A test-supplied `url` still wins; otherwise the override is consulted,
          // and with nothing set it resolves to the published URL unchanged.
          const effectiveUrl = url ?? resolveVoicePackCatalogUrl({ base: getDevBaseUrl?.(), logger });
          const result = await fetchVoicePackCatalog({ url: effectiveUrl, fetchImpl, etag: good?.etag });

          if (result.status === "ok") {
            good = { entries: result.entries, etag: result.etag, at: now() };
            lastAttempt = { at: good.at, ok: true };
            logger.debug(`Voice pack catalog fetched ${result.entries.length} packs`);

            return good;
          }

          if (result.status === "not-modified") {
            // A 304 answers "the document behind the ETag you sent is
            // unchanged" — but this branch only runs when THIS process sent one
            // (see the guard above), and that only happens with a good catalog
            // cached. If `good` is somehow still undefined here, the 304 is
            // validating an ETag this run never actually offered — a stale
            // value surviving past a cache eviction, a caching proxy guessing,
            // or a bug — and there is no document behind it this call can
            // serve. Reporting `state: "ok"` in that situation would be
            // presenting entries this call never received, so it is treated as
            // a failure instead: honest, and self-correcting on the next
            // unconditional fetch a plain failure schedules.
            if (good === undefined) {
              logger.warn("Voice pack catalog: server answered 304 with nothing cached to reuse");

              return failed();
            }

            // The whole point of the ETag round trip: keep the entries exactly
            // as they were and only refresh the timestamp, with no re-parse and
            // no second validation of a body that was never sent.
            good = { entries: good.entries, etag: good.etag, at: now() };
            lastAttempt = { at: good.at, ok: true };

            return good;
          }

          logger.info(
            good === undefined
              ? "Voice pack catalog could not be reached"
              : "Voice pack catalog could not be reached; keeping the last one fetched",
          );

          return failed();
        } catch {
          // fetchVoicePackCatalog is written not to throw; if it ever does,
          // that is a failed check like any other, cached as one.
          return failed();
        }
      })();

      // Cleared through `.finally` on the ASSIGNED promise, never in a
      // `finally` inside the async function itself. An async IIFE runs
      // synchronously up to its first `await`, so a delegate that throws
      // synchronously — `getDevBaseUrl` reading a settings singleton, say —
      // reaches the inner `catch` and its `finally` BEFORE `inFlight` has been
      // assigned at all. The clear then ran against the old value and the
      // assignment immediately put the settled promise back, stranding it for
      // the life of the process: exactly the failure the clear exists to
      // prevent, reintroduced by evaluation order. A `.finally` callback is
      // always a microtask, so it cannot run before the assignment below.
      //
      // The identity check keeps a slow attempt from clearing a newer one that
      // replaced it.
      const tracked: Promise<CachedCatalog | undefined> = attempt.finally(() => {
        if (inFlight === tracked) inFlight = undefined;
      });

      inFlight = tracked;
    }

    return inFlight;
  }

  return {
    async get(options): Promise<VoicePackCatalogState> {
      try {
        if (!isEnabled()) return { state: "unknown" };

        const catalog = await fetchCatalog(options?.bypassTtl === true);

        if (catalog === undefined) return { state: "unknown" };

        const pluginVersion = getPluginVersion();
        const packs: VoicePackOffer[] = catalog.entries.map((entry) =>
          buildOffer(entry, pluginVersion, getInstalledSha, bundledVoices),
        );

        return {
          state: "ok",
          packs,
          // When the answer CAME FROM, not when it was asked for — a status
          // served from a cache 40 minutes into its TTL is 40 minutes old, and
          // this field exists to say exactly that (refreshed on a 304 too,
          // since that response is itself a fresh confirmation). A failed
          // re-check does not move it either: the entries are still the ones
          // the last successful fetch returned, so that is how old they are,
          // and stamping them with the failure's time would present a stale
          // list as a fresh one.
          checkedAt: catalog.at,
        };
      } catch (error: unknown) {
        // A throwing delegate (the gate, the version lookup, an installed-hash
        // lookup) must not turn into a rejected call the settings window would
        // have to handle.
        logger.warn("Voice pack catalog check failed");
        logger.debug(String(error));

        return { state: "unknown" };
      }
    },

    async entry(packId: string): Promise<VoicePackCatalogEntry | undefined> {
      try {
        // Gated like `get()`. If the user has turned this feature's network
        // access off, an install must not become the one path that still talks
        // to the site.
        if (!isEnabled()) return undefined;

        return (await fetchCatalog(false))?.entries.find((candidate) => candidate.id === packId);
      } catch (error: unknown) {
        logger.warn("Voice pack catalog lookup failed");
        logger.debug(String(error));

        return undefined;
      }
    },
  };
}

/**
 * Does the plugin's own bundle already provide every voice this entry offers?
 *
 * ALL of them, not any: a pack shipping two voices of which one is bundled
 * still contributes the other (the scanner drops the colliding voice from the
 * pack rather than rejecting the pack), so installing it gets the user
 * something. Guarded on a non-empty list as well, even though the schema
 * requires one voice — `every` over an empty array is vacuously true, and a
 * relaxed schema must not silently turn "offers nothing" into "already
 * provided".
 */
function isProvidedByBundle(entry: VoicePackCatalogEntry, bundledVoices: readonly string[]): boolean {
  return entry.voices.length > 0 && entry.voices.every((voice) => bundledVoices.includes(voice.id));
}

/**
 * Turn one catalog entry into the verdict the UI renders a button from.
 *
 * Computed once, here, rather than by each surface that would otherwise
 * repeat the same hash comparison — see `voice-pack-status.ts` for why two
 * independent copies of this logic is a bug waiting for the settings window
 * and the warning banner to disagree about the same pack.
 */
function buildOffer(
  entry: VoicePackCatalogEntry,
  pluginVersion: string,
  getInstalledSha: (packId: string) => string | undefined,
  bundledVoices: readonly string[],
): VoicePackOffer {
  const base = {
    id: entry.id,
    label: entry.label,
    version: entry.version,
    description: entry.description,
    bytes: entry.bytes,
  };

  // A pack the plugin itself provides is decided first, ahead of everything
  // the catalog says about its archive, because none of that can change the
  // fact: the voice is on this machine and plays, whatever the entry's hash
  // or version floor. It reads as `installed` — "Installed", no button —
  // which is the one verdict that is TRUE from where the user sits: the voice
  // is available and there is nothing to press. `install` or `update` would
  // start a download the scanner then reports as a broken pack; `unsupported`
  // would say a newer plugin is needed for a voice this one already plays;
  // and a verdict of its own would need every renderer to learn it first — a
  // page that does not know a verdict drops the row, and the catalog would
  // appear to have forgotten the pack. In the release that still bundles
  // `default` and publishes it too, this is what keeps the catalog row and
  // the plugin telling the same story; once nothing is bundled the injected
  // list is empty and no entry ever takes this branch.
  if (isProvidedByBundle(entry, bundledVoices)) return { ...base, verdict: "installed" };

  // Unsupported is decided next and wins outright: a pack that needs a newer
  // plugin is shown as unsupported even where a hash comparison alone would
  // have called it an update, because "update" would tell the user pressing
  // the button will work.
  if (!isVoicePackOfferable(entry, pluginVersion)) {
    return { ...base, verdict: "unsupported", minPluginVersion: entry.minPluginVersion };
  }

  const installedSha = getInstalledSha(entry.id);
  let verdict: VoicePackOfferVerdict;

  if (installedSha === undefined) {
    verdict = "install";
  } else if (installedSha === entry.sha256) {
    verdict = "installed";
  } else {
    verdict = "update";
  }

  return { ...base, verdict };
}
