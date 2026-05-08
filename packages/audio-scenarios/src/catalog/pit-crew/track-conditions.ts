/**
 * Track-conditions callouts (issue #526).
 *
 * Twelve scenarios — one per (direction, target-state) combination — fire on
 * `track.wetness.changed` filtered by both the target state and the direction
 * of the transition. The translator already suppresses transitions involving
 * `Unknown` so neither side is ever Unknown by the time the bus dispatches.
 *
 * Direction is read from the event payload as `to > from` (worsening) or
 * `to < from` (drying). Worsening targets cover MostlyDry → ExtremelyWet
 * (six lines); drying targets cover Dry → VeryWet (six lines). Combinations
 * that don't make physical sense (worsening to Dry, drying to ExtremelyWet)
 * are simply not scenarios — the predicate filters them out.
 *
 * **Family preemption.** All twelve share `family: "track-conditions"` so a
 * rapid double-step (worsening → ModeratelyWet → VeryWet) supersedes the
 * in-flight callout cleanly — same mechanism the flag and pit-status families
 * use. Cross-family priority stays `normal` so meatball / urgent flags still
 * preempt these.
 *
 * Pool-driven clips (mirrors `flag-alerts.ts` / `pit-status.ts`) so a future
 * variant pack is a one-line append in `pools.ts` instead of a scenario rewrite.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type SimEventOf, TrackWetness } from "@iracedeck/event-bus";

import type { Scenario, Step } from "../../dsl.js";

type Direction = "worsening" | "drying";

function trackConditionsScenario(direction: Direction, target: TrackWetness, slug: string, body: Step[]): Scenario {
  return {
    id: `pit-crew.track-conditions-${direction}-${slug}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    priority: "normal",
    family: "track-conditions",
    sequence: ["@pit-crew.radio-open", ...body, "@pit-crew.radio-close"],
    when: {
      event: "track.wetness.changed",
      where: (e) => {
        const data = (e as SimEventOf<"track.wetness.changed">).data;

        if (data.to !== target) return false;

        return direction === "worsening" ? data.to > data.from : data.to < data.from;
      },
    },
  };
}

export const TRACK_CONDITIONS_ALERTS: readonly Scenario[] = [
  // Worsening — Dry isn't a worsening target.
  trackConditionsScenario("worsening", TrackWetness.MostlyDry, "mostly-dry", [
    "pool:track-conditions-worsening-mostly-dry",
  ]),
  trackConditionsScenario("worsening", TrackWetness.VeryLightlyWet, "very-lightly-wet", [
    "pool:track-conditions-worsening-very-lightly-wet",
  ]),
  trackConditionsScenario("worsening", TrackWetness.LightlyWet, "lightly-wet", [
    "pool:track-conditions-worsening-lightly-wet",
  ]),
  trackConditionsScenario("worsening", TrackWetness.ModeratelyWet, "moderately-wet", [
    "pool:track-conditions-worsening-moderately-wet",
  ]),
  trackConditionsScenario("worsening", TrackWetness.VeryWet, "very-wet", [
    "pool:track-conditions-worsening-very-wet",
  ]),
  trackConditionsScenario("worsening", TrackWetness.ExtremelyWet, "extremely-wet", [
    "pool:track-conditions-worsening-extremely-wet",
  ]),

  // Drying — ExtremelyWet isn't a drying target.
  trackConditionsScenario("drying", TrackWetness.Dry, "dry", ["pool:track-conditions-drying-dry"]),
  trackConditionsScenario("drying", TrackWetness.MostlyDry, "mostly-dry", ["pool:track-conditions-drying-mostly-dry"]),
  trackConditionsScenario("drying", TrackWetness.VeryLightlyWet, "very-lightly-wet", [
    "pool:track-conditions-drying-very-lightly-wet",
  ]),
  trackConditionsScenario("drying", TrackWetness.LightlyWet, "lightly-wet", [
    "pool:track-conditions-drying-lightly-wet",
  ]),
  trackConditionsScenario("drying", TrackWetness.ModeratelyWet, "moderately-wet", [
    "pool:track-conditions-drying-moderately-wet",
  ]),
  trackConditionsScenario("drying", TrackWetness.VeryWet, "very-wet", ["pool:track-conditions-drying-very-wet"]),
];

/** Scenario ids exported for tests so a typo here surfaces as a test failure. */
export const TRACK_CONDITIONS_SCENARIO_IDS: readonly string[] = TRACK_CONDITIONS_ALERTS.map((s) => s.id);

/** Pool names this catalog draws from — kept here so tests can register them
 *  on the scenario engine without duplicating the list. */
export const TRACK_CONDITIONS_POOL_NAMES: readonly string[] = [
  "track-conditions-worsening-mostly-dry",
  "track-conditions-worsening-very-lightly-wet",
  "track-conditions-worsening-lightly-wet",
  "track-conditions-worsening-moderately-wet",
  "track-conditions-worsening-very-wet",
  "track-conditions-worsening-extremely-wet",
  "track-conditions-drying-dry",
  "track-conditions-drying-mostly-dry",
  "track-conditions-drying-very-lightly-wet",
  "track-conditions-drying-lightly-wet",
  "track-conditions-drying-moderately-wet",
  "track-conditions-drying-very-wet",
];
