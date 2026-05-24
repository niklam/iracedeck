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

  // Damage callout pool (issue #489). Single pool today; multi-clip rotation
  // works the same way as the flag pools above.
  "damage-repair-needed": [
    "voice/{voice}/damage/repair-needed-01.mp3",
    "voice/{voice}/damage/repair-needed-02.mp3",
    "voice/{voice}/damage/repair-needed-03.mp3",
  ],

  // Pit-service status callout pools (issue #479). One pool per non-`None`
  // PitSvStatus target. Single-clip today; future variants append cleanly
  // here without scenario changes. Closing transitions (`* → None`) are
  // suppressed by the sim translator, so there's no `pit-status-none` pool.
  "pit-status-in-progress": ["voice/{voice}/pit-status/in-progress-01.mp3"],
  "pit-status-complete": ["voice/{voice}/pit-status/complete-01.mp3"],
  "pit-status-too-far-left": ["voice/{voice}/pit-status/too-far-left-01.mp3"],
  "pit-status-too-far-right": ["voice/{voice}/pit-status/too-far-right-01.mp3"],
  "pit-status-too-far-forward": ["voice/{voice}/pit-status/too-far-forward-01.mp3"],
  "pit-status-too-far-back": ["voice/{voice}/pit-status/too-far-back-01.mp3"],
  "pit-status-bad-angle": ["voice/{voice}/pit-status/bad-angle-01.mp3"],
  "pit-status-cant-fix-that": ["voice/{voice}/pit-status/cant-fix-that-01.mp3"],

  // Incident callout pools (issue #530). One pool per IncidentType
  // discriminator. Three alternating lines per pool — the first two are
  // calm coaching (off-track / out-of-control / contact = no penalty),
  // the third adds variety. Collision lines mention the deterministic
  // penalty point count inline (CollisionWithWorld is always 2x,
  // CollisionWithCar is always 4x per iRacing's `irsdk_IncidentFlags`
  // enum), so no separate penalty follow-on pool is needed.
  "incident-off-track": [
    "voice/{voice}/incidents/off-track-01.mp3",
    "voice/{voice}/incidents/off-track-02.mp3",
    "voice/{voice}/incidents/off-track-03.mp3",
  ],
  "incident-out-of-control": [
    "voice/{voice}/incidents/out-of-control-01.mp3",
    "voice/{voice}/incidents/out-of-control-02.mp3",
    "voice/{voice}/incidents/out-of-control-03.mp3",
  ],
  "incident-contact-world": [
    "voice/{voice}/incidents/contact-world-01.mp3",
    "voice/{voice}/incidents/contact-world-02.mp3",
    "voice/{voice}/incidents/contact-world-03.mp3",
  ],
  "incident-collision-world": [
    "voice/{voice}/incidents/collision-world-01.mp3",
    "voice/{voice}/incidents/collision-world-02.mp3",
    "voice/{voice}/incidents/collision-world-03.mp3",
  ],
  "incident-contact-car": [
    "voice/{voice}/incidents/contact-car-01.mp3",
    "voice/{voice}/incidents/contact-car-02.mp3",
    "voice/{voice}/incidents/contact-car-03.mp3",
  ],
  "incident-collision-car": [
    "voice/{voice}/incidents/collision-car-01.mp3",
    "voice/{voice}/incidents/collision-car-02.mp3",
    "voice/{voice}/incidents/collision-car-03.mp3",
  ],

  // Track-conditions callout pools (issue #526). One pool per
  // (direction, target-state) combination — six worsening + six drying.
  // Single-clip today; future variants append cleanly here.
  "track-conditions-worsening-mostly-dry": ["voice/{voice}/track-conditions/worsening-mostly-dry-01.mp3"],
  "track-conditions-worsening-very-lightly-wet": ["voice/{voice}/track-conditions/worsening-very-lightly-wet-01.mp3"],
  "track-conditions-worsening-lightly-wet": ["voice/{voice}/track-conditions/worsening-lightly-wet-01.mp3"],
  "track-conditions-worsening-moderately-wet": ["voice/{voice}/track-conditions/worsening-moderately-wet-01.mp3"],
  "track-conditions-worsening-very-wet": ["voice/{voice}/track-conditions/worsening-very-wet-01.mp3"],
  "track-conditions-worsening-extremely-wet": ["voice/{voice}/track-conditions/worsening-extremely-wet-01.mp3"],
  "track-conditions-drying-dry": ["voice/{voice}/track-conditions/drying-dry-01.mp3"],
  "track-conditions-drying-mostly-dry": ["voice/{voice}/track-conditions/drying-mostly-dry-01.mp3"],
  "track-conditions-drying-very-lightly-wet": ["voice/{voice}/track-conditions/drying-very-lightly-wet-01.mp3"],
  "track-conditions-drying-lightly-wet": ["voice/{voice}/track-conditions/drying-lightly-wet-01.mp3"],
  "track-conditions-drying-moderately-wet": ["voice/{voice}/track-conditions/drying-moderately-wet-01.mp3"],
  "track-conditions-drying-very-wet": ["voice/{voice}/track-conditions/drying-very-wet-01.mp3"],

  // Qualifying lap-invalidation pools (issue #567). The core "invalidated"
  // line always fires; the tail picks one of these branches based on the
  // snapshot's `lapsRemaining`:
  //   0      → qualifying-out-of-laps
  //   1..5   → qualifying-N-laps-left  (each clip carries its own unique
  //            motivational line, so the scenario is just a pool lookup)
  //   6+     → qualifying-plenty-of-laps
  // Time-limited qualifying is gated upstream (no `lapLimited` snapshot field
  // → tail skipped, core line only).
  "qualifying-invalidated": ["voice/{voice}/qualifying-invalidation/invalidated-01.mp3"],
  "qualifying-out-of-laps": ["voice/{voice}/qualifying-invalidation/out-of-laps-01.mp3"],
  "qualifying-plenty-of-laps": ["voice/{voice}/qualifying-invalidation/plenty-of-laps-01.mp3"],
  "qualifying-1-lap-left": ["voice/{voice}/qualifying-invalidation/1-lap-left-01.mp3"],
  "qualifying-2-laps-left": ["voice/{voice}/qualifying-invalidation/2-laps-left-01.mp3"],
  "qualifying-3-laps-left": ["voice/{voice}/qualifying-invalidation/3-laps-left-01.mp3"],
  "qualifying-4-laps-left": ["voice/{voice}/qualifying-invalidation/4-laps-left-01.mp3"],
  "qualifying-5-laps-left": ["voice/{voice}/qualifying-invalidation/5-laps-left-01.mp3"],

  // Pit-box count-in pools (issue #600). One pool per distance mark; single-clip
  // today, named `-NN` so future variants append cleanly. Terse delivery — no
  // radio frame around the countdown (see `pit-box.ts`).
  "pit-box-five": ["voice/{voice}/pit-box/five-01.mp3"],
  "pit-box-four": ["voice/{voice}/pit-box/four-01.mp3"],
  "pit-box-three": ["voice/{voice}/pit-box/three-01.mp3"],
  "pit-box-two": ["voice/{voice}/pit-box/two-01.mp3"],
  "pit-box-one": ["voice/{voice}/pit-box/one-01.mp3"],
  "pit-box-pit-now": ["voice/{voice}/pit-box/pit-now-01.mp3"],
};
