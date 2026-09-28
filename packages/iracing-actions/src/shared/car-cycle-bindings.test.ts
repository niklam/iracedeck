import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CAR_CYCLE_BINDING_DEFAULTS,
  CAR_CYCLE_BINDING_KEY_LIST,
  CAR_CYCLE_BINDING_KEYS,
  carCycleBindingKey,
} from "./car-cycle-bindings.js";

const KEY_BINDINGS_PATH = new URL("../actions/data/key-bindings.json", import.meta.url);

type BindingRow = { id: string; label: string; default: string; setting: string };

function keyBindings(): Record<string, BindingRow[]> {
  return JSON.parse(readFileSync(KEY_BINDINGS_PATH, "utf8")) as Record<string, BindingRow[]>;
}

/** The rows of one key-bindings section that name a car-cycle key. */
function carCycleRows(section: string): BindingRow[] {
  const keys = new Set<string>(CAR_CYCLE_BINDING_KEY_LIST);

  return (keyBindings()[section] ?? []).filter((row) => keys.has(row.setting));
}

describe("car-cycle-bindings (#1277)", () => {
  it("keeps the persisted global setting keys", () => {
    // Stored user settings: renaming either would silently drop a user's binding.
    expect(CAR_CYCLE_BINDING_KEYS.next).toBe("replayControlNextCar");
    expect(CAR_CYCLE_BINDING_KEYS.previous).toBe("replayControlPrevCar");
    expect(CAR_CYCLE_BINDING_KEY_LIST).toEqual(["replayControlNextCar", "replayControlPrevCar"]);
  });

  it("maps next to Next Car and previous to Previous Car", () => {
    expect(carCycleBindingKey("next")).toBe("replayControlNextCar");
    expect(carCycleBindingKey("previous")).toBe("replayControlPrevCar");
  });

  it("lists both keys under replayControl AND cameraControls in key-bindings.json", () => {
    // Both PIs render their own section; a key missing from one of them could
    // not be configured from that action's PI.
    for (const section of ["replayControl", "cameraControls"]) {
      expect(
        carCycleRows(section)
          .map((row) => row.setting)
          .sort(),
        section,
      ).toEqual([...CAR_CYCLE_BINDING_KEY_LIST].sort());
    }
  });

  it("describes the pair identically in both sections (one sim control, one setting)", () => {
    // The settings window shows one row per setting; two sections disagreeing on
    // the label or iRacing's default would make that row depend on which one won.
    const bySetting = (rows: BindingRow[]) => Object.fromEntries(rows.map((row) => [row.setting, row]));
    const replay = bySetting(carCycleRows("replayControl"));
    const camera = bySetting(carCycleRows("cameraControls"));

    for (const key of CAR_CYCLE_BINDING_KEY_LIST) {
      expect(camera[key], key).toEqual(replay[key]);
    }

    // iRacing's own defaults, so an untouched install works out of the box.
    expect(replay[CAR_CYCLE_BINDING_KEYS.next].default).toBe("V");
    expect(replay[CAR_CYCLE_BINDING_KEYS.previous].default).toBe("Shift+V");
  });

  it("hands the startup seed defaults that match key-bindings.json in BOTH sections", () => {
    // Every plugin seeds these for users who never stored them. They are
    // literals (no JSON in the bundle), so they must agree with what each PI's
    // field saves on mount — the key-bindings.json default of its own section.
    expect(Object.keys(CAR_CYCLE_BINDING_DEFAULTS).sort()).toEqual([...CAR_CYCLE_BINDING_KEY_LIST].sort());

    for (const section of ["replayControl", "cameraControls"]) {
      const fromJson = Object.fromEntries(carCycleRows(section).map((row) => [row.setting, row.default]));

      expect(CAR_CYCLE_BINDING_DEFAULTS, section).toEqual(fromJson);
    }

    expect(CAR_CYCLE_BINDING_DEFAULTS).toEqual({ replayControlNextCar: "V", replayControlPrevCar: "Shift+V" });
  });
});
