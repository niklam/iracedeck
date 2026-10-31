/**
 * Directional radar (proximity state) transitions.
 *
 * Emits `radar.changed { from, to }` when the resolved state changes.
 * Consumers (scenarios) start/stop repeating tick loops based on the new
 * state.
 */
import type { RadarState, SimEventName } from "@iracedeck/event-bus";
import { CarLeftRight, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

export function resolveRadarState(carLeftRight: number): RadarState {
  switch (carLeftRight) {
    case CarLeftRight.CarLeft:
      return "left";
    case CarLeftRight.CarRight:
      return "right";
    case CarLeftRight.CarLeftRight:
      return "both";
    case CarLeftRight.TwoCarsLeft:
      return "two-left";
    case CarLeftRight.TwoCarsRight:
      return "two-right";
    case CarLeftRight.Off:
    case CarLeftRight.Clear:
    default:
      return "clear";
  }
}

/** The events {@link diffRadar} emits (issue #1499): its emitter's type, and its row in `TICK_ORDER`. */
export const RADAR_EVENTS = ["radar.changed"] as const satisfies readonly SimEventName[];

export function diffRadar(
  state: TranslatorState,
  telemetry: TelemetryData,
  emit: EmitFn<(typeof RADAR_EVENTS)[number]>,
): void {
  const carLeftRight = telemetry.CarLeftRight ?? CarLeftRight.Off;
  const next = resolveRadarState(carLeftRight);

  if (next !== state.radarState) {
    emit({ event: "radar.changed", data: { from: state.radarState, to: next } });
    state.radarState = next;
  }
}
