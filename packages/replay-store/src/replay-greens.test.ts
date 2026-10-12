import { describe, expect, it } from "vitest";

import {
  emptyGreensSection,
  findGreenInSection,
  type GreenRecord,
  GREENS_SECTION_VERSION,
  isNewerGreensSection,
  mergeGreensSectionInto,
  normalizeGreensSection,
  recordGreenInSection,
  type ReplayGreensSection,
} from "./replay-greens.js";
import { MARKER_DEDUPE_FRAMES } from "./replay-markers.js";

const green = (overrides: Partial<GreenRecord> = {}): GreenRecord => ({
  sessionNum: 2,
  sessionUniqueId: 4,
  kind: "start",
  frame: 30215,
  sessionTimeMs: 512433,
  ...overrides,
});

const restart = (frame: number, overrides: Partial<GreenRecord> = {}): GreenRecord =>
  green({ kind: "restart", frame, sessionTimeMs: frame * 16, ...overrides });

/** The spec's example: one race session with its start and one restart. */
function sectionWithGreens(): ReplayGreensSection {
  const section = emptyGreensSection();

  recordGreenInSection(section, green());
  recordGreenInSection(section, green({ kind: "restart", frame: 71904, sessionTimeMs: 1199870 }));

  return section;
}

const kindsAndFrames = (section: ReplayGreensSection, index = 0) =>
  section.sessions[index]?.greens.map((e) => [e.kind, e.frame]);

describe("replay greens section (#1354)", () => {
  it("writes exactly the spec's shape", () => {
    expect(GREENS_SECTION_VERSION).toBe(1);
    expect(JSON.parse(JSON.stringify(sectionWithGreens()))).toEqual({
      version: 1,
      sessions: [
        {
          sessionNum: 2,
          sessionUniqueId: 4,
          greens: [
            { kind: "start", frame: 30215, sessionTimeMs: 512433 },
            { kind: "restart", frame: 71904, sessionTimeMs: 1199870 },
          ],
        },
      ],
    });
  });

  describe("recordGreenInSection", () => {
    it("keeps entries in frame order whatever the order they arrive in", () => {
      const section = emptyGreensSection();

      expect(recordGreenInSection(section, restart(90000))).toBe(true);
      expect(recordGreenInSection(section, restart(50000))).toBe(true);
      expect(recordGreenInSection(section, green({ frame: 30000 }))).toBe(true);
      expect(recordGreenInSection(section, restart(70000))).toBe(true);

      expect(kindsAndFrames(section)).toEqual([
        ["start", 30000],
        ["restart", 50000],
        ["restart", 70000],
        ["restart", 90000],
      ]);
    });

    it("keeps one start per session instance: the latest replaces the earlier one (a re-grid)", () => {
      const section = sectionWithGreens();

      expect(recordGreenInSection(section, green({ frame: 41000, sessionTimeMs: 690000 }))).toBe(true);

      expect(section.sessions).toHaveLength(1);
      expect(section.sessions[0]?.greens).toEqual([
        { kind: "start", frame: 41000, sessionTimeMs: 690000 },
        { kind: "restart", frame: 71904, sessionTimeMs: 1199870 },
      ]);
    });

    it("a start recorded twice changes nothing", () => {
      const section = sectionWithGreens();
      const before = structuredClone(section);

      expect(recordGreenInSection(section, green())).toBe(false);
      expect(section).toEqual(before);
    });

    it("a start at the recorded frame is the same moment: the entry stays and takes a different session time", () => {
      const section = normalizeGreensSection({
        version: 1,
        sessions: [
          {
            sessionNum: 2,
            sessionUniqueId: 4,
            greens: [{ kind: "start", frame: 30215, sessionTimeMs: 0, flags: 1024 }],
          },
        ],
      });

      expect(recordGreenInSection(section, green())).toBe(true);
      expect(section.sessions[0]?.greens).toEqual([
        { kind: "start", frame: 30215, sessionTimeMs: 512433, flags: 1024 },
      ]);
    });

    it("de-duplicates a restart against another restart within the marker window, and no further", () => {
      const section = emptyGreensSection();

      expect(MARKER_DEDUPE_FRAMES).toBe(60);
      expect(recordGreenInSection(section, restart(70000))).toBe(true);
      expect(recordGreenInSection(section, restart(70001))).toBe(false); // the tick-level double emit
      expect(recordGreenInSection(section, restart(70060))).toBe(false);
      expect(recordGreenInSection(section, restart(69940))).toBe(false);
      expect(recordGreenInSection(section, restart(70061))).toBe(true);
      expect(recordGreenInSection(section, restart(69939))).toBe(true);

      expect(kindsAndFrames(section)).toEqual([
        ["restart", 69939],
        ["restart", 70000],
        ["restart", 70061],
      ]);
    });

    it("never de-duplicates one kind against the other", () => {
      const section = emptyGreensSection();

      recordGreenInSection(section, green({ frame: 30000 }));

      // A restart a tick after the start, and a start a tick after a restart.
      expect(recordGreenInSection(section, restart(30010))).toBe(true);
      expect(recordGreenInSection(section, green({ frame: 30020 }))).toBe(true);

      expect(kindsAndFrames(section)).toEqual([
        ["restart", 30010],
        ["start", 30020],
      ]);
    });

    it("leaves an entry of a kind it does not know alone: not replaced, not de-duplicated against, not dropped", () => {
      const section = normalizeGreensSection({
        version: 1,
        sessions: [
          {
            sessionNum: 2,
            sessionUniqueId: 4,
            greens: [
              { kind: "start", frame: 30215, sessionTimeMs: 512433 },
              { kind: "checkered", frame: 70000, sessionTimeMs: 1166666, lap: 40 },
            ],
          },
        ],
      });

      expect(recordGreenInSection(section, restart(70010))).toBe(true); // within 60 of the unknown entry
      expect(recordGreenInSection(section, green({ frame: 69990, sessionTimeMs: 1 }))).toBe(true);

      expect(section.sessions[0]?.greens).toEqual([
        { kind: "start", frame: 69990, sessionTimeMs: 1 },
        { kind: "checkered", frame: 70000, sessionTimeMs: 1166666, lap: 40 },
        { kind: "restart", frame: 70010, sessionTimeMs: 70010 * 16 },
      ]);
    });

    it("matches a session by its exact pair: another unique id is another session, whatever its frame", () => {
      const section = sectionWithGreens(); // (2, 4): 30215 … 71904

      // Inside the first session's span — the lap record would join it by frame; the greens never do.
      expect(recordGreenInSection(section, green({ sessionUniqueId: 5, frame: 50000 }))).toBe(true);
      expect(recordGreenInSection(section, green({ sessionNum: 3, frame: 90000 }))).toBe(true);

      expect(section.sessions.map((s) => [s.sessionNum, s.sessionUniqueId, s.greens.length])).toEqual([
        [2, 4, 2],
        [2, 5, 1],
        [3, 4, 1],
      ]);
    });

    it("a session's first green opens it, a restart as well as a start", () => {
      const section = emptyGreensSection();

      expect(recordGreenInSection(section, restart(70000))).toBe(true);
      expect(section.sessions).toEqual([
        { sessionNum: 2, sessionUniqueId: 4, greens: [{ kind: "restart", frame: 70000, sessionTimeMs: 70000 * 16 }] },
      ]);
    });

    it("collapses a file's several starts for one session onto the newly recorded one", () => {
      const section = normalizeGreensSection({
        version: 1,
        sessions: [
          {
            sessionNum: 2,
            sessionUniqueId: 4,
            greens: [
              { kind: "start", frame: 100, sessionTimeMs: 1 },
              { kind: "start", frame: 200, sessionTimeMs: 2 },
            ],
          },
        ],
      });

      // The same moment as one of them: that entry stays, the other goes.
      expect(recordGreenInSection(section, green({ frame: 200, sessionTimeMs: 2 }))).toBe(true);
      expect(kindsAndFrames(section)).toEqual([["start", 200]]);
    });
  });

  describe("normalizeGreensSection", () => {
    it("reads anything that is not a section as an empty one", () => {
      for (const raw of [undefined, null, 7, "greens", [], {}, { version: 1 }, { version: 1, sessions: {} }]) {
        expect(normalizeGreensSection(raw)).toEqual({ version: 1, sessions: [] });
      }
    });

    it("drops what is not a session or an entry, and puts the entries in frame order", () => {
      const section = normalizeGreensSection({
        version: 1,
        sessions: [
          null,
          "x",
          { sessionNum: 2 },
          { sessionUniqueId: 4, greens: [] },
          {
            sessionNum: 2,
            sessionUniqueId: 4,
            greens: [
              { kind: "restart", frame: 71904, sessionTimeMs: 1199870 },
              null,
              7,
              { frame: 5, sessionTimeMs: 1 }, // no kind
              { kind: "start", sessionTimeMs: 1 }, // no frame
              { kind: 3, frame: 5, sessionTimeMs: 1 },
              { kind: "start", frame: Number.NaN, sessionTimeMs: 1 },
              { kind: "start", frame: 30215, sessionTimeMs: 512433 },
            ],
          },
          { sessionNum: 3, sessionUniqueId: 5, greens: "none" },
        ],
      });

      expect(section.sessions).toEqual([
        {
          sessionNum: 2,
          sessionUniqueId: 4,
          greens: [
            { kind: "start", frame: 30215, sessionTimeMs: 512433 },
            { kind: "restart", frame: 71904, sessionTimeMs: 1199870 },
          ],
        },
        { sessionNum: 3, sessionUniqueId: 5, greens: [] },
      ]);
    });

    it("keeps unknown fields on an entry, a session and the section", () => {
      const raw = {
        version: 1,
        source: "live",
        sessions: [
          {
            sessionNum: 2,
            sessionUniqueId: 4,
            type: "Race",
            greens: [{ kind: "start", frame: 30215, sessionTimeMs: 512433, flags: 1024 }],
          },
        ],
      };

      expect(normalizeGreensSection(raw)).toEqual(raw);
    });

    it("carries an entry of an unknown kind exactly as it came, and reads a missing session time on its own kinds as 0", () => {
      const section = normalizeGreensSection({
        version: 1,
        sessions: [
          {
            sessionNum: 2,
            sessionUniqueId: 4,
            greens: [
              { kind: "restart", frame: 300 },
              { kind: "checkered", frame: 200, sessionTimeMs: null, lap: 40 },
              { kind: "red", frame: 100 },
            ],
          },
        ],
      });

      expect(section.sessions[0]?.greens).toEqual([
        { kind: "red", frame: 100 },
        { kind: "checkered", frame: 200, sessionTimeMs: null, lap: 40 },
        { kind: "restart", frame: 300, sessionTimeMs: 0 },
      ]);
    });

    it("copies what it keeps: the loaded value is not the live section", () => {
      const raw = {
        version: 1,
        sessions: [{ sessionNum: 2, sessionUniqueId: 4, greens: [{ kind: "checkered", frame: 200 }] }],
      };
      const section = normalizeGreensSection(raw);

      recordGreenInSection(section, green());
      section.sessions[0]!.greens[0]!.frame = 1;

      expect(section.sessions[0]?.greens).toHaveLength(2);
      expect(raw.sessions[0]?.greens).toEqual([{ kind: "checkered", frame: 200 }]);
    });

    it("never downgrades a version on the way through, and labels a section without one", () => {
      expect(normalizeGreensSection({ version: 1, sessions: [] }).version).toBe(1);
      expect(normalizeGreensSection({ version: 0, sessions: [] }).version).toBe(1);
      expect(normalizeGreensSection({ sessions: [] }).version).toBe(1);
      expect(normalizeGreensSection({ version: 3, sessions: [] }).version).toBe(3);
    });
  });

  describe("isNewerGreensSection", () => {
    it("is true only for a version above this build's", () => {
      expect(isNewerGreensSection({ version: GREENS_SECTION_VERSION + 1, sessions: [] })).toBe(true);
      expect(isNewerGreensSection({ version: GREENS_SECTION_VERSION, sessions: [] })).toBe(false);
      expect(isNewerGreensSection({ version: "2", sessions: [] })).toBe(false);
      expect(isNewerGreensSection({ sessions: [] })).toBe(false);
      expect(isNewerGreensSection(undefined)).toBe(false);
      expect(isNewerGreensSection(null)).toBe(false);
      expect(isNewerGreensSection(2)).toBe(false);
    });
  });

  describe("mergeGreensSectionInto", () => {
    it("keeps the target's start where both have one, and takes the source's where the target has none", () => {
      const target = sectionWithGreens(); // (2, 4): start 30215, restart 71904
      const source = emptyGreensSection();

      recordGreenInSection(target, restart(50000, { sessionUniqueId: 6 })); // (2, 6): a restart, no start
      recordGreenInSection(source, green({ frame: 99999, sessionTimeMs: 1 }));
      recordGreenInSection(source, green({ sessionUniqueId: 6, frame: 45000, sessionTimeMs: 2 }));

      mergeGreensSectionInto(target, source);

      expect(target.sessions[0]?.greens).toEqual([
        { kind: "start", frame: 30215, sessionTimeMs: 512433 },
        { kind: "restart", frame: 71904, sessionTimeMs: 1199870 },
      ]);
      expect(kindsAndFrames(target, 1)).toEqual([
        ["start", 45000],
        ["restart", 50000],
      ]);
    });

    it("unions the restarts under the de-dupe rule, the target's winning inside the window, in frame order", () => {
      const target = sectionWithGreens(); // restart at 71904
      const source = emptyGreensSection();

      recordGreenInSection(source, restart(71950)); // within 60 of the target's
      recordGreenInSection(source, restart(60000));
      recordGreenInSection(source, restart(95000));

      mergeGreensSectionInto(target, source);

      expect(target.sessions[0]?.greens).toEqual([
        { kind: "start", frame: 30215, sessionTimeMs: 512433 },
        { kind: "restart", frame: 60000, sessionTimeMs: 60000 * 16 },
        { kind: "restart", frame: 71904, sessionTimeMs: 1199870 },
        { kind: "restart", frame: 95000, sessionTimeMs: 95000 * 16 },
      ]);
    });

    it("clones in a session only the source has, and leaves the source untouched", () => {
      const target = sectionWithGreens();
      const source = emptyGreensSection();

      recordGreenInSection(source, green({ sessionNum: 4, sessionUniqueId: 9, frame: 120000, sessionTimeMs: 3 }));

      const before = structuredClone(source);

      mergeGreensSectionInto(target, source);
      target.sessions[1]!.greens[0]!.frame = 1;
      recordGreenInSection(target, restart(130000, { sessionNum: 4, sessionUniqueId: 9 }));

      expect(target.sessions).toHaveLength(2);
      expect(source).toEqual(before);
    });

    it("never touches what the target already holds, entries of a kind it does not know included", () => {
      const target = normalizeGreensSection({
        version: 1,
        source: "live",
        sessions: [
          {
            sessionNum: 2,
            sessionUniqueId: 4,
            type: "Race",
            greens: [
              { kind: "start", frame: 30215, sessionTimeMs: 512433, flags: 1024 },
              { kind: "checkered", frame: 70000, sessionTimeMs: 1166666, lap: 40 },
            ],
          },
        ],
      });
      const source = normalizeGreensSection({
        version: 1,
        sessions: [
          {
            sessionNum: 2,
            sessionUniqueId: 4,
            greens: [
              { kind: "start", frame: 31000, sessionTimeMs: 1 },
              { kind: "restart", frame: 70030, sessionTimeMs: 2 }, // within 60 of the unknown entry: still added
              { kind: "checkered", frame: 70000, sessionTimeMs: 9 }, // the target has that kind at that frame
              { kind: "red", frame: 40000 },
            ],
          },
        ],
      });

      mergeGreensSectionInto(target, source);

      expect(target).toEqual({
        version: 1,
        source: "live",
        sessions: [
          {
            sessionNum: 2,
            sessionUniqueId: 4,
            type: "Race",
            greens: [
              { kind: "start", frame: 30215, sessionTimeMs: 512433, flags: 1024 },
              { kind: "red", frame: 40000 },
              { kind: "checkered", frame: 70000, sessionTimeMs: 1166666, lap: 40 },
              { kind: "restart", frame: 70030, sessionTimeMs: 2 },
            ],
          },
        ],
      });
    });
  });

  describe("findGreenInSection", () => {
    it("finds the start by the (sessionNum, sessionUniqueId) pair", () => {
      expect(findGreenInSection(sectionWithGreens(), { sessionNum: 2, sessionUniqueId: 4, kind: "start" })).toEqual({
        hit: true,
        frame: 30215,
        sessionTimeMs: 512433,
        matchedBy: "pair",
        sessionUniqueId: 4,
      });
    });

    it("the pair wins over a later instance of the same sessionNum", () => {
      const section = sectionWithGreens();

      recordGreenInSection(section, green({ sessionUniqueId: 5, frame: 200000, sessionTimeMs: 9 }));

      expect(findGreenInSection(section, { sessionNum: 2, sessionUniqueId: 4, kind: "start" })).toMatchObject({
        frame: 30215,
        matchedBy: "pair",
        sessionUniqueId: 4,
      });
    });

    it("with no sessionUniqueId, uses the one session with that sessionNum that has a start", () => {
      const section = sectionWithGreens();

      recordGreenInSection(section, restart(150000, { sessionUniqueId: 5 })); // same sessionNum, no start
      recordGreenInSection(section, green({ sessionNum: 0, sessionUniqueId: 1, frame: 100, sessionTimeMs: 1 }));

      for (const sessionUniqueId of [undefined, null]) {
        expect(findGreenInSection(section, { sessionNum: 2, sessionUniqueId, kind: "start" })).toEqual({
          hit: true,
          frame: 30215,
          sessionTimeMs: 512433,
          matchedBy: "sessionNum",
          sessionUniqueId: 4,
        });
      }

      expect(findGreenInSection(section, { sessionNum: 2, kind: "start" })).toMatchObject({ frame: 30215 });
    });

    it("of several sessions with that sessionNum that have a start, uses the latest in the recording", () => {
      const section = emptyGreensSection();

      // Recorded out of frame order, so the answer is by frame and not by position.
      recordGreenInSection(section, green({ sessionUniqueId: 7, frame: 90000, sessionTimeMs: 3 }));
      recordGreenInSection(section, green({ sessionUniqueId: 6, frame: 60000, sessionTimeMs: 2 }));
      recordGreenInSection(section, green({ sessionUniqueId: 5, frame: 30000, sessionTimeMs: 1 }));

      expect(findGreenInSection(section, { sessionNum: 2, kind: "start" })).toEqual({
        hit: true,
        frame: 90000,
        sessionTimeMs: 3,
        matchedBy: "sessionNum",
        sessionUniqueId: 7,
      });
    });

    it("falls back by sessionNum when the pair matches no session", () => {
      expect(findGreenInSection(sectionWithGreens(), { sessionNum: 2, sessionUniqueId: 0, kind: "start" })).toEqual({
        hit: true,
        frame: 30215,
        sessionTimeMs: 512433,
        matchedBy: "sessionNum",
        sessionUniqueId: 4,
      });
    });

    it("never answers a named instance with another pass's start: a recorded instance without one misses", () => {
      const section = sectionWithGreens();

      // A second pass of the race, whose green was not seen but whose restart was.
      recordGreenInSection(section, restart(150000, { sessionUniqueId: 5 }));

      expect(findGreenInSection(section, { sessionNum: 2, sessionUniqueId: 5, kind: "start" })).toEqual({
        hit: false,
        reason: "no green",
      });
      // From outside the race no instance is named, and the one start there is stands.
      expect(findGreenInSection(section, { sessionNum: 2, kind: "start" })).toMatchObject({
        hit: true,
        frame: 30215,
        matchedBy: "sessionNum",
      });
    });

    it("with exact ids, never answers a named instance from another: an unrecorded pass misses", () => {
      const section = sectionWithGreens();

      // The one start there is belongs to pass 4; the query names pass 5, whose green was not seen.
      expect(
        findGreenInSection(section, { sessionNum: 2, sessionUniqueId: 5, kind: "start" }, { exactInstance: true }),
      ).toEqual({ hit: false, reason: "no session" });
      // Without exact ids the same query takes the one start: a file whose ids did not survive the save.
      expect(findGreenInSection(section, { sessionNum: 2, sessionUniqueId: 5, kind: "start" })).toMatchObject({
        hit: true,
        frame: 30215,
        matchedBy: "sessionNum",
      });
      // Exact ids change nothing for the pair itself, or for a query that names no instance.
      expect(
        findGreenInSection(section, { sessionNum: 2, sessionUniqueId: 4, kind: "start" }, { exactInstance: true }),
      ).toMatchObject({ hit: true, frame: 30215, matchedBy: "pair" });
      expect(findGreenInSection(section, { sessionNum: 2, kind: "start" }, { exactInstance: true })).toMatchObject({
        hit: true,
        frame: 30215,
        matchedBy: "sessionNum",
      });
    });

    it("misses with 'no session' when the named instance is not recorded and several others have a start", () => {
      const section = sectionWithGreens();

      recordGreenInSection(section, green({ frame: 160000, sessionUniqueId: 5 }));

      // A pass the record never saw: neither of the two it holds is that race.
      expect(findGreenInSection(section, { sessionNum: 2, sessionUniqueId: 6, kind: "start" })).toEqual({
        hit: false,
        reason: "no session",
      });
      // Unnamed, the latest of the two.
      expect(findGreenInSection(section, { sessionNum: 2, kind: "start" })).toMatchObject({ hit: true, frame: 160000 });
    });

    it("a start lookup never answers with a restart or an entry of a kind it does not know", () => {
      const section = normalizeGreensSection({
        version: 1,
        sessions: [
          {
            sessionNum: 2,
            sessionUniqueId: 4,
            greens: [
              { kind: "Start", frame: 100, sessionTimeMs: 1 },
              { kind: "restart", frame: 200, sessionTimeMs: 2 },
              { kind: "checkered", frame: 300, sessionTimeMs: 3 },
            ],
          },
        ],
      });

      expect(findGreenInSection(section, { sessionNum: 2, sessionUniqueId: 4, kind: "start" })).toEqual({
        hit: false,
        reason: "no green",
      });
      expect(findGreenInSection(section, { sessionNum: 2, kind: "start" })).toEqual({
        hit: false,
        reason: "no green",
      });
    });

    it("misses with 'no green' for a file with no greens section", () => {
      expect(findGreenInSection(undefined, { sessionNum: 2, sessionUniqueId: 4, kind: "start" })).toEqual({
        hit: false,
        reason: "no green",
      });
    });

    it("misses with 'no session' when no recorded session has the sessionNum", () => {
      expect(findGreenInSection(emptyGreensSection(), { sessionNum: 2, kind: "start" })).toEqual({
        hit: false,
        reason: "no session",
      });
      // The unique id alone is not a match.
      expect(findGreenInSection(sectionWithGreens(), { sessionNum: 3, sessionUniqueId: 4, kind: "start" })).toEqual({
        hit: false,
        reason: "no session",
      });
    });

    it("reads the latest start should a file hold several for one session", () => {
      const section = normalizeGreensSection({
        version: 1,
        sessions: [
          {
            sessionNum: 2,
            sessionUniqueId: 4,
            greens: [
              { kind: "start", frame: 100, sessionTimeMs: 1 },
              { kind: "start", frame: 200, sessionTimeMs: 2 },
            ],
          },
        ],
      });

      expect(findGreenInSection(section, { sessionNum: 2, sessionUniqueId: 4, kind: "start" })).toMatchObject({
        frame: 200,
        sessionTimeMs: 2,
      });
    });
  });
});
