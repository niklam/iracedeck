/**
 * Car Control's Wipers and Visor mode (#1463): one key that becomes whichever
 * of Tear Off Visor, Trigger Wipers and Toggle Wipers the current car has.
 *
 * The pure rules live here — which kind of car the user is in, which binding a
 * press sends, what the key shows, and which binding its missing-binding
 * warning checks — so `car-control.ts` only wires them in.
 *
 * Spec: docs/superpowers/specs/2026-10-20-issue-1463-car-control-wipers-and-visor.md
 */
import tearOffVisorIcon from "@iracedeck/icons/car-control/tear-off-visor.svg";
import wipersAndVisorIcon from "@iracedeck/icons/car-control/wipers-and-visor.svg";
import toggleWipersIcon from "@iracedeck/icons/cockpit-misc/toggle-wipers.svg";
import triggerWipersIcon from "@iracedeck/icons/cockpit-misc/trigger-wipers.svg";
import { hasVisor, hasWipers, isLiveOnTrack, type TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import { WIPERS_AND_VISOR_BINDINGS } from "./wipers-and-visor-bindings.js";

export { WIPERS_AND_VISOR_BINDING_KEYS, WIPERS_AND_VISOR_BINDINGS } from "./wipers-and-visor-bindings.js";

/** What a tap does on a wiper car; a long press does the other. */
export const WIPERS_ON_TAP_OPTIONS = ["trigger", "toggle"] as const;

export type WipersOnTap = (typeof WIPERS_ON_TAP_OPTIONS)[number];

/**
 * The per-key "Wipers on tap" setting. A key stored before the setting existed
 * (or holding a value this build does not know) reads as Trigger.
 */
export const WipersOnTapField = z.enum(WIPERS_ON_TAP_OPTIONS).default("trigger").catch("trigger");

/**
 * The kind of car the user is in:
 * - `visor` — an open-cockpit car with a tear-off visor;
 * - `wipers` — a car with windshield wipers;
 * - `unknown` — anything but a driver live in their own car (menus, garage,
 *   spectating, a replay, no sim), so the car cannot be told;
 * - `neither` — live in their own car, and the car exposes neither.
 */
export type WipersAndVisorKind = "visor" | "wipers" | "unknown" | "neither";

/** The resolved car, with which wiper variables a wiper car exposes. */
export type WipersAndVisorCar =
  { kind: "visor" } | { kind: "wipers"; trigger: boolean; toggle: boolean } | { kind: "unknown" } | { kind: "neither" };

/**
 * Resolve the car from a telemetry frame. Gated on `isLiveOnTrack` like the
 * Ignition and Starter keys: a replay publishes a full frame for the car being
 * watched, which is not the user's.
 *
 * #637 calls the visor and the wipers mutually exclusive; if a car ever
 * exposed both, the visor wins, since it is the variable iRacing names for
 * the one action an open cockpit has.
 */
export function resolveWipersAndVisorCar(telemetry: TelemetryData | null | undefined): WipersAndVisorCar {
  if (!telemetry || !isLiveOnTrack(telemetry)) return { kind: "unknown" };

  if (hasVisor(telemetry)) return { kind: "visor" };

  if (hasWipers(telemetry)) {
    return {
      kind: "wipers",
      trigger: telemetry.dcTriggerWindshieldWipers !== undefined,
      toggle: telemetry.dcToggleWindshieldWipers !== undefined,
    };
  }

  return { kind: "neither" };
}

/** The press a binding is chosen for: the key going down, or a release classified as a tap or a long press. */
export type WipersAndVisorPress = "down" | "tap" | "long";

/**
 * The binding a press sends, or null when it sends nothing.
 *
 * - A visor car tears off on key-down; its release sends nothing.
 * - A wiper car sends nothing on key-down. On release a tap sends the Wipers
 *   on tap choice (Trigger by default) and a long press the other. A car that
 *   exposes only one wiper variable gets that one's binding for both, so the
 *   key is never dead on a wiper car.
 * - An unknown car, or one with neither, sends nothing: a guess could tear
 *   off a visor on a car that turns out to have wipers.
 *
 * A `wipersOnTap` that is not `"toggle"` (including a missing one) reads as Trigger.
 */
export function wipersAndVisorBinding(
  car: WipersAndVisorCar,
  press: WipersAndVisorPress,
  wipersOnTap: WipersOnTap | undefined,
): string | null {
  if (car.kind === "visor") return press === "down" ? WIPERS_AND_VISOR_BINDINGS.visor : null;

  if (car.kind !== "wipers" || press === "down") return null;

  if (car.trigger !== car.toggle) {
    return car.trigger ? WIPERS_AND_VISOR_BINDINGS.trigger : WIPERS_AND_VISOR_BINDINGS.toggle;
  }

  const tapToggles = wipersOnTap === "toggle";
  const sendsToggle = press === "tap" ? tapToggles : !tapToggles;

  return sendsToggle ? WIPERS_AND_VISOR_BINDINGS.toggle : WIPERS_AND_VISOR_BINDINGS.trigger;
}

/**
 * The binding the key's missing-binding warning checks, or null for none. It
 * follows the resolved car so the warning never nags a driver about the side
 * they never bind: a visor car checks the visor binding, a wiper car the
 * binding its tap sends (deck-core's warning is one flag, so the long press is
 * not checked), and an unknown car or one with neither checks nothing.
 */
export function wipersAndVisorRequiredBinding(
  car: WipersAndVisorCar,
  wipersOnTap: WipersOnTap | undefined,
): string | null {
  if (car.kind === "visor") return wipersAndVisorBinding(car, "down", wipersOnTap);

  if (car.kind === "wipers") return wipersAndVisorBinding(car, "tap", wipersOnTap);

  return null;
}

/** What the key shows: its artwork, default title, and whether it is drawn in the unavailable look. */
export interface WipersAndVisorAppearance {
  iconSvg: string;
  title: string;
  unavailable: boolean;
}

/** Whether a wiper car's tap sends Toggle Wipers, which is what its key shows. */
function tapToggles(
  car: Extract<WipersAndVisorCar, { kind: "wipers" }>,
  wipersOnTap: WipersOnTap | undefined,
): boolean {
  return wipersAndVisorBinding(car, "tap", wipersOnTap) === WIPERS_AND_VISOR_BINDINGS.toggle;
}

/**
 * The key's appearance for a car and the Wipers on tap choice. A known car
 * shows the existing artwork of what a tap does (the visor, or the wiper
 * action a tap actually sends — on a car with only one wiper variable that is
 * the one it has, whatever the swap); an unknown car shows the combined icon;
 * a car with neither shows it in the unavailable look.
 */
export function wipersAndVisorAppearance(
  car: WipersAndVisorCar,
  wipersOnTap: WipersOnTap | undefined,
): WipersAndVisorAppearance {
  switch (car.kind) {
    case "visor":
      return { iconSvg: tearOffVisorIcon, title: "VISOR\nTEAR OFF", unavailable: false };
    case "wipers":
      return tapToggles(car, wipersOnTap)
        ? { iconSvg: toggleWipersIcon, title: "TOGGLE\nWIPERS", unavailable: false }
        : { iconSvg: triggerWipersIcon, title: "TRIGGER\nWIPERS", unavailable: false };
    case "neither":
      return { iconSvg: wipersAndVisorIcon, title: "WIPERS\nVISOR", unavailable: true };
    case "unknown":
      return { iconSvg: wipersAndVisorIcon, title: "WIPERS\nVISOR", unavailable: false };
  }
}

/**
 * The part of the render key this mode owns: the resolved kind and, on a wiper
 * car, which wiper action a tap sends, so the key is redrawn only when what it
 * shows changes.
 */
export function wipersAndVisorRenderKey(car: WipersAndVisorCar, wipersOnTap: WipersOnTap | undefined): string {
  if (car.kind !== "wipers") return car.kind;

  return `wipers|${tapToggles(car, wipersOnTap) ? "toggle" : "trigger"}`;
}
