/**
 * Session-start readout scenario — issues #542, #668.
 *
 * Fires when a practice or qualifying session starts — on `session.changed`,
 * approximately {@link SESSION_START_DELAY_MS} after the session begins — whether
 * or not the driver leaves the garage. Race sessions are covered exclusively by
 * the race-start scenario (issue #568), which fires on the same event; the
 * `where:` predicate rejects `sessionType === "race"` here so the two scenarios
 * never double-greet.
 *
 * Riding `session.changed` also inherits:
 *   - Replay-only suppression (issue #604): the event is gated at emission in
 *     the sim-events-iracing translator, so replays never trigger a brief.
 *   - Fresh-connect synthetic event: when the plugin connects mid-session, the
 *     translator emits a synthetic `session.changed { from: -1, to: N }` —
 *     connecting mid-practice or mid-qualifying triggers the brief.
 *
 * The delay is implemented as `triggerDelay` after {@link SESSION_START_DELAY_MS}
 * (see its doc for why this is a `triggerDelay`, not a leading pause).
 *
 * Script (fires ~{@link SESSION_START_DELAY_MS} ms after `session.changed`):
 *   [radio open]
 *   "Ok, <Name>,"                                  greeting (per-name clip)
 *   <session line>                                 practice / qualifying
 *   "The pit speed limit is" <N> <speed-unit>      CONDITIONAL — see below
 *   "Track temperature is" <N> "degrees" <unit>
 *   "air temperature is" <N> "degrees" <unit>
 *   "and the track is" <wetness-state>
 *   [radio close]
 *
 * Snapshot-at-fire-time (readback.ts pattern, issue #481): every dynamic clip
 * is a `{ var }` step backed by a resolver that reads the snapshot closure at
 * fire time, so a deferred replay speaks current conditions. Units, rounding,
 * and the session-type bucket are resolved upstream in
 * `getSessionStartConditions()` — this file only maps the snapshot fields onto
 * clip paths.
 *
 * The pit-speed clause is conditional: iRacing pit limits are a small known
 * set, so the `session-start-speed-numbers` group only covers observed values
 * (plus ±1 for telemetry drift). The clause is skipped entirely for any value
 * outside {@link SESSION_START_SPEED_VALUES} — a guessed or rounded number
 * could imply a false pit-speed-penalty risk.
 *
 * `where:` is `getSnapshot() !== null && sessionType !== "race"`, so the
 * scenario doesn't fire at all when conditions are unavailable (no telemetry /
 * session info, or wetness still `Unknown`), and never fires in race sessions.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type SessionStartSnapshot, TrackWetness } from "@iracedeck/event-bus";

import type { Scenario, Step } from "../../dsl.js";
import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/**
 * Resolver for the session-start snapshot, invoked at fire time. Returns
 * `null` when conditions aren't available — the scenario then skips the
 * callout entirely (its `where:` predicate short-circuits).
 */
export type SessionStartSnapshotResolver = () => SessionStartSnapshot | null;

/**
 * Delay before the where: predicate and sequence-expansion run, once
 * `session.changed` fires for a practice or qualifying session. Implemented as
 * the scenario's `triggerDelay` (NOT a leading `{ pause }` step) so iRacing's
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

const SESSION_START_BASE = "session-start";

/** Group holding the setup-mismatch warning clips (issue #625). */
const SETUP_WARNING_GROUP = "setup-warning";

/** Build a `clip` step path relative to the scenario's `voice/{voice}` base. */
function clipPath(filename: string): string {
  return `${SESSION_START_BASE}/${filename}`;
}

/**
 * Register the session-start scenario's variables on the scenario engine.
 * Must run before the scenario is defined — load-time validation rejects a
 * `{ var }` step whose name isn't registered. The resolvers close over the
 * snapshot closure and return `null` (a no-op step) whenever conditions
 * aren't available.
 *
 * Every resolver returns a dynamic pool reference (issue #836): the clips
 * that exist for the active voice define what values are speakable, so there
 * are no hardcoded speed/temperature ranges — a value with no clip skips its
 * `optional` clause (or aborts the callout for required content, per #835).
 */
export function registerSessionStartVars(engine: IScenarioEngine, getSnapshot: SessionStartSnapshotResolver): void {
  engine.defineVar("sessionStart.greeting", () => {
    const s = getSnapshot();

    return s ? poolRef("session-start-greeting", s.driverName) : null;
  });

  engine.defineVar("sessionStart.sessionLine", () => {
    const s = getSnapshot();

    return s ? poolRef("session-start", `session-${s.sessionType}`) : null;
  });

  engine.defineVar("sessionStart.speedNumber", () => {
    const s = getSnapshot();

    return s ? poolRef("session-start-speed-numbers", String(s.pitSpeedLimit)) : null;
  });

  engine.defineVar("sessionStart.speedUnit", () => {
    const s = getSnapshot();

    return s ? poolRef("session-start", `speed-unit-${s.speedUnit}`) : null;
  });

  engine.defineVar("sessionStart.trackTempNumber", () => {
    const s = getSnapshot();

    return s ? poolRef("session-start-temp-numbers", String(s.trackTemp)) : null;
  });

  engine.defineVar("sessionStart.airTempNumber", () => {
    const s = getSnapshot();

    return s ? poolRef("session-start-temp-numbers", String(s.airTemp)) : null;
  });

  engine.defineVar("sessionStart.degreesUnit", () => {
    const s = getSnapshot();

    return s ? poolRef("session-start", `degrees-${s.tempUnit}`) : null;
  });

  engine.defineVar("sessionStart.wetness", () => {
    const s = getSnapshot();
    const suffix = s ? WETNESS_CLIP_SUFFIX[s.wetness] : undefined;

    return suffix ? poolRef("session-start", `wetness-${suffix}`) : null;
  });
}

/**
 * Construct the session-start scenario from a prepared sequence, injecting the
 * shared scenario shape (mirrors the `<family>Scenario(...)` helpers in the
 * sibling pit-crew catalog files): the fixed id, the snapshot-gated `when`
 * block, and the shared channel / bus / base / family defaults (weight is
 * omitted, so it defaults to `WEIGHT.NORMAL`).
 */
function sessionStartScenario(getSnapshot: SessionStartSnapshotResolver, sequence: Step[]): Scenario {
  return {
    id: "pit-crew.session-start",
    when: {
      event: "session.changed",
      where: () => {
        const snapshot = getSnapshot();

        if (snapshot === null) return false;

        // Race sessions are spoken exclusively by the race-start scenario
        // (issue #568), whose `where:` requires `isRaceSession(getSessionType())`.
        // Rejecting `sessionType === "race"` here prevents a double-greeting
        // when both scenarios ride the same `session.changed` event.
        //
        // We read `snapshot.sessionType` (not `isRaceSession(getSessionType())`)
        // because the snapshot is the injected seam: the var resolvers and the
        // scenario-harness session-start composer both drive it directly via the
        // snapshot resolver, so the gate and the spoken session-type line are
        // always drawn from the same source and can't disagree.
        if (snapshot.sessionType === "race") return false;

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
    sequence,
  };
}

/**
 * Build the session-start scenario bound to a snapshot resolver. The resolver
 * is read in the `where:` predicate (to gate firing) and inside the
 * pit-speed `if` step (to gate the conditional clause); the per-clip `var`
 * resolvers registered by {@link registerSessionStartVars} read it again at
 * sequence-expansion time.
 *
 * `getSetupWarningMismatch` (issue #625) appends a "double-check your setup"
 * nudge before the radio close when, in a **qualifying** session, the loaded
 * setup name looks like a race setup. It is read live at fire time so a
 * mid-session opt-in toggle or pattern edit takes effect immediately. Practice
 * sessions never warn (only qualifying and — via race-start — race do).
 */
export function buildSessionStartScenario(
  getSnapshot: SessionStartSnapshotResolver,
  getSetupWarningMismatch: (kind: "qualifying" | "race") => boolean = () => false,
): Scenario {
  const sequence: Step[] = [
    "@pit-crew.radio-open",
    // Optional (issue #835): driver names are a union across voices, so a
    // voice lacking the picked name clip skips the greeting — a complete
    // sentence either way — instead of aborting the whole brief.
    { optional: [{ var: "sessionStart.greeting" }] },
    { var: "sessionStart.sessionLine" },
    // Optional clause (issues #835/#836): whether a pit-speed value is
    // speakable derives from the clips that exist — a limit (or a voice)
    // without the number clip skips the WHOLE clause (never "The pit speed
    // limit is…" with no number) while the rest of the brief still plays.
    {
      optional: [
        clipPath("pit-speed-intro.mp3"),
        { var: "sessionStart.speedNumber" },
        { var: "sessionStart.speedUnit" },
      ],
    },
    // Optional clauses (issue #836): the temp clip range is defined by the
    // generated clips (no clamping) — a reading outside it skips its clause
    // rather than speaking a wrong clamped number or killing the brief.
    {
      optional: [
        clipPath("track-temp-intro.mp3"),
        { var: "sessionStart.trackTempNumber" },
        { var: "sessionStart.degreesUnit" },
      ],
    },
    {
      optional: [
        clipPath("air-temp-intro.mp3"),
        { var: "sessionStart.airTempNumber" },
        { var: "sessionStart.degreesUnit" },
      ],
    },
    clipPath("wetness-intro.mp3"),
    { var: "sessionStart.wetness" },
    {
      if: () => getSnapshot()?.sessionType === "qualifying" && getSetupWarningMismatch("qualifying"),
      // Optional clause (issue #835): the nudge is a self-contained add-on —
      // a voice without the clip skips it, not the brief.
      then: [{ optional: [`${SETUP_WARNING_GROUP}/qualifying-01.mp3`] }],
    },
    "@pit-crew.radio-close",
  ];

  return sessionStartScenario(getSnapshot, sequence);
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
 * Empty — the session-start brief is composed from static `clipPath(...)` steps
 * and `engine.defineVar` resolvers (see {@link registerSessionStartVars}), not
 * pools. Exported anyway for parity with the family-completeness check used by
 * the other pit-crew catalog files.
 */
export const SESSION_START_POOL_NAMES: readonly string[] = [];
