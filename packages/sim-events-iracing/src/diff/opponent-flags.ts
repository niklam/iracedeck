/**
 * Opponent penalty-flag store (issue #936).
 *
 * **Store = truth, qualifier = policy.** This module holds the flag-state
 * STORE: raw decoded per-car penalty flags (`PENALTY_FLAG_MASK` over
 * `CarIdxSessionFlags`) with no debounce, no episodes, no cooldowns — the
 * reusable seam (`getLiveOpponentFlags()` in `translator.ts`) reads it
 * directly. Announcement POLICY (raise/range-entry trigger classification,
 * the furled debounce, per-(car, flag) cooldowns, and burst aggregation)
 * stays private to this diff and lands in Tasks 5–6 on top of the skeleton
 * shipped here.
 *
 * The store advances every tick from the live array length (never a fixed
 * 64 — a real capture showed length 72 with the pace car at index 64) and
 * keeps advancing even while the eventual callout gates are closed, so a
 * gated tick is absorbed rather than replayed once the gate reopens (the
 * `diffOpponentPit` precedent).
 *
 * Two pieces of level-based (not edge-based) per-car cleanup run every tick
 * regardless of gating, since they describe the CURRENT bit state rather
 * than a transition:
 * - `opponentFlagAnnouncedMask[i] &= bits` — a flag's own bit dropping ends
 *   that flag's announced episode (Task 5's dedup reads this).
 * - `opponentFlagFurledSinceAt[i]` — the epoch ms the Furled bit has been
 *   continuously up, kept while it stays up (not reset every tick), seeded
 *   to `now` the tick it's found already up (including the very first
 *   store tick), and cleared to `0` while it's down. Task 5's #669 debounce
 *   reads this to tell a flicker apart from a sustained raise.
 */
import { decodePenaltyFlags, PENALTY_FLAG_MASK, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/** Rolling window for counting near-simultaneous eligible flag announcements (Task 6). */
export const OPPONENT_FLAG_AGGREGATE_WINDOW_MS = 12_000;

/** Eligible announcements within the window at which enumeration collapses (Task 6). */
export const OPPONENT_FLAG_AGGREGATE_THRESHOLD = 3;

/** Per-(car, flag) re-announce cooldown — an escalation (black → DQ) is never suppressed by it (Task 5). */
export const OPPONENT_FLAG_CAR_COOLDOWN_MS = 30_000;

/** How long the Furled bit must stay continuously up before it announces (the #669 flicker guard, Task 5). */
export const OPPONENT_FLAG_FURLED_DEBOUNCE_MS = 1_000;

/** Coarse forward track-gap distance (s) at which the track-ahead window opens (Task 5). */
export const OPPONENT_FLAG_TRACK_GAP_ENTER_S = 10;

/** Coarse forward track-gap distance (s) at which the track-ahead window closes — hysteresis (Task 5). */
export const OPPONENT_FLAG_TRACK_GAP_EXIT_S = 12;

/** Standings-ahead window width in class positions (Task 5). */
export const OPPONENT_FLAG_AHEAD_WINDOW = 3;

/** Speed floor (m/s) for the track-gap estimate — guards a stationary player from a division by zero (Task 5). */
export const OPPONENT_FLAG_MIN_PLAYER_SPEED_MPS = 10;

/**
 * Advance the per-car penalty-flag store for the current tick (issue #936).
 *
 * This task ships the STORE responsibility only — decode, size, and
 * level-based cleanup. Trigger classification, gating, and emission are
 * Tasks 5–6; the gate/position/track-length parameters are accepted now
 * (so the call site and signature are stable) but not yet consumed.
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
  // Trigger classification, gating, and emission land in Tasks 5–6; this
  // task only advances the store, so these are unused for now.
  void playerCarIdx; // consumed from Task 5 on
  void paceCarIdx; // consumed from Task 5 on
  void isRaceSession; // consumed from Task 5 on
  void replayOnlySession; // consumed from Task 5 on
  void preGreen; // consumed from Task 5 on
  void postRace; // consumed from Task 5 on
  void isMultiClass; // consumed from Task 5 on
  void frozenPositions; // consumed from Task 5 on
  void trackLengthMeters; // consumed from Task 5 on
  void emit; // consumed from Task 5 on

  const raw = telemetry.CarIdxSessionFlags as number[] | undefined;

  if (!raw) return;

  state.opponentFlagsInitialized = true;

  const bits = state.opponentFlagBits;
  const announced = state.opponentFlagAnnouncedMask;
  const furledSinceAt = state.opponentFlagFurledSinceAt;

  for (let i = 0; i < raw.length; i++) {
    const masked = (raw[i] ?? 0) & PENALTY_FLAG_MASK;

    bits[i] = masked;
    // Level-based, not edge-based: a flag's own bit dropping ends its
    // announced episode regardless of what else changed this tick.
    announced[i] = (announced[i] ?? 0) & masked;

    if (decodePenaltyFlags(masked).furled) {
      // Kept while continuously up; seeded to `now` the tick it's first
      // found up (seed tick included — there is no earlier truth to read).
      furledSinceAt[i] = furledSinceAt[i] || now;
    } else {
      furledSinceAt[i] = 0;
    }
  }

  bits.length = raw.length;
  announced.length = raw.length;
  furledSinceAt.length = raw.length;
}
