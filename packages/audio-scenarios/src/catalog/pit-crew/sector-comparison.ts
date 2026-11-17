/**
 * Sector comparison (issue #1572): at the player's line in a race, where on
 * the lap the time goes against the class leader, and the one sector where
 * the car ahead is slower (attack) or the car behind quicker (defence).
 * Three contracts off `lap.completed`, one per target:
 *
 *   pit-crew.sector-comparison-leader  "Pace check. The leader is quicker by
 *                                      zero point five seconds. Most of it is
 *                                      in sector two. We're quicker in sector
 *                                      three."
 *   pit-crew.sector-comparison-ahead   "Car twelve ahead is slower than us in
 *                                      sector two. That's our chance."
 *   pit-crew.sector-comparison-behind  "Car seven behind is quicker than us in
 *                                      sector three."
 *
 * The translator keeps the facts — each car's last laps, their measured
 * sector times and whether each was clean (spec decisions 4 and 5) — and
 * the catalog keeps the policy, here, beside its thresholds: the reference
 * (the per-sector median of the last {@link SECTOR_REFERENCE_LAPS} clean laps
 * among the last {@link SECTOR_RECENT_LAPS}), the pace gap, the picture of
 * each target and the selection of the one target that speaks (decisions 5
 * to 7). The code decides WHETHER and about WHOM the engineer speaks; WHAT is
 * said lives in the active voice's `callouts.json` under the three ids.
 *
 * **One selection for all three.** {@link selectSectorCall} is the one pure
 * function every contract's `where:` asks, and its answer is computed once
 * per `lap.completed` envelope and kept for the other two, so the three can
 * never disagree about which target speaks. The `where:` is the pure half
 * (#1137): it stashes the selection keyed by the event envelope (#1138, the
 * qualifying-invalidation shape) for the vars and the gate to read through
 * `ctx.event`. The `speakGate` is the claim: after its refusals, LAST, it
 * records the picture as spoken for that target and the lap of the call. A
 * picture is recorded nowhere else, so a call that never plays leaves its
 * target due.
 *
 * **At the line, after the lap time** (decision 8): a
 * {@link SECTOR_COMPARISON_TRIGGER_DELAY_MS} delay lets every lap call of the
 * same tick reach the bus first, and `queueBehind` keeps the sector call
 * behind whichever of them waits.
 *
 * Module state: the spoken pictures, the lap of the last call and the
 * per-envelope selections; {@link readSectorComparisonDebugState} reads them
 * and a `session.changed` clears them (`registerPitCrew`).
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutIdOf, SECTOR_COMPARISON_CALLOUTS } from "@iracedeck/callout-settings";
import type { SessionClass, SimEventName, SimEventOf } from "@iracedeck/event-bus";

import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import { poolRef, WEIGHT } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import type { UnderCautionResolver } from "./caution.js";
import { lapStillCurrent } from "./lap-announcement.js";
import type { LapCompletedSnapshot, LapCompletedSnapshotResolver } from "./lap-time.js";
import { isRaceSession } from "./race-start.js";

// ---------------------------------------------------------------------------
// The input: the catalog's own type, which `buildPitCrewDeps` maps the
// translator's snapshot onto (decision 10).
// ---------------------------------------------------------------------------

/** One completed lap of a car, as the translator recorded it. */
export type SectorLapInput = {
  /** The car's completed-lap count once this lap was done — the same number `lap.completed` carries as `lap` for the player. The race's opening lap is 1. */
  lap: number;
  /** One per sector, in order; null where that crossing was not measured. */
  sectorTimes: readonly (number | null)[];
  /**
   * Whether the lap counts for a comparison. One rule for every car, the
   * player included, so a strictly filtered lap is never compared with a
   * leniently filtered one: the car stayed on the racing surface the whole lap
   * (never in the pit lane or its stall, never off track, always in the
   * world), no full-course caution was out on any part of it, it is not the
   * race's opening lap, and every sector was measured and is positive. The
   * family relies on each part: a pit, off-track or caution lap of the
   * player's says nothing, and the first comparison comes from lap 4.
   */
  clean: boolean;
};

/** One car of the comparison. */
export type SectorCarInput = {
  carIdx: number;
  /** The car number as the session spells it ("12", "007"), null when unknown. */
  carNumber: string | null;
  /** The live gap to the player in seconds (the gap display's reading); null for the player or when unknown. */
  gapSeconds: number | null;
  /**
   * How many laps the car has completed now, counted the way
   * {@link SectorLapInput.lap} is, whether or not its sector times were
   * measured; null when the sim reports none for the car (it is out of the
   * world: in the garage or retired).
   */
  lapsCompleted: number | null;
  /** Recorded laps, newest last (at most 8); a lap the timer could not measure is missing. */
  recentLaps: readonly SectorLapInput[];
};

/** The comparison as it stands: the track's sector count, the player and the three targets. */
export type SectorComparisonInput = {
  sectorCount: number;
  player: SectorCarInput;
  /** The class leader; null when the player leads the class or no leader is known. May be the same car as `ahead`: the selection skips the leader then. */
  leader: SectorCarInput | null;
  /** The class neighbours; null when there is none. */
  ahead: SectorCarInput | null;
  behind: SectorCarInput | null;
};

/** The comparison read live; `null` outside a race, with no sectors, or before the translator started. */
export type SectorComparisonResolver = () => SectorComparisonInput | null;

// ---------------------------------------------------------------------------
// The thresholds (decisions 5 to 8). Each is the policy's own number.
// ---------------------------------------------------------------------------

/** Clean laps a reference is the median of. */
export const SECTOR_REFERENCE_LAPS = 3;
/** The most recent completed laps a reference may draw from, clean or not. */
export const SECTOR_RECENT_LAPS = 5;
/** A sector counts as quicker or slower only from this many seconds. */
export const SECTOR_DELTA_MIN_S = 0.1;
/** The attack and defence calls name a sector only from this many seconds. */
export const SECTOR_CHANCE_MIN_S = 0.15;
/** A leader pace gap under this many seconds a lap is level: nothing is said. */
export const PACE_LEVEL_S = 0.2;
/** A leader pace gap above this many seconds a lap is not about racing: nothing is said. */
export const PACE_GAP_MAX_S = 5;
/** "Most of it" when the worst sector carries at least this share of the time lost across the losing sectors. */
export const SECTOR_MOST_SHARE = 0.5;
/** The attack and defence calls need the live gap to that neighbour at or under this many seconds. */
export const SECTOR_BATTLE_GAP_S = 3.0;
/** The leader is due again once its pace gap has moved this many seconds a lap since it was spoken. */
export const PACE_DRIFT_S = 0.3;
/** The leader is due again this many laps after it was spoken, its picture unchanged. */
export const PACE_REPEAT_LAPS = 8;
/** After a sector call on lap N, none before lap N + this. */
export const SECTOR_CALL_MIN_LAPS = 2;
/** How long after `lap.completed` the sector call is attempted, so the lap's own lines reach the bus first. */
export const SECTOR_COMPARISON_TRIGGER_DELAY_MS = 500;

/**
 * Tolerance on every threshold comparison. Sector times are sums and
 * differences of binary fractions, so a delta of exactly 0.10 s on the
 * timing screen can arrive as 0.0999999999; a threshold is met "at or
 * above" its value as a person reads it, never by a rounding artefact.
 */
const EPS = 1e-9;

// ---------------------------------------------------------------------------
// The pure policy.
// ---------------------------------------------------------------------------

/** A sector time that can be compared: finite and positive. */
function isSectorTime(t: number | null): t is number {
  return typeof t === "number" && Number.isFinite(t) && t > 0;
}

/** The median of a non-empty list. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A car's per-sector reference: for each sector, the median of the last
 * {@link SECTOR_REFERENCE_LAPS} usable laps among its last
 * {@link SECTOR_RECENT_LAPS} completed laps, or `null` when there are fewer
 * than that many (decision 5).
 *
 * The five are the car's own last five completed laps by number, counted
 * back from `lapsCompleted`, measured or not: the timer leaves out a lap it
 * could not measure, so the last five recorded laps can reach back a whole
 * stint. A car the sim reports no lap count for (`lapsCompleted` null) is
 * not running and has no reference, so no call compares with it.
 *
 * A usable lap is a clean lap with a time for every one of `sectorCount`
 * sectors. A clean lap with a sector unmeasured, or recorded against a
 * different sector count, still counts as one of the five recent laps but
 * not toward the three: a median taken per sector over different laps would
 * stop the pace gap and its split by sector being the same numbers, and the
 * translator only marks a lap clean when every crossing was measured, so the
 * case is a guard, not a policy.
 */
export function sectorReference(car: SectorCarInput, sectorCount: number): number[] | null {
  if (car.lapsCompleted === null) return null;

  const oldestOutside = car.lapsCompleted - SECTOR_RECENT_LAPS;
  const usable = car.recentLaps
    .filter((lap) => lap.lap > oldestOutside)
    .filter((lap) => lap.clean && lap.sectorTimes.length === sectorCount && lap.sectorTimes.every(isSectorTime))
    .slice(-SECTOR_REFERENCE_LAPS);

  if (usable.length < SECTOR_REFERENCE_LAPS) return null;

  return Array.from({ length: sectorCount }, (_, k) => median(usable.map((lap) => lap.sectorTimes[k] as number)));
}

/**
 * Per sector, the player's reference minus the target's: positive where the
 * player is slower. `null` when either has no reference.
 */
export function sectorDeltas(input: SectorComparisonInput, target: SectorCarInput): number[] | null {
  const player = sectorReference(input.player, input.sectorCount);
  const other = sectorReference(target, input.sectorCount);

  if (player === null || other === null) return null;

  return player.map((t, k) => t - other[k]);
}

/** The pace gap: the sum of the per-sector deltas, positive when the player is slower (decision 5). */
export function paceGapOf(deltas: readonly number[]): number {
  return deltas.reduce((sum, d) => sum + d, 0);
}

/** The three targets, in the order a lap's due targets are served (decision 7). */
export const SECTOR_TARGETS = ["ahead", "behind", "leader"] as const;

/** Whom a sector call is about. */
export type SectorTarget = (typeof SECTOR_TARGETS)[number];

/** The keys of `sectorComparison.paceShape`. */
export type SectorPaceShape = "slower" | "quicker";

/** The keys of `sectorComparison.lossShape`. */
export type SectorLossShape = "most" | "largest" | "every";

/**
 * What a sector call says about its target — the picture. Two calls with an
 * equal picture say the same thing ({@link samePicture}); `pace` and
 * `carNumber` ride along for the words and are not part of it.
 *
 * Sectors are numbered from 1. `lossSector` is where the player loses the
 * most to the target, `gainSector` where the player gains the most, each
 * only beyond its bar:
 *
 *   leader, slower   shape, lossShape + lossSector (none for every), gainSector
 *   leader, quicker  shape, lossSector (the leader's best sector), no gain
 *   ahead            gainSector (the attack sector)
 *   behind           lossSector (the defence sector)
 */
export type SectorPicture = {
  target: SectorTarget;
  carIdx: number;
  carNumber: string | null;
  /** The leader's shape; null for a neighbour. */
  shape: SectorPaceShape | null;
  /** The leader's pace gap in seconds a lap, positive when the player is slower; null for a neighbour. */
  pace: number | null;
  lossShape: SectorLossShape | null;
  lossSector: number | null;
  gainSector: number | null;
};

/** The sector (1-based) whose value `score` ranks highest at or above `min`; null when none reaches it. */
function bestSector(deltas: readonly number[], score: (d: number) => number, min: number): number | null {
  let best: number | null = null;

  deltas.forEach((d, k) => {
    if (score(d) < min - EPS) return;

    if (best === null || score(d) > score(deltas[best - 1])) best = k + 1;
  });

  return best;
}

/**
 * The leader's picture (decision 6), or `null` when nothing is said: the
 * pace level (under {@link PACE_LEVEL_S}), beyond {@link PACE_GAP_MAX_S}, a
 * track with fewer than two sectors, or no reference on either side.
 *
 * Slower: the loss is "every" sector when the track has three or more and
 * each is slower by at least {@link SECTOR_DELTA_MIN_S} (no sector named, no
 * gain); otherwise the worst losing sector, "most" when it carries at least
 * {@link SECTOR_MOST_SHARE} of the time lost across the losing sectors and
 * "largest" when not — so on a two-sector track both halves slower is always
 * "most"; and the best gaining sector when there is one. A slower pace with
 * no single sector past the bar names no sector: the line is the pace alone.
 *
 * Quicker: the sector where the leader is quicker, when there is one.
 */
export function leaderPicture(input: SectorComparisonInput): SectorPicture | null {
  const leader = input.leader;

  if (leader === null || input.sectorCount < 2) return null;

  const deltas = sectorDeltas(input, leader);

  if (deltas === null) return null;

  const pace = paceGapOf(deltas);
  const magnitude = Math.abs(pace);

  if (magnitude < PACE_LEVEL_S - EPS || magnitude > PACE_GAP_MAX_S + EPS) return null;

  const base = { target: "leader" as const, carIdx: leader.carIdx, carNumber: leader.carNumber, pace };
  const lossSector = bestSector(deltas, (d) => d, SECTOR_DELTA_MIN_S);

  if (pace < 0) {
    return { ...base, shape: "quicker", lossShape: null, lossSector, gainSector: null };
  }

  const everySector = input.sectorCount >= 3 && deltas.every((d) => d >= SECTOR_DELTA_MIN_S - EPS);

  if (everySector) {
    return { ...base, shape: "slower", lossShape: "every", lossSector: null, gainSector: null };
  }

  const gainSector = bestSector(deltas, (d) => -d, SECTOR_DELTA_MIN_S);

  if (lossSector === null) {
    return { ...base, shape: "slower", lossShape: null, lossSector: null, gainSector };
  }

  const lost = deltas.filter((d) => d >= SECTOR_DELTA_MIN_S - EPS).reduce((sum, d) => sum + d, 0);
  const share = deltas[lossSector - 1] / lost;

  return {
    ...base,
    shape: "slower",
    lossShape: share >= SECTOR_MOST_SHARE - EPS ? "most" : "largest",
    lossSector,
    gainSector,
  };
}

/** Whether a neighbour is close enough for a sector fight: a known gap at or under {@link SECTOR_BATTLE_GAP_S}. */
function inBattleRange(car: SectorCarInput): boolean {
  const gap = car.gapSeconds;

  return gap !== null && Number.isFinite(gap) && Math.abs(gap) <= SECTOR_BATTLE_GAP_S + EPS;
}

/**
 * A neighbour's picture (decision 6): for the car ahead, the sector where
 * the player is quicker by the most; for the car behind, the sector where it
 * is quicker than the player by the most — each at or above
 * {@link SECTOR_CHANCE_MIN_S}, with the neighbour within
 * {@link SECTOR_BATTLE_GAP_S}. `null` otherwise, and on a track with fewer
 * than two sectors.
 */
export function neighbourPicture(input: SectorComparisonInput, side: "ahead" | "behind"): SectorPicture | null {
  const car = input[side];

  if (car === null || input.sectorCount < 2 || !inBattleRange(car)) return null;

  const deltas = sectorDeltas(input, car);

  if (deltas === null) return null;

  const base = {
    target: side,
    carIdx: car.carIdx,
    carNumber: car.carNumber,
    shape: null,
    pace: null,
    lossShape: null,
  };

  if (side === "ahead") {
    const gainSector = bestSector(deltas, (d) => -d, SECTOR_CHANCE_MIN_S);

    return gainSector === null ? null : { ...base, lossSector: null, gainSector };
  }

  const lossSector = bestSector(deltas, (d) => d, SECTOR_CHANCE_MIN_S);

  return lossSector === null ? null : { ...base, lossSector, gainSector: null };
}

/** Whether two pictures say the same thing: the same car, shape and sectors. */
export function samePicture(a: SectorPicture, b: SectorPicture): boolean {
  return (
    a.target === b.target &&
    a.carIdx === b.carIdx &&
    a.shape === b.shape &&
    a.lossShape === b.lossShape &&
    a.lossSector === b.lossSector &&
    a.gainSector === b.gainSector
  );
}

/** A picture as spoken, and the lap of the call. */
export type SpokenSectorPicture = { picture: SectorPicture; lap: number };

/** What the selection remembers: the last picture spoken per target and the lap of the last call. */
export type SectorCallMemory = {
  spoken: ReadonlyMap<SectorTarget, SpokenSectorPicture>;
  lastCallLap: number | null;
};

/**
 * Whether a target may be selected at all: its opt-in is on AND the active
 * voice scripts its contract (decision 7), so a voice that scripts one of
 * the three never has it starved by the other two.
 */
export type SectorTargetSelectableResolver = (target: SectorTarget) => boolean;

/** Whether a sector call on `lap` falls inside the spacing after the last one. */
function insideSpacing(lap: number, lastCallLap: number | null, minLaps: number): boolean {
  return lastCallLap !== null && lap >= lastCallLap && lap - lastCallLap < minLaps;
}

/**
 * Whether a target's picture is due (decision 7): never spoken, or a
 * different picture from the one last spoken for it. The leader is also due
 * once its pace gap has moved {@link PACE_DRIFT_S} since, or
 * {@link PACE_REPEAT_LAPS} laps have passed; a neighbour never repeats an
 * unchanged picture.
 */
export function pictureDue(picture: SectorPicture, lap: number, last: SpokenSectorPicture | undefined): boolean {
  if (last === undefined || !samePicture(picture, last.picture)) return true;

  if (picture.target !== "leader") return false;

  if (lap - last.lap >= PACE_REPEAT_LAPS) return true;

  const drift = Math.abs((picture.pace ?? 0) - (last.picture.pace ?? 0));

  return drift >= PACE_DRIFT_S - EPS;
}

/**
 * The one sector call of the player's lap `lap`, or `null` (decision 7): none
 * within {@link SECTOR_CALL_MIN_LAPS} of the last call (`minLaps`, a
 * parameter only so a test can remove the spacing); otherwise the first
 * selectable target, in the order ahead, behind, leader, whose picture is
 * due. The leader is skipped when the player leads the class and when it is
 * also the car directly ahead, whose attack call owns it.
 */
export function selectSectorCall(
  input: SectorComparisonInput,
  lap: number,
  isSelectable: SectorTargetSelectableResolver,
  memory: SectorCallMemory,
  minLaps: number = SECTOR_CALL_MIN_LAPS,
): SectorPicture | null {
  if (insideSpacing(lap, memory.lastCallLap, minLaps)) return null;

  for (const target of SECTOR_TARGETS) {
    if (!isSelectable(target)) continue;

    if (target === "leader" && input.leader !== null && input.leader.carIdx === input.ahead?.carIdx) continue;

    const picture = target === "leader" ? leaderPicture(input) : neighbourPicture(input, target);

    if (picture !== null && pictureDue(picture, lap, memory.spoken.get(target))) return picture;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Module state, its reader and its reset.
// ---------------------------------------------------------------------------

/** The selection a `lap.completed` envelope produced, kept for the three `where:`s, the vars and the gate. */
type EnvelopeSelection = { lap: number; picture: SectorPicture | null };

/** The last picture spoken per target. Written only by a gate's claim. */
let spokenPictures = new Map<SectorTarget, SpokenSectorPicture>();

/** The player's lap of the last sector call. Written only by a gate's claim. */
let lastCallLap: number | null = null;

/**
 * The selection per `lap.completed` envelope (#1138: a stash the gate reads
 * is per fire). A `Map` rather than a `WeakMap` so the snapshot can count
 * it; every entry of an older lap is pruned when a newer lap's envelope is
 * first selected on, by which point a fire of that older lap would be
 * refused at its gate anyway, so it holds one lap's envelopes at a time.
 */
let selections = new Map<SimEventOf<SimEventName>, EnvelopeSelection>();

/**
 * What the family remembers, for the Telemetry Snapshot (#1387): the picture
 * last spoken per target, the lap of the last call and how many envelopes'
 * selections are held. A pure read; the pictures are copied into a plain
 * object so the section stays JSON as it is.
 */
export function readSectorComparisonDebugState(): {
  spokenPictures: Partial<Record<SectorTarget, SpokenSectorPicture>>;
  lastCallLap: number | null;
  pendingSelections: number;
} {
  return { spokenPictures: Object.fromEntries(spokenPictures), lastCallLap, pendingSelections: selections.size };
}

/**
 * Forget everything: the spoken pictures, the last call's lap and every
 * stashed selection. `registerPitCrew` calls it on `session.changed`, since
 * a new session's laps count from one again and its cars are other cars;
 * tests call it between cases.
 */
export function resetSectorComparison(): void {
  spokenPictures = new Map();
  lastCallLap = null;
  selections = new Map();
}

/** The stashed selection of the fire being expanded, or `null` (an imperative fire, an unknown envelope). */
function stashedPicture(ctx: ScenarioContext): SectorPicture | null {
  return ctx.event === null ? null : (selections.get(ctx.event)?.picture ?? null);
}

// ---------------------------------------------------------------------------
// The contracts and the vocabulary.
// ---------------------------------------------------------------------------

/** What the family reads besides its event. */
export type SectorComparisonDeps = {
  getSectorComparison: SectorComparisonResolver;
  getSessionClass: () => SessionClass | null;
  getUnderFullCourseCaution: UnderCautionResolver;
  getRaceFinishedFired: () => boolean;
  getLapCompletedSnapshot: LapCompletedSnapshotResolver;
  /** Built in `registerPitCrew` from the three opt-ins and the active voice's script. */
  isSelectable: SectorTargetSelectableResolver;
};

/** Each target's contract id. */
export const SECTOR_COMPARISON_CONTRACT_IDS = {
  leader: "pit-crew.sector-comparison-leader",
  ahead: "pit-crew.sector-comparison-ahead",
  behind: "pit-crew.sector-comparison-behind",
} as const satisfies Readonly<Record<SectorTarget, string>>;

/** The lap-time lines the sector call is heard after (#1571, #555, #1163). */
export const SECTOR_COMPARISON_QUEUE_BEHIND: readonly string[] = [
  "pit-crew.fastest-lap-race",
  "pit-crew.lap-time-best",
  "pit-crew.lap-time-last",
];

const SECTOR_NUMBER_GROUP = "sector-comparison-sector";
const CAR_NUMBER_GROUP = "car-number";
const SECONDS_GROUP = "lap-time-second";
const DECIMAL_GROUP = "lap-time-decimal";
const SECTOR_COMPARISON_GROUP = "sector-comparison";

/** The declared key set of `sectorComparison.paceShape`. */
export const SECTOR_PACE_SHAPE_KEYS: Readonly<Record<SectorPaceShape, string>> = {
  slower: "The class leader is quicker than the driver over a lap.",
  quicker: "The driver is quicker than the class leader over a lap.",
};

/** The declared key set of `sectorComparison.lossShape`. */
export const SECTOR_LOSS_SHAPE_KEYS: Readonly<Record<SectorLossShape, string>> = {
  most: "One sector carries at least half of the time the driver loses to the leader.",
  largest: "The time lost is spread, and one sector loses the most of it.",
  every: "The driver is slower than the leader in every sector of a track with three or more.",
};

/** A sector number as a `sector-comparison-sector` pool reference; `null` for none. */
function sectorRef(sector: number | null): string | null {
  return sector === null ? null : poolRef(SECTOR_NUMBER_GROUP, String(sector));
}

/**
 * A pace gap as it is read aloud: unsigned, rounded half up to the tenth, as
 * whole seconds and tenths. The rounding carries the thresholds' tolerance
 * ({@link EPS}): a pace summed from sector deltas that is 0.75 s on the
 * timing screen can arrive as 0.7499999, and is read "point eight", as a
 * person would read it, never "point seven".
 */
export function paceTenths(pace: number): { seconds: number; tenths: number } {
  const totalTenths = Math.round(Math.abs(pace) * 10 + EPS);

  return { seconds: Math.floor(totalTenths / 10), tenths: totalTenths % 10 };
}

/** The leader's pace gap as {@link paceTenths} reads it; `null` for a neighbour. */
function paceParts(picture: SectorPicture | null): { seconds: number; tenths: number } | null {
  if (picture?.pace === null || picture?.pace === undefined) return null;

  return paceTenths(picture.pace);
}

/** Whether the player's lap the event closed was recorded clean (decision 4), read from the comparison. */
function playerLapClean(input: SectorComparisonInput, lap: number): boolean {
  return input.player.recentLaps.some((l) => l.lap === lap && l.clean);
}

/**
 * Build the sector-comparison family over its reads: the vocabulary its
 * scripts may name and its three contracts, sharing one selection per lap.
 */
export function buildSectorComparison(deps: SectorComparisonDeps): {
  registerVocabulary(engine: Pick<IScenarioEngine, "defineVar" | "defineCond" | "defineCase">): void;
  contracts: readonly ScenarioContract[];
} {
  /**
   * Decide this envelope once, for the first `where:` that gets past the
   * cheap gates: build the comparison, check the player's lap was recorded
   * clean (decision 4: a pit lap or an off-track lap of the player's produces
   * no call), and select. The answer is stored, a refusal as a null picture,
   * so the other two `where:`s read it without building the comparison again
   * and the three see one answer even if it moves between their timers.
   * Older laps' entries are pruned here.
   */
  const decide = (ev: SimEventOf<SimEventName>, lap: number): SectorPicture | null => {
    for (const [key, entry] of selections) {
      if (entry.lap < lap) selections.delete(key);
    }

    const input = deps.getSectorComparison();
    const picture =
      input !== null && playerLapClean(input, lap)
        ? selectSectorCall(input, lap, deps.isSelectable, { spoken: spokenPictures, lastCallLap })
        : null;

    selections.set(ev, { lap, picture });

    return picture;
  };

  const registerVocabulary = (engine: Pick<IScenarioEngine, "defineVar" | "defineCond" | "defineCase">): void => {
    engine.defineVar(
      "sectorComparison.paceSeconds",
      (ctx) => {
        const parts = paceParts(stashedPicture(ctx));

        return parts === null ? null : poolRef(SECONDS_GROUP, String(parts.seconds));
      },
      "The whole seconds of the pace gap to the class leader over a lap, rounded to the tenth, from the lap-time-second clip group; nothing for a call about the car ahead or behind.",
    );

    engine.defineVar(
      "sectorComparison.paceDecimal",
      (ctx) => {
        const parts = paceParts(stashedPicture(ctx));

        return parts === null ? null : poolRef(DECIMAL_GROUP, String(parts.tenths));
      },
      'The tenths of the pace gap to the class leader ("point five seconds."), from the lap-time-decimal clip group; nothing for a call about the car ahead or behind.',
    );

    engine.defineVar(
      "sectorComparison.lossSector",
      (ctx) => sectorRef(stashedPicture(ctx)?.lossSector ?? null),
      "The sector where the driver loses the most to the car the call is about (the leader's quicker sector, or the sector where the car behind is quicker), from the sector-comparison-sector clip group; a sector with no clip skips the call.",
    );

    engine.defineVar(
      "sectorComparison.gainSector",
      (ctx) => sectorRef(stashedPicture(ctx)?.gainSector ?? null),
      "The sector where the driver gains the most on the car the call is about (on the leader, or where the car ahead is slower), from the sector-comparison-sector clip group; a sector with no clip skips the call.",
    );

    engine.defineVar(
      "sectorComparison.carNumber",
      (ctx) => {
        const carNumber = stashedPicture(ctx)?.carNumber ?? null;

        return carNumber === null || carNumber === "" ? null : poolRef(CAR_NUMBER_GROUP, carNumber);
      },
      "The number of the car the call is about, as the session spells it, from the car-number clip group; nothing when the sim gave the car no number, which skips a line that needs it.",
    );

    engine.defineCase(
      "sectorComparison.paceShape",
      (ctx) => stashedPicture(ctx)?.shape ?? null,
      SECTOR_PACE_SHAPE_KEYS,
      "Whether the class leader is quicker than the driver over a lap or the driver is quicker than the leader; nothing for a call about the car ahead or behind.",
    );

    engine.defineCase(
      "sectorComparison.lossShape",
      (ctx) => stashedPicture(ctx)?.lossShape ?? null,
      SECTOR_LOSS_SHAPE_KEYS,
      "How the time lost to a quicker leader is spread: mostly in one sector, the largest share in one sector, or in every sector; nothing when the driver is quicker or no sector stands out.",
    );

    engine.defineCond(
      "sectorComparison.hasGain",
      (ctx) => (stashedPicture(ctx)?.gainSector ?? null) !== null,
      "The call names a sector where the driver gains on the car it is about.",
    );
  };

  const buildContract = (target: SectorTarget, description: string): ScenarioContract => ({
    id: SECTOR_COMPARISON_CONTRACT_IDS[target],
    description,
    when: {
      event: "lap.completed",
      where: (ev) => {
        if (ev.event !== "lap.completed") return false;

        // Decided already by a sibling's `where:` for this lap: its answer.
        const known = selections.get(ev);

        if (known !== undefined) return known.picture?.target === target;

        // Race only (decision 7), as the neighbours read the session.
        if (!isRaceSession(deps.getSessionClass())) return false;

        const data = ev.data as LapCompletedSnapshot;

        // A lap the sim did not count, a lap under or ending a caution
        // (#1127, R16), a caution out now, and the player's finish (#569):
        // the lap-time family's gates, applied alike.
        if (data.lapIsValid === false || data.wasCaution === true) return false;

        if (deps.getUnderFullCourseCaution() || deps.getRaceFinishedFired()) return false;

        return decide(ev, data.lap)?.target === target;
      },
    },
    speakGate: {
      description:
        "The driver has not completed another lap since, no full-course caution is out and no other sector call has been made for this lap; speaking it records what was said.",
      admit: (ctx) => {
        if (ctx.event === null) return false;

        const stashed = selections.get(ctx.event);

        if (stashed === undefined || stashed.picture === null || stashed.picture.target !== target) return false;

        if (!lapStillCurrent(stashed.lap, deps.getLapCompletedSnapshot())) return false;

        if (deps.getUnderFullCourseCaution()) return false;

        // One call per spacing, whichever target: a second approval for the
        // same lap (the comparison moved between timers) is turned away here.
        if (insideSpacing(stashed.lap, lastCallLap, SECTOR_CALL_MIN_LAPS)) return false;

        // The claim, last (#1137): only a fire that goes on to play records
        // its picture, so a refused one leaves its target due.
        spokenPictures.set(target, { picture: stashed.picture, lap: stashed.lap });
        lastCallLap = stashed.lap;

        return true;
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "sector-comparison",
    supersedeGroup: "sector-comparison",
    weight: WEIGHT.CHATTER,
    interrupt: false,
    queueable: true,
    maxQueueWaitMs: 20_000,
    triggerDelay: SECTOR_COMPARISON_TRIGGER_DELAY_MS,
    queueBehind: SECTOR_COMPARISON_QUEUE_BEHIND,
  });

  return {
    registerVocabulary,
    contracts: [
      buildContract(
        "leader",
        "You cross the line in a race on a clean lap and your pace gap to the class leader is new, has moved or was last said 8 laps ago, from lap 4 on, at most every other lap.",
      ),
      buildContract(
        "ahead",
        "You cross the line in a race on a clean lap and the car ahead within 3 seconds is clearly slower than you in one sector, at most every other lap.",
      ),
      buildContract(
        "behind",
        "You cross the line in a race on a clean lap and the car behind within 3 seconds is clearly quicker than you in one sector, at most every other lap.",
      ),
    ],
  };
}

/** Stable identifier for each sector-comparison callout (issue #1572). */
export type SectorComparisonCalloutId = CalloutIdOf<typeof SECTOR_COMPARISON_CALLOUTS>;

// `as const` for the compile-time completeness check on `SCENARIO_ID_TO_SECTOR_COMPARISON_ID`.
export const SECTOR_COMPARISON_SCENARIO_IDS = [
  "pit-crew.sector-comparison-leader",
  "pit-crew.sector-comparison-ahead",
  "pit-crew.sector-comparison-behind",
] as const;

export const SCENARIO_ID_TO_SECTOR_COMPARISON_ID: Record<
  (typeof SECTOR_COMPARISON_SCENARIO_IDS)[number],
  SectorComparisonCalloutId
> = {
  "pit-crew.sector-comparison-leader": "leader",
  "pit-crew.sector-comparison-ahead": "ahead",
  "pit-crew.sector-comparison-behind": "behind",
};

/**
 * The `sector-comparison` group bases the first-party scripts address (spec
 * decision 9), each one take: the leader intros that lead into the pace gap
 * (`leader-slower`, `leader-quicker`), the loss clauses that lead into a
 * sector (`loss-most`, `loss-largest`) or end the line (`loss-every`), the
 * gain clauses that lead into a sector (`gain` when the driver is slower,
 * `leader-gain` when quicker), the tails after a car number that lead into a
 * sector (`ahead-slower`, `behind-quicker`) and the attack call's closing
 * `chance`. The numbers, the sectors and the car numbers are vars', drawing
 * from their own groups.
 */
export const SECTOR_COMPARISON_CLIP_SOURCES: readonly { group: "sector-comparison"; base: string }[] = [
  { group: SECTOR_COMPARISON_GROUP, base: "leader-slower" },
  { group: SECTOR_COMPARISON_GROUP, base: "leader-quicker" },
  { group: SECTOR_COMPARISON_GROUP, base: "loss-most" },
  { group: SECTOR_COMPARISON_GROUP, base: "loss-largest" },
  { group: SECTOR_COMPARISON_GROUP, base: "loss-every" },
  { group: SECTOR_COMPARISON_GROUP, base: "gain" },
  { group: SECTOR_COMPARISON_GROUP, base: "leader-gain" },
  { group: SECTOR_COMPARISON_GROUP, base: "ahead-slower" },
  { group: SECTOR_COMPARISON_GROUP, base: "chance" },
  { group: SECTOR_COMPARISON_GROUP, base: "behind-quicker" },
];
