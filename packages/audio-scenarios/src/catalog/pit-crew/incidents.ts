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
 * **Scheduling (issue #1211).** All six are `queueable` at the default
 * weight (`WEIGHT.NORMAL`). Until #1211 they were not, and a fire that could
 * not take the Voice bus was dropped: below the spotter's focus floor (held
 * at `WEIGHT.SAFETY` while a car is alongside, which is when nearly every car
 * collision happens), or behind any equal-weight line of another family
 * playing (a damage or furled-flag line, or a caution call at `WEIGHT.SAFETY`
 * landing in the same seconds). Now such a fire waits in the engine's one
 * pending slot and plays when the floor releases or the bus idles. The one
 * slot is the engine's limit (#1185 owns it): a heavier queueable fire (a
 * penalty flag, a SAFETY fuel tier, opponent-pit, pit-window) or an
 * equal-weight one arriving later (a NORMAL fuel tier at start/finish)
 * displaces a waiting incident line; lighter chatter never does. The weight
 * stays NORMAL on purpose — at the floor's weight or above, the line would
 * break through the floor and talk over the alongside moment it exists to
 * protect.
 *
 * A waiting line goes stale, so each contract's `speakGate` refuses a fire
 * whose event is more than {@link INCIDENT_SPEAK_MAX_AGE_MS} old when it
 * comes to speak: past that, a new, unrelated incident may already have
 * begun, and a late line would be heard as describing it. An imperative
 * `fire(id)` carries no event and is admitted (the harness buttons). A line
 * cut mid-play by an `interrupt` replays whole without asking the gate again
 * (#1138's contract for an admitted fire) — accepted, since the driver
 * already heard it begin. `pendingHoldMs` is not used: incidents are not a
 * train of related fires, and the translator's burst coalescing already
 * merges a crash into one emission.
 *
 * **Family preemption, and escalation.** All six share `family: "incident"`
 * so a fast sequence (light contact → harder collision a second later)
 * supersedes the in-flight callout cleanly — same mechanism the flag and
 * pit-status callouts use. Preemption applies to the PLAYING line only; an
 * escalation that finds the earlier incident WAITING replaces it in the
 * pending slot by the engine's tie rule (equal weight, newest wins), so the
 * driver hears the escalation's corrected points once, never both lines. The
 * damage line (`damage-alerts.ts`) waits behind whichever incident line is
 * waiting, the escalation included.
 *
 * **Qualifying (issue #1211).** On a counted flying lap the
 * lap-invalidation line (`qualifying-invalidation.ts`) supersedes this
 * generic coaching (#567). Its `where:` records the timestamp of the
 * `incident.scored` it approved, and these `where:`s refuse an
 * `incident.occurred` carrying the same timestamp — the same translator
 * flush. Before #1211 that precedence rested on the qualifying line taking an
 * idle bus first; once the incident lines queue, that race would park them
 * behind it (a double-up) or, under the floor, play them alone while the
 * non-queueable qualifying line was dropped.
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

import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import { qualifyingApprovedBurstAt } from "./qualifying-invalidation.js";

/**
 * How old an incident fire's event may be when the line comes to speak
 * (issue #1211). A line waiting behind the spotter's floor or a busy bus past
 * this is refused: the incident chain it describes has closed, a new one may
 * have begun, and the late line would be heard as describing that. Measured
 * from the envelope `timestamp`, the translator's flush tick — itself about a
 * second and a half after the last count increment. Equal to #1122's
 * `INCIDENT_SEQUENCE_GAP_MS` by reasoning, not by import: the two answer
 * different questions and may diverge. What would set it properly: the
 * distribution, over race sessions with debug logging on, of the time from
 * `Scenario "pit-crew.incident-…" pending` to its replay, plus a listening
 * check of how late a line can arrive before it reads as a new incident.
 */
export const INCIDENT_SPEAK_MAX_AGE_MS = 10_000;

/**
 * The incident contracts' speak-time gate (issue #1211): the fire's event is
 * no older than {@link INCIDENT_SPEAK_MAX_AGE_MS}. An imperative `fire(id)`
 * carries no event and is admitted, which keeps the harness buttons working.
 * Pure — it claims nothing.
 *
 * @internal Exported for tests.
 */
export function incidentStillFresh(ctx: ScenarioContext): boolean {
  if (ctx.event === null) return true;

  return ctx.now - ctx.event.timestamp <= INCIDENT_SPEAK_MAX_AGE_MS;
}

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
 * AFTER the type check and the qualifying yield): a dispatch in which nothing
 * fires must not touch it, because a fire waiting in the engine's pending
 * slot — every incident line is queueable since #1211 — has its expansion
 * deferred to the pending drain, which re-expands WITHOUT re-running
 * `where:`, so a later suppressed or non-matching event overwriting the stash
 * would make that queued fire speak the wrong count (issue #922 review). When
 * a later incident DOES fire, the same synchronous dispatch that rewrites the
 * stash also replaces the pending or in-flight family-mate (the tie rule in
 * the slot, family preemption on the bus), so stash and fire stay in
 * lockstep — that replacement relies on all six contracts sharing
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
    "You run all four wheels off the track in any session outside the pits, and nothing worse follows within a second or two; on a timed qualifying lap the lap-invalidated line speaks instead.",
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
    // Wait for a held or busy bus rather than drop (issue #1211; see the header).
    queueable: true,
    when: {
      event: "incident.occurred",
      // No session-type gate here. In qualifying sessions, the
      // `pit-crew.qualifying-invalidation-lap-invalidated` contract (#567)
      // fires on `incident.scored`, which the translator publishes BEFORE
      // this event on the same flush (#1122); when it approved that burst,
      // this line yields to it (#1211). On out-laps, post-pit-exit laps,
      // race / practice sessions, and any other case where the qualifying
      // contract's `where:` returns false, this contract fires normally —
      // the driver still hears generic coaching.
      where: (e) => {
        const event = e as SimEventOf<"incident.occurred">;
        const data = event.data;

        if (data.type !== type) return false;

        // The lap-invalidation line approved this same flush (issue #1211).
        if (qualifyingApprovedBurstAt(event.timestamp)) return false;

        // Stash the payload's points for the `incident.points` resolver —
        // only the matching, fully-gated contract writes it, AFTER every
        // refusal, so a dispatch in which nothing fires can't corrupt a
        // queued fire's count (see `lastIncidentPoints`).
        lastIncidentPoints = Number.isInteger(data.points) && data.points > 0 ? data.points : null;

        return true;
      },
    },
    speakGate: {
      description: "The incident was reported no more than ten seconds before the call comes to speak.",
      admit: incidentStillFresh,
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
