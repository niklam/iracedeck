/**
 * Overtake congratulations — fires after a sustained pass in a race session.
 *
 * Behavior:
 *   - Race sessions only (filtered via `@iracedeck/sim-events-iracing`'s
 *     `getSessionType()`).
 *   - Fires every Nth confirmed overtake (`OVERTAKE_PLAY_EVERY = 5`) to
 *     avoid spamming during battle-heavy stints.
 *   - Enforces an 8 s scenario cooldown on top, so even at high overtake
 *     density the callouts stay well spaced.
 *
 * The "every 5th" counter lives in a closure captured by the `where`
 * predicate — scenario-local state without a module-level singleton.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { getSessionType } from "@iracedeck/sim-events-iracing";

import type { Scenario } from "../../dsl.js";

const OVERTAKE_PLAY_EVERY = 5;
const OVERTAKE_COOLDOWN_MS = 8000;

function createOvertakeWhere(): () => boolean {
  let confirmedCount = 0;

  return () => {
    if (getSessionType() !== "Race") return false;

    confirmedCount++;

    if (confirmedCount < OVERTAKE_PLAY_EVERY) return false;

    confirmedCount = 0;

    return true;
  };
}

export const OVERTAKE: Scenario = {
  id: "pit-crew.overtake",
  when: { event: "overtake.completed", where: createOvertakeWhere() },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  priority: "normal",
  cooldown: OVERTAKE_COOLDOWN_MS,
  sequence: ["@pit-crew.radio-open", "pool:overtake", "@pit-crew.radio-close"],
};
