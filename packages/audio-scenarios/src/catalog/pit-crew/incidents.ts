/**
 * Per-incident-type Race Engineer callouts (issue #530).
 *
 * Six scenarios — one per `IncidentType` discriminator emitted by the sim
 * translator — fire on `incident.occurred` filtered by `data.type`. The
 * translator already classifies the `irsdk_IncidentFlags` report byte and
 * suppresses unknown / Ongoing variants, so every event that reaches a
 * scenario carries a known type. The translator also coalesces multi-step
 * incident bursts (off-track → out-of-control → collision) into a single
 * emission with the most-recent type, so the engineer announces once per
 * crash rather than three times in a row.
 *
 * **Family preemption.** All six share `family: "incident"` so a fast
 * sequence (light contact → harder collision a second later) supersedes
 * the in-flight callout cleanly — same mechanism the flag and pit-status
 * callouts use.
 *
 * **Cross-family weight.** Default weight (`WEIGHT.NORMAL`) means
 * higher-weight flags (meatball at `WEIGHT.CRITICAL`) still win the bus over
 * these; an in-flight lower-weight pit readback is replaced by a fresh
 * incident.
 *
 * **Penalty wording.** Collision lines mention the deterministic penalty
 * point count inline ("…cost us four penalty points"). iRacing's
 * `irsdk_IncidentFlags` enum locks the points per type
 * (`CollisionWithWorld` is always 2x, `CollisionWithCar` is always 4x),
 * so each pool's text is shaped around its known penalty count — no
 * separate penalty follow-on pool is needed.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { IncidentType, SimEventOf } from "@iracedeck/event-bus";

import type { Scenario, Step } from "../../dsl.js";

function incidentScenario(id: string, type: IncidentType, body: Step[]): Scenario {
  return {
    id: `pit-crew.incident-${id}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "incident",
    sequence: ["@pit-crew.radio-open", ...body, "@pit-crew.radio-close"],
    when: {
      event: "incident.occurred",
      // No session-type gate here. In qualifying sessions, the
      // `pit-crew.qualifying-invalidation-lap-invalidated` scenario (#567) is
      // registered BEFORE these incidents in `index.ts` and grabs the Voice
      // bus first on a valid flying lap, so the incident scenario's
      // attemptFire is dropped by the bus-busy check. On out-laps,
      // post-pit-exit laps, race / practice sessions, and any other case
      // where the qualifying scenario's `where:` returns false, this scenario
      // fires normally — the driver still hears generic coaching.
      where: (e) => (e as SimEventOf<"incident.occurred">).data.type === type,
    },
  };
}

export const INCIDENT_ALERTS: readonly Scenario[] = [
  incidentScenario("off-track", "off-track", ["pool:incident-off-track"]),
  incidentScenario("out-of-control", "out-of-control", ["pool:incident-out-of-control"]),
  incidentScenario("contact-world", "contact-world", ["pool:incident-contact-world"]),
  incidentScenario("collision-world", "collision-world", ["pool:incident-collision-world"]),
  incidentScenario("contact-car", "contact-car", ["pool:incident-contact-car"]),
  incidentScenario("collision-car", "collision-car", ["pool:incident-collision-car"]),
];

/** Scenario ids exported for tests so a typo here surfaces as a test failure. */
export const INCIDENT_SCENARIO_IDS: readonly string[] = INCIDENT_ALERTS.map((s) => s.id);

/** Pool names this catalog draws from — kept here so tests can register them
 *  on the scenario engine without duplicating the list. */
export const INCIDENT_POOL_NAMES: readonly string[] = [
  "incident-off-track",
  "incident-out-of-control",
  "incident-contact-world",
  "incident-collision-world",
  "incident-contact-car",
  "incident-collision-car",
];
