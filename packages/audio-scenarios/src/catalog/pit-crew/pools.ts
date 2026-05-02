/**
 * Pool definitions for the pit-crew scenario catalog.
 *
 * Each pool name maps to an ordered list of clip paths relative to the
 * `@iracedeck/audio-assets` package root. Pools are registered with the
 * scenario engine at catalog load time; scenarios then reference them as
 * `"pool:<name>"` and `{ pool: "<name>" }`.
 *
 * Rotation is shared — two scenarios that draw from the same pool share
 * its "last index" tracker, so back-to-back picks across scenarios are
 * avoided.
 */

export const POOLS: Readonly<Record<string, readonly string[]>> = {
  // Acknowledgments that open toggle callouts ("copy that", "got it", ...).
  // Voice-scoped via `{voice}` substitution — resolved at playback time from
  // the active Race Engineer voice setting.
  acknowledgment: [
    "voice/{voice}/acknowledgment/okay.mp3",
    "voice/{voice}/acknowledgment/got-it.mp3",
    "voice/{voice}/acknowledgment/roger-that.mp3",
    "voice/{voice}/acknowledgment/copy-that.mp3",
    "voice/{voice}/acknowledgment/we-got-that.mp3",
  ],

  // Pit-action acknowledgments — short "got it" style intros that play before
  // a pit-action callout ("...we'll change the front tires at the next pitstop").
  // Kept as a separate pool from `acknowledgment` (rather than reusing it) so the
  // two rotations advance independently — the user hears variety on a toggle
  // burst even if a `acknowledgment` clip just played for an unrelated cue.
  // The clip set is also a deliberate subset (no "okay" / "we got that") tuned
  // for the pit-service confirmation register.
  "pit-action-acknowledgment": [
    "voice/{voice}/pit-actions/got-it.mp3",
    "voice/{voice}/pit-actions/roger-that.mp3",
    "voice/{voice}/pit-actions/copy-that.mp3",
  ],

  // Pit-action callouts. One pool per action — single-clip today, named
  // `-NN` so future variants append cleanly (mirrors the flag pools).
  "pit-action-fuel-on": ["voice/{voice}/pit-actions/fuel-on-01.mp3"],
  "pit-action-fuel-off": ["voice/{voice}/pit-actions/fuel-off-01.mp3"],
  "pit-action-tires-off": ["voice/{voice}/pit-actions/tires-off-01.mp3"],

  // Flag callout pools. Every flag scenario draws from a pool — even the
  // single-clip flags — so adding a variant later becomes a one-line
  // append here instead of restructuring the scenario. Multi-element
  // pools rotate (no-repeat shared per-pool); single-element pools are
  // deterministic. All voice-scoped via `{voice}`.
  "flag-yellow-local": ["voice/{voice}/flags/yellow-local-01.mp3"],
  "flag-yellow-full": ["voice/{voice}/flags/yellow-full-01.mp3"],
  "flag-yellow-cleared": ["voice/{voice}/flags/yellow-cleared-01.mp3"],
  "flag-blue": [
    "voice/{voice}/flags/blue-01.mp3",
    "voice/{voice}/flags/blue-02.mp3",
  ],
  "flag-red": ["voice/{voice}/flags/red-01.mp3"],
  "flag-black": ["voice/{voice}/flags/black-01.mp3"],
  "flag-debris": [
    "voice/{voice}/flags/debris-01.mp3",
    "voice/{voice}/flags/debris-02.mp3",
    "voice/{voice}/flags/debris-03.mp3",
  ],
  "flag-meatball": ["voice/{voice}/flags/meatball-01.mp3"],
  // Green, white and checkered all branch on getSessionType() at fire time
  // so each session type gets its own pool. Future variants for any single
  // session type append to that pool only.
  "flag-green-practice": ["voice/{voice}/flags/green-practice-01.mp3"],
  "flag-green-qualifying": ["voice/{voice}/flags/green-qualifying-01.mp3"],
  "flag-green-race": [
    "voice/{voice}/flags/green-race-01.mp3",
    "voice/{voice}/flags/green-race-02.mp3",
  ],
  "flag-white-practice": ["voice/{voice}/flags/white-practice-01.mp3"],
  "flag-white-qualifying": ["voice/{voice}/flags/white-qualifying-01.mp3"],
  "flag-white-race": [
    "voice/{voice}/flags/white-race-01.mp3",
    "voice/{voice}/flags/white-race-02.mp3",
  ],
  "flag-checkered-practice": ["voice/{voice}/flags/checkered-practice-01.mp3"],
  "flag-checkered-qualifying": ["voice/{voice}/flags/checkered-qualifying-01.mp3"],
  "flag-checkered-race": ["voice/{voice}/flags/checkered-race-01.mp3"],
};
