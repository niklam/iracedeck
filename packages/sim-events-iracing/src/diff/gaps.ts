/**
 * Gap tracking diff (issue #933).
 *
 * Owns the stateful side of the crossing-time gap model: records every live
 * car's progress→SessionTime trace each tick, resolves the player's
 * class-standings neighbors from the canonical frozen order, computes the
 * live gaps the `getLiveGaps()` accessor exposes (switching to a chaser-ETA
 * reading when the pair's leading car is stopped/crawling), maintains the
 * continuous display trend (a smoothed gap-rate EMA), and emits the
 * relevance-driven `gap.trendChanged` / `gap.thresholdCrossed` events.
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
  recentProgressRate,
  resolveClassNeighbors,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";

import type { GapNeighborState, TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/**
 * Deadband for the continuous display trend, in seconds-per-lap of smoothed
 * gap rate. Rates inside it render "steady".
 */
export const GAP_DISPLAY_TREND_DEADBAND_S = 0.15;
/** Minimum sustained closing rate (s/lap) before a contact projection exists. */
export const GAP_CLOSING_MIN_RATE_S_PER_LAP = 0.2;
/**
 * Closing announcements fire when the projected contact is within this many
 * laps (and within the laps actually remaining) — "someone is eating a 10 s
 * gap" is news, "someone gains 2 s/lap on a 30 s gap with 5 laps left" is
 * not (issue #933 follow-up).
 */
export const GAP_CONTACT_HORIZON_LAPS = 8;
/** A closing threat re-announces when its projection halves since the last call. */
export const GAP_CONTACT_REANNOUNCE_FACTOR = 0.5;
/** Minimum opening rate (s/lap) for a breakaway announcement. */
export const GAP_BREAKAWAY_MIN_RATE_S_PER_LAP = 0.5;
/** Breakaways only matter while the gap is still battle-sized (seconds). */
export const GAP_BREAKAWAY_MAX_GAP_S = 10;
/** A breakaway episode re-arms once the pair closes back under this (seconds). */
export const GAP_BREAKAWAY_REARM_GAP_S = 5;
/**
 * Default minimum gap movement (seconds) since a side's last trend
 * announcement before another may fire — the anti-ping-pong gate
 * (issue #933 follow-up). User-configurable via
 * `gapCalloutMinChangeSeconds`; 0 disables.
 */
export const GAP_DEFAULT_MIN_CHANGE_S = 1.5;
/**
 * Assumed grid spacing (seconds) between standings neighbors at the race
 * start (issue #933 follow-up). On lap 1, a side with no announcement
 * history uses this as its movement-gate baseline — being ~this close off
 * the start is expected, not news.
 */
export const GAP_ASSUMED_START_SPACING_S = 0.7;
/** A threshold episode re-arms once the gap exceeds threshold + this margin. */
export const GAP_THRESHOLD_HYSTERESIS_S = 0.5;
/** Player-progress spacing (laps) between display-trend rate samples. */
export const GAP_CHECKPOINT_STEP = 0.02;
/** Fallback alert threshold when no resolver is wired (seconds). */
export const GAP_DEFAULT_ALERT_THRESHOLD_S = 1.0;

/** Window (s) for measuring a car's recent progress rate. */
const GAP_RATE_WINDOW_S = 3;
/**
 * ETA-regime switch (issue #933 follow-up: a stopped player's behind gap
 * froze while the pursuers physically closed): when the LEADING car of a
 * pair is this much slower than the chaser, the crossing-time gap no longer
 * tracks the pair's true time-distance (both `now` and the lookup advance at
 * the chaser's pace), so the gap becomes the chaser's ETA over the
 * separation at its current pace — counting down as it closes.
 */
const GAP_ETA_LEADER_SLOW_FACTOR = 0.5;
/** Minimum chaser rate (laps/s) for the ETA regime — both-cars-stopped stays crossing-time. */
const GAP_ETA_CHASER_MIN_RATE = 0.002;

/** EMA smoothing factor for the display gap rate (~last third of a lap). */
const GAP_TREND_EMA_ALPHA = 0.15;
/** Rate samples required before the display trend classifies. ~0.1 lap. */
const GAP_TREND_MIN_SAMPLES = 5;
/** A sampling break wider than this (laps) restarts the rate chain. */
const GAP_TREND_MAX_STEP_LAPS = 0.1;
/** Single rate samples beyond this (s/lap) are glitches — skipped. */
const GAP_TREND_MAX_RATE_S_PER_LAP = 20;

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
  /**
   * Estimated laps left in the race (fractional; null = unknown/unlimited).
   * Caps the closing-announcement horizon — a projected catch that completes
   * after the checkered is never announced.
   */
  lapsRemaining: number | null = null,
  /**
   * Live resolver for the minimum-movement gate in seconds (issue #933
   * follow-up). Plugins wire the `gapCalloutMinChangeSeconds` setting.
   */
  getMinChangeSeconds: () => number = () => GAP_DEFAULT_MIN_CHANGE_S,
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

  // 4) Relevance-driven callout events + threshold episodes.
  maybeEmitCalloutEvents(state, telemetry, playerPaused, lapsRemaining, getThresholdSeconds, getMinChangeSeconds, emit);
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
  let etaRegime = false;

  if (lapDelta === 0) {
    // Ahead: how long ago did the neighbor cross MY position (their trace).
    // Behind: how long ago did I cross the neighbor's position (my trace).
    const trace = side === "ahead" ? state.gapTraces[idx] : state.gapTraces[playerCarIdx];
    const lookupProgress = side === "ahead" ? playerProgress : neighborProgress;
    const crossed = trace ? crossingTimeAt(trace, lookupProgress) : null;

    if (crossed !== null) gapSeconds = Math.max(0, sessionTime - crossed);

    // ETA regime: when the pair's LEADING car is dramatically slower than
    // the chaser (stopped, wrecked, crawling), the crossing-time reading
    // goes insensitive — replace it with the chaser's ETA over the
    // separation at its current pace, which counts down as it closes.
    const leaderIdx = side === "ahead" ? idx : playerCarIdx;
    const chaserIdx = side === "ahead" ? playerCarIdx : idx;
    const leaderProgress = side === "ahead" ? neighborProgress : playerProgress;
    const chaserProgress = side === "ahead" ? playerProgress : neighborProgress;
    const chaserRate = recentProgressRate(state.gapTraces[chaserIdx], chaserProgress, sessionTime, GAP_RATE_WINDOW_S);
    const leaderRate = recentProgressRate(state.gapTraces[leaderIdx], leaderProgress, sessionTime, GAP_RATE_WINDOW_S);

    if (
      chaserRate !== null &&
      chaserRate > GAP_ETA_CHASER_MIN_RATE &&
      leaderRate !== null &&
      leaderRate < chaserRate * GAP_ETA_LEADER_SLOW_FACTOR
    ) {
      etaRegime = true;
      gapSeconds = Math.max(0, leaderProgress - chaserProgress) / chaserRate;
    }
  }

  const suppressed = playerPaused || neighborSuppressed(telemetry, idx);
  let trend: GapTrendDirection | null = null;

  if (etaRegime) {
    // The chaser is closing on a slow/stopped leader by construction — the
    // trend IS "closing". The EMA chain restarts clean when the regime ends
    // so a cross-regime delta can never poison the smoothed rate.
    resetTrendRate(state, side);

    if (!suppressed) trend = "closing";
  } else if (!suppressed && lapDelta === 0 && gapSeconds !== null) {
    // Continuous display trend: smoothed gap rate from adjacent checkpoint
    // deltas (~2 s apart, where track-position noise is negligible),
    // projected to seconds-per-lap. Live within ~0.1 lap of any reset.
    if (checkpointDue) updateTrendRate(state, side, playerProgress, gapSeconds);

    const ema = side === "ahead" ? state.gapRateEmaAhead : state.gapRateEmaBehind;
    const samples = side === "ahead" ? state.gapRateSamplesAhead : state.gapRateSamplesBehind;

    if (ema !== null && samples >= GAP_TREND_MIN_SAMPLES) {
      trend = classifyGapTrend(ema, GAP_DISPLAY_TREND_DEADBAND_S);
    }
  } else if (checkpointDue) {
    // A due checkpoint the side can't sample breaks the rate chain — a pit
    // visit or data gap must not leak a stale rate into the next stint.
    resetTrendRate(state, side);
  }

  return { carIdx: idx, gapSeconds, lapDelta, trend };
}

/** Fold one checkpoint into a side's smoothed gap rate (s/lap EMA). */
function updateTrendRate(state: TranslatorState, side: Side, progress: number, gapSeconds: number): void {
  const last = side === "ahead" ? state.gapLastCheckpointAhead : state.gapLastCheckpointBehind;
  const checkpoint = { progress, gapSeconds };

  if (side === "ahead") state.gapLastCheckpointAhead = checkpoint;
  else state.gapLastCheckpointBehind = checkpoint;

  if (!last) return;

  const step = progress - last.progress;

  if (step <= 0 || step > GAP_TREND_MAX_STEP_LAPS) {
    // Went backwards (tow/teleport) or a wide sampling break — restart the
    // chain anchored on this checkpoint.
    resetTrendRate(state, side);

    if (side === "ahead") state.gapLastCheckpointAhead = checkpoint;
    else state.gapLastCheckpointBehind = checkpoint;

    return;
  }

  const ratePerLap = (gapSeconds - last.gapSeconds) / step;

  // A single absurd sample is a data glitch (e.g. a trace discontinuity
  // after a blink) — skip it rather than poisoning the average.
  if (!Number.isFinite(ratePerLap) || Math.abs(ratePerLap) > GAP_TREND_MAX_RATE_S_PER_LAP) return;

  const ema = side === "ahead" ? state.gapRateEmaAhead : state.gapRateEmaBehind;
  const next = ema === null ? ratePerLap : ema + GAP_TREND_EMA_ALPHA * (ratePerLap - ema);

  if (side === "ahead") {
    state.gapRateEmaAhead = next;
    state.gapRateSamplesAhead++;
  } else {
    state.gapRateEmaBehind = next;
    state.gapRateSamplesBehind++;
  }
}

/** Clear one side's display-trend rate chain. */
function resetTrendRate(state: TranslatorState, side: Side): void {
  if (side === "ahead") {
    state.gapLastCheckpointAhead = null;
    state.gapRateEmaAhead = null;
    state.gapRateSamplesAhead = 0;
  } else {
    state.gapLastCheckpointBehind = null;
    state.gapRateEmaBehind = null;
    state.gapRateSamplesBehind = 0;
  }
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
  resetTrendRate(state, side);

  if (side === "ahead") {
    state.gapContactAnnouncedLapsAhead = null;
    state.gapBreakawayAnnouncedAhead = false;
    state.gapLastAnnouncedGapAhead = null;
    state.gapThresholdArmedAhead = false;
  } else {
    state.gapContactAnnouncedLapsBehind = null;
    state.gapBreakawayAnnouncedBehind = false;
    state.gapLastAnnouncedGapBehind = null;
    state.gapThresholdArmedBehind = false;
  }
}

/**
 * Relevance-driven callout events (issue #933): what deserves the driver's
 * attention is not the gap's derivative but its PROJECTION.
 *
 * Closing: with a sustained closing rate, `gapSeconds ÷ rate` projects the
 * laps until contact. An announcement fires when that projection first
 * drops inside {@link GAP_CONTACT_HORIZON_LAPS} — capped by the laps
 * actually remaining, so a catch that completes after the checkered is
 * never announced — and again each time the projection roughly halves.
 * The episode re-arms once the threat clearly recedes.
 *
 * Opening: a breakaway — a small gap (≤ {@link GAP_BREAKAWAY_MAX_GAP_S})
 * being opened hard (≥ {@link GAP_BREAKAWAY_MIN_RATE_S_PER_LAP}) — fires
 * once per episode; re-arms when the pair closes back into battle range. A
 * big gap opening further is never news.
 *
 * Threshold: an episode arms only once the gap has been seen beyond
 * threshold + hysteresis (so a nose-to-tail start can't fire at the green),
 * fires `gap.thresholdCrossed` once when the live gap first drops below the
 * threshold, and re-arms only past the hysteresis point.
 *
 * All of it is evaluated continuously (no lap-boundary sampling) and stays
 * silent while either car is on pit road / off track, for lapped neighbors,
 * and while the smoothed rate has no signal. A per-side minimum-movement
 * gate additionally holds any trend announcement until the gap has moved at
 * least `getMinChangeSeconds()` from the side's last one, either direction —
 * the anti-ping-pong rule.
 */
function maybeEmitCalloutEvents(
  state: TranslatorState,
  telemetry: TelemetryData,
  playerPaused: boolean,
  lapsRemaining: number | null,
  getThresholdSeconds: () => number,
  getMinChangeSeconds: () => number,
  emit: EmitFn,
): void {
  // Opening-lap grid assumption (issue #933 follow-up): on lap 1 the field
  // is close BY CONSTRUCTION — the grid put everyone ~a car length apart, so
  // "the car behind is right with us" off the start is not news. A side with
  // no announcement history yet is treated as if its last announcement
  // happened at the assumed grid spacing, and on lap 1 the threshold call is
  // held to the same movement gate — only genuine movement from the grid
  // situation announces. A real lap-1 breakaway still fires the moment it
  // clears the gate.
  const firstLap = typeof telemetry.LapCompleted === "number" && telemetry.LapCompleted < 1;

  processThresholdEpisode(
    state,
    telemetry,
    "ahead",
    playerPaused,
    firstLap,
    getThresholdSeconds,
    getMinChangeSeconds,
    emit,
  );
  processThresholdEpisode(
    state,
    telemetry,
    "behind",
    playerPaused,
    firstLap,
    getThresholdSeconds,
    getMinChangeSeconds,
    emit,
  );
  processRelevance(state, telemetry, "ahead", playerPaused, firstLap, lapsRemaining, getMinChangeSeconds, emit);
  processRelevance(state, telemetry, "behind", playerPaused, firstLap, lapsRemaining, getMinChangeSeconds, emit);
}

/** Evaluate one side's closing-threat projection and breakaway episode. */
function processRelevance(
  state: TranslatorState,
  telemetry: TelemetryData,
  side: Side,
  playerPaused: boolean,
  firstLap: boolean,
  lapsRemaining: number | null,
  getMinChangeSeconds: () => number,
  emit: EmitFn,
): void {
  const live = side === "ahead" ? state.gapLiveAhead : state.gapLiveBehind;
  const idx = side === "ahead" ? state.gapAheadIdx : state.gapBehindIdx;
  const ema = side === "ahead" ? state.gapRateEmaAhead : state.gapRateEmaBehind;
  const samples = side === "ahead" ? state.gapRateSamplesAhead : state.gapRateSamplesBehind;
  const suppressed = playerPaused || (idx >= 0 && neighborSuppressed(telemetry, idx));

  if (!live || idx < 0 || suppressed || live.lapDelta !== 0 || live.gapSeconds === null) return;

  if (ema === null || samples < GAP_TREND_MIN_SAMPLES) return;

  const gap = live.gapSeconds;
  // Anti-ping-pong gate (issue #933 follow-up): no trend announcement for
  // this side, in EITHER direction, until the gap has moved at least the
  // configured amount from the side's last one. A rate wobbling around the
  // bars must not alternate "pulling away" / "closing in" while the gap
  // itself hovers at the same value. On lap 1 an unannounced side is
  // baselined at the assumed grid spacing — the start put them there.
  const lastAnnouncedGap = side === "ahead" ? state.gapLastAnnouncedGapAhead : state.gapLastAnnouncedGapBehind;
  const baseline = lastAnnouncedGap ?? (firstLap ? GAP_ASSUMED_START_SPACING_S : null);
  const movedEnough = baseline === null || Math.abs(gap - baseline) >= getMinChangeSeconds();

  // ── Closing threat: announce by projected time-to-contact. ──
  const announcedAt = side === "ahead" ? state.gapContactAnnouncedLapsAhead : state.gapContactAnnouncedLapsBehind;
  const closingRate = -ema;

  if (closingRate >= GAP_CLOSING_MIN_RATE_S_PER_LAP) {
    const lapsToContact = gap / closingRate;
    const horizon = Math.min(GAP_CONTACT_HORIZON_LAPS, lapsRemaining ?? Number.POSITIVE_INFINITY);
    const due =
      movedEnough &&
      lapsToContact <= horizon &&
      (announcedAt === null || lapsToContact <= announcedAt * GAP_CONTACT_REANNOUNCE_FACTOR);

    if (due) {
      emit({
        event: "gap.trendChanged",
        data: { side, direction: "closing", gapSeconds: gap, ratePerLap: ema, lapsToContact, carIdx: idx },
      });

      if (side === "ahead") {
        state.gapContactAnnouncedLapsAhead = lapsToContact;
        state.gapLastAnnouncedGapAhead = gap;
      } else {
        state.gapContactAnnouncedLapsBehind = lapsToContact;
        state.gapLastAnnouncedGapBehind = gap;
      }
    }
  } else if (announcedAt !== null && closingRate < GAP_CLOSING_MIN_RATE_S_PER_LAP / 2) {
    // The threat receded (they stopped closing) — re-arm with hysteresis so
    // a rate hovering at the bar can't re-announce on every wobble.
    if (side === "ahead") state.gapContactAnnouncedLapsAhead = null;
    else state.gapContactAnnouncedLapsBehind = null;
  }

  // ── Breakaway: a small gap being opened hard, once per episode. ──
  const breakawayAnnounced = side === "ahead" ? state.gapBreakawayAnnouncedAhead : state.gapBreakawayAnnouncedBehind;

  if (breakawayAnnounced && gap <= GAP_BREAKAWAY_REARM_GAP_S && ema < GAP_BREAKAWAY_MIN_RATE_S_PER_LAP) {
    // Back into battle range with the breakaway over — a later one is news
    // again. The rate condition keeps a just-announced episode latched while
    // the gap is still small and still opening.
    if (side === "ahead") state.gapBreakawayAnnouncedAhead = false;
    else state.gapBreakawayAnnouncedBehind = false;
  } else if (
    !breakawayAnnounced &&
    movedEnough &&
    ema >= GAP_BREAKAWAY_MIN_RATE_S_PER_LAP &&
    gap <= GAP_BREAKAWAY_MAX_GAP_S
  ) {
    emit({
      event: "gap.trendChanged",
      data: { side, direction: "opening", gapSeconds: gap, ratePerLap: ema, carIdx: idx },
    });

    if (side === "ahead") {
      state.gapBreakawayAnnouncedAhead = true;
      state.gapLastAnnouncedGapAhead = gap;
    } else {
      state.gapBreakawayAnnouncedBehind = true;
      state.gapLastAnnouncedGapBehind = gap;
    }
  }
}

/** Arm/fire one side's threshold episode against the live gap. */
function processThresholdEpisode(
  state: TranslatorState,
  telemetry: TelemetryData,
  side: Side,
  playerPaused: boolean,
  firstLap: boolean,
  getThresholdSeconds: () => number,
  getMinChangeSeconds: () => number,
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
    // Opening-lap grid assumption (issue #933 follow-up): on lap 1 the
    // "we've caught them" call is held to the movement gate against the
    // assumed grid spacing — a neighbor who was ~0.7 s away at the start
    // briefly opening past the re-arm point and closing back is the field
    // sorting itself out, not a catch.
    if (firstLap) {
      const lastAnnouncedGap = side === "ahead" ? state.gapLastAnnouncedGapAhead : state.gapLastAnnouncedGapBehind;
      const baseline = lastAnnouncedGap ?? GAP_ASSUMED_START_SPACING_S;

      if (Math.abs(live.gapSeconds - baseline) < getMinChangeSeconds()) return;
    }

    emit({
      event: "gap.thresholdCrossed",
      data: { side, gapSeconds: live.gapSeconds, thresholdSeconds: threshold, carIdx: idx },
    });

    if (side === "ahead") {
      state.gapThresholdArmedAhead = false;
      state.gapLastAnnouncedGapAhead = live.gapSeconds;
    } else {
      state.gapThresholdArmedBehind = false;
      state.gapLastAnnouncedGapBehind = live.gapSeconds;
    }
  }
}
