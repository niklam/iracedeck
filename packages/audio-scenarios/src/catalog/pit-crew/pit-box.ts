/**
 * Pit-box count-in callouts (issue #600).
 *
 * Six scenarios — one per distance mark — fire on `pitBox.countdown` filtered
 * by the payload's `mark`. The translator emits each mark once per pit-road
 * visit as the driver closes on their box (five 120 m → pit-now 20 m), so the
 * scenarios just map mark → clip.
 *
 * **Terse delivery.** Unlike the conversational callouts, the count-in has NO
 * `@pit-crew.radio-open` / `…close` beep frame — the marks fire ~a second apart
 * and a beep around each number would be noise. Each scenario plays a single
 * clip from its pool.
 *
 * **Countdown wins the CHATTER band (issue #758, reverses #646).** The
 * count-in carries an explicit weight between `CHATTER` (10) and `NORMAL`
 * (50) plus `interrupt: true`, so a mark that fires while the pit-entry
 * service readback is playing CUTS it immediately — the countdown is the
 * time-critical callout on approach, and the interrupted readback (queueable
 * + resumable) resumes from where it left off once the count-in is done.
 * `queueable: false` stays: a mark that loses the bus to a `NORMAL`-or-above
 * line (pit-status, flags, fuel-critical) is dropped, never deferred — a
 * stale number replayed after the moment passed is worse than silence.
 * `pendingHoldMs` keeps the bus's pending replay held between marks so the
 * displaced readback doesn't stutter back into the ~1 s gaps of the train.
 *
 * **Family preemption.** All six share `family: "pit-box"` so a faster approach
 * that crosses two marks in quick succession still supersedes the in-flight
 * count-in cleanly — the same mechanism the flag / track-conditions families use.
 *
 * Pool-driven clips (mirrors `flag-alerts.ts` / `track-conditions.ts`) so a
 * future variant pack is a one-line append in `pools.ts`.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { PitBoxMark, SimEventOf } from "@iracedeck/event-bus";

import type { Scenario } from "../../dsl.js";

/**
 * Explicit integer between `WEIGHT.CHATTER` (10) and `WEIGHT.NORMAL` (50) —
 * the #655 pit-window precedent for a callout that slots between named bands.
 * The count-in outranks the readback and other background commentary but
 * still loses (drops) against ordinary and safety callouts.
 */
export const PIT_BOX_COUNT_IN_WEIGHT = 30;

/**
 * How long the pending replay stays held after each mark finishes. Marks
 * arrive ~1 s apart at pit-lane speed (20 m spacing) and stretch out as the
 * driver brakes into the box, so the window must comfortably bridge the
 * slowest inter-mark gap; after the final mark it delays the readback resume
 * by the same amount, which lands while the car is stopping in the stall.
 */
export const PIT_BOX_PENDING_HOLD_MS = 2500;

function pitBoxScenario(mark: PitBoxMark): Scenario {
  return {
    id: `pit-crew.pit-box-${mark}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: PIT_BOX_COUNT_IN_WEIGHT,
    interrupt: true,
    queueable: false,
    pendingHoldMs: PIT_BOX_PENDING_HOLD_MS,
    family: "pit-box",
    sequence: [`pool:pit-box-${mark}`],
    when: {
      event: "pitBox.countdown",
      where: (e) => (e as SimEventOf<"pitBox.countdown">).data.mark === mark,
    },
  };
}

export const PIT_BOX_ALERTS: readonly Scenario[] = [
  pitBoxScenario("five"),
  pitBoxScenario("four"),
  pitBoxScenario("three"),
  pitBoxScenario("two"),
  pitBoxScenario("one"),
  pitBoxScenario("pit-now"),
];

/** Scenario ids exported for tests so a typo here surfaces as a test failure. */
export const PIT_BOX_SCENARIO_IDS: readonly string[] = PIT_BOX_ALERTS.map((s) => s.id);

/** Pool names this catalog draws from — kept here so tests can register them
 *  on the scenario engine without duplicating the list. */
export const PIT_BOX_POOL_NAMES: readonly string[] = [
  "pit-box-five",
  "pit-box-four",
  "pit-box-three",
  "pit-box-two",
  "pit-box-one",
  "pit-box-pit-now",
];
