/**
 * Opponent penalty-flag callouts (issue #936).
 *
 * **Store = truth, qualifier = policy.** This module holds the flag-state
 * STORE: raw decoded per-car penalty flags (`PENALTY_FLAG_MASK` over
 * `CarIdxSessionFlags`) with no debounce, no episodes, no cooldowns — the
 * reusable seam (`getLiveOpponentFlags()` in `translator.ts`) reads it
 * directly. On top of the store, this module also owns announcement POLICY:
 * qualification-window classification (standings-relative + coarse
 * track-relative, with enter/exit hysteresis), the Furled debounce, the
 * per-(car, flag) episode latch + re-announce cooldown, and `raised` vs
 * `entered-range` trigger classification. Burst aggregation
 * (`opponentFlagRecentEntries` / threshold collapse, the #622 shape) is a
 * separate concern layered on top (Task 6) — this module only emits
 * individual `opponentFlag.flagged` lines.
 *
 * The store advances every tick from the live array length (never a fixed
 * 64 — a real capture showed length 72 with the pace car at index 64) and
 * keeps advancing even while the announce gates are closed, so a gated tick
 * is absorbed rather than replayed once the gate reopens (the
 * `diffOpponentPit` precedent). Two pieces of level-based (not edge-based)
 * per-car cleanup run every tick regardless of gating, since they describe
 * the CURRENT bit state rather than a transition:
 * - `opponentFlagAnnouncedMask[i] &= bits` — a flag's own bit dropping ends
 *   that flag's announced episode (the dedup gate below reads this).
 * - `opponentFlagFurledSinceAt[i]` — the epoch ms the Furled bit has been
 *   continuously up, kept while it stays up (not reset every tick), seeded
 *   to `now` the tick it's found already up (including the very first
 *   store tick), and cleared to `0` while it's down. The #669 debounce
 *   below reads this to tell a flicker apart from a sustained raise.
 *
 * **`opponentFlagEffectiveMask`** is the third level-based per-car value
 * advanced every tick: a bitmask (same bit values as `opponentFlagBits`) of
 * flags that are EFFECTIVELY active — debounce-adjusted for Furled, equal to
 * the raw bit for the other three. Comparing this tick's value against the
 * value from the END of the previous tick (captured before this tick
 * overwrites it) is what tells "became effectively active THIS tick"
 * (`raised`) apart from "was already active, something else about this
 * announce just became true" (`entered-range`) — Furled's debounce means the
 * raw bit can rise several ticks before the flag is announce-eligible, so a
 * raw-bit transition alone can't drive the trigger label; and because this
 * mask advances unconditionally (like the other store fields), a flag that
 * turns effectively active DURING a gated window is already reflected by
 * the time the gate reopens, so the reopened tick correctly reports
 * `entered-range` rather than replaying a `raised` for an edge that
 * happened several ticks earlier under the gate.
 *
 * **Qualification window.** Per non-player/non-pace/in-world car: standings
 * relations first (same class + same lap, `classify`'s structure copied
 * from the #622 `diffOpponentPit` classifier) — class-position delta
 * `playerPos − carPos ∈ [1..OPPONENT_FLAG_AHEAD_WINDOW]` is `"ahead"`,
 * `carPos − playerPos === 1` is `"behind"`; standings membership has no
 * hysteresis. Otherwise a coarse forward track gap (`coarseForwardGapSeconds`)
 * against an enter/exit hysteresis bound is `"track-ahead"` — evaluated
 * regardless of class or lap, so a different-class or different-lap car can
 * still qualify by track proximity even though it can never qualify via
 * standings. `opponentFlagInWindow` is the per-car hysteresis memory (which
 * bound applies) and is only advanced on ungated ticks (see gating below).
 *
 * **Announce condition.** Effectively active (per `opponentFlagEffectiveMask`)
 * AND in window (per `classify`) AND that flag's bit not already in
 * `opponentFlagAnnouncedMask` (the per-episode latch) AND that flag's
 * per-car cooldown (`opponentFlagCooldownUntil`, `OPPONENT_FLAG_CAR_COOLDOWN_MS`)
 * expired. On announce: set the episode-latch bit, stamp the flag's own
 * cooldown (per-flag, so an escalation like black → DQ on the same car is
 * never suppressed by the black cooldown), and emit with
 * `trigger: "raised"` when the flag became effectively active this exact
 * tick, else `"entered-range"` (the level-triggered case: the flag was
 * already active and something else — the window, a cooldown, a gate —
 * just cleared).
 *
 * **Gating** (the `diffOpponentPit` precedent): race sessions only,
 * replay-only sessions suppressed, pre-green suppressed (grid/formation
 * positions are meaningless), post-race suppressed (the whole field can
 * carry stale flags after the checkered), and an unresolved player carIdx
 * suppresses everything (classification is relative to the player). The
 * whole announce pass — including `opponentFlagInWindow` advancement — is
 * skipped while gated; the store (bits, Furled debounce timer, effective
 * mask) still advances every tick regardless, so nothing gated ever
 * replays once the gate reopens. The very first tick is handled the same
 * way as a gated tick (seed the store silently, no announce pass) so a
 * flag that's already active before the plugin ever attached doesn't
 * spuriously read as "just activated".
 */
import { OpponentPenaltyFlag } from "@iracedeck/event-bus";
import {
  classPositionFromOrder,
  coarseForwardGapSeconds,
  decodePenaltyFlags,
  Flags,
  PENALTY_FLAG_MASK,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/** Rolling window for counting near-simultaneous eligible flag announcements (Task 6). */
export const OPPONENT_FLAG_AGGREGATE_WINDOW_MS = 12_000;

/** Eligible announcements within the window at which enumeration collapses (Task 6). */
export const OPPONENT_FLAG_AGGREGATE_THRESHOLD = 3;

/** Per-(car, flag) re-announce cooldown — an escalation (black → DQ) is never suppressed by it. */
export const OPPONENT_FLAG_CAR_COOLDOWN_MS = 30_000;

/** How long the Furled bit must stay continuously up before it announces (the #669 flicker guard). */
export const OPPONENT_FLAG_FURLED_DEBOUNCE_MS = 1_000;

/** Coarse forward track-gap distance (s) at which the track-ahead window opens. */
export const OPPONENT_FLAG_TRACK_GAP_ENTER_S = 10;

/** Coarse forward track-gap distance (s) at which the track-ahead window closes — hysteresis. */
export const OPPONENT_FLAG_TRACK_GAP_EXIT_S = 12;

/** Standings-ahead window width in class positions. */
export const OPPONENT_FLAG_AHEAD_WINDOW = 3;

/** Speed floor (m/s) for the track-gap estimate — guards a stationary player from a division by zero. */
export const OPPONENT_FLAG_MIN_PLAYER_SPEED_MPS = 10;

/** The four per-driver penalty/status bits this module tracks, keyed to their `CarPenaltyFlags` field name. */
type FlagKey = "furled" | "black" | "repair" | "disqualify";

/** Table-driven flag catalog — one entry per bit, no copy-paste per flag in the loops below. */
const FLAG_DEFS: Array<{ key: FlagKey; bit: number; flag: OpponentPenaltyFlag }> = [
  { key: "furled", bit: Flags.Furled, flag: OpponentPenaltyFlag.Furled },
  { key: "black", bit: Flags.Black, flag: OpponentPenaltyFlag.Black },
  { key: "repair", bit: Flags.Repair, flag: OpponentPenaltyFlag.Repair },
  { key: "disqualify", bit: Flags.Disqualify, flag: OpponentPenaltyFlag.Disqualify },
];

type Classification = {
  relation: "ahead" | "behind" | "track-ahead";
  /** The car's effective position (class position in multi-class) at classify time; `0` when unresolved. */
  position: number;
  /** Coarse forward track gap in seconds — only set for `"track-ahead"`. */
  gapSeconds?: number;
};

/**
 * Classify a car's relation to the player for the qualification window
 * (issue #936). Standings relations first — the #622 `classify` structure
 * (same class + same lap, class-position delta) — then a coarse
 * track-relative fallback that ignores class and lap entirely, so a
 * different-class or different-lap car can still qualify by proximity even
 * though it can never win on standings. `wasInWindow` selects the
 * track-ahead hysteresis bound (the enter bound while outside last tick,
 * the wider exit bound while inside); standings membership has no
 * hysteresis.
 */
function classify(
  telemetry: TelemetryData,
  positions: number[],
  playerCarIdx: number,
  carIdx: number,
  isMultiClass: boolean,
  trackLengthMeters: number | null,
  wasInWindow: boolean,
): Classification | null {
  const carClasses = telemetry.CarIdxClass;
  const sameClass =
    !isMultiClass || (carClasses?.[playerCarIdx] !== undefined && carClasses[playerCarIdx] === carClasses[carIdx]);

  if (sameClass) {
    const carPos = isMultiClass ? classPositionFromOrder(positions, carClasses, carIdx) : (positions[carIdx] ?? 0);
    const playerPos = isMultiClass
      ? classPositionFromOrder(positions, carClasses, playerCarIdx)
      : (positions[playerCarIdx] ?? 0);

    if (carPos > 0 && playerPos > 0) {
      // Same lap: lap-progress scores within one full lap. Raw `CarIdxLap`
      // equality misbehaves around S/F crossings; the score form is what the
      // position machinery ranks by.
      const lc = telemetry.CarIdxLapCompleted;
      const dp = telemetry.CarIdxLapDistPct;
      const carLc = lc?.[carIdx] ?? -1;
      const playerLc = lc?.[playerCarIdx] ?? -1;
      const carDp = dp?.[carIdx] ?? -1;
      const playerDp = dp?.[playerCarIdx] ?? -1;

      if (carLc >= 0 && playerLc >= 0 && carDp >= 0 && playerDp >= 0) {
        const scoreGap = Math.abs(carLc + carDp - (playerLc + playerDp));

        if (scoreGap < 1.0) {
          const delta = playerPos - carPos;

          if (delta >= 1 && delta <= OPPONENT_FLAG_AHEAD_WINDOW) return { relation: "ahead", position: carPos };

          if (carPos - playerPos === 1) return { relation: "behind", position: carPos };
        }
      }
    }
  }

  // Track-relative fallback — independent of class and lap. `null` when the
  // car's own progress is missing (not in world) or the track length/player
  // progress isn't usable (coarseForwardGapSeconds's own validation).
  const carDp = telemetry.CarIdxLapDistPct?.[carIdx];

  if (typeof carDp !== "number") return null;

  const gapSeconds = coarseForwardGapSeconds(
    telemetry.LapDistPct ?? -1,
    carDp,
    trackLengthMeters,
    telemetry.Speed,
    OPPONENT_FLAG_MIN_PLAYER_SPEED_MPS,
  );

  if (gapSeconds === null) return null;

  const bound = wasInWindow ? OPPONENT_FLAG_TRACK_GAP_EXIT_S : OPPONENT_FLAG_TRACK_GAP_ENTER_S;

  if (gapSeconds > bound) return null;

  const position = isMultiClass ? classPositionFromOrder(positions, carClasses, carIdx) : (positions[carIdx] ?? 0);

  return { relation: "track-ahead", position, gapSeconds };
}

/**
 * Advance the per-car penalty-flag store and run the announce qualifier for
 * the current tick (issue #936).
 */
export function diffOpponentFlags(
  state: TranslatorState,
  telemetry: TelemetryData,
  playerCarIdx: number,
  paceCarIdx: number | null,
  isRaceSession: boolean,
  replayOnlySession: boolean,
  preGreen: boolean,
  postRace: boolean,
  isMultiClass: boolean,
  frozenPositions: number[],
  trackLengthMeters: number | null,
  now: number,
  emit: EmitFn,
): void {
  const raw = telemetry.CarIdxSessionFlags as number[] | undefined;

  if (!raw) return;

  // The very first tick is handled like a gated tick below: the store still
  // seeds, but nothing announces — a flag already active before the plugin
  // ever attached must not read as "just activated".
  const isFirstTick = !state.opponentFlagsInitialized;

  state.opponentFlagsInitialized = true;

  const bits = state.opponentFlagBits;
  const announced = state.opponentFlagAnnouncedMask;
  const furledSinceAt = state.opponentFlagFurledSinceAt;
  const effectiveMask = state.opponentFlagEffectiveMask;
  const cooldownUntil = state.opponentFlagCooldownUntil;

  // Effectively-active bits from the END of the previous tick, captured
  // before this tick's loop overwrites `effectiveMask` — the raised-vs-
  // entered-range transition detector below.
  const prevEffective: number[] = [];

  for (let i = 0; i < raw.length; i++) {
    const masked = (raw[i] ?? 0) & PENALTY_FLAG_MASK;

    bits[i] = masked;
    // Level-based, not edge-based: a flag's own bit dropping ends its
    // announced episode regardless of what else changed this tick.
    announced[i] = (announced[i] ?? 0) & masked;

    const decoded = decodePenaltyFlags(masked);

    if (decoded.furled) {
      // Kept while continuously up; seeded to `now` the tick it's first
      // found up (seed tick included — there is no earlier truth to read).
      furledSinceAt[i] = furledSinceAt[i] || now;
    } else {
      furledSinceAt[i] = 0;
    }

    prevEffective[i] = effectiveMask[i] ?? 0;

    let newEffective = 0;

    for (const def of FLAG_DEFS) {
      const active =
        def.key === "furled"
          ? furledSinceAt[i] > 0 && now - furledSinceAt[i] >= OPPONENT_FLAG_FURLED_DEBOUNCE_MS
          : decoded[def.key];

      if (active) newEffective |= def.bit;
    }

    effectiveMask[i] = newEffective;
  }

  bits.length = raw.length;
  announced.length = raw.length;
  furledSinceAt.length = raw.length;
  effectiveMask.length = raw.length;

  const gated = !isRaceSession || replayOnlySession || preGreen || postRace || playerCarIdx < 0;

  if (isFirstTick || gated) return;

  const lc = telemetry.CarIdxLapCompleted;
  const dp = telemetry.CarIdxLapDistPct;

  for (let i = 0; i < raw.length; i++) {
    if (i === playerCarIdx || i === paceCarIdx) continue;

    // In-world test (the race-finish.ts shape) — blipped/vanished cars skip.
    if ((lc?.[i] ?? -1) < 0 || (dp?.[i] ?? -1) < 0) continue;

    const wasInWindow = state.opponentFlagInWindow[i] ?? false;
    const classification = classify(
      telemetry,
      frozenPositions,
      playerCarIdx,
      i,
      isMultiClass,
      trackLengthMeters,
      wasInWindow,
    );

    state.opponentFlagInWindow[i] = classification !== null;

    if (!classification) continue;

    for (const def of FLAG_DEFS) {
      if ((effectiveMask[i] & def.bit) === 0) continue; // not effectively active

      if ((announced[i] & def.bit) !== 0) continue; // episode already announced

      const cooldownArr = cooldownUntil[def.key];

      if (now < (cooldownArr[i] ?? 0)) continue; // per-(car, flag) cooldown

      const activatedThisTick = (prevEffective[i] & def.bit) === 0;

      announced[i] |= def.bit;
      cooldownArr[i] = now + OPPONENT_FLAG_CAR_COOLDOWN_MS;

      emit({
        event: "opponentFlag.flagged",
        data: {
          relation: classification.relation,
          carIdx: i,
          flag: def.flag,
          trigger: activatedThisTick ? "raised" : "entered-range",
          isMultiClass,
          ...(classification.position > 0 ? { position: classification.position } : {}),
          ...(classification.relation === "track-ahead" ? { gapSeconds: classification.gapSeconds } : {}),
        },
      });
    }
  }
}
