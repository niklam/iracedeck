/**
 * Fetches the published changelog artifact (issue #1016).
 *
 * The one place the plugin talks to iracedeck.com for the update check, and
 * the only module in this feature that does I/O at all — everything either
 * side of it is pure, which is what makes the rest of it testable without a
 * network. The URL is a constant here, never taken from the settings window or
 * any request: the page asks the plugin for a verdict, it does not get to say
 * where the plugin looks.
 *
 * Never throws. A refused connection, a timeout, an HTTP error, a body that is
 * not JSON and a body of the wrong shape are all the same answer — `undefined`,
 * "we do not know" — because the caller treats every one of them identically:
 * the tab is exactly what it is offline.
 */
import { parsePublishedChangelog, type PublishedRelease } from "./published-changelog.js";

/** The artifact the website build publishes (see packages/website/scripts). */
export const PUBLISHED_CHANGELOG_URL = "https://iracedeck.com/changelog.json";

/**
 * Request timeout. Generous enough for a slow connection, short enough that a
 * black-holed request cannot leave the window's What's New tab waiting on it —
 * the page renders its built-in notes immediately either way.
 */
export const CHANGELOG_FETCH_TIMEOUT_MS = 5000;

/** An abort signal that fires after `ms`, or undefined where unsupported. */
function abortAfter(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }

  return undefined;
}

/**
 * Fetch and parse the published changelog. Returns the releases, or
 * `undefined` when anything at all went wrong.
 */
export async function fetchPublishedChangelog(
  p: {
    url?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<PublishedRelease[] | undefined> {
  const { url = PUBLISHED_CHANGELOG_URL, fetchImpl = fetch, timeoutMs = CHANGELOG_FETCH_TIMEOUT_MS } = p;

  try {
    const response = await fetchImpl(url, { signal: abortAfter(timeoutMs), cache: "no-store" });

    if (!response.ok) return undefined;

    return parsePublishedChangelog(await response.json());
  } catch {
    return undefined;
  }
}
