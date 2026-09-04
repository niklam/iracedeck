/**
 * Corner-name callout (issue #888) — the engineer speaks the upcoming
 * corner's bare name ("Eau Rouge", "Turn five") in practice/test sessions.
 *
 * Terse delivery: a single clip, NO radio open/close frame (the pit-box
 * count-in precedent) — at a 1 s default lead a beep frame would eat the
 * whole margin. Since issue #1064 the engine applies the frame itself, so it
 * is the scenario's `frame: NO_FRAME` (`"none"`) that enforces this now.
 * `family: "corner-name"` so back-to-back corners preempt the
 * in-flight name; `queueable: false` because a name that missed its moment
 * must drop, never replay late. Weight stays at the default `WEIGHT.NORMAL`.
 *
 * Snapshot-driven builder shape (issue #558, the lap-time precedent): the
 * clip resolver reads a plugin-owned cache of the latest event payload at
 * expansion time. The slug maps straight to the `corner-names` clip group —
 * a name with no clip for the active voice aborts the whole callout at
 * expansion (issue #835), which is exactly the graceful degradation we want
 * when the dataset grows between releases. Session gating (practice-only)
 * lives in the translator diff, NOT here, so the scenario stays firable from
 * the scenario harness.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario } from "../../dsl.js";
import { NO_FRAME, poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/** Snapshot the clip resolver reads — exactly the event payload. */
export type CornerNameSnapshot = SimEventOf<"cornerName.approaching">["data"];

/** Resolver for the most recent `cornerName.approaching` payload. */
export type CornerNameSnapshotResolver = () => CornerNameSnapshot | null;

const CORNER_NAME_GROUP = "corner-names";

/**
 * Register the corner-name clip resolver. Must run before the scenario is
 * defined — load-time validation rejects an unregistered `{ var }` name.
 */
export function registerCornerNameVars(engine: IScenarioEngine, getSnapshot: CornerNameSnapshotResolver): void {
  engine.defineVar("cornerName.clip", () => {
    const s = getSnapshot();

    if (!s || typeof s.slug !== "string" || s.slug === "") return null;

    return poolRef(CORNER_NAME_GROUP, s.slug);
  });
}

/** Build the corner-name scenario bound to a snapshot resolver. */
export function buildCornerNameScenario(getSnapshot: CornerNameSnapshotResolver): Scenario {
  return {
    id: "pit-crew.corner-name-approaching",
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "corner-name",
    queueable: false,
    frame: NO_FRAME,
    sequence: [{ var: "cornerName.clip" }],
    when: {
      event: "cornerName.approaching",
      where: (e) => {
        const data = (e as SimEventOf<"cornerName.approaching">).data;

        // The snapshot cache is what the resolver speaks from; require a
        // usable slug on the event itself so a malformed payload can't fire
        // an empty expansion.
        return typeof data.slug === "string" && data.slug !== "" && getSnapshot() !== null;
      },
    },
  };
}

/** Stable identifier for the corner-name callout family (issue #888). */
export type CornerNameCalloutId = "corner-names";

/** Canonical id↔setting-key map plugins read the live opt-in through. */
export const CORNER_NAME_CALLOUT_SETTING_KEYS: Record<CornerNameCalloutId, string> = {
  "corner-names": "calloutEnabledCornerNames",
};

export const SCENARIO_ID_TO_CORNER_NAME_ID: Record<string, CornerNameCalloutId> = {
  "pit-crew.corner-name-approaching": "corner-names",
};

export const CORNER_NAME_SCENARIO_IDS: readonly string[] = ["pit-crew.corner-name-approaching"];

/** Empty — the clip is var-resolved (#836), no POOL_REGISTRY entry. */
export const CORNER_NAME_POOL_NAMES: readonly string[] = [];
