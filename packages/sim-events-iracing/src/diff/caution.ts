/**
 * The full-course caution sequence (issue #1127): the pace car's comings and
 * goings, the pickup, the laps behind it, one to go, and the restart.
 *
 * Every rule here was measured, not assumed — see
 * `docs/superpowers/specs/2026-09-17-issue-1127-oval-caution-restart.md` and the
 * committed fixture in `__fixtures__/caution-restart-20260917.json`.
 */
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import { resolvePaceCarIdx } from "./pace-laps.js";
import type { EmitFn } from "./types.js";

/** The pace car is on the road when its surface is a track surface rather than a pit one. */
function onTrack(surface: number | undefined): boolean {
  return surface === TrkLoc.OnTrack || surface === TrkLoc.OffTrack;
}

export function diffCaution(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  emit: EmitFn,
): void {
  const paceCarIdx = resolvePaceCarIdx(sessionInfo);
  const surfaces = telemetry.CarIdxTrackSurface;
  const surface = paceCarIdx !== null && Array.isArray(surfaces) ? surfaces[paceCarIdx] : undefined;

  if (!state.cautionInitialized) {
    state.cautionInitialized = true;
    state.cautionPaceCarSurface = surface ?? null;

    return;
  }

  const was = state.cautionPaceCarSurface;

  state.cautionPaceCarSurface = surface ?? null;

  if (surface === undefined || was === null) return;

  if (!onTrack(was) && onTrack(surface)) emit({ event: "paceCar.deployed", data: {} });
  else if (onTrack(was) && !onTrack(surface)) emit({ event: "paceCar.off", data: {} });
}
