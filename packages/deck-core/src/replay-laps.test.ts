import { describe, expect, it } from "vitest";

import {
  emptyLapsSection,
  findLapStartInSection,
  LAPS_SECTION_VERSION,
  normalizeLapsSection,
  recordLapStartInSection,
  recordLapTimeInSection,
  type ReplayLapsSection,
} from "./replay-laps.js";

const start = (overrides: Partial<Parameters<typeof recordLapStartInSection>[1]> = {}) => ({
  sessionNum: 2,
  sessionUniqueId: 4,
  carIdx: 7,
  carNumberRaw: 2,
  userId: 123456,
  lap: 1,
  frame: 30821,
  ...overrides,
});

function sectionWithLaps(): ReplayLapsSection {
  const section = emptyLapsSection();

  recordLapStartInSection(section, start({ lap: 1, frame: 30821 }));
  recordLapStartInSection(section, start({ lap: 2, frame: 36305 }));
  recordLapTimeInSection(section, { sessionNum: 2, sessionUniqueId: 4, carIdx: 7, lap: 1, timeMs: 91433 });

  return section;
}

describe("replay laps section (#1203)", () => {
  it("writes exactly the spec's shape", () => {
    expect(JSON.parse(JSON.stringify(sectionWithLaps()))).toEqual({
      version: LAPS_SECTION_VERSION,
      sessions: [
        {
          sessionNum: 2,
          sessionUniqueId: 4,
          cars: {
            "7": {
              carNumberRaw: 2,
              userId: 123456,
              laps: [
                { lap: 1, frame: 30821, timeMs: 91433 },
                { lap: 2, frame: 36305, timeMs: null },
              ],
            },
          },
        },
      ],
    });
  });

  describe("recordLapStartInSection", () => {
    it("keeps entries per (sessionNum, sessionUniqueId): a restart is session 0 again under a new unique id", () => {
      const section = emptyLapsSection();

      recordLapStartInSection(section, start({ sessionNum: 0, sessionUniqueId: 1, lap: 1, frame: 100 }));
      recordLapStartInSection(section, start({ sessionNum: 0, sessionUniqueId: 2, lap: 1, frame: 20000 }));

      expect(section.sessions).toHaveLength(2);
      expect(findLapStartInSection(section, { ...start(), sessionNum: 0, sessionUniqueId: 2, lap: 1 })).toMatchObject({
        hit: true,
        frame: 20000,
      });
    });

    it("keeps laps ordered by lap whatever the order they arrive in", () => {
      const section = emptyLapsSection();

      recordLapStartInSection(section, start({ lap: 3, frame: 300 }));
      recordLapStartInSection(section, start({ lap: 1, frame: 100 }));
      recordLapStartInSection(section, start({ lap: 2, frame: 200 }));

      expect(section.sessions[0]?.cars["7"]?.laps.map((e) => e.lap)).toEqual([1, 2, 3]);
    });

    it("re-recording a lap takes the new frame and keeps the time", () => {
      const section = sectionWithLaps();

      recordLapStartInSection(section, start({ lap: 1, frame: 30800 }));

      expect(section.sessions[0]?.cars["7"]?.laps[0]).toEqual({ lap: 1, frame: 30800, timeMs: 91433 });
    });

    it("replaces the car record when the index now carries another car number", () => {
      const section = sectionWithLaps();

      const { carReplaced } = recordLapStartInSection(
        section,
        start({ carNumberRaw: 99, userId: 1, lap: 5, frame: 5 }),
      );

      expect(carReplaced).toBe(true);
      expect(section.sessions[0]?.cars["7"]).toEqual({
        carNumberRaw: 99,
        userId: 1,
        laps: [{ lap: 5, frame: 5, timeMs: null }],
      });
    });

    it("a team driver swap only updates the userId", () => {
      const section = sectionWithLaps();

      const { carReplaced } = recordLapStartInSection(section, start({ userId: 777, lap: 3, frame: 40000 }));

      expect(carReplaced).toBe(false);
      expect(section.sessions[0]?.cars["7"]?.userId).toBe(777);
      expect(section.sessions[0]?.cars["7"]?.laps).toHaveLength(3);
    });
  });

  describe("recordLapTimeInSection", () => {
    it("pairs a time with its start entry", () => {
      const section = sectionWithLaps();

      expect(
        recordLapTimeInSection(section, { sessionNum: 2, sessionUniqueId: 4, carIdx: 7, lap: 2, timeMs: 90000 }),
      ).toBe(true);
      expect(section.sessions[0]?.cars["7"]?.laps[1]?.timeMs).toBe(90000);
    });

    it("returns false for a lap, car or session with no start entry", () => {
      const section = sectionWithLaps();

      expect(recordLapTimeInSection(section, { sessionNum: 2, sessionUniqueId: 4, carIdx: 7, lap: 9, timeMs: 1 })).toBe(
        false,
      );
      expect(recordLapTimeInSection(section, { sessionNum: 2, sessionUniqueId: 4, carIdx: 8, lap: 1, timeMs: 1 })).toBe(
        false,
      );
      expect(recordLapTimeInSection(section, { sessionNum: 3, sessionUniqueId: 4, carIdx: 7, lap: 1, timeMs: 1 })).toBe(
        false,
      );
    });
  });

  describe("findLapStartInSection", () => {
    it("hits by the (sessionNum, sessionUniqueId) pair", () => {
      expect(findLapStartInSection(sectionWithLaps(), { ...start(), lap: 2 })).toEqual({
        hit: true,
        frame: 36305,
        timeMs: null,
        matchedBy: "pair",
      });
    });

    it("falls back to a unique sessionNum when the replay offers no SessionUniqueID or none matches", () => {
      const section = sectionWithLaps();

      expect(findLapStartInSection(section, { ...start(), sessionUniqueId: null, lap: 1 })).toMatchObject({
        hit: true,
        frame: 30821,
        matchedBy: "sessionNum",
      });
      expect(findLapStartInSection(section, { ...start(), sessionUniqueId: 99, lap: 1 })).toMatchObject({
        hit: true,
        matchedBy: "sessionNum",
      });
    });

    it("does not guess between two sessions with the same sessionNum", () => {
      const section = emptyLapsSection();

      recordLapStartInSection(section, start({ sessionNum: 0, sessionUniqueId: 1 }));
      recordLapStartInSection(section, start({ sessionNum: 0, sessionUniqueId: 2 }));

      expect(findLapStartInSection(section, { ...start(), sessionNum: 0, sessionUniqueId: null })).toEqual({
        hit: false,
        reason: "no session",
      });
    });

    it("misses with the reason the action logs", () => {
      const section = sectionWithLaps();

      expect(findLapStartInSection(undefined, start())).toEqual({ hit: false, reason: "no session" });
      expect(findLapStartInSection(section, { ...start(), sessionNum: 5 })).toEqual({
        hit: false,
        reason: "no session",
      });
      expect(findLapStartInSection(section, { ...start(), carIdx: 8 })).toEqual({ hit: false, reason: "no car" });
      expect(findLapStartInSection(section, { ...start(), carNumberRaw: 3 })).toEqual({
        hit: false,
        reason: "car mismatch",
      });
      expect(findLapStartInSection(section, { ...start(), lap: 3 })).toEqual({
        hit: false,
        reason: "lap not recorded",
      });
    });
  });

  describe("normalizeLapsSection", () => {
    it("keeps unknown fields at every level — section, session, car and entry — and never downgrades the section version", () => {
      const raw = {
        version: 3,
        source: "live",
        sessions: [
          {
            sessionNum: 2,
            sessionUniqueId: 4,
            weather: "dry",
            cars: {
              "7": { carNumberRaw: 2, userId: 1, team: "A", laps: [{ lap: 1, frame: 10, timeMs: null, valid: true }] },
            },
          },
        ],
      };

      expect(normalizeLapsSection(raw)).toEqual(raw);
    });

    it("round-trips a written section", () => {
      const section = sectionWithLaps();

      expect(normalizeLapsSection(JSON.parse(JSON.stringify(section)))).toEqual(section);
    });

    it("drops what is not a session, a car or an entry and keeps the rest", () => {
      const normalized = normalizeLapsSection({
        version: 1,
        sessions: [
          null,
          { sessionNum: "x", sessionUniqueId: 1 },
          {
            sessionNum: 2,
            sessionUniqueId: 4,
            cars: {
              "7": { carNumberRaw: 2, laps: [{ lap: 1, frame: 10, timeMs: "fast" }, { lap: "2" }, null] },
              "8": { userId: 1 },
            },
          },
        ],
      });

      expect(normalized).toEqual({
        version: LAPS_SECTION_VERSION,
        sessions: [
          {
            sessionNum: 2,
            sessionUniqueId: 4,
            cars: { "7": { carNumberRaw: 2, userId: 0, laps: [{ lap: 1, frame: 10, timeMs: null }] } },
          },
        ],
      });
    });

    it("reads anything that is not a section as an empty one", () => {
      expect(normalizeLapsSection(undefined)).toEqual(emptyLapsSection());
      expect(normalizeLapsSection([])).toEqual(emptyLapsSection());
      expect(normalizeLapsSection({ version: 1 })).toEqual(emptyLapsSection());
    });
  });
});
