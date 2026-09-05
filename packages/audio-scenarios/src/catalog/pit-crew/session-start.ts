/**
 * Session-start readout contract — issues #542, #668; scripted since #1065.
 *
 * Fires when a practice or qualifying session starts — on `session.changed`,
 * approximately {@link SESSION_START_DELAY_MS} after the session begins — whether
 * or not the driver leaves the garage. Race sessions are covered exclusively by
 * the race-start contract (issue #568), which fires on the same event; the
 * `where:` predicate rejects `sessionType === "race"` here so the two contracts
 * never double-greet.
 *
 * Riding `session.changed` also inherits:
 *   - Replay-only suppression (issue #604): the event is gated at emission in
 *     the sim-events-iracing translator, so replays never trigger a brief.
 *   - Fresh-connect synthetic event: when the plugin connects mid-session, the
 *     translator emits a synthetic `session.changed { from: -1, to: N }` —
 *     connecting mid-practice or mid-qualifying triggers the brief, UNLESS the
 *     driver's car is already on track (issue #871): a plugin restart while
 *     lapping must not replay the intro, so the `where:` rejects the synthetic
 *     marker when the envelope telemetry reads `IsOnTrack === true`.
 *
 * The delay is implemented as `triggerDelay` after {@link SESSION_START_DELAY_MS}
 * (see its doc for why this is a `triggerDelay`, not a leading pause).
 *
 * The code below decides WHETHER the brief is due and how it is scheduled;
 * WHAT is said lives in the active voice's `callouts.json` under the same id
 * (`scenarios["pit-crew.session-start"]`), paired at `setScripts` time. The
 * bundled script's shape (fires ~{@link SESSION_START_DELAY_MS} ms after
 * `session.changed`):
 *   [radio open]
 *   "Ok, <Name>,"                                  {{sessionStart.greeting}} — optional
 *   <session line>                                 {{sessionStart.sessionLine}} — required
 *   "The pit speed limit is" <N> <speed-unit>      optional clause — see below
 *   "Track temperature is" <N> "degrees" <unit>    optional clause
 *   "air temperature is"   <N> "degrees" <unit>    optional clause
 *   "and the track is" {{sessionStart.wetness}}    required
 *   (if setupWarning.qualifyingMismatch) the nudge optional clause
 *   [radio close]
 *
 * Every optional clause is a whole clause (the #1064 spec's second rule): the
 * brief without the greeting, without the pit-speed limit, or without a
 * temperature reading is shorter and still true, so a voice lacking a name
 * clip, a speed-number clip or a temperature clip skips that clause and
 * speaks the rest. The session line and the wetness are required: a brief
 * that names no session, or ends on "and the track is", is not a brief.
 *
 * Snapshot-at-fire-time (readback.ts pattern, issue #481): every dynamic clip
 * is a `{{var}}` backed by a resolver that reads the snapshot closure at
 * fire time, so a deferred replay speaks current conditions. Units, rounding,
 * and the session-type bucket are resolved upstream in
 * `getSessionStartConditions()` — this file only maps the snapshot fields onto
 * clip paths. That is why the vocabulary takes the resolver (and the
 * setup-warning resolver); the contract builder keeps the snapshot resolver
 * for its `where:`.
 *
 * The pit-speed clause is optional: iRacing pit limits are a small known set,
 * so the `session-start-speed-numbers` group only covers observed values (plus
 * ±1 for telemetry drift). The clause is skipped entirely for any value
 * without a clip — a guessed or rounded number could imply a false
 * pit-speed-penalty risk.
 *
 * `where:` is `getSnapshot() !== null && sessionType !== "race"`, plus the
 * #871 fresh-connect arm (reject `from === -1` when the car is on track) — so
 * the contract doesn't fire at all when conditions are unavailable (no
 * telemetry / session info, or wetness still `Unknown`), never fires in race
 * sessions, and never replays the brief to a driver already mid-session.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type SessionStartSnapshot, TrackWetness } from "@iracedeck/event-bus";
import { type TelemetryData } from "@iracedeck/iracing-sdk";

import type { ScenarioContract } from "../../dsl.js";
import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import type { SetupWarningResolver } from "./race-start.js";

/**
 * Resolver for the session-start snapshot, invoked at fire time. Returns
 * `null` when conditions aren't available — the contract then skips the
 * callout entirely (its `where:` predicate short-circuits).
 */
export type SessionStartSnapshotResolver = () => SessionStartSnapshot | null;

/**
 * Delay before the where: predicate and sequence-expansion run, once
 * `session.changed` fires for a practice or qualifying session. Implemented as
 * the contract's `triggerDelay` (NOT a leading `{ pause }` step) so iRacing's
 * telemetry has a chance to settle before we read it.
 *
 * iRacing publishes `SessionNum`-changed ticks immediately on session
 * transition, but `TrackWetness` (and a few other fields) can briefly read
 * `Unknown` for a beat right at the transition. A leading `{ pause }` step
 * inside the sequence does NOT help — vars are resolved at expansion time,
 * synchronously when the where: returns true. By the time the pause's audio-
 * gap actually plays, the var paths are already frozen. `triggerDelay`
 * defers the entire fire decision so where: and var resolvers see fresh,
 * settled telemetry.
 */
export const SESSION_START_DELAY_MS = 3000;

/** Wetness enum → `session-start/wetness-<suffix>.mp3` clip suffix. */
const WETNESS_CLIP_SUFFIX: Readonly<Partial<Record<TrackWetness, string>>> = {
  [TrackWetness.Dry]: "dry",
  [TrackWetness.MostlyDry]: "mostly-dry",
  [TrackWetness.VeryLightlyWet]: "very-lightly-wet",
  [TrackWetness.LightlyWet]: "lightly-wet",
  [TrackWetness.ModeratelyWet]: "moderately-wet",
  [TrackWetness.VeryWet]: "very-wet",
  [TrackWetness.ExtremelyWet]: "extremely-wet",
};

/**
 * Register the vocabulary the session-start script references (issue #1065):
 * the eight vars the brief is built from and the setup-warning condition. The
 * vars read the snapshot through `getSnapshot` at expansion time and return
 * `null` (nothing to say) when it is unavailable — every one is a dynamic pool
 * reference (issue #836): the clips that exist for the active voice define
 * what values are speakable, so there are no hardcoded speed/temperature
 * ranges — a value with no clip skips its optional clause, or aborts the
 * callout for required content (#835). The condition reads
 * `getSetupWarningMismatch` live, so a mid-session opt-in toggle or pattern
 * edit takes effect immediately, and only in a qualifying session — practice
 * never warns (only qualifying and, via race-start, race do). Names and
 * descriptions are the public API of the format; the descriptions feed the
 * generated reference (#1066).
 */
export function registerSessionStartVocabulary(
  engine: Pick<IScenarioEngine, "defineVar" | "defineCond">,
  getSnapshot: SessionStartSnapshotResolver,
  getSetupWarningMismatch: SetupWarningResolver = () => false,
): void {
  engine.defineVar(
    "sessionStart.greeting",
    () => {
      const s = getSnapshot();

      return s ? poolRef("session-start-greeting", s.driverName) : null;
    },
    'The session-start greeting with the driver\'s name — "ok, <name>" as one clip per name the voice recorded. Draws from the session-start-greeting clip group; a name the voice lacks resolves to nothing, so keep it optional.',
  );

  engine.defineVar(
    "sessionStart.sessionLine",
    () => {
      const s = getSnapshot();

      return s ? poolRef("session-start", `session-${s.sessionType}`) : null;
    },
    "The line naming the session that just started — practice or qualifying (race is the race-start callout's). Draws the session-practice and session-qualifying lines from the session-start clip group.",
  );

  engine.defineVar(
    "sessionStart.speedNumber",
    () => {
      const s = getSnapshot();

      return s ? poolRef("session-start-speed-numbers", String(s.pitSpeedLimit)) : null;
    },
    "The pit speed limit as a whole number in the driver's speed unit. Draws from the session-start-speed-numbers clip group, which covers the limits iRacing uses; a limit with no clip resolves to nothing and aborts the clause it sits in.",
  );

  engine.defineVar(
    "sessionStart.speedUnit",
    () => {
      const s = getSnapshot();

      return s ? poolRef("session-start", `speed-unit-${s.speedUnit}`) : null;
    },
    "The speed unit word after the pit speed limit — kilometres per hour or miles per hour, per the driver's display setting. Draws the speed-unit-kmh and speed-unit-mph lines from the session-start clip group.",
  );

  engine.defineVar(
    "sessionStart.trackTempNumber",
    () => {
      const s = getSnapshot();

      return s ? poolRef("session-start-temp-numbers", String(s.trackTemp)) : null;
    },
    "The track temperature as a whole number in the driver's display unit. Draws from the session-start-temp-numbers clip group; a reading outside the recorded range aborts the clause it sits in.",
  );

  engine.defineVar(
    "sessionStart.airTempNumber",
    () => {
      const s = getSnapshot();

      return s ? poolRef("session-start-temp-numbers", String(s.airTemp)) : null;
    },
    "The air temperature as a whole number in the driver's display unit. Draws from the session-start-temp-numbers clip group; a reading outside the recorded range aborts the clause it sits in.",
  );

  engine.defineVar(
    "sessionStart.degreesUnit",
    () => {
      const s = getSnapshot();

      return s ? poolRef("session-start", `degrees-${s.tempUnit}`) : null;
    },
    "The temperature unit word — degrees celsius or degrees fahrenheit, per the driver's display setting. Draws the degrees-celsius and degrees-fahrenheit lines from the session-start clip group.",
  );

  engine.defineVar(
    "sessionStart.wetness",
    () => {
      const s = getSnapshot();
      const suffix = s ? WETNESS_CLIP_SUFFIX[s.wetness] : undefined;

      return suffix ? poolRef("session-start", `wetness-${suffix}`) : null;
    },
    "The track wetness state as a word — dry, mostly dry, very lightly wet, lightly wet, moderately wet, very wet or extremely wet. Draws the wetness-<state> lines from the session-start clip group.",
  );

  engine.defineCond(
    "setupWarning.qualifyingMismatch",
    () => getSnapshot()?.sessionType === "qualifying" && getSetupWarningMismatch("qualifying"),
    "The session is qualifying and the loaded setup's name looks like a race setup, per the driver's setup-name patterns — worth a double-check-your-setup nudge. Never true in practice, and false when the warning is switched off or no pattern matches.",
  );
}

/**
 * Build the session-start contract bound to a snapshot resolver. Stays a
 * builder because the `where:` reads the resolver (to gate firing); the
 * brief itself is the vocabulary's ({@link registerSessionStartVocabulary}).
 * Holds the fixed id, the snapshot-gated `when` block, and the shared
 * channel / bus / base / family defaults (weight is omitted, so it defaults
 * to `WEIGHT.NORMAL`).
 */
export function buildSessionStartContract(getSnapshot: SessionStartSnapshotResolver): ScenarioContract {
  return {
    id: "pit-crew.session-start",
    when: {
      event: "session.changed",
      where: (e) => {
        const snapshot = getSnapshot();

        if (snapshot === null) return false;

        // Race sessions are spoken exclusively by the race-start contract
        // (issue #568), whose `where:` requires `isRaceSession(getSessionType())`.
        // Rejecting `sessionType === "race"` here prevents a double-greeting
        // when both contracts ride the same `session.changed` event.
        //
        // We read `snapshot.sessionType` (not `isRaceSession(getSessionType())`)
        // because the snapshot is the injected seam: the var resolvers and the
        // scenario-harness session-start composer both drive it directly via the
        // snapshot resolver, so the gate and the spoken session-type line are
        // always drawn from the same source and can't disagree.
        if (snapshot.sessionType === "race") return false;

        // Issue #871: the translator's fresh-connect synthesis marks itself
        // with `from: -1`. Replaying the intro brief to a driver already
        // lapping (plugin restart mid-practice / mid-qualifying) is noise —
        // reject the synthetic event when the driver's car is on track. The
        // envelope telemetry is the synthesis-tick state, i.e. "was the
        // driver already driving at connect". Deliberately NOT
        // `isLiveOnTrack` — its `IsReplayPlaying !== true` conjunct encodes
        // "actively driving", but the question here is "session already
        // underway": a connect tick with the in-session replay view open (or
        // the #604 transient replay tick) would evade the gate and replay
        // the brief over a live session. Connecting in the garage (the
        // #668 case) and genuine transitions (`from >= 0`) still brief, and
        // missing telemetry briefs too (don't punish missing data — also
        // keeps the harness composer firable without driving telemetry).
        const from = (e.data as { from?: number }).from;
        const telemetry = e.telemetry as TelemetryData | null;

        if (from === -1 && telemetry?.IsOnTrack === true) return false;

        return true;
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "session-start",
    // Defer where: + var resolution so telemetry has settled by the time we
    // read TrackWetness / TrackTempCrew / AirTemp. See
    // `SESSION_START_DELAY_MS` for the rationale.
    triggerDelay: SESSION_START_DELAY_MS,
  };
}

/**
 * Stable identifier for the session-start callout (issue #542). Single
 * subject — the whole readout is one user-toggleable callout.
 */
export type SessionStartCalloutId = "session-start";

/**
 * Canonical mapping from `SessionStartCalloutId` to its plugin-global setting
 * key in `GlobalSettingsSchema`. Plugin entry points use this to read the live
 * opt-in without duplicating the key string.
 */
export const SESSION_START_CALLOUT_SETTING_KEYS: Record<SessionStartCalloutId, string> = {
  "session-start": "calloutEnabledSessionStart",
};

export const SCENARIO_ID_TO_SESSION_START_ID: Record<string, SessionStartCalloutId> = {
  "pit-crew.session-start": "session-start",
};

export const SESSION_START_SCENARIO_IDS: readonly string[] = ["pit-crew.session-start"];

/**
 * The clip sources the session-start script draws from directly — the pools
 * it addresses as `pool:<group>/<base>` rather than through a var: the four
 * clause intros under `session-start` and the setup nudge under
 * `setup-warning`. The value-driven clips (the greeting, the session line,
 * the numbers, the units, the wetness) are the vars', whose descriptions
 * name their groups. The completeness tests read this list: the bundled
 * voice must ship at least one clip for each, and the bundled script must
 * reference exactly this set. A `(group, base)` a script addresses is
 * published — renaming a base is a rename in every pack's script and every
 * pack's clip folder.
 */
export const SESSION_START_CLIP_SOURCES: readonly { group: string; base: string }[] = [
  { group: "session-start", base: "pit-speed-intro" },
  { group: "session-start", base: "track-temp-intro" },
  { group: "session-start", base: "air-temp-intro" },
  { group: "session-start", base: "wetness-intro" },
  { group: "setup-warning", base: "qualifying" },
];
