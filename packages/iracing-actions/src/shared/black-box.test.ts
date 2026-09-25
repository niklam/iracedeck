import type { ILogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BLACK_BOX_GLOBAL_KEYS,
  BLACK_BOX_SEQUENCE_HOLD_MS,
  PRIME_BLACK_BOX,
  resolvePrimeKey,
  showBlackBox,
} from "./black-box.js";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withLevel: vi.fn(),
  createScope: vi.fn(),
} as unknown as ILogger;

type BindingKind = "keyboard" | "simhub";

/** Binding predicates for exactly the listed global keys; everything else is unbound. */
function bindings(map: Record<string, BindingKind>) {
  return {
    isConfigured: (key: string) => key in map,
    isKeyboardBound: (key: string) => map[key] === "keyboard",
  };
}

describe("BLACK_BOX_GLOBAL_KEYS", () => {
  it("should map all 11 black boxes", () => {
    expect(Object.keys(BLACK_BOX_GLOBAL_KEYS)).toHaveLength(11);
    expect(BLACK_BOX_GLOBAL_KEYS.fuel).toBe("blackBoxFuel");
    expect(BLACK_BOX_GLOBAL_KEYS["lap-timing"]).toBe("blackBoxLapTiming");
  });

  it("should list lap-timing first so it is the default prime fallback", () => {
    expect(Object.keys(BLACK_BOX_GLOBAL_KEYS)[0]).toBe("lap-timing");
    expect(PRIME_BLACK_BOX).toBe("lap-timing");
  });
});

describe("resolvePrimeKey", () => {
  const prime = (targetId: Parameters<typeof resolvePrimeKey>[0], map: Record<string, BindingKind>) => {
    const b = bindings(map);

    return resolvePrimeKey(targetId, b.isConfigured, b.isKeyboardBound);
  };

  it("should prefer a keyboard-bound lap timing", () => {
    expect(
      prime("fuel", { blackBoxLapTiming: "keyboard", blackBoxStandings: "keyboard", blackBoxFuel: "keyboard" }),
    ).toBe("blackBoxLapTiming");
  });

  it("should pick a keyboard standings over a SimHub lap timing (#962)", () => {
    expect(
      prime("fuel", { blackBoxLapTiming: "simhub", blackBoxStandings: "keyboard", blackBoxFuel: "keyboard" }),
    ).toBe("blackBoxStandings");
  });

  it("should prefer any keyboard box over SimHub boxes earlier in the scan order", () => {
    expect(
      prime("fuel", {
        blackBoxLapTiming: "simhub",
        blackBoxStandings: "simhub",
        blackBoxWeather: "keyboard",
        blackBoxFuel: "simhub",
      }),
    ).toBe("blackBoxWeather");
  });

  it("should still prefer a keyboard prime when the target is a SimHub role", () => {
    expect(prime("fuel", { blackBoxLapTiming: "simhub", blackBoxRelative: "keyboard", blackBoxFuel: "simhub" })).toBe(
      "blackBoxRelative",
    );
  });

  it("should fall back to the first SimHub box when no other box is keyboard-bound", () => {
    expect(prime("fuel", { blackBoxRelative: "simhub", blackBoxTires: "simhub", blackBoxFuel: "keyboard" })).toBe(
      "blackBoxRelative",
    );
  });

  it("should prefer a SimHub lap timing within the SimHub tier", () => {
    expect(prime("fuel", { blackBoxRelative: "simhub", blackBoxLapTiming: "simhub", blackBoxFuel: "simhub" })).toBe(
      "blackBoxLapTiming",
    );
  });

  it("should pick another box when the target IS lap timing", () => {
    expect(prime("lap-timing", { blackBoxLapTiming: "keyboard", blackBoxStandings: "keyboard" })).toBe(
      "blackBoxStandings",
    );
  });

  it("should fall back to the first keyboard non-target box when lap timing is unbound", () => {
    expect(prime("fuel", { blackBoxRelative: "keyboard", blackBoxTires: "keyboard", blackBoxFuel: "keyboard" })).toBe(
      "blackBoxRelative",
    );
  });

  it("should never return the target itself", () => {
    expect(prime("fuel", { blackBoxFuel: "keyboard" })).toBeNull();
    expect(prime("fuel", { blackBoxFuel: "simhub" })).toBeNull();
  });

  it("should return null when nothing is configured", () => {
    expect(prime("fuel", {})).toBeNull();
  });
});

describe("showBlackBox", () => {
  const tapSequence = vi.fn<(settingKeys: string[], holdMs?: number) => Promise<boolean>>();
  const tap = vi.fn<(settingKey: string) => Promise<boolean>>();

  const deps = (map: Record<string, BindingKind>) => ({ ...bindings(map), tapSequence, tap, logger });

  beforeEach(() => {
    vi.clearAllMocks();
    tapSequence.mockResolvedValue(true);
    tap.mockResolvedValue(true);
  });

  describe("atomic path (target and prime keyboard-bound)", () => {
    it("should tap prime then target as one sequence and never tap separately", async () => {
      const result = await showBlackBox("fuel", deps({ blackBoxLapTiming: "keyboard", blackBoxFuel: "keyboard" }));

      expect(result).toBe(true);
      expect(tapSequence).toHaveBeenCalledWith(["blackBoxLapTiming", "blackBoxFuel"], BLACK_BOX_SEQUENCE_HOLD_MS);
      expect(tap).not.toHaveBeenCalled();
    });

    it("should skip, not serialize, when the keyboard sequence is refused", async () => {
      tapSequence.mockResolvedValue(false);

      const result = await showBlackBox("fuel", deps({ blackBoxLapTiming: "keyboard", blackBoxFuel: "keyboard" }));

      expect(result).toBe(false);
      expect(tap).not.toHaveBeenCalled();
    });

    it("should use the atomic path for the #962 bug configuration", async () => {
      const result = await showBlackBox(
        "fuel",
        deps({ blackBoxLapTiming: "simhub", blackBoxStandings: "keyboard", blackBoxFuel: "keyboard" }),
      );

      expect(result).toBe(true);
      expect(tapSequence).toHaveBeenCalledWith(["blackBoxStandings", "blackBoxFuel"], BLACK_BOX_SEQUENCE_HOLD_MS);
      expect(tap).not.toHaveBeenCalled();
    });
  });

  describe("serialized path (a SimHub role is involved)", () => {
    it("should tap a keyboard prime then a SimHub target, in order", async () => {
      const result = await showBlackBox("fuel", deps({ blackBoxLapTiming: "keyboard", blackBoxFuel: "simhub" }));

      expect(result).toBe(true);
      expect(tap.mock.calls).toEqual([["blackBoxLapTiming"], ["blackBoxFuel"]]);
      expect(tapSequence).not.toHaveBeenCalled();
    });

    it("should tap a SimHub prime then a keyboard target, in order", async () => {
      const result = await showBlackBox("fuel", deps({ blackBoxLapTiming: "simhub", blackBoxFuel: "keyboard" }));

      expect(result).toBe(true);
      expect(tap.mock.calls).toEqual([["blackBoxLapTiming"], ["blackBoxFuel"]]);
      expect(tapSequence).not.toHaveBeenCalled();
    });

    it("should serialize when every box is a SimHub role", async () => {
      const result = await showBlackBox("fuel", deps({ blackBoxLapTiming: "simhub", blackBoxFuel: "simhub" }));

      expect(result).toBe(true);
      expect(tap.mock.calls).toEqual([["blackBoxLapTiming"], ["blackBoxFuel"]]);
    });

    it("should never tap the target when the prime tap did not go out", async () => {
      tap.mockResolvedValueOnce(false);

      const result = await showBlackBox("fuel", deps({ blackBoxLapTiming: "simhub", blackBoxFuel: "simhub" }));

      expect(result).toBe(false);
      expect(tap.mock.calls).toEqual([["blackBoxLapTiming"]]);
    });

    it("should return false when the target tap fails after a successful prime", async () => {
      tap.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      const result = await showBlackBox("fuel", deps({ blackBoxLapTiming: "keyboard", blackBoxFuel: "simhub" }));

      expect(result).toBe(false);
      expect(tap.mock.calls).toEqual([["blackBoxLapTiming"], ["blackBoxFuel"]]);
    });
  });

  describe("skip", () => {
    it("should send nothing when the target is unbound", async () => {
      const result = await showBlackBox("fuel", deps({ blackBoxLapTiming: "keyboard" }));

      expect(result).toBe(false);
      expect(tapSequence).not.toHaveBeenCalled();
      expect(tap).not.toHaveBeenCalled();
    });

    it("should send nothing when no other box is bound to prime with", async () => {
      const result = await showBlackBox("fuel", deps({ blackBoxFuel: "simhub" }));

      expect(result).toBe(false);
      expect(tapSequence).not.toHaveBeenCalled();
      expect(tap).not.toHaveBeenCalled();
    });
  });
});
