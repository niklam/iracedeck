import { describe, expect, it } from "vitest";

import {
  emptyLapsSection,
  findLapStartInSection,
  isNewerLapsSection,
  LAPS_SECTION_VERSION,
  listLapStartsInSection,
  mergeLapsSectionInto,
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
    it("with exact ids, answers a named instance from that instance only (#1354)", () => {
      const section = emptyLapsSection();

      // Two passes of one race: pass 1 has the car's lap 1, pass 2 only its lap 2.
      recordLapStartInSection(section, start({ sessionUniqueId: 4, lap: 1, frame: 30821 }));
      recordLapStartInSection(section, start({ sessionUniqueId: 5, lap: 2, frame: 190000 }));

      const lapOneInPassTwo = { ...start(), sessionUniqueId: 5, lap: 1 };

      // A file's ids may be another sim run's, so the one other session with the lap answers...
      expect(findLapStartInSection(section, lapOneInPassTwo)).toMatchObject({
        hit: true,
        frame: 30821,
        matchedBy: "sessionNum",
      });
      // ...but exact ids make it another pass's lap, and a pass that is not recorded at all is not another one.
      expect(findLapStartInSection(section, lapOneInPassTwo, { exactInstance: true })).toEqual({
        hit: false,
        reason: "lap not recorded",
      });
      expect(
        findLapStartInSection(section, { ...start(), sessionUniqueId: 6, lap: 1 }, { exactInstance: true }),
      ).toEqual({ hit: false, reason: "no session" });
      // The pair itself, and a query that names no instance, read as before.
      expect(
        findLapStartInSection(section, { ...start(), sessionUniqueId: 4, lap: 1 }, { exactInstance: true }),
      ).toMatchObject({ hit: true, frame: 30821, matchedBy: "pair" });
    });

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

    describe("which session a start with no pair match joins", () => {
      it("a walk's start under a replay's own pair joins the one session with that sessionNum when its frame lies within that session's span", () => {
        const section = sectionWithLaps(); // (2, 4): car 7, laps at 30821 and 36305

        const { joinedBySessionNum } = recordLapStartInSection(
          section,
          start({ sessionUniqueId: 0, carIdx: 8, carNumberRaw: 21, lap: 2, frame: 33000 }),
        );

        expect(joinedBySessionNum).toBe(true);
        expect(section.sessions).toHaveLength(1);
        expect(section.sessions[0]?.cars["8"]?.laps).toEqual([{ lap: 2, frame: 33000, timeMs: null }]);
        // Every later lookup from that replay still pair-misses and reads the live session by its sessionNum.
        expect(findLapStartInSection(section, { ...start(), sessionUniqueId: 0, lap: 1 })).toMatchObject({
          hit: true,
          frame: 30821,
          matchedBy: "sessionNum",
        });
      });

      it("a restart — session 0 again under a new unique id, its frames past the old span — stays its own session", () => {
        const section = emptyLapsSection();

        recordLapStartInSection(section, start({ sessionNum: 0, sessionUniqueId: 1, lap: 1, frame: 100 }));
        recordLapStartInSection(section, start({ sessionNum: 0, sessionUniqueId: 1, lap: 2, frame: 18000 }));

        const { joinedBySessionNum } = recordLapStartInSection(
          section,
          start({ sessionNum: 0, sessionUniqueId: 2, lap: 1, frame: 20000 }),
        );

        expect(joinedBySessionNum).toBe(false);
        expect(section.sessions.map((s) => s.sessionUniqueId)).toEqual([1, 2]);
        expect(section.sessions[0]?.cars["7"]?.laps).toHaveLength(2);
      });

      it("a start outside the span, or with two sessions sharing the sessionNum, opens its own session", () => {
        const section = sectionWithLaps();

        recordLapStartInSection(section, start({ sessionUniqueId: 0, lap: 3, frame: 40000 })); // past 36305
        expect(section.sessions.map((s) => s.sessionUniqueId)).toEqual([4, 0]);

        recordLapStartInSection(section, start({ sessionUniqueId: 9, lap: 1, frame: 31000 })); // two hold sessionNum 2
        expect(section.sessions.map((s) => s.sessionUniqueId)).toEqual([4, 0, 9]);
      });
    });
  });

  describe("mergeLapsSectionInto", () => {
    it("unions sessions, cars and laps, keeping the target's entry where both have one and filling only a null time", () => {
      const target = sectionWithLaps(); // (2, 4) car 7: lap 1 @ 30821 timed 91433, lap 2 @ 36305 untimed
      const source = emptyLapsSection();

      recordLapStartInSection(source, start({ lap: 1, frame: 99999 })); // conflicts: target's frame stays
      recordLapTimeInSection(source, { sessionNum: 2, sessionUniqueId: 4, carIdx: 7, lap: 1, timeMs: 1 }); // target's time stays
      recordLapStartInSection(source, start({ lap: 2, frame: 99999 }));
      recordLapTimeInSection(source, { sessionNum: 2, sessionUniqueId: 4, carIdx: 7, lap: 2, timeMs: 90000 }); // fills the null
      recordLapStartInSection(source, start({ lap: 3, frame: 41000 })); // new lap
      recordLapStartInSection(source, start({ carIdx: 8, carNumberRaw: 21, lap: 1, frame: 30900 })); // new car
      recordLapStartInSection(source, start({ sessionNum: 3, sessionUniqueId: 5, lap: 1, frame: 60000 })); // new session
      const before = JSON.parse(JSON.stringify(source));

      mergeLapsSectionInto(target, source);

      expect(target.sessions[0]?.cars["7"]?.laps).toEqual([
        { lap: 1, frame: 30821, timeMs: 91433 },
        { lap: 2, frame: 36305, timeMs: 90000 },
        { lap: 3, frame: 41000, timeMs: null },
      ]);
      expect(target.sessions[0]?.cars["8"]?.laps).toEqual([{ lap: 1, frame: 30900, timeMs: null }]);
      expect(target.sessions[1]).toMatchObject({ sessionNum: 3, sessionUniqueId: 5 });
      expect(source).toEqual(before); // cloned in, not aliased
      expect(target.sessions[1]).not.toBe(source.sessions[1]);
    });

    it("does not file a source car's laps under a target car with another number at the same index", () => {
      const target = sectionWithLaps();
      const source = emptyLapsSection();

      recordLapStartInSection(source, start({ carNumberRaw: 99, lap: 5, frame: 50000 }));
      mergeLapsSectionInto(target, source);

      expect(target.sessions[0]?.cars["7"]).toMatchObject({ carNumberRaw: 2 });
      expect(target.sessions[0]?.cars["7"]?.laps).toHaveLength(2);
    });
  });

  describe("isNewerLapsSection", () => {
    it("is true only for a section whose version is above this build's", () => {
      expect(isNewerLapsSection({ version: LAPS_SECTION_VERSION + 1, sessions: [] })).toBe(true);
      expect(isNewerLapsSection({ version: LAPS_SECTION_VERSION, sessions: [] })).toBe(false);
      expect(isNewerLapsSection({ sessions: [] })).toBe(false);
      expect(isNewerLapsSection(undefined)).toBe(false);
      expect(isNewerLapsSection({ version: "2" })).toBe(false);
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
      recordLapStartInSection(section, start({ sessionNum: 0, sessionUniqueId: 2, frame: 50000 }));

      expect(findLapStartInSection(section, { ...start(), sessionNum: 0, sessionUniqueId: null })).toEqual({
        hit: false,
        reason: "no session",
      });
    });

    describe("through a sparse pair-matched session", () => {
      // The live session (2, 4) has car 7's laps; a walk under the replay's
      // pair (2, 0) recorded car 9 past the live span, opening a sparse session.
      const withSparse = (): ReplayLapsSection => {
        const section = sectionWithLaps();

        recordLapStartInSection(
          section,
          start({ sessionUniqueId: 0, carIdx: 9, carNumberRaw: 33, lap: 4, frame: 90000 }),
        );

        return section;
      };

      it("reads the one other session with the sessionNum that has the car and the lap", () => {
        expect(findLapStartInSection(withSparse(), { ...start(), sessionUniqueId: 0, lap: 2 })).toEqual({
          hit: true,
          frame: 36305,
          timeMs: null,
          matchedBy: "sessionNum",
        });
        expect(
          findLapStartInSection(withSparse(), { ...start(), sessionUniqueId: 0, carIdx: 9, carNumberRaw: 33, lap: 4 }),
        ).toMatchObject({ hit: true, frame: 90000, matchedBy: "pair" });
      });

      it("keeps the pair session's miss when no other session has it, or when a car mismatches there", () => {
        expect(
          findLapStartInSection(withSparse(), { ...start(), sessionUniqueId: 0, carIdx: 9, carNumberRaw: 33, lap: 9 }),
        ).toEqual({ hit: false, reason: "lap not recorded" });
        expect(findLapStartInSection(withSparse(), { ...start(), sessionUniqueId: 0, carIdx: 8, lap: 1 })).toEqual({
          hit: false,
          reason: "no car",
        });
        expect(
          findLapStartInSection(withSparse(), { ...start(), sessionUniqueId: 0, carIdx: 9, carNumberRaw: 1, lap: 4 }),
        ).toEqual({ hit: false, reason: "car mismatch" });
      });

      it("does not guess between two other sessions that both have it", () => {
        const section = emptyLapsSection();

        recordLapStartInSection(section, start({ sessionNum: 0, sessionUniqueId: 1, lap: 1, frame: 100 }));
        recordLapStartInSection(section, start({ sessionNum: 0, sessionUniqueId: 2, lap: 1, frame: 20000 }));
        recordLapStartInSection(section, start({ sessionNum: 0, sessionUniqueId: 9, carIdx: 9, lap: 1, frame: 30000 }));

        expect(findLapStartInSection(section, { ...start(), sessionNum: 0, sessionUniqueId: 9, lap: 1 })).toEqual({
          hit: false,
          reason: "no car",
        });
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

describe("listLapStartsInSection (#1426)", () => {
  const car = { carIdx: 7, carNumberRaw: 2 };

  it("lists one car's lap starts across every session, in frame order, raw, each with its lap and session", () => {
    const section = emptyLapsSection();

    // Qualifying, then the race; recorded out of order, and another car beside it.
    recordLapStartInSection(section, start({ sessionNum: 2, sessionUniqueId: 4, lap: 2, frame: 96305 }));
    recordLapStartInSection(section, start({ sessionNum: 2, sessionUniqueId: 4, lap: 1, frame: 90821 }));
    recordLapStartInSection(section, start({ sessionNum: 1, sessionUniqueId: 3, lap: 1, frame: 30500 }));
    recordLapStartInSection(section, start({ sessionNum: 1, sessionUniqueId: 3, lap: 2, frame: 36000 }));
    recordLapStartInSection(
      section,
      start({ sessionNum: 2, sessionUniqueId: 4, carIdx: 9, carNumberRaw: 31, frame: 90900 }),
    );

    expect(listLapStartsInSection(section, car)).toEqual({
      hit: true,
      starts: [
        { frame: 30500, lap: 1, sessionNum: 1, sessionUniqueId: 3 },
        { frame: 36000, lap: 2, sessionNum: 1, sessionUniqueId: 3 },
        { frame: 90821, lap: 1, sessionNum: 2, sessionUniqueId: 4 },
        { frame: 96305, lap: 2, sessionNum: 2, sessionUniqueId: 4 },
      ],
    });
  });

  it("collapses starts within 60 frames of each other to the earliest: a lap two sessions both hold is one step", () => {
    const section = emptyLapsSection();

    recordLapStartInSection(section, start({ sessionUniqueId: 4, lap: 1, frame: 30821 }));
    recordLapStartInSection(section, start({ sessionUniqueId: 4, lap: 2, frame: 36305 }));
    // The walk's sparse session under a replay's own pair, past the live span so it does not join it.
    recordLapStartInSection(section, start({ sessionUniqueId: 99, lap: 3, frame: 41800 }));
    // The same laps the other session also holds: 60 frames apart is one entry.
    section.sessions[1]?.cars["7"]?.laps.push({ lap: 2, frame: 36365, timeMs: null });
    section.sessions[0]?.cars["7"]?.laps.push({ lap: 3, frame: 41740, timeMs: null });
    // 61 frames past the entry kept is another entry.
    section.sessions[0]?.cars["7"]?.laps.push({ lap: 4, frame: 41801, timeMs: null });

    // The earliest of two collapsed starts is kept with its own lap and session: lap 3 is session 0's at 41740.
    expect(listLapStartsInSection(section, car)).toEqual({
      hit: true,
      starts: [
        { frame: 30821, lap: 1, sessionNum: 2, sessionUniqueId: 4 },
        { frame: 36305, lap: 2, sessionNum: 2, sessionUniqueId: 4 },
        { frame: 41740, lap: 3, sessionNum: 2, sessionUniqueId: 4 },
        { frame: 41801, lap: 4, sessionNum: 2, sessionUniqueId: 4 },
      ],
    });
  });

  it("leaves out a session whose record for the index is another car", () => {
    const section = emptyLapsSection();

    recordLapStartInSection(section, start({ sessionNum: 1, sessionUniqueId: 3, carNumberRaw: 55, frame: 10000 }));
    recordLapStartInSection(section, start({ sessionNum: 2, sessionUniqueId: 4, frame: 30821 }));

    expect(listLapStartsInSection(section, car)).toEqual({
      hit: true,
      starts: [{ frame: 30821, lap: 1, sessionNum: 2, sessionUniqueId: 4 }],
    });
  });

  it("misses with 'no car' when no session holds the index, or the file has no laps section", () => {
    expect(listLapStartsInSection(sectionWithLaps(), { carIdx: 12, carNumberRaw: 2 })).toEqual({
      hit: false,
      reason: "no car",
    });
    expect(listLapStartsInSection(emptyLapsSection(), car)).toEqual({ hit: false, reason: "no car" });
    expect(listLapStartsInSection(undefined, car)).toEqual({ hit: false, reason: "no car" });
  });

  it("misses with 'car mismatch' when every session holding the index holds another car", () => {
    expect(listLapStartsInSection(sectionWithLaps(), { carIdx: 7, carNumberRaw: 3 })).toEqual({
      hit: false,
      reason: "car mismatch",
    });
  });
});
