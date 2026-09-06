/**
 * Per-incident-type Race Engineer callouts (issue #530; scripted since
 * #1065).
 *
 * Six contracts — one per `IncidentType` discriminator emitted by the sim
 * translator — fire on `incident.occurred` filtered by `data.type`. The
 * translator already classifies the `irsdk_IncidentFlags` report byte and
 * suppresses unknown / Ongoing variants, so every event that reaches a
 * contract carries a known type. The translator also coalesces multi-step
 * incident bursts (off-track → out-of-control → collision) into a single
 * emission with the highest-scored type (ties → latest), so a quick crash
 * announces once rather than three times in a row; an escalation slow
 * enough to span announcement windows (#938) arrives as a second emission
 * whose family-preemption trumps the earlier line.
 *
 * The code below decides WHETHER and WHEN each line fires and how it is
 * scheduled; WHAT is said lives in the active voice's `callouts.json` under
 * the same ids (`scenarios["pit-crew.incident-off-track"]`, …), paired at
 * `setScripts` time. The bundled script addresses each type-flavored intro
 * directly as `pool:incidents/<type>`, and the four contact / collision
 * entries follow it with the `incident.points` var (registered by
 * {@link registerIncidentVocabulary}) inside an `optional` clause.
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
 * **Penalty wording (issues #922 / #938).** The spoken point count is
 * composed from the event payload's `points` — the incident's value as the
 * sim scores it (for iRacing, the Sporting Code §3.5.1 value of the
 * classified type, discipline-resolved by the translator: heavy car contact
 * is 4x on pavement but 2x on dirt) — never a constant assumed from the
 * incident type baked into clip wording (#922), and never the raw count
 * `delta` (#938): iRacing scores a multi-stage crash as ONE sequence that
 * escalates to its worst outcome, so the count moves by the MARGINAL
 * upgrade at each step and a delta-derived number under-reports whenever
 * the escalation spans announcement windows (an off-track that ends in the
 * wall seconds later moved the count by +1 for a 2x incident). A later,
 * worse emission for the same crash simply announces again with the
 * corrected value — `family: "incident"` preemption cuts the earlier line
 * if it is still playing. Each contact/collision script entry plays a
 * type-flavored intro with no number, then a count clause resolved at
 * speak time from the stashed points via `pool:incidents/points-<points>`
 * (the #836 value-pool form). The clause is a WHOLE clause ("That cost us
 * two penalty points.") and is wrapped `optional` in the bundled script
 * (#835): a points value with no matching clip for the active voice — or a
 * missing/zero value (light contacts) — skips the count and the intro
 * still plays, so the engineer states no count rather than a wrong one.
 * The off-track and out-of-control lines carry no count and are
 * unaffected.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { IncidentType, SimEventOf } from "@iracedeck/event-bus";

import type { ScenarioContract } from "../../dsl.js";
import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/**
 * Points value of the incident fire most recently ADMITTED by a contract's
 * `where:` predicate, read by the `incident.points` var resolver at
 * sequence-expansion time. The payload value is carried across module
 * scope, the same shape as the qualifying-invalidation per-lap latch: a
 * resolver does receive the fire context since #1065, but a QUEUED fire's
 * deferred re-expansion is where the stash earns its keep (below), and
 * the stash is what both paths read.
 *
 * Only the MATCHING, fully-gated contract writes the stash (the write sits
 * AFTER the type check): a dispatch in which nothing fires must not touch
 * it, because a fire that arrived while a lower-weight line held the bus
 * waits in the engine's pending slot with its expansion deferred to the
 * pending drain — which re-expands WITHOUT re-running `where:` — so a later
 * suppressed or non-matching event overwriting the stash would make that
 * queued fire speak the wrong count (issue #922 review). When a later
 * incident DOES fire, the same synchronous dispatch that rewrites the stash
 * also replaces the pending or in-flight family-mate, so stash and fire stay
 * in lockstep — that replacement relies on all six contracts sharing
 * `family: "incident"` and the same (default) weight; keep both uniform.
 * Imperative `engine.fire()` bypasses `where:` entirely and would read a
 * stale value — no code path fires incident contracts imperatively today.
 * `null` when the admitted payload carries no usable count (zero or
 * non-integer — light contacts report `points: 0`) — the count clause then
 * skips via the script's optional group.
 */
let lastIncidentPoints: number | null = null;

/**
 * @internal Test hook — clears the stashed points between tests.
 */
export function _resetLastIncidentPoints(): void {
  lastIncidentPoints = null;
}

/**
 * Register the vocabulary the incident scripts reference (issue #1065): the
 * count-clause var. Must run before the {@link INCIDENT_CONTRACTS} are
 * defined so the first `setScripts` compile sees it.
 */
export function registerIncidentVocabulary(engine: Pick<IScenarioEngine, "defineVar">): void {
  engine.defineVar(
    "incident.points",
    () => (lastIncidentPoints === null ? null : poolRef("incidents", `points-${lastIncidentPoints}`)),
    'The penalty points the incident cost, as the sim scored it, spoken as a whole clause from the incidents group (incidents/points-2 is "That cost us two penalty points."). Nothing for a light contact worth no points, or for a count the voice has no clip for — a whole clause, so a script may make it optional and the type line still stands on its own.',
  );
}

/**
 * Each contract's `description` (#1066): the sim moment per incident type.
 * The translator waits for a crash sequence to go quiet (about a second and
 * a half) and reports its worst outcome, so every sentence says what must
 * NOT follow for that type to be the one spoken — the reason a light contact
 * that ends in the wall never plays the contact line.
 */
const INCIDENT_DESCRIPTIONS: Record<IncidentType, string> = {
  "off-track":
    "You run all four wheels off the track in any session outside the pits, and nothing worse follows within a second or two; on a timed qualifying lap the lap-invalidated line speaks first.",
  "out-of-control":
    "You lose control of the car — a spin — in any session outside the pits, and nothing worse follows within a second or two.",
  "contact-world":
    "You brush a wall or a trackside object lightly in any session outside the pits, with no harder hit following within a second or two.",
  "collision-world":
    "You hit a wall or a trackside object hard enough for iRacing to score it as a collision, in any session outside the pits, with no car collision following within a second or two.",
  "contact-car":
    "You make light contact with another car in any session outside the pits, with no heavier collision following within a second or two.",
  "collision-car":
    "You collide heavily with another car in any session outside the pits — the worst outcome a crash sequence can reach, called once the sequence has settled.",
};

function incidentContract(id: string, type: IncidentType): ScenarioContract {
  return {
    id: `pit-crew.incident-${id}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "incident",
    description: INCIDENT_DESCRIPTIONS[type],
    when: {
      event: "incident.occurred",
      // No session-type gate here. In qualifying sessions, the
      // `pit-crew.qualifying-invalidation-lap-invalidated` contract (#567) is
      // registered BEFORE these incidents in `index.ts` and grabs the Voice
      // bus first on a valid flying lap, so the incident contract's
      // attemptFire is dropped by the bus-busy check. On out-laps,
      // post-pit-exit laps, race / practice sessions, and any other case
      // where the qualifying contract's `where:` returns false, this contract
      // fires normally — the driver still hears generic coaching.
      where: (e) => {
        const data = (e as SimEventOf<"incident.occurred">).data;

        if (data.type !== type) return false;

        // Stash the payload's points for the `incident.points` resolver —
        // only the matching, fully-gated contract writes it, so a dispatch
        // in which nothing fires can't corrupt a queued fire's count (see
        // `lastIncidentPoints`).
        lastIncidentPoints = Number.isInteger(data.points) && data.points > 0 ? data.points : null;

        return true;
      },
    },
  };
}

export const INCIDENT_CONTRACTS: readonly ScenarioContract[] = [
  incidentContract("off-track", "off-track"),
  incidentContract("out-of-control", "out-of-control"),
  incidentContract("contact-world", "contact-world"),
  incidentContract("collision-world", "collision-world"),
  incidentContract("contact-car", "contact-car"),
  incidentContract("collision-car", "collision-car"),
];

/** Contract ids exported for tests so a typo here surfaces as a test failure. */
export const INCIDENT_SCENARIO_IDS: readonly string[] = INCIDENT_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the incident scripts draw from — every
 * `pool:incidents/<base>` the bundled script may write, as a literal list.
 * The completeness tests read it: the bundled voice must ship at least one
 * clip for each, and the bundled script must reference exactly this set.
 * The `points-<n>` count clips are NOT sources: they are the
 * `incident.points` var, a value pool derived from the manifest at fire time
 * (issue #836).
 */
export const INCIDENT_CLIP_SOURCES: readonly { group: "incidents"; base: string }[] = [
  { group: "incidents", base: "off-track" },
  { group: "incidents", base: "out-of-control" },
  { group: "incidents", base: "contact-world" },
  { group: "incidents", base: "collision-world" },
  { group: "incidents", base: "contact-car" },
  { group: "incidents", base: "collision-car" },
];
