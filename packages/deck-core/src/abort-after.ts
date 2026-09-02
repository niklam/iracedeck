/**
 * A one-shot deadline for an outbound request (issues #1016, #1100).
 *
 * Extracted when the voice-pack catalog became the second feed in this package
 * to need it. Two identical copies of a fallback that only executes on runtimes
 * we do not test is the worst kind of duplication: the branch that would prove
 * the copies had diverged is the branch that never runs here.
 *
 * Note the browser-side sibling in `@iracedeck/pi-components` stays separate on
 * purpose. That one ships inside a Property Inspector's bundle and this one runs
 * in the plugin's Node process; sharing them would mean the PI bundle importing
 * from deck-core, which it deliberately never does.
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
