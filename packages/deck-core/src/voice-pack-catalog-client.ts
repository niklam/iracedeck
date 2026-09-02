/**
 * Fetches the published voice-pack catalog (issue #1034, stage 2).
 *
 * The second feed built on the client/service split `changelog-feed-client.ts`
 * and `update-check-service.ts` established for the What's New pane. This
 * module is the fetch half — the only place that touches the network — and
 * `voice-pack-catalog-service.ts` is the layer above it that owns caching,
 * TTLs and turning entries into verdicts. `voice-pack-catalog.ts` owns the
 * document's shape and is imported rather than re-validated here.
 *
 * The URL is a module constant for the reason its sibling's is: the settings
 * window asks the plugin "what packs are available?", it never gets to say
 * where the plugin looks for the answer. Letting a request steer this URL
 * would turn a read-only status feed into a way to make the plugin's Node
 * process fetch an attacker-chosen address.
 *
 * Never throws. A refused connection, a timeout, an HTTP error, a body that is
 * not JSON, and a body of the wrong shape are all the same answer —
 * `{ status: "unknown" }`, "we do not know" — because every caller acts on all
 * of them identically: the Installed Voices card renders exactly the packs it
 * already knew about, same as if this feature did not exist.
 */
import { abortAfter } from "./abort-after.js";
import { parseVoicePackCatalog, type VoicePackCatalogEntry } from "./voice-pack-catalog.js";

/** The artifact the website build publishes (see packages/website/scripts). */
export const VOICE_PACK_CATALOG_URL = "https://iracedeck.com/voice-catalog.json";

/**
 * Request timeout. The same figure the changelog feed uses: generous enough
 * for a slow connection, short enough that a black-holed request cannot leave
 * a caller waiting on it — today that caller is the settings window's Race
 * Engineer card, which has installed packs to show with or without an answer.
 */
export const VOICE_PACK_CATALOG_FETCH_TIMEOUT_MS = 5000;

/**
 * What one fetch answered.
 *
 * `not-modified` is kept apart from `ok` rather than folded into it by
 * splicing in whatever entries the caller remembers: that splice is a
 * decision about TRUST — whether the entries a caller is holding are still the
 * ones the server's ETag was issued for — and this module has no memory across
 * calls to make that judgement with. It hands back exactly what the server
 * said (including that it never re-read the response body on a 304) and lets
 * `voice-pack-catalog-service.ts`, which is the one holding a cache, decide
 * what a 304 means when it has nothing cached to reuse.
 */
export type VoicePackCatalogFetchResult =
  | { status: "ok"; entries: VoicePackCatalogEntry[]; etag: string | undefined }
  | { status: "not-modified" }
  | { status: "unknown" };

/**
 * Fetch the voice-pack catalog, optionally conditioned on a previous ETag.
 *
 * Passing `etag` (the value returned alongside a prior `"ok"` result) sends it
 * as `If-None-Match`; a server that still has the same document answers with
 * an empty 304 rather than resending the whole catalog — the "anything new?"
 * check the spec calls out, at the cost of a few hundred bytes instead of the
 * full document. Omitting it makes an ordinary unconditional request.
 */
export async function fetchVoicePackCatalog(
  p: {
    url?: string;
    /** A previously returned ETag, to ask "anything new since then?". */
    etag?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<VoicePackCatalogFetchResult> {
  const { url = VOICE_PACK_CATALOG_URL, etag, fetchImpl = fetch, timeoutMs = VOICE_PACK_CATALOG_FETCH_TIMEOUT_MS } = p;

  try {
    const response = await fetchImpl(url, {
      signal: abortAfter(timeoutMs),
      cache: "no-store",
      headers: etag === undefined ? undefined : { "If-None-Match": etag },
    });

    // Checked before `response.ok`: a 304 is not in the 200–299 range `ok`
    // reports, and it carries no body worth (or safe) reading as JSON.
    if (response.status === 304) return { status: "not-modified" };

    if (!response.ok) return { status: "unknown" };

    const entries = parseVoicePackCatalog(await response.json());

    if (entries === undefined) return { status: "unknown" };

    return { status: "ok", entries, etag: response.headers.get("etag") ?? undefined };
  } catch {
    return { status: "unknown" };
  }
}
