/**
 * Directional spotter (proximity state) transitions.
 *
 * Emits `spotter.changed { from, to }` when the resolved state changes.
 * Consumers (scenarios) start/stop repeating tick loops based on the new
 * state.
 */
import type { SpotterState } from "@iracedeck/event-bus";
import { CarLeftRight, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

export function resolveSpotterState(carLeftRight: number): SpotterState {
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
  const next = resolveSpotterState(carLeftRight);

  if (next !== state.spotterState) {
    emit({ event: "spotter.changed", data: { from: state.spotterState, to: next } });
    state.spotterState = next;
  }
}
