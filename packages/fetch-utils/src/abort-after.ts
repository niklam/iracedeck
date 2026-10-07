/**
 * A one-shot deadline for an outbound request (issues #1016, #1100).
 *
 * Extracted from deck-core when the voice-pack catalog became the second feed
 * to need it, and moved here (#1364) so both runtimes can import it.
 * Two identical copies of a fallback that only executes on runtimes
 * we do not test is the worst kind of duplication: the branch that would prove
 * the copies had diverged is the branch that never runs here.
 *
 * This package serves both runtimes: the plugin's Node process (deck-core's feed
 * clients) and a Property Inspector's browser bundle. It therefore uses only
 * globals both share, which its tsconfig enforces (see CLAUDE.md).
 *
 * NOT for the voice-pack download. That needs a deadline it can re-arm on every
 * chunk, to tell a slow connection from a dead one, and an `AbortSignal.timeout`
 * is a single fixed instant that cannot be re-armed — see the comment in
 * `voice-pack-download.ts`.
 */

/** An abort signal that fires after `ms`, or undefined where unsupported. */
export function abortAfter(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }

  // Without this fallback a runtime lacking `AbortSignal.timeout` would run the
  // request with NO deadline at all — the one thing the timeout above exists to
  // prevent, and the one that would leave a caller's status endpoint never
  // answering.
  if (typeof AbortController !== "undefined") {
    const controller = new AbortController();

    setTimeout(() => controller.abort(), ms);

    return controller.signal;
  }

  return undefined;
}
