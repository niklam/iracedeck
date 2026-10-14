import { describe, expect, it } from "vitest";

import {
  emptyIncidentsSection,
  INCIDENT_FOLD_FRAMES,
  type IncidentRecord,
  INCIDENTS_SECTION_VERSION,
  isNewerIncidentsSection,
  listIncidentsInSection,
  mergeIncidentsSectionInto,
  normalizeIncidentsSection,
  recordIncidentInSection,
  type ReplayIncidentsSection,
} from "./replay-incidents.js";

/** The driver's own 2x in race session (2, 3) unless overridden. */
const rise = (overrides: Partial<IncidentRecord> = {}): IncidentRecord => ({
  sessionNum: 2,
  sessionUniqueId: 3,
  carIdx: 7,
  carNumberRaw: 2,
  frame: 40000,
  sessionTimeMs: 666000,
  delta: 2,
  source: "telemetry",
  ...overrides,
});

const entries = (section: ReplayIncidentsSection, index = 0) =>
  section.sessions[index]?.incidents.map((e) => [e.carIdx, e.frame, e.delta]);

describe("replay incidents section (#1426)", () => {
  it("pins the fold window at ten seconds, #1122's sequence gap", () => {
    expect(INCIDENT_FOLD_FRAMES).toBe(600);
    expect(INCIDENTS_SECTION_VERSION).toBe(1);
  });

  it("writes exactly the section's shape", () => {
    const section = emptyIncidentsSection();

    expect(recordIncidentInSection(section, rise())).toBe(true);
    expect(
      recordIncidentInSection(
        section,
        rise({ carIdx: 12, carNumberRaw: 44, frame: 52000, delta: 4, source: "sessionInfo" }),
      ),
    ).toBe(true);

    expect(JSON.parse(JSON.stringify(section))).toEqual({
      version: 1,
      sessions: [
        {
          sessionNum: 2,
          sessionUniqueId: 3,
          incidents: [
            { carIdx: 7, carNumberRaw: 2, frame: 40000, sessionTimeMs: 666000, delta: 2, source: "telemetry" },
            { carIdx: 12, carNumberRaw: 44, frame: 52000, sessionTimeMs: 666000, delta: 4, source: "sessionInfo" },
          ],
        },
      ],
    });
  });

  describe("recordIncidentInSection: the 600-frame fold", () => {
    it("folds a rise inside the window into the car's last entry, which keeps its first frame and time", () => {
      const section = emptyIncidentsSection();

      recordIncidentInSection(section, rise({ delta: 1 }));
      expect(recordIncidentInSection(section, rise({ frame: 40240, sessionTimeMs: 670000, delta: 2 }))).toBe(true);

      expect(section.sessions[0]?.incidents).toEqual([
        { carIdx: 7, carNumberRaw: 2, frame: 40000, sessionTimeMs: 666000, delta: 3, source: "telemetry" },
      ]);
    });

    it("folds a rise exactly at the window's edge", () => {
      const section = emptyIncidentsSection();

      recordIncidentInSection(section, rise());
      recordIncidentInSection(section, rise({ frame: 40000 + INCIDENT_FOLD_FRAMES, delta: 4 }));

      expect(entries(section)).toEqual([[7, 40000, 6]]);
    });

    it("opens a new entry for a rise past the window", () => {
      const section = emptyIncidentsSection();

      recordIncidentInSection(section, rise());
      recordIncidentInSection(section, rise({ frame: 40000 + INCIDENT_FOLD_FRAMES + 1, delta: 4 }));

      expect(entries(section)).toEqual([
        [7, 40000, 2],
        [7, 40601, 4],
      ]);
    });

    it("measures the window from the entry's first frame, so a long chain of rises is not one entry", () => {
      const section = emptyIncidentsSection();

      recordIncidentInSection(section, rise({ frame: 40000, delta: 1 }));
      recordIncidentInSection(section, rise({ frame: 40500, delta: 1 }));
      recordIncidentInSection(section, rise({ frame: 41000, delta: 1 }));

      expect(entries(section)).toEqual([
        [7, 40000, 2],
        [7, 41000, 1],
      ]);
    });

    it("folds into the car's LAST entry only", () => {
      const section = emptyIncidentsSection();

      recordIncidentInSection(section, rise({ frame: 40000 }));
      recordIncidentInSection(section, rise({ frame: 50000 }));
      recordIncidentInSection(section, rise({ frame: 50300, delta: 1 }));

      expect(entries(section)).toEqual([
        [7, 40000, 2],
        [7, 50000, 3],
      ]);
    });

    it("never folds another car's rise, nor a car index now carrying another number", () => {
      const section = emptyIncidentsSection();

      recordIncidentInSection(section, rise());
      recordIncidentInSection(section, rise({ carIdx: 12, carNumberRaw: 44, frame: 40100, source: "sessionInfo" }));
      recordIncidentInSection(section, rise({ carNumberRaw: 9, frame: 40200 }));

      expect(section.sessions[0]?.incidents.map((e) => [e.carIdx, e.carNumberRaw, e.frame, e.delta])).toEqual([
        [7, 2, 40000, 2],
        [12, 44, 40100, 2],
        [7, 9, 40200, 2],
      ]);
    });

    it("never folds across session pairs, a restarted event's other instance included", () => {
      const section = emptyIncidentsSection();

      recordIncidentInSection(section, rise());
      recordIncidentInSection(section, rise({ sessionUniqueId: 6, frame: 40100 }));
      recordIncidentInSection(section, rise({ sessionNum: 3, sessionUniqueId: 7, frame: 40200 }));

      expect(section.sessions.map((s) => [s.sessionNum, s.sessionUniqueId, s.incidents.length])).toEqual([
        [2, 3, 1],
        [2, 6, 1],
        [3, 7, 1],
      ]);
    });

    it("opens a new entry, in frame order, for a rise before the car's last entry", () => {
      const section = emptyIncidentsSection();

      recordIncidentInSection(section, rise({ frame: 40000 }));
      recordIncidentInSection(section, rise({ frame: 39800 }));

      expect(entries(section)).toEqual([
        [7, 39800, 2],
        [7, 40000, 2],
      ]);
    });
  });

  describe("normalizeIncidentsSection", () => {
    it("reads anything that is not a section as an empty one", () => {
      expect(normalizeIncidentsSection(undefined)).toEqual(emptyIncidentsSection());
      expect(normalizeIncidentsSection({ sessions: {} })).toEqual(emptyIncidentsSection());
    });

    it("drops what is not a session or an entry, sorts by frame, and keeps unknown fields and sources at every level", () => {
      expect(
        normalizeIncidentsSection({
          version: 1,
          source: "live",
          sessions: [
            { sessionNum: 2 },
            {
              sessionNum: 2,
              sessionUniqueId: 3,
              type: "Race",
              incidents: [
                { carIdx: 7, carNumberRaw: 2, frame: 52000, delta: 4, source: "telemetry", sessionTimeMs: 1, lap: 9 },
                { carIdx: 7, carNumberRaw: 2, frame: 40000, delta: 2, source: "replayScan" },
                { carIdx: 7, frame: 41000, delta: 2, source: "telemetry" },
                { carIdx: 7, carNumberRaw: 2, frame: 42000, source: "telemetry" },
                { carIdx: 7, carNumberRaw: 2, frame: 43000, delta: 2 },
                "text",
              ],
            },
          ],
        }),
      ).toEqual({
        version: 1,
        source: "live",
        sessions: [
          {
            sessionNum: 2,
            sessionUniqueId: 3,
            type: "Race",
            incidents: [
              { carIdx: 7, carNumberRaw: 2, frame: 40000, sessionTimeMs: 0, delta: 2, source: "replayScan" },
              { carIdx: 7, carNumberRaw: 2, frame: 52000, sessionTimeMs: 1, delta: 4, source: "telemetry", lap: 9 },
            ],
          },
        ],
      });
    });

    it("never downgrades a newer section version on the way through", () => {
      expect(normalizeIncidentsSection({ version: 4, sessions: [] }).version).toBe(4);
    });
  });

  it("isNewerIncidentsSection is true only for a version above this build's", () => {
    expect(isNewerIncidentsSection({ version: 2 })).toBe(true);
    expect(isNewerIncidentsSection({ version: 1 })).toBe(false);
    expect(isNewerIncidentsSection(null)).toBe(false);
  });

  describe("mergeIncidentsSectionInto", () => {
    it("keeps the target's entry where both hold the incident, copies the rest, and leaves the source alone", () => {
      const target = emptyIncidentsSection();

      recordIncidentInSection(target, rise({ delta: 4 }));

      const source = emptyIncidentsSection();

      recordIncidentInSection(source, rise({ frame: 40010, delta: 2 })); // the same crash
      recordIncidentInSection(source, rise({ frame: 60000, delta: 1 }));
      recordIncidentInSection(source, rise({ carIdx: 12, carNumberRaw: 44, frame: 40005, source: "sessionInfo" }));
      recordIncidentInSection(source, rise({ sessionUniqueId: 8, frame: 90000 }));

      const before = structuredClone(source);

      mergeIncidentsSectionInto(target, source);

      expect(entries(target)).toEqual([
        [7, 40000, 4],
        [12, 40005, 2],
        [7, 60000, 1],
      ]);
      expect(target.sessions[1]).toMatchObject({ sessionNum: 2, sessionUniqueId: 8 });
      expect(source).toEqual(before);
    });
  });

  describe("listIncidentsInSection", () => {
    it("lists every session's incidents in frame order, each with its session, as copies", () => {
      const section = emptyIncidentsSection();

      recordIncidentInSection(section, rise({ frame: 50000 }));
      recordIncidentInSection(section, rise({ sessionNum: 1, sessionUniqueId: 2, frame: 20000 }));
      recordIncidentInSection(section, rise({ carIdx: 12, carNumberRaw: 44, frame: 45000, source: "sessionInfo" }));

      const list = listIncidentsInSection(section);

      expect(list.map((i) => [i.sessionNum, i.sessionUniqueId, i.carIdx, i.frame])).toEqual([
        [1, 2, 7, 20000],
        [2, 3, 12, 45000],
        [2, 3, 7, 50000],
      ]);

      const first = list[0];

      if (first !== undefined) first.delta = 99;

      expect(section.sessions[1]?.incidents[0]?.delta).toBe(2);
    });

    it("lists nothing for a file with no incidents section", () => {
      expect(listIncidentsInSection(undefined)).toEqual([]);
    });
  });
});
