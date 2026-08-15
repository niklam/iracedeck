/**
 * Pit-service status callouts (issue #479) and their positioning-error
 * repeat nags (issue #951).
 *
 * Eight scenarios — one per non-`None` `PlayerCarPitSvStatus` target —
 * fire on `pitService.statusChanged` filtered by `data.to`. The translator
 * already suppresses `* → None` so the silent idle state never reaches
 * the bus.
 *
 * **Family preemption.** All eight share `family: "pit-status"` so a rapid
 * positioning correction (`TooFarLeft → TooFarRight`) supersedes the
 * in-flight callout cleanly — same mechanism the flag callouts use.
 *
 * **Cross-family weight.** Default weight (`WEIGHT.NORMAL`) means a meatball
 * flag (`WEIGHT.CRITICAL`) still wins the bus over these, and a positioning
 * callout cleanly outweighs an in-flight lower-weight pit-readback (#476).
 *
 * Pool-driven clips (mirrors `flag-alerts.ts` / `damage-alerts.ts`) so a
 * future variant pack (#470) is a one-line append in `pools.ts` instead
 * of a scenario rewrite.
 *
 * ## Repeat nags (issue #951)
 *
 * iRacing reports a positioning error once and then leaves the status
 * latched, so a driver who overshoots, backs up, and stops still short of the
 * box would otherwise sit unserved in silence. The translator therefore
 * re-emits `pitService.positioningRepeat { status }` every ~2 s while the
 * error persists and the car is at rest, and the five scenarios below turn
 * each one into a terse correction line.
 *
 * Three deliberate differences from the transition calls:
 *
 * - **Own family.** Same-family preemption ignores weight, so sharing
 *   `family: "pit-status"` would let the first nag chop the initial call
 *   mid-sentence. `family: "pit-status-repeat"` keeps the two apart and lets
 *   the weight ordering below arbitrate instead. Nags still replace each
 *   OTHER, which is exactly right — a newer nag is the same information,
 *   fresher.
 * - **Strictly lower weight** ({@link PIT_STATUS_REPEAT_WEIGHT}). A nag that
 *   arrives while any `WEIGHT.NORMAL`-or-above line is playing is dropped and
 *   simply retries on the next cadence tick, while a FRESH positioning error
 *   outranks a playing nag and speaks in full the moment it finishes.
 * - **Terse delivery.** No `@pit-crew.radio-open` / `…close` frame — the
 *   pit-box count-in precedent: at a 2 s cadence the beeps would drown the
 *   words.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";
import { PitSvStatus } from "@iracedeck/iracing-sdk";

import type { Scenario, Step } from "../../dsl.js";

/**
 * Explicit integer between `WEIGHT.CHATTER` (10) and `WEIGHT.NORMAL` (50) —
 * the #655 / #758 precedent for a callout that slots between named bands.
 *
 * Strictly BELOW the transition calls is the load-bearing part: at equal
 * weight a fresh positioning error arriving mid-nag would be dropped, and the
 * driver would never learn they over-corrected into a different error. Above
 * the CHATTER band so the pit-service readback can't bury a nag.
 */
export const PIT_STATUS_REPEAT_WEIGHT = 40;

/**
 * The statuses that describe an uncorrected parking error — the ones the
 * translator repeats. Single-sourced here so the transition scenarios and
 * their repeat siblings can never disagree about which subjects those are.
 */
const POSITIONING_SUBJECTS: readonly { readonly id: string; readonly target: PitSvStatus }[] = [
  { id: "too-far-left", target: PitSvStatus.TooFarLeft },
  { id: "too-far-right", target: PitSvStatus.TooFarRight },
  { id: "too-far-forward", target: PitSvStatus.TooFarForward },
  { id: "too-far-back", target: PitSvStatus.TooFarBack },
  { id: "bad-angle", target: PitSvStatus.BadAngle },
];

function pitStatusScenario(id: string, target: PitSvStatus, body: Step[]): Scenario {
  return {
    id: `pit-crew.pit-status-${id}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "pit-status",
    sequence: ["@pit-crew.radio-open", ...body, "@pit-crew.radio-close"],
    when: {
      event: "pitService.statusChanged",
      where: (e) => (e as SimEventOf<"pitService.statusChanged">).data.to === target,
    },
  };
}

function pitStatusRepeatScenario(id: string, target: PitSvStatus): Scenario {
  return {
    id: `pit-crew.pit-status-${id}-repeat`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: PIT_STATUS_REPEAT_WEIGHT,
    family: "pit-status-repeat",
    sequence: [`pool:pit-status-${id}-repeat`],
    when: {
      event: "pitService.positioningRepeat",
      where: (e) => (e as SimEventOf<"pitService.positioningRepeat">).data.status === target,
    },
  };
}

export const PIT_STATUS_ALERTS: readonly Scenario[] = [
  pitStatusScenario("in-progress", PitSvStatus.InProgress, ["pool:pit-status-in-progress"]),
  pitStatusScenario("complete", PitSvStatus.Complete, ["pool:pit-status-complete"]),
  ...POSITIONING_SUBJECTS.map(({ id, target }) => pitStatusScenario(id, target, [`pool:pit-status-${id}`])),
  pitStatusScenario("cant-fix-that", PitSvStatus.CantFixThat, ["pool:pit-status-cant-fix-that"]),
];

/** The terse "still uncorrected" nags (issue #951) — one per positioning error. */
export const PIT_STATUS_REPEAT_ALERTS: readonly Scenario[] = POSITIONING_SUBJECTS.map(({ id, target }) =>
  pitStatusRepeatScenario(id, target),
);

/** Scenario ids exported for tests so a typo here surfaces as a test failure. */
export const PIT_STATUS_SCENARIO_IDS: readonly string[] = PIT_STATUS_ALERTS.map((s) => s.id);

/** Repeat-scenario ids, same purpose as {@link PIT_STATUS_SCENARIO_IDS}. */
export const PIT_STATUS_REPEAT_SCENARIO_IDS: readonly string[] = PIT_STATUS_REPEAT_ALERTS.map((s) => s.id);

/** Pool names this catalog draws from — kept here so tests can register them
 *  on the scenario engine without duplicating the list. */
export const PIT_STATUS_POOL_NAMES: readonly string[] = [
  "pit-status-in-progress",
  "pit-status-complete",
  ...POSITIONING_SUBJECTS.map(({ id }) => `pit-status-${id}`),
  "pit-status-cant-fix-that",
];

/** Repeat-nag pool names, same purpose as {@link PIT_STATUS_POOL_NAMES}. */
export const PIT_STATUS_REPEAT_POOL_NAMES: readonly string[] = POSITIONING_SUBJECTS.map(
  ({ id }) => `pit-status-${id}-repeat`,
);
