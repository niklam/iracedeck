/**
 * Pit service and car control toggle transitions.
 *
 * Emits:
 *   - pitService.toggled { service, on } — when Fuel / WindshieldTearoff /
 *     FastRepair bits in PitSvFlags flip.
 *   - tireService.changed { added, removed } — when tire service bits flip.
 *   - carControl.drsToggled / p2pToggled / limiterToggled { on } — on
 *     respective bit changes.
 *
 * Seeded on first tick (or when IsOnTrack is false) to avoid false
 * transitions on connect / garage returns.
 */
import { EngineWarnings, PitSvFlags, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

// Tire flag → human-readable name (matches pit-engineer's TIRE_SHORT domain)
const TIRE_FLAGS: ReadonlyArray<{ flag: number; name: string }> = [
  { flag: PitSvFlags.LFTireChange, name: "LF" },
  { flag: PitSvFlags.RFTireChange, name: "RF" },
  { flag: PitSvFlags.LRTireChange, name: "LR" },
  { flag: PitSvFlags.RRTireChange, name: "RR" },
];

function tireSet(flags: number): Set<string> {
  const s = new Set<string>();

  for (const { flag, name } of TIRE_FLAGS) {
    if ((flags & flag) !== 0) s.add(name);
  }

  return s;
}

export function diffToggles(state: TranslatorState, telemetry: TelemetryData, emit: EmitFn): void {
  const pitSvFlags = telemetry.PitSvFlags ?? 0;
  const limiter = ((telemetry.EngineWarnings ?? 0) & EngineWarnings.PitSpeedLimiter) !== 0;
  const p2p = telemetry.P2P_Status === true;
  const drs = (telemetry.DRS_Status ?? 0) > 0;
  const isOnTrack = telemetry.IsOnTrack ?? false;
  const pitSvCompound = telemetry.PitSvTireCompound ?? 0;

  // First tick, or off-track — capture state silently.
  if (!state.toggleStateInitialized || !isOnTrack) {
    state.toggleStateInitialized = true;
    state.lastPitSvFlags = pitSvFlags;
    state.lastPitSvCompound = pitSvCompound;
    state.lastLimiterActive = limiter;
    state.lastP2PActive = p2p;
    state.lastDrsActive = drs;

    return;
  }

  // ── Pit service (fuel / windshield / fast-repair) ──────────────────────
  const prevFuel = (state.lastPitSvFlags & PitSvFlags.FuelFill) !== 0;
  const currFuel = (pitSvFlags & PitSvFlags.FuelFill) !== 0;

  if (prevFuel !== currFuel) {
    emit({ event: "pitService.toggled", data: { service: "fuel", on: currFuel } });
  }

  const prevWindshield = (state.lastPitSvFlags & PitSvFlags.WindshieldTearoff) !== 0;
  const currWindshield = (pitSvFlags & PitSvFlags.WindshieldTearoff) !== 0;

  if (prevWindshield !== currWindshield) {
    emit({ event: "pitService.toggled", data: { service: "windshield", on: currWindshield } });
  }

  const prevFastRepair = (state.lastPitSvFlags & PitSvFlags.FastRepair) !== 0;
  const currFastRepair = (pitSvFlags & PitSvFlags.FastRepair) !== 0;

  if (prevFastRepair !== currFastRepair) {
    emit({ event: "pitService.toggled", data: { service: "fastRepair", on: currFastRepair } });
  }

  // ── Tire service (4 tires) ─────────────────────────────────────────────
  const prevTires = tireSet(state.lastPitSvFlags);
  const currTires = tireSet(pitSvFlags);
  const added: string[] = [];
  const removed: string[] = [];

  for (const t of currTires) {
    if (!prevTires.has(t)) added.push(t);
  }

  for (const t of prevTires) {
    if (!currTires.has(t)) removed.push(t);
  }

  if (added.length > 0 || removed.length > 0) {
    emit({ event: "tireService.changed", data: { added, removed } });
  }

  // ── Car control toggles ────────────────────────────────────────────────
  if (state.lastDrsActive !== drs) {
    emit({ event: "carControl.drsToggled", data: { on: drs } });
  }

  if (state.lastP2PActive !== p2p) {
    emit({ event: "carControl.p2pToggled", data: { on: p2p } });
  }

  if (state.lastLimiterActive !== limiter) {
    emit({ event: "carControl.limiterToggled", data: { on: limiter } });
  }

  state.lastPitSvFlags = pitSvFlags;
  state.lastPitSvCompound = pitSvCompound;
  state.lastLimiterActive = limiter;
  state.lastP2PActive = p2p;
  state.lastDrsActive = drs;
}
