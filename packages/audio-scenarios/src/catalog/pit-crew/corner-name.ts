/**
 * Corner-name callout (issue #888; scripted since #1065) — the engineer
 * speaks the upcoming corner's bare name ("Eau Rouge", "Turn five") in
 * practice/test sessions.
 *
 * The code below decides WHETHER and WHEN the name fires and how it is
 * scheduled; WHAT is said lives in the active voice's `callouts.json` under
 * the same id (`scenarios["pit-crew.corner-name-approaching"]`), paired at
 * `setScripts` time. The bundled script is the one step `{{cornerName.clip}}`
 * — the var registered by {@link registerCornerNameVocabulary}, which turns
 * the event's slug into `pool:corner-names/<slug>` — so the name IS the
 * callout, and a pack rephrases around it (a lead-in, a beat) rather than
 * re-recording four hundred corners.
 *
 * Terse delivery: a single clip, NO radio open/close frame (the pit-box
 * count-in precedent) — at a 1 s default lead a beep frame would eat the
 * whole margin. Since issue #1064 the engine applies the frame itself, so it
 * is the contract's `frame: NO_FRAME` (`"none"`) that enforces this now.
 * `family: "corner-name"` so back-to-back corners preempt the in-flight
 * name; `queueable: false` because a name that missed its moment must drop,
 * never replay late. Weight stays at the default `WEIGHT.NORMAL`, so a name
 * that arrives while a lighter line plays (a sector start, #1676, or a
 * `CHATTER` position call) waits in the bus's queue for it, queueable or
 * not, and plays the moment it ends; {@link MARKER_CALL_MAX_LAG_MS} bounds
 * that wait, so a name more than 1.5 s late is dropped rather than naming a
 * corner the driver is already in.
 *
 * Snapshot-driven builder shape (issue #558, the lap-time precedent): the
 * clip resolver reads a plugin-owned cache of the latest event payload at
 * expansion time. The slug maps straight to the `corner-names` clip group —
 * a name with no clip for the active voice aborts the whole callout at
 * expansion (issue #835), which is exactly the graceful degradation we want
 * when the dataset grows between releases. Session gating (practice-only)
 * lives in the translator diff, NOT here, so the contract stays firable from
 * the scenario harness.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutIdOf, CORNER_NAME_CALLOUTS } from "@iracedeck/callout-settings";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { ScenarioContract } from "../../dsl.js";
import { NO_FRAME, poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/** Snapshot the clip resolver reads — exactly the event payload. */
export type CornerNameSnapshot = SimEventOf<"cornerName.approaching">["data"];

/** Resolver for the most recent `cornerName.approaching` payload. */
export type CornerNameSnapshotResolver = () => CornerNameSnapshot | null;

const CORNER_NAME_GROUP = "corner-names";

/**
 * The longest a track-marker call — a corner name or a sector start — may
 * start after it was due, in milliseconds (#1676), set as `maxQueueWaitMs` on
 * both contracts. The two often come due together, and the bus plays the
 * second right after the first; a call still waiting past this is stale and
 * dropped. At the default 1 s lead a call 1.5 s late starts half a second
 * past its marker, the latest a corner is still "called as it starts" — any
 * later and it names a corner the driver is already in, #888's reason the
 * names never replay late. It clears every measured bundled overlap: a
 * corner behind "Sector three." waits at most 1.02 s, a sector call behind
 * a corner name at most 1.62 s only when the two markers coincide on the
 * longest names. A constant rather than one scaled by the lead, because a
 * pack's longer clips are exactly what it exists to cut off.
 */
export const MARKER_CALL_MAX_LAG_MS = 1500;

/**
 * Register the vocabulary the corner-name script references (issue #1065):
 * the one var that carries the corner's name clip. Must run before the
 * contract is defined so the first `setScripts` compile sees it; a later
 * registration would only mark the compiled scripts dirty.
 */
export function registerCornerNameVocabulary(
  engine: Pick<IScenarioEngine, "defineVar">,
  getSnapshot: CornerNameSnapshotResolver,
): void {
  engine.defineVar(
    "cornerName.clip",
    () => {
      const s = getSnapshot();

      if (!s || typeof s.slug !== "string" || s.slug === "") return null;

      return poolRef(CORNER_NAME_GROUP, s.slug);
    },
    "The name of the corner the driver is approaching, drawn from the corner-names group (one clip per corner, named by its slug — corner-names/eau-rouge, corner-names/turn-5). Nothing when the voice has no clip for that corner, which skips the callout rather than half-saying it.",
  );
}

/**
 * Build the corner-name contract bound to a snapshot resolver. Still a
 * builder rather than a constant: the `where:` reads the resolver to refuse a
 * fire before the plugin's cache holds the payload the var will speak from.
 */
export function buildCornerNameContract(getSnapshot: CornerNameSnapshotResolver): ScenarioContract {
  return {
    id: "pit-crew.corner-name-approaching",
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "corner-name",
    queueable: false,
    // A name waiting for a lighter line in flight (it is heavier, so it
    // waits queueable or not) is dropped once it is this late (#1676).
    maxQueueWaitMs: MARKER_CALL_MAX_LAG_MS,
    frame: NO_FRAME,
    description:
      "Your car reaches the point about a second (the configured lead) before a named corner in a practice or test session, once per corner per lap; qualifying and races stay silent.",
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
export type CornerNameCalloutId = CalloutIdOf<typeof CORNER_NAME_CALLOUTS>;

export const SCENARIO_ID_TO_CORNER_NAME_ID: Record<string, CornerNameCalloutId> = {
  "pit-crew.corner-name-approaching": "corner-names",
};

export const CORNER_NAME_SCENARIO_IDS: readonly string[] = ["pit-crew.corner-name-approaching"];
