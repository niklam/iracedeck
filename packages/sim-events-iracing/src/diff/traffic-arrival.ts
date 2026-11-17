/**
 * When each car reaches a lap position P (issue #1113, spec decisions 1 and 5,
 * "Settled (amended 2026-11-10)"): the arrival primitive the rejoin and
 * pit-exit detectors share, and the per-class reference curves it reads.
 * Publishes nothing.
 *
 * **The model.** `CarIdxEstTime` is the sim's reference-lap time to the car's
 * current position, measured on the car's OWN class's reference lap, so for
 * a class it is a function of lap position alone. A car's time to reach P is
 * then `T_C(P) − CarIdxEstTime[car]`, with `T_C(P)` its class's reference time
 * at P, wrapped round the lap when the car is ahead of P on the lap (decided by
 * position, never by the sign of the difference). Using any other
 * class's reference — the player's own `CarIdxEstTime` on rejoin, say — is off
 * by the class offset, about five seconds between GTP and GTD at Monza's
 * Roggia chicane, wider than the pit-exit window.
 *
 * **Measured, before building on it** (2026-11-11):
 * - Spa 2024 GP, online practice, one class (GT3, the full capture behind the
 *   `pit-lane-landmarks-spa-20261109` fixture): 41,320 racing-surface samples
 *   of 16 cars against the class's median curve in 1,000 bins differ by
 *   0.059 s at the median, 0.21 s at p90 and 0.45 s at p99. Each car carries a
 *   steady offset of its own of up to ±0.21 s (network timing, presumably),
 *   which the running mean below averages across cars. Pit-lane samples sit on
 *   the same curve (0.06 s), but the spec learns only from the racing surface.
 * - Monza, official race, GTP and GTD (the 2026-07-28 Telemetry Snapshot):
 *   cars of a class next to each other agree to a few tenths, with single cars
 *   up to about a second off (one instant, so no averaging). Across classes
 *   the ratio of the two reference times at the same position is
 *   1.143–1.147 from 0.37 to 0.65 of the lap, against a `CarClassEstLapTime`
 *   ratio of 1.152: scaling the player's class reference by that ratio (the
 *   fallback tier) lands within about 0.2–0.3 s of the curve there.
 * - `CarClassEstLapTime` is not where `CarIdxEstTime` restarts: Spa's class
 *   read 132.77 s while the curve reaches about 133.66 s at the line, and
 *   Monza's GTD about 104.0 s against 105.57 s. So a wrap uses the curve's own
 *   lap end when it is known ({@link resolveClassLapTime}).
 * - `CarIdxEstTime` restarts with `CarIdxLapDistPct` at the line: the first
 *   bins extrapolate to 0 at 0, and the two samples in that capture read on the
 *   line itself had a position of 1.00001 with the time already restarted —
 *   which the [0, 1) position check drops.
 *
 * **What a curve is.** {@link TRAFFIC_CURVE_BINS} fixed bins over [0, 1), each
 * a running mean of the samples that fell into it (`TrafficCurveBin` in
 * `state.ts`). A lookup interpolates between the nearest sample at or before P
 * and the nearest at or after it, never across the start/finish line, and
 * only over at most {@link TRAFFIC_CURVE_MAX_SPAN_PCT}. The line itself is the
 * one point known without a sample: estTime 0 at position 0.
 *
 * **The sources, in the order the caller gives them** (`TrafficReferenceSource`):
 * the landmark's own per-class time (pit exit only), the class curve at P, and
 * the player's class reference at P scaled by the class lap ratio. A car no
 * source can time is reported untimed with the reason; what that means is the
 * detector's call (traffic at pit exit, a blocked clear line on rejoin).
 *
 * **Candidates** are every car but the player whose `CarIdxTrackSurface` is
 * the racing surface (`OnTrack` or `OffTrack`): that leaves out exactly the
 * cars not in world (also any with a negative `CarIdxLapDistPct`) and the cars
 * in the pits (`InPitStall`, `AproachingPits`). `CarIdxOnPitRoad` is never
 * read: it reads true for remote cars on the racing surface (#1112, amendment
 * 11). The pace car is a candidate: it does arrive.
 *
 * **A car standing still is not a candidate.** The model times every car at
 * its class's reference pace, so a car stopped or crawling just behind P —
 * the other half of a multi-car incident, a stalled car — reads as arriving
 * now, stays the nearest for as long as it stands there, and hides every car
 * really coming. So each car's progress along the lap is measured
 * ({@link TrafficCarMotion} in `state.ts`): over a window of at least
 * {@link TRAFFIC_MOTION_WINDOW_S} of `SessionTime`, the shorter way round the
 * lap, so crossing the start/finish line is no jump. A car whose last rate,
 * times the track length, is under {@link TRAFFIC_CRAWL_MPS} — standing,
 * crawling, or going backwards — is left out of the arrivals altogether: not
 * untimed, simply not coming. A car with no usable rate counts as moving, the
 * cautious direction, since a car left out can never be a warning: on its
 * first readings, after a gap in them longer than
 * {@link TRAFFIC_MOTION_MAX_AGE_S}, after a jump faster than
 * {@link TRAFFIC_MOTION_MAX_PLAUSIBLE_MPS} (a tow, a reset), with a rate older
 * than {@link TRAFFIC_MOTION_MAX_AGE_S}, and without a track length or a
 * `SessionTime`. A close car that stops is therefore gone, as one that drove
 * by is, and comes back as a new car coming when it moves again.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { pitLaneSignedDeltaPct } from "@iracedeck/track-data";

import {
  type TrafficArrivalState,
  type TrafficCarMotion,
  type TrafficCurveBin,
  type TrafficReferenceCurve,
} from "../state.js";
import { runUnitsDirectly, type UnitRunner } from "../tick-steps.js";
import { isRacingSurface } from "./track-surface.js";

/**
 * Bins per lap: 500, one per 0.002 of the lap (10–14 m on a 5–7 km road
 * course, about 0.2–0.3 s of driving). Narrow enough that the bend of the
 * curve inside one bin — the only error the running mean adds, at most about a
 * tenth of a second at the hardest braking point — stays under the
 * measurement's own per-car spread, and wide enough that one car at 60 Hz
 * drops several samples into every bin on every lap, so a class's whole curve
 * fills on its first lap. Three classes cost about 1,500 small objects.
 */
export const TRAFFIC_CURVE_BINS = 500;

/**
 * The widest gap (lap fraction) a lookup interpolates across: 0.01, five bins,
 * about one second of driving. Straight-line interpolation is exact where the
 * speed is constant; across a braking zone that halves the speed it is off by
 * up to a quarter of the change in time-per-lap-fraction times the span —
 * about 0.25 s at 0.01, twice that at 0.02 — so a wider gap would put an error
 * the size of the pit-exit window into the arrival. A gap that wide only
 * exists before a class has driven past P, where the scaling tier answers.
 */
export const TRAFFIC_CURVE_MAX_SPAN_PCT = 0.01;

/**
 * The running mean's weight cap: a bin past 64 samples takes each new one at
 * 1/64. At 60 Hz one car leaves about ten samples in a bin, so the mean spans
 * the last half-dozen passing cars — enough to average out one car's offset
 * (above), while a curve that moved would still follow within a lap.
 */
export const TRAFFIC_CURVE_SAMPLE_CAP = 64;

/**
 * The crawl speed, m/s (about 11 km/h), shared by both traffic detectors:
 * under it the player's own car counts as stopped or crawling, which starts a
 * rejoin, and another car counts as standing still, which leaves it out of the
 * arrivals. Far under the slowest corner of any road course (a hairpin is
 * taken at 50 km/h or more) and under any caution or formation pace, so a
 * moving race car never reads as one, while a car rolling backwards after a
 * spin or creeping out of the gravel still does.
 */
export const TRAFFIC_CRAWL_MPS = 3;

/**
 * The least `SessionTime` (s) a car's progress is measured over: half a
 * second, about 30 ticks. A rate from one tick to the next would read zero
 * whenever a tick repeated a remote car's position, and an evaluation landing
 * there would leave out a car that is really coming — a false clear; over 30
 * ticks one repeated reading moves the rate by a thirtieth. Short enough that
 * a car that has stopped reads stopped within a second, under the detectors'
 * one-second evaluation.
 */
export const TRAFFIC_MOTION_WINDOW_S = 0.5;

/**
 * The oldest reading (s of `SessionTime`) the motion measurement trusts: a
 * window that began longer ago restarts with no rate, since the car went
 * unread in between (in the pits, out of the world, a unit that threw), and a
 * rate measured longer ago is not used, counting the car as moving. Twice the
 * window, so a car read on every tick always has a rate younger than this,
 * while one whose readings stopped counts as moving again within a second.
 */
export const TRAFFIC_MOTION_MAX_AGE_S = 1;

/**
 * The fastest progress (m/s) a car is taken to have driven: 540 km/h, beyond
 * any car iRacing runs. Anything faster across a window is a tow, a reset or a
 * reading that jumped, so the window restarts at the new position with no
 * rate. The pit-lane learner's own bound is the same number for the same
 * reason (`PIT_LANE_MAX_PLAUSIBLE_SPEED_MPS`), kept separate because that one
 * is to be tuned on its captures.
 */
export const TRAFFIC_MOTION_MAX_PLAUSIBLE_MPS = 150;

/** The per-car arrays the arrival model reads, and the session clock its motion measurement runs on. */
export type TrafficTelemetry = Pick<
  TelemetryData,
  "CarIdxLapDistPct" | "CarIdxEstTime" | "CarIdxTrackSurface" | "CarIdxClass" | "SessionTime"
>;

/**
 * What the arrival model needs from the session info (`DriverInfo.Drivers[]`):
 * each class's `CarClassEstLapTime`, keyed by `CarClassID` as a string (as the
 * landmarks' `estTimeByClass` is), and each car's `CarClassID` by `CarIdx`
 * (`-1` for a slot with no driver), the class of a car the telemetry gives
 * none — the pace car, which reads `CarIdxClass` -1 (Monza, 2026-07-28).
 */
export type TrafficClassInfo = {
  readonly lapTimeByClass: Readonly<Record<string, number>>;
  readonly classByCarIdx: readonly number[];
};

/** Which tier timed a car: the landmark's own time, the class curve, or the scaled player-class reference. */
export type TrafficReferenceSourceName = "landmark" | "curve" | "scaled";

/**
 * One way to answer "class C's reference time at P". The caller hands
 * {@link computeTrafficArrivals} an ordered list; the first that answers for
 * a car's class times that car.
 */
export type TrafficReferenceSource = {
  readonly name: TrafficReferenceSourceName;
  /** Class `classId`'s reference time at P, seconds; `null` when this source cannot say. */
  readonly referenceAt: (classId: number) => number | null;
};

/**
 * Why a candidate car has no arrival time: the target position is not a lap
 * position (`noTarget`), the car's own `CarIdxLapDistPct` is not one either
 * though not negative — past 1 by more than {@link TRAFFIC_LINE_OVERSHOOT_PCT},
 * or infinite (`noPosition`), no class for the car (`noClass`), no valid
 * `CarIdxEstTime` (`noEstTime`), no source answered for its class
 * (`noReference`), or it is ahead of P on the lap and its class's lap is
 * unknown, so its next visit cannot be timed (`noClassLap`).
 */
export type TrafficUntimedReason = "noTarget" | "noPosition" | "noClass" | "noEstTime" | "noReference" | "noClassLap";

/** One candidate car's arrival at P: in `seconds`, timed by `source`, or untimed for `reason`. */
export type TrafficArrival =
  | {
      readonly carIdx: number;
      readonly classId: number;
      readonly timed: true;
      readonly seconds: number;
      readonly source: TrafficReferenceSourceName;
    }
  | {
      readonly carIdx: number;
      readonly classId: number | null;
      readonly timed: false;
      readonly reason: TrafficUntimedReason;
    };

/** A car the model timed: its arrival in `seconds`, and the source that timed it. */
export type TimedArrival = Extract<TrafficArrival, { timed: true }>;

/** A candidate car no source could time, with the reason. */
export type UntimedArrival = Extract<TrafficArrival, { timed: false }>;

/** The line itself: the reference time restarts at 0 there, so it is a sample every curve has. */
const LINE: Readonly<TrafficCurveBin> = { pct: 0, estTime: 0, samples: 1 };

/** A number that is neither `NaN` nor infinite. Shared by the traffic modules. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A lap position: a number in [0, 1), so neither `NaN`, the sim's −1 for a car not in world, nor 1. Shared by the traffic modules. */
export function isLapFraction(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value < 1;
}

/**
 * How far past 1 (lap fraction) a `CarIdxLapDistPct` reading still counts as
 * the start/finish line itself: a thousandth of the lap, a few metres. The sim
 * reads a car on the line as 1 or a hair past it, its `CarIdxEstTime` already
 * restarted (1.00001 and 1.0000126 measured; module header), so such a reading
 * is that hair past 0. Anything farther past 1 is no lap position.
 */
export const TRAFFIC_LINE_OVERSHOOT_PCT = 0.001;

/**
 * A `CarIdxLapDistPct` reading as a lap position in [0, 1): itself in [0, 1);
 * 1, or at most {@link TRAFFIC_LINE_OVERSHOOT_PCT} past it, as that much past 0
 * (the line, module header); `null` for anything else — the sim's −1 for a car
 * not in world, any negative, `NaN`, an infinity, a value clearly past 1, a
 * non-number. The one rule every traffic module reads the line by.
 */
export function normalizeLapPosition(value: unknown): number | null {
  if (typeof value !== "number" || !(value >= 0)) return null;

  if (value < 1) return value;

  return value - 1 <= TRAFFIC_LINE_OVERSHOOT_PCT ? value - 1 : null;
}

/** How long since `since` (ms); a clock that stepped back counts as just now. Shared by the traffic detectors. */
export function elapsed(now: number, since: number): number {
  return Math.max(0, now - since);
}

function isReferenceTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isClassId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function binIndex(pct: number): number {
  return Math.min(TRAFFIC_CURVE_BINS - 1, Math.floor(pct * TRAFFIC_CURVE_BINS));
}

/**
 * The class lap times and each car's class from the session info, `null`
 * without a `DriverInfo.Drivers` list. A driver entry with a malformed car
 * index, class id or lap time contributes what is valid in it. Pure: the
 * translator memoises it per session-info object.
 */
export function resolveTrafficClassInfo(sessionInfo: Record<string, unknown> | null): TrafficClassInfo | null {
  const driverInfo = sessionInfo?.DriverInfo as Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers;

  if (!Array.isArray(drivers)) return null;

  const lapTimeByClass: Record<string, number> = {};
  const classByCarIdx: number[] = [];

  for (const driver of drivers as unknown[]) {
    if (typeof driver !== "object" || driver === null) continue;

    const { CarIdx: carIdx, CarClassID: classId, CarClassEstLapTime: lapTime } = driver as Record<string, unknown>;

    if (!isClassId(classId)) continue;

    if (typeof lapTime === "number" && Number.isFinite(lapTime) && lapTime > 0 && !(classId in lapTimeByClass)) {
      lapTimeByClass[classId] = lapTime;
    }

    if (isClassId(carIdx)) {
      while (classByCarIdx.length <= carIdx) classByCarIdx.push(-1);

      classByCarIdx[carIdx] = classId;
    }
  }

  return { lapTimeByClass, classByCarIdx };
}

/**
 * A car's class: its `CarIdxClass`, else its `CarClassID` from the session
 * info (the pace car), else `null`.
 */
export function resolveCarClassId(
  telemetry: Pick<TelemetryData, "CarIdxClass">,
  classes: TrafficClassInfo | null,
  carIdx: number,
): number | null {
  const fromTelemetry = telemetry.CarIdxClass?.[carIdx];

  if (isClassId(fromTelemetry)) return fromTelemetry;

  const fromSession = classes?.classByCarIdx[carIdx];

  return isClassId(fromSession) ? fromSession : null;
}

/** Folds one sample into its bin's running mean; the bin is created with the sample. */
function foldCurveSample(curve: TrafficReferenceCurve, pct: number, estTime: number): void {
  const index = binIndex(pct);
  const bin = curve.bins[index];

  if (bin === null || bin === undefined) {
    curve.bins[index] = { pct, estTime, samples: 1 };

    return;
  }

  const samples = Math.min(bin.samples + 1, TRAFFIC_CURVE_SAMPLE_CAP);

  bin.pct += (pct - bin.pct) / samples;
  bin.estTime += (estTime - bin.estTime) / samples;
  bin.samples = samples;
}

/** The outer emit a unit runner is handed by a step that publishes nothing. */
function ignoreEvent(): void {}

/** A car's window starting at `pct` and `sessionTime`, with no rate yet. */
function seedMotion(pct: number, sessionTime: number): TrafficCarMotion {
  return { fromPct: pct, fromTime: sessionTime, rate: null, rateAt: null };
}

/**
 * One reading of a car's progress (module header): the window it is in, or
 * the rate that window measured and the next window starting here. Returns the
 * car's new record, or `prev` itself when nothing changes.
 */
function nextMotion(
  prev: TrafficCarMotion | undefined,
  pct: number,
  sessionTime: number,
  trackLengthMeters: number | null,
): TrafficCarMotion {
  if (prev === undefined) return seedMotion(pct, sessionTime);

  const span = sessionTime - prev.fromTime;

  // `SessionTime` repeats a value for a tick now and then (#1112's capture
  // review): no time passed, so nothing was measured.
  if (span === 0) return prev;

  // A clock that went backwards, or a car unread for longer than a window
  // can span: start again here, with no rate.
  if (!(span > 0) || span > TRAFFIC_MOTION_MAX_AGE_S) return seedMotion(pct, sessionTime);

  if (span < TRAFFIC_MOTION_WINDOW_S) return prev;

  // The shorter way round the lap, so a car crossing the line moves by its
  // few metres, not by a lap.
  const delta = pitLaneSignedDeltaPct(prev.fromPct, pct);

  // Without a track length no move can be judged plausible; a tow or a reset
  // moves a car faster than any car drives.
  if (trackLengthMeters === null || !(trackLengthMeters > 0)) return seedMotion(pct, sessionTime);

  if (Math.abs(delta) * trackLengthMeters > TRAFFIC_MOTION_MAX_PLAUSIBLE_MPS * span) {
    return seedMotion(pct, sessionTime);
  }

  return { fromPct: pct, fromTime: sessionTime, rate: delta / span, rateAt: sessionTime };
}

/**
 * The live-tick update: every car on the racing surface (`OnTrack` or
 * `OffTrack`) with a class, a position in [0, 1) and a finite non-negative
 * `CarIdxEstTime` is a sample of its class's curve, the player's car and the
 * pace car included. Never a pit-lane car. A class gets its curve with its
 * first sample. Every car on the racing surface at a position in [0, 1) is
 * also a reading of its progress (module header), on `SessionTime`; a tick
 * without one measures nothing. Writes the slice in place. The cars are
 * independent, so each is one unit of `runUnit` (#1559): a car whose unit
 * throws loses that car's sample and reading this tick and no other car's,
 * and its progress record, written last, is left as it was.
 *
 * @param trackLengthMeters - `WeekendInfo.TrackLength` in metres (`resolveTrackLengthMeters`), `null` while unknown, which measures no rate: no move can be judged plausible without it.
 * @param runUnit - Runs each car as a unit: the translator's step runner, so one car's throw costs that car only. Defaults to {@link runUnitsDirectly}, which catches nothing
 */
export function updateTrafficReferenceCurves(
  slice: TrafficArrivalState,
  telemetry: TrafficTelemetry,
  classes: TrafficClassInfo | null,
  trackLengthMeters: number | null,
  runUnit: UnitRunner = runUnitsDirectly,
): void {
  const pcts = telemetry.CarIdxLapDistPct;
  const estTimes = telemetry.CarIdxEstTime;
  const surfaces = telemetry.CarIdxTrackSurface;

  if (!Array.isArray(pcts) || !Array.isArray(estTimes) || !Array.isArray(surfaces)) return;

  const sessionTime = isFiniteNumber(telemetry.SessionTime) ? telemetry.SessionTime : null;

  // The car the unit below reads, set by the loop: one closure per tick rather
  // than one per car. It emits nothing.
  let carIdx = 0;
  const unit = (): void => {
    const pct = pcts[carIdx];

    if (!isRacingSurface(surfaces[carIdx]) || !isLapFraction(pct)) return;

    const estTime = estTimes[carIdx];
    const classId = isReferenceTime(estTime) ? resolveCarClassId(telemetry, classes, carIdx) : null;

    if (classId !== null) {
      const key = String(classId);
      const curve = (slice.curves[key] ??= {
        bins: new Array<TrafficCurveBin | null>(TRAFFIC_CURVE_BINS).fill(null),
      });

      foldCurveSample(curve, pct, estTime as number);
    }

    // The car's progress record last (#1559's rule), so a throw above leaves
    // its window as it was and the car is read again on the next tick.
    if (sessionTime !== null)
      slice.motion[carIdx] = nextMotion(slice.motion[carIdx], pct, sessionTime, trackLengthMeters);
  };

  for (carIdx = 0; carIdx < pcts.length; carIdx++) runUnit(ignoreEvent, unit);
}

/**
 * Whether a car is known to be standing still (module header): its last rate,
 * no older than {@link TRAFFIC_MOTION_MAX_AGE_S}, times the track length, is
 * under {@link TRAFFIC_CRAWL_MPS} — a car going backwards included. Anything
 * not known — no reading yet, no rate, a stale one, no `SessionTime` or no
 * track length — is `false`: the car counts as moving, the cautious direction.
 */
export function isTrafficCarStationary(
  slice: Readonly<TrafficArrivalState>,
  carIdx: number,
  sessionTime: number | null,
  trackLengthMeters: number | null,
): boolean {
  if (sessionTime === null || trackLengthMeters === null || !(trackLengthMeters > 0)) return false;

  const motion = slice.motion[carIdx];

  if (motion === undefined || motion.rate === null || motion.rateAt === null) return false;

  const age = sessionTime - motion.rateAt;

  if (!(age >= 0) || age > TRAFFIC_MOTION_MAX_AGE_S) return false;

  return motion.rate * trackLengthMeters < TRAFFIC_CRAWL_MPS;
}

/**
 * A class curve's reference time at `pct`: the sample there, or the straight
 * line between the nearest sample at or before it and the nearest at or after
 * it when the two are at most {@link TRAFFIC_CURVE_MAX_SPAN_PCT} apart. The
 * line (estTime 0 at 0) stands in for a missing sample before the first bin's;
 * nothing stands in after the last bin's, and no lookup crosses the line,
 * since the time restarts there. `null` for no curve, a position outside
 * [0, 1), or no pair of samples close enough.
 */
export function referenceTimeAt(curve: TrafficReferenceCurve | undefined, pct: number): number | null {
  if (curve === undefined || !isLapFraction(pct)) return null;

  const start = binIndex(pct);
  let lower: TrafficCurveBin | null = null;
  let upper: TrafficCurveBin | null = null;

  for (let i = start; i >= 0 && pct - (i + 1) / TRAFFIC_CURVE_BINS <= TRAFFIC_CURVE_MAX_SPAN_PCT; i--) {
    const bin = curve.bins[i];

    if (bin && bin.pct <= pct) {
      lower = bin;
      break;
    }
  }

  if (lower === null && pct <= TRAFFIC_CURVE_MAX_SPAN_PCT) lower = LINE;

  for (let i = start; i < TRAFFIC_CURVE_BINS && i / TRAFFIC_CURVE_BINS - pct <= TRAFFIC_CURVE_MAX_SPAN_PCT; i++) {
    const bin = curve.bins[i];

    if (bin && bin.pct >= pct) {
      upper = bin;
      break;
    }
  }

  if (lower === null || upper === null) return null;

  const span = upper.pct - lower.pct;

  if (span > TRAFFIC_CURVE_MAX_SPAN_PCT) return null;

  if (span === 0) return lower.estTime;

  return lower.estTime + ((upper.estTime - lower.estTime) * (pct - lower.pct)) / span;
}

/**
 * Where a class curve's reference time reaches the line, extrapolated along
 * the line through its last two samples when both lie within
 * {@link TRAFFIC_CURVE_MAX_SPAN_PCT} of the line and of each other: the
 * reference lap's length, the constant a car past P wraps by. `null` otherwise.
 */
export function curveLapEnd(curve: TrafficReferenceCurve | undefined): number | null {
  if (curve === undefined) return null;

  let last: TrafficCurveBin | null = null;

  for (let i = TRAFFIC_CURVE_BINS - 1; i >= 0 && 1 - (i + 1) / TRAFFIC_CURVE_BINS <= TRAFFIC_CURVE_MAX_SPAN_PCT; i--) {
    const bin = curve.bins[i];

    if (!bin) continue;

    if (last === null) {
      last = bin;
      continue;
    }

    if (last.pct - bin.pct > TRAFFIC_CURVE_MAX_SPAN_PCT) return null;

    const slope = (last.estTime - bin.estTime) / (last.pct - bin.pct);

    if (!(slope > 0)) return null;

    return last.estTime + slope * (1 - last.pct);
  }

  return null;
}

/**
 * The length of class `classId`'s reference lap, the constant a car past P
 * wraps by: the curve's own lap end when it has one, else the class's
 * `CarClassEstLapTime`, else `null`. The curve comes first because
 * `CarClassEstLapTime` is not where `CarIdxEstTime` restarts (0.9 s short at
 * Spa, 1.5 s long for Monza's GTD; module header).
 */
export function resolveClassLapTime(
  slice: Readonly<TrafficArrivalState>,
  classes: TrafficClassInfo | null,
  classId: number,
): number | null {
  const key = String(classId);
  const lapEnd = curveLapEnd(slice.curves[key]);

  if (lapEnd !== null) return lapEnd;

  return classes?.lapTimeByClass[key] ?? null;
}

/**
 * Whether a car at lap position `carPct` must cross the start/finish line
 * before it reaches P (`targetPct`, in [0, 1)): exactly when it is ahead of P
 * on the lap. A position the sim reads as 1 or just past it (on the line, its
 * time already restarted) counts as that hair past 0
 * ({@link normalizeLapPosition}); a reading that is no lap position at all is
 * `false`, so a caller screens those out first. The wrap is decided here, by position,
 * never by the sign of `T(P) − estTime`: each car's estTime carries an offset
 * of its own (±0.2 s typically, about 1 s at worst; module header), so a car
 * just behind P can read a reference time past P's and one just past P a time
 * short of it, and a sign test would put the first a lap away — a false clear
 * — and the second arriving now.
 */
export function crossesLineBefore(carPct: number, targetPct: number): boolean {
  const pct = normalizeLapPosition(carPct);

  return pct !== null && pct > targetPct;
}

/**
 * A car's arrival at P, from its class's reference at P and its own
 * `CarIdxEstTime`, given whether it crosses the line first
 * ({@link crossesLineBefore}). A car that does arrives in
 * `T(P) − estTime + classLap`, and is untimed (`null`) while the class lap is
 * unknown. One that does not arrives in `T(P) − estTime`, needing no lap; a
 * negative value there is the car's own offset with the car right behind P,
 * so it arrives now (`0`). Clamped at 0 on the wrapping side too, for the same
 * offset on a car right behind the line with P right after it.
 */
export function arrivalSeconds(
  referenceAtP: number,
  carEstTime: number,
  crossesLine: boolean,
  classLap: number | null,
): number | null {
  const raw = referenceAtP - carEstTime;

  if (!crossesLine) return Math.max(0, raw);

  if (classLap === null) return null;

  return Math.max(0, raw + classLap);
}

/** Tier (a), pit exit: the landmark's own reference time for the class (its `estTimeByClass`). */
export function landmarkReferenceSource(estTimeByClass: Readonly<Record<string, number>>): TrafficReferenceSource {
  return {
    name: "landmark",
    referenceAt: (classId) => {
      const value = estTimeByClass[String(classId)];

      return isReferenceTime(value) ? value : null;
    },
  };
}

/** Tier (b): the class's learned curve at `pct`. */
export function curveReferenceSource(slice: Readonly<TrafficArrivalState>, pct: number): TrafficReferenceSource {
  return { name: "curve", referenceAt: (classId) => referenceTimeAt(slice.curves[String(classId)], pct) };
}

/**
 * Tier (c): the player's class reference at P, scaled to class C by the ratio
 * of the two classes' `CarClassEstLapTime` (the spec's fallback before C has
 * driven past P). The caller supplies the player-class reference: the
 * player's own `CarIdxEstTime` on rejoin, the landmark's or the curve's value
 * for the player's class at pit exit. The player's own class needs no ratio.
 */
export function scaledReferenceSource(
  playerClassReference: number | null,
  playerClassId: number | null,
  classes: TrafficClassInfo | null,
): TrafficReferenceSource {
  return {
    name: "scaled",
    referenceAt: (classId) => {
      if (!isReferenceTime(playerClassReference) || playerClassId === null) return null;

      if (classId === playerClassId) return playerClassReference;

      const classLap = classes?.lapTimeByClass[String(classId)];
      const playerLap = classes?.lapTimeByClass[String(playerClassId)];

      if (classLap === undefined || playerLap === undefined) return null;

      return (playerClassReference * classLap) / playerLap;
    },
  };
}

/**
 * Every candidate car's arrival at P (`targetPct`, the lap position the
 * sources answer for; module header), or `null` when the telemetry lacks a
 * per-car array the model reads (`CarIdxLapDistPct`, `CarIdxEstTime`,
 * `CarIdxTrackSurface` absent or not an array): no data is not an empty
 * track, so the caller must tell the two apart, and neither detector says
 * clear on `null`. An empty array, from complete data, is no car on track.
 * Each car is timed by the first of `sources` that
 * answers for its class, or untimed with the reason. Whether a car wraps is
 * decided by its position against P ({@link crossesLineBefore}); the wrap
 * adds {@link resolveClassLapTime}. A car standing still
 * ({@link isTrafficCarStationary}) is no candidate: it is left out, and its
 * index added to `stationary` when the caller hands one in, for its log line.
 * A `targetPct` outside [0, 1) times no car (`noTarget`), every candidate
 * still reported. Pure but for `stationary`; reads the slice.
 *
 * @param trackLengthMeters - `WeekendInfo.TrackLength` in metres, `null` while unknown, which leaves no car out: a car's rate means nothing without it.
 * @param stationary - Where the cars left out as standing still are listed, in index order; optional.
 */
export function computeTrafficArrivals(
  slice: Readonly<TrafficArrivalState>,
  targetPct: number,
  sources: readonly TrafficReferenceSource[],
  telemetry: TrafficTelemetry,
  playerCarIdx: number,
  classes: TrafficClassInfo | null,
  trackLengthMeters: number | null,
  stationary?: number[],
): TrafficArrival[] | null {
  const pcts = telemetry.CarIdxLapDistPct;
  const estTimes = telemetry.CarIdxEstTime;
  const surfaces = telemetry.CarIdxTrackSurface;

  if (!Array.isArray(pcts) || !Array.isArray(estTimes) || !Array.isArray(surfaces)) return null;

  const sessionTime = isFiniteNumber(telemetry.SessionTime) ? telemetry.SessionTime : null;
  const arrivals: TrafficArrival[] = [];

  for (let carIdx = 0; carIdx < pcts.length; carIdx++) {
    if (carIdx === playerCarIdx) continue;

    const pct = pcts[carIdx];

    if (!isRacingSurface(surfaces[carIdx]) || typeof pct !== "number" || !(pct >= 0)) continue;

    if (isTrafficCarStationary(slice, carIdx, sessionTime, trackLengthMeters)) {
      stationary?.push(carIdx);
      continue;
    }

    const classId = resolveCarClassId(telemetry, classes, carIdx);

    if (!isLapFraction(targetPct)) {
      arrivals.push({ carIdx, classId, timed: false, reason: "noTarget" });
      continue;
    }

    // A racing-surface car whose position is no lap position cannot be placed
    // against P: untimed, never left out, so it can never be a clear.
    if (normalizeLapPosition(pct) === null) {
      arrivals.push({ carIdx, classId, timed: false, reason: "noPosition" });
      continue;
    }

    arrivals.push(
      timeCar(slice, sources, estTimes[carIdx], crossesLineBefore(pct, targetPct), classId, carIdx, classes),
    );
  }

  return arrivals;
}

function timeCar(
  slice: Readonly<TrafficArrivalState>,
  sources: readonly TrafficReferenceSource[],
  estTime: number | undefined,
  crossesLine: boolean,
  classId: number | null,
  carIdx: number,
  classes: TrafficClassInfo | null,
): TrafficArrival {
  if (classId === null) return { carIdx, classId, timed: false, reason: "noClass" };

  if (!isReferenceTime(estTime)) return { carIdx, classId, timed: false, reason: "noEstTime" };

  for (const source of sources) {
    const reference = source.referenceAt(classId);

    if (reference === null) continue;

    const classLap = crossesLine ? resolveClassLapTime(slice, classes, classId) : null;
    const seconds = arrivalSeconds(reference, estTime, crossesLine, classLap);

    if (seconds === null) return { carIdx, classId, timed: false, reason: "noClassLap" };

    return { carIdx, classId, timed: true, seconds, source: source.name };
  }

  return { carIdx, classId, timed: false, reason: "noReference" };
}
