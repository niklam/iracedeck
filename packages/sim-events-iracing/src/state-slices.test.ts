import { describe, expect, it } from "vitest";

import { FROZEN_FLAT_MEMBERS, FROZEN_WHOLE_STATE_DIFF_MODULES } from "./state-slices.baseline.test-support.js";
import {
  checkFlatPinFrozen,
  checkStateImporters,
  type FlatMemberPin,
  readSliceSources,
  scanStateSlices,
  type SliceReadAllowList,
  type SliceScan,
  type SliceSources,
  type SliceViolation,
} from "./state-slices.test-support.js";

/**
 * `TranslatorState` arrives in slices (#1588): every new cluster of translator
 * state is one member `<family>: <Family>State`, and a diff takes its slice
 * rather than the whole state. This guards the convention over `state.ts` and
 * `diff/` with the four rules of the #1588 spec, decision 3, and a fifth that
 * refuses a new diff module on the whole state (#1661); the scanner's header in
 * `state-slices.test-support.ts` says what each rule matches.
 */

/**
 * The clusters of `TranslatorState` that are still flat, by the
 * `// ── <heading> ──` comment they sit under in `state.ts`, and the one list
 * of them (`CLAUDE.md` points here). It only shrinks: a name is never added,
 * and moving a cluster into a slice deletes its entry in the same change.
 * Rule B checks both halves: every pinned name is a member under its heading,
 * and every pinned name is in `FROZEN_FLAT_MEMBERS`
 * (`state-slices.baseline.test-support.ts`), whose lines are only ever
 * deleted, so a name added fails by name whatever else the change removes,
 * and a name removed fails until its line is deleted there. The comment on an
 * entry is what its move must settle first; an entry without one
 * has not been assessed yet, so its move starts by reading how the replay wipe
 * (`wipeStateForReplay`) treats its fields and which other diffs read them.
 *
 * Not here: "Track-order gaps outside a race (issue #1515)" (`trackGaps`),
 * "Pit-lane landmarks (issue #1112)" (`pitLaneLandmarks`),
 * "Car progress (issue #1572)" (`carProgress`),
 * "Replay progress (issue #1682)" (`replayProgress`),
 * "Sector times (issue #1572)" (`sectorTimes`),
 * "Approaching traffic (issue #1113)" (`trafficArrival`),
 * "Fastest lap of the race (issue #1571)" (`fastestLap`),
 * "Laps-of-fuel-left callouts (issue #838)" (`fuelCallout`) and "Track
 * sectors (issue #1573)" (`trackSectors`, `sectorStart`), whose only members are slices, the
 * `lapCrossing` slice under "Lap completion", and the `cornerName` slice under
 * "Corner-name callouts (issue #888)".
 */
const LEGACY_FLAT_MEMBERS: FlatMemberPin = {
  "Pit lane / stall": [
    "pitLaneInitialized",
    "lastOnPitRoad",
    "lastInPitStall",
    "lastTrackSurface",
    "approachExitingSuppressed",
    "approachAlertFired",
    "pitApproachCooldownUntil",
    "pitBoxMarksSpoken",
    "pitBoxEntrySeeded",
  ],
  // `lapStartedFromPits` sits under this heading by source order, but
  // `diff/pit-lane.ts` and `diff/lifecycle.ts` write it: it moves with the
  // pit-lane cluster, not with the corner names.
  "Corner-name callouts (issue #888)": ["lapStartedFromPits"],
  // `playerFinalLapStarted` reaches `diff/fuel-laps-left.ts` as a value, and
  // the green re-arm of the fuel reassurance goes through the closure
  // `createFuelReassuranceRearm` builds over the `fuelCallout` slice (#1405).
  Flags: [
    "flagStateInitialized",
    "activeFlags",
    "lastYellowScope",
    "lastAnyYellow",
    "yellowClearPendingSince",
    "yellowEpisodeFullCourse",
    "furledPendingAt",
    "furledAnnounced",
    "flagLastLapCompleted",
    "flagLastCrossedAt",
    "checkeredPendingCross",
    "whiteLastLapFired",
    "playerFinalLapStarted",
    "whiteRaisedAt",
  ],
  // With the catch-up below: the largest partial keep of the replay wipe;
  // `cautionPhase` is read by `diff/flags.ts`, `diff/laps.ts` and
  // `diff/start-lights.ts`, and must become a value for each.
  "Full-course caution (issue #1127)": [
    "cautionInitialized",
    "cautionPaceCarSurface",
    "cautionPhase",
    "cautionRestartedAt",
    "cautionLastFlags",
    "cautionLeaderLapCompleted",
    "cautionFollowCarIdx",
    "cautionLastLapDistPct",
    "cautionCheckpointArmed",
    "cautionEpisodeId",
    "cautionFirstFollowCarIdx",
  ],
  // Moves with the caution above: the same partial keep in the replay wipe.
  "Caution catch-up (issue #1168)": [
    "cautionProcedureJoined",
    "cautionProcedureAwaySeen",
    "cautionProcedureInPlaceCarIdx",
    "cautionProcedureInPlaceSince",
    "cautionProcedureInPlaceSeenAt",
    "cautionCaughtAt",
    "cautionCatchUpLastOnPitRoad",
    "cautionCatchUpPitRoadSince",
    "cautionCatchUpPitExitAt",
    "cautionCatchUpPitExitCalled",
    "cautionCatchUpFollowCarIdx",
    "cautionCatchUpRaisedSince",
    "cautionCatchUpRaisedSeenAt",
    "cautionCatchUpSuspendedSince",
    "cautionCatchUpSuspendedSeenAt",
    "cautionCatchUpCandidateCarIdx",
    "cautionCatchUpCandidateRaisedSince",
    "cautionCatchUpCandidateSeenAt",
    "cautionCatchUpOpen",
    "cautionCatchUpLastCallAt",
    "cautionCatchUpLastCallGapMeters",
    "cautionCatchUpReminders",
  ],
  "Rolling-start pace laps (issue #657)": [
    "paceLapInitialized",
    "lastTickInParadeLaps",
    "paceLapArmed",
    "paceLapAccrued",
    "paceLapLastDistPct",
    "paceLapSourceCarIdx",
    "paceLapPaceCarIdx",
    "onePaceLapToGoFired",
  ],
  "Rolling-start field-rolling detection (issue #660)": ["rollingStartInitialized", "lastInParadeLaps"],
  "Rolling-start formation (issue #1167)": [
    "rollingStartFormationId",
    "rollingStartFirstFollowCarIdx",
    "rollingStartFollowCarIdx",
  ],
  "Pit window open/closed (issue #655)": ["pitsOpenInitialized", "lastPitsOpen"],
  "Start lights (issue #480)": [
    "startLightInitialized",
    "lastStartLightBits",
    "startCountdownCeiling",
    "startCountdownFired",
    "startCountdownObserved",
  ],
  "Toggles (pit service, car control)": [
    "toggleStateInitialized",
    "lastPitSvFlags",
    "lastPitSvCompound",
    "lastP2PActive",
    "lastDrsActive",
    "fuelDebounce",
    "windshieldDebounce",
    "fastRepairDebounce",
    "autoFuelBaseline",
    "autoFuelDebounce",
    "autoFuelSwitchHeld",
    "lastSeenTireFlags",
    "lastTireChangeAt",
  ],
  "Pit-service readback (issue #476)": [
    "pitReadbackInitialized",
    "pitReadbackPrevOnPitRoad",
    "pitReadbackExitFireAt",
    "pitActionCooldownUntil",
    "pitReadbackPreStartFireAt",
    "lastTickInPreStart",
  ],
  "How the car reached its stall (issues #1108, #254)": ["stallVisitDroveOnCircuit", "stallVisitDriveIn"],
  "Tire wear of a stop (issue #1108)": ["tireWearReport"],
  // `lastStopTireTemps` survives a session change (`resetPerSessionState`'s
  // `preservedAcrossSessions`), so the slice must be listed there too.
  "Tire temperatures of the last stop (issue #254)": ["lastStopTireTemps", "tireTempsOnCircuit"],
  "Track wetness (issue #526)": ["trackWetnessInitialized", "lastTrackWetness"],
  "Pit-service status (issue #479)": [
    "pitStatusInitialized",
    "lastPitSvStatus",
    "pitStatusRepeatDueAt",
    "pitStatusRestSince",
    "lastPitstopActive",
    "pitstopActiveSince",
  ],
  "Pit limiter warnings": [
    "limiterInitialized",
    "lastOnPitRoadForLimiter",
    "lastLimiterOnPitRoad",
    "speedingWarnedAt",
    "pitSpeedingActive",
    "pitSpeedingUnderLimitSince",
  ],
  "Incidents / off-track": [
    "lastIncidentCount",
    "offTrackStartedAt",
    "offTrackWarnedThisExcursion",
    "materialHistory",
    "offTrackPending",
    "incidentTypeHistory",
    "incidentChainTotal",
    "incidentChainLatestAt",
    "incidentBurstType",
    "incidentBurstDelta",
    "incidentBurstFirstAt",
    "incidentBurstLatestAt",
  ],
  "Damage (issue #489)": [
    "damageInitialized",
    "damageBaseline",
    "damagePendingAt",
    "damagePendingValue",
    "damageHeldAt",
    "damageHeldSawBurst",
  ],
  Overtakes: [
    "overtakeInitialized",
    "lastPosition",
    "pendingOvertakePos",
    "pendingOvertakeTime",
    "lastConfirmedOvertakeCarIdx",
    "pendingOvertakeFromRetirement",
    "lastCalledPosition",
    "pendingOvertakePrevPos",
    "pendingOvertakePrevClassPos",
    "lastClassPosition",
    "pendingLossPos",
    "pendingLossTime",
    "pendingLossPrevPos",
    "pendingLossPrevClassPos",
    "trackLengthMeters",
    "trackLengthKey",
  ],
  // Partial replay keep (`gapRestartMark`). The traces are no longer here:
  // they are the `carProgress` slice (#1572), which the translator's pair
  // reading for `diffOpponentFlags` reads. About 22 signature lines in
  // `diff/gaps.ts` take the whole state.
  "Gaps (issue #933)": [
    "gapAheadIdx",
    "gapBehindIdx",
    "gapLiveAhead",
    "gapLiveBehind",
    "gapLastCheckpointAhead",
    "gapLastCheckpointBehind",
    "gapRateEmaAhead",
    "gapRateEmaBehind",
    "gapRateSamplesAhead",
    "gapRateSamplesBehind",
    "gapLapHistoryAhead",
    "gapLapHistoryBehind",
    "gapLapRateWindowAhead",
    "gapLapRateWindowBehind",
    "gapEtaReadingAhead",
    "gapEtaReadingBehind",
    "gapLastCheckpointProgress",
    "gapRestartMark",
    "gapContactAnnouncedLapsAhead",
    "gapContactAnnouncedLapsBehind",
    "gapBreakawayAnnouncedAhead",
    "gapBreakawayAnnouncedBehind",
    "gapMinSinceAnnounceAhead",
    "gapMinSinceAnnounceBehind",
    "gapMaxSinceAnnounceAhead",
    "gapMaxSinceAnnounceBehind",
    "gapLastEvalGapAhead",
    "gapLastEvalGapBehind",
    "gapStableTicksAhead",
    "gapStableTicksBehind",
    "gapThresholdArmedAhead",
    "gapThresholdArmedBehind",
  ],
  "Self-managed running order (issue #603)": [
    "positionLastKnownScores",
    "positionFrozen",
    "lastFrozenPositions",
    "positionPrevScore",
    "positionJustReleased",
  ],
  // Partial replay keep; #1559 has just restructured the diff into per-car
  // units, so a move now would only collide with it.
  "Opponent pit entries (issue #622)": [
    "opponentPitInitialized",
    "opponentPitLastSurface",
    "opponentPitCarCooldownUntil",
    "opponentPitRecentEntries",
    "opponentPitAggregateAnnounced",
  ],
  // Partial replay keep; #1559 has just restructured the diff into per-car
  // units, so a move now would only collide with it.
  "Opponent penalty flags (issue #936)": [
    "opponentFlagsInitialized",
    "opponentFlagSeededAt",
    "opponentFlagBits",
    "opponentFlagHeldSinceAt",
    "opponentFlagAnnouncedMask",
    "opponentFlagHeldBackLoggedMask",
    "opponentFlagCooldownUntil",
    "opponentFlagEffectiveMask",
    "opponentFlagRecentEntries",
    "opponentFlagAggregateAnnounced",
  ],
  // Partial replay keep (`leaderWhiteFired`, `leaderWhitePostExpiryCrossed`).
  // Self-contained otherwise; the smallest next one.
  "Leader's white flag (issue #936)": [
    "leaderWhiteLastLeaderIdx",
    "leaderWhiteLastLeaderLap",
    "leaderWhiteLastLapsRemainEx",
    "leaderWhiteLastClockExpired",
    "leaderWhiteFired",
    "leaderWhitePostExpiryCrossed",
  ],
  Radar: ["radarState"],
  Lifecycle: ["lifecycleInitialized", "lastSessionNum", "lastEngineRunning", "lastLap"],
  // The `lapCrossing` slice nests inside the laps slice; `flagCheckeredTakenLap`
  // (written by the flags) becomes a value.
  "Lap completion (issue #555)": [
    "lapCompletedInitialized",
    "lastLapCompletedCounter",
    "lastLapBestLapTime",
    "lastLapSessionNum",
    "lastEmittedLapTime",
    "lapLatchLap",
    "lapPitLatch",
    "lapCompletedPit",
    "lapCautionSeen",
    "lapCompletedWasCaution",
    "lastLapPosition",
    "lastLapClassPosition",
    "lapResultsPendingSince",
    "lastPositionChangeLap",
    "raceFinishedFired",
    "raceFinish",
    "flagCheckeredTakenLap",
  ],
};

/**
 * The `diff/` modules that import `TranslatorState` (rule E), relative to
 * `diff/`: the ones that took the whole state when the list was frozen
 * (#1661, 2026-11-23). It only shrinks: a new diff module takes its slice as
 * its first parameter and gets another family's fact as a value, so it never
 * joins this list. Every name here must be in `FROZEN_WHOLE_STATE_DIFF_MODULES`
 * (`state-slices.baseline.test-support.ts`), whose lines are only ever deleted;
 * a module that moves onto its slice leaves both in the same change.
 */
const WHOLE_STATE_DIFF_MODULES: readonly string[] = [
  "caution.ts",
  "damage.ts",
  "flags.ts",
  "gaps.ts",
  "incidents.ts",
  "laps.ts",
  "leader-white.ts",
  "lifecycle.ts",
  "limiter.ts",
  "opponent-flags.ts",
  "opponent-pit.ts",
  "overtakes.ts",
  "pace-laps.ts",
  "pit-box-countdown.ts",
  "pit-lane.ts",
  "pit-readback.ts",
  "pit-speeding.ts",
  "pit-status.ts",
  "pits-open.ts",
  "race-finish.ts",
  "radar.ts",
  "rolling-start.ts",
  "stall-visit.ts",
  "start-lights.ts",
  "tire-temps.ts",
  "tire-wear.ts",
  "toggles.ts",
  "track-wetness.ts",
];

/** Rule C's exceptions: `<module under diff/>:<slice key>` → why that module still reads the slice through `TranslatorState`. */
const SLICE_READS_ALLOWED: SliceReadAllowList = {
  "laps.ts:lapCrossing":
    "The laps cluster is still flat, so `diffLaps` takes the whole state; the crossing nests into the laps slice when that cluster moves (#1588 spec, decision 3, rule C).",
};

/** The slices the tree has, by key. */
const SLICE_KEYS = [
  "trackGaps",
  "pitLaneLandmarks",
  "trafficArrival",
  "trafficRejoin",
  "trafficPitExit",
  "fastestLap",
  "fuelCallout",
  "lapCrossing",
  "trackSectors",
  "cornerName",
  "sectorStart",
  "limiterToggle",
  "carProgress",
  "replayProgress",
  "sectorTimes",
];

const violationNames = (scan: SliceScan): string[] => scan.violations.map((v) => `${v.rule}:${v.name}`);
const violationKeys = (violations: readonly SliceViolation[]): string[] =>
  violations.map((v) => (v.module === undefined ? `${v.rule}:${v.name}` : `${v.rule}:${v.module}:${v.name}`));

/** Every finding over a real-tree scan: the scan's own, and the pins' against their frozen baselines (rules B and E). */
const realFindings = (
  scan: SliceScan,
  pin: FlatMemberPin = LEGACY_FLAT_MEMBERS,
  importers: readonly string[] = WHOLE_STATE_DIFF_MODULES,
  frozenFlat: readonly string[] = FROZEN_FLAT_MEMBERS,
  frozenImporters: readonly string[] = FROZEN_WHOLE_STATE_DIFF_MODULES,
): SliceViolation[] => [
  ...scan.violations,
  ...checkFlatPinFrozen(pin, frozenFlat),
  ...checkStateImporters(scan, importers, frozenImporters),
];

/** The findings `planted` has that `baseline` does not, so a real-tree control fails only for what it plants. */
const added = (baseline: readonly SliceViolation[], planted: readonly SliceViolation[]): string[] => {
  const before = new Set(violationKeys(baseline));

  return violationKeys(planted).filter((key) => !before.has(key));
};

describe("TranslatorState keeps to the slice convention (#1588)", () => {
  const sources = readSliceSources(import.meta.dirname);
  const scan = scanStateSlices(sources, LEGACY_FLAT_MEMBERS, SLICE_READS_ALLOWED);
  const findings = realFindings(scan);

  it("scans the whole state and every diff module, not an empty or narrowed read", () => {
    // Measured when the importer list was frozen (#1661), 2026-11-23: 244
    // members (229 pinned flat, 15 slices), 59 diff modules, 28 of them
    // importing TranslatorState. The importers are pinned exactly (rule E), so
    // an empty or narrowed read reports every pinned module as stale.
    expect(scan.members.length).toBeGreaterThan(200);
    expect(scan.diffModules.length).toBeGreaterThanOrEqual(40);
    expect(scan.diffModules).toContain("laps.ts");
    expect(scan.stateImporters).toEqual([...WHOLE_STATE_DIFF_MODULES].sort());
  });

  it("holds both pins to their frozen baselines", () => {
    expect([...new Set(Object.values(LEGACY_FLAT_MEMBERS).flat())].sort()).toEqual(FROZEN_FLAT_MEMBERS);
    expect([...WHOLE_STATE_DIFF_MODULES].sort()).toEqual(FROZEN_WHOLE_STATE_DIFF_MODULES);
  });

  it("finds every slice the tree has as a slice", () => {
    expect(scan.slices.map((slice) => slice.key)).toEqual(expect.arrayContaining(SLICE_KEYS));
    expect(scan.slices.map((slice) => slice.key).sort()).toEqual([...SLICE_KEYS].sort());
  });

  it("matches every allow-list entry against a read it exempts", () => {
    for (const key of Object.keys(SLICE_READS_ALLOWED)) {
      expect(
        scan.sliceReads.some((read) => read.allowed && `${read.module}:${read.key}` === key),
        `${key} matches no read`,
      ).toBe(true);
    }
  });

  it("breaks no rule", () => {
    expect(findings.map((violation) => violation.message)).toEqual([]);
  });

  /** The real sources with `state.ts` edited by `edit`, which must change it. */
  const withState = (edit: (state: string) => string): SliceSources => {
    const state = edit(sources.state);

    expect(state).not.toEqual(sources.state);

    return { ...sources, state };
  };

  /** The real pin with `Radar` replaced by `names` (deleted when `null`). */
  const withRadarPinned = (names: readonly string[] | null): FlatMemberPin => {
    expect(LEGACY_FLAT_MEMBERS.Radar).toEqual(["radarState"]);

    const { Radar: _radar, ...rest } = LEGACY_FLAT_MEMBERS;

    return names === null ? rest : { ...rest, Radar: names };
  };

  it("reports a flat member added to the real state.ts", () => {
    const anchor = "  // ── Radar ";

    expect(sources.state).toContain(anchor);

    const planted = sources.state.replace(anchor, `  plantedFlatMember: number;\n\n${anchor}`);
    const result = scanStateSlices({ ...sources, state: planted }, LEGACY_FLAT_MEMBERS, SLICE_READS_ALLOWED);

    expect(added(findings, realFindings(result))).toEqual(["A:plantedFlatMember"]);
  });

  it("reports a flat member added to the real state.ts and pinned, by name, printing nothing to copy", () => {
    const sourcesWith = withState((state) =>
      state.replace("  radarState: RadarState;", "  radarState: RadarState;\n  plantedFlatMember: number;"),
    );
    const pin = withRadarPinned(["radarState", "plantedFlatMember"]);
    const result = realFindings(scanStateSlices(sourcesWith, pin, SLICE_READS_ALLOWED), pin);

    expect(added(findings, result)).toEqual(["B:plantedFlatMember"]);

    const message = result.find((v) => v.name === "plantedFlatMember")?.message ?? "";

    expect(message).toContain('LEGACY_FLAT_MEMBERS["Radar"] names `plantedFlatMember`, which FROZEN_FLAT_MEMBERS');
    expect(message).toContain('"Translator state slices (#1588)"');
    expect(message).not.toMatch(/count:|sha256/);
  });

  it("reports a real flat member renamed in state.ts and the pin: the new name, and the old name's line", () => {
    const sourcesWith = withState((state) =>
      state.replace("  radarState: RadarState;", "  plantedRadarState: RadarState;"),
    );
    const pin = withRadarPinned(["plantedRadarState"]);
    const result = realFindings(scanStateSlices(sourcesWith, pin, SLICE_READS_ALLOWED), pin);

    expect(added(findings, result)).toEqual(["B:plantedRadarState", "B:radarState"]);
  });

  it("reports the name added by a real change that moves a two-name cluster out and pins one new name", () => {
    expect(LEGACY_FLAT_MEMBERS["Pit window open/closed (issue #655)"]).toEqual(["pitsOpenInitialized", "lastPitsOpen"]);

    const sourcesWith = withState((state) =>
      state
        .replace("  pitsOpenInitialized: boolean;\n", "")
        .replace("  lastPitsOpen: boolean;\n", "")
        .replace("  radarState: RadarState;", "  radarState: RadarState;\n  plantedFlatMember: number;"),
    );
    const { "Pit window open/closed (issue #655)": _moved, ...pin } = withRadarPinned([
      "radarState",
      "plantedFlatMember",
    ]);
    const scanned = scanStateSlices(sourcesWith, pin, SLICE_READS_ALLOWED);

    expect(added(findings, realFindings(scanned, pin))).toEqual([
      "B:plantedFlatMember",
      "B:lastPitsOpen",
      "B:pitsOpenInitialized",
    ]);

    const baselineDeleted = FROZEN_FLAT_MEMBERS.filter(
      (name) => name !== "pitsOpenInitialized" && name !== "lastPitsOpen",
    );

    expect(added(findings, realFindings(scanned, pin, WHOLE_STATE_DIFF_MODULES, baselineDeleted))).toEqual([
      "B:plantedFlatMember",
    ]);
  });

  it("reports the real pin shrunk with the baseline line kept, naming the line, and passes once it is deleted", () => {
    const sourcesWith = withState((state) => state.replace("  radarState: RadarState;\n", ""));
    const pin = withRadarPinned(null);
    const scanned = scanStateSlices(sourcesWith, pin, SLICE_READS_ALLOWED);
    const result = realFindings(scanned, pin);

    expect(added(findings, result)).toEqual(["B:radarState"]);
    expect(result.find((v) => v.name === "radarState")?.message).toContain(
      'delete the line `"radarState",` from FROZEN_FLAT_MEMBERS',
    );

    const baselineDeleted = FROZEN_FLAT_MEMBERS.filter((name) => name !== "radarState");

    expect(added(findings, realFindings(scanned, pin, WHOLE_STATE_DIFF_MODULES, baselineDeleted))).toEqual([]);
  });

  it("reports a new diff module typed on the whole state planted into the real diff/", () => {
    const diff = new Map(sources.diff);

    diff.set(
      "planted-family.ts",
      `import type { TranslatorState } from "../state.js";\nexport function diffPlanted(state: TranslatorState): boolean {\n  return state.pitLaneInitialized;\n}\n`,
    );
    diff.set(
      "nested/planted-heritage.ts",
      `import type * as S from "../../state.js";\ninterface Ctx extends S.TranslatorState {\n  now: number;\n}\nexport function diffPlanted(ctx: Ctx): number {\n  return ctx.now;\n}\n`,
    );
    // Through a relay outside diff/ (`src/planted-types.ts` re-exporting the
    // state), which the scan never reads: the diff module alone is reported.
    diff.set(
      "planted-relayed.ts",
      `import type { TranslatorState } from "../planted-types.js";\nexport function diffPlanted(state: TranslatorState): unknown {\n  return state.fastestLap;\n}\n`,
    );

    const result = realFindings(scanStateSlices({ ...sources, diff }, LEGACY_FLAT_MEMBERS, SLICE_READS_ALLOWED));

    expect(added(findings, result)).toEqual([
      "C:planted-relayed.ts:fastestLap",
      "E:nested/planted-heritage.ts:nested/planted-heritage.ts",
      "E:planted-family.ts:planted-family.ts",
      "E:planted-relayed.ts:planted-relayed.ts",
    ]);
    expect(result.find((v) => v.name === "planted-family.ts")?.message).toContain(
      "a new diff module takes its slice as its first parameter",
    );
  });

  it("reports a real pinned importer that no longer imports the state, and passes once its entry and line are gone", () => {
    expect(sources.diff.get("radar.ts")).toContain('import type { TranslatorState } from "../state.js";');

    const diff = new Map(sources.diff);

    diff.set("radar.ts", "export const planted = 1;\n");

    const result = scanStateSlices({ ...sources, diff }, LEGACY_FLAT_MEMBERS, SLICE_READS_ALLOWED);
    const remaining = WHOLE_STATE_DIFF_MODULES.filter((module) => module !== "radar.ts");
    const baselineDeleted = FROZEN_WHOLE_STATE_DIFF_MODULES.filter((module) => module !== "radar.ts");

    expect(added(findings, realFindings(result))).toEqual(["E:radar.ts:radar.ts"]);
    expect(realFindings(result).find((v) => v.name === "radar.ts")?.message).toContain(
      'no longer imports TranslatorState: delete the entry, and the line `"radar.ts",` from FROZEN_WHOLE_STATE_DIFF_MODULES',
    );
    expect(added(findings, realFindings(result, LEGACY_FLAT_MEMBERS, remaining))).toEqual(["E:radar.ts:radar.ts"]);
    expect(
      added(findings, realFindings(result, LEGACY_FLAT_MEMBERS, remaining, FROZEN_FLAT_MEMBERS, baselineDeleted)),
    ).toEqual([]);
  });

  it("reports a real diff module that reads a slice through the whole state", () => {
    const flags = sources.diff.get("flags.ts") ?? "";

    expect(flags).toMatch(/import type \{[^}]*\bTranslatorState\b[^}]*\} from "\.\.\/state\.js";/);

    const diff = new Map(sources.diff);

    diff.set(
      "flags.ts",
      `${flags}\nexport function planted(state: TranslatorState): unknown {\n  return state.fastestLap;\n}\n`,
    );

    const result = scanStateSlices({ ...sources, diff }, LEGACY_FLAT_MEMBERS, SLICE_READS_ALLOWED);

    expect(added(findings, realFindings(result))).toEqual(["C:flags.ts:fastestLap"]);
  });
});

// ── Positive controls over planted sources ──────────────────────────────

/** A planted `state.ts`: two slices and one flat section, plus any extra member and alias. */
function plantedState({
  members = "",
  initial = "",
  types = "",
}: { members?: string; initial?: string; types?: string } = {}): string {
  return `
export type TrackGapsState = { ahead: number[] };
export function createTrackGapsState(): TrackGapsState { return { ahead: [] }; }
export type FastestLapState = { record: number | null };
export function createFastestLapState(): FastestLapState { return { record: null }; }
${types}
export type TranslatorState = {
  // ── Pit lane / stall ──────────────────────────────────────────
  /** A doc comment between the heading and the member. */
  pitLaneInitialized: boolean;
  lastOnPitRoad: boolean;

  // ── Track-order gaps (issue #1515) ────────────────────────────
  trackGaps: TrackGapsState;

  // ── Fastest lap of the race (issue #1571) ─────────────────────
  fastestLap: FastestLapState;
${members}
};

export function createInitialState(): TranslatorState {
  return {
    pitLaneInitialized: false,
    lastOnPitRoad: false,
    trackGaps: createTrackGapsState(),
    fastestLap: createFastestLapState(),
${initial}
  };
}
`;
}

const PLANTED_PIN: FlatMemberPin = { "Pit lane / stall": ["pitLaneInitialized", "lastOnPitRoad"] };

function planted(
  state: string,
  diff: Record<string, string> = {},
  pin: FlatMemberPin = PLANTED_PIN,
  allowed: SliceReadAllowList = {},
): SliceScan {
  const sources: SliceSources = { state, diff: new Map(Object.entries(diff)) };

  return scanStateSlices(sources, pin, allowed);
}

const IMPORT = `import type { TranslatorState } from "../state.js";\n`;

describe("the state-slice scanner (positive controls)", () => {
  it("passes the planted baseline, with both slices found", () => {
    const scan = planted(plantedState());

    expect(scan.violations).toEqual([]);
    expect(scan.slices).toEqual([
      { key: "trackGaps", type: "TrackGapsState" },
      { key: "fastestLap", type: "FastestLapState" },
    ]);
    expect(scan.members.map((member) => [member.name, member.section])).toEqual([
      ["pitLaneInitialized", "Pit lane / stall"],
      ["lastOnPitRoad", "Pit lane / stall"],
      ["trackGaps", "Track-order gaps (issue #1515)"],
      ["fastestLap", "Fastest lap of the race (issue #1571)"],
    ]);
  });

  describe("rule A", () => {
    it("reports an unpinned flat member", () => {
      const scan = planted(
        plantedState({ members: "  fastestLapClaim: number | null;", initial: "    fastestLapClaim: null," }),
      );

      expect(violationNames(scan)).toEqual(["A:fastestLapClaim"]);
      expect(scan.violations[0].message).toContain("Never add a name to the pin");
    });

    it("reports a *State member initialised from a literal", () => {
      const scan = planted(
        plantedState({
          types:
            "export type LeaderWhiteState = { fired: boolean };\nexport function createLeaderWhiteState(): LeaderWhiteState { return { fired: false }; }",
          members: "  leaderWhite: LeaderWhiteState;",
          initial: "    leaderWhite: { fired: false },",
        }),
      );

      expect(violationNames(scan)).toEqual(["A:leaderWhite"]);
      expect(scan.violations[0].message).toContain("`leaderWhite: createLeaderWhiteState()`");
    });

    it("reports a factory called with arguments", () => {
      const scan = planted(
        plantedState({
          types:
            "export type LeaderWhiteState = { fired: boolean };\nexport function createLeaderWhiteState(fired: boolean): LeaderWhiteState { return { fired }; }",
          members: "  leaderWhite: LeaderWhiteState;",
          initial: "    leaderWhite: createLeaderWhiteState(false),",
        }),
      );

      expect(violationNames(scan)).toEqual(["A:leaderWhite"]);
    });

    it("reports a slice type with a ?: property", () => {
      const scan = planted(
        plantedState({
          types:
            "export type LeaderWhiteState = { fired: boolean; lap?: number };\nexport function createLeaderWhiteState(): LeaderWhiteState { return { fired: false }; }",
          members: "  leaderWhite: LeaderWhiteState;",
          initial: "    leaderWhite: createLeaderWhiteState(),",
        }),
      );

      expect(violationNames(scan)).toEqual(["A:LeaderWhiteState.lap"]);
    });

    it("reports a slice with no factory in state.ts", () => {
      const scan = planted(
        plantedState({
          types: "export type LeaderWhiteState = { fired: boolean };",
          members: "  leaderWhite: LeaderWhiteState;",
          initial: "    leaderWhite: createLeaderWhiteState(),",
        }),
      );

      expect(violationNames(scan)).toEqual(["A:leaderWhite"]);
      expect(scan.violations[0].message).toContain("has no factory");
    });

    it("reports a member typed with a *State interface rather than an object type alias", () => {
      const scan = planted(
        plantedState({
          types:
            "export interface LeaderWhiteState { fired: boolean }\nexport function createLeaderWhiteState(): LeaderWhiteState { return { fired: false }; }",
          members: "  leaderWhite: LeaderWhiteState;",
          initial: "    leaderWhite: createLeaderWhiteState(),",
        }),
      );

      expect(violationNames(scan)).toEqual(["A:leaderWhite"]);
    });

    it("reports a member before any heading", () => {
      const state = plantedState().replace(
        "export type TranslatorState = {",
        "export type TranslatorState = {\n  early: boolean;",
      );
      const pin = { "Pit lane / stall": ["pitLaneInitialized", "lastOnPitRoad", "early"] };

      expect(violationNames(planted(state, {}, pin))).toEqual(["heading:early"]);
    });
  });

  describe("rule B", () => {
    it("reports a pinned name missing from the source, naming the entry to delete", () => {
      const pin = { "Pit lane / stall": ["pitLaneInitialized", "lastOnPitRoad", "pitBoxEntrySeeded"] };
      const scan = planted(plantedState(), {}, pin);

      expect(violationNames(scan)).toEqual(["B:pitBoxEntrySeeded"]);
      expect(scan.violations[0].message).toContain('LEGACY_FLAT_MEMBERS["Pit lane / stall"] pins `pitBoxEntrySeeded`');
      expect(scan.violations[0].message).toContain("delete it");
    });

    it("reports a pinned name under the wrong heading, naming both", () => {
      const state = plantedState({
        members: "\n  // ── Radar ──────\n  radarState: number;",
        initial: "    radarState: 0,",
      });
      const pin = { "Pit lane / stall": ["pitLaneInitialized", "lastOnPitRoad", "radarState"] };
      const scan = planted(state, {}, pin);

      expect(violationNames(scan)).toEqual(["B:radarState"]);
      expect(scan.violations[0].message).toContain('pinned under "Pit lane / stall"');
      expect(scan.violations[0].message).toContain('sits under "Radar"');
    });

    it("reports a pin entry whose heading the state no longer has, and an empty one", () => {
      const pin = { ...PLANTED_PIN, "Leader's white flag (issue #936)": [] };

      expect(violationNames(planted(plantedState(), {}, pin))).toEqual([
        "B:Leader's white flag (issue #936)",
        "B:Leader's white flag (issue #936)",
      ]);
    });

    it("reports a name pinned twice", () => {
      const state = plantedState({
        members: "\n  // ── Radar ──────\n  radarState: number;",
        initial: "    radarState: 0,",
      });
      const pin = { ...PLANTED_PIN, Radar: ["radarState", "lastOnPitRoad"] };

      expect(violationNames(planted(state, {}, pin))).toEqual(["B:lastOnPitRoad"]);
    });
  });

  describe("rule C", () => {
    it("reports a module importing TranslatorState that reads state.fastestLap", () => {
      const scan = planted(plantedState(), {
        "fastest-lap.ts": `${IMPORT}export function diff(state: TranslatorState): unknown {\n  return state.fastestLap.record;\n}\n`,
      });

      expect(scan.violations.map((v) => `${v.rule}:${v.module}:${v.line}:${v.name}`)).toEqual([
        "C:fastest-lap.ts:3:fastestLap",
      ]);
      expect(scan.stateImporters).toEqual(["fastest-lap.ts"]);
    });

    it("reports a module that destructures the slice from the state", () => {
      const scan = planted(plantedState(), {
        "fastest-lap.ts": `${IMPORT}export function diff(state: TranslatorState): unknown {\n  const { fastestLap } = state;\n  return fastestLap;\n}\n`,
      });

      expect(violationNames(scan)).toEqual(["C:fastestLap"]);
    });

    it("reports the inline `type` import form, an element access and a destructured parameter", () => {
      const scan = planted(plantedState(), {
        "a.ts": `import { type TranslatorState } from "../state.js";\nexport function a(state: Readonly<TranslatorState>): unknown {\n  return state["trackGaps"];\n}\n`,
        "b.ts": `${IMPORT}export function b({ fastestLap }: TranslatorState): unknown {\n  return fastestLap;\n}\n`,
      });

      expect(scan.violations.map((v) => `${v.rule}:${v.module}:${v.name}`)).toEqual([
        "C:a.ts:trackGaps",
        "C:b.ts:fastestLap",
      ]);
      expect(scan.stateImporters).toEqual(["a.ts", "b.ts"]);
    });

    it("reports a module importing TranslatorState that names a slice type", () => {
      const scan = planted(plantedState(), {
        "track-gaps.ts": `import type { TrackGapsState, TranslatorState } from "../state.js";\nexport function diff(state: TranslatorState, store: TrackGapsState): void {}\n`,
      });

      expect(scan.violations.map((v) => `${v.rule}:${v.line}:${v.name}`)).toEqual([
        "C:1:TrackGapsState",
        "C:2:TrackGapsState",
      ]);
    });

    it("reports a read through a module-local alias of TranslatorState", () => {
      const scan = planted(plantedState(), {
        "fastest-lap.ts": `${IMPORT}type Ctx = TranslatorState;\nexport function diff(state: Ctx): void {\n  state.fastestLap.record = null;\n}\n`,
      });

      expect(scan.violations.map((v) => `${v.rule}:${v.module}:${v.line}:${v.name}`)).toEqual([
        "C:fastest-lap.ts:4:fastestLap",
      ]);
    });

    it("reports a read through an alias of an alias, declared before its target", () => {
      const scan = planted(plantedState(), {
        "fastest-lap.ts": `${IMPORT}type Outer = Readonly<Inner>;\ntype Inner = Pick<TranslatorState, "fastestLap">;\nexport function diff(state: Outer): unknown {\n  return state.fastestLap;\n}\n`,
      });

      expect(scan.violations.map((v) => `${v.rule}:${v.module}:${v.line}:${v.name}`)).toEqual([
        "C:fastest-lap.ts:5:fastestLap",
      ]);
    });

    it("reports a read through a local interface extending TranslatorState", () => {
      const scan = planted(plantedState(), {
        "fastest-lap.ts": `${IMPORT}interface Ctx extends TranslatorState { extra: number }\nexport function diff(state: Ctx): unknown {\n  const { trackGaps } = state;\n  return trackGaps;\n}\n`,
      });

      expect(violationNames(scan)).toEqual(["C:trackGaps"]);
    });

    it("passes a local alias that does not reach TranslatorState", () => {
      const scan = planted(plantedState(), {
        "fastest-lap.ts": `${IMPORT}type Other = { fastestLap: number };\ntype Alias = Other;\nexport function diff(state: TranslatorState, other: Alias): number {\n  return other.fastestLap + (state.pitLaneInitialized ? 1 : 0);\n}\n`,
      });

      expect(scan.violations).toEqual([]);
    });

    it("reports a read through an inline import type, which counts as importing the state", () => {
      const scan = planted(plantedState(), {
        "inline.ts": `export function diff(state: import("../state.js").TranslatorState): unknown {\n  return state.fastestLap;\n}\n`,
        "inline-slice.ts": `export function diff(store: import("../state.js").TrackGapsState, state: import("../state.js").TranslatorState): boolean {\n  return state.pitLaneInitialized;\n}\n`,
      });

      expect(scan.violations.map((v) => `${v.rule}:${v.module}:${v.line}:${v.name}`)).toEqual([
        "C:inline-slice.ts:1:TrackGapsState",
        "C:inline.ts:2:fastestLap",
      ]);
      expect(scan.stateImporters).toEqual(["inline-slice.ts", "inline.ts"]);
    });

    it("reports an exported type that stands for or holds the state, by its exported name", () => {
      const scan = planted(plantedState(), {
        "a.ts": `${IMPORT}export type DiffState = TranslatorState;\n`,
        "b.ts": `${IMPORT}type Local = Readonly<TranslatorState>;\nexport type { Local as Shared };\n`,
        "c.ts": `${IMPORT}export interface Ctx { now: number; state: TranslatorState }\n`,
        "d.ts": `export type { TranslatorState } from "../state.js";\n`,
      });

      expect(scan.violations.map((v) => `${v.rule}:${v.module}:${v.line}:${v.name}`)).toEqual([
        "C:a.ts:2:DiffState",
        "C:b.ts:3:Shared",
        "C:c.ts:2:Ctx",
        "C:d.ts:1:TranslatorState",
      ]);
      expect(scan.violations[0].message).toContain("Keep such a type module-local");
    });

    it("counts a namespace import used only in an `extends` clause as importing the state, and reads through it", () => {
      const scan = planted(plantedState(), {
        "ns.ts": `import type * as S from "../state.js";\ninterface Ctx extends S.TranslatorState { extra: number }\nexport function diff(state: Ctx): unknown {\n  return state.fastestLap;\n}\n`,
        "unused-ns.ts": `import type * as S from "../state.js";\nexport function diff(store: S.TrackGapsState): number {\n  return store.ahead.length;\n}\n`,
      });

      expect(scan.stateImporters).toEqual(["ns.ts"]);
      expect(scan.violations.map((v) => `${v.rule}:${v.module}:${v.line}:${v.name}`)).toEqual([
        "C:ns.ts:4:fastestLap",
      ]);
    });

    it("counts `export * from` and `export * as ns from` the state module as importing it, and reports each as a stand-in", () => {
      const scan = planted(plantedState(), {
        "a.ts": `export * from "../state.js";\n`,
        "b.ts": `export * as S from "../state.js";\n`,
        "c.ts": `export type * from "../state.js";\n`,
      });

      expect(scan.stateImporters).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect(scan.violations.map((v) => `${v.rule}:${v.module}:${v.line}:${v.name}`)).toEqual([
        "C:a.ts:1:TranslatorState",
        "C:b.ts:1:S",
        "C:c.ts:1:TranslatorState",
      ]);
    });

    it("counts TranslatorState imported or re-exported through another relative module, and reads through it (rules C and E)", () => {
      // The relay, `src/translator-types.ts` re-exporting TranslatorState from
      // state.ts, sits outside diff/ and is never scanned: each diff module is
      // read alone, so the name is what the scan keys on.
      const RELAY = `"../translator-types.js"`;
      const scan = planted(plantedState(), {
        "named.ts": `import type { TranslatorState } from ${RELAY};\nexport function diff(state: TranslatorState): unknown {\n  return state.fastestLap;\n}\n`,
        "inline-type.ts": `import { type TranslatorState as S } from ${RELAY};\nexport function diff(state: S): unknown {\n  return state.trackGaps;\n}\n`,
        "namespace.ts": `import type * as T from ${RELAY};\nexport function diff(state: T.TranslatorState): unknown {\n  return state.fastestLap;\n}\n`,
        "import-type.ts": `export function diff(state: import(${RELAY}).TranslatorState): unknown {\n  return state.trackGaps;\n}\n`,
        "re-export.ts": `export type { TranslatorState } from ${RELAY};\n`,
      });

      expect(scan.stateImporters).toEqual([
        "import-type.ts",
        "inline-type.ts",
        "named.ts",
        "namespace.ts",
        "re-export.ts",
      ]);
      expect(scan.violations.map((v) => `${v.rule}:${v.module}:${v.line}:${v.name}`)).toEqual([
        "C:import-type.ts:2:trackGaps",
        "C:inline-type.ts:3:trackGaps",
        "C:named.ts:3:fastestLap",
        "C:namespace.ts:3:fastestLap",
        "C:re-export.ts:1:TranslatorState",
      ]);
      expect(violationKeys(checkStateImporters(scan, [], []))).toEqual([
        "E:import-type.ts:import-type.ts",
        "E:inline-type.ts:inline-type.ts",
        "E:named.ts:named.ts",
        "E:namespace.ts:namespace.ts",
        "E:re-export.ts:re-export.ts",
      ]);
    });

    it("passes another name from a relative module, TranslatorState from a package, and a slice type from a relay", () => {
      const scan = planted(plantedState(), {
        "other-name.ts": `import type { EmitFn } from "./types.js";\nimport type * as T from "../translator-types.js";\nexport function diff(emit: EmitFn, holder: T.Other): unknown {\n  return [emit, holder];\n}\n`,
        "package.ts": `import type { TranslatorState } from "@iracedeck/other";\nexport function diff(state: TranslatorState): unknown {\n  return state.fastestLap;\n}\n`,
        "relay-slice.ts": `import type { FastestLapState } from "../translator-types.js";\nexport function diff(slice: FastestLapState): unknown {\n  return slice.record;\n}\n`,
      });

      expect(scan.stateImporters).toEqual([]);
      expect(scan.violations).toEqual([]);
    });

    it("passes an exported type that neither is nor holds the state", () => {
      const scan = planted(plantedState(), {
        "gaps.ts": `${IMPORT}export type Reading = { gap: number; traces: TranslatorState["pitLaneInitialized"] };\ntype Local = TranslatorState;\nexport function diff(state: Local): boolean {\n  return state.pitLaneInitialized;\n}\n`,
      });

      expect(scan.violations).toEqual([]);
    });

    it("reports a read through a container property, directly, through an alias and nested", () => {
      const scan = planted(plantedState(), {
        "direct.ts": `${IMPORT}export function diff(ctx: { state: TranslatorState }): unknown {\n  return ctx.state.fastestLap;\n}\n`,
        "alias.ts": `${IMPORT}type Ctx = { now: number; state: Readonly<TranslatorState> };\nexport function diff(ctx: Ctx): unknown {\n  const { state } = ctx;\n  const held = ctx.state;\n  return [state.trackGaps, held.fastestLap, ctx["state"].trackGaps];\n}\n`,
        "nested.ts": `${IMPORT}type Outer = { inner: { state: TranslatorState } };\nexport function diff(ctx: Outer): unknown {\n  const { inner: { state: { fastestLap } } } = ctx;\n  return [fastestLap, ctx.inner.state.trackGaps];\n}\n`,
      });

      expect(scan.violations.map((v) => `${v.rule}:${v.module}:${v.line}:${v.name}`)).toEqual([
        "C:alias.ts:6:trackGaps",
        "C:alias.ts:6:fastestLap",
        "C:alias.ts:6:trackGaps",
        "C:direct.ts:3:fastestLap",
        "C:nested.ts:4:fastestLap",
        "C:nested.ts:5:trackGaps",
      ]);
    });

    it("reports a read through a union or an intersection with the state", () => {
      const scan = planted(plantedState(), {
        "a.ts": `${IMPORT}export function diff(state: TranslatorState | null, both: TranslatorState & { extra: number }): unknown {\n  return [state!.fastestLap, both.trackGaps];\n}\n`,
      });

      expect(violationNames(scan)).toEqual(["C:fastestLap", "C:trackGaps"]);
    });

    it("passes ctx.fastestLap on a container of the state, and an indexed access of the state", () => {
      const scan = planted(plantedState(), {
        "direct.ts": `${IMPORT}export function diff(ctx: { state: TranslatorState; fastestLap: number }): number {\n  return ctx.fastestLap;\n}\n`,
        "alias.ts": `${IMPORT}type Ctx = { state: TranslatorState; trackGaps: number[] };\nexport function diff(ctx: Ctx): unknown {\n  const { trackGaps } = ctx;\n  return [ctx.trackGaps, trackGaps];\n}\n`,
        "indexed.ts": `${IMPORT}export function diff(traces: TranslatorState["pitLaneInitialized"] & { fastestLap: number }): number {\n  return traces.fastestLap;\n}\n`,
      });

      expect(scan.violations).toEqual([]);
      expect(scan.sliceReads).toEqual([]);
    });

    it("passes other.fastestLap on a receiver not annotated TranslatorState", () => {
      const scan = planted(plantedState(), {
        "fastest-lap.ts": `${IMPORT}type Other = { fastestLap: number };\nexport function diff(state: TranslatorState, other: Other): number {\n  const { fastestLap } = other;\n  return other.fastestLap + fastestLap + (state.pitLaneInitialized ? 1 : 0);\n}\n`,
      });

      expect(scan.violations).toEqual([]);
      expect(scan.sliceReads).toEqual([]);
      expect(scan.stateImporters).toEqual(["fastest-lap.ts"]);
    });

    it("passes a slice read in a module that takes the slice and not the state", () => {
      const scan = planted(plantedState(), {
        "fastest-lap.ts": `import type { FastestLapState } from "../state.js";\nexport function diff(slice: FastestLapState, holder: { fastestLap: FastestLapState }): unknown {\n  return [slice.record, holder.fastestLap];\n}\n`,
      });

      expect(scan.violations).toEqual([]);
      expect(scan.stateImporters).toEqual([]);
    });

    it("exempts an allow-listed read, and reports an entry that matches nothing", () => {
      const diff = {
        "laps.ts": `${IMPORT}export function diff(state: TranslatorState): unknown {\n  return state.trackGaps;\n}\n`,
      };
      const allowed = { "laps.ts:trackGaps": "planted reason", "gaps.ts:fastestLap": "stale" };
      const scan = planted(plantedState(), diff, PLANTED_PIN, allowed);

      expect(violationNames(scan)).toEqual(["allow:gaps.ts:fastestLap"]);
      expect(scan.violations[0].message).toContain("delete the entry");
      expect(scan.sliceReads).toEqual([{ module: "laps.ts", key: "trackGaps", line: 3, allowed: true }]);
    });
  });

  describe("rule D", () => {
    it("reports an assignment state.trackGaps = … in a diff module", () => {
      const scan = planted(plantedState(), {
        "track-gaps.ts": `import { createTrackGapsState, type TranslatorState } from "../state.js";\nexport function reset(state: TranslatorState): void {\n  state.trackGaps = createTrackGapsState();\n}\n`,
      });

      expect(scan.violations.map((v) => `${v.rule}:${v.module}:${v.line}:${v.name}`)).toEqual([
        "D:track-gaps.ts:3:trackGaps",
        "C:track-gaps.ts:3:trackGaps",
      ]);
      expect(scan.violations[0].message).toContain("Object.assign(<slice>, createTrackGapsState())");
    });

    it("reports the replacement on any receiver, in a module that does not import TranslatorState", () => {
      const scan = planted(plantedState(), {
        "other.ts": `export function reset(holder: { fastestLap: unknown }): void {\n  holder["fastestLap"] ??= {};\n}\n`,
      });

      expect(violationNames(scan)).toEqual(["D:fastestLap"]);
    });

    it("reports a slice key in an Object.assign source literal, shorthand included", () => {
      const scan = planted(plantedState(), {
        "other.ts": `export function reset(holder: object): void {\n  const fastestLap = {};\n  Object.assign(holder, { trackGaps: {} });\n  Object.assign(holder, { now: 1 }, { fastestLap });\n}\n`,
      });

      expect(scan.violations.map((v) => `${v.rule}:${v.line}:${v.name}`)).toEqual(["D:3:trackGaps", "D:4:fastestLap"]);
      expect(scan.violations[0].message).toContain("Object.assign");
    });

    it("reports a slice key as a destructuring assignment target and as a loop variable", () => {
      const scan = planted(plantedState(), {
        "other.ts": `export function reset(holder: { trackGaps: unknown; fastestLap: unknown }, obj: { a: unknown }, x: unknown, xs: unknown[]): void {\n  ({ a: holder.trackGaps } = obj);\n  [holder.fastestLap] = [x];\n  ({ a: holder["trackGaps"] = x } = obj);\n  for (holder.fastestLap of xs) {}\n}\n`,
      });

      expect(scan.violations.map((v) => `${v.rule}:${v.line}:${v.name}`)).toEqual([
        "D:2:trackGaps",
        "D:3:fastestLap",
        "D:4:trackGaps",
        "D:5:fastestLap",
      ]);
    });

    it("passes an in-place clear through Object.assign and a slice key read as a destructuring source", () => {
      const scan = planted(plantedState(), {
        "other.ts": `export function reset(holder: { trackGaps: object }, obj: { trackGaps: unknown }): unknown {\n  let local: unknown;\n  Object.assign(holder.trackGaps, createTrackGapsState());\n  Object.assign(holder, { other: 1 });\n  ({ trackGaps: local } = obj);\n  return local;\n}\n`,
      });

      expect(scan.violations).toEqual([]);
    });

    it("passes an in-place clear", () => {
      const scan = planted(plantedState(), {
        "track-gaps.ts": `import { createTrackGapsState, type TrackGapsState } from "../state.js";\nexport function reset(store: TrackGapsState): void {\n  Object.assign(store, createTrackGapsState());\n}\n`,
      });

      expect(scan.violations).toEqual([]);
    });
  });

  describe("rule B, frozen baseline", () => {
    const FROZEN = ["lastOnPitRoad", "pitLaneInitialized"];

    it("passes the pin its baseline holds, whatever the headings", () => {
      expect(checkFlatPinFrozen(PLANTED_PIN, FROZEN)).toEqual([]);
      expect(checkFlatPinFrozen({ Renamed: ["lastOnPitRoad"], Other: ["pitLaneInitialized"] }, FROZEN)).toEqual([]);
    });

    it("reports a name added to the pin by name, pointing at the slice convention and printing nothing to copy", () => {
      const findings = checkFlatPinFrozen(
        { "Pit lane / stall": ["pitLaneInitialized", "lastOnPitRoad", "fastestLapClaim"] },
        FROZEN,
      );

      expect(violationKeys(findings)).toEqual(["B:fastestLapClaim"]);
      expect(findings[0].message).toContain(
        'LEGACY_FLAT_MEMBERS["Pit lane / stall"] names `fastestLapClaim`, which FROZEN_FLAT_MEMBERS (src/state-slices.baseline.test-support.ts) does not hold',
      );
      expect(findings[0].message).toContain("the pin only shrinks. New state goes into a slice");
      expect(findings[0].message).toContain(
        '`packages/sim-events-iracing/CLAUDE.md`, "Translator state slices (#1588)"',
      );
      expect(findings[0].message).toContain("never add one to let a name in");
      expect(findings[0].message).not.toMatch(/count:|sha256/);
    });

    it("reports a name swapped in for one that left: the added name, and the line to delete", () => {
      const findings = checkFlatPinFrozen({ "Pit lane / stall": ["pitLaneInitialized", "fastestLapClaim"] }, FROZEN);

      expect(violationKeys(findings)).toEqual(["B:fastestLapClaim", "B:lastOnPitRoad"]);
      expect(findings[0].message).toContain("A flat member renamed is a name added");
      expect(findings[1].message).toContain('delete the line `"lastOnPitRoad",` from FROZEN_FLAT_MEMBERS');
    });

    it("reports the name added by a change that removes two and adds one, before and after the two lines are deleted", () => {
      const frozen = ["lastOnPitRoad", "pitBoxEntrySeeded", "pitLaneInitialized"];
      const pin = { "Pit lane / stall": ["pitLaneInitialized", "fastestLapClaim"] };

      expect(violationKeys(checkFlatPinFrozen(pin, frozen))).toEqual([
        "B:fastestLapClaim",
        "B:lastOnPitRoad",
        "B:pitBoxEntrySeeded",
      ]);
      expect(violationKeys(checkFlatPinFrozen(pin, ["pitLaneInitialized"]))).toEqual(["B:fastestLapClaim"]);
    });

    it("reports a shrunk pin whose baseline still holds the name, naming the line to delete, and passes once it is deleted", () => {
      const pin = { "Pit lane / stall": ["pitLaneInitialized"] };
      const findings = checkFlatPinFrozen(pin, FROZEN);

      expect(violationKeys(findings)).toEqual(["B:lastOnPitRoad"]);
      expect(findings[0].message).toContain(
        'FROZEN_FLAT_MEMBERS (src/state-slices.baseline.test-support.ts) holds `lastOnPitRoad`, which LEGACY_FLAT_MEMBERS no longer names: delete the line `"lastOnPitRoad",`',
      );
      expect(findings[0].message).not.toMatch(/count:|sha256/);
      expect(checkFlatPinFrozen(pin, ["pitLaneInitialized"])).toEqual([]);
    });

    it("reports a baseline out of code-unit order, and one with a repeat", () => {
      const unsorted = checkFlatPinFrozen(PLANTED_PIN, ["pitLaneInitialized", "lastOnPitRoad"]);

      expect(violationKeys(unsorted)).toEqual(["B:lastOnPitRoad"]);
      expect(unsorted[0].message).toContain("keep it sorted by code unit with each name once");
      expect(
        violationKeys(checkFlatPinFrozen(PLANTED_PIN, ["lastOnPitRoad", "lastOnPitRoad", "pitLaneInitialized"])),
      ).toEqual(["B:lastOnPitRoad"]);
    });
  });

  describe("rule E", () => {
    const WHOLE = `${IMPORT}export function diff(state: TranslatorState): boolean {\n  return state.pitLaneInitialized;\n}\n`;
    const SLICED = `import type { FastestLapState } from "../state.js";\nexport function diff(slice: FastestLapState): unknown {\n  return slice.record;\n}\n`;
    const diff = { "flags.ts": WHOLE, "laps.ts": WHOLE, "fastest-lap.ts": SLICED };
    const PIN = ["flags.ts", "laps.ts"];
    const FROZEN = ["flags.ts", "laps.ts"];

    it("passes when the importers are the pinned modules and the baseline holds the pin", () => {
      const scan = planted(plantedState(), diff);

      expect(scan.violations).toEqual([]);
      expect(scan.stateImporters).toEqual(["flags.ts", "laps.ts"]);
      expect(checkStateImporters(scan, PIN, FROZEN)).toEqual([]);
    });

    it("reports a new diff module importing TranslatorState, telling it to take its slice", () => {
      const scan = planted(plantedState(), { ...diff, "leader-white.ts": WHOLE });
      const findings = checkStateImporters(scan, PIN, FROZEN);

      expect(violationKeys(findings)).toEqual(["E:leader-white.ts:leader-white.ts"]);
      expect(findings[0].message).toContain("diff/leader-white.ts imports TranslatorState");
      expect(findings[0].message).toContain("a new diff module takes its slice as its first parameter");
      expect(findings[0].message).toContain("another family's fact arrives as a value");
      expect(findings[0].message).not.toMatch(/add it/i);
    });

    it("reports the new module added to the pin by name, printing nothing to copy", () => {
      const scan = planted(plantedState(), { ...diff, "leader-white.ts": WHOLE });
      const findings = checkStateImporters(scan, [...PIN, "leader-white.ts"], FROZEN);

      expect(violationKeys(findings)).toEqual(["E:leader-white.ts:leader-white.ts"]);
      expect(findings[0].message).toContain(
        "WHOLE_STATE_DIFF_MODULES names `leader-white.ts`, which FROZEN_WHOLE_STATE_DIFF_MODULES (src/state-slices.baseline.test-support.ts) does not hold",
      );
      expect(findings[0].message).toContain("takes its slice as its first parameter");
      expect(findings[0].message).not.toMatch(/count:|sha256/);
    });

    it("reports a module swapped into the pin for one that left: the added module, and the line to delete", () => {
      const scan = planted(plantedState(), { "flags.ts": WHOLE, "leader-white.ts": WHOLE });
      const findings = checkStateImporters(scan, ["flags.ts", "leader-white.ts"], FROZEN);

      expect(violationKeys(findings)).toEqual(["E:leader-white.ts:leader-white.ts", "E:laps.ts:laps.ts"]);
      expect(findings[1].message).toContain('delete the line `"laps.ts",` from FROZEN_WHOLE_STATE_DIFF_MODULES');
    });

    it("reports the module added by a change that moves two onto their slices and adds one, before and after the two lines are deleted", () => {
      const scan = planted(plantedState(), {
        "flags.ts": WHOLE,
        "laps.ts": SLICED,
        "radar.ts": SLICED,
        "leader-white.ts": WHOLE,
      });
      const pin = ["flags.ts", "leader-white.ts"];

      expect(violationKeys(checkStateImporters(scan, pin, ["flags.ts", "laps.ts", "radar.ts"]))).toEqual([
        "E:leader-white.ts:leader-white.ts",
        "E:laps.ts:laps.ts",
        "E:radar.ts:radar.ts",
      ]);
      expect(violationKeys(checkStateImporters(scan, pin, ["flags.ts"]))).toEqual([
        "E:leader-white.ts:leader-white.ts",
      ]);
    });

    it("reports a stale entry with the pin entry and baseline line to delete, and passes once both are gone", () => {
      const scan = planted(plantedState(), { ...diff, "laps.ts": SLICED });
      const stale = checkStateImporters(scan, PIN, FROZEN);

      expect(violationKeys(stale)).toEqual(["E:laps.ts:laps.ts"]);
      expect(stale[0].message).toContain(
        'names `laps.ts`, which no longer imports TranslatorState: delete the entry, and the line `"laps.ts",` from FROZEN_WHOLE_STATE_DIFF_MODULES',
      );

      const pinOnly = checkStateImporters(scan, ["flags.ts"], FROZEN);

      expect(violationKeys(pinOnly)).toEqual(["E:laps.ts:laps.ts"]);
      expect(pinOnly[0].message).toContain(
        'holds `laps.ts`, which WHOLE_STATE_DIFF_MODULES no longer names: delete the line `"laps.ts",`',
      );
      expect(checkStateImporters(scan, ["flags.ts"], ["flags.ts"])).toEqual([]);
    });

    it("reports an entry that is not a diff module at all", () => {
      const scan = planted(plantedState(), { "flags.ts": WHOLE });
      const findings = checkStateImporters(scan, PIN, FROZEN);

      expect(violationKeys(findings)).toEqual(["E:laps.ts:laps.ts"]);
      expect(findings[0].message).toContain("which is not a diff module");
    });

    it("reports an entry named twice", () => {
      const scan = planted(plantedState(), diff);
      const findings = checkStateImporters(scan, [...PIN, "laps.ts"], FROZEN);

      expect(violationKeys(findings)).toEqual(["E:laps.ts:laps.ts"]);
      expect(findings[0].message).toContain("names `laps.ts` twice");
    });

    it("reports a baseline out of code-unit order", () => {
      const scan = planted(plantedState(), diff);
      const findings = checkStateImporters(scan, PIN, ["laps.ts", "flags.ts"]);

      expect(violationKeys(findings)).toEqual(["E:flags.ts:flags.ts"]);
      expect(findings[0].message).toContain("keep it sorted by code unit");
    });
  });
});
