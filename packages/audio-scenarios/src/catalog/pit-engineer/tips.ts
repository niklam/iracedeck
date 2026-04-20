/**
 * Racing tips — fires per lap in race sessions with a 25% probability.
 *
 * Start-window (lap <= 1) picks from `welcome-tip` (excludes MID_RACE_ONLY
 * tip-11 but includes the starter-only tips 6 and 7). Mid-race picks from
 * `race-tip` (excludes START_ONLY tips 6 and 7 but includes mid-race tip-11).
 *
 * Behavior drift from the legacy pit-engineer:
 *   - Legacy path polled telemetry every 2 s for a random LapDistPct
 *     threshold. The scenario fires once at `lap.started` (new-lap edge)
 *     which is slightly earlier and more deterministic — acceptable
 *     simplification per the plan's "accept minor jitter loss" decision.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { getSessionType } from "@iracedeck/sim-events-iracing";

import type { Scenario, ScenarioContext } from "../../dsl.js";

const TIP_LAP_PROBABILITY = 0.25;

function isStartWindow(ctx: ScenarioContext): boolean {
  const lap = (ctx.data as { lap?: number } | null)?.lap;

  return typeof lap === "number" && lap <= 1;
}

export const RACING_TIPS: Scenario = {
  id: "pit-engineer.racing-tips",
  when: {
    event: "lap.started",
    where: () => {
      if (getSessionType() !== "Race") return false;

      return Math.random() < TIP_LAP_PROBABILITY;
    },
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-engineer",
  priority: "normal",
  sequence: [
    "@pit-engineer.radio-open",
    {
      if: (ctx) => isStartWindow(ctx),
      then: ["pool:welcome-tip"],
      else: ["pool:race-tip"],
    },
    "@pit-engineer.radio-close",
  ],
};
