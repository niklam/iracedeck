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

/** Treat exactly the listed global keys as configured. */
const configured =
  (...keys: string[]) =>
  (key: string) =>
    keys.includes(key);

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
  it("should prefer lap timing", () => {
    expect(resolvePrimeKey("fuel", configured("blackBoxLapTiming", "blackBoxFuel"))).toBe("blackBoxLapTiming");
  });

  it("should pick another configured box when the target IS lap timing", () => {
    const isConfigured = configured("blackBoxLapTiming", "blackBoxStandings");

    expect(resolvePrimeKey("lap-timing", isConfigured)).toBe("blackBoxStandings");
  });

  it("should fall back to the first configured non-target box when lap timing is unbound", () => {
    const isConfigured = configured("blackBoxRelative", "blackBoxTires", "blackBoxFuel");

    expect(resolvePrimeKey("fuel", isConfigured)).toBe("blackBoxRelative");
  });

  it("should never return the target itself", () => {
    expect(resolvePrimeKey("fuel", configured("blackBoxFuel"))).toBeNull();
  });

  it("should return null when nothing is configured", () => {
    expect(resolvePrimeKey("fuel", () => false)).toBeNull();
  });
});

describe("showBlackBox", () => {
  const tapSequence = vi.fn().mockResolvedValue(true);

  beforeEach(() => {
    vi.clearAllMocks();
    tapSequence.mockResolvedValue(true);
  });

  it("should tap prime then target as one sequence", async () => {
    const result = await showBlackBox("fuel", {
      isConfigured: configured("blackBoxLapTiming", "blackBoxFuel"),
      tapSequence,
      logger,
    });

    expect(result).toBe(true);
    expect(tapSequence).toHaveBeenCalledWith(["blackBoxLapTiming", "blackBoxFuel"], BLACK_BOX_SEQUENCE_HOLD_MS);
  });

  it("should send nothing when the target is unbound", async () => {
    const result = await showBlackBox("fuel", {
      isConfigured: configured("blackBoxLapTiming"),
      tapSequence,
      logger,
    });

    expect(result).toBe(false);
    expect(tapSequence).not.toHaveBeenCalled();
  });

  it("should send nothing when no other box is bound to prime with", async () => {
    const result = await showBlackBox("fuel", {
      isConfigured: configured("blackBoxFuel"),
      tapSequence,
      logger,
    });

    expect(result).toBe(false);
    expect(tapSequence).not.toHaveBeenCalled();
  });

  it("should propagate a skipped sequence", async () => {
    tapSequence.mockResolvedValue(false);

    const result = await showBlackBox("fuel", {
      isConfigured: configured("blackBoxLapTiming", "blackBoxFuel"),
      tapSequence,
      logger,
    });

    expect(result).toBe(false);
  });
});
