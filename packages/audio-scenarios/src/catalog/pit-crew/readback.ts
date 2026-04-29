/**
 * Pit-service readback scenarios — issue #476.
 *
 * Two scenarios driven by `pitService.readbackRequested` (one per `reason`
 * value the sim translator emits):
 *
 *   - `pit-crew.pit-readback-entry`  — fires on `entry` and `entry-refire`.
 *   - `pit-crew.pit-readback-exit`   — fires on `exit`.
 *
 * Both scenarios are pure slot compositions over the event payload (no
 * live telemetry reads from inside the DSL). Each slot picks zero or one
 * clip based on the snapshot; slots that resolve to "omit" contribute
 * nothing. There are no connectors between slots — the slot clips are
 * authored with consistent lead-in / lead-out so they flow naturally
 * back-to-back.
 *
 * Slot order:
 *   1. Opener           — exit: "To confirm:".
 *                         entry: an optional limiter pre-opener
 *                         ("Don't forget your limiter.") fires when
 *                         `limiterEngaged === false`, followed by the
 *                         always-on `opener-entry` ("We're …"). The two
 *                         are separate clips so the regular opener fires
 *                         every entry regardless of limiter state.
 *   2. Fuel             — "taking fuel" / "no fuel".
 *   3. Tires / compound — exactly one of: a tire-pattern clip (15 options),
 *                          a compound-change clip (2), or "no tires".
 *   4. Fast repair      — "fast repair" / "no fast repair", or omitted
 *                          when the series doesn't offer fast repair.
 *   5. Windshield       — "cleaning the windshield" / "no windshield",
 *                          or omitted when not applicable.
 *   6. Closer (exit)    — short tail clip, exit only.
 *
 * Empty-snapshot fallback: when fuel + tires + extras all resolve to
 * "omit"/"no", the dedicated empty-fallback clip plays alone instead
 * of stitching a series of negatives.
 *
 * Family preemption: both scenarios share `family: "pit-readback"` so a
 * refire (mid-lane toggle) replaces the running readback wholesale —
 * distinct from #464's per-toggle stitching, which merges live.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario, ScenarioContext, Step } from "../../dsl.js";

type ReadbackPayload = SimEventOf<"pitService.readbackRequested">["data"];

function payload(ctx: ScenarioContext): ReadbackPayload {
  return ctx.data as ReadbackPayload;
}

function hasAnyTire(p: ReadbackPayload): boolean {
  return p.tires.lf || p.tires.rf || p.tires.lr || p.tires.rr;
}

function hasAnyService(p: ReadbackPayload): boolean {
  return (
    p.fuel.queued ||
    hasAnyTire(p) ||
    p.compoundChange !== null ||
    (p.fastRepair.available && p.fastRepair.queued) ||
    (p.windshield.available && p.windshield.queued)
  );
}

/**
 * 15-way exhaustive tire-pattern lookup. Mirrors the names already used by
 * `toggle-confirmations.ts` so the readback callout matches the per-toggle
 * confirmation's vocabulary one-to-one. Patterns are mutually exclusive,
 * so at most one entry resolves true per snapshot.
 */
const TIRE_PATTERN_CLIPS: ReadonlyArray<{
  match: (t: ReadbackPayload["tires"]) => boolean;
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

function fuelSlotSteps(): Step[] {
  return [
    {
      if: (ctx) => payload(ctx).fuel.queued,
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
function tireCompoundSlotSteps(): Step[] {
  return [
    {
      if: (ctx) => payload(ctx).compoundChange?.to === 0,
      then: [clipPath("compound-dry.mp3")],
    },
    {
      if: (ctx) => payload(ctx).compoundChange?.to === 1,
      then: [clipPath("compound-wet.mp3")],
    },
    ...TIRE_PATTERN_CLIPS.map<Step>(({ match, clip }) => ({
      if: (ctx) => payload(ctx).compoundChange === null && match(payload(ctx).tires),
      then: [clipPath(clip)],
    })),
    {
      if: (ctx) => payload(ctx).compoundChange === null && !hasAnyTire(payload(ctx)),
      then: [clipPath("tires-off.mp3")],
    },
  ];
}

function fastRepairSlotSteps(): Step[] {
  return [
    {
      if: (ctx) => payload(ctx).fastRepair.available && payload(ctx).fastRepair.queued,
      then: [clipPath("fast-repair-on.mp3")],
    },
    {
      if: (ctx) => payload(ctx).fastRepair.available && !payload(ctx).fastRepair.queued,
      then: [clipPath("fast-repair-off.mp3")],
    },
  ];
}

function windshieldSlotSteps(): Step[] {
  return [
    {
      if: (ctx) => payload(ctx).windshield.available && payload(ctx).windshield.queued,
      then: [clipPath("windshield-on.mp3")],
    },
    {
      if: (ctx) => payload(ctx).windshield.available && !payload(ctx).windshield.queued,
      then: [clipPath("windshield-off.mp3")],
    },
  ];
}

function readbackScenario(reason: "entry" | "exit"): Scenario {
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
      // Empty-snapshot fast path. Skips opener entirely so we don't hear
      // "We're … and that's it" — the empty-fallback clip stands alone.
      {
        if: (ctx) => !hasAnyService(payload(ctx)),
        then: [clipPath("empty-fallback.mp3")],
        else: [
          // Opener.
          //   Entry: optional limiter pre-opener fires when the limiter
          //   isn't engaged, then the always-on `opener-entry` follows.
          //   Exit: a single `opener-exit` clip.
          ...(isEntry
            ? ([
                {
                  if: (ctx) => !payload(ctx).limiterEngaged,
                  then: [clipPath("opener-entry-limiter.mp3")],
                },
                { clip: clipPath("opener-entry.mp3") },
              ] as Step[])
            : [{ clip: clipPath("opener-exit.mp3") } as Step]),
          // Slots 2-5 — each fires zero or one clip; the slot clips are
          // authored with consistent lead-in / lead-out so they flow
          // naturally back-to-back without explicit connector glue.
          ...fuelSlotSteps(),
          ...tireCompoundSlotSteps(),
          ...fastRepairSlotSteps(),
          ...windshieldSlotSteps(),
          // Slot 6 — closer (exit only).
          ...(isEntry ? [] : [{ clip: clipPath("closer-exit.mp3") } as Step]),
        ],
      },
      "@pit-crew.radio-close",
    ],
  };
}

export const PIT_READBACK_ENTRY: Scenario = readbackScenario("entry");
export const PIT_READBACK_EXIT: Scenario = readbackScenario("exit");

export const PIT_READBACK_SCENARIOS: readonly Scenario[] = [PIT_READBACK_ENTRY, PIT_READBACK_EXIT];

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
