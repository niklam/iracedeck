/**
 * Directional radar (proximity state) transitions.
 *
 * Emits `radar.changed { from, to }` when the resolved state changes.
 * Consumers (scenarios) start/stop repeating tick loops based on the new
 * state.
 */
import type { RadarState } from "@iracedeck/event-bus";
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

export function diffSpotter(state: TranslatorState, telemetry: TelemetryData, emit: EmitFn): void {
  const carLeftRight = telemetry.CarLeftRight ?? CarLeftRight.Off;
  const next = resolveRadarState(carLeftRight);

  if (next !== state.spotterState) {
    emit({ event: "radar.changed", data: { from: state.spotterState, to: next } });
    state.spotterState = next;
  }
}
