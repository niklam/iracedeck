/**
 * Gap tracking diff (issue #933).
 *
 * Owns the stateful side of the crossing-time gap model: records every live
 * car's progress→SessionTime trace each tick, resolves the player's
 * class-standings neighbors from the canonical frozen order, computes the
 * live gaps the `getLiveGaps()` accessor exposes, maintains the continuous
 * display trend (gap now vs. one lap ago at the same track position), and
 * emits the `gap.trendChanged` / `gap.thresholdCrossed` callout events.
 *
 * All math primitives are pure and live in `@iracedeck/iracing-sdk`
 * `gap-utils.ts`; this module only sequences them against state.
 */
import {
  appendProgressSample,
  classifyGapTrend,
  crossingTimeAt,
  type GapTrendDirection,
  isPreGreen,
  lapDeltaBetween,
  resolveClassNeighbors,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";

import type { GapNeighborState, TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/** Deadband for the continuous display trend (larger — it updates every tick). */
export const GAP_DISPLAY_TREND_DEADBAND_S = 0.3;
/** Deadband for the lap-over-lap callout trend. */
export const GAP_CALLOUT_TREND_DEADBAND_S = 0.2;
/** A threshold episode re-arms once the gap exceeds threshold + this margin. */
export const GAP_THRESHOLD_HYSTERESIS_S = 0.5;
/** Player-progress spacing (laps) between display-trend checkpoints. */
export const GAP_CHECKPOINT_STEP = 0.02;
/** Fallback alert threshold when no resolver is wired (seconds). */
export const GAP_DEFAULT_ALERT_THRESHOLD_S = 1.0;

/** Checkpoint ring capacity: one lap of checkpoints plus margin. */
const GAP_CHECKPOINT_CAP = Math.ceil(1.05 / GAP_CHECKPOINT_STEP) + 2;
/** Oldest usable checkpoint age (laps) for the one-lap-ago comparison. */
const GAP_CHECKPOINT_MAX_AGE_LAPS = 1.1;

type Side = "ahead" | "behind";

/**
 * Per-tick gap tracking. Called from the translator's `handleTick` after the
 * frozen positions are computed (the same canonical array `diffOvertakes`
 * consumes). `paceCarIdx` is excluded from neighbor resolution explicitly —
 * the canonical order has no pace-car filter of its own.
 */
export function diffGaps(
  state: TranslatorState,
  telemetry: TelemetryData,
  isRaceSession: boolean,
  playerCarIdx: number,
  paceCarIdx: number | null,
  frozenPositions: number[] | null,
  getThresholdSeconds: () => number,
  emit: EmitFn,
): void {
  const lc = telemetry.CarIdxLapCompleted as number[] | undefined;
  const pct = telemetry.CarIdxLapDistPct as number[] | undefined;
  const sessionTime = typeof telemetry.SessionTime === "number" ? telemetry.SessionTime : null;
  const playerRacing = !(typeof telemetry.LapCompleted === "number" && telemetry.LapCompleted < 0);

  if (
    !isRaceSession ||
    !Array.isArray(lc) ||
    !Array.isArray(pct) ||
    sessionTime === null ||
    playerCarIdx < 0 ||
    frozenPositions === null ||
    isPreGreen(telemetry) ||
    !playerRacing
  ) {
    // Keep the traces — a brief gate flicker must not wipe a lap of history
    // (session change recreates the whole state anyway). Only the live
    // snapshots go blank.
    state.gapLiveAhead = null;
    state.gapLiveBehind = null;

    return;
  }

  // 1) Record every live car's progress trace.
  const carCount = Math.min(lc.length, pct.length);

  for (let i = 0; i < carCount; i++) {
    const laps = lc[i]!;
    const dist = pct[i]!;

    if (laps < 0 || dist < 0) continue;

    let trace = state.gapTraces[i];

    if (!trace) {
      trace = [];
      state.gapTraces[i] = trace;
    }

    appendProgressSample(trace, laps + dist, sessionTime);
  }

  const playerLc = lc[playerCarIdx];
  const playerPct = pct[playerCarIdx];

  if (playerLc === undefined || playerLc < 0 || playerPct === undefined || playerPct < 0) {
    state.gapLiveAhead = null;
    state.gapLiveBehind = null;

    return;
  }

  const playerProgress = playerLc + playerPct;

  // 2) Resolve neighbors from the canonical order; identity change resets a side.
  const neighbors = resolveClassNeighbors(
    frozenPositions,
    telemetry.CarIdxClass as number[] | undefined,
    playerCarIdx,
    paceCarIdx,
  );

  if (neighbors.aheadIdx !== state.gapAheadIdx) {
    resetSideState(state, "ahead");
    state.gapAheadIdx = neighbors.aheadIdx;
  }

  if (neighbors.behindIdx !== state.gapBehindIdx) {
    resetSideState(state, "behind");
    state.gapBehindIdx = neighbors.behindIdx;
  }

  // 3) Compute the live gap per side (forward-only crossing-time model).
  const playerPaused = telemetry.OnPitRoad === true || telemetry.IsOnTrack === false;
  const checkpointDue =
    state.gapLastCheckpointProgress < 0 || playerProgress - state.gapLastCheckpointProgress >= GAP_CHECKPOINT_STEP;

  state.gapLiveAhead = computeSide(
    state,
    telemetry,
    "ahead",
    playerCarIdx,
    playerProgress,
    sessionTime,
    playerPaused,
    checkpointDue,
  );
  state.gapLiveBehind = computeSide(
    state,
    telemetry,
    "behind",
    playerCarIdx,
    playerProgress,
    sessionTime,
    playerPaused,
    checkpointDue,
  );

  if (checkpointDue) state.gapLastCheckpointProgress = playerProgress;

  // 4) Lap-over-lap callout sampling + threshold episodes.
  maybeEmitCalloutEvents(state, telemetry, playerPaused, getThresholdSeconds, emit);
}

/** Compute one side's live snapshot, maintaining its checkpoint ring. */
function computeSide(
  state: TranslatorState,
  telemetry: TelemetryData,
  side: Side,
  playerCarIdx: number,
  playerProgress: number,
  sessionTime: number,
  playerPaused: boolean,
  checkpointDue: boolean,
): GapNeighborState | null {
  const idx = side === "ahead" ? state.gapAheadIdx : state.gapBehindIdx;

  if (idx < 0) return null;

  const lc = telemetry.CarIdxLapCompleted as number[];
  const pct = telemetry.CarIdxLapDistPct as number[];
  const neighborLc = lc[idx];
  const neighborPct = pct[idx];

  if (neighborLc === undefined || neighborLc < 0 || neighborPct === undefined || neighborPct < 0) {
    // Neighbor has no live progress this tick (blink / not in world) — hold
    // identity but show no numbers.
    return { carIdx: idx, gapSeconds: null, lapDelta: 0, trend: null };
  }

  const neighborProgress = neighborLc + neighborPct;
  const lapDelta =
    side === "ahead"
      ? lapDeltaBetween(neighborProgress, playerProgress)
      : lapDeltaBetween(playerProgress, neighborProgress);

  let gapSeconds: number | null = null;

  if (lapDelta === 0) {
    // Ahead: how long ago did the neighbor cross MY position (their trace).
    // Behind: how long ago did I cross the neighbor's position (my trace).
    const trace = side === "ahead" ? state.gapTraces[idx] : state.gapTraces[playerCarIdx];
    const lookupProgress = side === "ahead" ? playerProgress : neighborProgress;
    const crossed = trace ? crossingTimeAt(trace, lookupProgress) : null;

    if (crossed !== null) gapSeconds = Math.max(0, sessionTime - crossed);
  }

  const suppressed = playerPaused || neighborSuppressed(telemetry, idx);
  const checkpoints = side === "ahead" ? state.gapCheckpointsAhead : state.gapCheckpointsBehind;
  let trend: GapTrendDirection | null = null;

  if (!suppressed && lapDelta === 0 && gapSeconds !== null) {
    // Continuous display trend: compare against the checkpoint nearest one
    // full lap back — same track position, so track-shape noise cancels.
    let reference: { progress: number; gapSeconds: number } | null = null;

    for (let i = checkpoints.length - 1; i >= 0; i--) {
      if (checkpoints[i]!.progress <= playerProgress - 1) {
        reference = checkpoints[i]!;
        break;
      }
    }

    if (reference !== null && playerProgress - reference.progress <= GAP_CHECKPOINT_MAX_AGE_LAPS) {
      trend = classifyGapTrend(gapSeconds - reference.gapSeconds, GAP_DISPLAY_TREND_DEADBAND_S);
    }

    if (checkpointDue) {
      checkpoints.push({ progress: playerProgress, gapSeconds });

      if (checkpoints.length > GAP_CHECKPOINT_CAP) checkpoints.splice(0, checkpoints.length - GAP_CHECKPOINT_CAP);
    }
  }

  return { carIdx: idx, gapSeconds, lapDelta, trend };
}

/** Whether the neighbor's own state suppresses trend/threshold processing. */
function neighborSuppressed(telemetry: TelemetryData, idx: number): boolean {
  const onPitRoad = telemetry.CarIdxOnPitRoad as boolean[] | undefined;
  const surface = telemetry.CarIdxTrackSurface as number[] | undefined;

  if (Array.isArray(onPitRoad) && onPitRoad[idx] === true) return true;

  if (Array.isArray(surface) && surface[idx] === TrkLoc.NotInWorld) return true;

  return false;
}

/** Reset one side's trend/threshold state (neighbor identity changed). */
function resetSideState(state: TranslatorState, side: Side): void {
  if (side === "ahead") {
    state.gapCheckpointsAhead = [];
    state.gapLapSampleAhead = null;
    state.gapPrevLapDirectionAhead = null;
    state.gapAnnouncedDirectionAhead = null;
    state.gapThresholdArmedAhead = false;
  } else {
    state.gapCheckpointsBehind = [];
    state.gapLapSampleBehind = null;
    state.gapPrevLapDirectionBehind = null;
    state.gapAnnouncedDirectionBehind = null;
    state.gapThresholdArmedBehind = false;
  }
}

/**
 * Lap-over-lap trend sampling + threshold episodes (issue #933).
 *
 * Trend: the gap is sampled at each player lap completion; a direction
 * (closing/opening, 0.2 s deadband) that differs from the last announced one
 * and holds for 2 consecutive laps emits `gap.trendChanged`. Threshold: an
 * episode arms only once the gap has been seen beyond threshold + hysteresis
 * (so a nose-to-tail start can't fire at the green), fires
 * `gap.thresholdCrossed` once when the live gap first drops below the
 * threshold, and re-arms only past the hysteresis point. Both are silent
 * while either car is on pit road / off track and for lapped neighbors.
 */
function maybeEmitCalloutEvents(
  state: TranslatorState,
  telemetry: TelemetryData,
  playerPaused: boolean,
  getThresholdSeconds: () => number,
  emit: EmitFn,
): void {
  processThresholdEpisode(state, telemetry, "ahead", playerPaused, getThresholdSeconds, emit);
  processThresholdEpisode(state, telemetry, "behind", playerPaused, getThresholdSeconds, emit);

  const lapCompleted = typeof telemetry.LapCompleted === "number" ? telemetry.LapCompleted : -1;

  if (lapCompleted < 0 || lapCompleted === state.gapLastLapCompleted) return;

  const seeding = state.gapLastLapCompleted < 0;

  state.gapLastLapCompleted = lapCompleted;
  processLapSample(state, telemetry, "ahead", lapCompleted, playerPaused, seeding, emit);
  processLapSample(state, telemetry, "behind", lapCompleted, playerPaused, seeding, emit);
}

/** Capture one side's lap sample and emit a sustained trend flip. */
function processLapSample(
  state: TranslatorState,
  telemetry: TelemetryData,
  side: Side,
  lapCompleted: number,
  playerPaused: boolean,
  seeding: boolean,
  emit: EmitFn,
): void {
  const live = side === "ahead" ? state.gapLiveAhead : state.gapLiveBehind;
  const idx = side === "ahead" ? state.gapAheadIdx : state.gapBehindIdx;
  const suppressed = playerPaused || (idx >= 0 && neighborSuppressed(telemetry, idx));

  if (!live || idx < 0 || suppressed || live.lapDelta !== 0 || live.gapSeconds === null) {
    // The lap-over-lap series is broken — a comparison across the break
    // would attribute pit/tow time to pace. Start fresh next lap.
    setLapSample(state, side, null);
    setPrevLapDirection(state, side, null);

    return;
  }

  const prevSample = side === "ahead" ? state.gapLapSampleAhead : state.gapLapSampleBehind;

  setLapSample(state, side, live.gapSeconds);

  if (seeding || prevSample === null) {
    setPrevLapDirection(state, side, null);

    return;
  }

  const direction = classifyGapTrend(live.gapSeconds - prevSample, GAP_CALLOUT_TREND_DEADBAND_S);
  const prevDirection = side === "ahead" ? state.gapPrevLapDirectionAhead : state.gapPrevLapDirectionBehind;
  const announced = side === "ahead" ? state.gapAnnouncedDirectionAhead : state.gapAnnouncedDirectionBehind;

  if ((direction === "closing" || direction === "opening") && direction === prevDirection && direction !== announced) {
    emit({
      event: "gap.trendChanged",
      data: {
        side,
        direction,
        gapSeconds: live.gapSeconds,
        previousGapSeconds: prevSample,
        carIdx: idx,
        lap: lapCompleted,
      },
    });

    if (side === "ahead") state.gapAnnouncedDirectionAhead = direction;
    else state.gapAnnouncedDirectionBehind = direction;
  }

  setPrevLapDirection(state, side, direction);
}

/** Arm/fire one side's threshold episode against the live gap. */
function processThresholdEpisode(
  state: TranslatorState,
  telemetry: TelemetryData,
  side: Side,
  playerPaused: boolean,
  getThresholdSeconds: () => number,
  emit: EmitFn,
): void {
  const live = side === "ahead" ? state.gapLiveAhead : state.gapLiveBehind;
  const idx = side === "ahead" ? state.gapAheadIdx : state.gapBehindIdx;

  if (!live || idx < 0 || live.lapDelta !== 0 || live.gapSeconds === null) return;

  if (playerPaused || neighborSuppressed(telemetry, idx)) {
    // A pit visit invalidates the episode — the huge, fast-moving gap of a
    // car serving a stop must not fire a crossing on rejoin.
    if (side === "ahead") state.gapThresholdArmedAhead = false;
    else state.gapThresholdArmedBehind = false;

    return;
  }

  const armed = side === "ahead" ? state.gapThresholdArmedAhead : state.gapThresholdArmedBehind;
  const threshold = getThresholdSeconds();

  if (!armed) {
    if (live.gapSeconds > threshold + GAP_THRESHOLD_HYSTERESIS_S) {
      if (side === "ahead") state.gapThresholdArmedAhead = true;
      else state.gapThresholdArmedBehind = true;
    }

    return;
  }

  if (live.gapSeconds < threshold) {
    emit({
      event: "gap.thresholdCrossed",
      data: { side, gapSeconds: live.gapSeconds, thresholdSeconds: threshold, carIdx: idx },
    });

    if (side === "ahead") state.gapThresholdArmedAhead = false;
    else state.gapThresholdArmedBehind = false;
  }
}

function setLapSample(state: TranslatorState, side: Side, value: number | null): void {
  if (side === "ahead") state.gapLapSampleAhead = value;
  else state.gapLapSampleBehind = value;
}

function setPrevLapDirection(state: TranslatorState, side: Side, value: GapTrendDirection | null): void {
  if (side === "ahead") state.gapPrevLapDirectionAhead = value;
  else state.gapPrevLapDirectionBehind = value;
}
