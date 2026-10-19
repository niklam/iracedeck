import { describe, expect, it } from "vitest";

import { parseSessionInfoYaml } from "./session-yaml.js";

// Cut from a live dump: EURO NASCAR V8GP, Adelaide, iRacing build 2026.10.01.01 (#1461)
const EURO_NASCAR_CAR_SETUP = [
  "---",
  "DriverInfo:",
  " DriverCarIdx: 0",
  " Drivers:",
  " - CarIdx: 0",
  '   CarNumber: "46"',
  "CarSetup:",
  " UpdateCount: 1",
  " Tires:",
  "  TireType:",
  "   TireType: Dry",
  " Tires:",
  "  LeftFront:",
  "   ColdPressure: 159 kPa",
  "   TreadRemaining: 100%, 100%, 100%",
  " Chassis:",
  "  Rear:",
  "   FuelFillTo: 50.0 L",
  "",
  "...",
  "",
].join("\n");

describe("parseSessionInfoYaml", () => {
  it("merges the Euro NASCAR's two CarSetup.Tires sections, keeping both", () => {
    const { info, repeatedKeys } = parseSessionInfoYaml(EURO_NASCAR_CAR_SETUP);
    const setup = info?.CarSetup as Record<string, any>;

    expect(setup.Tires.TireType.TireType).toBe("Dry");
    expect(setup.Tires.LeftFront.ColdPressure).toBe("159 kPa");
    expect(setup.Chassis.Rear.FuelFillTo).toBe("50.0 L");
    expect((info?.DriverInfo as Record<string, any>).Drivers[0].CarNumber).toBe("46");
    expect(repeatedKeys).toEqual(["CarSetup.Tires"]);
  });

  it("merges repeats nested inside the merged maps", () => {
    const yaml = ["A:", " B:", "  X: 1", "  Y: 1", " B:", "  Y: 2", "  Z: 3", ""].join("\n");

    const { info, repeatedKeys } = parseSessionInfoYaml(yaml);

    expect(info).toEqual({ A: { B: { X: 1, Y: 2, Z: 3 } } });
    expect(repeatedKeys).toEqual(["A.B", "A.B.Y"]);
  });

  it("lets the later value win when a repeat is not two maps", () => {
    const { info, repeatedKeys } = parseSessionInfoYaml("A:\n B: 1\n B: 2\n");

    expect(info).toEqual({ A: { B: 2 } });
    expect(repeatedKeys).toEqual(["A.B"]);
  });

  it("merges repeats inside sequence items and reports each path once", () => {
    const yaml = ["Drivers:", "- N: 1", "  N: 2", "- N: 3", "  N: 4", ""].join("\n");

    const { info, repeatedKeys } = parseSessionInfoYaml(yaml);

    expect(info).toEqual({ Drivers: [{ N: 2 }, { N: 4 }] });
    expect(repeatedKeys).toEqual(["Drivers[].N"]);
  });

  it("reports nothing for YAML with no repeats", () => {
    const { info, repeatedKeys } = parseSessionInfoYaml("WeekendInfo:\n TrackName: Spa\n");

    expect(info).toEqual({ WeekendInfo: { TrackName: "Spa" } });
    expect(repeatedKeys).toEqual([]);
  });

  it("throws on text that is not YAML", () => {
    expect(() => parseSessionInfoYaml("WeekendInfo: [unclosed")).toThrow();
  });
});
