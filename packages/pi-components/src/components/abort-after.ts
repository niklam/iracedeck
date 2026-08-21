/// <reference lib="dom" />
/**
 * A deadline for a Property Inspector / settings-window fetch.
 *
 * Every request these components make is answered by something that can stall —
 * SimHub's REST API, or the plugin's own loopback endpoints, one of which
 * (`/updates/status`) is itself waiting on the network. A fetch with no deadline
 * leaves its promise pending for the lifetime of the page, so both callers take
 * one from here rather than each keeping a copy of this ladder.
 */

/**
 * An abort signal that fires after `ms`. Prefers `AbortSignal.timeout` (the
 * Stream Deck PI WebView supports it — ird-key-binding already relies on it),
 * with an `AbortController` + `setTimeout` fallback for any older embedded
 * WebView that lacks it. Returns undefined when neither exists (the request
 * simply runs without a client-side timeout rather than failing).
 */
export function abortAfter(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }

  if (typeof AbortController !== "undefined") {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);

    return controller.signal;
  }

  return undefined;
}
