/**
 * The lap-time precedence and drop rule (issues #1163, #1571): the pure
 * functions in `lap-announcement.ts`. The integration over the real
 * `registerPitCrew` is `lap-time-precedence.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  FASTEST_LAP_GRACE_LAPS,
  fastestLapAnnounceable,
  type LapOwnerFlags,
  lapStillCurrent,
  type PlayerLapOwner,
  playerLapOwner,
} from "./lap-announcement.js";
import type { LapCompletedSnapshot } from "./lap-time.js";

function lap(overrides: Partial<LapCompletedSnapshot> = {}): LapCompletedSnapshot {
  return { lap: 5, lapTime: 83.4, isBest: false, isFirstValid: false, sessionType: "race", ...overrides };
}

const ALL_ON: LapOwnerFlags = { fastestLap: true, bestLap: true, everyLap: true };

describe("fastestLapAnnounceable (#1571, decision 5)", () => {
  it("holds a two-lap grace", () => {
    expect(FASTEST_LAP_GRACE_LAPS).toBe(2);
  });

  it("refuses lap 2 and admits lap 3 when enabled, and refuses both when not", () => {
    expect(fastestLapAnnounceable(1, true)).toBe(false);
    expect(fastestLapAnnounceable(2, true)).toBe(false);
    expect(fastestLapAnnounceable(3, true)).toBe(true);
    expect(fastestLapAnnounceable(2, false)).toBe(false);
    expect(fastestLapAnnounceable(3, false)).toBe(false);
  });
});

describe("lapStillCurrent (#1571, decision 9; #1163)", () => {
  it("admits with no lap completed yet, and while the latest lap is not past the one at the event", () => {
    expect(lapStillCurrent(5, null)).toBe(true);
    expect(lapStillCurrent(5, { lap: 4 })).toBe(true);
    expect(lapStillCurrent(5, { lap: 5 })).toBe(true);
  });

  it("refuses once the player has completed a later lap", () => {
    expect(lapStillCurrent(5, { lap: 6 })).toBe(false);
  });
});

describe("playerLapOwner (#1571, decision 7; #1163)", () => {
  const fastest = lap({ isClassFastestLapOfRace: true, isBest: true });
  const fastestInGrace = lap({ lap: 2, isClassFastestLapOfRace: true, isBest: true });
  const best = lap({ isBest: true });
  const firstValid = lap({ isFirstValid: true });
  const plain = lap();

  it("gives a fastest lap of the race past the grace to the fastest-lap call", () => {
    expect(playerLapOwner(fastest, ALL_ON)).toBe("fastest-lap");
  });

  it("hands a fastest lap inside the grace, or with that call off, to the best-lap call", () => {
    expect(playerLapOwner(fastestInGrace, ALL_ON)).toBe("best-lap");
    expect(playerLapOwner(fastest, { ...ALL_ON, fastestLap: false })).toBe("best-lap");
  });

  it("gives a personal best or a first valid lap to the best-lap call", () => {
    expect(playerLapOwner(best, ALL_ON)).toBe("best-lap");
    expect(playerLapOwner(firstValid, ALL_ON)).toBe("best-lap");
  });

  it("gives every other lap to the every-lap call", () => {
    expect(playerLapOwner(plain, ALL_ON)).toBe("every-lap");
  });

  it("hands a best lap to the every-lap call when the best-lap call is off or unscripted — a pack scripting lap-time-last but not lap-time-best still hears every lap", () => {
    expect(playerLapOwner(best, { fastestLap: true, bestLap: false, everyLap: true })).toBe("every-lap");
  });

  it("gives every lap to the every-lap call when neither higher tier is on", () => {
    const on = { fastestLap: false, bestLap: false, everyLap: true };

    for (const l of [fastest, fastestInGrace, best, firstValid, plain]) expect(playerLapOwner(l, on)).toBe("every-lap");
  });

  it("names no owner when every tier is off", () => {
    const off = { fastestLap: false, bestLap: false, everyLap: false };

    for (const l of [fastest, best, plain]) expect(playerLapOwner(l, off)).toBeNull();
  });

  it("over the whole matrix answers the precedence, tier by tier", () => {
    const laps = [fastest, fastestInGrace, best, plain];

    for (const fastestLap of [false, true]) {
      for (const bestLap of [false, true]) {
        for (const everyLap of [false, true]) {
          for (const l of laps) {
            const fastestOwns = l.isClassFastestLapOfRace === true && l.lap > 2 && fastestLap;
            const bestOwns = (l.isBest || l.isFirstValid) && bestLap;
            const expected: PlayerLapOwner = fastestOwns
              ? "fastest-lap"
              : bestOwns
                ? "best-lap"
                : everyLap
                  ? "every-lap"
                  : null;

            expect(
              playerLapOwner(l, { fastestLap, bestLap, everyLap }),
              JSON.stringify({ l, fastestLap, bestLap, everyLap }),
            ).toBe(expected);
          }
        }
      }
    }
  });
});
