/**
 * The Fastest Lap and every-lap shortcuts (#1571, #1163): the payloads the
 * buttons publish, and the precedence between the three lap-time callouts
 * (`playerLapOwner`) they stand for, checked against the real catalog rule.
 */
import { playerLapOwner } from "@iracedeck/audio-scenarios/pit-crew";
import { describe, expect, it } from "vitest";

import { SCENARIO_SHORTCUTS, type ScenarioShortcut } from "./scenario-shortcuts.js";

type Published = { event: string; data: Record<string, unknown> };

const byLabel = (category: string, label: string): ScenarioShortcut => {
  const found = SCENARIO_SHORTCUTS.find((s) => s.category === category && s.label === label);

  if (!found) throw new Error(`no shortcut "${category} → ${label}"`);

  return found;
};

const fastest = (label: string) => byLabel("Fastest Lap", label);
const data = (s: ScenarioShortcut) => (s as unknown as Published).data;
const preceding = (s: ScenarioShortcut) => (s as unknown as { precedingEvents?: Published[] }).precedingEvents ?? [];

type LapArg = Parameters<typeof playerLapOwner>[0];

const ALL_ON = { fastestLap: true, bestLap: true, everyLap: true };

describe("Fastest Lap shortcuts", () => {
  it("has the seven buttons, in order, all publishing fastestLap.set at 1:23.4", () => {
    const fastestLap = SCENARIO_SHORTCUTS.filter((s) => s.category === "Fastest Lap");

    expect(fastestLap.map((s) => s.label)).toEqual([
      "Yours",
      "Taken from you",
      "Leader",
      "Car ahead",
      "Car behind",
      "Other car",
      "Yours in the grace",
    ]);
    expect(fastestLap.every((s) => (s as unknown as Published).event === "fastestLap.set")).toBe(true);
    expect(fastestLap.every((s) => data(s).lapTime === 83.4)).toBe(true);
  });

  it("selects each holder key through the positions in the payload", () => {
    expect(data(fastest("Yours"))).toMatchObject({ isPlayer: true, lap: 5 });
    expect(data(fastest("Taken from you"))).toMatchObject({
      isPlayer: false,
      carNumber: "5",
      previous: { isPlayer: true },
    });
    expect(data(fastest("Leader"))).toMatchObject({ position: 1, playerPosition: 4 });
    expect(data(fastest("Car ahead"))).toMatchObject({ position: 3, playerPosition: 4 });
    expect(data(fastest("Car behind"))).toMatchObject({ position: 5, playerPosition: 4 });
    expect(data(fastest("Other car"))).toMatchObject({ carNumber: "5", position: 6, playerPosition: 2 });
  });

  it("pairs Yours with the lap.completed that carries the fastest-lap flag on the same lap", () => {
    for (const [label, lap] of [
      ["Yours", 5],
      ["Yours in the grace", 2],
    ] as const) {
      const shortcut = fastest(label);
      const [lapCompleted, ...rest] = preceding(shortcut);

      expect(rest).toEqual([]);
      expect(lapCompleted.event).toBe("lap.completed");
      expect(lapCompleted.data).toMatchObject({
        lap,
        isBest: true,
        isClassFastestLapOfRace: true,
        sessionType: "race",
      });
      expect(data(shortcut)).toMatchObject({ lap, isPlayer: true });
    }
  });

  it("publishes no pairing for the opponent buttons", () => {
    for (const label of ["Taken from you", "Leader", "Car ahead", "Car behind", "Other car"]) {
      expect(preceding(fastest(label))).toEqual([]);
    }
  });

  it("gives the fastest-lap line the lap on Yours, and the best-lap line on Yours in the grace", () => {
    const owner = (label: string) => playerLapOwner(preceding(fastest(label))[0].data as LapArg, ALL_ON);

    expect(owner("Yours")).toBe("fastest-lap");
    expect(owner("Yours in the grace")).toBe("best-lap");
  });

  it("keeps every opponent button playable after any harness lap: its lap count is past every lap.completed the harness publishes", () => {
    // The fastest-lap speak gate drops a call once a lap.completed past its
    // `playerLapsCompleted` has fired (`lapStillCurrent`), so a button pressed
    // after a lap button with a higher lap would play nothing.
    const publishedLaps = SCENARIO_SHORTCUTS.flatMap((s) => [s as unknown as Published, ...preceding(s)])
      .filter((p) => p.event === "lap.completed")
      .map((p) => p.data.lap as number);
    const highestLap = Math.max(...publishedLaps);

    expect(highestLap).toBeGreaterThanOrEqual(6);

    for (const label of ["Taken from you", "Leader", "Car ahead", "Car behind", "Other car"]) {
      expect(data(fastest(label)).playerLapsCompleted, label).toBeGreaterThanOrEqual(highestLap);
    }
  });
});

describe("Every lap shortcuts", () => {
  const lapData = (label: string) => data(byLabel("Lap Time", label)) as LapArg;

  it("gives the every-lap call a plain non-best lap in a practice session", () => {
    for (const [label, lapTime] of [
      ["Every lap 1:45.237", 105.237],
      ["Every lap under a minute 58.041", 58.041],
    ] as const) {
      const lap = lapData(label);

      expect(lap).toMatchObject({ lapTime, isBest: false, isFirstValid: false, sessionType: "practice" });
      expect(playerLapOwner(lap, ALL_ON)).toBe("every-lap");
    }
  });

  it("marks the out lap, which the every-lap call stays silent on", () => {
    const shortcut = byLabel("Lap Time", "Out lap — silent");

    expect(data(shortcut)).toMatchObject({ isOutLap: true, isBest: false });
    expect(shortcut.description).toMatch(/silent/i);
  });
});
