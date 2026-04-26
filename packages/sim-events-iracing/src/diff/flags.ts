/**
 * Flag transitions.
 *
 * Publishes flag.*.raised when a flag appears in SessionFlags that wasn't
 * active last tick, and flag.yellow.cleared when the yellow flag disappears.
 *
 * Yellow scope is "full" when Caution / CautionWaving bits are set, else
 * "local". Blue is suppressed when Green is active (race-start sets both).
 */
import type { FlagScope } from "@iracedeck/event-bus";
import { Flags, hasFlag, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

type FlagKey = "green" | "yellow" | "blue" | "black" | "red" | "white" | "checkered" | "debris" | "meatball";

function resolveActiveFlags(sessionFlags: number): { flags: Set<FlagKey>; yellowScope: FlagScope | null } {
  const flags = new Set<FlagKey>();
  let yellowScope: FlagScope | null = null;

  if (hasFlag(sessionFlags, Flags.Green)) flags.add("green");

  const fullYellow = hasFlag(sessionFlags, Flags.Caution) || hasFlag(sessionFlags, Flags.CautionWaving);
  const localYellow = hasFlag(sessionFlags, Flags.Yellow) || hasFlag(sessionFlags, Flags.YellowWaving);

  if (fullYellow || localYellow) {
    flags.add("yellow");
    yellowScope = fullYellow ? "full" : "local";
  }

  if (hasFlag(sessionFlags, Flags.Blue)) flags.add("blue");

  if (hasFlag(sessionFlags, Flags.Black) || hasFlag(sessionFlags, Flags.Disqualify)) flags.add("black");

  if (hasFlag(sessionFlags, Flags.Red)) flags.add("red");

  if (hasFlag(sessionFlags, Flags.White)) flags.add("white");

  if (hasFlag(sessionFlags, Flags.Checkered)) flags.add("checkered");

  if (hasFlag(sessionFlags, Flags.Debris)) flags.add("debris");

  // Meatball ("come in to pits, you have damage") — `Flags.Repair` in the SDK enum.
  if (hasFlag(sessionFlags, Flags.Repair)) flags.add("meatball");

  // Race-start sets both green and blue bits — suppress blue.
  if (flags.has("green") && flags.has("blue")) flags.delete("blue");

  return { flags, yellowScope };
}

export function diffFlags(state: TranslatorState, telemetry: TelemetryData, emit: EmitFn): void {
  const sessionFlags = telemetry.SessionFlags ?? 0;
  const { flags: current, yellowScope } = resolveActiveFlags(sessionFlags);

  // First tick — seed without firing.
  if (!state.flagStateInitialized) {
    state.flagStateInitialized = true;
    state.activeFlags = current as Set<string>;
    state.lastYellowScope = yellowScope;

    return;
  }

  // New "raised" transitions
  for (const flag of current) {
    if (!state.activeFlags.has(flag)) {
      switch (flag) {
        case "yellow":
          emit({ event: "flag.yellow.raised", data: { scope: yellowScope ?? "local" } });
          break;
        case "green":
          emit({ event: "flag.green.raised", data: {} });
          break;
        case "blue":
          emit({ event: "flag.blue.raised", data: {} });
          break;
        case "black":
          emit({ event: "flag.black.raised", data: {} });
          break;
        case "red":
          emit({ event: "flag.red.raised", data: {} });
          break;
        case "white":
          emit({ event: "flag.white.raised", data: {} });
          break;
        case "checkered":
          emit({ event: "flag.checkered.raised", data: {} });
          break;
        case "debris":
          emit({ event: "flag.debris.raised", data: {} });
          break;
        case "meatball":
          emit({ event: "flag.meatball.raised", data: {} });
          break;
      }
    }
  }

  // Cleared transitions (yellow only — the event catalog only includes yellow.cleared today)
  if (state.activeFlags.has("yellow") && !current.has("yellow")) {
    emit({ event: "flag.yellow.cleared", data: {} });
  }

  state.activeFlags = current as Set<string>;
  state.lastYellowScope = yellowScope;
}
