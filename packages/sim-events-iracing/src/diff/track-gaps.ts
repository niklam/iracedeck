/**
 * Track-order gaps outside a race (issue #1515).
 *
 * In practice, warmup, testing and open qualifying, Session Info's Gaps rows
 * show the cars physically ahead and behind the player on the road, not the
 * class-standings neighbours the race gaps (`gaps.ts`, issue #933) follow.
 * Traffic is traffic whatever its class there: a faster-class car closing
 * from behind is the one a driver most needs to see. This is track order,
 * never a race position (`.claude/rules/race-positions.md`, "Physical track
 * order"): the neighbours come from `findNearestCarOnTrack`, the one
 * track-order primitive, and nothing here sorts cars by lap distance.
 *
 * The gap is the race's crossing time — ahead, how long ago the car ahead
 * passed the player's spot (its trace); behind, how long ago the player
 * passed the spot the car behind is at (the player's trace) — with the
 * race's ETA switch for a crawling leader, through the shared
 * {@link readGapAt}. The traces are keyed on a per-car odometer rather than
 * the lap count, so the caller translates the lookup point onto the leading
 * car's trace by the forward lap fraction between the two. `lapDelta` is
 * always 0: a track neighbour is less than a lap away by construction. The
 * display trend is the race's chain ({@link updateTrendChain}), sampled at
 * the player's odometer.
 *
 * Publishes no bus event, and the Race Engineer never reads it: the
 * `getTrackGaps()` accessor is separate from `getLiveGaps()`, and the two
 * gates are disjoint.
 */
import { appendProgressSample, findNearestCarOnTrack, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import { classifySessionKind } from "../session-kind.js";
import {
  createTrackGapsState,
  type GapNeighborState,
  type TrackGapSideState,
  type TrackGapsState,
  type TranslatorState,
} from "../state.js";
import { classifyTrendChain, GAP_CHECKPOINT_STEP, readGapAt, resetTrendChain, updateTrendChain } from "./gaps.js";
import { resolvePaceCarIdx } from "./pace-laps.js";

/**
 * A per-tick change in `CarIdxLapDistPct` of more than half a lap in either
 * direction is a crossing of the start/finish line (the fraction wrapped),
 * folded by a whole lap — the accrual shape of `pace-laps.ts`.
 */
const TRACK_GAP_LINE_WRAP_THRESHOLD = 0.5;

/**
 * Whether a session gets track-order gaps (issue #1515, spec Decision 1):
 * practice, warmup, testing and open qualifying, by `classifySessionKind`'s
 * table — and not the lone sessions, whose other cars are each on their own
 * run and not on the player's road (a Lone Qualify capture shows seven of
 * them `OnTrack` in telemetry). An allow-list on purpose: a race, a
 * `"Heat Race"`, an empty or unknown session type all answer false.
 */
export function isTrackGapSession(sessionType: string): boolean {
  if (sessionType === "Lone Qualify" || sessionType === "Lone Practice") return false;

  // Called after the replay guard, where no saved replay reaches, so the
  // `SimMode` half of the classifier has nothing to say.
  const kind = classifySessionKind(sessionType, undefined);

  return kind === "test" || kind === "practice" || kind === "qualifying";
}

/** Whether a track surface is pit road (the stall or the approach), judged by `CarIdxTrackSurface`, never `CarIdxOnPitRoad`. */
function isPitSurface(surface: number | undefined): boolean {
  return surface === TrkLoc.InPitStall || surface === TrkLoc.AproachingPits;
}

/** A usable lap-distance fraction: finite and non-negative (`-1` = not in the world). */
function isValidDist(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Car indices `DriverInfo.Drivers` marks as spectators (`IsSpectator === 1`). */
function resolveSpectatorIdxs(sessionInfo: Record<string, unknown> | null): Set<number> {
  const spectators = new Set<number>();
  const drivers = (sessionInfo?.DriverInfo as Record<string, unknown> | undefined)?.Drivers;

  if (!Array.isArray(drivers)) return spectators;

  for (const driver of drivers as Array<Record<string, unknown> | null>) {
    if (driver?.IsSpectator === 1 && typeof driver.CarIdx === "number") spectators.add(driver.CarIdx);
  }

  return spectators;
}

/**
 * Per-tick track-order gaps. Called from the translator's `handleTick` after
 * the replay guard, beside `diffGaps`. Outside {@link isTrackGapSession} the
 * whole store is dropped, so it never grows in a race.
 */
export function diffTrackGaps(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionType: string,
  sessionInfo: Record<string, unknown> | null,
  playerCarIdx: number,
  trackLengthMeters: number | null,
): void {
  if (!isTrackGapSession(sessionType)) {
    if (!isEmpty(state.trackGaps)) state.trackGaps = createTrackGapsState();

    return;
  }

  const store = state.trackGaps;
  const pct = telemetry.CarIdxLapDistPct as number[] | undefined;
  // Finite, not merely numeric: a NaN session time stamped into a trace
  // would surface as a NaN gap.
  const rawSessionTime = telemetry.SessionTime;
  const sessionTime = typeof rawSessionTime === "number" && Number.isFinite(rawSessionTime) ? rawSessionTime : null;

  if (!Array.isArray(pct) || sessionTime === null) {
    // Keep the traces — a brief data gap must not wipe them; only the live
    // snapshots go blank.
    clearLive(store);

    return;
  }

  const surface = telemetry.CarIdxTrackSurface as number[] | undefined;
  const surfaces = Array.isArray(surface) ? surface : null;
  const paceCarIdx = resolvePaceCarIdx(sessionInfo);
  const spectators = resolveSpectatorIdxs(sessionInfo);
  const playerSurface = surfaces
    ? surfaces[playerCarIdx]
    : typeof telemetry.PlayerTrackSurface === "number"
      ? telemetry.PlayerTrackSurface
      : undefined;
  // The player must be on the road (spec Decision 2): in the world, off pit
  // road and in the car. In the pit lane a "car behind" read from the
  // player's pit-lane passage would be badly wrong; in the garage there is
  // no road position at all.
  const playerOnRoad =
    playerCarIdx >= 0 &&
    playerCarIdx < pct.length &&
    telemetry.IsOnTrack !== false &&
    playerSurface !== TrkLoc.NotInWorld &&
    !isPitSurface(playerSurface);

  // 1) Advance every car's odometer and trace. Walk the array to its end —
  // a field can exceed 64 cars — and drop anything past it.
  const carCount = pct.length;

  truncate(store, carCount);

  for (let i = 0; i < carCount; i++) {
    const dist = pct[i];
    const carSurface = surfaces?.[i];
    const onRoad =
      isValidDist(dist) &&
      carSurface !== TrkLoc.NotInWorld &&
      !isPitSurface(carSurface) &&
      i !== paceCarIdx &&
      !spectators.has(i) &&
      (i !== playerCarIdx || playerOnRoad);

    if (!onRoad) {
      // Not on the road this tick: record nothing, and forget the car, so no
      // sample ever bridges an absence or a pit-lane passage — which the
      // trace's own step guard would not catch for a car that re-enters at
      // a plausible distance.
      store.odometers[i] = undefined;
      store.lastDistPct[i] = undefined;
      store.traces[i] = undefined;
      continue;
    }

    const last = store.lastDistPct[i];
    let odometer = store.odometers[i];

    if (odometer === undefined || last === undefined) {
      // First tick on the road: any origin works, since every reading is a
      // difference on one car's own scale.
      odometer = dist;
    } else {
      let delta = dist - last;

      if (delta <= -TRACK_GAP_LINE_WRAP_THRESHOLD) delta += 1;
      else if (delta >= TRACK_GAP_LINE_WRAP_THRESHOLD) delta -= 1;

      odometer += delta;
    }

    store.odometers[i] = odometer;
    store.lastDistPct[i] = dist;

    let trace = store.traces[i];

    if (!trace) {
      trace = [];
      store.traces[i] = trace;
    }

    appendProgressSample(trace, odometer, sessionTime);
  }

  const playerOdometer = playerOnRoad ? store.odometers[playerCarIdx] : undefined;

  if (playerOdometer === undefined) {
    // No road position: no track gaps at all, and the trend chains restart
    // from scratch once the player is back out.
    clearLive(store);
    resetSide(store.ahead, -1);
    resetSide(store.behind, -1);
    store.lastCheckpoint = null;

    return;
  }

  // 2) The cars physically ahead and behind — the pace car, spectators and
  // anything on pit road skipped; an OffTrack car is still traffic.
  const skipIdx = (idx: number): boolean => idx === paceCarIdx || spectators.has(idx) || isPitSurface(surfaces?.[idx]);
  const aheadIdx = findNearestCarOnTrack(telemetry, playerCarIdx, "ahead", { skipIdx }) ?? -1;
  const behindIdx = findNearestCarOnTrack(telemetry, playerCarIdx, "behind", { skipIdx }) ?? -1;

  if (aheadIdx !== store.ahead.carIdx) resetSide(store.ahead, aheadIdx);

  if (behindIdx !== store.behind.carIdx) resetSide(store.behind, behindIdx);

  // 3) The display-trend checkpoint, on the player's odometer. A backwards
  // jump (reversing over a stretch) restarts both chains, as the race does.
  if (store.lastCheckpoint !== null && playerOdometer < store.lastCheckpoint - GAP_CHECKPOINT_STEP) {
    resetTrendChain(store.ahead.trend);
    resetTrendChain(store.behind.trend);
    store.lastCheckpoint = null;
  }

  const checkpointDue = store.lastCheckpoint === null || playerOdometer - store.lastCheckpoint >= GAP_CHECKPOINT_STEP;
  const ctx: SideContext = { store, pct, playerCarIdx, playerOdometer, sessionTime, trackLengthMeters, checkpointDue };

  store.ahead.live = computeSide(ctx, "ahead");
  store.behind.live = computeSide(ctx, "behind");

  if (checkpointDue) store.lastCheckpoint = playerOdometer;
}

/** What one side's computation reads. */
type SideContext = {
  store: TrackGapsState;
  pct: number[];
  playerCarIdx: number;
  playerOdometer: number;
  sessionTime: number;
  trackLengthMeters: number | null;
  checkpointDue: boolean;
};

/** One side's live snapshot, maintaining its trend chain. */
function computeSide(ctx: SideContext, side: "ahead" | "behind"): GapNeighborState | null {
  const sideState = side === "ahead" ? ctx.store.ahead : ctx.store.behind;
  const idx = sideState.carIdx;

  if (idx < 0) return null;

  const neighborOdometer = ctx.store.odometers[idx];
  const neighborDist = ctx.pct[idx];
  const playerDist = ctx.pct[ctx.playerCarIdx];

  if (neighborOdometer === undefined || !isValidDist(neighborDist) || !isValidDist(playerDist)) {
    // Defensive: every candidate `findNearestCarOnTrack` accepts past the
    // skip filter is one step 1 gave an odometer, by the same in-world and
    // pit-road tests. Should the two ever disagree, hold identity and show
    // no number rather than read a trace that is not there.
    if (ctx.checkpointDue) resetTrendChain(sideState.trend);

    return { carIdx: idx, gapSeconds: null, lapDelta: 0, trend: null };
  }

  // The forward lap fraction from the chaser to the leader, across the line
  // when it lies between them. Ahead the leader is the neighbour; behind it
  // is the player. The lookup is where the chaser stands, translated onto
  // the leader's own odometer: the leader's odometer minus that fraction.
  const separation = side === "ahead" ? (neighborDist - playerDist + 1) % 1 : (playerDist - neighborDist + 1) % 1;
  const reading =
    side === "ahead"
      ? readGapAt({
          leaderTrace: ctx.store.traces[idx],
          leaderProgress: neighborOdometer,
          chaserTrace: ctx.store.traces[ctx.playerCarIdx],
          chaserProgress: ctx.playerOdometer,
          lookupProgress: neighborOdometer - separation,
          separationLaps: separation,
          sessionTime: ctx.sessionTime,
          trackLengthMeters: ctx.trackLengthMeters,
        })
      : readGapAt({
          leaderTrace: ctx.store.traces[ctx.playerCarIdx],
          leaderProgress: ctx.playerOdometer,
          chaserTrace: ctx.store.traces[idx],
          chaserProgress: neighborOdometer,
          lookupProgress: ctx.playerOdometer - separation,
          separationLaps: separation,
          sessionTime: ctx.sessionTime,
          trackLengthMeters: ctx.trackLengthMeters,
        });
  const gapSeconds = reading.gapSeconds !== null && Number.isFinite(reading.gapSeconds) ? reading.gapSeconds : null;
  let trend: GapNeighborState["trend"] = null;

  if (reading.etaReading && gapSeconds !== null) {
    // Closing on a crawling leader by construction — the trend IS
    // "closing", and the chain restarts clean so a cross-regime delta never
    // poisons the smoothed rate (as in the race).
    resetTrendChain(sideState.trend);
    trend = "closing";
  } else if (gapSeconds !== null) {
    if (ctx.checkpointDue) updateTrendChain(sideState.trend, ctx.playerOdometer, gapSeconds);

    trend = classifyTrendChain(sideState.trend);
  } else if (ctx.checkpointDue) {
    // A due checkpoint the side cannot sample breaks the chain.
    resetTrendChain(sideState.trend);
  }

  return { carIdx: idx, gapSeconds, lapDelta: 0, trend };
}

/** A side's neighbour changed (or the player left the road): new identity, fresh chain, no snapshot. */
function resetSide(side: TrackGapSideState, carIdx: number): void {
  side.carIdx = carIdx;
  side.live = null;
  resetTrendChain(side.trend);
}

/** Blank both live snapshots. */
function clearLive(store: TrackGapsState): void {
  store.ahead.live = null;
  store.behind.live = null;
}

/** Drop the per-car entries past the end of this tick's arrays. */
function truncate(store: TrackGapsState, carCount: number): void {
  if (store.odometers.length > carCount) store.odometers.length = carCount;

  if (store.lastDistPct.length > carCount) store.lastDistPct.length = carCount;

  if (store.traces.length > carCount) store.traces.length = carCount;
}

/** Whether the store holds nothing a fresh one would not. */
function isEmpty(store: TrackGapsState): boolean {
  return (
    store.traces.length === 0 &&
    store.odometers.length === 0 &&
    store.ahead.carIdx < 0 &&
    store.behind.carIdx < 0 &&
    store.ahead.live === null &&
    store.behind.live === null &&
    store.lastCheckpoint === null
  );
}
