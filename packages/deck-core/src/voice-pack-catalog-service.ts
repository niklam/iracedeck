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
 * than a feed of releases:
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
 */
import type { ILogger } from "@iracedeck/logger";

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
  /** Override the artifact URL. Tests only; never taken from a request. */
  url?: string;
  /** Injected `fetch`, so tests never touch the network. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  successTtlMs?: number;
  failureTtlMs?: number;
  logger: ILogger;
}

export interface VoicePackCatalogService {
  /** The current catalog state. Never rejects. */
  get(): Promise<VoicePackCatalogState>;
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

export function createVoicePackCatalogService(deps: VoicePackCatalogServiceDeps): VoicePackCatalogService {
  const {
    isEnabled,
    getPluginVersion,
    getInstalledSha,
    url,
    fetchImpl,
    now = () => Date.now(),
    successTtlMs = VOICE_PACK_CATALOG_SUCCESS_TTL_MS,
    failureTtlMs = VOICE_PACK_CATALOG_FAILURE_TTL_MS,
    logger,
  } = deps;

  let cached: { entries: VoicePackCatalogEntry[] | undefined; etag: string | undefined; at: number } | undefined;
  // One request at a time: two panes asking at once, or a reopened window
  // racing itself, must not become two outbound requests. Cleared in `finally`
  // on EVERY outcome — left set by a throw it would pin one failed promise
  // there forever, and every later call would re-await that same failure with
  // nothing short of a plugin restart able to clear it.
  let inFlight: Promise<VoicePackCatalogEntry[] | undefined> | undefined;

  function isFresh(entry: { entries: VoicePackCatalogEntry[] | undefined; at: number }): boolean {
    const ttl = entry.entries === undefined ? failureTtlMs : successTtlMs;

    return now() - entry.at < ttl;
  }

  async function fetchEntries(): Promise<VoicePackCatalogEntry[] | undefined> {
    if (cached !== undefined && isFresh(cached)) return cached.entries;

    inFlight ??= (async () => {
      try {
        // Only offer an ETag when there is cached content behind it to vouch
        // for. Sending one alongside `entries: undefined` — a previous fetch
        // failed outright — would ask the server to validate a document this
        // process has already decided not to trust.
        const etag = cached?.entries === undefined ? undefined : cached.etag;
        const result = await fetchVoicePackCatalog({ url, fetchImpl, etag });

        if (result.status === "ok") {
          cached = { entries: result.entries, etag: result.etag, at: now() };
          logger.debug(`Voice pack catalog fetched ${result.entries.length} packs`);

          return result.entries;
        }

        if (result.status === "not-modified") {
          // A 304 answers "the document behind the ETag you sent is
          // unchanged" — but this branch only runs when THIS process sent one
          // (see the guard above), and that only happens with entries already
          // cached. If `cached.entries` is somehow still undefined here, the
          // 304 is validating an ETag this run never actually offered — a
          // stale value surviving past a cache eviction, a caching proxy
          // guessing, or a bug — and there is no document behind it this call
          // can serve. Reporting `state: "ok"` in that situation would be
          // presenting entries this call never received, so it is treated as
          // a failure instead: honest, and self-correcting on the next
          // unconditional fetch a plain failure schedules.
          if (cached?.entries === undefined) {
            logger.warn("Voice pack catalog: server answered 304 with nothing cached to reuse");
            cached = { entries: undefined, etag: undefined, at: now() };

            return undefined;
          }

          // The whole point of the ETag round trip: keep the entries exactly
          // as they were and only refresh the timestamp, with no re-parse and
          // no second validation of a body that was never sent.
          cached = { entries: cached.entries, etag: cached.etag, at: now() };

          return cached.entries;
        }

        logger.info("Voice pack catalog could not be reached");
        cached = { entries: undefined, etag: undefined, at: now() };

        return undefined;
      } catch {
        // fetchVoicePackCatalog is written not to throw; if it ever does, that
        // is a failed check like any other, cached as one.
        cached = { entries: undefined, etag: undefined, at: now() };

        return undefined;
      } finally {
        inFlight = undefined;
      }
    })();

    return inFlight;
  }

  return {
    async get(): Promise<VoicePackCatalogState> {
      try {
        if (!isEnabled()) return { state: "unknown" };

        const entries = await fetchEntries();

        if (entries === undefined) return { state: "unknown" };

        const pluginVersion = getPluginVersion();
        const packs: VoicePackOffer[] = entries.map((entry) => buildOffer(entry, pluginVersion, getInstalledSha));

        return {
          state: "ok",
          packs,
          // When the answer CAME FROM, not when it was asked for — a status
          // served from a cache 40 minutes into its TTL is 40 minutes old, and
          // this field exists to say exactly that (refreshed on a 304 too,
          // since that response is itself a fresh confirmation).
          checkedAt: cached?.at ?? now(),
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

        return (await fetchEntries())?.find((candidate) => candidate.id === packId);
      } catch (error: unknown) {
        logger.warn("Voice pack catalog lookup failed");
        logger.debug(String(error));

        return undefined;
      }
    },
  };
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
): VoicePackOffer {
  const base = {
    id: entry.id,
    label: entry.label,
    version: entry.version,
    description: entry.description,
    bytes: entry.bytes,
  };

  // Unsupported is decided first and wins outright: a pack that needs a newer
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
