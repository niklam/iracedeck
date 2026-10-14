import { describe, expect, it } from "vitest";

import {
  emptySessionsSection,
  isNewerSessionsSection,
  listSessionStartsInSection,
  mergeSessionsSectionInto,
  normalizeSessionsSection,
  recordSessionStartInSection,
  type ReplaySessionsSection,
  SESSIONS_SECTION_VERSION,
  type SessionStartRecord,
} from "./replay-sessions.js";

const start = (overrides: Partial<SessionStartRecord> = {}): SessionStartRecord => ({
  sessionNum: 0,
  sessionUniqueId: 1,
  frame: 0,
  ...overrides,
});

/** Practice, qualifying and the race of one event, recorded in that order. */
function eventSection(): ReplaySessionsSection {
  const section = emptySessionsSection();

  recordSessionStartInSection(section, start({ sessionNum: 0, sessionUniqueId: 1, frame: 0 }));
  recordSessionStartInSection(section, start({ sessionNum: 1, sessionUniqueId: 2, frame: 36120 }));
  recordSessionStartInSection(section, start({ sessionNum: 2, sessionUniqueId: 3, frame: 72480 }));

  return section;
}

const pairsAndFrames = (section: ReplaySessionsSection) =>
  section.sessions.map((s) => [s.sessionNum, s.sessionUniqueId, s.frame]);

describe("replay sessions section (#1426)", () => {
  it("writes one entry per session in frame order", () => {
    expect(SESSIONS_SECTION_VERSION).toBe(1);
    expect(JSON.parse(JSON.stringify(eventSection()))).toEqual({
      version: 1,
      sessions: [
        { sessionNum: 0, sessionUniqueId: 1, frame: 0 },
        { sessionNum: 1, sessionUniqueId: 2, frame: 36120 },
        { sessionNum: 2, sessionUniqueId: 3, frame: 72480 },
      ],
    });
  });

  describe("recordSessionStartInSection", () => {
    it("keeps the entries in frame order whatever the order they arrive in", () => {
      const section = emptySessionsSection();

      expect(recordSessionStartInSection(section, start({ sessionNum: 2, sessionUniqueId: 3, frame: 72480 }))).toBe(
        true,
      );
      expect(recordSessionStartInSection(section, start({ sessionNum: 0, sessionUniqueId: 1, frame: 0 }))).toBe(true);
      expect(recordSessionStartInSection(section, start({ sessionNum: 1, sessionUniqueId: 2, frame: 36120 }))).toBe(
        true,
      );

      expect(pairsAndFrames(section)).toEqual([
        [0, 1, 0],
        [1, 2, 36120],
        [2, 3, 72480],
      ]);
    });

    it("keeps a session's first start: a second record for the same pair changes nothing", () => {
      const section = eventSection();

      expect(recordSessionStartInSection(section, start({ sessionNum: 1, sessionUniqueId: 2, frame: 36122 }))).toBe(
        false,
      );
      expect(recordSessionStartInSection(section, start({ sessionNum: 1, sessionUniqueId: 2, frame: 10 }))).toBe(false);
      expect(recordSessionStartInSection(section, start({ sessionNum: 1, sessionUniqueId: 2, frame: 36120 }))).toBe(
        false,
      );

      expect(pairsAndFrames(section)).toEqual([
        [0, 1, 0],
        [1, 2, 36120],
        [2, 3, 72480],
      ]);
    });

    it("records a restarted event's second instance of a session number as a new entry, later on the tape", () => {
      const section = emptySessionsSection();

      recordSessionStartInSection(section, start({ sessionNum: 0, sessionUniqueId: 1, frame: 0 }));
      recordSessionStartInSection(section, start({ sessionNum: 1, sessionUniqueId: 2, frame: 9000 }));

      expect(recordSessionStartInSection(section, start({ sessionNum: 0, sessionUniqueId: 3, frame: 21000 }))).toBe(
        true,
      );
      expect(pairsAndFrames(section)).toEqual([
        [0, 1, 0],
        [1, 2, 9000],
        [0, 3, 21000],
      ]);
    });
  });

  describe("normalizeSessionsSection", () => {
    it("reads anything that is not a section as an empty one", () => {
      expect(normalizeSessionsSection(undefined)).toEqual(emptySessionsSection());
      expect(normalizeSessionsSection(null)).toEqual(emptySessionsSection());
      expect(normalizeSessionsSection([1, 2])).toEqual(emptySessionsSection());
      expect(normalizeSessionsSection({ version: 1, sessions: "no" })).toEqual(emptySessionsSection());
    });

    it("drops what is not an entry, sorts by frame and keeps unknown fields at both levels", () => {
      expect(
        normalizeSessionsSection({
          version: 1,
          source: "live",
          sessions: [
            { sessionNum: 2, sessionUniqueId: 3, frame: 72480, type: "Race" },
            null,
            "text",
            { sessionNum: 1, sessionUniqueId: 2 },
            { sessionNum: 1, sessionUniqueId: "2", frame: 36120 },
            { sessionNum: 0, sessionUniqueId: 1, frame: 0 },
          ],
        }),
      ).toEqual({
        version: 1,
        source: "live",
        sessions: [
          { sessionNum: 0, sessionUniqueId: 1, frame: 0 },
          { sessionNum: 2, sessionUniqueId: 3, frame: 72480, type: "Race" },
        ],
      });
    });

    it("never downgrades a newer section version on the way through", () => {
      expect(normalizeSessionsSection({ version: 3, sessions: [] }).version).toBe(3);
      expect(normalizeSessionsSection({ sessions: [] }).version).toBe(SESSIONS_SECTION_VERSION);
    });
  });

  it("isNewerSessionsSection is true only for a version above this build's", () => {
    expect(isNewerSessionsSection({ version: 2, sessions: [] })).toBe(true);
    expect(isNewerSessionsSection({ version: 1, sessions: [] })).toBe(false);
    expect(isNewerSessionsSection({ sessions: [] })).toBe(false);
    expect(isNewerSessionsSection(undefined)).toBe(false);
    expect(isNewerSessionsSection("2")).toBe(false);
  });

  describe("mergeSessionsSectionInto", () => {
    it("keeps the target's entry where both have the pair, copies the rest in frame order, and leaves the source alone", () => {
      const target = normalizeSessionsSection({
        version: 1,
        sessions: [
          { sessionNum: 0, sessionUniqueId: 1, frame: 0, note: "file" },
          { sessionNum: 2, sessionUniqueId: 3, frame: 72480 },
        ],
      });
      const source = emptySessionsSection();

      recordSessionStartInSection(source, start({ sessionNum: 0, sessionUniqueId: 1, frame: 15 }));
      recordSessionStartInSection(source, start({ sessionNum: 1, sessionUniqueId: 2, frame: 36120 }));

      const before = structuredClone(source);

      mergeSessionsSectionInto(target, source);

      expect(target.sessions).toEqual([
        { sessionNum: 0, sessionUniqueId: 1, frame: 0, note: "file" },
        { sessionNum: 1, sessionUniqueId: 2, frame: 36120 },
        { sessionNum: 2, sessionUniqueId: 3, frame: 72480 },
      ]);
      expect(source).toEqual(before);

      // Cloned: a change to the target does not reach the source.
      const copied = target.sessions[1];

      if (copied !== undefined) copied.frame = 1;

      expect(source.sessions[1]?.frame).toBe(36120);
    });
  });

  describe("listSessionStartsInSection", () => {
    it("lists every start in frame order, as copies", () => {
      const section = eventSection();
      const list = listSessionStartsInSection(section);

      expect(list.map((s) => s.frame)).toEqual([0, 36120, 72480]);

      const first = list[0];

      if (first !== undefined) first.frame = 99;

      expect(section.sessions[0]?.frame).toBe(0);
    });

    it("lists nothing for a file with no sessions section", () => {
      expect(listSessionStartsInSection(undefined)).toEqual([]);
    });
  });
});
