/**
 * Position-change callout — issue #566.
 *
 * Fires on `lap.completed` when the driver's position changed compared to
 * the previous completed lap. Plays AFTER the lap-time best-lap callout
 * (#555) on laps that produce both, via the engine's **deferred-low**
 * mechanism — NOT via registration order.
 *
 * Why `weight: WEIGHT.CHATTER` + `queueable: true`: when two cross-family
 * default-weight scenarios fire on the same event, the scenario engine
 * (`interpreter.ts` `attemptFire`) starts the first one and **silently drops**
 * the second (`bus busy`, no preemption rule matches). A `queueable` scenario
 * is *deferred* and replayed once the bus goes idle (see `finishFire` →
 * `drainPending`). Lap-time stays default `WEIGHT.NORMAL`; position is
 * `WEIGHT.CHATTER` + `queueable: true` so it queues behind. The deferred replay
 * carries the original event payload, so the snapshot resolver still reads the
 * correct lap's position.
 *
 * Both scenarios share the `lap.completed` trigger but sit on different
 * families (`lap-time` vs `position`), so neither preempts the other.
 *
 * Script:
 *   [radio open]
 *   (if qualifying lap was invalidated by iRacing — issue #572)
 *     <didn't count>              "That lap didn't count."  (static clip)
 *     <currently>                 "We're currently"  (static clip; invalid laps
 *                                  never get the "better" framing or pole)
 *     <number>                    pee one / pee two / … / pee sixty four
 *   (else if qualifying-pole condition)
 *     <pole>                      "That puts us on pole."  (self-contained)
 *   (else)
 *     <intro>                     that-puts-us-to  OR  currently
 *     <number>                    pee one / pee two / … / pee sixty four
 *   [radio close]
 *
 * The intro is data-driven via `engine.defineVar`:
 *   - **Qualifying**: driver gained positions OR `previousPosition` is unset
 *     (first valid lap — `isFirstValid: true` aligns with #555) →
 *     "That puts us to <break /> pee N." ("better" intro). Driver lost
 *     positions OR position unchanged on a non-PB lap → "We're currently
 *     <break /> pee N." ("worse" intro). Position unchanged on a PB lap →
 *     `where:` short-circuits, scenario silent (lap-time-best already
 *     narrates the lap). Improvement to effective P1 in qualifying →
 *     "That puts us on pole." (one clip, no number — pole branch).
 *     Invalidated qualifying lap (`lapIsValid === false`, issue #572) →
 *     "That lap didn't count. We're currently <break /> pee N." — the
 *     invalid-lap branch beats the pole / "better" branches unconditionally.
 *   - **Race** (issue #569): every direction uses the "currently" intro —
 *     race standings don't follow from lap times, so "That puts us to P3"
 *     reads wrong; "We're currently P3" works whether you gained or lost
 *     the place. Pole branch is skipped (qualifying-only). Hold-position
 *     status is owned by the every-3-laps race-status callout; the
 *     position-change callout in race fires only on real changes.
 *
 * The "effective" position picks between class and overall based on the
 * payload's `isMultiClass` flag (translator-resolved from session info):
 *   - Multi-class series → `classPosition` (drivers in multi-class care
 *     about their class standing, not the overall mixed-field order).
 *   - Single-class → `position` (overall).
 *
 * Snapshot-at-fire-time (session-start / lap-time pattern): the var
 * resolvers read the most recent `lap.completed` payload via a closure,
 * shared with the lap-time scenario in each plugin. A deferred replay
 * speaks the frozen lap's position rather than whatever position the
 * driver holds when the engineer finally gets bus time.
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
 * `PlayerCarPosition === 0` on a session reset), the scenario does NOT
 * fire; the var resolver returning `null` is a defense-in-depth guard.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import { poolRef, WEIGHT } from "../../dsl.js";
import type { Scenario, Step } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import {
  liveCurrentlyAnnounceable,
  type LivePositionResolver,
  POSITION_CURRENTLY_CLIP,
  selectLivePosition,
  tryClaimPositionAnnouncement,
} from "./position-readout.js";

/**
 * Resolver for the most recent `lap.completed` payload — shared with the
 * lap-time scenario (same data, same cache, different consumers). The
 * plugin owns the cache; the scenarios just read.
 */
export type LapCompletedSnapshotResolver = () => SimEventOf<"lap.completed">["data"] | null;

const POSITION_GROUP_INTRO_BETTER = "position-intro-better";
const POSITION_GROUP_INTRO_WORSE = "position-intro-worse";
const POSITION_GROUP_INTRO_POLE = "position-intro-pole";
const POSITION_GROUP_NUMBER = "position-number";

/**
 * Static "That lap didn't count." clip path, relative to the `voice/{voice}`
 * base (issue #572). Mirrors {@link POSITION_CURRENTLY_CLIP} — a bare clip
 * step rather than a `{ var }`, because the prefix is the same line every
 * time (no live data). Used only in the qualifying invalid-lap branch.
 */
const POSITION_DIDNT_COUNT_CLIP = "position-invalid-lap/that-lap-didnt-count-01.mp3";

/**
 * Pick the position pair the engineer should announce. Multi-class series
 * read class-position; single-class (or unknown) read overall. Returns
 * `null` when neither side is available — the scenario stays silent.
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
 *   - Session type is qualifying (the only session the scenario fires in
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
 * Register the position scenario's variables on the scenario engine. Must run
 * before {@link buildPositionScenario} is registered — load-time validation
 * rejects `{ var }` steps whose names aren't registered.
 */
export function registerPositionVars(
  engine: IScenarioEngine,
  getSnapshot: LapCompletedSnapshotResolver,
  getLivePosition: LivePositionResolver = () => null,
): void {
  engine.defineVar("position.intro", () => {
    const s = getSnapshot();

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
  });

  engine.defineVar("position.number", () => {
    const s = getSnapshot();

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
  });

  // Self-contained "That puts us on pole." clip — replaces both the intro
  // and the number when the qualifying-pole condition fires. See
  // `isPoleAchievement` for the trigger conditions.
  engine.defineVar("position.pole", () => {
    const s = getSnapshot();

    if (!s) return null;

    return poolRef(POSITION_GROUP_INTRO_POLE, "that-puts-us-on-pole");
  });
}

/**
 * Build the position-change scenario. Takes a snapshot resolver to power the
 * qualifying-pole branch's `if:` predicate at expansion time (the per-clip
 * `var` resolvers receive their own resolver reference via {@link
 * registerPositionVars}), plus an optional `getRaceFinishedFired` so the
 * `where:` short-circuits on the final lap of a race (issue #569). Without
 * the race-finished gate, a position change on the final lap would queue
 * "We're currently P[n]" behind race-end and play after the result speech
 * — same `weight: WEIGHT.CHATTER` + `queueable: true` as race-end with no
 * shared family, so the engine defers but does not drop it. Default
 * `() => false` (race never ends)
 * preserves legacy behavior for tests / qualifying.
 */
export function buildPositionScenario(
  getSnapshot: LapCompletedSnapshotResolver,
  getRaceFinishedFired: () => boolean = () => false,
  getLivePosition: LivePositionResolver = () => null,
): Scenario {
  const sequence: Step[] = [
    "@pit-crew.radio-open",
    {
      // Invalid-lap branch (issue #572) — QUALIFYING ONLY. iRacing flagged the
      // just-completed qualifying lap as invalid (track-limits cut, pit-lane
      // violation, etc.). Prefix the readout with "That lap didn't count." and
      // always speak the worse-framing "currently" intro: an invalid lap can't
      // earn a "better" framing (no pole, no "That puts us to P[n]") even if
      // standings shifted from others' laps. Gated to qualifying so the race
      // path (which reads the spoken number LIVE at speak-time and shares the
      // position cooldown, issue #574) is untouched — "that lap didn't count"
      // has no meaning in a race where every lap counts. `lapIsValid` of `true`
      // or `undefined` (no signal from telemetry) falls through to the existing
      // path — don't suppress callouts on a missing signal. The frozen-snapshot
      // `position.number` resolver returns the qualifying number here.
      if: () => {
        const s = getSnapshot();

        return s !== null && s.sessionType === "qualifying" && s.lapIsValid === false;
      },
      then: [POSITION_DIDNT_COUNT_CLIP, POSITION_CURRENTLY_CLIP, { var: "position.number" }],
      else: [
        {
          // Qualifying pole branch — single self-contained "on pole" clip
          // replaces the intro + number for an improvement to P1 in qualifying.
          // Holding P1 on a slow lap falls through to the else branch (standard
          // "We're currently P1" status line), so the pole call doesn't repeat.
          if: () => {
            const s = getSnapshot();

            return s !== null && isPoleAchievement(s);
          },
          then: [{ var: "position.pole" }],
          else: [{ var: "position.intro" }, { var: "position.number" }],
        },
      ],
    },
    "@pit-crew.radio-close",
  ];

  return {
    id: "pit-crew.position-change",
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
    // scenario when the bus is busy (typically because the lap-time-best callout
    // fires on the same `lap.completed` event and grabs the Voice bus first).
    // Without `queueable`, a default-weight scenario would hit the
    // dropped-on-busy-bus path in `interpreter.ts` `attemptFire` and the user
    // would never hear the position update on a PB lap. See the file header for
    // the full rationale.
    weight: WEIGHT.CHATTER,
    queueable: true,
    family: "position",
    sequence,
  };
}

/**
 * Stable identifier for the position-change callout (issue #566). Single
 * subject — `change` covers improvement, worsening, and first-fix
 * (intro selection happens inside the scenario).
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
// map below can be typed against — TS errors out at build time if a scenario id
// is renamed, missing, or extra. Cheaper than a runtime completeness assertion.
export const POSITION_SCENARIO_IDS = ["pit-crew.position-change"] as const;

export const SCENARIO_ID_TO_POSITION_ID: Record<(typeof POSITION_SCENARIO_IDS)[number], PositionCalloutId> = {
  "pit-crew.position-change": "change",
};

/**
 * Empty — the position readout is composed entirely from `engine.defineVar`
 * resolvers, not pools. Exported for parity with the family-completeness
 * check used by the other pit-crew catalog files. The broader convention
 * alignment (static `POSITION_ALERTS` + constructor helper) is tracked in
 * issue #558.
 */
export const POSITION_POOL_NAMES: readonly string[] = [];
