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
 * **Family preemption.** All six share `family: "pit-box"` so a faster approach
 * that crosses two marks in quick succession supersedes the in-flight clip
 * cleanly — the same mechanism the flag / track-conditions families use. Cross-
 * family priority stays `normal` so urgent flags (meatball) still preempt these.
 *
 * Pool-driven clips (mirrors `flag-alerts.ts` / `track-conditions.ts`) so a
 * future variant pack is a one-line append in `pools.ts`.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { PitBoxMark, SimEventOf } from "@iracedeck/event-bus";

import type { Scenario } from "../../dsl.js";

function pitBoxScenario(mark: PitBoxMark): Scenario {
  return {
    id: `pit-crew.pit-box-${mark}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    priority: "normal",
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
