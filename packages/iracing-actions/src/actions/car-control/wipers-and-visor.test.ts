import tearOffVisorIcon from "@iracedeck/icons/car-control/tear-off-visor.svg";
import wipersAndVisorIcon from "@iracedeck/icons/car-control/wipers-and-visor.svg";
import toggleWipersIcon from "@iracedeck/icons/cockpit-misc/toggle-wipers.svg";
import triggerWipersIcon from "@iracedeck/icons/cockpit-misc/trigger-wipers.svg";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import {
  resolveWipersAndVisorCar,
  WIPERS_AND_VISOR_BINDING_KEYS,
  WIPERS_AND_VISOR_BINDINGS,
  wipersAndVisorAppearance,
  wipersAndVisorBinding,
  type WipersAndVisorCar,
  wipersAndVisorRenderKey,
  wipersAndVisorRequiredBinding,
  WipersOnTapField,
} from "./wipers-and-visor.js";

/** A frame of a driver live in their own car, plus the car's own variables. */
const live = (car: Partial<TelemetryData>): TelemetryData =>
  ({ IsOnTrack: true, IsReplayPlaying: false, ...car }) as TelemetryData;

const VISOR_CAR: Partial<TelemetryData> = { dcTearOffVisor: false };
const WIPER_CAR: Partial<TelemetryData> = { dcTriggerWindshieldWipers: false, dcToggleWindshieldWipers: false };

const visor: WipersAndVisorCar = { kind: "visor" };
const wipers: WipersAndVisorCar = { kind: "wipers", trigger: true, toggle: true, on: false };
const wipersOn: WipersAndVisorCar = { kind: "wipers", trigger: true, toggle: true, on: true };
const triggerOnly: WipersAndVisorCar = { kind: "wipers", trigger: true, toggle: false, on: false };
const toggleOnly: WipersAndVisorCar = { kind: "wipers", trigger: false, toggle: true, on: false };
const unknown: WipersAndVisorCar = { kind: "unknown" };
const neither: WipersAndVisorCar = { kind: "neither" };

const { visor: VISOR, trigger: TRIGGER, toggle: TOGGLE } = WIPERS_AND_VISOR_BINDINGS;

describe("wipers-and-visor (#1463)", () => {
  describe("bindings", () => {
    it("reuses the existing global bindings", () => {
      expect(WIPERS_AND_VISOR_BINDINGS).toEqual({
        visor: "carControlTearOffVisor",
        trigger: "cockpitMiscTriggerWipers",
        toggle: "cockpitMiscToggleWipers",
      });
      expect(WIPERS_AND_VISOR_BINDING_KEYS).toEqual([VISOR, TRIGGER, TOGGLE]);
    });
  });

  describe("WipersOnTapField", () => {
    it("reads a key stored without the setting as Trigger", () => {
      expect(WipersOnTapField.parse(undefined)).toBe("trigger");
    });

    it("reads an unknown stored value as Trigger", () => {
      expect(WipersOnTapField.parse("sideways")).toBe("trigger");
    });

    it("keeps both known values", () => {
      expect(WipersOnTapField.parse("trigger")).toBe("trigger");
      expect(WipersOnTapField.parse("toggle")).toBe("toggle");
    });
  });

  describe("resolveWipersAndVisorCar", () => {
    it("is unknown with no telemetry", () => {
      expect(resolveWipersAndVisorCar(null)).toEqual(unknown);
      expect(resolveWipersAndVisorCar(undefined)).toEqual(unknown);
    });

    it("is unknown off track (menus, garage before getting in)", () => {
      expect(resolveWipersAndVisorCar({ ...VISOR_CAR, IsOnTrack: false } as TelemetryData)).toEqual(unknown);
    });

    it("is unknown in a replay, even with a full frame for the watched car", () => {
      expect(
        resolveWipersAndVisorCar({ ...WIPER_CAR, IsOnTrack: true, IsReplayPlaying: true } as TelemetryData),
      ).toEqual(unknown);
    });

    it("is a visor car when the car exposes dcTearOffVisor", () => {
      expect(resolveWipersAndVisorCar(live(VISOR_CAR))).toEqual(visor);
    });

    it("is a wiper car, with both variables, when the car exposes both", () => {
      expect(resolveWipersAndVisorCar(live(WIPER_CAR))).toEqual(wipers);
    });

    it("records which wiper variable a one-variable car exposes", () => {
      expect(resolveWipersAndVisorCar(live({ dcTriggerWindshieldWipers: false }))).toEqual(triggerOnly);
      expect(resolveWipersAndVisorCar(live({ dcToggleWindshieldWipers: false }))).toEqual(toggleOnly);
    });

    it("is neither when live in a car that exposes no visor and no wipers", () => {
      expect(resolveWipersAndVisorCar(live({}))).toEqual(neither);
    });

    it("reads whether the wipers are on from the Toggle variable", () => {
      expect(resolveWipersAndVisorCar(live({ ...WIPER_CAR, dcToggleWindshieldWipers: true }))).toEqual(wipersOn);
      expect(resolveWipersAndVisorCar(live({ dcTriggerWindshieldWipers: true }))).toEqual(triggerOnly);
    });

    it("prefers the visor if a car ever exposed both", () => {
      expect(resolveWipersAndVisorCar(live({ ...VISOR_CAR, ...WIPER_CAR }))).toEqual(visor);
    });
  });

  describe("wipersAndVisorBinding", () => {
    it("tears off the visor on key-down, and sends nothing on release", () => {
      expect(wipersAndVisorBinding(visor, "down", "trigger")).toBe(VISOR);
      expect(wipersAndVisorBinding(visor, "tap", "trigger")).toBeNull();
      expect(wipersAndVisorBinding(visor, "long", "toggle")).toBeNull();
    });

    it("sends nothing on key-down on a wiper car", () => {
      expect(wipersAndVisorBinding(wipers, "down", "trigger")).toBeNull();
      expect(wipersAndVisorBinding(wipers, "down", "toggle")).toBeNull();
    });

    it("by default triggers on a tap and toggles on a long press", () => {
      expect(wipersAndVisorBinding(wipers, "tap", "trigger")).toBe(TRIGGER);
      expect(wipersAndVisorBinding(wipers, "long", "trigger")).toBe(TOGGLE);
    });

    it("swaps the two when Wipers on tap is Toggle", () => {
      expect(wipersAndVisorBinding(wipers, "tap", "toggle")).toBe(TOGGLE);
      expect(wipersAndVisorBinding(wipers, "long", "toggle")).toBe(TRIGGER);
    });

    it("turns running wipers off on a tap, whatever the swap; the long press is unchanged", () => {
      expect(wipersAndVisorBinding(wipersOn, "tap", "trigger")).toBe(TOGGLE);
      expect(wipersAndVisorBinding(wipersOn, "tap", "toggle")).toBe(TOGGLE);
      expect(wipersAndVisorBinding(wipersOn, "tap", undefined)).toBe(TOGGLE);
      expect(wipersAndVisorBinding(wipersOn, "long", "trigger")).toBe(TOGGLE);
      expect(wipersAndVisorBinding(wipersOn, "long", "toggle")).toBe(TRIGGER);
      expect(wipersAndVisorBinding(wipersOn, "down", "trigger")).toBeNull();
    });

    it("reads a missing Wipers on tap as Trigger", () => {
      expect(wipersAndVisorBinding(wipers, "tap", undefined)).toBe(TRIGGER);
      expect(wipersAndVisorBinding(wipers, "long", undefined)).toBe(TOGGLE);
    });

    it("sends the one variable's binding for both presses on a one-variable car", () => {
      for (const swap of ["trigger", "toggle"] as const) {
        expect(wipersAndVisorBinding(triggerOnly, "tap", swap)).toBe(TRIGGER);
        expect(wipersAndVisorBinding(triggerOnly, "long", swap)).toBe(TRIGGER);
        expect(wipersAndVisorBinding(toggleOnly, "tap", swap)).toBe(TOGGLE);
        expect(wipersAndVisorBinding(toggleOnly, "long", swap)).toBe(TOGGLE);
      }
    });

    it("sends nothing for an unknown car or one with neither", () => {
      for (const car of [unknown, neither]) {
        for (const press of ["down", "tap", "long"] as const) {
          expect(wipersAndVisorBinding(car, press, "trigger")).toBeNull();
        }
      }
    });
  });

  describe("wipersAndVisorRequiredBinding", () => {
    it("checks the visor binding on a visor car, never a wiper binding", () => {
      expect(wipersAndVisorRequiredBinding(visor, "trigger")).toBe(VISOR);
      expect(wipersAndVisorRequiredBinding(visor, "toggle")).toBe(VISOR);
    });

    it("checks the binding a tap sends on a wiper car", () => {
      expect(wipersAndVisorRequiredBinding(wipers, "trigger")).toBe(TRIGGER);
      expect(wipersAndVisorRequiredBinding(wipers, "toggle")).toBe(TOGGLE);
      expect(wipersAndVisorRequiredBinding(toggleOnly, "trigger")).toBe(TOGGLE);
      expect(wipersAndVisorRequiredBinding(wipersOn, "trigger")).toBe(TOGGLE);
    });

    it("checks nothing for an unknown car or one with neither", () => {
      expect(wipersAndVisorRequiredBinding(unknown, "trigger")).toBeNull();
      expect(wipersAndVisorRequiredBinding(neither, "trigger")).toBeNull();
    });
  });

  describe("wipersAndVisorAppearance", () => {
    it("shows the Tear Off Visor art on a visor car, whatever the swap", () => {
      for (const swap of ["trigger", "toggle"] as const) {
        expect(wipersAndVisorAppearance(visor, swap)).toEqual({
          iconSvg: tearOffVisorIcon,
          title: "VISOR\nTEAR OFF",
          unavailable: false,
        });
      }
    });

    it("shows what a tap does on a wiper car", () => {
      expect(wipersAndVisorAppearance(wipers, "trigger")).toEqual({
        iconSvg: triggerWipersIcon,
        title: "TRIGGER\nWIPERS",
        unavailable: false,
      });
      expect(wipersAndVisorAppearance(wipers, undefined).iconSvg).toBe(triggerWipersIcon);
      expect(wipersAndVisorAppearance(wipers, "toggle")).toEqual({
        iconSvg: toggleWipersIcon,
        title: "TOGGLE\nWIPERS",
        unavailable: false,
      });
    });

    it("shows the Toggle Wipers art while the wipers are on, since a tap turns them off", () => {
      for (const swap of ["trigger", "toggle"] as const) {
        expect(wipersAndVisorAppearance(wipersOn, swap)).toEqual({
          iconSvg: toggleWipersIcon,
          title: "TOGGLE\nWIPERS",
          unavailable: false,
        });
      }
    });

    it("shows the combined icon for an unknown car", () => {
      expect(wipersAndVisorAppearance(unknown, "trigger")).toEqual({
        iconSvg: wipersAndVisorIcon,
        title: "WIPERS\nVISOR",
        unavailable: false,
      });
    });

    it("shows the combined icon in the unavailable look for a car with neither", () => {
      expect(wipersAndVisorAppearance(neither, "trigger")).toEqual({
        iconSvg: wipersAndVisorIcon,
        title: "WIPERS\nVISOR",
        unavailable: true,
      });
    });

    it("shows the one wiper action a single-variable car has, whatever the swap", () => {
      for (const swap of ["trigger", "toggle"] as const) {
        expect(wipersAndVisorAppearance(triggerOnly, swap).iconSvg).toBe(triggerWipersIcon);
        expect(wipersAndVisorAppearance(toggleOnly, swap).iconSvg).toBe(toggleWipersIcon);
      }
    });

    it("draws four distinct artworks", () => {
      expect(new Set([tearOffVisorIcon, triggerWipersIcon, toggleWipersIcon, wipersAndVisorIcon]).size).toBe(4);
    });
  });

  describe("wipersAndVisorRenderKey", () => {
    it("changes with the kind and, on a wiper car, with the swap", () => {
      const keys = new Set([
        wipersAndVisorRenderKey(visor, "trigger"),
        wipersAndVisorRenderKey(unknown, "trigger"),
        wipersAndVisorRenderKey(neither, "trigger"),
        wipersAndVisorRenderKey(wipers, "trigger"),
        wipersAndVisorRenderKey(wipers, "toggle"),
      ]);
      expect(keys.size).toBe(5);
    });

    it("changes when the wipers turn on under the default swap", () => {
      expect(wipersAndVisorRenderKey(wipersOn, "trigger")).not.toBe(wipersAndVisorRenderKey(wipers, "trigger"));
    });

    it("does not change with the swap where the art does not", () => {
      for (const car of [visor, unknown, neither, triggerOnly, toggleOnly]) {
        expect(wipersAndVisorRenderKey(car, "toggle")).toBe(wipersAndVisorRenderKey(car, "trigger"));
      }
    });

    it("treats a missing swap as Trigger", () => {
      expect(wipersAndVisorRenderKey(wipers, undefined)).toBe(wipersAndVisorRenderKey(wipers, "trigger"));
    });
  });
});
