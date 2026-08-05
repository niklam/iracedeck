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
 * **Penalty wording (issue #922).** The spoken point count is composed from
 * the event payload's `delta` — the new points the translator actually
 * detected for the incident — never a constant assumed from the incident
 * type. iRacing's per-type point weights are NOT fixed across content
 * (dirt-road car contact scores 2x, not the road-racing 4x), and a
 * multi-step crash coalesces into one emission whose delta is the points the
 * episode scored in total (iRacing upgrades to the worst outcome — an
 * off-track that ends in the wall is 2x, not 1x + 2x) while carrying only
 * the latest type, so a number baked into a type pool's wording would
 * eventually disagree with the sim. Each
 * contact/collision scenario therefore plays a type-flavored intro with no
 * number, then a count clause resolved at speak time from the stashed delta
 * via `pool:incidents/points-<delta>` (the #836 value-pool form). The clause
 * is wrapped `{ optional: [...] }` (#835): a delta with no matching clip for
 * the active voice — or a missing/zero delta — skips the count locally and
 * the intro still plays, so the engineer states no count rather than a wrong
 * one. The off-track and out-of-control lines carry no count and are
 * unaffected.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { IncidentType, SimEventOf } from "@iracedeck/event-bus";

import type { Scenario, Step } from "../../dsl.js";
import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/**
 * Point delta of the incident fire most recently ADMITTED by a scenario's
 * `where:` predicate, read by the `incident.points` var resolver at
 * sequence-expansion time — var resolvers take no fire context (see
 * `IScenarioEngine.defineVar`), so the payload value is carried across
 * module scope, the same shape as the qualifying-invalidation per-lap latch.
 *
 * Only the MATCHING, fully-gated scenario writes the stash (the write sits
 * AFTER the type check): a dispatch in which nothing fires must not touch
 * it, because a fire that arrived while a lower-weight line held the bus
 * waits in the engine's pending slot with its expansion deferred to the
 * pending drain — which re-expands WITHOUT re-running `where:` — so a later
 * suppressed or non-matching event overwriting the stash would make that
 * queued fire speak the wrong count (issue #922 review). When a later
 * incident DOES fire, the same synchronous dispatch that rewrites the stash
 * also replaces the pending or in-flight family-mate, so stash and fire stay
 * in lockstep — that replacement relies on all six scenarios sharing
 * `family: "incident"` and the same (default) weight; keep both uniform.
 * Imperative `engine.fire()` bypasses `where:` entirely and would read a
 * stale value — no code path fires incident scenarios imperatively today.
 * `null` when the admitted payload carries no usable count (zero or
 * non-integer) — the count clause then skips via its optional group.
 */
let lastIncidentDelta: number | null = null;

/**
 * @internal Test hook — clears the stashed delta between tests.
 */
export function _resetLastIncidentDelta(): void {
  lastIncidentDelta = null;
}

/**
 * Register the incident count-clause variable on the scenario engine. Must
 * run before the {@link INCIDENT_ALERTS} scenarios are registered —
 * load-time validation rejects a `{ var }` step whose name isn't registered.
 */
export function registerIncidentVars(engine: IScenarioEngine): void {
  engine.defineVar("incident.points", () =>
    lastIncidentDelta === null ? null : poolRef("incidents", `points-${lastIncidentDelta}`),
  );
}

/**
 * The composed count clause (issue #922): "That cost us two penalty points."
 * etc., selected by the stashed event delta. Optional so an unresolvable
 * count skips the clause — never the whole callout — per #835.
 */
const POINTS_CLAUSE: Step = { optional: [{ var: "incident.points" }] };

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
      where: (e) => {
        const data = (e as SimEventOf<"incident.occurred">).data;

        if (data.type !== type) return false;

        // Stash the detected delta for the `incident.points` resolver — only
        // the matching, fully-gated scenario writes it, so a dispatch in
        // which nothing fires can't corrupt a queued fire's count (see
        // `lastIncidentDelta`).
        lastIncidentDelta = Number.isInteger(data.delta) && data.delta > 0 ? data.delta : null;

        return true;
      },
    },
  };
}

export const INCIDENT_ALERTS: readonly Scenario[] = [
  incidentScenario("off-track", "off-track", ["pool:incident-off-track"]),
  incidentScenario("out-of-control", "out-of-control", ["pool:incident-out-of-control"]),
  incidentScenario("contact-world", "contact-world", ["pool:incident-contact-world", POINTS_CLAUSE]),
  incidentScenario("collision-world", "collision-world", ["pool:incident-collision-world", POINTS_CLAUSE]),
  incidentScenario("contact-car", "contact-car", ["pool:incident-contact-car", POINTS_CLAUSE]),
  incidentScenario("collision-car", "collision-car", ["pool:incident-collision-car", POINTS_CLAUSE]),
];

/** Scenario ids exported for tests so a typo here surfaces as a test failure. */
export const INCIDENT_SCENARIO_IDS: readonly string[] = INCIDENT_ALERTS.map((s) => s.id);

/** Pool names this catalog draws from — kept here so tests can register them
 *  on the scenario engine without duplicating the list. The `points-<n>`
 *  count clips are NOT listed: they are dynamic value pools derived from the
 *  manifest at fire time (`pool:incidents/points-<n>`, issue #836), not
 *  registered pools. */
export const INCIDENT_POOL_NAMES: readonly string[] = [
  "incident-off-track",
  "incident-out-of-control",
  "incident-contact-world",
  "incident-collision-world",
  "incident-contact-car",
  "incident-collision-car",
];
