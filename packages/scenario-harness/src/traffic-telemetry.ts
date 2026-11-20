/**
 * The multi-car telemetry the approaching-traffic shortcuts drive the
 * translator with (issue #1113), in a module of its own because both
 * detectors decide from a FIELD — every car's lap position, reference time,
 * class and surface — which no single bus event carries, and because the
 * test that runs them through the real translator reads the same numbers.
 *
 * Indexed against the `race` / `race-oval` session presets' roster, as the
 * caution and rolling-start arrays are: the pace car at index 0, the player at
 * index 7, eighteen slots in all. Every car the run does not use is out of the
 * world (`NotInWorld`, lap position −1), the pace car included, so nothing but
 * the cars named here is a candidate.
 *
 * **Two classes, set in the telemetry.** The presets' roster is one class, so
 * the classes come from `CarIdxClass`, which the arrival model reads before
 * the session's `CarClassID`: class {@link TRAFFIC_CLASS_A} (the player's,
 * an 80 s reference lap) and class {@link TRAFFIC_CLASS_B} (90 s). Neither
 * preset carries a `CarClassEstLapTime`, so the scaled tier has no ratio to
 * scale by and a class-B car is timed by class B's own learned curve or not
 * at all. That is the point: a wrong class reference would move every class-B
 * arrival by ten percent, and an unlearned one withholds the clear line.
 *
 * **Reference times are linear in lap position** (`estTime = pct × lap`). The
 * sim's are not, but the arrival model only ever reads a class's curve where
 * that class has been sampled, so a straight line is a curve like any other,
 * and it lets every arrival below be written as a number of seconds.
 *
 * **Arrivals sit half a second past the second they are spoken as.** The
 * detector rounds down, and a curve read by interpolation can land a hair
 * under an exact whole second, which would speak the one below it.
 */
import { EngineWarnings, Flags, REPLAY_EXIT_GRACE_MS, SessionState, TrkLoc } from "@iracedeck/iracing-sdk";

import type { TelemetryStep } from "./scenario-shortcuts.js";

/** Slots in the presets' roster. */
const ROSTER_SIZE = 18;

/** The player's car, `DriverInfo.DriverCarIdx` in `race` and `race-oval`. */
export const TRAFFIC_PLAYER_CAR_IDX = 7;

/** The player's class: a sports car on an 80 s reference lap. */
export const TRAFFIC_CLASS_A = 0;

/** The faster cars' slower sibling: a class on a 90 s reference lap. */
export const TRAFFIC_CLASS_B = 1;

const LAP_SECONDS: Record<number, number> = { [TRAFFIC_CLASS_A]: 80, [TRAFFIC_CLASS_B]: 90 };

/** A car's reference time at a lap position, on its class's linear reference lap. */
function estTimeAt(classId: number, pct: number): number {
  return pct * LAP_SECONDS[classId];
}

/** The lap position at which a car of the class reads `estTime`. */
function pctAt(classId: number, estTime: number): number {
  return estTime / LAP_SECONDS[classId];
}

/** The racing-speed `Speed` the player drives at when not stopped: 40 m/s, as the overtake shortcuts' step. */
const RACING_SPEED_MPS = 40;

/** Racing under green with no flag shown, the caution shortcuts' resting `SessionFlags`. */
const RACING_NO_FLAG = Flags.Servicible | Flags.StartHidden;

/** How long a replay-mode bracket's close is held: the replay exit grace plus a few ticks (the shortcuts' idiom). */
const REPLAY_EXIT_SETTLE_MS = REPLAY_EXIT_GRACE_MS + 200;

/** How long a replay-mode bracket's opening is held. */
const BRACKET_SEED_MS = 200;

/** The step that makes the translator re-seed on what a bracket arranged, whatever the tick rate. */
const SEEDED_TICK: TelemetryStep = { patch: {}, tick: true };

/** One car in a field snapshot: where it is, of which class, on which surface. */
type FieldCar = { carIdx: number; classId: number; pct: number; surface: TrkLoc };

/**
 * The per-car arrays for a field: the named cars where given, every other
 * slot out of the world. `CarIdxEstTime` is each car's class reference at its
 * position; `CarIdxLapCompleted` is deleted, so the canonical order ranks
 * nobody and no position, gap or overtake event can come out of a field whose
 * cars jump between snapshots.
 */
function field(cars: readonly FieldCar[]): Record<string, unknown> {
  const pcts = new Array<number>(ROSTER_SIZE).fill(-1);
  const estTimes = new Array<number>(ROSTER_SIZE).fill(-1);
  const surfaces = new Array<number>(ROSTER_SIZE).fill(TrkLoc.NotInWorld);
  const classes = new Array<number>(ROSTER_SIZE).fill(TRAFFIC_CLASS_A);
  const onPitRoad = new Array<boolean>(ROSTER_SIZE).fill(false);

  for (const car of cars) {
    pcts[car.carIdx] = car.pct;
    estTimes[car.carIdx] = estTimeAt(car.classId, car.pct);
    surfaces[car.carIdx] = car.surface;
    classes[car.carIdx] = car.classId;
    onPitRoad[car.carIdx] = car.surface === TrkLoc.InPitStall || car.surface === TrkLoc.AproachingPits;
  }

  return {
    CarIdxLapDistPct: pcts,
    CarIdxEstTime: estTimes,
    CarIdxTrackSurface: surfaces,
    CarIdxClass: classes,
    CarIdxOnPitRoad: onPitRoad,
    CarIdxLapCompleted: null,
  };
}

/** The per-car arrays the traffic runs add, deleted again at the end of each. */
const FIELD_DELETED: Record<string, null> = {
  CarIdxLapDistPct: null,
  CarIdxEstTime: null,
  CarIdxTrackSurface: null,
  CarIdxClass: null,
  CarIdxOnPitRoad: null,
};

/**
 * The run's last two steps: a replay-mode bracket that puts the player back on
 * the circuit at racing speed, off pit road, and deletes the per-car arrays,
 * so the next button starts from the presets' premise (the caution extra-lap
 * button counts on no per-car lap progress) and nothing the run arranged is
 * announced on the way out. Replay mode also wipes the traffic episodes. It
 * ends on {@link SEEDED_TICK}, so the translator re-seeds on what the bracket
 * handed back now rather than on the next button's first live tick, which
 * with the tick loop paused or slowed would take that button's first patch
 * for its baseline and swallow its edge.
 */
const TRAFFIC_TEARDOWN: readonly TelemetryStep[] = [
  {
    patch: {
      IsReplayPlaying: true,
      IsOnTrack: true,
      OnPitRoad: false,
      PlayerCarInPitStall: false,
      PlayerTrackSurface: TrkLoc.OnTrack,
      Speed: RACING_SPEED_MPS,
      ...FIELD_DELETED,
    },
    holdMs: BRACKET_SEED_MS,
    tick: true,
  },
  { patch: { IsReplayPlaying: false }, holdMs: REPLAY_EXIT_SETTLE_MS, tick: true },
  SEEDED_TICK,
];

// ── Rejoin ────────────────────────────────────────────────────────────────

/** Where the player stops: P, 0.6 of the lap, class A reference 48 s. */
export const TRAFFIC_REJOIN_STOP_PCT = 0.6;

/** The class-B car the verdicts follow: 25.5, 12.5, 8.5, 5.5, then 1.5 s from P, then past it. */
export const TRAFFIC_REJOIN_LEAD_CAR_IDX = 3;

/** A class-A car behind the lead car, which becomes the nearest once the lead car has gone by. */
export const TRAFFIC_REJOIN_MID_CAR_IDX = 5;

/** A class-B car behind the class-A car. */
export const TRAFFIC_REJOIN_TAIL_CAR_IDX = 9;

/**
 * Each car's arrival at P (seconds) in the seven snapshots, `null` once it is
 * past P. The lead car closes from far away (25.5 and 12.5 s, both silent
 * since the engineer speaks only to warn, amended 2026-11-20) into near, near
 * three seconds closer and right behind; the class-A car behind it is still
 * 10 s or more away once the lead has gone by (silent), then close on its own
 * (a new first call); the tail keeps the train a train.
 */
const REJOIN_ARRIVALS: Record<number, readonly (number | null)[]> = {
  [TRAFFIC_REJOIN_LEAD_CAR_IDX]: [25.5, 12.5, 8.5, 5.5, 1.5, null, null],
  [TRAFFIC_REJOIN_MID_CAR_IDX]: [34.5, 22.5, 18.5, 15.5, 11.5, 10.5, 6.5],
  [TRAFFIC_REJOIN_TAIL_CAR_IDX]: [45.5, 33.5, 29.5, 26.5, 22.5, 21.5, 17.5],
};

const REJOIN_CLASSES: Record<number, number> = {
  [TRAFFIC_REJOIN_LEAD_CAR_IDX]: TRAFFIC_CLASS_B,
  [TRAFFIC_REJOIN_MID_CAR_IDX]: TRAFFIC_CLASS_A,
  [TRAFFIC_REJOIN_TAIL_CAR_IDX]: TRAFFIC_CLASS_B,
};

/** Where a car past P sits: 0.02 of the lap beyond it, so it wraps a lap, far outside every window. */
const REJOIN_PASSED_PCT = TRAFFIC_REJOIN_STOP_PCT + 0.02;

/** The player, stopped (or not) at P on the racing surface. */
function rejoinPlayer(): FieldCar {
  return {
    carIdx: TRAFFIC_PLAYER_CAR_IDX,
    classId: TRAFFIC_CLASS_A,
    pct: TRAFFIC_REJOIN_STOP_PCT,
    surface: TrkLoc.OnTrack,
  };
}

/** Snapshot `n` (0–6) of the train: every car where its arrival at P puts it. */
function rejoinSnapshot(n: number): Record<string, unknown> {
  const cars: FieldCar[] = [rejoinPlayer()];

  for (const [key, arrivals] of Object.entries(REJOIN_ARRIVALS)) {
    const carIdx = Number(key);
    const classId = REJOIN_CLASSES[carIdx];
    const arrival = arrivals[n];
    const pct =
      arrival === null ? REJOIN_PASSED_PCT : pctAt(classId, estTimeAt(classId, TRAFFIC_REJOIN_STOP_PCT) - arrival);

    cars.push({ carIdx, classId, pct, surface: TrkLoc.OnTrack });
  }

  return field(cars);
}

/**
 * The learning lap, compressed to two ticks: every car of both classes drives
 * over the stretch either side of P and over the last hundredth of the lap, so
 * each class has samples round P (its arrival there is exact) and a lap end
 * (a car past P is timed a lap away, never left untimed). Without it, class
 * B's curve has nothing at P and the lead and tail cars are untimed.
 */
function rejoinLearningTick(across: 0 | 1): Record<string, unknown> {
  const nearP = across === 0 ? TRAFFIC_REJOIN_STOP_PCT - 0.004 : TRAFFIC_REJOIN_STOP_PCT + 0.004;
  const nearLine = across === 0 ? 0.992 : 0.998;

  return field([
    // The player at speed short of P, about to spin there.
    {
      carIdx: TRAFFIC_PLAYER_CAR_IDX,
      classId: TRAFFIC_CLASS_A,
      pct: TRAFFIC_REJOIN_STOP_PCT - 0.03,
      surface: TrkLoc.OnTrack,
    },
    { carIdx: TRAFFIC_REJOIN_LEAD_CAR_IDX, classId: TRAFFIC_CLASS_B, pct: nearP, surface: TrkLoc.OnTrack },
    { carIdx: TRAFFIC_REJOIN_TAIL_CAR_IDX, classId: TRAFFIC_CLASS_B, pct: nearLine, surface: TrkLoc.OnTrack },
    { carIdx: TRAFFIC_REJOIN_MID_CAR_IDX, classId: TRAFFIC_CLASS_A, pct: nearLine, surface: TrkLoc.OnTrack },
  ]);
}

/**
 * How long the stop is held before a second tick on the same snapshot: past
 * the detector's 1.5 s entry dwell (`TRAFFIC_REJOIN_ENTRY_DWELL_MS`).
 */
const REJOIN_STOP_HOLD_MS = 1700;

/**
 * How long that second tick, on which the episode has started and spoken, is
 * held before the first snapshot changes: past the detector's one-second
 * evaluation interval, so the next snapshot is evaluated.
 *
 * The stop is two ticked steps, not one long hold, for a harness whose tick
 * loop is paused: a step's hold then adds no tick, so with one step the dwell
 * would end on the next snapshot's tick and the entry would be judged off
 * snapshot 1, never snapshot 0. Both are silent now (no car under 10 s), but
 * the run keeps each snapshot's evaluation where it was, so the bands under
 * 10 s land on the same steps with the loop ticking or paused.
 */
const REJOIN_ENTRY_HOLD_MS = 1300;

/** How long each later snapshot is held: past the detector's one-second evaluation interval. */
const REJOIN_SNAPSHOT_HOLD_MS = 1500;

/** How long the player drives away before the teardown: past the detector's 2 s end dwell. */
const REJOIN_DRIVE_AWAY_MS = 2500;

/**
 * Stopped on the circuit with a train of three cars coming (issue #1113, spec
 * "Verification"): the player spins to a stop at P while a class-B car closes
 * from 25 s to 12, 8, 5 and 1.5 s away and goes by, with a class-A car and a
 * class-B car behind it. Through the real rejoin detector, warnings only
 * (amended 2026-11-20): nothing on entry or at 12.5 s, then `near` 8 (first),
 * `near` 5 (the count, three seconds closer), `rightBehind`, nothing once the
 * lead car is past while the next car is still 10 s or more away, and that
 * car's own close call when it closes (`near` 6, first).
 *
 * Opens inside a replay-mode bracket that puts the player on the circuit at
 * racing speed, off pit road and racing under green, then a seeding tick; then
 * the two-tick learning lap ({@link rejoinLearningTick}); then the stop and
 * the snapshots, each held past the detector's evaluation interval; then the
 * player drives away (the episode ends silently) and the teardown bracket.
 * The snapshots jump the cars seconds at a time: the detector re-times the
 * field once a second and speaks on a verdict change, so a compressed picture
 * is heard exactly as a continuous one would be.
 */
export const TRAFFIC_REJOIN_SEQUENCE: readonly TelemetryStep[] = rejoinSequence(true);

/**
 * The same run without the learning lap, for the test's control: class B has
 * no curve at P, so its two cars are untimed and left out; the class-A car is
 * timed, so its `near` is still heard.
 *
 * @internal Exported for testing
 */
export const TRAFFIC_REJOIN_SEQUENCE_UNLEARNED: readonly TelemetryStep[] = rejoinSequence(false);

function rejoinSequence(learn: boolean): TelemetryStep[] {
  return [
    {
      patch: {
        IsReplayPlaying: true,
        IsOnTrack: true,
        IsInGarage: false,
        OnPitRoad: false,
        PlayerCarInPitStall: false,
        PlayerTrackSurface: TrkLoc.OnTrack,
        Speed: RACING_SPEED_MPS,
        SessionState: SessionState.Racing,
        SessionFlags: RACING_NO_FLAG,
        ...rejoinLearningTick(0),
      },
      holdMs: BRACKET_SEED_MS,
      tick: true,
    },
    { patch: { IsReplayPlaying: false }, holdMs: REPLAY_EXIT_SETTLE_MS, tick: true },
    SEEDED_TICK,
    // The learning lap, live: both classes sampled round P and at the line.
    ...(learn
      ? [
          { patch: rejoinLearningTick(0), holdMs: 100, tick: true },
          { patch: rejoinLearningTick(1), holdMs: 100, tick: true },
        ]
      : []),
    // The spin: stopped at P, the train 25.5 / 34.5 / 45.5 s away; then a
    // tick past the entry dwell, still on that snapshot, which the episode
    // starts on.
    { patch: { Speed: 0, ...rejoinSnapshot(0) }, holdMs: REJOIN_STOP_HOLD_MS, tick: true },
    { patch: {}, holdMs: REJOIN_ENTRY_HOLD_MS, tick: true },
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ patch: rejoinSnapshot(n), holdMs: REJOIN_SNAPSHOT_HOLD_MS, tick: true })),
    // Away again: the episode ends once the car has been moving for two
    // seconds, on a tick after that dwell. That tick is a step of its own, so
    // the episode also ends with the tick loop paused (one tick per step): an
    // episode still running at the teardown bracket would be wiped there, with
    // `traffic.rejoinTowed`, which cuts a rejoin line in flight.
    { patch: { Speed: RACING_SPEED_MPS }, holdMs: REJOIN_DRIVE_AWAY_MS, tick: true },
    { patch: {}, holdMs: 0, tick: true },
    ...TRAFFIC_TEARDOWN,
  ];
}

// ── Pit exit ──────────────────────────────────────────────────────────────

/**
 * Where the learned pit lane ends: `pitRoadEnd` at 0.30 of the lap. Far
 * enough round the lap that every car the runs place, up to 15 s from the
 * blend, sits past the start/finish line on a lap position of its own.
 */
export const TRAFFIC_PIT_ROAD_END_PCT = 0.3;

/**
 * Where the exit blend ends: `blendEnd` at 0.35 of the lap, a blend lane of
 * about 100 m, long enough that the car the run places 3 s before the player
 * is still short of the blend when the merge is checked.
 */
export const TRAFFIC_BLEND_END_PCT = 0.35;

/**
 * The player's stall, and where the player is on the tick after leaving it:
 * 0.05 of the 2.05 km lap short of `pitRoadEnd`, 102.5 m, 6.15 s at the
 * presets' 60 km/h limit, so the departure is well short of the call point.
 */
const PIT_EXIT_STALL_PCT = 0.2495;
const PIT_EXIT_LEAVING_PCT = 0.25;

/**
 * Where the call is made, still on pit road (amended 2026-11-20): 0.02 of the
 * lap short of `pitRoadEnd`, 41 m, 2.46 s at the limit, inside the detector's
 * 3 s lead.
 */
const PIT_EXIT_CALL_PCT = 0.28;

/** Where the player is once over the end of pit road, in the exit lane: 10 m past `pitRoadEnd`. */
const PIT_EXIT_BLEND_LANE_PCT = 0.305;

/** The class-A car on track whose arrival at the blend each pit-exit run places. */
export const TRAFFIC_PIT_EXIT_CAR_IDX = 3;

/** One sample of a learned landmark's window, as the landmark store keeps it. */
function landmarkSample(pct: number, key: string): Record<string, unknown> {
  return { pct, estTime: estTimeAt(TRAFFIC_CLASS_A, pct), carClassId: TRAFFIC_CLASS_A, key, at: 0 };
}

/**
 * The pit-lane section a store would hand the translator's learner for the
 * presets' track (`loadPitLaneLandmarks`, issue #1112): `pitRoadEnd` and
 * `blendEnd`, each published by two agreeing samples of class A, whose
 * reference time there (24 s, 28 s) the store derives from the window. The
 * `trackLength` is the presets' own, so the learner reads no rebuild.
 */
export function trafficPitExitLandmarkSection(): Record<string, unknown> {
  return {
    version: 1,
    trackLength: "2.05 km",
    landmarks: {
      pitRoadEnd: {
        window: [
          landmarkSample(TRAFFIC_PIT_ROAD_END_PCT, "harness:a:pitRoadEnd"),
          landmarkSample(TRAFFIC_PIT_ROAD_END_PCT, "harness:b:pitRoadEnd"),
        ],
      },
      blendEnd: {
        window: [
          landmarkSample(TRAFFIC_BLEND_END_PCT, "harness:a:blendEnd"),
          landmarkSample(TRAFFIC_BLEND_END_PCT, "harness:b:blendEnd"),
        ],
      },
    },
  };
}

/** The presets' pit speed limit, 60 km/h, in m/s. */
const PIT_LIMIT_MPS = 60 / 3.6;

/**
 * The player's arrival at `blendEnd` from `pct` on pit road, as the detector
 * computes it there: the distance to `pitRoadEnd` along the 2.05 km lap at
 * the limit, plus class A's reference time from `pitRoadEnd` to `blendEnd`
 * (4 s).
 */
function pitRoadEtaS(pct: number): number {
  return (
    ((TRAFFIC_PIT_ROAD_END_PCT - pct) * 2050) / PIT_LIMIT_MPS +
    (estTimeAt(TRAFFIC_CLASS_A, TRAFFIC_BLEND_END_PCT) - estTimeAt(TRAFFIC_CLASS_A, TRAFFIC_PIT_ROAD_END_PCT))
  );
}

/** The player's arrival at `blendEnd` on the tick after leaving the stall: 6.15 + 4 s. The verdict settles on this, unspoken. */
const PIT_EXIT_LEAVING_ETA_S = pitRoadEtaS(PIT_EXIT_LEAVING_PCT);

/**
 * How long before `pitRoadEnd` the call point is, at the limit, where the run
 * makes the call: 2.46 s, inside the detector's 3 s lead
 * (`TRAFFIC_PIT_EXIT_CALL_LEAD_S`, amended 2026-11-20).
 */
export const TRAFFIC_PIT_EXIT_CALL_LEAD_S = ((TRAFFIC_PIT_ROAD_END_PCT - PIT_EXIT_CALL_PCT) * 2050) / PIT_LIMIT_MPS;

/**
 * The player's arrival at `blendEnd` at the call point, still on pit road:
 * 2.46 + 4 = 6.46 s. The seconds the call carries are relative to this.
 */
export const TRAFFIC_PIT_EXIT_PLAYER_ETA_S = pitRoadEtaS(PIT_EXIT_CALL_PCT);

/**
 * The player's arrival at `blendEnd` once over the end of pit road, in the
 * exit lane, where the merge warning is checked: class A's reference time from
 * there to `blendEnd` (28 − 24.4 = 3.6 s). The merge warning's seconds are
 * relative to this.
 */
export const TRAFFIC_PIT_EXIT_MERGE_ETA_S =
  estTimeAt(TRAFFIC_CLASS_A, TRAFFIC_BLEND_END_PCT) - estTimeAt(TRAFFIC_CLASS_A, PIT_EXIT_BLEND_LANE_PCT);

/**
 * The four cases of the spec's test plan: a car reaching the blend this many
 * seconds after the player (negative: before). At the default merge threshold
 * (1.5 s) the −1 s case also gets the merge warning in the exit lane, and the
 * other three, outside it, do not.
 */
export const TRAFFIC_PIT_EXIT_CASES = [-3, -1, 3, 5] as const;

/** The class-A car on track that reaches `blendEnd` `relativeSeconds` after a player arriving in `playerEtaS`. */
function pitExitCar(relativeSeconds: number, playerEtaS: number): FieldCar {
  const arrival = playerEtaS + relativeSeconds;
  const estTime = estTimeAt(TRAFFIC_CLASS_A, TRAFFIC_BLEND_END_PCT) - arrival;

  return {
    carIdx: TRAFFIC_PIT_EXIT_CAR_IDX,
    classId: TRAFFIC_CLASS_A,
    pct: pctAt(TRAFFIC_CLASS_A, estTime),
    surface: TrkLoc.OnTrack,
  };
}

/**
 * How long the run spends on pit road after leaving the stall: past one
 * evaluation interval, so the paused runner's next tick is an evaluation too.
 * The verdict settles at the departure and nothing is said.
 */
const PIT_EXIT_PIT_ROAD_MS = 1500;

/**
 * How long the run holds the call point, on pit road: the call comes at the
 * first evaluation there and plays, about as long as the 41 m left of pit
 * road take at the limit.
 */
const PIT_EXIT_CALL_POINT_MS = 3000;

/** How long the run listens once over the end of pit road: the merge warning, when due, comes at the first tick there. */
const PIT_EXIT_LISTEN_MS = 4000;

/**
 * Leaving the stall, driving down pit road to the call point and over the end
 * of pit road into the exit lane with one car on track reaching the end of
 * the exit blend `relativeSeconds` after the player (issue #1113, spec
 * "Verification", amended 2026-11-20), through the real pit-exit detector,
 * against the landmarks of {@link trafficPitExitLandmarkSection} — which must
 * already be in the translator's learner: the detector stays silent on a
 * track whose landmarks are not learned. At the fixed window (2 s before, 4 s
 * after) the four {@link TRAFFIC_PIT_EXIT_CASES} are `clear`, `traffic`,
 * `traffic`, `clear`, and at the default merge threshold (1.5 s) only the
 * −1 s case gets the merge warning.
 *
 * Opens inside a replay-mode bracket that puts the player in the stall (the
 * limiter on, so the limiter family stays quiet) and the car on track, then a
 * seeding tick, so the detector's stall baseline is live; then the departure,
 * 6.15 s short of `pitRoadEnd`, where the verdict settles unspoken, held on
 * pit road; then the call point, 2.46 s short of it, where the call is made at
 * the first evaluation, held while the line plays; then over the end of pit
 * road (`OnPitRoad` false, the limiter off) into the exit lane, where the
 * merge is checked at the first tick; then the teardown bracket. The car is
 * placed against the player's ETA at each, so every step sees the same
 * picture.
 */
export function trafficPitExitSequence(relativeSeconds: number): readonly TelemetryStep[] {
  const leavingCar = pitExitCar(relativeSeconds, PIT_EXIT_LEAVING_ETA_S);
  const callPointCar = pitExitCar(relativeSeconds, TRAFFIC_PIT_EXIT_PLAYER_ETA_S);
  const blendLaneCar = pitExitCar(relativeSeconds, TRAFFIC_PIT_EXIT_MERGE_ETA_S);
  const player = (pct: number, surface: TrkLoc): FieldCar => ({
    carIdx: TRAFFIC_PLAYER_CAR_IDX,
    classId: TRAFFIC_CLASS_A,
    pct,
    surface,
  });

  return [
    {
      patch: {
        IsReplayPlaying: true,
        IsOnTrack: true,
        IsInGarage: false,
        OnPitRoad: true,
        PlayerCarInPitStall: true,
        PlayerTrackSurface: TrkLoc.InPitStall,
        Speed: 0,
        SessionState: SessionState.Racing,
        SessionFlags: RACING_NO_FLAG,
        EngineWarnings: { setBits: EngineWarnings.PitSpeedLimiter },
        ...field([player(PIT_EXIT_STALL_PCT, TrkLoc.InPitStall), leavingCar]),
      },
      holdMs: BRACKET_SEED_MS,
      tick: true,
    },
    { patch: { IsReplayPlaying: false }, holdMs: REPLAY_EXIT_SETTLE_MS, tick: true },
    SEEDED_TICK,
    // Out of the stall: the detector's episode starts and settles its verdict, unspoken.
    {
      patch: {
        PlayerCarInPitStall: false,
        PlayerTrackSurface: TrkLoc.AproachingPits,
        Speed: 5,
        ...field([player(PIT_EXIT_LEAVING_PCT, TrkLoc.AproachingPits), leavingCar]),
      },
      holdMs: PIT_EXIT_PIT_ROAD_MS,
      tick: true,
    },
    // Down pit road to 2.46 s short of its end: the call.
    {
      patch: {
        Speed: PIT_LIMIT_MPS,
        ...field([player(PIT_EXIT_CALL_PCT, TrkLoc.AproachingPits), callPointCar]),
      },
      holdMs: PIT_EXIT_CALL_POINT_MS,
      tick: true,
    },
    // Over the end of pit road into the exit lane, the limiter off: the merge check.
    {
      patch: {
        OnPitRoad: false,
        Speed: 20,
        EngineWarnings: { clearBits: EngineWarnings.PitSpeedLimiter },
        ...field([player(PIT_EXIT_BLEND_LANE_PCT, TrkLoc.AproachingPits), blendLaneCar]),
      },
      holdMs: PIT_EXIT_LISTEN_MS,
      tick: true,
    },
    ...TRAFFIC_TEARDOWN,
  ];
}
