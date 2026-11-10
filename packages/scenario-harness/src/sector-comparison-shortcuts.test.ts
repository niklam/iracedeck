/**
 * The Sectors buttons (issue #1572): each composes the comparison its label
 * promises, and the family's own selection (`selectSectorCall`, the one
 * function the three contracts' `where:` ask) picks the target it is built for,
 * pressed one after another in the list's order and again in reverse.
 */
import {
  type SectorCallMemory,
  type SectorComparisonInput,
  type SectorPicture,
  type SectorTarget,
  selectSectorCall,
  type SpokenSectorPicture,
} from "@iracedeck/audio-scenarios/pit-crew";
import { describe, expect, it } from "vitest";

import { SCENARIO_SHORTCUTS } from "./scenario-shortcuts.js";
import { composeSectorComparison, validateSectorComparison } from "./sector-comparison-snapshot.js";

const SECTORS = SCENARIO_SHORTCUTS.filter((s) => s.category === "Sectors");

const EXPECTED: Readonly<
  Record<string, { target: SectorTarget; shape?: string; lossShape?: string; lossSector?: number; gainSector?: number }>
> = {
  "Leader pace, most of it with a gain": {
    target: "leader",
    shape: "slower",
    lossShape: "most",
    lossSector: 1,
    gainSector: 3,
  },
  "Leader pace, the most": { target: "leader", shape: "slower", lossShape: "largest", lossSector: 1 },
  "Leader pace, every sector": { target: "leader", shape: "slower", lossShape: "every" },
  "Quicker than the leader": { target: "leader", shape: "quicker", lossSector: 3 },
  "Chance on the car ahead": { target: "ahead", gainSector: 1 },
  "Car behind quicker": { target: "behind", lossSector: 2 },
  "Same picture twice": { target: "ahead", gainSector: 3 },
};

function snapshotOf(label: string): SectorComparisonInput {
  const shortcut = SECTORS.find((s) => s.label === label);

  if (shortcut === undefined || shortcut.sectorComparisonSnapshot === undefined) throw new Error(label);

  return shortcut.sectorComparisonSnapshot;
}

function lapOf(label: string): number {
  const data = SECTORS.find((s) => s.label === label)?.data as { lap: number };

  return data.lap;
}

/** A press: select as the contracts' `where:` would, and record a spoken picture as a gate's claim does. */
function press(label: string, memory: { spoken: Map<SectorTarget, SpokenSectorPicture>; lastCallLap: number | null }) {
  const lap = lapOf(label);
  const picture = selectSectorCall(snapshotOf(label), lap, () => true, memory as SectorCallMemory);

  if (picture !== null) {
    memory.spoken.set(picture.target, { picture, lap });
    memory.lastCallLap = lap;
  }

  return picture;
}

describe("the Sectors shortcuts", () => {
  it("are the seven the voice scripts' test lines name", () => {
    expect(SECTORS.map((s) => s.label)).toEqual(Object.keys(EXPECTED));
  });

  it("publish a counted race lap for the player's newest lap, every lap own and 2+ laps apart", () => {
    const laps = SECTORS.map((s) => (s.data as { lap: number }).lap);

    for (const s of SECTORS) {
      expect(s.event).toBe("lap.completed");
      expect(s.data).toMatchObject({ lapIsValid: true, sessionType: "race" });
      expect(s.data).not.toHaveProperty("wasCaution");
      expect(s.description).toContain("awaiting approval");
    }

    for (let i = 1; i < laps.length; i++) expect(laps[i] - laps[i - 1]).toBeGreaterThanOrEqual(2);
  });

  it.each(Object.entries(EXPECTED))("%s selects its own picture and only that", (label, expected) => {
    const picture = press(label, { spoken: new Map(), lastCallLap: null });

    expect(picture).toMatchObject({ target: expected.target });
    expect(picture?.shape ?? undefined).toBe(expected.shape);
    expect(picture?.lossShape ?? undefined).toBe(expected.lossShape);
    expect(picture?.lossSector ?? undefined).toBe(expected.lossSector);
    expect(picture?.gainSector ?? undefined).toBe(expected.gainSector);
  });

  it("composes the player's newest lap, clean, with five clean laps for every car", () => {
    for (const s of SECTORS) {
      const input = s.sectorComparisonSnapshot as SectorComparisonInput;
      const lap = (s.data as { lap: number }).lap;
      const cars = [input.player, input.leader, input.ahead, input.behind].filter((c) => c !== null);

      expect(input.player.recentLaps.at(-1)).toMatchObject({ lap, clean: true });

      for (const car of cars) {
        expect(car.recentLaps).toHaveLength(5);
        expect(car.recentLaps.every((l) => l.clean && l.sectorTimes.length === input.sectorCount)).toBe(true);
      }
    }
  });

  it("puts a neighbour inside the battle range and none in the leader buttons", () => {
    for (const label of ["Chance on the car ahead", "Car behind quicker", "Same picture twice"]) {
      const input = snapshotOf(label);
      const neighbour = input.ahead ?? input.behind;

      expect(Math.abs(neighbour?.gapSeconds ?? 99)).toBeLessThanOrEqual(3);
      expect(input.leader).toBeNull();
    }

    for (const label of Object.keys(EXPECTED).slice(0, 4)) {
      const input = snapshotOf(label);

      expect(input.ahead).toBeNull();
      expect(input.behind).toBeNull();
    }
  });

  it("give every button its own car", () => {
    const cars = SECTORS.map((s) => {
      const input = s.sectorComparisonSnapshot as SectorComparisonInput;

      return (input.leader ?? input.ahead ?? input.behind)?.carIdx;
    });

    expect(new Set(cars).size).toBe(SECTORS.length);
  });

  it("each speak once when pressed one after another, in the list's order and in reverse", () => {
    for (const order of [Object.keys(EXPECTED), Object.keys(EXPECTED).reverse()]) {
      const memory = { spoken: new Map<SectorTarget, SpokenSectorPicture>(), lastCallLap: null as number | null };
      const heard = order.map((label) => press(label, memory)?.target ?? null);

      expect(heard).toEqual(order.map((label) => EXPECTED[label].target));
    }
  });

  it("is silent the second time the same button is pressed", () => {
    for (const label of Object.keys(EXPECTED)) {
      const memory = { spoken: new Map<SectorTarget, SpokenSectorPicture>(), lastCallLap: null as number | null };

      expect(press(label, memory)).not.toBeNull();
      expect(press(label, memory)).toBeNull();
    }
  });

  it("is silent the second time even once the spacing is out of the way", () => {
    // "Same picture twice": the picture, not only the spacing, silences it.
    const label = "Same picture twice";
    const memory = { spoken: new Map<SectorTarget, SpokenSectorPicture>(), lastCallLap: null as number | null };
    const first = press(label, memory) as SectorPicture;

    expect(first.target).toBe("ahead");
    expect(selectSectorCall(snapshotOf(label), lapOf(label) + 5, () => true, memory as SectorCallMemory)).toBeNull();
  });
});

describe("validateSectorComparison", () => {
  const VALID = composeSectorComparison({
    lap: 10,
    sectorCount: 3,
    player: { carIdx: 5, carNumber: "5" },
    ahead: { carIdx: 6, carNumber: "6", gapSeconds: -1, deltas: [0, 0, 0] },
  });

  it("accepts a composed comparison and null (clear)", () => {
    expect(validateSectorComparison(VALID)).toBe(VALID);
    expect(validateSectorComparison(null)).toBeNull();
  });

  it.each([
    ["a non-object", 42, "body must be an object or null"],
    ["a bad sector count", { ...VALID, sectorCount: -1 }, "sectorCount must be a non-negative integer"],
    ["a missing player", { ...VALID, player: undefined }, "player must be an object"],
    [
      "a bad car index",
      { ...VALID, ahead: { ...VALID.ahead, carIdx: 1.5 } },
      "ahead.carIdx must be a non-negative integer",
    ],
    [
      "a bad gap",
      { ...VALID, ahead: { ...VALID.ahead, gapSeconds: "1" } },
      "ahead.gapSeconds must be a finite number or null",
    ],
    [
      "a bad lap",
      { ...VALID, player: { ...VALID.player, recentLaps: [{ lap: 1, sectorTimes: ["x"], clean: true }] } },
      "player.recentLaps[0].sectorTimes must be an array of finite numbers or null",
    ],
  ])("rejects %s", (_label, body, expected) => {
    expect(validateSectorComparison(body)).toBe(expected);
  });
});
