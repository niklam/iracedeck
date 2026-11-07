import { describe, expect, it } from "vitest";

import {
  type FlatMemberPin,
  readSliceSources,
  scanStateSlices,
  type SliceReadAllowList,
  type SliceScan,
  type SliceSources,
} from "./state-slices.test-support.js";

/**
 * `TranslatorState` arrives in slices (#1588): every new cluster of translator
 * state is one member `<family>: <Family>State`, and a diff takes its slice
 * rather than the whole state. This guards the convention over `state.ts` and
 * `diff/` with the four rules of the #1588 spec, decision 3; the scanner's
 * header in `state-slices.test-support.ts` says what each rule matches.
 */

/**
 * The clusters of `TranslatorState` that are still flat, by the
 * `// ── <heading> ──` comment they sit under in `state.ts`, and the one list
 * of them (`CLAUDE.md` points here). It only shrinks: a name is never added,
 * and moving a cluster into a slice deletes its entry in the same change. The
 * comment on an entry is what its move must settle first; an entry without one
 * has not been assessed yet, so its move starts by reading how the replay wipe
 * (`wipeStateForReplay`) treats its fields and which other diffs read them.
 *
 * Not here: "Track-order gaps outside a race (issue #1515)" (`trackGaps`),
 * "Fastest lap of the race (issue #1571)" (`fastestLap`) and
 * "Laps-of-fuel-left callouts (issue #838)" (`fuelCallout`), whose only
 * members are slices, and the `lapCrossing` slice under "Lap completion".
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
  "Corner-name callouts (issue #888)": [
    "cornerLeadPrevPct",
    "cornerSpoken",
    "cornerMarkersKey",
    "cornerMarkers",
    "lapStartedFromPits",
  ],
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
    "lastLimiterActive",
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
  // Partial replay keep (`gapRestartMark`); the translator's pair reading for
  // `diffOpponentFlags` reads its traces, which the slice must still serve.
  // About 22 signature lines in `diff/gaps.ts` take the whole state.
  "Gaps (issue #933)": [
    "gapTraces",
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

/** Rule C's exceptions: `<module under diff/>:<slice key>` → why that module still reads the slice through `TranslatorState`. */
const SLICE_READS_ALLOWED: SliceReadAllowList = {
  "laps.ts:lapCrossing":
    "The laps cluster is still flat, so `diffLaps` takes the whole state; the crossing nests into the laps slice when that cluster moves (#1588 spec, decision 3, rule C).",
};

/** The slices the tree has, by key. */
const SLICE_KEYS = ["trackGaps", "fastestLap", "fuelCallout", "lapCrossing"];

const violationNames = (scan: SliceScan): string[] => scan.violations.map((v) => `${v.rule}:${v.name}`);
const violationKeys = (scan: SliceScan): string[] =>
  scan.violations.map((v) => `${v.rule}:${v.module ?? "state.ts"}:${v.name}`);

/** The violations `planted` reports that `baseline` does not, so a real-tree control fails only for what it plants. */
const added = (baseline: SliceScan, planted: SliceScan): string[] => {
  const before = new Set(violationKeys(baseline));

  return violationKeys(planted).filter((key) => !before.has(key));
};

describe("TranslatorState keeps to the slice convention (#1588)", () => {
  const sources = readSliceSources(import.meta.dirname);
  const scan = scanStateSlices(sources, LEGACY_FLAT_MEMBERS, SLICE_READS_ALLOWED);

  it("scans the whole state and every diff module, not an empty or narrowed read", () => {
    // Measured after the fuel-callout move (#1405), 2026-11-07: 239 members
    // (235 pinned flat under 30 headings, 4 slices), 46 diff modules, 29 of
    // them importing TranslatorState.
    expect(scan.members.length).toBeGreaterThan(200);
    expect(scan.diffModules.length).toBeGreaterThanOrEqual(40);
    expect(scan.stateImporters.length).toBeGreaterThanOrEqual(28);
    expect(scan.diffModules).toContain("laps.ts");
    expect(scan.stateImporters).toContain("laps.ts");
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
    expect(scan.violations.map((violation) => violation.message)).toEqual([]);
  });

  it("reports a flat member added to the real state.ts", () => {
    const anchor = "  // ── Radar ";

    expect(sources.state).toContain(anchor);

    const planted = sources.state.replace(anchor, `  plantedFlatMember: number;\n\n${anchor}`);
    const result = scanStateSlices({ ...sources, state: planted }, LEGACY_FLAT_MEMBERS, SLICE_READS_ALLOWED);

    expect(added(scan, result)).toEqual(["A:state.ts:plantedFlatMember"]);
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

    expect(added(scan, result)).toEqual(["C:flags.ts:fastestLap"]);
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
});
