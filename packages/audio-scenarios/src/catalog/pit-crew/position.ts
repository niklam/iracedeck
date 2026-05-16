/**
 * Position-change callout — issue #566.
 *
 * Fires on `lap.completed` when the driver's position changed compared to
 * the previous completed lap. Plays AFTER the lap-time best-lap callout
 * (#555) on laps that produce both, via the engine's **deferred-low**
 * mechanism — NOT via registration order.
 *
 * Why `priority: "low"`: when two cross-family normal-priority scenarios
 * fire on the same event, the scenario engine (`interpreter.ts`
 * `attemptFire`) starts the first one and **silently drops** the second
 * (`bus busy`, no preemption rule matches). `low` is the only path that
 * gets *deferred* and replayed once the bus goes idle (see `finishFire` →
 * `deferredLowFire`). Lap-time stays `normal`; position is `low` so it
 * queues behind. The deferred replay carries the original event payload,
 * so the snapshot resolver still reads the correct lap's position.
 *
 * Both scenarios share the `lap.completed` trigger but sit on different
 * families (`lap-time` vs `position`), so neither preempts the other.
 *
 * Script:
 *   [radio open]
 *   (if qualifying-pole condition)
 *     <pole>                      "That puts us on pole."  (self-contained)
 *   (else)
 *     <intro>                     that-puts-us-to  OR  currently
 *     <number>                    pee one / pee two / … / pee sixty four
 *   [radio close]
 *
 * The intro is data-driven via `engine.defineVar`:
 *   - Driver gained positions, OR `previousPosition` is unset (first valid
 *     lap of the session — `isFirstValid: true` aligns with #555) →
 *     "That puts us to <break /> pee N." ("better" intro)
 *   - Driver lost positions, OR position unchanged on a non-PB lap →
 *     "We're currently <break /> pee N." ("worse" intro)
 *   - Position unchanged on a PB lap → `where:` short-circuits, scenario
 *     silent (lap-time-best already narrates the lap).
 *   - **Qualifying pole** — improvement to effective P1 in qualifying →
 *     "That puts us on pole." (one clip, no number). Holding P1 stays on
 *     the standard status line ("We're currently P1") so the pole call
 *     doesn't repeat each subsequent lap.
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
 *   - **Qualifying only** — the standings-based phrasings fit qualifying's
 *     standings-after-best-lap model. Race / practice / test stay silent.
 *     See `isAnnounceableSessionType` for the rationale.
 *   - Position is in the announceable range (`POSITION_NUMBER_MIN..MAX`).
 *     Out-of-range positions cause the scenario not to fire at all
 *     rather than producing a partial readout.
 *   - Position change detected OR position unchanged on a non-PB lap
 *     (the status-update path; see `positionChangeIsAnnounceable`).
 *
 * Sentinel: when neither overall nor class position is populated (e.g.
 * `PlayerCarPosition === 0` on a session reset), the scenario does NOT
 * fire; the var resolver returning `null` is a defense-in-depth guard.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario, Step } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/**
 * Resolver for the most recent `lap.completed` payload — shared with the
 * lap-time scenario (same data, same cache, different consumers). The
 * plugin owns the cache; the scenarios just read.
 */
export type LapCompletedSnapshotResolver = () => SimEventOf<"lap.completed">["data"] | null;

/**
 * Inclusive announceable range. The voice config currently ships
 * `position-number/1..64` to cover the full iRacing field-size spectrum
 * (the largest oval events sit around 60-car splits). Positions outside
 * this range cause `where:` to skip the scenario rather than producing a
 * partial readout. Expand the bounds together with the voice config group.
 */
export const POSITION_NUMBER_MIN = 1;
export const POSITION_NUMBER_MAX = 64;

const POSITION_GROUP_INTRO_BETTER = "position-intro-better";
const POSITION_GROUP_INTRO_WORSE = "position-intro-worse";
const POSITION_GROUP_INTRO_POLE = "position-intro-pole";
const POSITION_GROUP_NUMBER = "position-number";

/** Build a full `voice/{voice}/...` path for a `var` resolver. */
function voicePath(group: string, name: string): string {
  return `voice/{voice}/${group}/${name}.mp3`;
}

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
 * Whether `current` is inside the clip range. Defensive bound — `where:`
 * already filters via this so the var resolver should never see an
 * out-of-range value in practice.
 */
export function positionNumberIsSpeakable(n: number): boolean {
  return Number.isInteger(n) && n >= POSITION_NUMBER_MIN && n <= POSITION_NUMBER_MAX;
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

  if (!positionNumberIsSpeakable(effective.current)) return false;

  if (effective.previous === undefined) {
    // No baseline — first fix, speak as better.
    return true;
  }

  if (effective.current !== effective.previous) {
    // Position changed (improved or worsened).
    return true;
  }

  // Position unchanged. Fire the status update unless lap-time-best is
  // already handling this lap (PB or first-valid). `isBest === true` is the
  // condition lap-time-best fires on; `isFirstValid` always coincides with
  // `isBest` (the first valid lap is necessarily the new best), so checking
  // `isBest` alone is sufficient to avoid double-narrating.
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
 * callout. **Qualifying only** for now — the standings-based phrasings
 * ("That puts us to P5", "We're currently P5", "That puts us on pole")
 * fit qualifying's standings-after-best-lap model. Race position changes
 * happen dynamically through overtakes and pit stops rather than at lap
 * boundaries; a race-flavoured callout family will be a separate scenario
 * if/when we add it. Practice and test sessions also stay silent.
 * `undefined` (unresolved session info) defaults to silent so a
 * misconfigured tick never produces an unintended fire.
 */
function isAnnounceableSessionType(snapshot: SimEventOf<"lap.completed">["data"]): boolean {
  return snapshot.sessionType === "qualifying";
}

/**
 * Register the position scenario's variables on the scenario engine. Must run
 * before {@link buildPositionScenario} is registered — load-time validation
 * rejects `{ var }` steps whose names aren't registered.
 */
export function registerPositionVars(engine: IScenarioEngine, getSnapshot: LapCompletedSnapshotResolver): void {
  engine.defineVar("position.intro", () => {
    const s = getSnapshot();

    if (!s) return null;

    return isBetterChange(s)
      ? voicePath(POSITION_GROUP_INTRO_BETTER, "that-puts-us-to")
      : voicePath(POSITION_GROUP_INTRO_WORSE, "currently");
  });

  engine.defineVar("position.number", () => {
    const s = getSnapshot();

    if (!s) return null;

    const effective = selectEffectivePosition(s);

    if (!effective || !positionNumberIsSpeakable(effective.current)) return null;

    return voicePath(POSITION_GROUP_NUMBER, String(effective.current));
  });

  // Self-contained "That puts us on pole." clip — replaces both the intro
  // and the number when the qualifying-pole condition fires. See
  // `isPoleAchievement` for the trigger conditions.
  engine.defineVar("position.pole", () => {
    const s = getSnapshot();

    if (!s) return null;

    return voicePath(POSITION_GROUP_INTRO_POLE, "that-puts-us-on-pole");
  });
}

/**
 * Build the position-change scenario. Takes a snapshot resolver only to
 * power the qualifying-pole branch's `if:` predicate at expansion time —
 * the per-clip `var` resolvers receive their own resolver reference via
 * {@link registerPositionVars}. The `where:` predicate reads `ev.data`
 * directly so it can decide whether to fire without the snapshot.
 */
export function buildPositionScenario(getSnapshot: LapCompletedSnapshotResolver): Scenario {
  const sequence: Step[] = [
    "@pit-crew.radio-open",
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

        return positionChangeIsAnnounceable(data);
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    // `low` so the engine *defers* this scenario when the bus is busy
    // (typically because the lap-time-best callout fires on the same
    // `lap.completed` event and grabs the Voice bus first). `normal` would
    // hit the dropped-on-busy-bus path in `interpreter.ts` `attemptFire` and
    // the user would never hear the position update on a PB lap. See the
    // file header for the full rationale.
    priority: "low",
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

export const SCENARIO_ID_TO_POSITION_ID: Record<string, PositionCalloutId> = {
  "pit-crew.position-change": "change",
};

export const POSITION_SCENARIO_IDS: readonly string[] = ["pit-crew.position-change"];

/**
 * Empty — the position readout is composed entirely from `engine.defineVar`
 * resolvers, not pools. Exported for parity with the family-completeness
 * check used by the other pit-crew catalog files. The broader convention
 * alignment (static `POSITION_ALERTS` + constructor helper) is tracked in
 * issue #558.
 */
export const POSITION_POOL_NAMES: readonly string[] = [];
