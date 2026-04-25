/**
 * Pool definitions for the pit-crew scenario catalog.
 *
 * Each pool name maps to an ordered list of clip paths relative to the
 * `@iracedeck/audio-assets` package root. Pools are registered with the
 * scenario engine at catalog load time; scenarios then reference them as
 * `"pool:<name>"` and `{ pool: "<name>" }`.
 *
 * Rotation is shared — two scenarios that both draw from `greeting` share
 * the same "last index" tracker, so repeats are avoided across scenarios
 * (design doc §7.1).
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

  // Walkie-talkie "uh, yeah, copy that" style fragments inserted between voice
  // clips in multi-message sequences. The special `{ connector: true }` step
  // draws from this pool.
  connector: [
    "pit-crew/connector/IRD-connector-addition.mp3",
    "pit-crew/connector/IRD-connector-also.mp3",
    "pit-crew/connector/IRD-connector-and.mp3",
    "pit-crew/connector/IRD-connector-as-well-as.mp3",
    "pit-crew/connector/IRD-connector-plus.mp3",
  ],

  // Spoken word-greetings ("alright", "hi", "right then", "so") used by the
  // welcome flow. The folder name `radio-openers` is legacy — these are
  // word-greetings, not walkie-talkie PTT ticks (see audio-assets layout §5).
  greeting: [
    "pit-crew/greeting/IRD-radio-opener-alright.mp3",
    "pit-crew/greeting/IRD-radio-opener-hi.mp3",
    "pit-crew/greeting/IRD-radio-opener-right-then.mp3",
    "pit-crew/greeting/IRD-radio-opener-so.mp3",
  ],

  // Pit approach callouts ("you're approaching the pits"). Picked randomly,
  // no-repeat back-to-back.
  "pit-approach": [
    "pit-crew/pitlane/IRD-pit-approach.mp3",
    "pit-crew/pitlane/IRD-pit-approach-2.mp3",
  ],

  // Pit exit callouts ("you're out").
  "pit-exit": [
    "pit-crew/pitlane/IRD-pit-exit.mp3",
    "pit-crew/pitlane/IRD-pit-exit-2.mp3",
    "pit-crew/pitlane/IRD-pit-exit-3.mp3",
    "pit-crew/pitlane/IRD-pit-exit-4.mp3",
    "pit-crew/pitlane/IRD-pit-exit-5.mp3",
    "pit-crew/pitlane/IRD-pit-exit-6.mp3",
  ],

  // Stall-departure callouts ("remember to disengage the pit limiter").
  "stall-departure": [
    "pit-crew/pitlane/IRD-pit-stall-departure.mp3",
    "pit-crew/pitlane/IRD-pit-stall-departure-2.mp3",
    "pit-crew/pitlane/IRD-pit-stall-departure-3.mp3",
    "pit-crew/pitlane/IRD-pit-stall-departure-4.mp3",
  ],

  // Fuel low-5-laps pool ("fuel's going to be tight — five laps to go").
  "fuel-low-5laps": [
    "pit-crew/fuel/low-5laps/IRD-fuel-low-5laps-01.mp3",
    "pit-crew/fuel/low-5laps/IRD-fuel-low-5laps-02.mp3",
    "pit-crew/fuel/low-5laps/IRD-fuel-low-5laps-03.mp3",
  ],

  // Fuel low-3-laps pool.
  "fuel-low-3laps": [
    "pit-crew/fuel/low-3laps/IRD-fuel-low-3laps-01.mp3",
    "pit-crew/fuel/low-3laps/IRD-fuel-low-3laps-02.mp3",
    "pit-crew/fuel/low-3laps/IRD-fuel-low-3laps-03.mp3",
  ],

  // Fuel critical pool ("we're down to the last lap").
  "fuel-critical": [
    "pit-crew/fuel/critical/IRD-fuel-critical-01.mp3",
    "pit-crew/fuel/critical/IRD-fuel-critical-02.mp3",
    "pit-crew/fuel/critical/IRD-fuel-critical-03.mp3",
  ],

  // Fuel empty pool ("we're on fumes").
  "fuel-empty": [
    "pit-crew/fuel/empty/IRD-fuel-empty-01.mp3",
    "pit-crew/fuel/empty/IRD-fuel-empty-02.mp3",
    "pit-crew/fuel/empty/IRD-fuel-empty-03.mp3",
  ],

  // Pit limiter on-track warning — fires when the limiter is engaged while
  // NOT in pit lane. Dedicated warning clips, distinct from the "dropped"
  // set (those fire when the limiter disengages mid-pit-lane).
  "pit-limiter-on-track": [
    "pit-crew/toggle/IRD-toggle-limiter-on-warning-1.mp3",
    "pit-crew/toggle/IRD-toggle-limiter-on-warning-2.mp3",
    "pit-crew/toggle/IRD-toggle-limiter-on-warning-3.mp3",
  ],

  // Missing pit limiter — entered pit road without the limiter engaged.
  "pit-no-limiter": [
    "pit-crew/pitlane/IRD-pit-no-limiter-01.mp3",
    "pit-crew/pitlane/IRD-pit-no-limiter-02.mp3",
    "pit-crew/pitlane/IRD-pit-no-limiter-03.mp3",
  ],

  // Limiter disengaged while still in the pit lane.
  "pit-limiter-dropped": [
    "pit-crew/pitlane/IRD-pit-limiter-dropped-01.mp3",
    "pit-crew/pitlane/IRD-pit-limiter-dropped-02.mp3",
    "pit-crew/pitlane/IRD-pit-limiter-dropped-03.mp3",
  ],

  // Speeding in pit lane.
  "pit-speeding": [
    "pit-crew/pitlane/IRD-pit-speeding-01.mp3",
    "pit-crew/pitlane/IRD-pit-speeding-02.mp3",
    "pit-crew/pitlane/IRD-pit-speeding-03.mp3",
  ],

  // Racing tips eligible mid-race (excludes START_ONLY tips 6 and 7 from
  // welcome-tip; keeps MID_RACE_ONLY tip-11).
  "race-tip": [
    "pit-crew/tips/IRD-pit-crew-tip-1.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-2.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-3.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-4.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-5.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-8.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-9.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-10.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-11.mp3",
  ],

  // Track-limits / off-track incident warnings. Rotated sequentially; see
  // `incident-alerts.ts` for why no-repeat works per scenario.
  "incident-limits": [
    "pit-crew/incidents/IRD-incident-limits-01.mp3",
    "pit-crew/incidents/IRD-incident-limits-02.mp3",
    "pit-crew/incidents/IRD-incident-limits-03.mp3",
    "pit-crew/incidents/IRD-incident-limits-04.mp3",
    "pit-crew/incidents/IRD-incident-limits-05.mp3",
    "pit-crew/incidents/IRD-incident-limits-06.mp3",
  ],

  // Overtake congratulations. Single clip today; pool leaves room for
  // variants without touching the scenario.
  overtake: ["pit-crew/overtake/IRD-overtake-good-pass.mp3"],

  // Auto-fuel reminder alternatives. Replaces the generic fuel reminder when
  // the user has auto-fuel enabled at pit entry.
  "autofuel-reminder": [
    "pit-crew/reminder/IRD-pit-reminder-autofuel.mp3",
    "pit-crew/reminder/IRD-pit-reminder-autofuel-2.mp3",
  ],

  // Tips eligible during the start-of-race window (formation/pace lap through
  // lap 1). Excludes MID_RACE_ONLY tip-11 from the full TIP_POOL.
  "welcome-tip": [
    "pit-crew/tips/IRD-pit-crew-tip-1.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-2.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-3.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-4.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-5.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-6.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-7.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-8.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-9.mp3",
    "pit-crew/tips/IRD-pit-crew-tip-10.mp3",
  ],
};
