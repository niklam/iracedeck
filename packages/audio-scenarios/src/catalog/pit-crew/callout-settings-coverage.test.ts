import {
  AUTO_FUEL_CALLOUTS,
  CALLOUT_SETTING_KEYS,
  type CalloutFamily,
  CAUTION_CALLOUTS,
  CORNER_NAME_CALLOUTS,
  DAMAGE_CALLOUTS,
  FASTEST_LAP_CALLOUTS,
  FLAG_CALLOUTS,
  FUEL_CALLOUTS,
  GAP_CALLOUTS,
  INCIDENT_CALLOUTS,
  LAP_TIME_CALLOUTS,
  NO_LIMITER_CALLOUTS,
  OPPONENT_FLAG_CALLOUTS,
  OPPONENT_PIT_CALLOUTS,
  OVERTAKE_CALLOUTS,
  PIT_BOX_CALLOUTS,
  PIT_LIMITER_CALLOUTS,
  PIT_READBACK_CALLOUTS,
  PIT_STATUS_CALLOUTS,
  PIT_WINDOW_CALLOUTS,
  POSITION_CALLOUTS,
  QUALIFYING_INVALIDATION_CALLOUTS,
  RACE_END_CALLOUTS,
  RACE_START_CALLOUTS,
  RACE_STATUS_CALLOUTS,
  ROLLING_START_CALLOUTS,
  SECTOR_START_CALLOUTS,
  SESSION_START_CALLOUTS,
  START_LIGHT_CALLOUTS,
  TIRE_WEAR_CALLOUTS,
  TRACK_CONDITIONS_CALLOUTS,
} from "@iracedeck/callout-settings";
import { describe, expect, it } from "vitest";

import { SCENARIO_ID_TO_CORNER_NAME_ID } from "./corner-name.js";
import { SCENARIO_ID_TO_FASTEST_LAP_ID } from "./fastest-lap.js";
import { SCENARIO_ID_TO_GAP_ID } from "./gaps.js";
import {
  SCENARIO_ID_TO_AUTO_FUEL_ID,
  SCENARIO_ID_TO_CAUTION_ID,
  SCENARIO_ID_TO_DAMAGE_ID,
  SCENARIO_ID_TO_FLAG_ID,
  SCENARIO_ID_TO_FUEL_ID,
  SCENARIO_ID_TO_INCIDENT_ID,
  SCENARIO_ID_TO_PIT_BOX_ID,
  SCENARIO_ID_TO_PIT_STATUS_ID,
  SCENARIO_ID_TO_PIT_WINDOW_ID,
  SCENARIO_ID_TO_ROLLING_START_ID,
  SCENARIO_ID_TO_START_LIGHT_ID,
  SCENARIO_ID_TO_TIRE_WEAR_ID,
  SCENARIO_ID_TO_TRACK_CONDITIONS_ID,
} from "./index.js";
import { SCENARIO_ID_TO_LAP_TIME_ID } from "./lap-time.js";
import { SCENARIO_ID_TO_NO_LIMITER_ID } from "./no-limiter.js";
import { SCENARIO_ID_TO_OPPONENT_FLAG_ID } from "./opponent-flags.js";
import { SCENARIO_ID_TO_OPPONENT_PIT_ID } from "./opponent-pit.js";
import { SCENARIO_ID_TO_OVERTAKE_ID } from "./overtake.js";
import { SCENARIO_ID_TO_PIT_LIMITER_ID } from "./pit-limiter.js";
import { SCENARIO_ID_TO_POSITION_ID } from "./position.js";
import { SCENARIO_ID_TO_QUALIFYING_INVALIDATION_ID } from "./qualifying-invalidation.js";
import { SCENARIO_ID_TO_RACE_END_ID } from "./race-end.js";
import { SCENARIO_ID_TO_RACE_START_ID } from "./race-start.js";
import { SCENARIO_ID_TO_RACE_STATUS_ID } from "./race-status.js";
import { SCENARIO_ID_TO_PIT_READBACK_ID } from "./readback.js";
import { SCENARIO_ID_TO_SECTOR_START_ID } from "./sector-start.js";
import { SCENARIO_ID_TO_SESSION_START_ID } from "./session-start.js";

// Vite's `import.meta.glob`, typed for the one form the completeness check
// uses, as `sim-events-iracing`'s tick-order test does: this package's tests
// carry no Vite client typings.
declare global {
  interface ImportMeta {
    glob(patterns: string | readonly string[], options: { eager: true }): Record<string, Record<string, unknown>>;
  }
}

interface GatedFamily {
  readonly name: string;
  readonly scenarios: Readonly<Record<string, string>>;
  readonly family: CalloutFamily;
}

/** What {@link scenarioMapCoverage} needs of a row: its name, to report it, and its map, to match it. */
interface MapRow {
  readonly name: string;
  readonly scenarios: object;
}

/** How the rows cover the `SCENARIO_ID_TO_*` maps the modules export. */
interface MapCoverage {
  /** The distinct maps exported, a map re-exported by the barrel counted once. */
  readonly exported: number;
  /** Export names of every map no row names. */
  readonly missing: string[];
  /** Names of rows whose map is none of the exports. */
  readonly stray: string[];
  /** Names of rows whose map an earlier row already names. */
  readonly repeated: string[];
}

/** The export-name prefix every scenario → callout id map carries. */
const SCENARIO_MAP_PREFIX = "SCENARIO_ID_TO_";

/**
 * Match `rows` to the `SCENARIO_ID_TO_*` maps `modules` export, by object
 * identity rather than by a row's `name`: a map re-exported from the barrel is
 * one map, and a row holding a copy of a map does not cover it.
 */
function scenarioMapCoverage(
  modules: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  rows: readonly MapRow[],
): MapCoverage {
  const names = new Map<object, Set<string>>();

  for (const exports of Object.values(modules)) {
    for (const [name, value] of Object.entries(exports)) {
      if (!name.startsWith(SCENARIO_MAP_PREFIX) || typeof value !== "object" || value === null) continue;

      names.set(value, (names.get(value) ?? new Set()).add(name));
    }
  }

  const covered = new Set<object>();
  const stray: string[] = [];
  const repeated: string[] = [];

  for (const { name, scenarios } of rows) {
    if (!names.has(scenarios)) stray.push(name);
    else if (covered.has(scenarios)) repeated.push(name);
    else covered.add(scenarios);
  }

  const missing = [...names]
    .filter(([map]) => !covered.has(map))
    .map(([, exportNames]) => [...exportNames].sort().join(" = "))
    .sort();

  return { exported: names.size, missing, stray, repeated };
}

/**
 * Every non-test module of the folder, subfolders included, so a family
 * placed in one of its own is held to its row too. Each is already reachable from the
 * barrel, so this loads nothing the imports above do not; test files and
 * their helpers are left out, since loading one would register its tests here.
 */
const PIT_CREW_MODULES = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./**/*.test-*.ts"], { eager: true });

/**
 * Contract id → key, at the source (#1350): every scenario a family gates
 * resolves to a registry key, and every id of a scenario-backed family is
 * reached by at least one scenario.
 *
 * One row per `SCENARIO_ID_TO_*` map, which the completeness check below holds
 * to every such map a module of this folder exports (#1591), so a new family
 * cannot go unchecked by leaving its row out. The registry families with no such map,
 * and how each is gated instead:
 *
 * - `SPOTTER_CALLOUTS` (`cars`, `still-there`) and `PIT_SPEEDING_CALLOUTS`
 *   (`cue`): read inside their imperative engines (`registerSpotterEngine`,
 *   `registerPitSpeedingEngine`), which play direct rather than through a
 *   scenario `where:`.
 * - `PIT_SERVICE_REQUEST_CALLOUTS` (`requests`): one gate over all the toggle
 *   confirmations, applied by `wrapPitServiceRequestsScenario`.
 * - `SETUP_WARNING_CALLOUTS` (`warning`): a clause inside the session-start and
 *   race-start intros, read by the plugins' `getSetupWarningMismatch` resolver.
 * - `RACE_ENGINEER_TOGGLE_CALLOUTS`, `CORNER_NAMES_TOGGLE_CALLOUTS` (`ack`) and
 *   `TELEMETRY_CONNECT_CALLOUTS` (`radio-check`): played by deck actions in
 *   `@iracedeck/iracing-actions`, never by `registerPitCrew`.
 */
const GATED: readonly GatedFamily[] = [
  { name: "auto-fuel", scenarios: SCENARIO_ID_TO_AUTO_FUEL_ID, family: AUTO_FUEL_CALLOUTS },
  { name: "caution", scenarios: SCENARIO_ID_TO_CAUTION_ID, family: CAUTION_CALLOUTS },
  { name: "corner-name", scenarios: SCENARIO_ID_TO_CORNER_NAME_ID, family: CORNER_NAME_CALLOUTS },
  { name: "damage", scenarios: SCENARIO_ID_TO_DAMAGE_ID, family: DAMAGE_CALLOUTS },
  { name: "fastest-lap", scenarios: SCENARIO_ID_TO_FASTEST_LAP_ID, family: FASTEST_LAP_CALLOUTS },
  { name: "flag", scenarios: SCENARIO_ID_TO_FLAG_ID, family: FLAG_CALLOUTS },
  { name: "fuel", scenarios: SCENARIO_ID_TO_FUEL_ID, family: FUEL_CALLOUTS },
  { name: "gap", scenarios: SCENARIO_ID_TO_GAP_ID, family: GAP_CALLOUTS },
  { name: "incident", scenarios: SCENARIO_ID_TO_INCIDENT_ID, family: INCIDENT_CALLOUTS },
  { name: "lap-time", scenarios: SCENARIO_ID_TO_LAP_TIME_ID, family: LAP_TIME_CALLOUTS },
  { name: "no-limiter", scenarios: SCENARIO_ID_TO_NO_LIMITER_ID, family: NO_LIMITER_CALLOUTS },
  { name: "opponent-flag", scenarios: SCENARIO_ID_TO_OPPONENT_FLAG_ID, family: OPPONENT_FLAG_CALLOUTS },
  { name: "opponent-pit", scenarios: SCENARIO_ID_TO_OPPONENT_PIT_ID, family: OPPONENT_PIT_CALLOUTS },
  { name: "overtake", scenarios: SCENARIO_ID_TO_OVERTAKE_ID, family: OVERTAKE_CALLOUTS },
  { name: "pit-box", scenarios: SCENARIO_ID_TO_PIT_BOX_ID, family: PIT_BOX_CALLOUTS },
  { name: "pit-limiter", scenarios: SCENARIO_ID_TO_PIT_LIMITER_ID, family: PIT_LIMITER_CALLOUTS },
  { name: "pit-readback", scenarios: SCENARIO_ID_TO_PIT_READBACK_ID, family: PIT_READBACK_CALLOUTS },
  { name: "pit-status", scenarios: SCENARIO_ID_TO_PIT_STATUS_ID, family: PIT_STATUS_CALLOUTS },
  { name: "pit-window", scenarios: SCENARIO_ID_TO_PIT_WINDOW_ID, family: PIT_WINDOW_CALLOUTS },
  { name: "position", scenarios: SCENARIO_ID_TO_POSITION_ID, family: POSITION_CALLOUTS },
  {
    name: "qualifying-invalidation",
    scenarios: SCENARIO_ID_TO_QUALIFYING_INVALIDATION_ID,
    family: QUALIFYING_INVALIDATION_CALLOUTS,
  },
  { name: "race-end", scenarios: SCENARIO_ID_TO_RACE_END_ID, family: RACE_END_CALLOUTS },
  { name: "race-start", scenarios: SCENARIO_ID_TO_RACE_START_ID, family: RACE_START_CALLOUTS },
  { name: "race-status", scenarios: SCENARIO_ID_TO_RACE_STATUS_ID, family: RACE_STATUS_CALLOUTS },
  { name: "rolling-start", scenarios: SCENARIO_ID_TO_ROLLING_START_ID, family: ROLLING_START_CALLOUTS },
  { name: "sector-start", scenarios: SCENARIO_ID_TO_SECTOR_START_ID, family: SECTOR_START_CALLOUTS },
  { name: "session-start", scenarios: SCENARIO_ID_TO_SESSION_START_ID, family: SESSION_START_CALLOUTS },
  { name: "start-light", scenarios: SCENARIO_ID_TO_START_LIGHT_ID, family: START_LIGHT_CALLOUTS },
  { name: "tire-wear", scenarios: SCENARIO_ID_TO_TIRE_WEAR_ID, family: TIRE_WEAR_CALLOUTS },
  { name: "track-conditions", scenarios: SCENARIO_ID_TO_TRACK_CONDITIONS_ID, family: TRACK_CONDITIONS_CALLOUTS },
];

describe.each(GATED)("$name scenarios", ({ scenarios, family }) => {
  it("resolve every scenario id to a registry key", () => {
    for (const id of Object.values(scenarios)) {
      expect(CALLOUT_SETTING_KEYS).toContain(family.callouts[id]?.key);
    }
  });

  it("reach every callout id of the family", () => {
    expect(new Set(Object.values(scenarios))).toEqual(new Set(Object.keys(family.callouts)));
  });
});

describe("GATED names every SCENARIO_ID_TO_* map (#1591)", () => {
  it("discovers the folder's modules and no test file", () => {
    const paths = Object.keys(PIT_CREW_MODULES);

    expect(paths, "the barrel, which re-exports most maps").toContain("./index.ts");
    expect(
      paths.filter((path) => /\.test[.-]/.test(path)),
      "test modules the glob would load",
    ).toEqual([]);
  });

  it("gives every map exactly one row, and every row a map", () => {
    const coverage = scenarioMapCoverage(PIT_CREW_MODULES, GATED);

    // The vacuity floor: a glob matching nothing would leave nothing to miss.
    expect(coverage.exported, "SCENARIO_ID_TO_* maps exported by the folder").toBeGreaterThan(0);
    expect(coverage.missing, "maps with no GATED row").toEqual([]);
    expect(coverage.stray, "GATED rows whose map no module exports").toEqual([]);
    expect(coverage.repeated, "GATED rows naming a map another row names").toEqual([]);
  });

  describe("the comparison (positive controls)", () => {
    const a = { "pit-crew.a": "a" };
    const modules = {
      "./a.ts": { SCENARIO_ID_TO_A_ID: a, A_SCENARIO_IDS: ["pit-crew.a"] },
      "./index.ts": { SCENARIO_ID_TO_A_ID: a },
    };
    const rows: MapRow[] = [{ name: "a", scenarios: a }];

    it("counts a map the barrel re-exports once, and passes when its row is there", () => {
      expect(scenarioMapCoverage(modules, rows)).toEqual({ exported: 1, missing: [], stray: [], repeated: [] });
    });

    it("reports an exported map with no row", () => {
      const withX = { ...modules, "./x.ts": { SCENARIO_ID_TO_X_ID: { "pit-crew.x": "x" } } };

      expect(scenarioMapCoverage(withX, rows)).toEqual({
        exported: 2,
        missing: ["SCENARIO_ID_TO_X_ID"],
        stray: [],
        repeated: [],
      });
    });

    it("reports a row whose map no module exports, matching by identity rather than by contents", () => {
      const withStray: MapRow[] = [...rows, { name: "copy-of-a", scenarios: { ...a } }];

      expect(scenarioMapCoverage(modules, withStray)).toEqual({
        exported: 1,
        missing: [],
        stray: ["copy-of-a"],
        repeated: [],
      });
    });

    it("reports a second row for the same map", () => {
      const twice: MapRow[] = [...rows, { name: "a-again", scenarios: a }];

      expect(scenarioMapCoverage(modules, twice)).toEqual({
        exported: 1,
        missing: [],
        stray: [],
        repeated: ["a-again"],
      });
    });
  });
});
