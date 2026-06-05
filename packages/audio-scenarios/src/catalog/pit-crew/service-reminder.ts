/**
 * Service-reminder scenario — fires when the driver enters pit lane.
 *
 * Tells the driver which services are queued (fast repair, fuel / auto-fuel,
 * tire compound / generic tires). The step tree is conditional on the
 * current-tick telemetry carried by the event envelope.
 *
 * Weight / deferral:
 *   - `weight: WEIGHT.CHATTER` + `queueable: true` so the interpreter defers
 *     this fire if another scenario (approach, exit, stall departure) is still
 *     playing. The deferred fire is replayed automatically when the bus
 *     goes idle. This replaces the legacy 1500 ms fixed delay with a
 *     smarter wait-until-done semantic.
 *
 * Telemetry bitfields are decoded inline — keeping the logic in a pure
 * helper lets us unit-test service resolution without the DSL.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { PitSvFlags } from "@iracedeck/iracing-sdk";

import { WEIGHT } from "../../dsl.js";
import type { Scenario, ScenarioContext } from "../../dsl.js";

/** True when any tire-change flag is set in PitSvFlags. */
export function hasTireChange(flags: number): boolean {
  return (
    (flags & PitSvFlags.LFTireChange) !== 0 ||
    (flags & PitSvFlags.RFTireChange) !== 0 ||
    (flags & PitSvFlags.LRTireChange) !== 0 ||
    (flags & PitSvFlags.RRTireChange) !== 0
  );
}

/** True when the queued compound differs from the one on the car. */
export function isCompoundChange(flags: number, playerCompound: number, pitSvCompound: number): boolean {
  return hasTireChange(flags) && pitSvCompound !== 0 && pitSvCompound !== playerCompound;
}

function telemetry(ctx: ScenarioContext): TelemetryData | null {
  return (ctx.telemetry as TelemetryData | null) ?? null;
}

function pitSvFlags(ctx: ScenarioContext): number {
  return telemetry(ctx)?.PitSvFlags ?? 0;
}

export const SERVICE_REMINDER: Scenario = {
  id: "pit-crew.service-reminder",
  when: { event: "pitLane.entered" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  weight: WEIGHT.CHATTER,
  queueable: true,
  sequence: [
    "@pit-crew.radio-open",
    {
      if: (ctx) => (pitSvFlags(ctx) & PitSvFlags.FastRepair) !== 0,
      then: ["reminder/IRD-pit-reminder-fast-repair.mp3"],
    },
    {
      if: (ctx) => Boolean(telemetry(ctx)?.dpFuelAutoFillActive),
      then: ["pool:autofuel-reminder"],
      else: [
        {
          if: (ctx) => (pitSvFlags(ctx) & PitSvFlags.FuelFill) !== 0,
          then: ["reminder/IRD-pit-reminder-fuel.mp3"],
        },
      ],
    },
    {
      if: (ctx) => hasTireChange(pitSvFlags(ctx)),
      then: [
        {
          if: (ctx) => {
            const t = telemetry(ctx);

            return isCompoundChange(pitSvFlags(ctx), t?.PlayerTireCompound ?? 0, t?.PitSvTireCompound ?? 0);
          },
          then: ["reminder/IRD-pit-reminder-compound.mp3"],
          else: ["reminder/IRD-pit-reminder-tires.mp3"],
        },
      ],
    },
    "@pit-crew.radio-close",
  ],
};
