/**
 * Overtake detection.
 *
 * Emits `overtake.completed { carIdx, sustained }` when the player's race
 * position improves and holds for OVERTAKE_HOLD_MS. Only during race
 * sessions, on track, not in pits, not under caution. Position jumps
 * greater than OVERTAKE_MAX_JUMP are treated as sim glitches (teleport,
 * tow) and ignored.
 *
 * `carIdx` in the event payload is the player's own car index — the
 * translator doesn't know which car was passed without session scoring
 * snapshots, so we carry the player's idx for correlation.
 */
import { calculateRacePositions, Flags, hasFlag, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

export const OVERTAKE_HOLD_MS = 3000;
export const OVERTAKE_MAX_JUMP = 3;

export function diffOvertakes(
  state: TranslatorState,
  telemetry: TelemetryData,
  playerCarIdx: number,
  isRaceSession: boolean,
  now: number,
  emit: EmitFn,
): void {
  const onPitRoad = telemetry.OnPitRoad ?? false;

  if (!isRaceSession || onPitRoad) {
    if (state.overtakeInitialized) {
      state.overtakeInitialized = false;
      state.lastPosition = -1;
      state.pendingOvertakePos = -1;
    }

    return;
  }

  const sessionFlags = telemetry.SessionFlags ?? 0;
  const underCaution =
    hasFlag(sessionFlags, Flags.Caution) ||
    hasFlag(sessionFlags, Flags.CautionWaving) ||
    hasFlag(sessionFlags, Flags.Yellow) ||
    hasFlag(sessionFlags, Flags.YellowWaving);

  const positions = calculateRacePositions(telemetry);
  const currentPos = playerCarIdx >= 0 ? positions[playerCarIdx] : -1;

  if (currentPos === undefined || currentPos <= 0) return;

  if (underCaution) {
    state.lastPosition = currentPos;
    state.pendingOvertakePos = -1;

    return;
  }

  if (!state.overtakeInitialized) {
    state.lastPosition = currentPos;
    state.overtakeInitialized = true;

    return;
  }

  if (state.pendingOvertakePos > 0) {
    if (currentPos <= state.pendingOvertakePos) {
      if (now - state.pendingOvertakeTime >= OVERTAKE_HOLD_MS) {
        emit({
          event: "overtake.completed",
          data: { carIdx: playerCarIdx, sustained: now - state.pendingOvertakeTime },
        });
        state.pendingOvertakePos = -1;
      }

      if (currentPos < state.pendingOvertakePos) {
        state.pendingOvertakePos = currentPos;
      }
    } else {
      state.pendingOvertakePos = -1;
    }
  }

  if (state.lastPosition > 0 && currentPos < state.lastPosition && state.pendingOvertakePos < 0) {
    const jump = state.lastPosition - currentPos;

    if (jump <= OVERTAKE_MAX_JUMP) {
      state.pendingOvertakePos = currentPos;
      state.pendingOvertakeTime = now;
    }
  }

  state.lastPosition = currentPos;
}
