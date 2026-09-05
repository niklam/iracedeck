/**
 * Qualifying lap-invalidation callout — issue #567; scripted since #1065.
 *
 * Fires on `incident.occurred` when the active session is qualifying and the
 * driver hasn't already heard the callout for the current lap. In the bundled
 * script the core line ("This lap will be invalidated.") always plays; the
 * tail is one of five per-N pre-recorded clips, or the out-of-laps / plenty /
 * silent fallbacks, chosen through the `qualifying.lapsLeft` case:
 *
 *   lapsRemaining === 0     → "We're out of qualifying laps…"
 *   lapsRemaining ∈ [1, 5]  → "N lap(s) left. <unique motivational line>"
 *   lapsRemaining >= 6      → "We still have plenty of laps left…"
 *   !lapLimited (time-qual) → core line only (no tail: `qualifying.tailIsSpeakable` is false)
 *
 * The code below decides WHETHER an incident is worth the line (the
 * qualifying gate and the per-lap latch) and registers the two vocabulary
 * entries the tail hangs on; WHAT is said lives in the active voice's
 * `callouts.json` under the same id
 * (`scenarios["pit-crew.qualifying-invalidation-lap-invalidated"]`), paired at
 * `setScripts` time. The tail is a whole clause (an `if` with no else is
 * right for it), and inside it the branch is a lookup over a closed set — the
 * seven keys of the case — so a pack can collapse the five counts onto one
 * line, or stay silent about a branch, without cutting recordings.
 *
 * The whole callout is suppressed — no core line, no tail — on laps that
 * aren't timed attempts: pit-exit laps (`lapStartedFromPits`) and laps beyond
 * the driver's counted attempts (`lapCounted === false`, issue #776 — lap 3+
 * of a 2-lap qualifying, where iRacing lets the driver keep circulating but
 * nothing is invalidated by an incident).
 *
 * Each per-N clip carries its own full sentence with a unique tail line, so
 * the branch is just a pool lookup keyed on `lapsRemaining` — no composed
 * prosody chain. The trade-off is more recorded clips (one per N) for cleaner
 * audio and simpler runtime.
 *
 * Snapshot-at-fire-time (lap-time / session-start pattern): the plugin caches
 * a snapshot of `{ sessionType, sessionNum, lapsRemaining, lapLimited,
 * lapCompleted, lapStartedFromPits, lapCounted }` from the most recent
 * telemetry tick. The `where:` predicate reads the snapshot to gate on
 * qualifying + per-lap latch; the vocabulary reads it again at
 * sequence-expansion time. A deferred replay therefore speaks the live
 * snapshot when it actually fires — not whatever was current when the event
 * was emitted. That is why both the contract builder and the vocabulary take
 * the resolver.
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
 * **Bus-race with incident contracts.** Both this contract and the
 * `pit-crew.incident-*` contracts subscribe to `incident.occurred` on the
 * Voice bus at the default weight (`WEIGHT.NORMAL`). The engine drops
 * whichever loses the bus-grab race. Two defenses are in place: (1) the
 * incident contracts suppress themselves via a
 * `getSessionType().includes("Qualify")` gate (the correct production
 * semantic — the lap-status news supersedes generic coaching), and (2) this
 * contract is registered BEFORE the incident contracts in `index.ts`, so
 * subscription order keeps the qualifying callout in front when both gates
 * would pass.
 *
 * **The contract names no `base`** — it never did, and the migration keeps
 * the literal verbatim: the script's `pool:qualifying-invalidation/…` steps
 * resolve through the manifest regardless of a base, so nothing is missing.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { QualifyingInvalidationSnapshot } from "@iracedeck/event-bus";

import type { ScenarioContract } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

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
 * post-pit-exit lap — and on any lap beyond the counted attempts
 * (`lapCounted === false`, issue #776), where the driver keeps circulating
 * after their qualifying laps are done. None of these is a timed attempt, so
 * an incident there doesn't waste anything. Side-effect: updates the latch
 * on a positive answer so subsequent incidents on the same lap return
 * `false`. The latch is NOT touched on the suppression paths, so a
 * subsequent valid flying-lap incident still triggers cleanly.
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

  // Beyond the counted laps (issue #776) — the driver kept circulating after
  // their counted qualifying attempts were done (lap 3+ of a 2-lap
  // qualifying). Nothing is invalidated on such a lap, so the whole callout
  // stays silent. Strict `=== false` so a snapshot missing the flag (an
  // untyped producer omitting the field) fails open to the callout rather
  // than going silent on missing data.
  if (snapshot.lapCounted === false) return false;

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

/** The keys of the `qualifying.lapsLeft` case — the closed set the tail is a lookup over. */
export type QualifyingLapsLeftKey = "out-of-laps" | "plenty" | "1" | "2" | "3" | "4" | "5";

/**
 * The declared key set of `qualifying.lapsLeft`, each with the description
 * the generated reference (#1066) shows a pack author.
 *
 * @internal Exported for testing — the test enumerates the reachable
 * snapshots and checks the resolver returns nothing outside this set.
 */
export const QUALIFYING_LAPS_LEFT_KEYS: Readonly<Record<QualifyingLapsLeftKey, string>> = {
  "out-of-laps": "No qualifying laps left — the invalidated lap was the last counted attempt.",
  plenty:
    "Six or more laps left — more than the counted clips name, so the bundled script reassures rather than counts.",
  "1": "One lap left.",
  "2": "Two laps left.",
  "3": "Three laps left.",
  "4": "Four laps left.",
  "5": "Five laps left.",
};

/**
 * The tail's key for a snapshot, mirroring the closures' precedence: nothing
 * when the tail is not speakable (time-limited qualifying, or no telemetry),
 * `out-of-laps` at zero, `plenty` above the counted range, the count itself
 * inside it — and `null` for anything else (a fractional count), which takes
 * the script's `default` branch: with none, the tail says nothing, exactly
 * the silence the closures produced for it.
 *
 * @internal Exported for testing.
 */
export function resolveQualifyingLapsLeft(
  snapshot: QualifyingInvalidationSnapshot | null,
): QualifyingLapsLeftKey | null {
  if (!tailIsSpeakable(snapshot) || snapshot === null) return null;

  const laps = snapshot.lapsRemaining;

  if (laps === 0) return "out-of-laps";

  if (typeof laps !== "number") return null;

  if (laps > QUALIFYING_LAP_COUNT_MAX) return "plenty";

  if (Number.isInteger(laps) && laps >= QUALIFYING_LAP_COUNT_MIN) return String(laps) as QualifyingLapsLeftKey;

  return null;
}

/**
 * Register the vocabulary the qualifying-invalidation script references
 * (issue #1065): the tail gate as a condition and the laps-left lookup as a
 * case. Both read the snapshot through `getSnapshot` at expansion time, so a
 * deferred replay speaks the live count. Names and descriptions are the
 * public API of the format; the descriptions feed the generated reference
 * (#1066).
 */
export function registerQualifyingInvalidationVocabulary(
  engine: Pick<IScenarioEngine, "defineCond" | "defineCase">,
  getSnapshot: QualifyingInvalidationSnapshotResolver,
): void {
  engine.defineCond(
    "qualifying.tailIsSpeakable",
    () => tailIsSpeakable(getSnapshot()),
    "The qualifying session is lap-limited and the laps-left count is known, so a laps-left tail can follow the invalidated line. False in time-limited qualifying, where a lap count means nothing.",
  );

  engine.defineCase(
    "qualifying.lapsLeft",
    () => resolveQualifyingLapsLeft(getSnapshot()),
    QUALIFYING_LAPS_LEFT_KEYS,
    "How many counted qualifying laps remain after the invalidated one: none, one to five by count, or plenty above that. Only meaningful when qualifying.tailIsSpeakable holds.",
  );
}

/**
 * Build the contract bound to a snapshot resolver. Stays a builder because
 * the `where:` reads the resolver (qualifying gate + latch); the tail is the
 * vocabulary's ({@link registerQualifyingInvalidationVocabulary}). The
 * literal names no `base` — see the header.
 */
export function buildQualifyingInvalidationContract(
  getSnapshot: QualifyingInvalidationSnapshotResolver,
): ScenarioContract {
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
    family: "qualifying-invalidation",
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
 * The clip sources the qualifying-invalidation script draws from — every
 * `pool:qualifying-invalidation/<base>` the bundled script may write, as a
 * literal list, since nothing derives it. The completeness tests read it:
 * the bundled voice must ship at least one clip for each, and the bundled
 * script must reference exactly this set. A `(group, base)` a script
 * addresses is published — renaming a base is a rename in every pack's
 * script and every pack's clip folder.
 */
export const QUALIFYING_INVALIDATION_CLIP_SOURCES: readonly { group: "qualifying-invalidation"; base: string }[] = [
  { group: "qualifying-invalidation", base: "invalidated" },
  { group: "qualifying-invalidation", base: "out-of-laps" },
  { group: "qualifying-invalidation", base: "plenty-of-laps" },
  { group: "qualifying-invalidation", base: "1-lap-left" },
  { group: "qualifying-invalidation", base: "2-laps-left" },
  { group: "qualifying-invalidation", base: "3-laps-left" },
  { group: "qualifying-invalidation", base: "4-laps-left" },
  { group: "qualifying-invalidation", base: "5-laps-left" },
];
