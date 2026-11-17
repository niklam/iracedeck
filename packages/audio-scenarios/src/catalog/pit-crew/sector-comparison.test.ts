/**
 * The sector comparison (issue #1572). The pure policy — the reference, the
 * thresholds, the pictures, the selection — is pinned function by function,
 * each threshold on both sides of its value; then the three contracts are
 * driven through the real scenario engine and the real `registerPitCrew`,
 * over hand-built entries in the shape the spec's decision 9 gives (the
 * bundled entries are `skip: true` until the clips are approved) and a
 * manifest of exactly the clips those lines need. The gates, the claim in
 * the gate, the cadence and the order at the line against the lap-time calls
 * each have their positive control beside the refusal.
 */
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { createFakeAudio, type FakeAudio } from "@iracedeck/audio-service/testing";
import { type CalloutScript, type CalloutScriptEntry, collectScriptReferences } from "@iracedeck/callout-script";
import { SECTOR_COMPARISON_CALLOUTS } from "@iracedeck/callout-settings";
import type { CountedLapCompleted, IEventBus, SessionClass, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { classifySession } from "@iracedeck/sim-events-iracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, getScenarioEngine, initializeAudioScenarios } from "../../interpreter.js";
import { descriptionNamesGroup } from "../../reference/pack-reference.js";
import type { FastestLapData } from "./fastest-lap.js";
import { registerPitCrew } from "./index.js";
import type { LapCompletedSnapshot } from "./lap-time.js";
import { _resetLimiterCueEngine } from "./limiter-cue-engine.js";
import { _resetPitExitCueEngine } from "./pit-exit-cue-engine.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { _resetRadarEngine } from "./radar-engine.js";
import {
  buildSectorComparison,
  leaderPicture,
  neighbourPicture,
  PACE_DRIFT_S,
  PACE_GAP_MAX_S,
  PACE_LEVEL_S,
  PACE_REPEAT_LAPS,
  paceGapOf,
  paceTenths,
  pictureDue,
  readSectorComparisonDebugState,
  resetSectorComparison,
  SCENARIO_ID_TO_SECTOR_COMPARISON_ID,
  SECTOR_BATTLE_GAP_S,
  SECTOR_CALL_MIN_LAPS,
  SECTOR_CHANCE_MIN_S,
  SECTOR_COMPARISON_CLIP_SOURCES,
  SECTOR_COMPARISON_CONTRACT_IDS,
  SECTOR_COMPARISON_SCENARIO_IDS,
  SECTOR_COMPARISON_TRIGGER_DELAY_MS,
  SECTOR_DELTA_MIN_S,
  SECTOR_LOSS_SHAPE_KEYS,
  SECTOR_MOST_SHARE,
  SECTOR_PACE_SHAPE_KEYS,
  SECTOR_RECENT_LAPS,
  SECTOR_REFERENCE_LAPS,
  type SectorCallMemory,
  type SectorCarInput,
  type SectorComparisonDeps,
  type SectorComparisonInput,
  sectorDeltas,
  type SectorLapInput,
  type SectorPicture,
  sectorReference,
  type SectorTarget,
  selectSectorCall,
  type SpokenSectorPicture,
  stillTheNamedCar,
} from "./sector-comparison.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

const VOICE = "default";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** The player's sector times on every lap of the fixtures. Binary fractions throughout, so deltas are exact. */
const P = [30, 40, 50] as const;

/** `count` laps ending at `lastLap`, each with these sector times. */
function lapsOf(sectors: readonly (number | null)[], lastLap: number, count = 3, clean = true): SectorLapInput[] {
  return Array.from({ length: count }, (_, i) => ({ lap: lastLap - count + 1 + i, sectorTimes: [...sectors], clean }));
}

/** A car whose last three laps all ran these sector times. */
function car(
  carIdx: number,
  sectors: readonly number[],
  opts: { carNumber?: string | null; gap?: number | null; lastLap?: number } = {},
): SectorCarInput {
  return {
    carIdx,
    carNumber: opts.carNumber === undefined ? String(carIdx) : opts.carNumber,
    gapSeconds: opts.gap === undefined ? 1 : opts.gap,
    lapsCompleted: opts.lastLap ?? 5,
    recentLaps: lapsOf(sectors, opts.lastLap ?? 5),
  };
}

/** The player on lap `lap`, its last lap clean unless said otherwise. */
function player(lap = 5, sectors: readonly number[] = P, lastClean = true): SectorCarInput {
  const laps = lapsOf(sectors, lap, 4);

  laps[laps.length - 1] = { ...laps[laps.length - 1], clean: lastClean };

  return { carIdx: 0, carNumber: "1", gapSeconds: null, lapsCompleted: lap, recentLaps: laps };
}

function input(overrides: Partial<SectorComparisonInput> = {}): SectorComparisonInput {
  return { sectorCount: P.length, player: player(), leader: null, ahead: null, behind: null, ...overrides };
}

/** The leader slower picture of the spec's example: most of it in sector two, quicker in sector three (pace 0.5). */
const LEADER_MOST = car(20, [29.875, 39.5, 50.125], { carNumber: "3", gap: null });
/** The leader quicker everywhere by at least the bar (pace 0.625). */
const LEADER_EVERY = car(20, [29.875, 39.75, 49.75], { carNumber: "3", gap: null });
/** The player quicker than the leader by 0.625, the leader quicker in sector two. */
const LEADER_SLOWER_THAN_US = car(20, [30.5, 39.875, 50.25], { carNumber: "3", gap: null });
/** Car twelve ahead, slower than the player in sector two by 0.25. */
const AHEAD_SLOW_S2 = car(12, [30, 40.25, 50], { carNumber: "12", gap: 1.5 });
/** Car seven behind, quicker than the player in sector three by 0.25. */
const BEHIND_QUICK_S3 = car(7, [30, 40, 49.75], { carNumber: "7", gap: 1.2 });

const EMPTY_MEMORY: SectorCallMemory = { spoken: new Map(), lastCallLap: null };
const ALL: (t: SectorTarget) => boolean = () => true;

function memory(spoken: Partial<Record<SectorTarget, SpokenSectorPicture>>, lastCallLap: number | null = null) {
  return { spoken: new Map(Object.entries(spoken) as [SectorTarget, SpokenSectorPicture][]), lastCallLap };
}

// ─── The reference ───────────────────────────────────────────────────────────

describe("the reference (decision 5)", () => {
  /** A car with these laps recorded, whose completed-lap count is its newest recorded lap unless given. */
  const laps = (spec: [number, number, boolean][], lapsCompleted?: number | null): SectorCarInput => ({
    carIdx: 3,
    carNumber: "3",
    gapSeconds: 1,
    lapsCompleted: lapsCompleted === undefined ? (spec.at(-1)?.[0] ?? 0) : lapsCompleted,
    recentLaps: spec.map(([lap, t, clean]) => ({ lap, sectorTimes: [t, 2 * t], clean })),
  });

  it("is the per-sector median of the last three clean laps among the last five", () => {
    // Last five: laps 2..6. Clean among them: 2, 4, 5, 6; the last three: 4, 5, 6.
    const c = laps([
      [1, 10, true],
      [2, 31, true],
      [3, 99, false],
      [4, 30, true],
      [5, 50, true],
      [6, 32, true],
    ]);

    expect(sectorReference(c, 2)).toEqual([32, 64]);
  });

  it("ignores one traffic lap: the median of three takes none of its time", () => {
    const c = laps([
      [1, 30, true],
      [2, 45, true],
      [3, 31, true],
    ]);

    expect(sectorReference(c, 2)).toEqual([31, 62]);
  });

  it("is null with two clean laps among the last five", () => {
    const c = laps([
      [2, 30, true],
      [3, 30, false],
      [4, 30, false],
      [5, 30, false],
      [6, 30, true],
    ]);

    expect(sectorReference(c, 2)).toBeNull();
  });

  it("ignores an older clean lap outside the five — and the same lap inside them counts (the positive control)", () => {
    const outside = laps([
      [1, 30, true],
      [2, 30, false],
      [3, 30, false],
      [4, 30, false],
      [5, 30, true],
      [6, 30, true],
    ]);
    const inside = laps([
      [1, 30, false],
      [2, 30, true],
      [3, 30, false],
      [4, 30, false],
      [5, 30, true],
      [6, 30, true],
    ]);

    expect(sectorReference(outside, 2)).toBeNull();
    expect(sectorReference(inside, 2)).toEqual([30, 60]);
  });

  it("does not use a clean lap with a sector unmeasured, nor one recorded for another sector count", () => {
    const base: SectorLapInput[] = [
      { lap: 2, sectorTimes: [30, 60], clean: true },
      { lap: 3, sectorTimes: [30, 60], clean: true },
    ];
    const withNull = { ...laps([], 4), recentLaps: [...base, { lap: 4, sectorTimes: [30, null], clean: true }] };
    const wrongCount = { ...laps([], 4), recentLaps: [...base, { lap: 4, sectorTimes: [30, 30, 30], clean: true }] };
    const complete = { ...laps([], 4), recentLaps: [...base, { lap: 4, sectorTimes: [30, 60], clean: true }] };

    expect(sectorReference(withNull, 2)).toBeNull();
    expect(sectorReference(wrongCount, 2)).toBeNull();
    expect(sectorReference(complete, 2)).toEqual([30, 60]);
  });

  it("counts the five back from the car's completed laps, not its recorded ones: laps it was not measured on still count", () => {
    // Completed 12 laps; recorded only 2..6 (the timer missed the rest): the
    // last five completed are 8..12, and none of them was recorded.
    const recordedLongAgo = laps(
      [
        [2, 30, true],
        [3, 30, true],
        [4, 30, true],
        [5, 30, true],
        [6, 30, true],
      ],
      12,
    );

    expect(sectorReference(recordedLongAgo, 2)).toBeNull();
    // The positive control: the same laps with the car on lap 6 are its last five.
    expect(sectorReference({ ...recordedLongAgo, lapsCompleted: 6 }, 2)).toEqual([30, 60]);
  });

  it("uses only the window when three clean laps are inside it and older ones outside", () => {
    // Completed 10: the window is 6..10. Laps 1..4 (a slower stint) are outside it.
    const c = laps(
      [
        [1, 40, true],
        [2, 40, true],
        [3, 40, true],
        [4, 40, true],
        [7, 30, true],
        [9, 31, true],
        [10, 32, true],
      ],
      10,
    );

    expect(sectorReference(c, 2)).toEqual([31, 62]);
    // The bound is exact: with laps 9 and 10, lap 6 is inside the window ending at 10 and lap 5 is not.
    const edge = (lap: number) =>
      laps(
        [
          [lap, 50, true],
          [9, 31, true],
          [10, 32, true],
        ],
        10,
      );

    expect(sectorReference(edge(6), 2)).toEqual([32, 64]);
    expect(sectorReference(edge(5), 2)).toBeNull();
  });

  it("is null for a car the sim reports no lap count for (out of the world: retired, in the garage)", () => {
    const retired = laps(
      [
        [3, 30, true],
        [4, 30, true],
        [5, 30, true],
      ],
      null,
    );

    expect(sectorReference(retired, 2)).toBeNull();
    expect(sectorReference({ ...retired, lapsCompleted: 5 }, 2)).toEqual([30, 60]);
  });

  it("holds the player to the same window: no reference once the player's own recorded laps are too old", () => {
    const stale = { ...player(5), lapsCompleted: 11 };

    expect(sectorReference(player(5), 3)).toEqual([...P]);
    expect(sectorReference(stale, 3)).toBeNull();
    expect(selectSectorCall(input({ player: stale, ahead: AHEAD_SLOW_S2 }), 11, ALL, EMPTY_MEMORY)).toBeNull();
  });

  it("uses the window sizes the spec sets", () => {
    expect(SECTOR_REFERENCE_LAPS).toBe(3);
    expect(SECTOR_RECENT_LAPS).toBe(5);
  });

  it("gives the deltas player minus target, positive where the player is slower, and the pace gap as their sum", () => {
    const deltas = sectorDeltas(input({ leader: LEADER_MOST }), LEADER_MOST);

    expect(deltas).toEqual([0.125, 0.5, -0.125]);
    expect(paceGapOf(deltas ?? [])).toBe(0.5);
    // No reference on one side: no deltas.
    expect(sectorDeltas(input({ player: { ...player(), recentLaps: [] } }), LEADER_MOST)).toBeNull();
  });
});

// ─── The pictures and their thresholds ──────────────────────────────────────

describe("the leader's picture (decision 6)", () => {
  const withLeader = (sectors: readonly number[], playerSectors: readonly number[] = P) =>
    leaderPicture({
      sectorCount: playerSectors.length,
      player: player(5, playerSectors),
      leader: car(20, sectors, { gap: null }),
      ahead: null,
      behind: null,
    });

  it("most of it in sector two, quicker in sector three — the spec's example", () => {
    expect(leaderPicture(input({ leader: LEADER_MOST }))).toEqual({
      target: "leader",
      carIdx: 20,
      carNumber: "3",
      shape: "slower",
      pace: 0.5,
      lossShape: "most",
      lossSector: 2,
      gainSector: 3,
    });
  });

  it("PACE_LEVEL_S: a pace gap of 0.20 speaks, 0.19 is level and silent, on both sides", () => {
    expect(PACE_LEVEL_S).toBe(0.2);
    expect(withLeader([29.8, 40, 50])?.shape).toBe("slower");
    expect(withLeader([29.81, 40, 50])).toBeNull();
    expect(withLeader([30.2, 40, 50])?.shape).toBe("quicker");
    expect(withLeader([30.19, 40, 50])).toBeNull();
  });

  it("PACE_GAP_MAX_S: a pace gap of 5 s speaks, 5.1 s is not racing and silent", () => {
    expect(PACE_GAP_MAX_S).toBe(5);
    expect(withLeader([25, 40, 50])?.pace).toBe(5);
    expect(withLeader([24.9, 40, 50])).toBeNull();
    expect(withLeader([35.1, 40, 50])).toBeNull();
  });

  it("SECTOR_DELTA_MIN_S on the loss: a sector 0.10 slower is named, 0.09 is not", () => {
    expect(SECTOR_DELTA_MIN_S).toBe(0.1);
    // Three sectors 0.09 slower each: slower by 0.27, but no sector stands out — the pace alone.
    expect(withLeader([29.91, 39.91, 49.91])).toMatchObject({
      shape: "slower",
      lossShape: null,
      lossSector: null,
      gainSector: null,
    });
    expect(withLeader([29.9, 39.91, 49.91])).toMatchObject({ shape: "slower", lossShape: "most", lossSector: 1 });
  });

  it("SECTOR_DELTA_MIN_S on the gain: a sector 0.10 quicker is named, 0.09 is not", () => {
    expect(withLeader([29.5, 40, 50.1])).toMatchObject({ lossSector: 1, gainSector: 3 });
    expect(withLeader([29.5, 40, 50.09])).toMatchObject({ lossSector: 1, gainSector: null });
  });

  it("SECTOR_MOST_SHARE: the worst sector at half the loss is most, under half is the largest", () => {
    expect(SECTOR_MOST_SHARE).toBe(0.5);
    const four = [30, 40, 50, 20];

    // Losses 0.25 + 0.25 + 0.5 = 1.0, the worst exactly half: most.
    expect(withLeader([29.75, 39.75, 49.5, 20.25], four)).toMatchObject({
      lossShape: "most",
      lossSector: 3,
      gainSector: 4,
    });
    // Losses 0.25 + 0.25 + 0.375, the worst 0.43 of them: the largest.
    expect(withLeader([29.75, 39.75, 49.625, 20.25], four)).toMatchObject({
      lossShape: "largest",
      lossSector: 3,
      gainSector: 4,
    });
  });

  it("every sector at three sectors, each slower by at least the bar: no sector named, no gain", () => {
    expect(leaderPicture(input({ leader: LEADER_EVERY }))).toMatchObject({
      shape: "slower",
      lossShape: "every",
      lossSector: null,
      gainSector: null,
    });
    // The positive control: one sector only 0.09 slower is not every sector.
    expect(withLeader([29.875, 39.75, 49.91])).toMatchObject({ lossShape: "most", lossSector: 2 });
  });

  it("never says every sector on a two-sector track: both halves slower is most of it in the worse", () => {
    expect(withLeader([29.75, 39.5], [30, 40])).toMatchObject({ lossShape: "most", lossSector: 2, gainSector: null });
  });

  it("quicker than the leader: the shape, the pace and the sector where the leader is quicker", () => {
    expect(leaderPicture(input({ leader: LEADER_SLOWER_THAN_US }))).toEqual({
      target: "leader",
      carIdx: 20,
      carNumber: "3",
      shape: "quicker",
      pace: -0.625,
      lossShape: null,
      lossSector: 2,
      gainSector: null,
    });
  });

  it("is silent about a leader the sim reports no lap count for (retired, in the garage), however its old laps read", () => {
    expect(leaderPicture(input({ leader: { ...LEADER_MOST, lapsCompleted: null } }))).toBeNull();
    // The positive control: the same leader still running.
    expect(leaderPicture(input({ leader: LEADER_MOST }))?.shape).toBe("slower");
  });

  it("is silent on a track with one sector, with no leader, or with no reference on either side", () => {
    expect(withLeader([29], [30])).toBeNull();
    expect(leaderPicture(input())).toBeNull();
    expect(
      leaderPicture(input({ leader: { ...LEADER_MOST, recentLaps: LEADER_MOST.recentLaps.slice(1) } })),
    ).toBeNull();
  });
});

describe("the neighbours' pictures (decision 6)", () => {
  const ahead = (sectors: readonly number[], gap: number | null = 1) =>
    neighbourPicture(input({ ahead: car(12, sectors, { carNumber: "12", gap }) }), "ahead");
  const behind = (sectors: readonly number[], gap: number | null = 1) =>
    neighbourPicture(input({ behind: car(7, sectors, { carNumber: "7", gap }) }), "behind");

  it("the car ahead: the sector where it is slower than the player by the most", () => {
    expect(neighbourPicture(input({ ahead: AHEAD_SLOW_S2 }), "ahead")).toEqual({
      target: "ahead",
      carIdx: 12,
      carNumber: "12",
      shape: null,
      pace: null,
      lossShape: null,
      lossSector: null,
      gainSector: 2,
    });
    expect(ahead([30.25, 40.5, 50])?.gainSector).toBe(2);
  });

  it("the car behind: the sector where it is quicker than the player by the most", () => {
    expect(neighbourPicture(input({ behind: BEHIND_QUICK_S3 }), "behind")).toEqual({
      target: "behind",
      carIdx: 7,
      carNumber: "7",
      shape: null,
      pace: null,
      lossShape: null,
      lossSector: 3,
      gainSector: null,
    });
  });

  it("SECTOR_CHANCE_MIN_S: 0.15 is a chance, 0.14 is not, on both sides", () => {
    expect(SECTOR_CHANCE_MIN_S).toBe(0.15);
    expect(ahead([30, 40.15, 50])?.gainSector).toBe(2);
    expect(ahead([30, 40.14, 50])).toBeNull();
    expect(behind([30, 40, 49.85])?.lossSector).toBe(3);
    expect(behind([30, 40, 49.86])).toBeNull();
  });

  it("SECTOR_BATTLE_GAP_S: a neighbour 3.0 s away is a fight, 3.1 s or an unknown gap is not", () => {
    expect(SECTOR_BATTLE_GAP_S).toBe(3);
    expect(ahead([30, 40.25, 50], 3)?.gainSector).toBe(2);
    expect(ahead([30, 40.25, 50], 3.1)).toBeNull();
    expect(ahead([30, 40.25, 50], null)).toBeNull();
    expect(behind([30, 40, 49.75], 3)?.lossSector).toBe(3);
    expect(behind([30, 40, 49.75], 3.1)).toBeNull();
  });

  it("names nothing where the neighbour is only quicker (ahead) or only slower (behind)", () => {
    expect(ahead([29.75, 40, 50])).toBeNull();
    expect(behind([30.25, 40, 50])).toBeNull();
  });

  it("is silent on a track with one sector", () => {
    const one = { sectorCount: 1, player: player(5, [30]), leader: null, behind: null };

    expect(neighbourPicture({ ...one, ahead: car(12, [30.5]) }, "ahead")).toBeNull();
  });
});

// ─── The selection ───────────────────────────────────────────────────────────

describe("the selection (decision 7)", () => {
  const everyoneDue = input({ leader: LEADER_MOST, ahead: AHEAD_SLOW_S2, behind: BEHIND_QUICK_S3 });
  const only =
    (...targets: SectorTarget[]) =>
    (t: SectorTarget) =>
      targets.includes(t);

  it("serves ahead, then behind, then the leader", () => {
    expect(selectSectorCall(everyoneDue, 5, ALL, EMPTY_MEMORY)?.target).toBe("ahead");
    expect(selectSectorCall(everyoneDue, 5, only("behind", "leader"), EMPTY_MEMORY)?.target).toBe("behind");
    expect(selectSectorCall(everyoneDue, 5, only("leader"), EMPTY_MEMORY)?.target).toBe("leader");
    expect(selectSectorCall(everyoneDue, 5, only(), EMPTY_MEMORY)).toBeNull();
  });

  it("skips the leader when it is the car ahead — even when the car ahead has nothing to say", () => {
    const leaderAhead = input({ leader: LEADER_MOST, ahead: { ...LEADER_MOST, gapSeconds: 1 } });

    expect(selectSectorCall(leaderAhead, 5, ALL, EMPTY_MEMORY)).toBeNull();
    // The positive control: another car leads.
    expect(selectSectorCall({ ...leaderAhead, ahead: car(12, P) }, 5, ALL, EMPTY_MEMORY)?.target).toBe("leader");
  });

  it("skips the leader when the player leads the class (no leader)", () => {
    expect(selectSectorCall(input({ leader: null }), 5, ALL, EMPTY_MEMORY)).toBeNull();
  });

  it("keeps two laps between calls, whichever target", () => {
    expect(SECTOR_CALL_MIN_LAPS).toBe(2);
    const afterLeader = memory({}, 5);

    expect(selectSectorCall(everyoneDue, 6, ALL, afterLeader)).toBeNull();
    expect(selectSectorCall(everyoneDue, 7, ALL, afterLeader)?.target).toBe("ahead");
  });

  it("with the spacing removed, the next lap's due target speaks (the positive control)", () => {
    expect(selectSectorCall(everyoneDue, 6, ALL, memory({}, 5), 0)?.target).toBe("ahead");
  });

  it("an unchanged picture is silent; the next due target speaks instead", () => {
    const spokenAhead = neighbourPicture(everyoneDue, "ahead") as SectorPicture;
    const m = memory({ ahead: { picture: spokenAhead, lap: 3 } }, 3);

    expect(selectSectorCall(everyoneDue, 5, ALL, m)?.target).toBe("behind");
  });

  it("a new neighbour with the same sector is due", () => {
    const spokenAhead = neighbourPicture(everyoneDue, "ahead") as SectorPicture;
    const m = memory({ ahead: { picture: { ...spokenAhead, carIdx: 99 }, lap: 3 } }, 3);

    expect(selectSectorCall(everyoneDue, 5, ALL, m)?.target).toBe("ahead");
  });

  it("an empty selection when nothing is due", () => {
    const pictures = {
      ahead: { picture: neighbourPicture(everyoneDue, "ahead") as SectorPicture, lap: 1 },
      behind: { picture: neighbourPicture(everyoneDue, "behind") as SectorPicture, lap: 1 },
      leader: { picture: leaderPicture(everyoneDue) as SectorPicture, lap: 3 },
    };

    expect(selectSectorCall(everyoneDue, 5, ALL, memory(pictures, 3))).toBeNull();
  });

  it("is silent on a track with one sector", () => {
    const one: SectorComparisonInput = {
      sectorCount: 1,
      player: player(5, [30]),
      leader: car(20, [29]),
      ahead: car(12, [31]),
      behind: car(7, [29]),
    };

    expect(selectSectorCall(one, 5, ALL, EMPTY_MEMORY)).toBeNull();
  });
});

describe("when a picture is due again (decision 7)", () => {
  const leader = leaderPicture(input({ leader: LEADER_MOST })) as SectorPicture;
  const ahead = neighbourPicture(input({ ahead: AHEAD_SLOW_S2 }), "ahead") as SectorPicture;

  it("never spoken, or a different picture: due", () => {
    expect(pictureDue(leader, 5, undefined)).toBe(true);
    expect(pictureDue(leader, 5, { picture: { ...leader, lossSector: 1 }, lap: 4 })).toBe(true);
    expect(pictureDue(leader, 5, { picture: { ...leader, shape: "quicker" }, lap: 4 })).toBe(true);
  });

  it("the leader repeats after PACE_REPEAT_LAPS laps with the picture unchanged, not a lap before", () => {
    expect(PACE_REPEAT_LAPS).toBe(8);
    expect(pictureDue(leader, 12, { picture: leader, lap: 5 })).toBe(false);
    expect(pictureDue(leader, 13, { picture: leader, lap: 5 })).toBe(true);
  });

  it("the leader is due once its pace has drifted PACE_DRIFT_S, not under it", () => {
    expect(PACE_DRIFT_S).toBe(0.3);
    expect(pictureDue({ ...leader, pace: 0.8 }, 6, { picture: leader, lap: 5 })).toBe(true);
    expect(pictureDue({ ...leader, pace: 0.79 }, 6, { picture: leader, lap: 5 })).toBe(false);
    expect(pictureDue({ ...leader, pace: 0.2 }, 6, { picture: leader, lap: 5 })).toBe(true);
  });

  it("a neighbour never repeats an unchanged picture, however long ago it was said", () => {
    expect(pictureDue(ahead, 40, { picture: ahead, lap: 5 })).toBe(false);
    expect(pictureDue({ ...ahead, gainSector: 3 }, 6, { picture: ahead, lap: 5 })).toBe(true);
  });
});

// ─── Through the engine ─────────────────────────────────────────────────────

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
};

function createMockBus(): IEventBus & { publishEvent: (name: SimEventName, data: object) => void } {
  const handlers = new Map<SimEventName, Set<(e: SimEventOf<SimEventName>) => void>>();

  return {
    subscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      let set = handlers.get(name);

      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }

      set.add(handler as (e: SimEventOf<SimEventName>) => void);

      return () => handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
    },
    unsubscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
    },
    publish: (event: SimEventOf<SimEventName>) => {
      for (const handler of Array.from(handlers.get(event.event as SimEventName) ?? [])) handler(event);
    },
    publishEvent(name: SimEventName, data: object) {
      this.publish({
        event: name,
        timestamp: Date.now(),
        telemetry: null as unknown,
        data: data as never,
      } as SimEventOf<SimEventName>);
    },
  };
}

/** The Default voice's entries as the spec's decision 9 draws them (the bundled ones wait for the clips). */
const LEADER_ENTRY: CalloutScriptEntry = {
  comment: "Pace check against the class leader.",
  test: "Harness → Sectors → Leader pace, most of it with a gain.",
  sequence: [
    {
      case: "sectorComparison.paceShape",
      of: {
        slower: [
          "pool:sector-comparison/leader-slower",
          "{{sectorComparison.paceSeconds}}",
          "{{sectorComparison.paceDecimal}}",
          {
            case: "sectorComparison.lossShape",
            of: {
              most: ["pool:sector-comparison/loss-most", "{{sectorComparison.lossSector}}"],
              largest: ["pool:sector-comparison/loss-largest", "{{sectorComparison.lossSector}}"],
              every: ["pool:sector-comparison/loss-every"],
            },
          },
          { optional: ["pool:sector-comparison/gain", "{{sectorComparison.gainSector}}"] },
        ],
        quicker: [
          "pool:sector-comparison/leader-quicker",
          "{{sectorComparison.paceSeconds}}",
          "{{sectorComparison.paceDecimal}}",
          { optional: ["pool:sector-comparison/leader-gain", "{{sectorComparison.lossSector}}"] },
        ],
      },
    },
  ],
};

const AHEAD_ENTRY: CalloutScriptEntry = {
  comment: "The car ahead is slower in one sector.",
  test: "Harness → Sectors → Chance on the car ahead.",
  sequence: [
    "{{sectorComparison.carNumber}}",
    "pool:sector-comparison/ahead-slower",
    "{{sectorComparison.gainSector}}",
    "pool:sector-comparison/chance",
  ],
};

const BEHIND_ENTRY: CalloutScriptEntry = {
  comment: "The car behind is quicker in one sector.",
  test: "Harness → Sectors → Car behind quicker.",
  sequence: [
    "{{sectorComparison.carNumber}}",
    "pool:sector-comparison/behind-quicker",
    "{{sectorComparison.lossSector}}",
  ],
};

const SCRIPT = defaultScript as CalloutScript;

/** The bundled frames, the three lap-time lines the sector call follows, and the three sector entries. */
function testScript(sectorEntries: Partial<Record<SectorTarget, CalloutScriptEntry>>): CalloutScript {
  const scenarios: Record<string, CalloutScriptEntry> = {
    "pit-crew.fastest-lap-race": SCRIPT.scenarios["pit-crew.fastest-lap-race"],
    "pit-crew.lap-time-best": SCRIPT.scenarios["pit-crew.lap-time-best"],
    "pit-crew.lap-time-last": SCRIPT.scenarios["pit-crew.lap-time-last"],
    "test.holder": { comment: "Holds the bus.", test: "None.", sequence: ["pool:test/holder"] },
  };

  for (const [target, entry] of Object.entries(sectorEntries)) {
    scenarios[SECTOR_COMPARISON_CONTRACT_IDS[target as SectorTarget]] = entry;
  }

  return { ...SCRIPT, scenarios, fragments: {} };
}

const ALL_ENTRIES = { leader: LEADER_ENTRY, ahead: AHEAD_ENTRY, behind: BEHIND_ENTRY };

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...SECTOR_COMPARISON_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
    // The sector clips stop at ten, as #1573's group does.
    ...Array.from({ length: 10 }, (_, n) => `voice/${VOICE}/sector-comparison-sector/${n + 1}.mp3`),
    ...["3", "7", "12", "20"].map((n) => `voice/${VOICE}/car-number/${n}.mp3`),
    ...Array.from({ length: 60 }, (_, s) => `voice/${VOICE}/lap-time-second/${s}.mp3`),
    ...Array.from({ length: 10 }, (_, d) => `voice/${VOICE}/lap-time-decimal/${d}.mp3`),
    // The three lap lines: 1:23.400 read every way they read it.
    `voice/${VOICE}/fastest-lap/yours-01.mp3`,
    `voice/${VOICE}/lap-time-clock/1m23.mp3`,
    `voice/${VOICE}/lap-time-tenths/4.mp3`,
    `voice/${VOICE}/lap-time-intro/best-lap-yet.mp3`,
    `voice/${VOICE}/lap-time-minute/1.mp3`,
    `voice/${VOICE}/lap-time-last/intro-01.mp3`,
    `voice/${VOICE}/lap-time-thousandths/400.mp3`,
    `voice/${VOICE}/test/holder-01.mp3`,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let comparison: SectorComparisonInput | null;
let session: SessionClass | null;
let underCaution: boolean;
let raceFinished: boolean;
let latestLap: LapCompletedSnapshot | null;
let enabled: Record<string, boolean>;
/** How many times the catalog has read the comparison. */
let comparisonReads: number;

/** The deps `registerPitCrew` hands the family, for a test that builds the contracts again. */
function familyDeps(isSelectable: SectorComparisonDeps["isSelectable"]): SectorComparisonDeps {
  return {
    getSectorComparison: () => comparison,
    getSessionClass: () => session,
    getUnderFullCourseCaution: () => underCaution,
    getRaceFinishedFired: () => raceFinished,
    getLapCompletedSnapshot: () => latestLap,
    isSelectable,
  };
}

function lapPayload(lap: number, overrides: Partial<CountedLapCompleted> = {}): LapCompletedSnapshot {
  return { lap, lapTime: 83.4, isBest: false, isFirstValid: false, sessionType: "race", ...overrides };
}

function flush(iterations = 60): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
    vi.advanceTimersByTime(1000);
  }
}

/** The voice clips played, as `<group>/<base>` with a take suffix dropped. */
function line(): string[] {
  return audio._played
    .filter((p) => p.channel === AudioChannel.Voice)
    .map((p) =>
      p.path
        .split(`voice/${VOICE}/`)[1]
        .replace(/\.mp3$/, "")
        .replace(/-01$/, ""),
    );
}

/** Only the sector-comparison call's own clips (its group, the car numbers and the sectors), in order. */
function sectorLine(): string[] {
  return line().filter((c) => /^(sector-comparison|car-number|sector-comparison-sector)\//.test(c));
}

/** The player's lap `lap` completes with the comparison as given; the lap is published and played out. */
function lapDone(lap: number, c: Partial<SectorComparisonInput> = {}, payload: Partial<CountedLapCompleted> = {}) {
  comparison = input({ player: player(lap), ...c });
  latestLap = lapPayload(lap, payload);
  bus.publishEvent("lap.completed", latestLap);
  flush();
}

function setScript(entries: Partial<Record<SectorTarget, CalloutScriptEntry>> = ALL_ENTRIES): void {
  getScenarioEngine().setScripts(new Map([[VOICE, testScript(entries)]]));
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSectorComparison();
  comparison = null;
  session = classifySession("Race");
  underCaution = false;
  raceFinished = false;
  latestLap = null;
  // The every-lap call is off unless a test puts it on, so a lap's line is the sector call alone.
  enabled = { calloutEnabledLapTimeEveryLap: false };
  comparisonReads = 0;
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  registerPitCrew(bus, {
    logger: mockLogger as never,
    getSessionClass: () => session,
    isCalloutEnabled: (key) => enabled[key] ?? true,
    getUnderFullCourseCaution: () => underCaution,
    getRaceFinishedFired: () => raceFinished,
    getLapCompletedSnapshot: () => latestLap,
    getSectorComparison: () => {
      comparisonReads++;

      return comparison;
    },
  });
  getScenarioEngine().defineContract({
    id: "test.holder",
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.TRANSIENT,
    family: "test-holder",
  });
  setScript();
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _resetPitSpeedingEngine();
  _resetPitExitCueEngine();
  _resetLimiterCueEngine();
  resetSectorComparison();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("the lines (decision 9, the Default shape)", () => {
  it("leader, slower: the pace, most of it in sector two, quicker in sector three", () => {
    lapDone(5, { leader: LEADER_MOST });

    expect(line()).toEqual([
      "sector-comparison/leader-slower",
      "lap-time-second/0",
      "lap-time-decimal/5",
      "sector-comparison/loss-most",
      "sector-comparison-sector/2",
      "sector-comparison/gain",
      "sector-comparison-sector/3",
    ]);
  });

  it("leader, slower: the largest share, on a four-sector track", () => {
    lapDone(5, {
      sectorCount: 4,
      player: player(5, [30, 40, 50, 20]),
      leader: car(20, [29.75, 39.75, 49.625, 20.25], { gap: null }),
    });

    expect(line()).toEqual([
      "sector-comparison/leader-slower",
      "lap-time-second/0",
      "lap-time-decimal/6",
      "sector-comparison/loss-largest",
      "sector-comparison-sector/3",
      "sector-comparison/gain",
      "sector-comparison-sector/4",
    ]);
  });

  it("leader, slower in every sector: no sector named and no gain clause", () => {
    lapDone(5, { leader: LEADER_EVERY });

    expect(line()).toEqual([
      "sector-comparison/leader-slower",
      "lap-time-second/0",
      "lap-time-decimal/6",
      "sector-comparison/loss-every",
    ]);
  });

  it("leader, quicker: the pace and the sector where the leader is quicker", () => {
    lapDone(5, { leader: LEADER_SLOWER_THAN_US });

    expect(line()).toEqual([
      "sector-comparison/leader-quicker",
      "lap-time-second/0",
      "lap-time-decimal/6",
      "sector-comparison/leader-gain",
      "sector-comparison-sector/2",
    ]);
  });

  it("ahead: the car, the sector it is slower in, and the chance", () => {
    lapDone(5, { ahead: AHEAD_SLOW_S2 });

    expect(line()).toEqual([
      "car-number/12",
      "sector-comparison/ahead-slower",
      "sector-comparison-sector/2",
      "sector-comparison/chance",
    ]);
  });

  it("behind: the car and the sector it is quicker in", () => {
    lapDone(5, { behind: BEHIND_QUICK_S3 });

    expect(line()).toEqual(["car-number/7", "sector-comparison/behind-quicker", "sector-comparison-sector/3"]);
  });

  it("skips the whole call for a sector with no clip (sector eleven), and speaks sector ten (the positive control)", () => {
    const eleven = Array.from({ length: 11 }, () => 20);
    const slowAt = (k: number) => eleven.map((t, i) => (i === k ? t + 0.25 : t));

    lapDone(5, {
      sectorCount: 11,
      player: player(5, eleven),
      ahead: car(12, slowAt(10), { carNumber: "12" }),
    });
    expect(line()).toEqual([]);

    lapDone(7, {
      sectorCount: 11,
      player: player(7, eleven),
      ahead: car(12, slowAt(9), { carNumber: "12", lastLap: 7 }),
    });
    expect(line()).toEqual([
      "car-number/12",
      "sector-comparison/ahead-slower",
      "sector-comparison-sector/10",
      "sector-comparison/chance",
    ]);
  });

  it("skips the call about a car with no number", () => {
    lapDone(5, { ahead: { ...AHEAD_SLOW_S2, carNumber: null } });

    expect(line()).toEqual([]);
  });
});

describe("the gates at the line (decision 7)", () => {
  it("speaks in a race and not in practice or qualifying", () => {
    session = classifySession("Practice");
    lapDone(5, { ahead: AHEAD_SLOW_S2 });
    session = classifySession("Lone Qualify");
    lapDone(5, { ahead: AHEAD_SLOW_S2 });
    expect(line()).toEqual([]);

    session = classifySession("Race");
    lapDone(5, { ahead: AHEAD_SLOW_S2 });
    expect(sectorLine()).toContain("sector-comparison/ahead-slower");
  });

  it("is silent on a lap that carried a caution, and speaks the same lap under green", () => {
    lapDone(5, { ahead: AHEAD_SLOW_S2 }, { wasCaution: true });
    expect(line()).toEqual([]);

    lapDone(5, { ahead: AHEAD_SLOW_S2 });
    expect(sectorLine()).toContain("sector-comparison/ahead-slower");
  });

  it("is silent with a caution out at the line, and nothing is selected or stashed for it", () => {
    underCaution = true;
    lapDone(5, { ahead: AHEAD_SLOW_S2 });

    expect(line()).toEqual([]);
    expect(readSectorComparisonDebugState().pendingSelections).toBe(0);
  });

  it("is silent once the race has finished for the player", () => {
    raceFinished = true;
    lapDone(5, { ahead: AHEAD_SLOW_S2 });

    expect(line()).toEqual([]);
  });

  it("is silent on a lap the sim did not count", () => {
    comparison = input({ ahead: AHEAD_SLOW_S2 });
    latestLap = { lap: 5, isBest: false, isFirstValid: false, lapIsValid: false, sessionType: "race" };
    bus.publishEvent("lap.completed", latestLap);
    flush();

    expect(line()).toEqual([]);
  });

  it("builds the comparison once per lap for the three contracts, and keeps one answer for all three", () => {
    lapDone(5, { leader: LEADER_MOST, ahead: AHEAD_SLOW_S2, behind: BEHIND_QUICK_S3 });

    // One build decides for all three contracts; the one call that speaks
    // reads it once more at its gate, to check the named car is still there.
    expect(comparisonReads).toBe(2);
    expect(readSectorComparisonDebugState().pendingSelections).toBe(1);
    expect(sectorLine()[0]).toBe("car-number/12");
  });

  it("keeps a refused lap's answer too, so the other two contracts read it without building the comparison again", () => {
    comparison = input({ player: player(5, P, false), ahead: AHEAD_SLOW_S2 });
    latestLap = lapPayload(5);
    bus.publishEvent("lap.completed", latestLap);
    flush();

    expect(comparisonReads).toBe(1);
    expect(readSectorComparisonDebugState().pendingSelections).toBe(1);
    expect(line()).toEqual([]);
  });

  it("speaks nothing about a retired class leader, and the leader call stays silent after it", () => {
    lapDone(5, { leader: { ...LEADER_MOST, lapsCompleted: null } });
    expect(line()).toEqual([]);

    // The positive control: the leader still running is called.
    lapDone(5, { leader: LEADER_MOST });
    expect(sectorLine()[0]).toBe("sector-comparison/leader-slower");
  });

  it("is silent when the player's own lap was not recorded clean, and speaks when it was", () => {
    comparison = input({ player: player(5, P, false), ahead: AHEAD_SLOW_S2 });
    latestLap = lapPayload(5);
    bus.publishEvent("lap.completed", latestLap);
    flush();
    expect(line()).toEqual([]);

    lapDone(5, { ahead: AHEAD_SLOW_S2 });
    expect(sectorLine()).toContain("sector-comparison/ahead-slower");
  });

  it("is silent with no comparison at all (outside a race, no sectors)", () => {
    latestLap = lapPayload(5);
    bus.publishEvent("lap.completed", latestLap);
    flush();

    expect(line()).toEqual([]);
  });

  it("each opt-in silences only its own target, and the next one due speaks", () => {
    enabled.calloutEnabledSectorComparisonAhead = false;
    lapDone(5, { leader: LEADER_MOST, ahead: AHEAD_SLOW_S2, behind: BEHIND_QUICK_S3 });

    expect(sectorLine()).toEqual(["car-number/7", "sector-comparison/behind-quicker", "sector-comparison-sector/3"]);
  });
});

describe("the cadence (decision 7)", () => {
  const all = { leader: LEADER_MOST, ahead: AHEAD_SLOW_S2, behind: BEHIND_QUICK_S3 };

  it("serves ahead, behind and the leader on every other lap, in that order", () => {
    lapDone(5, all);
    expect(sectorLine()).toEqual([
      "car-number/12",
      "sector-comparison/ahead-slower",
      "sector-comparison-sector/2",
      "sector-comparison/chance",
    ]);

    audio._played.length = 0;
    lapDone(6, all);
    expect(sectorLine()).toEqual([]);

    lapDone(7, all);
    expect(sectorLine()).toEqual(["car-number/7", "sector-comparison/behind-quicker", "sector-comparison-sector/3"]);

    audio._played.length = 0;
    lapDone(8, all);
    lapDone(9, all);
    expect(sectorLine()[0]).toBe("sector-comparison/leader-slower");

    // Everything said and nothing changed: silence.
    audio._played.length = 0;
    lapDone(11, all);
    lapDone(13, all);
    expect(sectorLine()).toEqual([]);
  });

  it("a new car ahead is news on the next lap the spacing allows", () => {
    lapDone(5, { ahead: AHEAD_SLOW_S2 });
    audio._played.length = 0;

    lapDone(7, { ahead: { ...AHEAD_SLOW_S2, carIdx: 14, carNumber: "20" } });

    expect(sectorLine()).toEqual([
      "car-number/20",
      "sector-comparison/ahead-slower",
      "sector-comparison-sector/2",
      "sector-comparison/chance",
    ]);
  });

  it("repeats the leader's unchanged picture eight laps on", () => {
    lapDone(5, { leader: LEADER_MOST });
    audio._played.length = 0;

    lapDone(12, { leader: LEADER_MOST });
    expect(sectorLine()).toEqual([]);

    lapDone(13, { leader: LEADER_MOST });
    expect(sectorLine()[0]).toBe("sector-comparison/leader-slower");
  });

  it("a voice that scripts only the behind call hears it on the lap it is due, while the other two would be due", () => {
    setScript({ behind: BEHIND_ENTRY });
    lapDone(5, all);

    expect(sectorLine()).toEqual(["car-number/7", "sector-comparison/behind-quicker", "sector-comparison-sector/3"]);
    expect(Object.keys(readSectorComparisonDebugState().spokenPictures)).toEqual(["behind"]);
  });

  it("forgets everything on a session change, so a new race's laps speak from the start", () => {
    lapDone(30, { ahead: AHEAD_SLOW_S2 });
    expect(readSectorComparisonDebugState().lastCallLap).toBe(30);

    bus.publishEvent("session.changed", { from: 1, to: 2 });
    expect(readSectorComparisonDebugState()).toEqual({
      spokenPictures: {},
      lastCallLap: null,
      pendingSelections: 0,
    });

    audio._played.length = 0;
    lapDone(5, { ahead: AHEAD_SLOW_S2 });
    expect(sectorLine()).toContain("sector-comparison/ahead-slower");
  });
});

describe("the claim is the gate's (#1137, #1138)", () => {
  /** Hold the bus with a light line, so the lap's sector call waits behind it. */
  function holdTheBus(): void {
    getScenarioEngine().fire("test.holder");
  }

  function publishLap(lap: number, c: Partial<SectorComparisonInput>): void {
    comparison = input({ player: player(lap), ...c });
    latestLap = lapPayload(lap);
    bus.publishEvent("lap.completed", latestLap);
    vi.advanceTimersByTime(SECTOR_COMPARISON_TRIGGER_DELAY_MS + 10);
  }

  it("records the picture and the lap only when the call speaks", () => {
    lapDone(5, { ahead: AHEAD_SLOW_S2 });

    const state = readSectorComparisonDebugState();

    expect(state.lastCallLap).toBe(5);
    expect(state.spokenPictures.ahead).toMatchObject({ lap: 5, picture: { carIdx: 12, gainSector: 2 } });
  });

  it("selects in where: without claiming — a call waiting for the radio has recorded nothing yet", () => {
    holdTheBus();
    publishLap(5, { ahead: AHEAD_SLOW_S2 });

    expect(readSectorComparisonDebugState()).toMatchObject({ lastCallLap: null, pendingSelections: 1 });
    expect(readSectorComparisonDebugState().spokenPictures).toEqual({});

    flush();
    expect(sectorLine()).toContain("sector-comparison/ahead-slower");
    expect(readSectorComparisonDebugState().lastCallLap).toBe(5);
  });

  it("a caution out while it waits refuses it at the gate, leaving the target due, and the next lap speaks it", () => {
    holdTheBus();
    publishLap(5, { ahead: AHEAD_SLOW_S2 });
    underCaution = true;
    flush();

    expect(sectorLine()).toEqual([]);
    expect(readSectorComparisonDebugState()).toMatchObject({ lastCallLap: null });
    expect(readSectorComparisonDebugState().spokenPictures).toEqual({});

    underCaution = false;
    lapDone(6, { ahead: AHEAD_SLOW_S2 });
    expect(sectorLine()).toContain("sector-comparison/ahead-slower");
  });

  it("a call still waiting when the next lap completes is dropped, and recorded as nothing", () => {
    holdTheBus();
    publishLap(5, { ahead: AHEAD_SLOW_S2 });
    latestLap = lapPayload(6);
    flush();

    expect(sectorLine()).toEqual([]);
    expect(readSectorComparisonDebugState().lastCallLap).toBeNull();
  });

  it("a passed car is not named: the car ahead changed while the call waited refuses it, leaving the target due", () => {
    holdTheBus();
    publishLap(5, { ahead: AHEAD_SLOW_S2 });
    comparison = input({ player: player(5), ahead: { ...AHEAD_SLOW_S2, carIdx: 31, carNumber: "31" } });
    flush();

    expect(sectorLine()).toEqual([]);
    expect(readSectorComparisonDebugState().lastCallLap).toBeNull();
    expect(readSectorComparisonDebugState().spokenPictures).toEqual({});
  });

  it("the named car out of range by the time it speaks refuses it too", () => {
    holdTheBus();
    publishLap(5, { ahead: AHEAD_SLOW_S2 });
    comparison = input({ player: player(5), ahead: { ...AHEAD_SLOW_S2, gapSeconds: SECTOR_BATTLE_GAP_S + 1 } });
    flush();

    expect(sectorLine()).toEqual([]);
    expect(readSectorComparisonDebugState().lastCallLap).toBeNull();
  });

  it("a waiting call speaks when nothing changed (the positive control)", () => {
    holdTheBus();
    publishLap(5, { ahead: AHEAD_SLOW_S2 });
    flush();

    expect(line()[0]).toBe("test/holder");
    expect(sectorLine()).toContain("sector-comparison/ahead-slower");
  });

  it("the gate admits one call per lap: a second admission for the same lap is turned away", () => {
    const [, ahead] = buildSectorComparison(familyDeps(() => true)).contracts;

    comparison = input({ ahead: AHEAD_SLOW_S2 });
    latestLap = lapPayload(5);

    const envelope = {
      event: "lap.completed",
      timestamp: 0,
      telemetry: null,
      data: latestLap,
    } as unknown as SimEventOf<SimEventName>;
    const ctx = { event: envelope, now: 0 } as never;

    expect(ahead.when?.where?.(envelope)).toBe(true);
    expect(ahead.speakGate?.admit(ctx)).toBe(true);
    expect(ahead.speakGate?.admit(ctx)).toBe(false);
    // An imperative fire carries no lap and was never selected.
    expect(ahead.speakGate?.admit({ event: null, now: 0 } as never)).toBe(false);
  });
});

describe("at the line, after the lap-time calls (decision 8)", () => {
  const FASTEST_LAP_YOURS: FastestLapData = {
    carIdx: 0,
    isPlayer: true,
    lap: 5,
    lapTime: 83.4,
    carNumber: "1",
    position: 2,
    playerPosition: 2,
    playerLapsCompleted: 5,
  };

  /** The tick of a lap that set the fastest lap of the race: `lap.completed`, then its `fastestLap.set`. */
  function fastestLapTick(): void {
    comparison = input({ ahead: AHEAD_SLOW_S2 });
    latestLap = lapPayload(5, { isBest: true, isClassFastestLapOfRace: true });
    bus.publishEvent("lap.completed", latestLap);
    bus.publishEvent("fastestLap.set", FASTEST_LAP_YOURS);
  }

  it("on an idle bus, the fastest-lap line is heard first and the sector call after it", () => {
    fastestLapTick();
    flush();

    const played = line();

    expect(played.slice(0, 3)).toEqual(["fastest-lap/yours", "lap-time-clock/1m23", "lap-time-tenths/4"]);
    expect(played.slice(3)).toEqual([
      "car-number/12",
      "sector-comparison/ahead-slower",
      "sector-comparison-sector/2",
      "sector-comparison/chance",
    ]);
  });

  it("with the delay removed by hand, the sector call takes the idle bus first (the positive control)", () => {
    const engine = getScenarioEngine();

    for (const c of buildSectorComparison(familyDeps((t) => engine.isScripted(SECTOR_COMPARISON_CONTRACT_IDS[t])))
      .contracts) {
      engine.defineContract({ ...c, triggerDelay: 0 });
    }

    setScript();
    fastestLapTick();
    flush();

    expect(line()[0]).toBe("car-number/12");
    expect(line()).toContain("fastest-lap/yours");
    expect(line().indexOf("fastest-lap/yours")).toBeGreaterThan(line().indexOf("sector-comparison/chance"));
  });

  it("uses the delay and the order the spec sets", () => {
    expect(SECTOR_COMPARISON_TRIGGER_DELAY_MS).toBe(500);
  });

  describe("on a held bus, queueBehind keeps it behind each lap line", () => {
    /** Hold the bus, run the lap, and return what waits once the sector call has queued. */
    function heldLap(publish: () => void) {
      getScenarioEngine().fire("test.holder");
      publish();
      vi.advanceTimersByTime(SECTOR_COMPARISON_TRIGGER_DELAY_MS + 10);

      const state = getScenarioEngine().describeState();
      const voice = state.buses.find((b) => b.bus === "Voice");

      return voice?.waiting.map((w) => ({ id: w.id, after: w.after })) ?? [];
    }

    it("the fastest lap of the race", () => {
      const waiting = heldLap(fastestLapTick);

      expect(waiting).toEqual([
        { id: "pit-crew.fastest-lap-race", after: null },
        { id: "pit-crew.sector-comparison-ahead", after: "pit-crew.fastest-lap-race" },
      ]);
      flush();
      expect(line().indexOf("fastest-lap/yours")).toBeLessThan(line().indexOf("car-number/12"));
    });

    it("the best lap", () => {
      const waiting = heldLap(() => {
        comparison = input({ ahead: AHEAD_SLOW_S2 });
        latestLap = lapPayload(5, { isBest: true });
        bus.publishEvent("lap.completed", latestLap);
      });

      expect(waiting).toEqual([
        { id: "pit-crew.lap-time-best", after: null },
        { id: "pit-crew.sector-comparison-ahead", after: "pit-crew.lap-time-best" },
      ]);
      flush();
      expect(line().indexOf("lap-time-intro/best-lap-yet")).toBeLessThan(line().indexOf("car-number/12"));
    });

    it("every lap", () => {
      enabled.calloutEnabledLapTimeEveryLap = true;

      const waiting = heldLap(() => {
        comparison = input({ ahead: AHEAD_SLOW_S2 });
        latestLap = lapPayload(5);
        bus.publishEvent("lap.completed", latestLap);
      });

      expect(waiting).toEqual([
        { id: "pit-crew.lap-time-last", after: null },
        { id: "pit-crew.sector-comparison-ahead", after: "pit-crew.lap-time-last" },
      ]);
      flush();
      expect(line().indexOf("lap-time-last/intro")).toBeLessThan(line().indexOf("car-number/12"));
    });
  });
});

describe("stillTheNamedCar", () => {
  const picture = (target: "leader" | "ahead" | "behind", carIdx: number) =>
    ({
      target,
      carIdx,
      carNumber: null,
      shape: null,
      pace: null,
      lossShape: null,
      lossSector: null,
      gainSector: 2,
    }) as const;

  it("holds for the same car on its side, the leader at any distance", () => {
    expect(stillTheNamedCar(picture("ahead", 12), input({ ahead: AHEAD_SLOW_S2 }))).toBe(true);
    expect(stillTheNamedCar(picture("leader", 20), input({ leader: { ...LEADER_MOST, gapSeconds: 40 } }))).toBe(true);
  });

  it("fails for another car on that side, a neighbour out of range, no car there, or no comparison", () => {
    expect(stillTheNamedCar(picture("ahead", 12), input({ ahead: { ...AHEAD_SLOW_S2, carIdx: 31 } }))).toBe(false);
    expect(stillTheNamedCar(picture("ahead", 12), input({ ahead: { ...AHEAD_SLOW_S2, gapSeconds: 3.5 } }))).toBe(false);
    expect(stillTheNamedCar(picture("ahead", 12), input({ ahead: null }))).toBe(false);
    expect(stillTheNamedCar(picture("leader", 20), input({ leader: { ...LEADER_MOST, carIdx: 21 } }))).toBe(false);
    // A leader retired while the call waited: still first in the frozen order, no lap count.
    expect(stillTheNamedCar(picture("leader", 20), input({ leader: { ...LEADER_MOST, lapsCompleted: null } }))).toBe(
      false,
    );
    expect(stillTheNamedCar(picture("ahead", 12), null)).toBe(false);
  });
});

describe("the contracts", () => {
  const built = buildSectorComparison(familyDeps(() => true));

  it("carry the scheduling decision 8 sets, each its own target's id", () => {
    expect(built.contracts.map((c) => c.id)).toEqual([...SECTOR_COMPARISON_SCENARIO_IDS]);

    for (const c of built.contracts) {
      expect("sequence" in c).toBe(false);
      expect(c.when?.event).toBe("lap.completed");
      expect(c.weight).toBe(WEIGHT.CHATTER);
      expect(c.interrupt).toBe(false);
      expect(c.queueable).toBe(true);
      expect(c.dropWhenCut).toBe(true);
      expect(c.maxQueueWaitMs).toBe(20_000);
      expect(c.triggerDelay).toBe(SECTOR_COMPARISON_TRIGGER_DELAY_MS);
      expect(c.family).toBe("sector-comparison");
      expect(c.supersedeGroup).toBe("sector-comparison");
      expect(c.queueBehind).toEqual(["pit-crew.fastest-lap-race", "pit-crew.lap-time-best", "pit-crew.lap-time-last"]);
      expect(c.frame).toBeUndefined();
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("voice/{voice}");
      expect(c.speakGate?.description.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("queue behind contracts the catalog registers", () => {
    const ids = new Set(
      getScenarioEngine()
        .describeState()
        .contracts.map((c) => c.id),
    );

    for (const id of built.contracts[0].queueBehind ?? []) expect(ids.has(id), id).toBe(true);
  });

  it("map their scenarios to the registry's three callouts", () => {
    expect(SCENARIO_ID_TO_SECTOR_COMPARISON_ID).toEqual({
      "pit-crew.sector-comparison-leader": "leader",
      "pit-crew.sector-comparison-ahead": "ahead",
      "pit-crew.sector-comparison-behind": "behind",
    });
    expect(Object.keys(SECTOR_COMPARISON_CALLOUTS.callouts)).toEqual(["leader", "ahead", "behind"]);
    expect(Object.values(SECTOR_COMPARISON_CALLOUTS.callouts).map((e) => e.key)).toEqual([
      "calloutEnabledSectorComparisonLeader",
      "calloutEnabledSectorComparisonAhead",
      "calloutEnabledSectorComparisonBehind",
    ]);
  });
});

describe("paceTenths", () => {
  it("rounds half up to the tenth, unsigned, through a summing artefact", () => {
    // Sector deltas of 0.2, 0.3 and 0.25 s taken as player minus target
    // times sum to 0.7499999999999964 in binary floating point.
    const pace = 30 - 29.8 + (40 - 39.7) + (25 - 24.75);

    expect(pace).toBeLessThan(0.75);
    expect(paceTenths(pace)).toEqual({ seconds: 0, tenths: 8 });
    expect(paceTenths(-0.5)).toEqual({ seconds: 0, tenths: 5 });
    expect(paceTenths(0.74)).toEqual({ seconds: 0, tenths: 7 });
    expect(paceTenths(1.96)).toEqual({ seconds: 2, tenths: 0 });
  });
});

describe("the vocabulary", () => {
  it("publishes every name decision 9 lists, each described, each var naming its clip group", () => {
    const { vars, conds, cases } = getScenarioEngine().vocabulary();
    const ours = (name: string) => name.startsWith("sectorComparison.");

    expect(vars.filter((v) => ours(v.name)).map((v) => v.name)).toEqual([
      "sectorComparison.carNumber",
      "sectorComparison.gainSector",
      "sectorComparison.lossSector",
      "sectorComparison.paceDecimal",
      "sectorComparison.paceSeconds",
    ]);

    const description = (name: string) => vars.find((v) => v.name === name)?.description ?? "";

    expect(descriptionNamesGroup(description("sectorComparison.paceSeconds"), "lap-time-second")).toBe(true);
    expect(descriptionNamesGroup(description("sectorComparison.paceDecimal"), "lap-time-decimal")).toBe(true);
    expect(descriptionNamesGroup(description("sectorComparison.lossSector"), "sector-comparison-sector")).toBe(true);
    expect(descriptionNamesGroup(description("sectorComparison.gainSector"), "sector-comparison-sector")).toBe(true);
    expect(descriptionNamesGroup(description("sectorComparison.carNumber"), "car-number")).toBe(true);
    // The positive control: a group a var does not draw from is not named.
    expect(descriptionNamesGroup(description("sectorComparison.carNumber"), "sector-comparison-sector")).toBe(false);

    expect(conds.filter((c) => ours(c.name)).map((c) => c.name)).toEqual(["sectorComparison.hasGain"]);

    const caseKeys = (name: string) => Object.keys(cases.find((c) => c.name === name)?.keys ?? {});

    expect(caseKeys("sectorComparison.paceShape")).toEqual(["slower", "quicker"]);
    expect(caseKeys("sectorComparison.lossShape")).toEqual(["most", "largest", "every"]);
    expect(Object.keys(SECTOR_PACE_SHAPE_KEYS)).toEqual(["slower", "quicker"]);
    expect(Object.keys(SECTOR_LOSS_SHAPE_KEYS)).toEqual(["most", "largest", "every"]);

    for (const entry of [...vars, ...conds, ...cases].filter((e) => ours(e.name))) {
      expect(entry.description.length, entry.name).toBeGreaterThan(0);
    }
  });

  it("resolves nothing for an imperative fire, which carries no lap", () => {
    getScenarioEngine().fire("pit-crew.sector-comparison-behind");
    flush();

    expect(line()).toEqual([]);
  });

  it("compiles the drafted entries with nothing skipped", () => {
    expect(mockLogger.warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes("sector-comparison"))).toEqual(
      [],
    );
  });

  it("lists as clip sources exactly the sector-comparison bases the drafted entries address", () => {
    const refs = (entry: CalloutScriptEntry) =>
      collectScriptReferences({ ...SCRIPT, scenarios: { id: entry }, fragments: {}, frames: {} }).pools;
    const addressed = [...new Set([LEADER_ENTRY, AHEAD_ENTRY, BEHIND_ENTRY].flatMap(refs))].sort();

    expect(SECTOR_COMPARISON_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(addressed);
  });

  it("the bundled Default entries are the drafted ones this file plays", () => {
    expect(SCRIPT.scenarios["pit-crew.sector-comparison-leader"]?.sequence).toEqual(LEADER_ENTRY.sequence);
    expect(SCRIPT.scenarios["pit-crew.sector-comparison-ahead"]?.sequence).toEqual(AHEAD_ENTRY.sequence);
    expect(SCRIPT.scenarios["pit-crew.sector-comparison-behind"]?.sequence).toEqual(BEHIND_ENTRY.sequence);

    for (const id of SECTOR_COMPARISON_SCENARIO_IDS) expect(SCRIPT.scenarios[id]?.skip, id).toBeUndefined();
  });
});
