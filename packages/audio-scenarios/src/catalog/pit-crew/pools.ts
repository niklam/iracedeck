/**
 * Pool registry for the pit-crew scenario catalog (issue #664).
 *
 * Pools are config-driven: a pool is *all clips sharing a base name*
 * (`voice/<voice>/<group>/<base>-NN.mp3`), derived per-voice from the
 * runtime audio-asset manifest. `POOL_REGISTRY` maps each logical pool name
 * to its `(group, base)` source — it carries **no clip lists and no
 * counts**. Adding or removing a variant (or an entire voice) is a
 * clip-file change in `@iracedeck/audio-assets`; this file only changes
 * when a *new callout* (a new base) is introduced.
 *
 * Registered with the scenario engine at catalog load time via
 * `engine.definePoolFromManifest(name, group, base)`; scenarios reference
 * pools as `"pool:<name>"` and `{ pool: "<name>" }` exactly as before.
 *
 * Selection is RANDOM — every pick is a uniform-random clip from the active
 * voice's members (`Math.random`), never a fixed order. The only constraint
 * is no immediate repeat: the same clip is never played twice in a row.
 * That "last index" tracker is shared per-pool (and reset when the active
 * voice changes, since variant counts differ across voices), so the
 * no-repeat guard holds even across two scenarios drawing from one pool.
 * Voices may carry different variant counts or omit a pool entirely — an
 * empty pool skips its step at fire time.
 */

/** Where a pool's members live in the manifest: `voice/<voice>/<group>/<base>-NN.mp3`. */
export type PoolSource = { group: string; base: string };

export const POOL_REGISTRY: Readonly<Record<string, PoolSource>> = {
  // Acknowledgments that open toggle callouts ("Copy that.", "Got it.", …) —
  // five variants under the `acknowledgment` base (#837 rename migration).
  acknowledgment: { group: "acknowledgment", base: "acknowledgment" },

  // Pit-action acknowledgments — short "got it" style intros that play before
  // a pit-action callout. Kept as a separate pool from `acknowledgment`
  // (rather than reusing it) so the two pools' no-repeat trackers stay
  // independent — the user hears variety on a toggle burst even if an
  // `acknowledgment` clip just played for an unrelated cue. The clip set is
  // also a deliberate subset (no "Okay." / "We got that.") tuned for the
  // pit-service confirmation register.
  "pit-action-acknowledgment": { group: "pit-actions", base: "acknowledgment" },

  // Pit-action callouts. One pool per action.
  "pit-action-fuel-on": { group: "pit-actions", base: "fuel-on" },
  "pit-action-fuel-off": { group: "pit-actions", base: "fuel-off" },
  "pit-action-tires-off": { group: "pit-actions", base: "tires-off" },

  // Flag callout pools. Every flag scenario draws from a pool — even the
  // single-clip flags. Green, white and checkered branch on getSessionType()
  // at fire time so each session type gets its own pool. Auto-picked by
  // `FLAG_POOL_NAMES` (the `flag-` prefix).
  "flag-yellow-local": { group: "flags", base: "yellow-local" },
  "flag-yellow-full": { group: "flags", base: "yellow-full" },
  "flag-yellow-cleared": { group: "flags", base: "yellow-cleared" },
  "flag-blue": { group: "flags", base: "blue" },
  "flag-red": { group: "flags", base: "red" },
  "flag-black": { group: "flags", base: "black" },
  "flag-debris": { group: "flags", base: "debris" },
  "flag-meatball": { group: "flags", base: "meatball" },
  "flag-green-practice": { group: "flags", base: "green-practice" },
  "flag-green-qualifying": { group: "flags", base: "green-qualifying" },
  "flag-green-race": { group: "flags", base: "green-race" },
  "flag-white-practice": { group: "flags", base: "white-practice" },
  "flag-white-qualifying": { group: "flags", base: "white-qualifying" },
  "flag-white-race": { group: "flags", base: "white-race" },
  // Stage 2 of the two-stage white (issue #772) — the player crosses S/F
  // under the white flag and starts THEIR last lap.
  "flag-white-last-lap": { group: "flags", base: "white-last-lap" },
  // Stage 3 — the leader's final lap (issue #936), same subject/opt-in.
  "flag-white-leader": { group: "flags", base: "white-leader" },
  "flag-checkered-practice": { group: "flags", base: "checkered-practice" },
  "flag-checkered-qualifying": { group: "flags", base: "checkered-qualifying" },
  "flag-checkered-race": { group: "flags", base: "checkered-race" },
  // Missing-session-flag callouts (issue #480): driver-black splits,
  // race-progression flags, and the caution-waving variants (#657).
  "flag-disqualify": { group: "flags", base: "disqualify" },
  "flag-furled": { group: "flags", base: "furled" },
  "flag-furled-cleared": { group: "flags", base: "furled-cleared" },
  "flag-dq-scoring-invalid": { group: "flags", base: "dq-scoring-invalid" },
  "flag-crossed": { group: "flags", base: "crossed" },
  "flag-one-pace-lap-to-go": { group: "flags", base: "one-pace-lap-to-go" },
  "flag-green-held": { group: "flags", base: "green-held" },
  "flag-ten-to-go": { group: "flags", base: "ten-to-go" },
  "flag-five-to-go": { group: "flags", base: "five-to-go" },
  "flag-yellow-waving": { group: "flags", base: "yellow-waving" },
  "flag-caution-waving": { group: "flags", base: "caution-waving" },

  // Start-light family pools (issues #480 / #673): two gantry lines plus
  // the four numeric countdown marks. Auto-picked by the `start-light-`
  // prefix (see `start-lights.ts` `START_LIGHT_POOL_NAMES`).
  "start-light-ready": { group: "start-lights", base: "start-ready" },
  "start-light-go": { group: "start-lights", base: "start-go" },
  "start-light-countdown-90": { group: "start-lights", base: "countdown-90" },
  "start-light-countdown-60": { group: "start-lights", base: "countdown-60" },
  "start-light-countdown-30": { group: "start-lights", base: "countdown-30" },
  "start-light-countdown-10": { group: "start-lights", base: "countdown-10" },

  // Rolling-start family pool (issue #660): the "pace car is moving" call
  // at the start of a rolling-start formation lap.
  "rolling-start-pace-car": { group: "rolling-start", base: "pace-car-moving" },

  // Pit-window callout pools (issue #655): pit road opened / closed for the
  // player.
  "pit-window-opened": { group: "pit-window", base: "opened" },
  "pit-window-closed": { group: "pit-window", base: "closed" },

  // Opponent-pit callout pools (issue #622): other drivers entering the pits.
  // `car-in` / `is-pitting` are the splice intro/tail around the shared
  // position-number clip ("The car in, P4, is pitting.").
  "opponent-pit-leader": { group: "opponent-pit", base: "leader" },
  "opponent-pit-ahead": { group: "opponent-pit", base: "ahead" },
  "opponent-pit-behind": { group: "opponent-pit", base: "behind" },
  "opponent-pit-car-in": { group: "opponent-pit", base: "car-in" },
  "opponent-pit-is-pitting": { group: "opponent-pit", base: "is-pitting" },
  "opponent-pit-others": { group: "opponent-pit", base: "others" },

  // Opponent-flag callout pools (issue #936): another car's penalty flag
  // matters to the player. `car-in` deliberately REUSES the opponent-pit
  // clip group above (the #568 clip-group-reuse precedent) — "the car in,
  // P4," reads identically whether the car is pitting or flagged, so no new
  // clip is recorded for it. `-ahead-tail` is the splice tail after the
  // shared position-number clip ("…, P4, has gone black."); `-behind` and
  // `-track` are single full-line pools (no number splice).
  "opponent-flag-car-in": { group: "opponent-pit", base: "car-in" },
  "opponent-flag-furled-ahead-tail": { group: "opponent-flags", base: "furled-ahead-tail" },
  "opponent-flag-black-ahead-tail": { group: "opponent-flags", base: "black-ahead-tail" },
  "opponent-flag-meatball-ahead-tail": { group: "opponent-flags", base: "meatball-ahead-tail" },
  "opponent-flag-disqualify-ahead-tail": { group: "opponent-flags", base: "disqualify-ahead-tail" },
  "opponent-flag-furled-behind": { group: "opponent-flags", base: "furled-behind" },
  "opponent-flag-black-behind": { group: "opponent-flags", base: "black-behind" },
  "opponent-flag-meatball-behind": { group: "opponent-flags", base: "meatball-behind" },
  "opponent-flag-disqualify-behind": { group: "opponent-flags", base: "disqualify-behind" },
  "opponent-flag-furled-track": { group: "opponent-flags", base: "furled-track" },
  "opponent-flag-black-track": { group: "opponent-flags", base: "black-track" },
  "opponent-flag-meatball-track": { group: "opponent-flags", base: "meatball-track" },
  "opponent-flag-disqualify-track": { group: "opponent-flags", base: "disqualify-track" },
  "opponent-flag-others": { group: "opponent-flags", base: "others" },

  // Laps-of-fuel-left callout pools (issue #838): one per spoken count
  // 10 → 1 plus the dedicated count-0 "box this lap for fuel" call, and the
  // enough-fuel reassurance (issue #880).
  "fuel-laps-left-race-covered": { group: "fuel", base: "race-covered" },
  "fuel-laps-left-10": { group: "fuel", base: "laps-left-10" },
  "fuel-laps-left-9": { group: "fuel", base: "laps-left-9" },
  "fuel-laps-left-8": { group: "fuel", base: "laps-left-8" },
  "fuel-laps-left-7": { group: "fuel", base: "laps-left-7" },
  "fuel-laps-left-6": { group: "fuel", base: "laps-left-6" },
  "fuel-laps-left-5": { group: "fuel", base: "laps-left-5" },
  "fuel-laps-left-4": { group: "fuel", base: "laps-left-4" },
  "fuel-laps-left-3": { group: "fuel", base: "laps-left-3" },
  "fuel-laps-left-2": { group: "fuel", base: "laps-left-2" },
  "fuel-laps-left-1": { group: "fuel", base: "laps-left-1" },
  "fuel-laps-left-box": { group: "fuel", base: "laps-left-box" },

  // Gap callout pools (issue #933): trend-flip lines per side/direction,
  // threshold alerts per side, and the "Gap is" intro for the number readout
  // (the number itself reuses the lap-time-second / lap-time-decimal groups).
  "gap-ahead-closing": { group: "gap", base: "ahead-closing" },
  "gap-ahead-opening": { group: "gap", base: "ahead-opening" },
  "gap-behind-closing": { group: "gap", base: "behind-closing" },
  "gap-behind-opening": { group: "gap", base: "behind-opening" },
  "gap-threshold-ahead": { group: "gap", base: "threshold-ahead" },
  "gap-threshold-behind": { group: "gap", base: "threshold-behind" },
  "gap-readout-intro": { group: "gap", base: "readout-intro" },

  // Damage callout pool (issue #489).
  "damage-repair-needed": { group: "damage", base: "repair-needed" },

  // Pit-service status callout pools (issue #479). One pool per non-`None`
  // PitSvStatus target. Closing transitions (`* → None`) are suppressed by
  // the sim translator, so there's no `pit-status-none` pool.
  "pit-status-in-progress": { group: "pit-status", base: "in-progress" },
  "pit-status-complete": { group: "pit-status", base: "complete" },
  "pit-status-too-far-left": { group: "pit-status", base: "too-far-left" },
  "pit-status-too-far-right": { group: "pit-status", base: "too-far-right" },
  "pit-status-too-far-forward": { group: "pit-status", base: "too-far-forward" },
  "pit-status-too-far-back": { group: "pit-status", base: "too-far-back" },
  "pit-status-bad-angle": { group: "pit-status", base: "bad-angle" },
  "pit-status-cant-fix-that": { group: "pit-status", base: "cant-fix-that" },

  // Positioning-error repeat nags (issue #951). Terse "you're STILL parked
  // wrong" lines the translator re-emits every ~2 s while the car sits
  // misaligned. Only the five positioning errors repeat — `in-progress` /
  // `complete` / `cant-fix-that` state a fact, not an uncorrected error.
  "pit-status-too-far-left-repeat": { group: "pit-status", base: "too-far-left-repeat" },
  "pit-status-too-far-right-repeat": { group: "pit-status", base: "too-far-right-repeat" },
  "pit-status-too-far-forward-repeat": { group: "pit-status", base: "too-far-forward-repeat" },
  "pit-status-too-far-back-repeat": { group: "pit-status", base: "too-far-back-repeat" },
  "pit-status-bad-angle-repeat": { group: "pit-status", base: "bad-angle-repeat" },

  // Incident callout pools (issue #530). One pool per IncidentType
  // discriminator — the type-flavored intro with no point count. The count
  // is a separate clause composed from the event's detected `delta` via the
  // dynamic value pools `pool:incidents/points-<n>` (issue #922; per-type
  // point weights are NOT fixed across iRacing content), so those need no
  // registry entries here.
  "incident-off-track": { group: "incidents", base: "off-track" },
  "incident-out-of-control": { group: "incidents", base: "out-of-control" },
  "incident-contact-world": { group: "incidents", base: "contact-world" },
  "incident-collision-world": { group: "incidents", base: "collision-world" },
  "incident-contact-car": { group: "incidents", base: "contact-car" },
  "incident-collision-car": { group: "incidents", base: "collision-car" },

  // Track-conditions callout pools (issue #526). One pool per
  // (direction, target-state) combination — six worsening + six drying.
  "track-conditions-worsening-mostly-dry": { group: "track-conditions", base: "worsening-mostly-dry" },
  "track-conditions-worsening-very-lightly-wet": { group: "track-conditions", base: "worsening-very-lightly-wet" },
  "track-conditions-worsening-lightly-wet": { group: "track-conditions", base: "worsening-lightly-wet" },
  "track-conditions-worsening-moderately-wet": { group: "track-conditions", base: "worsening-moderately-wet" },
  "track-conditions-worsening-very-wet": { group: "track-conditions", base: "worsening-very-wet" },
  "track-conditions-worsening-extremely-wet": { group: "track-conditions", base: "worsening-extremely-wet" },
  "track-conditions-drying-dry": { group: "track-conditions", base: "drying-dry" },
  "track-conditions-drying-mostly-dry": { group: "track-conditions", base: "drying-mostly-dry" },
  "track-conditions-drying-very-lightly-wet": { group: "track-conditions", base: "drying-very-lightly-wet" },
  "track-conditions-drying-lightly-wet": { group: "track-conditions", base: "drying-lightly-wet" },
  "track-conditions-drying-moderately-wet": { group: "track-conditions", base: "drying-moderately-wet" },
  "track-conditions-drying-very-wet": { group: "track-conditions", base: "drying-very-wet" },

  // Qualifying lap-invalidation pools (issue #567). The core "invalidated"
  // line always fires; the tail picks one of these branches based on the
  // snapshot's `lapsRemaining`:
  //   0      → qualifying-out-of-laps
  //   1..5   → qualifying-N-laps-left  (each clip carries its own unique
  //            motivational line, so the scenario is just a pool lookup)
  //   6+     → qualifying-plenty-of-laps
  // Time-limited qualifying is gated upstream (no `lapLimited` snapshot field
  // → tail skipped, core line only).
  "qualifying-invalidated": { group: "qualifying-invalidation", base: "invalidated" },
  "qualifying-out-of-laps": { group: "qualifying-invalidation", base: "out-of-laps" },
  "qualifying-plenty-of-laps": { group: "qualifying-invalidation", base: "plenty-of-laps" },
  "qualifying-1-lap-left": { group: "qualifying-invalidation", base: "1-lap-left" },
  "qualifying-2-laps-left": { group: "qualifying-invalidation", base: "2-laps-left" },
  "qualifying-3-laps-left": { group: "qualifying-invalidation", base: "3-laps-left" },
  "qualifying-4-laps-left": { group: "qualifying-invalidation", base: "4-laps-left" },
  "qualifying-5-laps-left": { group: "qualifying-invalidation", base: "5-laps-left" },

  // Pit-box count-in pools (issue #600). One pool per distance mark. Terse
  // delivery — no radio frame around the countdown (see `pit-box.ts`).
  "pit-box-five": { group: "pit-box", base: "five" },
  "pit-box-four": { group: "pit-box", base: "four" },
  "pit-box-three": { group: "pit-box", base: "three" },
  "pit-box-two": { group: "pit-box", base: "two" },
  "pit-box-one": { group: "pit-box", base: "one" },
  "pit-box-pit-now": { group: "pit-box", base: "pit-now" },

  // Pit-limiter family pools (issue #1051) — cars that HAVE a limiter. Every
  // base is two-digit-suffixed per the manifest matcher
  // (`<base>(?:-\d{2})?.mp3`); the three-digit names these clips shipped with
  // matched nothing and built empty pools.
  "pit-limiter-on-track": { group: "pit-limiter", base: "on-track" },
  "pit-limiter-missing": { group: "pit-limiter", base: "missing" },
  "pit-limiter-dropped": { group: "pit-limiter", base: "dropped" },
  "pit-limiter-speeding": { group: "pit-limiter", base: "speeding" },

  // No-limiter family pools (issue #1051) — cars that have NO limiter, so no
  // line here may mention one. Deliberately REUSES the `pit-limiter` clip
  // group (the #568 clip-group-reuse precedent, as `opponent-flag-car-in`
  // does over `opponent-pit`): the pool name carries the audience, not the
  // directory. Distinct BASES are what let the two families split the two
  // speeding lines — a pool is every clip sharing a base, so one base could
  // not have served both.
  "no-limiter-speeding": { group: "pit-limiter", base: "no-limiter-speeding" },
  "no-limiter-entry": { group: "pit-limiter", base: "entry" },
};

/**
 * Register every catalog pool with the engine — all pools derive their
 * members from the manifest per voice (the last enumerated remainder, the
 * two acknowledgment pools, moved into the registry with the #837 rename
 * migration).
 */
export function registerPools(engine: {
  definePoolFromManifest(name: string, group: string, base: string): void;
}): void {
  for (const [name, { group, base }] of Object.entries(POOL_REGISTRY)) {
    engine.definePoolFromManifest(name, group, base);
  }
}
