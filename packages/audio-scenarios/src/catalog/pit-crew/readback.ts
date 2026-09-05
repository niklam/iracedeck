/**
 * Pit-service readback contracts + vocabulary — issue #476, #481; scripted
 * since #1065.
 *
 * Two contracts driven by `pitService.readbackRequested` (one per `reason`
 * value the sim translator emits):
 *
 *   - `pit-crew.pit-readback-entry`  — fires on `entry` and `entry-refire`.
 *   - `pit-crew.pit-readback-exit`   — fires on `exit`.
 *
 * The code below decides WHETHER and WHEN a readback fires and how it is
 * scheduled; WHAT is read back lives in the active voice's `callouts.json`
 * under the same ids (`scenarios["pit-crew.pit-readback-entry"]`, `…-exit`,
 * sharing the `readback-body` fragment), paired at `setScripts` time. The
 * script branches on the `readback.*` vocabulary registered by
 * {@link registerReadbackVocabulary}: every slot decision the closures used
 * to make — is fuel queued, which tires, is a fast-repair line due — is a
 * named condition or case a pack author can reference and rephrase around.
 * The tire slot is the reason the vocabulary has a `case` at all: it is a
 * lookup over a closed set (two compounds, fifteen corner patterns, none),
 * and a `case` with a declared key set is what lets a pack collapse the
 * three-corner keys onto one line, or stay silent about a pattern, without
 * cutting eighteen recordings (the #1064 spec's worked example).
 *
 * The snapshot is resolved at fire time via the `getSnapshot` closure
 * (issue #481) — NOT pulled from the event payload. The event carries
 * only the trigger `reason`. Reading at fire time keeps the recap fresh
 * when the scenario engine deferred the fire (deferred behind a busier bus,
 * or stashed when an `interrupt` line cut the readback) — the snapshot frozen
 * at emit time would be stale by the time the engineer actually speaks.
 * That is why the vocabulary, not the contract, takes the resolver: every
 * condition and the case read it when the script expands, and the contracts
 * are constants whose `where:` reads only the event.
 *
 * Slot order (the bundled script's; a pack may reorder):
 *   1. Opener           — exit: "To confirm:".
 *                         entry (initial): an optional limiter pre-opener
 *                         ("Don't forget your limiter.") fires when
 *                         `limiterEngaged === false`, followed by the
 *                         always-on `opener-entry` ("We're …"). The two
 *                         are separate clips so the regular opener fires
 *                         every initial entry regardless of limiter state.
 *                         entry-refire: opener slots are skipped — the
 *                         driver already heard the carrier sentence on
 *                         the initial entry, so a mid-lane refire just
 *                         replays the slot content. Only the event knows
 *                         which, so `readback.isFirstEntry` and
 *                         `readback.limiterReminderDue` read the fire
 *                         context's `reason` (the #1065 resolver seam).
 *   2. Fuel             — "taking fuel" / "no fuel".
 *   3. Tires / compound — exactly one of: a tire-pattern clip (15 options),
 *                          a compound-change clip (2), or "no tires" — the
 *                          `readback.tirePattern` case.
 *   4. Fast repair      — "fast repair" / "no fast repair", or omitted
 *                          when the series doesn't offer fast repair.
 *   5. Windshield       — "cleaning the windshield", or omitted when not
 *                          queued.
 *
 * Each slot picks zero or one clip based on the queued-services snapshot;
 * slots that resolve to nothing contribute nothing. There are no connectors
 * between slots — the slot clips are authored with consistent lead-in /
 * lead-out so they flow naturally back-to-back, and every slot is a whole
 * clause, so a shorter recap is still a true one (the second #1064 rule).
 *
 * Empty-snapshot fallback: when fuel + tires + extras all resolve to
 * "omit"/"no", the dedicated empty-fallback clip plays alone instead
 * of stitching a series of negatives (`readback.hasAnyService`). A null
 * snapshot (translator has no telemetry yet) is treated as empty.
 *
 * Family preemption: both contracts share `family: "pit-readback"` so a
 * refire (mid-lane toggle) replaces the running readback wholesale —
 * distinct from #464's per-toggle stitching, which merges live.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { PitReadbackSnapshot, SimEventOf } from "@iracedeck/event-bus";

import { WEIGHT } from "../../dsl.js";
import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

type ReadbackEventData = SimEventOf<"pitService.readbackRequested">["data"];

/**
 * The trigger `reason` of the fire that is expanding, or `null` for an
 * imperative `fire(id)` (the context then carries no event data). A null
 * reason reads as "not the initial entry": the openers stay silent and the
 * body still plays, rather than throwing inside a condition.
 */
function reasonOf(ctx: ScenarioContext): ReadbackEventData["reason"] | null {
  const data = ctx.data as Partial<ReadbackEventData> | null | undefined;

  return data?.reason ?? null;
}

function hasAnyTire(t: PitReadbackSnapshot["tires"]): boolean {
  return t.lf || t.rf || t.lr || t.rr;
}

function hasAnyService(s: PitReadbackSnapshot): boolean {
  return (
    s.fuel.queued ||
    hasAnyTire(s.tires) ||
    s.compoundChange !== null ||
    // Fast-repair is "a service to mention" when the car has damage and the
    // series allows fast-repair. The queued state decides which clip plays
    // (issue #489: drop the line entirely on a clean car).
    (s.hasDamage && s.fastRepair.available) ||
    (s.windshield.available && s.windshield.queued)
  );
}

/**
 * Resolver for the queued-services snapshot. Returns `null` when no
 * snapshot is available (translator hasn't seen telemetry yet); the
 * vocabulary treats null as the empty snapshot, which collapses to the
 * fallback clip rather than fabricating a "no fuel, no tires" recap.
 */
export type ReadbackSnapshotResolver = () => PitReadbackSnapshot | null;

/**
 * The keys of the `readback.tirePattern` case — the closed set the tire
 * slot is a lookup over. Published with the case, so the type is the
 * declared key set and nothing else.
 */
export type TirePatternKey =
  | "compound-dry"
  | "compound-wet"
  | "all"
  | "fronts"
  | "rears"
  | "lefts"
  | "rights"
  | "lf-rr"
  | "rf-lr"
  | "skip-lf"
  | "skip-rf"
  | "skip-lr"
  | "skip-rr"
  | "lf"
  | "rf"
  | "lr"
  | "rr"
  | "none";

/**
 * The declared key set of `readback.tirePattern`, each with the description
 * the generated reference (#1066) shows a pack author. Mirrors the names
 * `toggle-confirmations.ts` uses so the readback's vocabulary matches the
 * per-toggle confirmation's one-to-one.
 *
 * @internal Exported for testing — the test enumerates every reachable
 * snapshot and checks the resolver returns nothing outside this set.
 */
export const TIRE_PATTERN_KEYS: Readonly<Record<TirePatternKey, string>> = {
  "compound-dry": "A compound change to dry — covers all four tires, so no corner pattern applies.",
  "compound-wet": "A compound change to wet — covers all four tires, so no corner pattern applies.",
  all: "All four tires.",
  fronts: "Both fronts only.",
  rears: "Both rears only.",
  lefts: "Both left-side tires only.",
  rights: "Both right-side tires only.",
  "lf-rr": "The left-front and right-rear diagonal.",
  "rf-lr": "The right-front and left-rear diagonal.",
  "skip-lf": "Three corners — every tire except the left-front.",
  "skip-rf": "Three corners — every tire except the right-front.",
  "skip-lr": "Three corners — every tire except the left-rear.",
  "skip-rr": "Three corners — every tire except the right-rear.",
  lf: "The left-front only.",
  rf: "The right-front only.",
  lr: "The left-rear only.",
  rr: "The right-rear only.",
  none: "No tire change and no compound change queued.",
};

/**
 * 15-way exhaustive tire-pattern lookup. Patterns are mutually exclusive,
 * so at most one entry matches per snapshot; a snapshot matching none has
 * no tire bits set.
 */
const TIRE_PATTERNS: ReadonlyArray<{
  match: (t: PitReadbackSnapshot["tires"]) => boolean;
  key: TirePatternKey;
}> = [
  // 4 corners
  { match: (t) => t.lf && t.rf && t.lr && t.rr, key: "all" },
  // Same-axis pairs
  { match: (t) => t.lf && t.rf && !t.lr && !t.rr, key: "fronts" },
  { match: (t) => !t.lf && !t.rf && t.lr && t.rr, key: "rears" },
  { match: (t) => t.lf && !t.rf && t.lr && !t.rr, key: "lefts" },
  { match: (t) => !t.lf && t.rf && !t.lr && t.rr, key: "rights" },
  // Diagonals
  { match: (t) => t.lf && !t.rf && !t.lr && t.rr, key: "lf-rr" },
  { match: (t) => !t.lf && t.rf && t.lr && !t.rr, key: "rf-lr" },
  // 3-corner (skip one)
  { match: (t) => !t.lf && t.rf && t.lr && t.rr, key: "skip-lf" },
  { match: (t) => t.lf && !t.rf && t.lr && t.rr, key: "skip-rf" },
  { match: (t) => t.lf && t.rf && !t.lr && t.rr, key: "skip-lr" },
  { match: (t) => t.lf && t.rf && t.lr && !t.rr, key: "skip-rr" },
  // Singles
  { match: (t) => t.lf && !t.rf && !t.lr && !t.rr, key: "lf" },
  { match: (t) => !t.lf && t.rf && !t.lr && !t.rr, key: "rf" },
  { match: (t) => !t.lf && !t.rf && t.lr && !t.rr, key: "lr" },
  { match: (t) => !t.lf && !t.rf && !t.lr && t.rr, key: "rr" },
];

/**
 * The tire/compound slot's key for a snapshot. Precedence is the closures':
 * a compound change (dry / wet) first — it implicitly covers all four tires,
 * so the corner pattern is not spoken beside it — then the fifteen corner
 * patterns, then `none` when no bit is set. A compound change to a compound
 * the catalog has no word for resolves to `null`: the case takes its
 * `default` branch, and with none the slot says nothing — exactly the
 * silence the closures produced for it.
 *
 * @internal Exported for testing.
 */
export function resolveTirePattern(s: PitReadbackSnapshot): TirePatternKey | null {
  if (s.compoundChange !== null) {
    if (s.compoundChange.to === 0) return "compound-dry";

    if (s.compoundChange.to === 1) return "compound-wet";

    return null;
  }

  return TIRE_PATTERNS.find(({ match }) => match(s.tires))?.key ?? "none";
}

/**
 * The empty snapshot — used when the resolver returns `null` (translator
 * has no live telemetry yet). Treating this as the canonical "nothing
 * queued" view collapses the readback to the empty-fallback clip rather
 * than fabricating a "no fuel, no tires" string.
 */
const EMPTY_SNAPSHOT: PitReadbackSnapshot = {
  fuel: { queued: false },
  tires: { lf: false, rf: false, lr: false, rr: false },
  compoundChange: null,
  fastRepair: { queued: false, available: false },
  windshield: { queued: false, available: false },
  limiterEngaged: false,
  hasPitLimiter: false,
  hasDamage: false,
};

/**
 * Register the vocabulary the readback scripts reference (issue #1065): the
 * seven conditions the slots and openers hang on, and the tire-pattern
 * case. Every resolver reads the queued-services snapshot through
 * `getSnapshot` at expansion time — never a value captured earlier — which
 * is what keeps a deferred or resumed readback honest (issue #481); the two
 * opener conditions also read the fire's `reason`, since only the event
 * knows an initial entry from a mid-lane refire. Names and descriptions are
 * the public API of the format; the descriptions feed the generated
 * reference (#1066).
 */
export function registerReadbackVocabulary(
  engine: Pick<IScenarioEngine, "defineCond" | "defineCase">,
  getSnapshot: ReadbackSnapshotResolver,
): void {
  const snapshot = (): PitReadbackSnapshot => getSnapshot() ?? EMPTY_SNAPSHOT;

  // The pre-opener fires when the car HAS a limiter and it isn't engaged on
  // the initial entry — the warning is meaningless on cars without a limiter
  // (issue #639), and matters whether or not the driver has any services
  // queued otherwise; hence it sits outside the `hasAnyService` branch.
  engine.defineCond(
    "readback.limiterReminderDue",
    (ctx) => {
      const s = snapshot();

      return reasonOf(ctx) === "entry" && s.hasPitLimiter && !s.limiterEngaged;
    },
    "The car has a pit limiter and it is not engaged on the initial pit-lane entry, so a reminder is due before the readback. Never true on a mid-lane refire, on the exit readback, or on a car without a limiter.",
  );

  engine.defineCond(
    "readback.hasAnyService",
    () => hasAnyService(snapshot()),
    "At least one service is queued: fuel, any tire, a compound change, fast repair on a damaged car in a series that offers it, or a windshield clean. When false the bundled script plays the empty-fallback line alone instead of a string of negatives.",
  );

  // The opener is gated on `reason === "entry"` so refires (`entry-refire`)
  // skip the carrier sentence and replay only the slot content.
  engine.defineCond(
    "readback.isFirstEntry",
    (ctx) => reasonOf(ctx) === "entry",
    "This is the initial pit-lane entry, not a mid-lane refire after the driver changed the queue — the carrier sentence (the opener) is worth speaking only once.",
  );

  engine.defineCond("readback.fuelQueued", () => snapshot().fuel.queued, "Fuel is queued for the stop.");

  engine.defineCase(
    "readback.tirePattern",
    () => resolveTirePattern(snapshot()),
    TIRE_PATTERN_KEYS,
    "Which tires, or which compound change, are queued for the stop. A compound change covers all four tires and takes precedence over the corner pattern; exactly one key applies per snapshot.",
  );

  // Issue #489: gate on `hasDamage` (EngineWarnings & Mand|OptRepNeeded).
  //   - clean car          → omit the slot entirely (no callout, regardless of queued)
  //   - damaged + queued   → "we're doing fast repairs"
  //   - damaged + !queued  → "we're not doing fast repair"  (warns the driver)
  // The series-level `available` gate stays so cars without fast-repair
  // service stay silent even when damaged. Two conditions rather than one
  // case: each is a whole clause a pack may keep or drop on its own.
  engine.defineCond(
    "readback.fastRepairQueued",
    () => {
      const s = snapshot();

      return s.hasDamage && s.fastRepair.available && s.fastRepair.queued;
    },
    "The car is damaged, the series offers fast repair, and fast repair is queued. False on a clean car, so nothing is said about repairs then.",
  );
  engine.defineCond(
    "readback.fastRepairSkipped",
    () => {
      const s = snapshot();

      return s.hasDamage && s.fastRepair.available && !s.fastRepair.queued;
    },
    "The car is damaged, the series offers fast repair, and fast repair is NOT queued — worth warning the driver about. False on a clean car, so nothing is said about repairs then.",
  );

  // Only mention windshield when it's queued. Skipping the negative
  // ("no windshield") sidesteps the open-wheel false-positive — formula
  // / indycar / dirt cars don't have a windshield to clean, and iRacing
  // doesn't expose an "is windshield service available" signal in
  // telemetry to gate on.
  engine.defineCond(
    "readback.windshieldQueued",
    () => snapshot().windshield.queued,
    "A windshield clean is queued. Only the positive is ever worth speaking: open-wheel cars have no windshield and telemetry cannot tell, so there is no negative line.",
  );
}

function readbackContract(reason: "entry" | "exit"): ScenarioContract {
  const isEntry = reason === "entry";

  return {
    id: `pit-crew.pit-readback-${reason}`,
    when: {
      event: "pitService.readbackRequested",
      where: (e) => {
        const r = (e as SimEventOf<"pitService.readbackRequested">).data.reason;

        // The entry contract fires on both `entry` and `entry-refire`.
        return isEntry ? r === "entry" || r === "entry-refire" : r === "exit";
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    // `weight: WEIGHT.CHATTER` keeps the readback deferring behind ordinary
    // callouts: it still loses the bus to flags / normal callouts (flags,
    // limiter callouts) and replays once the bus goes idle via
    // `queueable: true`. The pit-box count-in OUTRANKS the readback and cuts
    // it (issue #758,
    // reversing #646 — the countdown is the time-critical callout on
    // approach); `resumable: true` makes the interrupted readback continue
    // from the clip it was cut on once the count-in finishes, instead of
    // re-firing from the top. The engine re-expands before resuming, so a
    // snapshot that changed while stashed still falls back to a full fresh
    // replay (the #481 freshness guarantee).
    weight: WEIGHT.CHATTER,
    queueable: true,
    resumable: true,
    family: "pit-readback",
  };
}

/**
 * Both pit-readback contracts. Constants, not a builder: nothing here reads
 * the snapshot — the `where:` reads only the event's `reason`, and every
 * snapshot-dependent decision is in the vocabulary
 * ({@link registerReadbackVocabulary}), which is what takes the resolver.
 */
export const PIT_READBACK_CONTRACTS: readonly ScenarioContract[] = [
  readbackContract("entry"),
  readbackContract("exit"),
];

export const PIT_READBACK_SCENARIO_IDS: readonly string[] = PIT_READBACK_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the readback scripts draw from — every
 * `pool:pit-readback/<base>` the bundled script may write, as a literal
 * list, since nothing derives it. The completeness tests read it: the
 * bundled voice must ship at least one clip for each, and the bundled
 * script must reference exactly this set. A `(group, base)` a script
 * addresses is published — renaming a base is a rename in every pack's
 * script and every pack's clip folder. `windshield-off` is deliberately
 * not a source: the negative is never spoken (see
 * `readback.windshieldQueued`), though the bundled voice still ships the
 * clip.
 */
export const PIT_READBACK_CLIP_SOURCES: readonly { group: "pit-readback"; base: string }[] = [
  { group: "pit-readback", base: "opener-entry" },
  { group: "pit-readback", base: "opener-entry-limiter" },
  { group: "pit-readback", base: "opener-exit" },
  { group: "pit-readback", base: "empty-fallback" },
  { group: "pit-readback", base: "fuel-on" },
  { group: "pit-readback", base: "fuel-off" },
  { group: "pit-readback", base: "compound-dry" },
  { group: "pit-readback", base: "compound-wet" },
  { group: "pit-readback", base: "tires-all" },
  { group: "pit-readback", base: "tires-fronts" },
  { group: "pit-readback", base: "tires-rears" },
  { group: "pit-readback", base: "tires-lefts" },
  { group: "pit-readback", base: "tires-rights" },
  { group: "pit-readback", base: "tires-lf-rr" },
  { group: "pit-readback", base: "tires-rf-lr" },
  { group: "pit-readback", base: "tires-skip-lf" },
  { group: "pit-readback", base: "tires-skip-rf" },
  { group: "pit-readback", base: "tires-skip-lr" },
  { group: "pit-readback", base: "tires-skip-rr" },
  { group: "pit-readback", base: "tires-lf" },
  { group: "pit-readback", base: "tires-rf" },
  { group: "pit-readback", base: "tires-lr" },
  { group: "pit-readback", base: "tires-rr" },
  { group: "pit-readback", base: "tires-off" },
  { group: "pit-readback", base: "fast-repair-on" },
  { group: "pit-readback", base: "fast-repair-off" },
  { group: "pit-readback", base: "windshield-on" },
];

/**
 * Stable identifier for each user-toggleable pit-readback callout. Two
 * subjects today, one per contract id; future fanouts (per-stop reason,
 * per-series tone) would extend this enum.
 */
export type PitReadbackCalloutId = "pit-readback-entry" | "pit-readback-exit";

/**
 * Canonical mapping from `PitReadbackCalloutId` to its plugin-global
 * setting key in `GlobalSettingsSchema`. Plugin entry points use this to
 * read the live opt-in for each readback without duplicating key strings.
 */
export const PIT_READBACK_CALLOUT_SETTING_KEYS: Record<PitReadbackCalloutId, string> = {
  "pit-readback-entry": "calloutEnabledPitReadbackEntry",
  "pit-readback-exit": "calloutEnabledPitReadbackExit",
};

export const SCENARIO_ID_TO_PIT_READBACK_ID: Record<string, PitReadbackCalloutId> = {
  "pit-crew.pit-readback-entry": "pit-readback-entry",
  "pit-crew.pit-readback-exit": "pit-readback-exit",
};
