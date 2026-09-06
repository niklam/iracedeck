/**
 * Pit-box count-in contracts (issue #600; scripted since #1065).
 *
 * Six contracts — one per distance mark — fire on `pitBox.countdown` filtered
 * by the payload's `mark`. The translator emits each mark once per pit-road
 * visit as the driver closes on their box (five 120 m → pit-now 20 m). The
 * code below decides WHEN each mark fires and how it is scheduled; WHAT is
 * spoken lives in the active voice's `callouts.json` under the same ids
 * (`scenarios["pit-crew.pit-box-five"]`, …), where the bundled script maps
 * each mark to its clip as `pool:pit-box/<mark>`. No vocabulary is registered
 * here — a mark never branches on anything.
 *
 * **Terse delivery.** Unlike the conversational callouts, the count-in has NO
 * radio beep frame — the marks fire ~a second apart and a beep around each
 * number would be noise. Since issue #1064 the engine applies the frame itself,
 * so it is the contract's `frame: NO_FRAME` (`"none"`) that enforces this; a
 * pack cannot put the ticks back without overriding the frame per entry.
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
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { PitBoxMark, SimEventOf } from "@iracedeck/event-bus";

import type { ScenarioContract } from "../../dsl.js";
import { NO_FRAME } from "../../dsl.js";

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

/** The six marks, in the order the translator emits them on the approach. */
const PIT_BOX_MARKS: readonly PitBoxMark[] = ["five", "four", "three", "two", "one", "pit-now"];

/**
 * When each mark fires, for the generated reference (#1066) — one sentence
 * per mark, since the distance is the only thing that tells them apart.
 */
const PIT_BOX_DESCRIPTIONS: Record<PitBoxMark, string> = {
  five: "On pit road heading for your own box, you close to 120 meters from it.",
  four: "On pit road heading for your own box, you close to 100 meters from it.",
  three: "On pit road heading for your own box, you close to 80 meters from it.",
  two: "On pit road heading for your own box, you close to 60 meters from it.",
  one: "On pit road heading for your own box, you close to 40 meters from it.",
  "pit-now": "On pit road heading for your own box, you close to 20 meters from it.",
};

function pitBoxContract(mark: PitBoxMark): ScenarioContract {
  return {
    id: `pit-crew.pit-box-${mark}`,
    description: PIT_BOX_DESCRIPTIONS[mark],
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: PIT_BOX_COUNT_IN_WEIGHT,
    interrupt: true,
    queueable: false,
    pendingHoldMs: PIT_BOX_PENDING_HOLD_MS,
    family: "pit-box",
    frame: NO_FRAME,
    when: {
      event: "pitBox.countdown",
      where: (e) => (e as SimEventOf<"pitBox.countdown">).data.mark === mark,
    },
  };
}

export const PIT_BOX_CONTRACTS: readonly ScenarioContract[] = PIT_BOX_MARKS.map(pitBoxContract);

/** Contract ids exported for tests so a typo here surfaces as a test failure. */
export const PIT_BOX_SCENARIO_IDS: readonly string[] = PIT_BOX_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the count-in scripts draw from — one `pool:pit-box/<mark>`
 * per mark. The completeness tests read it: the bundled voice must ship at
 * least one clip for each, and the bundled script must reference exactly this
 * set. A `(group, base)` a script addresses is published — renaming a base is
 * a rename in every pack's script and every pack's clip folder.
 */
export const PIT_BOX_CLIP_SOURCES: readonly { group: "pit-box"; base: string }[] = PIT_BOX_MARKS.map((mark) => ({
  group: "pit-box",
  base: mark,
}));
