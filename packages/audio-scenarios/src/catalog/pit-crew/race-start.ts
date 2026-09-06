/**
 * Race-start greeting + qualifying-position readout — issue #568; scripted
 * since #1065.
 *
 * Fires once per race session on `session.changed` after a short delay
 * ({@link RACE_START_DELAY_MS}). The bundled script greets the driver by
 * name, reports the qualifying-finish (grid) position, and reads the same
 * track + air temperature + wetness brief as the session-start callout —
 * minus the pit speed limit, which the driver heard during practice /
 * qualifying and which isn't useful at the green flag. Race start is the only
 * moment the driver wants the position context.
 *
 * The code below decides WHETHER the brief is due and how it is scheduled;
 * WHAT is said lives in the active voice's `callouts.json` under the same id
 * (`scenarios["pit-crew.race-start"]`), paired at `setScripts` time. The
 * bundled script's shape (fires {@link RACE_START_DELAY_MS} after
 * `session.changed`):
 *   [radio open]
 *   "Time to race, <Name>."                        {{raceStart.greeting}} — optional
 *   ── position clause, optional, `raceStart.gridPosition` case ──
 *     pole                 "Starting from pole. Well done."
 *     composed             "Qualifying put us to," + {{raceStart.position}}
 *     none                 (clause skipped entirely)
 *   ──
 *   "Track temperature is" <N> "degrees" <unit>    optional clause (session-start clips)
 *   "air temperature is"   <N> "degrees" <unit>    optional clause (session-start clips)
 *   "and the track is" {{raceStart.wetness}}        required
 *   (if setupWarning.raceMismatch) the setup nudge  optional clause
 *   [radio close]
 *
 * Every optional clause is a whole clause (the #1064 spec's second rule): the
 * brief without the greeting, without the grid position, or without a
 * temperature reading is shorter and still true, so a voice lacking a name
 * clip, a position clip or a temperature clip skips that clause and speaks the
 * rest. The grid position is a `case` inside the optional clause rather than
 * two nested `if`s: it is a lookup over a closed set (pole / composed / none),
 * and a pack can phrase the composed branch differently — or drop the pole
 * compliment — without touching code.
 *
 * Coexistence with session-start (issue #542): the session-start contract's
 * `where:` returns false in race sessions, so race entries are spoken
 * exclusively by this contract. Practice and qualifying are unchanged.
 *
 * The greeting is a single per-name clip ("Time to race, Niklas.") rather than
 * a composed "Time to race," + bare-name pair. Composition produced awkward
 * prosody — the prefix ended with a sentence terminator and the bare name
 * read as a fresh utterance instead of a continuation. Per-name clips speak
 * naturally at the cost of one clip per supported name.
 *
 * Snapshot-at-fire-time (session-start pattern, issue #542): every dynamic clip
 * is a `{{var}}` backed by a resolver that reads the snapshot closure at fire
 * time; the grid-position case and the setup-warning condition read it (or
 * the setup-warning resolver) the same way. The clip ranges (temp 0-150 in
 * display units, position 1-64) are the same as the families they borrow
 * from — both come from the same voice-group source of truth and don't need
 * to be tracked separately here. That is why the vocabulary takes both
 * resolvers; the contract builder keeps the snapshot resolver for its `where:`.
 *
 * Family `race-start`: reserves the namespace for future race-start scenarios
 * (wet-race opener, formation-lap brief, weather forecast). Distinct from
 * `session-start` so preemption between the two families is clean — a future
 * race-only opener can preempt this one without affecting practice / qualifying
 * sessions still using session-start.
 *
 * `where:` is `classifySessionType(getSessionType()) === "race" &&
 * getSnapshot() !== null`, plus the issue #871 fresh-connect gate: a synthetic
 * `session.changed { from: -1 }` (plugin connect mid-session) is rejected when
 * the race is already underway (`SessionState === Racing` or post-race) — a
 * pre-green grid restart still briefs. The first arm gates the contract open
 * only for race transitions (practice/qualifying are owned by session-start);
 * the snapshot arm short-circuits when telemetry / wetness aren't yet
 * available so the contract skips entirely rather than speaking a partial
 * readout.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type RaceStartSnapshot, TrackWetness } from "@iracedeck/event-bus";
import { isPostRace, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { getSessionType } from "@iracedeck/sim-events-iracing";

import type { ScenarioContract } from "../../dsl.js";
import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/**
 * Resolver for the race-start snapshot, invoked at fire time. Returns `null`
 * when conditions aren't available — the contract then skips the callout
 * entirely (its `where:` predicate short-circuits).
 */
export type RaceStartSnapshotResolver = () => RaceStartSnapshot | null;

/**
 * Resolver for the setup-name mismatch nudge (issue #625): whether the loaded
 * setup's name looks wrong for the session kind. Read live at fire time.
 */
export type SetupWarningResolver = (kind: "qualifying" | "race") => boolean;

/**
 * Delay before the where: predicate and sequence-expansion run, once
 * `session.changed` lands in a race session. Implemented as the contract's
 * `triggerDelay` (NOT a leading `{ pause }` step) so iRacing's telemetry has
 * a chance to settle before we read it.
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
export const RACE_START_DELAY_MS = 3000;

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

const RACE_START_GREETING_GROUP = "race-start-greeting";
const SESSION_START_GROUP = "session-start";
const SESSION_START_TEMP_NUMBERS_GROUP = "session-start-temp-numbers";
const POSITION_NUMBER_GROUP = "position-number";

/** The three buckets a session type collapses into — the keys of the `session.type` vocabulary (issue #1064). */
export type SessionKind = "practice" | "qualifying" | "race";

/**
 * The catalog's ONE rule for reading iRacing's raw `SessionType` string
 * ("Practice", "Lone Practice", "Offline Testing", "Open Qualify",
 * "Lone Qualify", "Race", "Warmup", …): practice or testing → `"practice"`
 * (a test session is practice-like), qualifying → `"qualifying"`, anything
 * else (race, warmup, heat) → `"race"`, and `""` — the translator's "no
 * session type known" answer — → `null`. It mirrors the translator's own
 * `classifySessionType` (sim-events-iracing `translator.ts`), which must
 * stay in agreement; every session gate in this package and the
 * `session.*` vocabulary a voice script names read through it, so a pack
 * can never see a session called a race that a `where:` here calls
 * something else.
 */
export function classifySessionType(sessionType: string): SessionKind | null {
  if (sessionType === "") return null;

  if (sessionType.includes("Practice") || sessionType.includes("Testing")) return "practice";

  if (sessionType.includes("Qualify")) return "qualifying";

  return "race";
}

/**
 * Whether the session is a race for the catalog's `where:` gates — the
 * shared rule above, read permissively: an UNKNOWN session type (`""`) also
 * passes, because a gate must never suppress on missing data (the #574
 * precedent). The `session.type` vocabulary reads the same rule honestly
 * (`null`) and leaves the unknown case to the pack's `default` branch —
 * that asymmetry is deliberate, not two rules. Public so the predicates can
 * be unit-tested without mocking the entire scenario harness.
 */
export function isRaceSession(sessionType: string): boolean {
  const kind = classifySessionType(sessionType);

  return kind !== "practice" && kind !== "qualifying";
}

/** The keys of the `raceStart.gridPosition` case — the closed set the position clause is a lookup over. */
export type RaceStartGridPositionKey = "pole" | "composed" | "none";

/**
 * The declared key set of `raceStart.gridPosition`, each with the description
 * the generated reference (#1066) shows a pack author.
 *
 * @internal Exported for testing — the test enumerates the positions and
 * checks the resolver returns nothing outside this set.
 */
export const RACE_START_GRID_POSITION_KEYS: Readonly<Record<RaceStartGridPositionKey, string>> = {
  pole: "Starting from pole — the driver qualified first.",
  composed:
    "A known grid position of second or worse, to read out with raceStart.position — a position the voice has no number clip for aborts the clause.",
  none: "No usable grid position — say nothing about the grid.",
};

/**
 * The grid-position key for a snapshot, mirroring the closures' precedence:
 * `pole` at P1, `composed` from P2 up (whether the voice can speak the number
 * is the var's business — a missing clip aborts the optional clause), and
 * `none` when the position is missing or not a positive number.
 *
 * @internal Exported for testing.
 */
export function resolveRaceStartGridPosition(snapshot: RaceStartSnapshot | null): RaceStartGridPositionKey {
  const position = snapshot?.playerCarPosition;

  if (typeof position !== "number") return "none";

  if (position === 1) return "pole";

  if (position >= 2) return "composed";

  return "none";
}

/**
 * Register the vocabulary the race-start script references (issue #1065):
 * the six vars the brief is built from, the grid-position case and the
 * setup-warning condition. The vars and the case read the snapshot through
 * `getSnapshot` at expansion time and return `null` (nothing to say) when it
 * is unavailable; the condition reads `getSetupWarningMismatch` live, so a
 * mid-session opt-in toggle or pattern edit takes effect immediately —
 * race-start only ever fires in a race session, so no session-type re-check
 * is needed. Names and descriptions are the public API of the format; the
 * descriptions feed the generated reference (#1066).
 */
export function registerRaceStartVocabulary(
  engine: Pick<IScenarioEngine, "defineVar" | "defineCond" | "defineCase">,
  getSnapshot: RaceStartSnapshotResolver,
  getSetupWarningMismatch: SetupWarningResolver = () => false,
): void {
  // Single per-name greeting clip — "Time to race, <Name>." recorded as one
  // sentence rather than composed from a "Time to race," prefix + a bare name
  // clip. Composition produced awkward prosody (sentence terminator + opening
  // intonation on the bare name); per-name clips speak naturally.
  engine.defineVar(
    "raceStart.greeting",
    () => {
      const s = getSnapshot();

      if (!s) return null;

      const name = s.driverName && s.driverName.length > 0 ? s.driverName : "driver";

      return poolRef(RACE_START_GREETING_GROUP, name);
    },
    'The race-start greeting with the driver\'s name — "time to race, <name>" as one clip per name the voice recorded (the generic driver clip when no name is picked). Draws from the race-start-greeting clip group; a name the voice lacks resolves to nothing, so keep it optional.',
  );

  engine.defineVar(
    "raceStart.position",
    () => {
      const s = getSnapshot();

      if (!s || typeof s.playerCarPosition !== "number" || s.playerCarPosition < 1) return null;

      return poolRef(POSITION_NUMBER_GROUP, String(s.playerCarPosition));
    },
    "The grid position as a spoken number. Draws from the position-number clip group; a position the voice has no clip for resolves to nothing and aborts the clause it sits in.",
  );

  engine.defineVar(
    "raceStart.trackTempNumber",
    () => {
      const s = getSnapshot();

      if (!s) return null;

      return poolRef(SESSION_START_TEMP_NUMBERS_GROUP, String(s.trackTemp));
    },
    "The track temperature as a whole number in the driver's display unit. Draws from the session-start-temp-numbers clip group; a reading outside the recorded range aborts the clause it sits in.",
  );

  engine.defineVar(
    "raceStart.airTempNumber",
    () => {
      const s = getSnapshot();

      if (!s) return null;

      return poolRef(SESSION_START_TEMP_NUMBERS_GROUP, String(s.airTemp));
    },
    "The air temperature as a whole number in the driver's display unit. Draws from the session-start-temp-numbers clip group; a reading outside the recorded range aborts the clause it sits in.",
  );

  engine.defineVar(
    "raceStart.degreesUnit",
    () => {
      const s = getSnapshot();

      if (!s) return null;

      return poolRef(SESSION_START_GROUP, `degrees-${s.tempUnit}`);
    },
    "The temperature unit word — degrees celsius or degrees fahrenheit, per the driver's display setting. Draws the degrees-celsius and degrees-fahrenheit lines from the session-start clip group.",
  );

  engine.defineVar(
    "raceStart.wetness",
    () => {
      const s = getSnapshot();
      const suffix = s ? WETNESS_CLIP_SUFFIX[s.wetness] : undefined;

      return suffix ? poolRef(SESSION_START_GROUP, `wetness-${suffix}`) : null;
    },
    "The track wetness state as a word — dry, mostly dry, very lightly wet, lightly wet, moderately wet, very wet or extremely wet. Draws the wetness-<state> lines from the session-start clip group.",
  );

  engine.defineCase(
    "raceStart.gridPosition",
    () => resolveRaceStartGridPosition(getSnapshot()),
    RACE_START_GRID_POSITION_KEYS,
    "Where the driver starts the race: from pole, from a known position to read out, or unknown. Exactly one key applies per start.",
  );

  // Issue #625: the setup-name nudge. Read live at fire time; race-start
  // only ever fires in a race session, so no session-type re-check is needed.
  engine.defineCond(
    "setupWarning.raceMismatch",
    () => getSetupWarningMismatch("race"),
    "The loaded setup's name looks like a qualifying setup at the start of a race, per the driver's setup-name patterns — worth a double-check-your-setup nudge. False when the warning is switched off or no pattern matches.",
  );
}

/**
 * Build the race-start contract bound to a snapshot resolver. Stays a builder
 * because the `where:` reads the resolver (to gate firing) and the logger;
 * the brief itself is the vocabulary's ({@link registerRaceStartVocabulary}).
 */
export function buildRaceStartContract(getSnapshot: RaceStartSnapshotResolver, logger?: ILogger): ScenarioContract {
  return {
    id: "pit-crew.race-start",
    when: {
      event: "session.changed",
      where: (e) => {
        const sessionType = getSessionType();
        const inRace = isRaceSession(sessionType);
        const snapshot = getSnapshot();

        if (!inRace) {
          logger?.info(`race-start where: rejected — sessionType="${sessionType}" is not race`);

          return false;
        }

        if (snapshot === null) {
          logger?.info(`race-start where: rejected — snapshot is null (telemetry not ready / wetness unknown)`);

          return false;
        }

        // Issue #871: the translator's fresh-connect synthesis marks itself
        // with `from: -1`. A fresh connect into a race already underway —
        // post-green (Racing) or post-race (Checkered/CoolDown) — must not
        // replay the grid brief; a restart on the pre-green grid still briefs
        // (starting position + conditions are still actionable). Explicit
        // positive state set (the #647 house style), so a missing/Invalid
        // SessionState briefs rather than suppresses. Defense-in-depth: the
        // translator already latches silently on race + Racing, but the
        // contract owns its firing conditions for harness-fired events.
        const from = (e.data as { from?: number }).from;
        const telemetry = e.telemetry as TelemetryData | null;

        if (from === -1 && (telemetry?.SessionState === SessionState.Racing || isPostRace(telemetry))) {
          logger?.info("race-start where: rejected — fresh connect into a race already underway");
          logger?.debug(`Fresh-connect rejection detail: SessionState=${telemetry?.SessionState}`);

          return false;
        }

        logger?.info(
          `race-start where: passed — sessionType="${sessionType}", position=${snapshot.playerCarPosition ?? "?"}`,
        );

        return true;
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "race-start",
    // Defer where: + var resolution so telemetry has settled by the time we
    // read TrackWetness / TrackTempCrew / AirTemp / PlayerCarPosition. See
    // `RACE_START_DELAY_MS` for the rationale.
    triggerDelay: RACE_START_DELAY_MS,
    description:
      "A race session begins and three seconds pass — a restart on the pre-green grid included, but not when iRaceDeck connects to a race already under way.",
  };
}

/**
 * Stable identifier for the race-start callout (issue #568). Single subject —
 * the whole readout (greeting + position + conditions) is one user-toggleable
 * callout. Kept as a union for symmetry with the other per-callout families
 * so a future second subject (wet-race opener, etc.) can be added by widening
 * the union without restructuring the wiring.
 */
export type RaceStartCalloutId = "race-start";

/**
 * Canonical mapping from `RaceStartCalloutId` to its plugin-global setting
 * key in `GlobalSettingsSchema`. Plugin entry points use this to read the
 * live opt-in without duplicating the key string.
 */
export const RACE_START_CALLOUT_SETTING_KEYS: Record<RaceStartCalloutId, string> = {
  "race-start": "calloutEnabledRaceStart",
};

// `as const` for the compile-time completeness check on `SCENARIO_ID_TO_RACE_START_ID`.
export const RACE_START_SCENARIO_IDS = ["pit-crew.race-start"] as const;

export const SCENARIO_ID_TO_RACE_START_ID: Record<(typeof RACE_START_SCENARIO_IDS)[number], RaceStartCalloutId> = {
  "pit-crew.race-start": "race-start",
};

/**
 * The clip sources the race-start script draws from directly — the pools it
 * addresses as `pool:<group>/<base>` rather than through a var: the two
 * position-clause lines under `race-start`, the three conditions intros it
 * borrows from `session-start` (issue #568 reuses the session-start clips),
 * and the setup nudge under `setup-warning`. The value-driven clips (the
 * greeting, the numbers, the unit, the wetness) are the vars', whose
 * descriptions name their groups. The completeness tests read this list:
 * the bundled voice must ship at least one clip for each, and the bundled
 * script must reference exactly this set. A `(group, base)` a script
 * addresses is published — renaming a base is a rename in every pack's
 * script and every pack's clip folder.
 */
export const RACE_START_CLIP_SOURCES: readonly { group: string; base: string }[] = [
  { group: "race-start", base: "starting-from-pole" },
  { group: "race-start", base: "qualifying-put-us-to" },
  { group: "session-start", base: "track-temp-intro" },
  { group: "session-start", base: "air-temp-intro" },
  { group: "session-start", base: "wetness-intro" },
  { group: "setup-warning", base: "race" },
];
