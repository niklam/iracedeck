/**
 * Gap tracking diff (issue #933).
 *
 * Owns the stateful side of the crossing-time gap model: records every live
 * car's progress→SessionTime trace each tick, resolves the player's
 * class-standings neighbors from the canonical frozen order, computes the
 * live gaps the `getLiveGaps()` accessor exposes (switching to a chaser-ETA
 * reading when the pair's leading car is stopped/crawling), maintains the
 * continuous display trend (a smoothed within-lap gap-rate EMA, display
 * only), and emits the relevance-driven `gap.trendChanged` /
 * `gap.thresholdCrossed` events. The trend callouts read a lap-scale rate
 * instead — the gap now against the gap at the same spot one lap earlier
 * (issue #1285) — because a within-lap rate measures one sector's profile,
 * not the battle.
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
import { coerceSettingNumber } from "./setting-number.js";
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
/** A breakaway episode re-arms once the pair closes back under this (seconds)... */
export const GAP_BREAKAWAY_REARM_GAP_S = 5;
/**
 * ...AND the lap rate has fallen below this (s/lap) — the opening is over at
 * lap scale (issue #1285). Half the announce bar: the same hysteresis the
 * closing threat's recede test uses.
 */
export const GAP_BREAKAWAY_REARM_RATE_S_PER_LAP = GAP_BREAKAWAY_MIN_RATE_S_PER_LAP / 2;
/**
 * Lap-over-lap gap changes averaged into the callouts' lap rate (issue
 * #1285): the last 10 checkpoints, 0.2 lap of track.
 */
export const GAP_LAP_RATE_WINDOW_SAMPLES = 10;
/** Lap-over-lap changes required before the lap rate reads anything but null. */
export const GAP_LAP_RATE_MIN_SAMPLES = 5;
/**
 * ETA-regime crawl bar (issue #1285): the leading car's recent average speed
 * (progress rate × track length over {@link GAP_RATE_WINDOW_S}) must be
 * below this (m/s, ~29 km/h) as well as below half the chaser's. A 3 s
 * average through a braking zone includes the braking and the exit, so it
 * stays above the apex speed of even a slow hairpin; a wrecked, stopped or
 * limping car falls below it.
 */
export const GAP_ETA_LEADER_CRAWL_MPS = 8;
/**
 * Default minimum gap movement (seconds) IN THE ANNOUNCED DIRECTION from the
 * gap's extreme since the side's last announcement (issue #933 follow-up):
 * "closing" needs the gap down this much from its peak, "pulling away" up
 * this much from its trough. Consistency with the previous call — kills
 * hover ping-pong and sector-profile fakes alike. User-configurable via
 * `gapCalloutMinChangeSeconds`; 0 disables.
 */
export const GAP_DEFAULT_MIN_CHANGE_S = 1.5;
/**
 * Assumed grid spacing (seconds) between standings neighbors at the race
 * start (issue #933 follow-up). On lap 1, a side with no announcement
 * history seeds its extremes here — being ~this close off the start is
 * expected, not news.
 */
export const GAP_ASSUMED_START_SPACING_S = 0.7;
/** A threshold episode re-arms once the gap exceeds threshold + this margin. */
export const GAP_THRESHOLD_HYSTERESIS_S = 0.5;
/**
 * Stability guard (issue #933 follow-up: a one-frame telemetry glitch read a
 * 2.4 s gap as 0.9 s and fired "right with us"): a per-tick gap step beyond
 * this is physically implausible — real gaps evolve by milliseconds per
 * frame — and resets the stability streak.
 */
export const GAP_GLITCH_JUMP_S = 0.5;
/**
 * Consecutive plausible ticks required before the gap may drive any callout
 * emission (~170 ms at 60 Hz). A glitch resets the streak on the way in AND
 * on the way back, so a frame or two of bad data can never confirm.
 */
export const GAP_STABLE_TICKS_FOR_CALLOUTS = 10;
/** Player-progress spacing (laps) between checkpoints (display-trend samples and lap-history readings). */
export const GAP_CHECKPOINT_STEP = 0.02;
/** Fallback alert threshold when no resolver is wired (seconds). */
export const GAP_DEFAULT_ALERT_THRESHOLD_S = 1.0;
/** Alert-threshold slider bounds; mirror `gapAlertThresholdSeconds` in the schema. */
export const GAP_ALERT_THRESHOLD_MIN_S = 0.5;
export const GAP_ALERT_THRESHOLD_MAX_S = 3;
/** Movement-gate slider bounds; mirror `gapCalloutMinChangeSeconds` in the schema. */
export const GAP_MIN_CHANGE_MIN_S = 0;
export const GAP_MIN_CHANGE_MAX_S = 10;

/**
 * Sanitize the `gapAlertThresholdSeconds` global setting. Clamps to the
 * slider's range; anything unparseable falls back to the default. Shared by
 * every plugin so the bounds live in exactly one place (the
 * `sanitizeCornerCalloutLeadSeconds` shape).
 */
export function sanitizeGapAlertThresholdSeconds(value: unknown): number {
  const n = coerceSettingNumber(value);

  if (n === null) return GAP_DEFAULT_ALERT_THRESHOLD_S;

  return Math.min(GAP_ALERT_THRESHOLD_MAX_S, Math.max(GAP_ALERT_THRESHOLD_MIN_S, n));
}

/**
 * Sanitize the `gapCalloutMinChangeSeconds` global setting (0 disables the
 * consistency gate). Same shape as {@link sanitizeGapAlertThresholdSeconds}.
 */
export function sanitizeGapMinChangeSeconds(value: unknown): number {
  const n = coerceSettingNumber(value);

  if (n === null) return GAP_DEFAULT_MIN_CHANGE_S;

  return Math.min(GAP_MIN_CHANGE_MAX_S, Math.max(GAP_MIN_CHANGE_MIN_S, n));
}

/** Window (s) for measuring a car's recent progress rate. */
const GAP_RATE_WINDOW_S = 3;
/**
 * ETA-regime switch (issue #933 follow-up: a stopped player's behind gap
 * froze while the pursuers physically closed): when the LEADING car of a
 * pair is this much slower than the chaser, the crossing-time gap no longer
 * tracks the pair's true time-distance (both `now` and the lookup advance at
 * the chaser's pace), so the gap becomes the chaser's ETA over the
 * separation at its current pace — counting down as it closes. The relative
 * test alone also passes for a leader braking into a hairpin while the
 * chaser is still flat on the straight (issue #1285), so the regime
 * additionally needs the leader under {@link GAP_ETA_LEADER_CRAWL_MPS}.
 */
const GAP_ETA_LEADER_SLOW_FACTOR = 0.5;
/** Minimum chaser rate (laps/s) for the ETA regime — both-cars-stopped stays crossing-time. */
const GAP_ETA_CHASER_MIN_RATE = 0.002;

/** EMA smoothing factor for the display gap rate (~0.13 lap of memory). Display only. */
const GAP_TREND_EMA_ALPHA = 0.15;
/** Rate samples required before the display trend classifies. ~0.1 lap. */
const GAP_TREND_MIN_SAMPLES = 5;
/**
 * A sampling break wider than this (laps) restarts the display rate chain,
 * and refuses a lap-history lookup whose bracketing readings are further
 * apart than this.
 */
const GAP_TREND_MAX_STEP_LAPS = 0.1;
/** Single rate samples (display or lap-over-lap) beyond this (s/lap) are glitches — skipped. */
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
  /**
   * Track length in meters (issue #1285), for the ETA regime's crawl bar.
   * `null` (unknown) means the regime never engages: a stopped leader then
   * shows the frozen crossing-time gap rather than risking a false reading.
   */
  trackLengthMeters: number | null = null,
  /**
   * Whether a full-course caution is out this tick (issue #1285): the
   * translator's `cautionPhase !== "none"`. The pace laps pack the field up
   * and the restart strings it out again, so neither lap is comparable with
   * the one before it — the lap history is cleared on every caution tick.
   */
  underFullCourseCaution: boolean = false,
): void {
  const lc = telemetry.CarIdxLapCompleted as number[] | undefined;
  const pct = telemetry.CarIdxLapDistPct as number[] | undefined;
  // Finite, not merely numeric: `typeof NaN === "number"`, and a NaN session
  // time would be stamped into every trace and surface as a NaN gap.
  const rawSessionTime = telemetry.SessionTime;
  const sessionTime = typeof rawSessionTime === "number" && Number.isFinite(rawSessionTime) ? rawSessionTime : null;
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
    state.gapEtaReadingAhead = false;
    state.gapEtaReadingBehind = false;

    return;
  }

  // 1) Record every live car's progress trace.
  const carCount = Math.min(lc.length, pct.length);

  for (let i = 0; i < carCount; i++) {
    const laps = lc[i]!;
    const dist = pct[i]!;

    // Finite check first: `NaN < 0` is false, so a bare range guard lets a
    // NaN sample through — and a NaN in a trace is permanent, since every
    // comparison in `appendProgressSample` (backwards reset, dedupe, prune)
    // is false against it. The trace would then grow unbounded and every
    // crossing-time lookup on it would return garbage.
    if (!Number.isFinite(laps) || !Number.isFinite(dist) || laps < 0 || dist < 0) continue;

    let trace = state.gapTraces[i];

    if (!trace) {
      trace = [];
      state.gapTraces[i] = trace;
    }

    appendProgressSample(trace, laps + dist, sessionTime);
  }

  const playerLc = lc[playerCarIdx];
  const playerPct = pct[playerCarIdx];

  if (!Number.isFinite(playerLc) || playerLc! < 0 || !Number.isFinite(playerPct) || playerPct! < 0) {
    state.gapLiveAhead = null;
    state.gapLiveBehind = null;
    state.gapEtaReadingAhead = false;
    state.gapEtaReadingBehind = false;

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

  // A backwards jump (tow, teleport to pits, session restart) leaves the
  // checkpoint anchor AHEAD of the player: `checkpointDue` would then stay
  // false until they re-passed it — up to a full lap — so the chain would
  // never be sampled NOR reset, and the pre-tow EMA would keep coloring the
  // rows and dating the callouts' ratePerLap. Break the chain here, the way
  // the per-car traces already do in `appendProgressSample`.
  //
  // Reset the WHOLE side state, not just the rate chain: every piece of
  // callout bookkeeping means "since the last announcement, in this racing
  // situation", and a discontinuity voids that situation. An armed threshold
  // carried across it would let the first stable gap afterwards fire a
  // crossing that belongs to a race that no longer exists, and the
  // consistency extremes would be measured against a vanished story.
  if (state.gapLastCheckpointProgress >= 0 && playerProgress < state.gapLastCheckpointProgress - GAP_CHECKPOINT_STEP) {
    resetSideState(state, "ahead");
    resetSideState(state, "behind");
    state.gapLastCheckpointProgress = -1;
  }

  const checkpointDue =
    state.gapLastCheckpointProgress < 0 || playerProgress - state.gapLastCheckpointProgress >= GAP_CHECKPOINT_STEP;
  const trackLength =
    typeof trackLengthMeters === "number" && Number.isFinite(trackLengthMeters) && trackLengthMeters > 0
      ? trackLengthMeters
      : null;

  // The lap history records only laps a later lap can fairly be compared
  // with (issue #1285). Not lap 1: the start queue and the field sorting
  // itself out inflate and deflate the gaps, so a lap-2 comparison against
  // it would call a catch or a breakaway that is only the start unwinding —
  // trend calls therefore begin on lap 3. And nothing under a full-course
  // caution: the pack-up and the restart are not racing.
  const lapHistoryOpen = !isFirstLap(telemetry) && !underFullCourseCaution;

  if (!lapHistoryOpen) {
    resetLapHistory(state, "ahead");
    resetLapHistory(state, "behind");
  }

  state.gapLiveAhead = computeSide(
    state,
    telemetry,
    "ahead",
    playerCarIdx,
    playerProgress,
    sessionTime,
    playerPaused,
    checkpointDue,
    trackLength,
    lapHistoryOpen,
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
    trackLength,
    lapHistoryOpen,
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
  trackLengthMeters: number | null,
  lapHistoryOpen: boolean,
): GapNeighborState | null {
  const idx = side === "ahead" ? state.gapAheadIdx : state.gapBehindIdx;

  setEtaReading(state, side, false);

  if (idx < 0) return null;

  const lc = telemetry.CarIdxLapCompleted as number[];
  const pct = telemetry.CarIdxLapDistPct as number[];
  const neighborLc = lc[idx];
  const neighborPct = pct[idx];

  if (neighborLc === undefined || neighborLc < 0 || neighborPct === undefined || neighborPct < 0) {
    // Neighbor has no live progress this tick (blink / not in world) — hold
    // identity but show no numbers. A due checkpoint here is one the side
    // cannot sample, so it breaks both rate chains like any other.
    if (checkpointDue) {
      resetTrendRate(state, side);
      resetLapHistory(state, side);
    }

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
    // the chaser AND crawling in absolute terms (stopped, wrecked, limping),
    // the crossing-time reading goes insensitive — replace it with the
    // chaser's ETA over the separation at its current pace, which counts
    // down as it closes. The crawl bar keeps a leader braking into a hairpin
    // out of it (issue #1285): there the crossing-time gap is correct, and
    // the ETA would underestimate it by seconds. No track length, no regime.
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
      leaderRate < chaserRate * GAP_ETA_LEADER_SLOW_FACTOR &&
      trackLengthMeters !== null &&
      leaderRate * trackLengthMeters < GAP_ETA_LEADER_CRAWL_MPS
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
    // so a cross-regime delta can never poison the smoothed rate, and the
    // lap history goes too: a lap-later comparison against an ETA reading
    // would compare two different measurements.
    setEtaReading(state, side, true);
    resetTrendRate(state, side);
    resetLapHistory(state, side);

    if (!suppressed) trend = "closing";
  } else if (!suppressed && lapDelta === 0 && gapSeconds !== null) {
    // Continuous display trend: smoothed gap rate from adjacent checkpoint
    // deltas (~2 s apart, where track-position noise is negligible),
    // projected to seconds-per-lap. Live within ~0.1 lap of any reset. The
    // same checkpoint feeds the callouts' lap history.
    if (checkpointDue) {
      updateTrendRate(state, side, playerProgress, gapSeconds);

      if (lapHistoryOpen) updateLapRate(state, side, playerProgress, gapSeconds);
    }

    const ema = side === "ahead" ? state.gapRateEmaAhead : state.gapRateEmaBehind;
    const samples = side === "ahead" ? state.gapRateSamplesAhead : state.gapRateSamplesBehind;

    if (ema !== null && samples >= GAP_TREND_MIN_SAMPLES) {
      trend = classifyGapTrend(ema, GAP_DISPLAY_TREND_DEADBAND_S);
    }
  } else if (checkpointDue) {
    // A due checkpoint the side can't sample breaks the rate chain — a pit
    // visit or data gap must not leak a stale rate into the next stint —
    // and the lap history with it: the next lap is compared with nothing.
    resetTrendRate(state, side);
    resetLapHistory(state, side);
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

/**
 * Record one checkpoint in a side's lap history and fold its lap-over-lap
 * change into the lap-rate window (issue #1285). The change is this gap
 * minus the gap at `progress − 1`, interpolated between the two history
 * readings that bracket that point — the same spot one lap earlier, so the
 * pair's within-lap sector profile cancels out. The lookup counts only when
 * the bracket is contiguous (≤ {@link GAP_TREND_MAX_STEP_LAPS} apart), which
 * is what refuses a comparison across a plain sampling gap.
 */
function updateLapRate(state: TranslatorState, side: Side, progress: number, gapSeconds: number): void {
  let history = side === "ahead" ? state.gapLapHistoryAhead : state.gapLapHistoryBehind;
  const last = history.length > 0 ? history[history.length - 1]! : undefined;

  // Checkpoints only ever advance (a backwards jump resets the side first);
  // anything else is a discontinuity the history must not straddle.
  if (last !== undefined && progress <= last.progress) {
    resetLapHistory(state, side);
    history = side === "ahead" ? state.gapLapHistoryAhead : state.gapLapHistoryBehind;
  }

  history.push({ progress, gapSeconds });

  // Keep exactly one reading at or before the lookup point: it is the lower
  // bracket now, and every later lookup lies further on.
  const target = progress - 1;

  while (history.length > 1 && history[1]!.progress <= target) history.shift();

  const gapThen = lapHistoryGapAt(history, target);
  const window = side === "ahead" ? state.gapLapRateWindowAhead : state.gapLapRateWindowBehind;

  if (gapThen === null) {
    // No same-spot reading a lap ago (not a lap of history yet, or a
    // sampling gap there): the window's older changes describe track that
    // is no longer the last 0.2 lap, so the lap rate goes dark rather than
    // keep serving them.
    window.length = 0;

    return;
  }

  const change = gapSeconds - gapThen;

  // A single absurd change is a data glitch — skip it rather than poisoning
  // the window, the same guard the display chain uses.
  if (!Number.isFinite(change) || Math.abs(change) > GAP_TREND_MAX_RATE_S_PER_LAP) return;

  window.push(change);

  while (window.length > GAP_LAP_RATE_WINDOW_SAMPLES) window.shift();
}

/**
 * The gap at `target` interpolated from the two history readings bracketing
 * it, or null when they don't or are not contiguous. The prune in
 * {@link updateLapRate} drops `history[0]` while `history[1]` is at or
 * before the target, so only `history[0]` and `history[1]` can bracket it.
 */
function lapHistoryGapAt(history: { progress: number; gapSeconds: number }[], target: number): number | null {
  if (history.length < 2) return null;

  const a = history[0]!;
  const b = history[1]!;

  if (a.progress > target || b.progress < target) return null;

  const span = b.progress - a.progress;

  if (span <= 0 || span > GAP_TREND_MAX_STEP_LAPS) return null;

  return a.gapSeconds + ((target - a.progress) / span) * (b.gapSeconds - a.gapSeconds);
}

/**
 * The callouts' lap rate for a side (s/lap; negative = closing): the mean of
 * its recent lap-over-lap changes, or null until the window holds
 * {@link GAP_LAP_RATE_MIN_SAMPLES}.
 */
function lapRate(state: TranslatorState, side: Side): number | null {
  const window = side === "ahead" ? state.gapLapRateWindowAhead : state.gapLapRateWindowBehind;

  if (window.length < GAP_LAP_RATE_MIN_SAMPLES) return null;

  let sum = 0;

  for (const change of window) sum += change;

  return sum / window.length;
}

/** Clear one side's lap history and lap-rate window — the next lap is silent. */
function resetLapHistory(state: TranslatorState, side: Side): void {
  if (side === "ahead") {
    state.gapLapHistoryAhead = [];
    state.gapLapRateWindowAhead = [];
  } else {
    state.gapLapHistoryBehind = [];
    state.gapLapRateWindowBehind = [];
  }
}

/** Record whether a side's live gap this tick is an ETA-regime reading. */
function setEtaReading(state: TranslatorState, side: Side, eta: boolean): void {
  if (side === "ahead") state.gapEtaReadingAhead = eta;
  else state.gapEtaReadingBehind = eta;
}

/** Whether the player is on the race's opening lap (`LapCompleted` below 1). */
function isFirstLap(telemetry: TelemetryData): boolean {
  return typeof telemetry.LapCompleted === "number" && telemetry.LapCompleted < 1;
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
  resetLapHistory(state, side);
  setEtaReading(state, side, false);

  if (side === "ahead") {
    state.gapContactAnnouncedLapsAhead = null;
    state.gapBreakawayAnnouncedAhead = false;
    state.gapMinSinceAnnounceAhead = null;
    state.gapMaxSinceAnnounceAhead = null;
    state.gapThresholdArmedAhead = false;
    state.gapLastEvalGapAhead = null;
    state.gapStableTicksAhead = 0;
  } else {
    state.gapContactAnnouncedLapsBehind = null;
    state.gapBreakawayAnnouncedBehind = false;
    state.gapMinSinceAnnounceBehind = null;
    state.gapMaxSinceAnnounceBehind = null;
    state.gapThresholdArmedBehind = false;
    state.gapLastEvalGapBehind = null;
    state.gapStableTicksBehind = 0;
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
 * once per episode; re-arms when the pair is back in battle range
 * (≤ {@link GAP_BREAKAWAY_REARM_GAP_S}) with the opening over at lap scale
 * (< {@link GAP_BREAKAWAY_REARM_RATE_S_PER_LAP}). A big gap opening further
 * is never news.
 *
 * Threshold: an episode arms only once the gap has been seen beyond
 * threshold + hysteresis (so a nose-to-tail start can't fire at the green),
 * fires `gap.thresholdCrossed` once when the live gap first drops below the
 * threshold, and re-arms only past the hysteresis point.
 *
 * The closing projection, the breakaway bar and both re-arms read the LAP
 * RATE (issue #1285): the mean recent change of the gap against the gap at
 * the same spot one lap earlier. The display EMA is a within-lap rate — a
 * car ahead that is faster down a straight reads as "opening hard" whatever
 * the lap-over-lap gap does — so it never drives a callout. The price is a
 * lap of same-spot history before any trend call: lap 1 is never recorded,
 * so none before lap 3, and none for a lap after a neighbor change, a pit
 * visit, a full-course caution or any other break. The
 * threshold call does not need the rate and works from the first stable
 * reading.
 *
 * All of it is evaluated continuously (no lap-boundary sampling) and stays
 * silent while either car is on pit road / off track, for lapped neighbors,
 * and while the lap rate has no signal. A per-side minimum-movement gate
 * additionally holds any trend announcement until the gap has moved at
 * least `getMinChangeSeconds()` from the side's extreme since its last one,
 * in the announced direction — the anti-ping-pong rule.
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
  // situation announces. Trend calls need no such hold: they read the lap
  // history, which never records lap 1 (issue #1285), but the extremes the
  // grid seeds still gate the first one on lap 3.
  const firstLap = isFirstLap(telemetry);

  for (const side of ["ahead", "behind"] as const) {
    // Stability guard: skip a side entirely while its gap hasn't evolved
    // plausibly for a short streak — a glitched frame must not arm, fire,
    // or update any episode bookkeeping.
    if (!updateStability(state, side)) continue;

    // Fold this tick's gap into the side's since-last-announcement extremes
    // BEFORE either processor reads them. Both the threshold gate and the
    // relevance gates compare against these extremes, so folding inside the
    // relevance path (which needs a warm lap rate) would leave them stale —
    // or never seeded at all — whenever the lap history is cold, silently
    // suppressing calls the user un-gated by setting the movement to 0.
    const extremes = foldSideExtremes(state, telemetry, side, playerPaused, firstLap);

    processThresholdEpisode(
      state,
      telemetry,
      side,
      playerPaused,
      firstLap,
      extremes,
      getThresholdSeconds,
      getMinChangeSeconds,
      emit,
    );
    processRelevance(state, telemetry, side, playerPaused, lapsRemaining, extremes, getMinChangeSeconds, emit);
  }
}

/** A side's gap extremes since its last announcement. */
type GapExtremes = { min: number; max: number };

/**
 * Fold one side's live gap into its since-last-announcement extremes, or
 * return null when this tick's reading must not count. Suppressed readings
 * (player or neighbor in the pits / off track) are excluded deliberately: a
 * pit-inflated gap folded as the "peak" would make every later closing call
 * pass the consistency gate for free.
 *
 * An ETA-regime reading (issue #1285) is not folded either — it is an
 * estimate against a stopped or crawling leader, and folded as the "trough"
 * it would let the crossing-time reading that follows pass the
 * pulling-away gate for free. The extremes are handed on as they stand, so
 * the threshold episode's lap-1 test still has them.
 */
function foldSideExtremes(
  state: TranslatorState,
  telemetry: TelemetryData,
  side: Side,
  playerPaused: boolean,
  firstLap: boolean,
): GapExtremes | null {
  const live = side === "ahead" ? state.gapLiveAhead : state.gapLiveBehind;
  const idx = side === "ahead" ? state.gapAheadIdx : state.gapBehindIdx;
  const suppressed = playerPaused || (idx >= 0 && neighborSuppressed(telemetry, idx));

  if (!live || idx < 0 || suppressed || live.lapDelta !== 0 || live.gapSeconds === null) return null;

  const etaReading = side === "ahead" ? state.gapEtaReadingAhead : state.gapEtaReadingBehind;

  if (etaReading) return currentExtremes(state, side);

  return foldExtremes(state, side, live.gapSeconds, firstLap);
}

/** A side's since-last-announcement extremes as they stand, or null when unseeded. */
function currentExtremes(state: TranslatorState, side: Side): GapExtremes | null {
  const min = side === "ahead" ? state.gapMinSinceAnnounceAhead : state.gapMinSinceAnnounceBehind;
  const max = side === "ahead" ? state.gapMaxSinceAnnounceAhead : state.gapMaxSinceAnnounceBehind;

  return min === null || max === null ? null : { min, max };
}

/**
 * Advance one side's stability streak and report whether its gap is currently
 * trustworthy for callout decisions. A missing gap (suppressed / cold start /
 * lapped) resets the streak — the first readings after any data gap are
 * exactly where glitches live.
 */
function updateStability(state: TranslatorState, side: Side): boolean {
  const live = side === "ahead" ? state.gapLiveAhead : state.gapLiveBehind;
  const gap = live && live.lapDelta === 0 ? live.gapSeconds : null;
  const lastGap = side === "ahead" ? state.gapLastEvalGapAhead : state.gapLastEvalGapBehind;
  let ticks = side === "ahead" ? state.gapStableTicksAhead : state.gapStableTicksBehind;

  if (gap === null || lastGap === null || Math.abs(gap - lastGap) > GAP_GLITCH_JUMP_S) {
    ticks = 0;
  } else {
    ticks++;
  }

  if (side === "ahead") {
    state.gapLastEvalGapAhead = gap;
    state.gapStableTicksAhead = ticks;
  } else {
    state.gapLastEvalGapBehind = gap;
    state.gapStableTicksBehind = ticks;
  }

  return ticks >= GAP_STABLE_TICKS_FOR_CALLOUTS;
}

/** Evaluate one side's closing-threat projection and breakaway episode. */
function processRelevance(
  state: TranslatorState,
  telemetry: TelemetryData,
  side: Side,
  playerPaused: boolean,
  lapsRemaining: number | null,
  extremes: GapExtremes | null,
  getMinChangeSeconds: () => number,
  emit: EmitFn,
): void {
  const live = side === "ahead" ? state.gapLiveAhead : state.gapLiveBehind;
  const idx = side === "ahead" ? state.gapAheadIdx : state.gapBehindIdx;
  const suppressed = playerPaused || (idx >= 0 && neighborSuppressed(telemetry, idx));

  if (!live || idx < 0 || suppressed || live.lapDelta !== 0 || live.gapSeconds === null || !extremes) return;

  // Lap-scale rate (issue #1285). Null until the pair has a lap of same-spot
  // history — no trend call, and no re-arm either: both latches hold
  // through a break in the history rather than flipping on missing data.
  const rate = lapRate(state, side);

  if (rate === null) return;

  const gap = live.gapSeconds;
  // Consistency gate (issue #933 follow-up): a call must agree with the
  // story since the previous one. "Closing" requires the gap DOWN at least
  // the configured amount from its PEAK since the last announcement (a
  // sector-profile dip below a gap that sits above everything since the
  // last call must never say "they're closing"); "pulling away" requires it
  // UP the same amount from its TROUGH. The extremes are folded once per
  // tick by the caller, from stable unsuppressed readings only, and lap 1
  // seeds them at the assumed grid spacing — the start put the neighbors
  // there.
  const minChange = getMinChangeSeconds();
  const closingConsistent = gap <= extremes.max - minChange;
  const openingConsistent = gap >= extremes.min + minChange;

  // ── Closing threat: announce by projected time-to-contact. ──
  const announcedAt = side === "ahead" ? state.gapContactAnnouncedLapsAhead : state.gapContactAnnouncedLapsBehind;
  const closingRate = -rate;

  if (closingRate >= GAP_CLOSING_MIN_RATE_S_PER_LAP) {
    const lapsToContact = gap / closingRate;
    const horizon = Math.min(GAP_CONTACT_HORIZON_LAPS, lapsRemaining ?? Number.POSITIVE_INFINITY);
    const due =
      closingConsistent &&
      lapsToContact <= horizon &&
      (announcedAt === null || lapsToContact <= announcedAt * GAP_CONTACT_REANNOUNCE_FACTOR);

    if (due) {
      emit({
        event: "gap.trendChanged",
        data: { side, direction: "closing", gapSeconds: gap, ratePerLap: rate, lapsToContact, carIdx: idx },
      });

      resetExtremes(state, side, gap);

      if (side === "ahead") state.gapContactAnnouncedLapsAhead = lapsToContact;
      else state.gapContactAnnouncedLapsBehind = lapsToContact;
    }
  } else if (announcedAt !== null && closingRate < GAP_CLOSING_MIN_RATE_S_PER_LAP / 2) {
    // The threat receded (they stopped closing) — re-arm with hysteresis so
    // a rate hovering at the bar can't re-announce on every wobble.
    if (side === "ahead") state.gapContactAnnouncedLapsAhead = null;
    else state.gapContactAnnouncedLapsBehind = null;
  }

  // ── Breakaway: a small gap being opened hard, once per episode. ──
  const breakawayAnnounced = side === "ahead" ? state.gapBreakawayAnnouncedAhead : state.gapBreakawayAnnouncedBehind;

  if (breakawayAnnounced && gap <= GAP_BREAKAWAY_REARM_GAP_S && rate < GAP_BREAKAWAY_REARM_RATE_S_PER_LAP) {
    // Back into battle range with the breakaway over at lap scale — a later
    // one is news again. The rate condition keeps a just-announced episode
    // latched while the gap is still small and still opening; with the bar
    // at half the announce rate (issue #1285), an opening hovering at the
    // bar cannot re-arm and re-announce lap after lap.
    if (side === "ahead") state.gapBreakawayAnnouncedAhead = false;
    else state.gapBreakawayAnnouncedBehind = false;
  } else if (
    !breakawayAnnounced &&
    openingConsistent &&
    rate >= GAP_BREAKAWAY_MIN_RATE_S_PER_LAP &&
    gap <= GAP_BREAKAWAY_MAX_GAP_S
  ) {
    emit({
      event: "gap.trendChanged",
      data: { side, direction: "opening", gapSeconds: gap, ratePerLap: rate, carIdx: idx },
    });

    resetExtremes(state, side, gap);

    if (side === "ahead") state.gapBreakawayAnnouncedAhead = true;
    else state.gapBreakawayAnnouncedBehind = true;
  }
}

/** Fold the current gap into a side's since-last-announcement extremes. */
function foldExtremes(state: TranslatorState, side: Side, gap: number, firstLap: boolean): GapExtremes {
  const prevMin = side === "ahead" ? state.gapMinSinceAnnounceAhead : state.gapMinSinceAnnounceBehind;
  const prevMax = side === "ahead" ? state.gapMaxSinceAnnounceAhead : state.gapMaxSinceAnnounceBehind;
  const seed = prevMin === null || prevMax === null ? (firstLap ? GAP_ASSUMED_START_SPACING_S : gap) : null;
  const min = Math.min(seed ?? prevMin!, gap);
  const max = Math.max(seed ?? prevMax!, gap);

  if (side === "ahead") {
    state.gapMinSinceAnnounceAhead = min;
    state.gapMaxSinceAnnounceAhead = max;
  } else {
    state.gapMinSinceAnnounceBehind = min;
    state.gapMaxSinceAnnounceBehind = max;
  }

  return { min, max };
}

/** Forget a side's extremes; the next folded reading reseeds them. */
function clearExtremes(state: TranslatorState, side: Side): void {
  if (side === "ahead") {
    state.gapMinSinceAnnounceAhead = null;
    state.gapMaxSinceAnnounceAhead = null;
  } else {
    state.gapMinSinceAnnounceBehind = null;
    state.gapMaxSinceAnnounceBehind = null;
  }
}

/** Restart a side's extremes at the just-announced gap. */
function resetExtremes(state: TranslatorState, side: Side, gap: number): void {
  if (side === "ahead") {
    state.gapMinSinceAnnounceAhead = gap;
    state.gapMaxSinceAnnounceAhead = gap;
  } else {
    state.gapMinSinceAnnounceBehind = gap;
    state.gapMaxSinceAnnounceBehind = gap;
  }
}

/** Arm/fire one side's threshold episode against the live gap. */
function processThresholdEpisode(
  state: TranslatorState,
  telemetry: TelemetryData,
  side: Side,
  playerPaused: boolean,
  firstLap: boolean,
  extremes: GapExtremes | null,
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
    // "we've caught them" call must be consistent with the assumed grid
    // situation — the gap down at least the movement amount from its peak
    // since the start (or the last call). A neighbor who was ~0.7 s away,
    // briefly opened past the re-arm point, and closed back is the field
    // sorting itself out, not a catch.
    if (firstLap) {
      const maxSince = extremes?.max ?? GAP_ASSUMED_START_SPACING_S;

      if (live.gapSeconds > maxSince - getMinChangeSeconds()) return;
    }

    emit({
      event: "gap.thresholdCrossed",
      data: { side, gapSeconds: live.gapSeconds, thresholdSeconds: threshold, carIdx: idx },
    });

    // An ETA reading is an estimate against a stopped or crawling leader,
    // not a crossing-time gap (issue #1285): seeding the extremes with it
    // would make it the trough a later crossing-time reading is measured
    // against. Clear them instead; the next folded reading reseeds them.
    const etaReading = side === "ahead" ? state.gapEtaReadingAhead : state.gapEtaReadingBehind;

    if (etaReading) clearExtremes(state, side);
    else resetExtremes(state, side, live.gapSeconds);

    if (side === "ahead") state.gapThresholdArmedAhead = false;
    else state.gapThresholdArmedBehind = false;
  }
}
