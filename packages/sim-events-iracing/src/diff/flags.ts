/**
 * Flag transitions.
 *
 * Publishes flag.*.raised when a flag appears in SessionFlags that wasn't
 * active last tick, and flag.yellow.cleared when all yellow-ish bits clear.
 *
 * Yellow handling (issue #480 rework): a *static* yellow (`Yellow` without
 * `YellowWaving`) / *static* caution (`Caution` without `CautionWaving`)
 * drives the existing `flag.yellow.raised {scope}` event; the waving variants
 * (`YellowWaving`, `CautionWaving`) drive their own (more urgent) callouts.
 * `flag.yellow.cleared` fires only when EVERY yellow-ish bit goes clear (so a
 * static→waving escalation never mis-clears) — tracked via `state.lastAnyYellow`.
 *
 * Blue is suppressed when Green is active (race-start sets both). Green is
 * suppressed when `StartGo` is set — a standing/rolling race-start go is owned
 * by the start-light family (issue #480); restarts (no `StartGo`) still fire.
 */
import type { FlagScope } from "@iracedeck/event-bus";
import { Flags, hasFlag, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

type FlagKey =
  | "green"
  | "yellow"
  | "blue"
  | "black"
  | "red"
  | "white"
  | "checkered"
  | "debris"
  | "meatball"
  | "disqualify"
  | "furled"
  | "dq-scoring-invalid"
  | "crossed"
  | "one-lap-to-green"
  | "green-held"
  | "ten-to-go"
  | "five-to-go"
  | "yellow-waving"
  | "caution-waving";

function resolveActiveFlags(sessionFlags: number): {
  flags: Set<FlagKey>;
  yellowScope: FlagScope | null;
  anyYellow: boolean;
} {
  const flags = new Set<FlagKey>();
  let yellowScope: FlagScope | null = null;

  if (hasFlag(sessionFlags, Flags.Green)) flags.add("green");

  // Yellow rework (issue #480). The *static* yellow drives the legacy
  // `flag.yellow.raised {scope}` event; the waving variants are separate
  // callouts. A static→waving escalation must not surface the static line.
  const yellowWaving = hasFlag(sessionFlags, Flags.YellowWaving);
  const cautionWaving = hasFlag(sessionFlags, Flags.CautionWaving);
  const localStatic = hasFlag(sessionFlags, Flags.Yellow) && !yellowWaving;
  const fullStatic = hasFlag(sessionFlags, Flags.Caution) && !cautionWaving;

  if (localStatic || fullStatic) {
    flags.add("yellow");
    yellowScope = fullStatic ? "full" : "local";
  }

  if (yellowWaving) flags.add("yellow-waving");

  if (cautionWaving) flags.add("caution-waving");

  // `anyYellow` is the true "is the field under any caution" signal, used for
  // the `flag.yellow.cleared` edge — independent of the static `"yellow"` key
  // (which leaves `activeFlags` on a static→waving escalation).
  const anyYellow =
    hasFlag(sessionFlags, Flags.Yellow) || yellowWaving || hasFlag(sessionFlags, Flags.Caution) || cautionWaving;

  if (hasFlag(sessionFlags, Flags.Blue)) flags.add("blue");

  // Disqualify is its own callout (issue #480) — split out of `black`.
  if (hasFlag(sessionFlags, Flags.Black)) flags.add("black");

  if (hasFlag(sessionFlags, Flags.Disqualify)) flags.add("disqualify");

  if (hasFlag(sessionFlags, Flags.Furled)) flags.add("furled");

  if (hasFlag(sessionFlags, Flags.DqScoringInvalid)) flags.add("dq-scoring-invalid");

  if (hasFlag(sessionFlags, Flags.Red)) flags.add("red");

  if (hasFlag(sessionFlags, Flags.White)) flags.add("white");

  if (hasFlag(sessionFlags, Flags.Checkered)) flags.add("checkered");

  if (hasFlag(sessionFlags, Flags.Debris)) flags.add("debris");

  // Meatball ("come in to pits, you have damage") — `Flags.Repair` in the SDK enum.
  if (hasFlag(sessionFlags, Flags.Repair)) flags.add("meatball");

  // Race-progression flags (issue #480).
  if (hasFlag(sessionFlags, Flags.Crossed)) flags.add("crossed");

  if (hasFlag(sessionFlags, Flags.OneLapToGreen)) flags.add("one-lap-to-green");

  if (hasFlag(sessionFlags, Flags.GreenHeld)) flags.add("green-held");

  if (hasFlag(sessionFlags, Flags.TenToGo)) flags.add("ten-to-go");

  if (hasFlag(sessionFlags, Flags.FiveToGo)) flags.add("five-to-go");

  // Race-start sets both green and blue bits — suppress blue.
  if (flags.has("green") && flags.has("blue")) flags.delete("blue");

  return { flags, yellowScope, anyYellow };
}

export function diffFlags(state: TranslatorState, telemetry: TelemetryData, emit: EmitFn): void {
  const sessionFlags = telemetry.SessionFlags ?? 0;
  const { flags: current, yellowScope, anyYellow } = resolveActiveFlags(sessionFlags);

  // First tick — seed without firing.
  if (!state.flagStateInitialized) {
    state.flagStateInitialized = true;
    state.activeFlags = current as Set<string>;
    state.lastYellowScope = yellowScope;
    state.lastAnyYellow = anyYellow;

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
          // Suppress green at a race start — `StartGo` means the start-light
          // family owns the "go" (issue #480). Restarts have no `StartGo`, so
          // green still fires there.
          if (!hasFlag(sessionFlags, Flags.StartGo)) {
            emit({ event: "flag.green.raised", data: {} });
          }

          break;
        case "blue":
          emit({ event: "flag.blue.raised", data: {} });
          break;
        case "black":
          emit({ event: "flag.black.raised", data: {} });
          break;
        case "disqualify":
          emit({ event: "flag.disqualify.raised", data: {} });
          break;
        case "furled":
          emit({ event: "flag.furled.raised", data: {} });
          break;
        case "dq-scoring-invalid":
          emit({ event: "flag.dq-scoring-invalid.raised", data: {} });
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
        case "crossed":
          emit({ event: "flag.crossed.raised", data: {} });
          break;
        case "one-lap-to-green":
          emit({ event: "flag.one-lap-to-green.raised", data: {} });
          break;
        case "green-held":
          emit({ event: "flag.green-held.raised", data: {} });
          break;
        case "ten-to-go":
          emit({ event: "flag.ten-to-go.raised", data: {} });
          break;
        case "five-to-go":
          emit({ event: "flag.five-to-go.raised", data: {} });
          break;
        case "yellow-waving":
          emit({ event: "flag.yellow-waving.raised", data: {} });
          break;
        case "caution-waving":
          emit({ event: "flag.caution-waving.raised", data: {} });
          break;
      }
    }
  }

  // Cleared transitions (yellow only — the event catalog only includes
  // yellow.cleared today). Fire when ALL yellow-ish bits clear after at least
  // one was set — NOT when a static yellow escalates to its waving variant.
  if (state.lastAnyYellow && !anyYellow) {
    emit({ event: "flag.yellow.cleared", data: {} });
  }

  state.activeFlags = current as Set<string>;
  state.lastYellowScope = yellowScope;
  state.lastAnyYellow = anyYellow;
}
