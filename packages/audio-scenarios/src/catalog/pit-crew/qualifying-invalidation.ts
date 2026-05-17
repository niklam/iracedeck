/**
 * Qualifying lap-invalidation callout — issue #567.
 *
 * Fires on `incident.occurred` when the active session is qualifying and the
 * driver hasn't already heard the callout for the current lap. The core line
 * ("This lap will be invalidated.") always plays; the tail is one of five
 * per-N pre-recorded clips, or the out-of-laps / plenty / silent fallbacks:
 *
 *   lapsRemaining === 0     → "We're out of qualifying laps…"
 *   lapsRemaining ∈ [1, 5]  → "N lap(s) left. <unique motivational line>"
 *   lapsRemaining >= 6      → "We still have plenty of laps left…"
 *   !lapLimited (time-qual) → core line only (no tail)
 *
 * Each per-N clip carries its own full sentence with a unique tail line, so
 * the scenario is just a pool lookup keyed on `lapsRemaining` — no var
 * resolver, no singular/plural switch, no composed prosody chain. The trade-off
 * is more recorded clips (one per N) for cleaner audio and simpler runtime.
 *
 * Snapshot-at-fire-time (lap-time / session-start pattern): the plugin caches
 * a snapshot of `{ sessionType, sessionNum, lapsRemaining, lapLimited,
 * lapCompleted }` from the most recent telemetry tick. The `where:` predicate
 * reads the snapshot to gate on qualifying + per-lap latch; the per-clip `if`
 * branches read it again at sequence-expansion time. A deferred replay
 * therefore speaks the live snapshot when it actually fires — not whatever was
 * current when the event was emitted.
 *
 * **Per-lap latch.** Multiple incidents on the same flying lap (a wall
 * brush followed by an off-track in the same corner) collapse to one
 * callout. The latch lives in module-scope state keyed by `(sessionNum,
 * lapCompleted)` and is reset by {@link resetQualifyingInvalidationLatch}
 * (used by tests; production code never calls it).
 *
 * **Family preemption.** Single subject for v1; the `family` identifier is
 * carried anyway so a future second qualifying-related callout shares
 * preemption with this one.
 *
 * **Bus-race with incident scenarios.** Both this scenario and the existing
 * `pit-crew.incident-*` scenarios subscribe to `incident.occurred` on the
 * Voice bus at `priority: "normal"`. The engine drops whichever loses the
 * bus-grab race. Two defenses are in place: (1) the incident scenarios
 * suppress themselves via a `getSessionType().includes("Qualify")` gate (the
 * correct production semantic — the lap-status news supersedes generic
 * coaching), and (2) this scenario is registered BEFORE the incident
 * scenarios in `index.ts`, so subscription order keeps the qualifying
 * callout in front when both gates would pass.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { QualifyingInvalidationSnapshot } from "@iracedeck/event-bus";

import type { Scenario, Step } from "../../dsl.js";

export type { QualifyingInvalidationSnapshot };

/**
 * Resolver for the snapshot. Returns `null` when telemetry isn't available
 * (pre-session, between sessions, mid-reconnect). A `null` return makes the
 * `where:` predicate short-circuit, so the callout stays silent.
 */
export type QualifyingInvalidationSnapshotResolver = () => QualifyingInvalidationSnapshot | null;

/**
 * Counted-clip range for the per-N tail. Numbers outside this range fall to
 * the "plenty of laps" branch. Keeps the clip set bounded while still naming
 * the count for every realistic qualifying format (oval 2-lap qual up through
 * 5-lap formats).
 *
 * @internal Exported for tests.
 */
export const QUALIFYING_LAP_COUNT_MIN = 1;
export const QUALIFYING_LAP_COUNT_MAX = 5;

/** Module-scope per-lap latch. Keyed by `(sessionNum, lapCompleted)`. */
let lastAnnounced: { sessionNum: number | undefined; lap: number } | null = null;

/**
 * Reset the per-lap latch. Used by tests to isolate one fire from the next;
 * production code has no reason to call this — the latch composite naturally
 * advances as the driver crosses S/F or changes sessions.
 *
 * @internal
 */
export function resetQualifyingInvalidationLatch(): void {
  lastAnnounced = null;
}

/**
 * Decide whether the current snapshot represents a new qualifying flying lap
 * that hasn't been announced yet. Returns false on any lap that started from
 * pit exit (`lapStartedFromPits === true`) — that includes the session
 * out-lap (it began when the driver exited the pit box) AND any mid-session
 * post-pit-exit lap. Neither is a timed attempt, so an incident there doesn't
 * waste anything. Side-effect: updates the latch on a positive answer so
 * subsequent incidents on the same lap return `false`. The latch is NOT
 * touched on the suppression paths, so a subsequent valid flying-lap
 * incident still triggers cleanly.
 *
 * @internal Exported for tests.
 */
export function checkAndUpdateQualifyingLatch(snapshot: QualifyingInvalidationSnapshot): boolean {
  if (snapshot.sessionType !== "qualifying") return false;

  // Pit-exit lap — covers both the session out-lap (driver exits the pit
  // box at session start) and any mid-session post-pit-exit lap. The plugin
  // captures `LapCompleted` at `pitLane.exited` time; this flag is true
  // while the driver is still on that same lap, and self-clears when
  // `LapCompleted` advances at S/F.
  if (snapshot.lapStartedFromPits) return false;

  if (
    lastAnnounced !== null &&
    lastAnnounced.sessionNum === snapshot.sessionNum &&
    lastAnnounced.lap === snapshot.lapCompleted
  ) {
    return false;
  }

  lastAnnounced = { sessionNum: snapshot.sessionNum, lap: snapshot.lapCompleted };

  return true;
}

/** Whether the tail clause should be spoken at all. */
function tailIsSpeakable(snapshot: QualifyingInvalidationSnapshot | null): boolean {
  // Time-limited qualifying has no meaningful "N laps left" reading — speak
  // the core line only. Same fallback when telemetry is missing entirely.
  if (!snapshot || !snapshot.lapLimited) return false;

  return typeof snapshot.lapsRemaining === "number" && snapshot.lapsRemaining >= 0;
}

function lapsRemainingEquals(snapshot: QualifyingInvalidationSnapshot | null, n: number): boolean {
  return snapshot !== null && snapshot.lapsRemaining === n;
}

function isPlentyOfLaps(snapshot: QualifyingInvalidationSnapshot | null): boolean {
  return (
    snapshot !== null &&
    snapshot.lapLimited &&
    typeof snapshot.lapsRemaining === "number" &&
    snapshot.lapsRemaining > QUALIFYING_LAP_COUNT_MAX
  );
}

/**
 * Build the scenario bound to a snapshot resolver. The resolver is read in the
 * `where:` predicate (qualifying gate + latch) and again in every tail branch
 * predicate (each per-N branch reads `lapsRemaining` to pick its pool).
 */
export function buildQualifyingInvalidationScenario(getSnapshot: QualifyingInvalidationSnapshotResolver): Scenario {
  // Flat-list of (predicate → pool) per N keeps the sequence readable and
  // makes adding a counted-clip (or removing one) a one-line change.
  const perCountBranches: Step[] = [];

  for (let n = QUALIFYING_LAP_COUNT_MIN; n <= QUALIFYING_LAP_COUNT_MAX; n++) {
    const poolName = n === 1 ? "qualifying-1-lap-left" : `qualifying-${n}-laps-left`;

    perCountBranches.push({
      if: () => lapsRemainingEquals(getSnapshot(), n),
      then: [`pool:${poolName}`],
    });
  }

  const sequence: Step[] = [
    "@pit-crew.radio-open",
    "pool:qualifying-invalidated",
    {
      if: () => tailIsSpeakable(getSnapshot()),
      then: [
        {
          if: () => lapsRemainingEquals(getSnapshot(), 0),
          then: ["pool:qualifying-out-of-laps"],
          else: [
            {
              if: () => isPlentyOfLaps(getSnapshot()),
              then: ["pool:qualifying-plenty-of-laps"],
              else: perCountBranches,
            },
          ],
        },
      ],
    },
    "@pit-crew.radio-close",
  ];

  return {
    id: "pit-crew.qualifying-invalidation-lap-invalidated",
    when: {
      event: "incident.occurred",
      where: () => {
        const snapshot = getSnapshot();

        if (snapshot === null) return false;

        return checkAndUpdateQualifyingLatch(snapshot);
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    priority: "normal",
    family: "qualifying-invalidation",
    sequence,
  };
}

/**
 * Stable identifier for the qualifying lap-invalidation callout (issue #567).
 * Single subject — the whole callout (core line + branched tail) is one
 * user-toggleable unit.
 */
export type QualifyingInvalidationCalloutId = "lap-invalidated";

/**
 * Canonical mapping from {@link QualifyingInvalidationCalloutId} to its
 * plugin-global setting key in `GlobalSettingsSchema`. Plugin entry points use
 * this to read the live opt-in without duplicating the key string.
 */
export const QUALIFYING_INVALIDATION_CALLOUT_SETTING_KEYS: Record<QualifyingInvalidationCalloutId, string> = {
  "lap-invalidated": "calloutEnabledQualifyingLapInvalidated",
};

// `as const` so the element type is a literal union the
// `SCENARIO_ID_TO_QUALIFYING_INVALIDATION_ID` `Record` key can be tightened
// against — a typo in either constant fails at compile time instead of
// slipping past as a `string` mismatch (mirrors the pattern in `position.ts`).
export const QUALIFYING_INVALIDATION_SCENARIO_IDS = [
  "pit-crew.qualifying-invalidation-lap-invalidated",
] as const;

export const SCENARIO_ID_TO_QUALIFYING_INVALIDATION_ID: Record<
  (typeof QUALIFYING_INVALIDATION_SCENARIO_IDS)[number],
  QualifyingInvalidationCalloutId
> = {
  "pit-crew.qualifying-invalidation-lap-invalidated": "lap-invalidated",
};

/**
 * Pool names this catalog draws from — kept here so tests can assert the
 * registration set and so the cross-cutting `register-pit-crew.test.ts`
 * gets a single import surface.
 */
export const QUALIFYING_INVALIDATION_POOL_NAMES: readonly string[] = [
  "qualifying-invalidated",
  "qualifying-out-of-laps",
  "qualifying-plenty-of-laps",
  "qualifying-1-lap-left",
  "qualifying-2-laps-left",
  "qualifying-3-laps-left",
  "qualifying-4-laps-left",
  "qualifying-5-laps-left",
];
