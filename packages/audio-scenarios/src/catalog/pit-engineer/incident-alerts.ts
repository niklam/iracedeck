/**
 * Incident / track-limits alert — fires on brief off-track excursions
 * that bumped the player's incident counter.
 *
 * `priority: "normal"` so pit-lane callouts take precedence. No cooldown;
 * the no-repeat pool rotation keeps the same line from playing twice in a
 * row across rapid incidents.
 *
 * TODO(sim-events): when `incident.occurred` gains material and duration
 * data, branch on surface (grass vs gravel) via an `if` step.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";

import type { Scenario } from "../../dsl.js";

export const INCIDENT_ALERTS: Scenario = {
  id: "pit-engineer.incident-alerts",
  when: { event: "incident.occurred" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-engineer",
  priority: "normal",
  sequence: ["@pit-engineer.radio-open", "pool:incident-limits", "@pit-engineer.radio-close"],
};
