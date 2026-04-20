/**
 * Pool definitions for the pit-engineer scenario catalog.
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
  // Walkie-talkie "uh, yeah, copy that" style fragments inserted between voice
  // clips in multi-message sequences. The special `{ connector: true }` step
  // draws from this pool.
  connector: [
    "pit-engineer/connector/IRD-connector-addition.mp3",
    "pit-engineer/connector/IRD-connector-also.mp3",
    "pit-engineer/connector/IRD-connector-and.mp3",
    "pit-engineer/connector/IRD-connector-as-well-as.mp3",
    "pit-engineer/connector/IRD-connector-plus.mp3",
  ],

  // Spoken word-greetings ("alright", "hi", "right then", "so") used by the
  // welcome flow. The folder name `radio-openers` is legacy — these are
  // word-greetings, not walkie-talkie PTT ticks (see audio-assets layout §5).
  greeting: [
    "pit-engineer/greeting/IRD-radio-opener-alright.mp3",
    "pit-engineer/greeting/IRD-radio-opener-hi.mp3",
    "pit-engineer/greeting/IRD-radio-opener-right-then.mp3",
    "pit-engineer/greeting/IRD-radio-opener-so.mp3",
  ],

  // Pit approach callouts ("you're approaching the pits"). Picked randomly,
  // no-repeat back-to-back.
  "pit-approach": [
    "pit-engineer/pitlane/IRD-pit-approach.mp3",
    "pit-engineer/pitlane/IRD-pit-approach-2.mp3",
  ],

  // Pit exit callouts ("you're out").
  "pit-exit": [
    "pit-engineer/pitlane/IRD-pit-exit.mp3",
    "pit-engineer/pitlane/IRD-pit-exit-2.mp3",
    "pit-engineer/pitlane/IRD-pit-exit-3.mp3",
    "pit-engineer/pitlane/IRD-pit-exit-4.mp3",
    "pit-engineer/pitlane/IRD-pit-exit-5.mp3",
    "pit-engineer/pitlane/IRD-pit-exit-6.mp3",
  ],

  // Stall-departure callouts ("remember to disengage the pit limiter").
  "stall-departure": [
    "pit-engineer/pitlane/IRD-pit-stall-departure.mp3",
    "pit-engineer/pitlane/IRD-pit-stall-departure-2.mp3",
    "pit-engineer/pitlane/IRD-pit-stall-departure-3.mp3",
    "pit-engineer/pitlane/IRD-pit-stall-departure-4.mp3",
  ],

  // Auto-fuel reminder alternatives. Replaces the generic fuel reminder when
  // the user has auto-fuel enabled at pit entry.
  "autofuel-reminder": [
    "pit-engineer/reminder/IRD-pit-reminder-autofuel.mp3",
    "pit-engineer/reminder/IRD-pit-reminder-autofuel-2.mp3",
  ],

  // Tips eligible during the start-of-race window (formation/pace lap through
  // lap 1). Excludes MID_RACE_ONLY tip-11 from the full TIP_POOL.
  "welcome-tip": [
    "pit-engineer/tips/IRD-pit-engineer-tip-1.mp3",
    "pit-engineer/tips/IRD-pit-engineer-tip-2.mp3",
    "pit-engineer/tips/IRD-pit-engineer-tip-3.mp3",
    "pit-engineer/tips/IRD-pit-engineer-tip-4.mp3",
    "pit-engineer/tips/IRD-pit-engineer-tip-5.mp3",
    "pit-engineer/tips/IRD-pit-engineer-tip-6.mp3",
    "pit-engineer/tips/IRD-pit-engineer-tip-7.mp3",
    "pit-engineer/tips/IRD-pit-engineer-tip-8.mp3",
    "pit-engineer/tips/IRD-pit-engineer-tip-9.mp3",
    "pit-engineer/tips/IRD-pit-engineer-tip-10.mp3",
  ],
};
