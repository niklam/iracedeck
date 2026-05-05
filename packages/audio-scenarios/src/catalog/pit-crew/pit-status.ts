/**
 * Pit-service status callouts (issue #479).
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
 * **Cross-family priority.** `priority: "normal"` means a meatball flag
 * (`urgent`) still preempts these, and the `low` → `normal` rule from
 * #476 lets a positioning callout cleanly trump an in-flight pit-readback.
 *
 * Pool-driven clips (mirrors `flag-alerts.ts` / `damage-alerts.ts`) so a
 * future variant pack (#470) is a one-line append in `pools.ts` instead
 * of a scenario rewrite.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";
import { PitSvStatus } from "@iracedeck/iracing-sdk";

import type { Scenario, Step } from "../../dsl.js";

function pitStatusScenario(id: string, target: PitSvStatus, body: Step[]): Scenario {
  return {
    id: `pit-crew.pit-status-${id}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    priority: "normal",
    family: "pit-status",
    sequence: ["@pit-crew.radio-open", ...body, "@pit-crew.radio-close"],
    when: {
      event: "pitService.statusChanged",
      where: (e) => (e as SimEventOf<"pitService.statusChanged">).data.to === target,
    },
  };
}

export const PIT_STATUS_ALERTS: readonly Scenario[] = [
  pitStatusScenario("in-progress", PitSvStatus.InProgress, ["pool:pit-status-in-progress"]),
  pitStatusScenario("complete", PitSvStatus.Complete, ["pool:pit-status-complete"]),
  pitStatusScenario("too-far-left", PitSvStatus.TooFarLeft, ["pool:pit-status-too-far-left"]),
  pitStatusScenario("too-far-right", PitSvStatus.TooFarRight, ["pool:pit-status-too-far-right"]),
  pitStatusScenario("too-far-forward", PitSvStatus.TooFarForward, ["pool:pit-status-too-far-forward"]),
  pitStatusScenario("too-far-back", PitSvStatus.TooFarBack, ["pool:pit-status-too-far-back"]),
  pitStatusScenario("bad-angle", PitSvStatus.BadAngle, ["pool:pit-status-bad-angle"]),
  pitStatusScenario("cant-fix-that", PitSvStatus.CantFixThat, ["pool:pit-status-cant-fix-that"]),
];

/** Scenario ids exported for tests so a typo here surfaces as a test failure. */
export const PIT_STATUS_SCENARIO_IDS: readonly string[] = PIT_STATUS_ALERTS.map((s) => s.id);

/** Pool names this catalog draws from — kept here so tests can register them
 *  on the scenario engine without duplicating the list. */
export const PIT_STATUS_POOL_NAMES: readonly string[] = [
  "pit-status-in-progress",
  "pit-status-complete",
  "pit-status-too-far-left",
  "pit-status-too-far-right",
  "pit-status-too-far-forward",
  "pit-status-too-far-back",
  "pit-status-bad-angle",
  "pit-status-cant-fix-that",
];
