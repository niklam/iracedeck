/**
 * Position-change callout — issue #566; scripted since #1065.
 *
 * Fires on `lap.completed` when the driver's position changed compared to
 * the previous completed lap. Plays AFTER the lap-time best-lap callout
 * (#555) on laps that produce both, via the engine's **deferred-low**
 * mechanism — NOT via registration order.
 *
 * Why `weight: WEIGHT.CHATTER` + `queueable: true`: when two cross-family
 * default-weight contracts fire on the same event, the scenario engine
 * (`interpreter.ts` `attemptFire`) starts the first one and **silently drops**
 * the second (`bus busy`, no preemption rule matches). A `queueable` contract
 * is *deferred* and replayed once the bus goes idle (see `finishFire` →
 * `drainPending`). Lap-time stays default `WEIGHT.NORMAL`; position is
 * `WEIGHT.CHATTER` + `queueable: true` so it queues behind. The deferred replay
 * carries the original event payload, and the vocabulary reads THAT payload
 * (`ctx.data`, see `snapshotOf`), so the replay speaks the lap that fired it.
 *
 * Both contracts share the `lap.completed` trigger but sit on different
 * families (`lap-time` vs `position`), so neither preempts the other.
 *
 * The code decides WHETHER and WHEN the callout fires; WHAT it says is the
 * active voice's `callouts.json` under the same id
 * (`scenarios["pit-crew.position-change"]`), paired at `setScripts` time.
 * The bundled script is one `case` on `position.readoutShape` — the three
 * mutually exclusive shapes the closures used to pick with nested `if`s:
 *
 *   invalid-lap  <didn't count>  "That lap didn't count."  (pool:position-invalid-lap/that-lap-didnt-count)
 *                <currently>     "We're currently"        (pool:position-intro-worse/currently; invalid laps
 *                                                          never get the "better" framing or pole)
 *                <number>        pee one / pee two / … / pee sixty four  ({{position.number}})
 *   pole         <pole>          "That puts us on pole."  ({{position.pole}}, self-contained)
 *   standard     <intro>         that-puts-us-to  OR  currently  ({{position.intro}})
 *                <number>        pee one / … / pee sixty four   ({{position.number}})
 *
 * The engine wraps the body in the voice's radio frame. The shape is a case
 * rather than two conditions because exactly one applies per lap and a pack
 * may phrase each independently; the vocabulary is registered by
 * {@link registerPositionVocabulary}:
 *   - **Qualifying**: driver gained positions OR `previousPosition` is unset
 *     (first valid lap — `isFirstValid: true` aligns with #555) →
 *     "That puts us to <break /> pee N." ("better" intro). Driver lost
 *     positions OR position unchanged on a non-PB lap → "We're currently
 *     <break /> pee N." ("worse" intro). Position unchanged on a PB lap →
 *     `where:` short-circuits, contract silent (lap-time-best already
 *     narrates the lap). Improvement to effective P1 in qualifying →
 *     "That puts us on pole." (one clip, no number — the pole shape).
 *     Invalidated qualifying lap (`lapIsValid === false`, issue #572) →
 *     "That lap didn't count. We're currently <break /> pee N." — the
 *     invalid-lap shape beats the pole / "better" shapes unconditionally.
 *   - **Race** (issue #569): every direction uses the "currently" intro —
 *     race standings don't follow from lap times, so "That puts us to P3"
 *     reads wrong; "We're currently P3" works whether you gained or lost
 *     the place. The pole shape is never taken (qualifying-only).
 *     Hold-position status is owned by the every-3-laps race-status
 *     callout; the position-change callout in race fires only on real
 *     changes.
 *
 * The "effective" position picks between class and overall based on the
 * payload's `isMultiClass` flag (translator-resolved from session info):
 *   - Multi-class series → `classPosition` (drivers in multi-class care
 *     about their class standing, not the overall mixed-field order).
 *   - Single-class → `position` (overall).
 *
 * The var and case resolvers read the `lap.completed` payload of the fire
 * itself (`ctx.data`) — the same payload the `where:` decided on — and fall
 * back to the plugin's most recent `lap.completed` snapshot (the closure
 * shared with the lap-time contract) only for a fire with no such event
 * behind it, an imperative `fire(id)`. A deferred replay therefore speaks
 * the frozen lap's position rather than whatever position the driver holds
 * when the engineer finally gets bus time — and rather than whatever lap
 * the plugin's snapshot has moved on to.
 *
 * `where:` filters:
 *   - **Qualifying or race** — qualifying fires on every lap update
 *     (improvement, worsening, or hold-status on a non-PB lap). Race only
 *     fires on real changes (improvement / worsening / first-fix); the
 *     hold-position status is owned by the every-3-laps race-status callout
 *     (issue #569) so we don't double-narrate. Practice / test stay silent.
 *     See `isAnnounceableSessionType` for the rationale.
 *   - A position with no `position-number` clip for the active voice aborts
 *     the whole callout at expansion (issues #835/#836) — the clips that
 *     exist define the speakable range; never a partial readout.
 *   - Position change detected OR (qualifying only) position unchanged on a
 *     non-PB lap (the status-update path; see `positionChangeIsAnnounceable`).
 *
 * Sentinel: when neither overall nor class position is populated (e.g.
 * `PlayerCarPosition === 0` on a session reset), the contract does NOT
 * fire; the var resolver returning `null` is a defense-in-depth guard.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import { poolRef, WEIGHT } from "../../dsl.js";
import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import {
  liveCurrentlyAnnounceable,
  type LivePositionResolver,
  selectLivePosition,
  tryClaimPositionAnnouncement,
} from "./position-readout.js";

/**
 * Resolver for the most recent `lap.completed` payload — shared with the
 * lap-time contract (same data, same cache, different consumers). The
 * plugin owns the cache; the contracts just read.
 */
export type LapCompletedSnapshotResolver = () => SimEventOf<"lap.completed">["data"] | null;

const POSITION_GROUP_INTRO_BETTER = "position-intro-better";
const POSITION_GROUP_INTRO_WORSE = "position-intro-worse";
const POSITION_GROUP_INTRO_POLE = "position-intro-pole";
const POSITION_GROUP_NUMBER = "position-number";

/**
 * Pick the position pair the engineer should announce. Multi-class series
 * read class-position; single-class (or unknown) read overall. Returns
 * `null` when neither side is available — the contract stays silent.
 */
export function selectEffectivePosition(
  snapshot: SimEventOf<"lap.completed">["data"],
): { current: number; previous: number | undefined } | null {
  const useClass = snapshot.isMultiClass === true;
  const current = useClass ? snapshot.classPosition : snapshot.position;
  const previous = useClass ? snapshot.previousClassPosition : snapshot.previousPosition;

  if (typeof current !== "number" || current <= 0) return null;

  return { current, previous: typeof previous === "number" && previous > 0 ? previous : undefined };
}

/**
 * Whether a position callout should fire for this snapshot. Four trigger
 * cases (always require an in-range position):
 *   - **First fix** — no `previousPosition` baseline (e.g. driver's first
 *     valid lap of the session): speak as "better" — "That puts us to P[N]".
 *   - **Improved** — `current < previous`: speak as "better".
 *   - **Worsened** — `current > previous`: speak as "worse" — "We're currently P[N]".
 *   - **Unchanged on a non-PB lap** — `current === previous && !isBest`:
 *     speak as "worse" — "We're currently P[N]". This is the "status update"
 *     case (every lap gets some feedback; a slow lap that holds position
 *     still confirms standings to the driver).
 *
 * **Unchanged on a PB lap** stays silent — `lap-time-best` already speaks for
 * that lap ("That was your best lap yet. 1:23.4."). Stacking a "P5"
 * status on top would be redundant noise.
 */
export function positionChangeIsAnnounceable(snapshot: SimEventOf<"lap.completed">["data"]): boolean {
  const effective = selectEffectivePosition(snapshot);

  if (!effective) return false;

  if (effective.previous === undefined) {
    // No baseline — first fix, speak as better.
    return true;
  }

  if (effective.current !== effective.previous) {
    // Position changed (improved or worsened).
    return true;
  }

  // Position unchanged. In race, the every-3-laps race-status callout
  // (issue #569) owns the hold-position status updates, so we stay silent
  // here to avoid stacking two callouts on the same lap. In qualifying the
  // status update fires unless lap-time-best is already handling this lap
  // (PB or first-valid): `isBest === true` is the condition lap-time-best
  // fires on; `isFirstValid` always coincides with `isBest`, so checking
  // `isBest` alone is sufficient to avoid double-narrating.
  if (snapshot.sessionType === "race") return false;

  return snapshot.isBest !== true;
}

/**
 * Whether the snapshot represents a position improvement (or first fix).
 * Drives intro selection: `true` → "better" intro, `false` → "worse".
 */
function isBetterChange(snapshot: SimEventOf<"lap.completed">["data"]): boolean {
  const effective = selectEffectivePosition(snapshot);

  if (!effective) return false;

  if (effective.previous === undefined) return true;

  return effective.current < effective.previous;
}

/**
 * Whether the snapshot represents the driver achieving pole position in
 * qualifying — i.e. an improvement to the effective P1. Triggers a
 * dedicated "That puts us on pole." line instead of the generic
 * "That puts us to P1.".
 *
 * Conditions:
 *   - Session type is qualifying (the only session the contract fires in
 *     at all; this check is technically redundant after
 *     `isAnnounceableSessionType` but kept as a self-documenting guard).
 *   - Effective current position is 1.
 *   - It's an improvement: no prior baseline OR previous > current. Holding
 *     P1 on a slow lap stays on the standard status line ("We're currently
 *     P1") because the user has already heard the pole call.
 */
function isPoleAchievement(snapshot: SimEventOf<"lap.completed">["data"]): boolean {
  if (snapshot.sessionType !== "qualifying") return false;

  const effective = selectEffectivePosition(snapshot);

  if (!effective) return false;

  if (effective.current !== 1) return false;

  // Improvement to P1 (or first fix at P1) — "on pole". Holding P1 falls
  // through to the standard status line.
  return effective.previous === undefined || effective.current < effective.previous;
}

/**
 * Whether the snapshot is in a session type that should produce a position
 * callout. **Qualifying and race** — in qualifying every lap update fires
 * (improvement, worsening, or status hold on a non-PB lap); in race only
 * the real change cases fire (issue #569) because the every-3-laps
 * race-status callout owns the hold-position status updates. Practice and
 * test sessions stay silent. `undefined` (unresolved session info) defaults
 * to silent so a misconfigured tick never produces an unintended fire.
 */
function isAnnounceableSessionType(snapshot: SimEventOf<"lap.completed">["data"]): boolean {
  return snapshot.sessionType === "qualifying" || snapshot.sessionType === "race";
}

/**
 * The keys of the `position.readoutShape` case — the closed set of shapes a
 * position readout takes. Published with the case, so the type is the
 * declared key set and nothing else.
 */
export type PositionReadoutShape = "invalid-lap" | "pole" | "standard";

/**
 * The declared key set of `position.readoutShape`, each with the description
 * the generated reference (#1066) shows a pack author.
 *
 * @internal Exported for testing — the test enumerates the reachable
 * snapshots and checks the resolver returns nothing outside this set.
 */
export const POSITION_READOUT_SHAPE_KEYS: Readonly<Record<PositionReadoutShape, string>> = {
  "invalid-lap":
    "A qualifying lap iRacing did not count (track limits, a pit-lane violation) — the didn't-count line, then the current position with the plain intro; never the pole line or the better framing.",
  pole: "An improvement to first place in qualifying — the lap put the driver on pole, said as one self-contained line with no number.",
  standard:
    "Any other readout — the intro (that-puts-us-to for a gain in qualifying, we're-currently otherwise) and the position number.",
};

/**
 * The readout shape for a snapshot, in the closures' precedence: the
 * invalid-lap shape beats everything (issue #572 — an invalid lap can't earn
 * a "better" framing even if standings shifted from others' laps), then the
 * qualifying pole shape, then the standard intro + number. `null` with no
 * snapshot — the case then takes the script's `default` branch, which the
 * bundled script leaves absent, so nothing plays: the same silence the
 * closures produced when their var resolvers found no snapshot.
 *
 * @internal Exported for testing.
 */
export function resolvePositionReadoutShape(
  snapshot: SimEventOf<"lap.completed">["data"] | null,
): PositionReadoutShape | null {
  if (!snapshot) return null;

  if (snapshot.sessionType === "qualifying" && snapshot.lapIsValid === false) return "invalid-lap";

  if (isPoleAchievement(snapshot)) return "pole";

  return "standard";
}

/**
 * The lap snapshot a fire is about: the fire's own `lap.completed` payload
 * when it has one — a deferred replay keeps its event, so this is the lap
 * that fired it however many laps the plugin's snapshot has moved on by —
 * else the plugin's latest snapshot, for an imperative fire.
 */
function snapshotOf(ctx: ScenarioContext, getSnapshot: LapCompletedSnapshotResolver) {
  return ctx.event?.event === "lap.completed" ? (ctx.data as SimEventOf<"lap.completed">["data"]) : getSnapshot();
}

/**
 * Register the vocabulary the position-change script references (issue
 * #1065): the readout-shape case and the three vars. Must run before
 * {@link buildPositionContract} is registered so the first `setScripts`
 * compile sees them. Every resolver reads the fire's own lap payload at
 * expansion time (`snapshotOf`); the race number reads the live position
 * (issue #574).
 */
export function registerPositionVocabulary(
  engine: Pick<IScenarioEngine, "defineVar" | "defineCase">,
  getSnapshot: LapCompletedSnapshotResolver,
  getLivePosition: LivePositionResolver = () => null,
): void {
  engine.defineCase(
    "position.readoutShape",
    (ctx) => resolvePositionReadoutShape(snapshotOf(ctx, getSnapshot)),
    POSITION_READOUT_SHAPE_KEYS,
    "Which shape the position readout takes for the lap just completed: an invalidated qualifying lap, a lap that put the driver on pole, or the standard intro and number. Exactly one applies per lap; the invalid-lap shape takes precedence.",
  );

  engine.defineVar(
    "position.intro",
    (ctx) => {
      const s = snapshotOf(ctx, getSnapshot);

      if (!s) return null;

      // In race, force the "currently" intro for every direction (issue #569).
      // "That puts us to P3" implies lap-times-drive-standings — true in
      // qualifying, semantically wrong in race where position changes from
      // overtakes and pit stops rather than from the lap just completed.
      // "We're currently P3" reads correctly as a standings status regardless
      // of whether you gained or lost the place.
      if (s.sessionType === "race") {
        return poolRef(POSITION_GROUP_INTRO_WORSE, "currently");
      }

      return isBetterChange(s)
        ? poolRef(POSITION_GROUP_INTRO_BETTER, "that-puts-us-to")
        : poolRef(POSITION_GROUP_INTRO_WORSE, "currently");
    },
    "The lead-in of a position readout, chosen by what the lap did: position-intro-better/that-puts-us-to for a gain (or a first fix) in qualifying, position-intro-worse/currently for a loss, a held place, or any lap in a race, where standings do not follow from lap times. A fragment of the sentence — keep it required before position.number.",
  );

  engine.defineVar(
    "position.number",
    (ctx) => {
      const s = snapshotOf(ctx, getSnapshot);

      if (!s) return null;

      // Race: read the position LIVE at speak-time (issue #574) so a deferred
      // readout reflects the position NOW, not the value frozen at S/F. The
      // change-detection in `where:` still uses the snapshot — live drives only
      // the spoken number.
      if (s.sessionType === "race") {
        const n = selectLivePosition(getLivePosition());

        return n !== null ? poolRef(POSITION_GROUP_NUMBER, String(n)) : null;
      }

      // Qualifying: the "that puts us to / on pole" flow needs the before/after
      // comparison, so it stays on the frozen lap snapshot.
      const effective = selectEffectivePosition(s);

      return effective ? poolRef(POSITION_GROUP_NUMBER, String(effective.current)) : null;
    },
    'The driver\'s position as a spoken number, drawn from the position-number group (position-number/4 is "P4"): the position the lap just completed left the driver in during qualifying, and the live position at the moment it is spoken during a race — class position in a multi-class session either way. The point of the readout, so a script keeps it required.',
  );

  // Self-contained "That puts us on pole." clip — replaces both the intro
  // and the number when the qualifying-pole shape applies. See
  // `isPoleAchievement` for the trigger conditions.
  engine.defineVar(
    "position.pole",
    (ctx) => {
      const s = snapshotOf(ctx, getSnapshot);

      if (!s) return null;

      return poolRef(POSITION_GROUP_INTRO_POLE, "that-puts-us-on-pole");
    },
    'The self-contained pole line, position-intro-pole/that-puts-us-on-pole ("That puts us on pole.") — a complete sentence that replaces the intro and the number when the lap put the driver on pole in qualifying.',
  );
}

/**
 * Build the position-change contract. Takes an optional `getRaceFinishedFired`
 * so the `where:` short-circuits on the final lap of a race (issue #569) and
 * the live-position resolver the race path gates on (issue #574). Without the
 * race-finished gate, a position change on the final lap would queue "We're
 * currently P[n]" behind race-end and play after the result speech — same
 * `weight: WEIGHT.CHATTER` + `queueable: true` as race-end with no shared
 * family, so the engine defers but does not drop it. Default `() => false`
 * (race never ends) preserves legacy behavior for tests / qualifying. The
 * snapshot resolver is NOT a contract dep any more: the `where:` decides from
 * the event payload, and every shape decision the closures made from the
 * snapshot is the vocabulary's ({@link registerPositionVocabulary}).
 */
export function buildPositionContract(
  getRaceFinishedFired: () => boolean = () => false,
  getLivePosition: LivePositionResolver = () => null,
): ScenarioContract {
  return {
    id: "pit-crew.position-change",
    description:
      "You finish a qualifying or race lap in a new position, or your first timed lap; a held place counts only on a non-best qualifying lap; in a race, no position readout in the past twenty seconds.",
    when: {
      event: "lap.completed",
      where: (ev) => {
        if (ev.event !== "lap.completed") return false;

        const data = ev.data as SimEventOf<"lap.completed">["data"];

        if (!isAnnounceableSessionType(data)) return false;

        // Change-detection (improved / worsened / first-fix / qualifying hold)
        // is decided from the frozen lap snapshot.
        if (!positionChangeIsAnnounceable(data)) return false;

        // Qualifying path: snapshot drives both the decision and the readout.
        if (data.sessionType !== "race") return true;

        // Race path (issue #574): the spoken number is read LIVE at speak-time,
        // so gate on the live position being readable + share the cooldown.
        //
        // Race finished — defer to race-end (issue #569). The diff sets the
        // latch synchronously before publishing `lap.completed`, so by the
        // time this where: runs the latch reads true on the final lap.
        if (getRaceFinishedFired()) return false;

        if (!liveCurrentlyAnnounceable(getLivePosition())) return false;

        // LAST gate: claim the shared position cooldown only when committing.
        return tryClaimPositionAnnouncement();
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    // `weight: WEIGHT.CHATTER` + `queueable: true` so the engine *defers* this
    // contract when the bus is busy (typically because the lap-time-best callout
    // fires on the same `lap.completed` event and grabs the Voice bus first).
    // Without `queueable`, a default-weight contract would hit the
    // dropped-on-busy-bus path in `interpreter.ts` `attemptFire` and the user
    // would never hear the position update on a PB lap. See the file header for
    // the full rationale.
    weight: WEIGHT.CHATTER,
    queueable: true,
    family: "position",
  };
}

/**
 * Stable identifier for the position-change callout (issue #566). Single
 * subject — `change` covers improvement, worsening, and first-fix
 * (intro selection happens inside the script's case).
 */
export type PositionCalloutId = "change";

/**
 * Canonical mapping from `PositionCalloutId` to its plugin-global setting
 * key in `GlobalSettingsSchema`. Plugin entry points use this to read the
 * live opt-in without duplicating the key string.
 */
export const POSITION_CALLOUT_SETTING_KEYS: Record<PositionCalloutId, string> = {
  change: "calloutEnabledPositionChange",
};

// `as const` so the element type is a literal union the `SCENARIO_ID_TO_POSITION_ID`
// map below can be typed against — TS errors out at build time if a contract id
// is renamed, missing, or extra. Cheaper than a runtime completeness assertion.
export const POSITION_SCENARIO_IDS = ["pit-crew.position-change"] as const;

export const SCENARIO_ID_TO_POSITION_ID: Record<(typeof POSITION_SCENARIO_IDS)[number], PositionCalloutId> = {
  "pit-crew.position-change": "change",
};

/**
 * The clip sources the bundled position script addresses DIRECTLY — the two
 * fixed lines of the invalid-lap shape, which never vary with the lap
 * (issue #572). Everything else the readout says reaches the script through
 * the `position.*` vars, which draw from `position-intro-better`,
 * `position-intro-worse`, `position-intro-pole` and `position-number` at
 * speak time. The completeness tests pin the script's pool references to
 * exactly this list and each entry to a clip in the bundled voice.
 */
export const POSITION_CLIP_SOURCES: readonly {
  group: "position-invalid-lap" | "position-intro-worse";
  base: string;
}[] = [
  { group: "position-invalid-lap", base: "that-lap-didnt-count" },
  { group: "position-intro-worse", base: "currently" },
];
