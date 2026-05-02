/**
 * Pit-service readback scenarios — issue #476, #481.
 *
 * Two scenarios driven by `pitService.readbackRequested` (one per `reason`
 * value the sim translator emits):
 *
 *   - `pit-crew.pit-readback-entry`  — fires on `entry` and `entry-refire`.
 *   - `pit-crew.pit-readback-exit`   — fires on `exit`.
 *
 * Each slot picks zero or one clip based on the queued-services snapshot;
 * slots that resolve to "omit" contribute nothing. There are no connectors
 * between slots — the slot clips are authored with consistent lead-in /
 * lead-out so they flow naturally back-to-back.
 *
 * The snapshot is resolved at fire time via the `getSnapshot` closure
 * (issue #481) — NOT pulled from the event payload. The event carries
 * only the trigger `reason`. Reading at fire time keeps the recap fresh
 * when the scenario engine deferred the fire (busy-bus low-priority hold
 * or urgent-flag preempt that stashed the readback for replay) — the
 * snapshot frozen at emit time would be stale by the time the engineer
 * actually speaks.
 *
 * Slot order:
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
 *                         replays the slot content.
 *   2. Fuel             — "taking fuel" / "no fuel".
 *   3. Tires / compound — exactly one of: a tire-pattern clip (15 options),
 *                          a compound-change clip (2), or "no tires".
 *   4. Fast repair      — "fast repair" / "no fast repair", or omitted
 *                          when the series doesn't offer fast repair.
 *   5. Windshield       — "cleaning the windshield" / "no windshield",
 *                          or omitted when not applicable.
 *
 * Empty-snapshot fallback: when fuel + tires + extras all resolve to
 * "omit"/"no", the dedicated empty-fallback clip plays alone instead
 * of stitching a series of negatives. A null snapshot (translator has
 * no telemetry yet) is treated as empty.
 *
 * Family preemption: both scenarios share `family: "pit-readback"` so a
 * refire (mid-lane toggle) replaces the running readback wholesale —
 * distinct from #464's per-toggle stitching, which merges live.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { PitReadbackSnapshot, SimEventOf } from "@iracedeck/event-bus";

import type { Scenario, ScenarioContext, Step } from "../../dsl.js";

type ReadbackEventData = SimEventOf<"pitService.readbackRequested">["data"];

function reasonOf(ctx: ScenarioContext): ReadbackEventData["reason"] {
  return (ctx.data as ReadbackEventData).reason;
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
 * predicates treat null as the empty snapshot, which collapses to the
 * fallback clip rather than fabricating a "no fuel, no tires" recap.
 */
export type ReadbackSnapshotResolver = () => PitReadbackSnapshot | null;

/**
 * 15-way exhaustive tire-pattern lookup. Mirrors the names already used by
 * `toggle-confirmations.ts` so the readback callout matches the per-toggle
 * confirmation's vocabulary one-to-one. Patterns are mutually exclusive,
 * so at most one entry resolves true per snapshot.
 */
const TIRE_PATTERN_CLIPS: ReadonlyArray<{
  match: (t: PitReadbackSnapshot["tires"]) => boolean;
  clip: string;
}> = [
  // 4 corners
  { match: (t) => t.lf && t.rf && t.lr && t.rr, clip: "tires-all.mp3" },
  // Same-axis pairs
  { match: (t) => t.lf && t.rf && !t.lr && !t.rr, clip: "tires-fronts.mp3" },
  { match: (t) => !t.lf && !t.rf && t.lr && t.rr, clip: "tires-rears.mp3" },
  { match: (t) => t.lf && !t.rf && t.lr && !t.rr, clip: "tires-lefts.mp3" },
  { match: (t) => !t.lf && t.rf && !t.lr && t.rr, clip: "tires-rights.mp3" },
  // Diagonals
  { match: (t) => t.lf && !t.rf && !t.lr && t.rr, clip: "tires-lf-rr.mp3" },
  { match: (t) => !t.lf && t.rf && t.lr && !t.rr, clip: "tires-rf-lr.mp3" },
  // 3-corner (skip one)
  { match: (t) => !t.lf && t.rf && t.lr && t.rr, clip: "tires-skip-lf.mp3" },
  { match: (t) => t.lf && !t.rf && t.lr && t.rr, clip: "tires-skip-rf.mp3" },
  { match: (t) => t.lf && t.rf && !t.lr && t.rr, clip: "tires-skip-lr.mp3" },
  { match: (t) => t.lf && t.rf && t.lr && !t.rr, clip: "tires-skip-rr.mp3" },
  // Singles
  { match: (t) => t.lf && !t.rf && !t.lr && !t.rr, clip: "tires-lf.mp3" },
  { match: (t) => !t.lf && t.rf && !t.lr && !t.rr, clip: "tires-rf.mp3" },
  { match: (t) => !t.lf && !t.rf && t.lr && !t.rr, clip: "tires-lr.mp3" },
  { match: (t) => !t.lf && !t.rf && !t.lr && t.rr, clip: "tires-rr.mp3" },
];

// Clip paths are relative to the scenario `base: "voice/{voice}"`. The
// engine applies the base when expanding each clip step, so the prefix
// here is just the group folder under each voice.
const READBACK_BASE = "pit-readback";

function clipPath(filename: string): string {
  return `${READBACK_BASE}/${filename}`;
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
  hasDamage: false,
};

function fuelSlotSteps(getSnap: ReadbackSnapshotResolver): Step[] {
  return [
    {
      if: () => (getSnap() ?? EMPTY_SNAPSHOT).fuel.queued,
      then: [clipPath("fuel-on.mp3")],
      else: [clipPath("fuel-off.mp3")],
    },
  ];
}

/**
 * Build the tire/compound slot. Mutually exclusive cases:
 *   - compound change (dry / wet) — implicitly covers all four tires
 *   - any tire bits set with no compound change — pick from the 15 patterns
 *   - tires explicitly skipped (no bits, no compound) — "no tires"
 */
function tireCompoundSlotSteps(getSnap: ReadbackSnapshotResolver): Step[] {
  return [
    {
      if: () => (getSnap() ?? EMPTY_SNAPSHOT).compoundChange?.to === 0,
      then: [clipPath("compound-dry.mp3")],
    },
    {
      if: () => (getSnap() ?? EMPTY_SNAPSHOT).compoundChange?.to === 1,
      then: [clipPath("compound-wet.mp3")],
    },
    ...TIRE_PATTERN_CLIPS.map<Step>(({ match, clip }) => ({
      if: () => {
        const s = getSnap() ?? EMPTY_SNAPSHOT;

        return s.compoundChange === null && match(s.tires);
      },
      then: [clipPath(clip)],
    })),
    {
      if: () => {
        const s = getSnap() ?? EMPTY_SNAPSHOT;

        return s.compoundChange === null && !hasAnyTire(s.tires);
      },
      then: [clipPath("tires-off.mp3")],
    },
  ];
}

function fastRepairSlotSteps(getSnap: ReadbackSnapshotResolver): Step[] {
  // Issue #489: gate on `hasDamage` (EngineWarnings & Mand|OptRepNeeded).
  //   - clean car          → omit the slot entirely (no callout, regardless of queued)
  //   - damaged + queued   → "we're doing fast repairs"
  //   - damaged + !queued  → "we're not doing fast repair"  (warns the driver)
  // The series-level `available` gate stays so cars without fast-repair
  // service stay silent even when damaged.
  return [
    {
      if: () => {
        const s = getSnap() ?? EMPTY_SNAPSHOT;

        return s.hasDamage && s.fastRepair.available && s.fastRepair.queued;
      },
      then: [clipPath("fast-repair-on.mp3")],
    },
    {
      if: () => {
        const s = getSnap() ?? EMPTY_SNAPSHOT;

        return s.hasDamage && s.fastRepair.available && !s.fastRepair.queued;
      },
      then: [clipPath("fast-repair-off.mp3")],
    },
  ];
}

function windshieldSlotSteps(getSnap: ReadbackSnapshotResolver): Step[] {
  // Only mention windshield when it's queued. Skipping the negative
  // ("no windshield") sidesteps the open-wheel false-positive — formula
  // / indycar / dirt cars don't have a windshield to clean, and iRacing
  // doesn't expose an "is windshield service available" signal in
  // telemetry to gate on.
  return [
    {
      if: () => (getSnap() ?? EMPTY_SNAPSHOT).windshield.queued,
      then: [clipPath("windshield-on.mp3")],
    },
  ];
}

function readbackScenario(reason: "entry" | "exit", getSnap: ReadbackSnapshotResolver): Scenario {
  const isEntry = reason === "entry";

  return {
    id: `pit-crew.pit-readback-${reason}`,
    when: {
      event: "pitService.readbackRequested",
      where: (e) => {
        const r = (e as SimEventOf<"pitService.readbackRequested">).data.reason;

        // The entry scenario fires on both `entry` and `entry-refire`.
        return isEntry ? r === "entry" || r === "entry-refire" : r === "exit";
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    // Defers to higher-priority scenarios (pit-approach, pit-exit chatter,
    // limiter callouts). The deferred-low-fire mechanism replays this once
    // the bus goes idle — same as the unregistered service-reminder.
    priority: "low",
    family: "pit-readback",
    sequence: [
      "@pit-crew.radio-open",
      ...(isEntry
        ? // Entry: limiter pre-opener fires unconditionally (when the
          // limiter isn't engaged on the initial entry) — the warning
          // matters whether or not the driver has any services queued.
          // After that, empty-snapshot collapses to the fallback clip;
          // non-empty plays the regular opener + slots.
          ([
            {
              if: (ctx) => reasonOf(ctx) === "entry" && !(getSnap() ?? EMPTY_SNAPSHOT).limiterEngaged,
              then: [clipPath("opener-entry-limiter.mp3")],
            },
            {
              if: () => !hasAnyService(getSnap() ?? EMPTY_SNAPSHOT),
              then: [clipPath("empty-fallback.mp3")],
              else: [
                // Opener — gated on `reason === "entry"` so refires
                // (`entry-refire`) skip the carrier sentence and replay
                // only the slot content.
                {
                  if: (ctx) => reasonOf(ctx) === "entry",
                  then: [clipPath("opener-entry.mp3")],
                },
                ...fuelSlotSteps(getSnap),
                ...tireCompoundSlotSteps(getSnap),
                // Brief beat after the tire/compound callout so the
                // optional fast-repair / windshield extras don't crowd
                // the longest slot in the recap.
                { pause: 300 },
                ...fastRepairSlotSteps(getSnap),
                ...windshieldSlotSteps(getSnap),
              ],
            },
          ] as Step[])
        : // Exit: opener + body. Empty-snapshot still keeps the opener
          // so the engineer says "To confirm: … not changing tires, not
          // refueling." rather than dropping straight into the fallback.
          ([
            { clip: clipPath("opener-exit.mp3") },
            {
              if: () => !hasAnyService(getSnap() ?? EMPTY_SNAPSHOT),
              then: [clipPath("empty-fallback.mp3")],
              else: [
                ...fuelSlotSteps(getSnap),
                ...tireCompoundSlotSteps(getSnap),
                // Brief beat after the tire/compound callout so the
                // optional fast-repair / windshield extras don't crowd
                // the longest slot in the recap.
                { pause: 300 },
                ...fastRepairSlotSteps(getSnap),
                ...windshieldSlotSteps(getSnap),
              ],
            },
          ] as Step[])),
      "@pit-crew.radio-close",
    ],
  };
}

/**
 * Build both pit-readback scenarios bound to a snapshot resolver. The
 * resolver is invoked at fire time inside every conditional `if` predicate
 * so deferred replays read the *current* queued-services state, not the
 * one captured when the event was emitted (issue #481).
 */
export function buildPitReadbackScenarios(getSnapshot: ReadbackSnapshotResolver): readonly Scenario[] {
  return [readbackScenario("entry", getSnapshot), readbackScenario("exit", getSnapshot)];
}

/**
 * Stable identifier for each user-toggleable pit-readback callout. Two
 * subjects today, one per scenario id; future fanouts (per-stop reason,
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
