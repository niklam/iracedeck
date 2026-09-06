/**
 * Track-conditions contracts (issue #526; scripted since #1065).
 *
 * Twelve contracts — one per (direction, target-state) combination — fire on
 * `track.wetness.changed` filtered by both the target state and the direction
 * of the transition. The translator already suppresses transitions involving
 * `Unknown` so neither side is ever Unknown by the time the bus dispatches.
 *
 * The code below decides WHETHER a transition is worth a line and how it is
 * scheduled; WHAT is said lives in the active voice's `callouts.json` under
 * the same ids (`scenarios["pit-crew.track-conditions-worsening-very-wet"]`,
 * …), paired at `setScripts` time. Each line is a single pool the script
 * addresses directly as `pool:track-conditions/<direction>-<slug>`; no
 * vocabulary is needed, since the direction and the target are both decided
 * by the contract's `where:` before the script is ever read.
 *
 * Direction is read from the event payload as `to > from` (worsening) or
 * `to < from` (drying). Worsening targets cover MostlyDry → ExtremelyWet
 * (six lines); drying targets cover Dry → VeryWet (six lines). Combinations
 * that don't make physical sense (worsening to Dry, drying to ExtremelyWet)
 * are simply not contracts — the predicate filters them out.
 *
 * **Family preemption.** All twelve share `family: "track-conditions"` so a
 * rapid double-step (worsening → ModeratelyWet → VeryWet) supersedes the
 * in-flight callout cleanly — same mechanism the flag and pit-status families
 * use. Cross-family weight stays at the default (`WEIGHT.NORMAL`) so a meatball
 * flag (`WEIGHT.CRITICAL`) still wins the bus over these.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type SimEventOf, TrackWetness } from "@iracedeck/event-bus";

import type { ScenarioContract } from "../../dsl.js";

type Direction = "worsening" | "drying";

function trackConditionsContract(
  direction: Direction,
  target: TrackWetness,
  slug: string,
  description: string,
): ScenarioContract {
  return {
    id: `pit-crew.track-conditions-${direction}-${slug}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "track-conditions",
    when: {
      event: "track.wetness.changed",
      where: (e) => {
        const data = (e as SimEventOf<"track.wetness.changed">).data;

        if (data.to !== target) return false;

        return direction === "worsening" ? data.to > data.from : data.to < data.from;
      },
    },
    description,
  };
}

export const TRACK_CONDITIONS_CONTRACTS: readonly ScenarioContract[] = [
  // Worsening — Dry isn't a worsening target.
  trackConditionsContract(
    "worsening",
    TrackWetness.MostlyDry,
    "mostly-dry",
    "The track's wetness rises to mostly dry from dry.",
  ),
  trackConditionsContract(
    "worsening",
    TrackWetness.VeryLightlyWet,
    "very-lightly-wet",
    "The track's wetness rises to very lightly wet from any drier state.",
  ),
  trackConditionsContract(
    "worsening",
    TrackWetness.LightlyWet,
    "lightly-wet",
    "The track's wetness rises to lightly wet from any drier state.",
  ),
  trackConditionsContract(
    "worsening",
    TrackWetness.ModeratelyWet,
    "moderately-wet",
    "The track's wetness rises to moderately wet from any drier state.",
  ),
  trackConditionsContract(
    "worsening",
    TrackWetness.VeryWet,
    "very-wet",
    "The track's wetness rises to very wet from any drier state.",
  ),
  trackConditionsContract(
    "worsening",
    TrackWetness.ExtremelyWet,
    "extremely-wet",
    "The track's wetness rises to extremely wet from any drier state.",
  ),

  // Drying — ExtremelyWet isn't a drying target.
  trackConditionsContract("drying", TrackWetness.Dry, "dry", "The track's wetness falls to dry from any wetter state."),
  trackConditionsContract(
    "drying",
    TrackWetness.MostlyDry,
    "mostly-dry",
    "The track's wetness falls to mostly dry from any wetter state.",
  ),
  trackConditionsContract(
    "drying",
    TrackWetness.VeryLightlyWet,
    "very-lightly-wet",
    "The track's wetness falls to very lightly wet from any wetter state.",
  ),
  trackConditionsContract(
    "drying",
    TrackWetness.LightlyWet,
    "lightly-wet",
    "The track's wetness falls to lightly wet from any wetter state.",
  ),
  trackConditionsContract(
    "drying",
    TrackWetness.ModeratelyWet,
    "moderately-wet",
    "The track's wetness falls to moderately wet from any wetter state.",
  ),
  trackConditionsContract(
    "drying",
    TrackWetness.VeryWet,
    "very-wet",
    "The track's wetness falls to very wet from extremely wet.",
  ),
];

/** Contract ids exported for tests so a typo here surfaces as a test failure. */
export const TRACK_CONDITIONS_SCENARIO_IDS: readonly string[] = TRACK_CONDITIONS_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the track-conditions scripts draw from — every
 * `pool:track-conditions/<base>` the bundled script may write, as a literal
 * list, since nothing derives it. The completeness tests read it: the
 * bundled voice must ship at least one clip for each, and the bundled
 * script must reference exactly this set. A `(group, base)` a script
 * addresses is published — renaming a base is a rename in every pack's
 * script and every pack's clip folder.
 */
export const TRACK_CONDITIONS_CLIP_SOURCES: readonly { group: "track-conditions"; base: string }[] = [
  { group: "track-conditions", base: "worsening-mostly-dry" },
  { group: "track-conditions", base: "worsening-very-lightly-wet" },
  { group: "track-conditions", base: "worsening-lightly-wet" },
  { group: "track-conditions", base: "worsening-moderately-wet" },
  { group: "track-conditions", base: "worsening-very-wet" },
  { group: "track-conditions", base: "worsening-extremely-wet" },
  { group: "track-conditions", base: "drying-dry" },
  { group: "track-conditions", base: "drying-mostly-dry" },
  { group: "track-conditions", base: "drying-very-lightly-wet" },
  { group: "track-conditions", base: "drying-lightly-wet" },
  { group: "track-conditions", base: "drying-moderately-wet" },
  { group: "track-conditions", base: "drying-very-wet" },
];
