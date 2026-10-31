/**
 * `TICK_ORDER` is the code (issue #1499).
 *
 * The table is only worth what it agrees with, so these tests prove it from
 * the running translator rather than from its source: every diff module is
 * mocked with its real implementation wrapped in a spy, and the bus is a
 * recorder, so one log holds the diff calls and the publishes of a tick in
 * the order they happened. A "probe" mode then makes each spied stage emit
 * one marked event through the emitter it was handed, which shows whether
 * that stage publishes directly or through the end-of-tick flush, and where.
 * The publish sites in `translator.ts` itself are driven with real ticks. The
 * only source scan is the completeness check on those sites' literals.
 */
import type { IEventBus, SimEventName } from "@iracedeck/event-bus";
import {
  CarLeftRight,
  ReplayStateTracker,
  type SDKController,
  SessionState,
  type TelemetryCallback,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIMITER_EVENTS } from "./diff/limiter.js";
import type { EmitFn } from "./diff/types.js";
import { findEndsOnOrderViolations, TICK_ORDER, type TickStage } from "./tick-order.js";
import { _resetSimEventsIracing, initializeSimEventsIracing } from "./translator.js";

type LogEntry = { kind: "call"; stage: string } | { kind: "publish"; event: string; probeOf?: string };

const harness = vi.hoisted(() => {
  const PROBE_KEY = "__tickOrderProbe";
  const log: Array<{ kind: "call"; stage: string } | { kind: "publish"; event: string; probeOf?: string }> = [];
  // `events` maps a stage to the event its probe emits; filled from TICK_ORDER
  // once the imports have run.
  const probe = { active: false, events: new Map<string, string>() };

  /**
   * Wrap the named exports of a diff module: each call is logged as its
   * stage, and in probe mode it then emits one marked event through the
   * argument at `emitIndex`, the emitter the translator handed it.
   */
  function spy<M>(mod: M, emitArgs: Record<string, number>): M {
    const source = mod as Record<string, unknown>;
    const out: Record<string, unknown> = { ...source };

    for (const [name, emitIndex] of Object.entries(emitArgs)) {
      const original = source[name];

      if (typeof original !== "function") throw new Error(`tick-order spy: ${name} is not an exported function`);

      out[name] = (...args: unknown[]): unknown => {
        log.push({ kind: "call", stage: name });
        const result = (original as (...a: unknown[]) => unknown)(...args);

        if (probe.active) {
          const emit = args[emitIndex];

          if (typeof emit !== "function") {
            throw new Error(`tick-order spy: argument ${emitIndex} of ${name} is not its emitter`);
          }

          const event = probe.events.get(name);

          if (event === undefined) throw new Error(`tick-order spy: no probe event for ${name}`);

          (emit as (ev: unknown) => void)({ event, data: { [PROBE_KEY]: name } });
        }

        return result;
      };
    }

    return out as M;
  }

  return { PROBE_KEY, log, probe, spy };
});

// One mock per diff module that publishes, its real code wrapped. The number
// is the emitter's argument index in the translator's call; a wrong one throws
// in probe mode rather than passing. A module missing here leaves its stage
// unrecorded, which the order test reports by name.
vi.mock("./diff/start-lights.js", async (io) => harness.spy(await io(), { diffStartCountdown: 3, diffStartLights: 3 }));
vi.mock("./diff/replay-laps.js", async (io) => harness.spy(await io(), { diffReplayLaps: 4 }));
vi.mock("./diff/replay-greens.js", async (io) => harness.spy(await io(), { diffReplayGreens: 4 }));
vi.mock("./diff/replay-sessions.js", async (io) => harness.spy(await io(), { diffReplaySessions: 5 }));
vi.mock("./diff/replay-incidents.js", async (io) => harness.spy(await io(), { diffReplayIncidents: 4 }));
vi.mock("./diff/lifecycle.js", async (io) => harness.spy(await io(), { diffLifecycle: 2 }));
vi.mock("./diff/flags.js", async (io) => harness.spy(await io(), { diffFlags: 3 }));
vi.mock("./diff/laps.js", async (io) => harness.spy(await io(), { diffLaps: 6 }));
vi.mock("./diff/limiter.js", async (io) => harness.spy(await io(), { diffLimiter: 4 }));
vi.mock("./diff/pit-lane.js", async (io) => harness.spy(await io(), { diffPitLane: 4 }));
vi.mock("./diff/pace-laps.js", async (io) => harness.spy(await io(), { diffPaceLaps: 3 }));
vi.mock("./diff/rolling-start.js", async (io) => harness.spy(await io(), { diffRollingStart: 3 }));
vi.mock("./diff/pits-open.js", async (io) => harness.spy(await io(), { diffPitsOpen: 3 }));
vi.mock("./diff/toggles.js", async (io) => harness.spy(await io(), { diffToggles: 3 }));
vi.mock("./diff/pit-status.js", async (io) => harness.spy(await io(), { diffPitStatus: 3 }));
vi.mock("./diff/pit-readback.js", async (io) => harness.spy(await io(), { diffPitReadback: 3 }));
vi.mock("./diff/tire-wear.js", async (io) => harness.spy(await io(), { diffTireWear: 2 }));
vi.mock("./diff/incidents.js", async (io) => harness.spy(await io(), { diffIncidents: 3 }));
vi.mock("./diff/damage.js", async (io) => harness.spy(await io(), { diffDamage: 3 }));
vi.mock("./diff/caution.js", async (io) => harness.spy(await io(), { diffCaution: 4 }));
vi.mock("./diff/opponent-pit.js", async (io) => harness.spy(await io(), { diffOpponentPit: 10 }));
vi.mock("./diff/opponent-flags.js", async (io) => harness.spy(await io(), { diffOpponentFlags: 12 }));
vi.mock("./diff/leader-white.js", async (io) => harness.spy(await io(), { diffLeaderWhite: 7 }));
vi.mock("./diff/overtakes.js", async (io) => harness.spy(await io(), { diffOvertakes: 7 }));
vi.mock("./diff/gaps.js", async (io) => harness.spy(await io(), { diffGaps: 7 }));
vi.mock("./diff/pit-box-countdown.js", async (io) => harness.spy(await io(), { diffPitBoxCountdown: 4 }));
vi.mock("./diff/corner-name.js", async (io) => harness.spy(await io(), { diffCornerName: 6 }));
vi.mock("./diff/fuel-laps-left.js", async (io) => harness.spy(await io(), { diffFuelLapsLeft: 6 }));
vi.mock("./diff/radar.js", async (io) => harness.spy(await io(), { diffRadar: 2 }));
vi.mock("./diff/pit-speeding.js", async (io) => harness.spy(await io(), { diffPitSpeeding: 4 }));
vi.mock("./diff/track-wetness.js", async (io) => harness.spy(await io(), { diffTrackWetness: 2 }));

/** A stage that lives in a diff module, so the spies can see its calls. */
function isModuleStage(stage: TickStage): boolean {
  return stage.source.startsWith("diff/");
}

/**
 * Compare the diff calls a tick recorded with the module stages of `order`.
 * Calls of stages the table does not list (a diff that publishes nothing) are
 * ignored; every listed one must appear, in the table's order and count.
 * Returns a readable mismatch, or null.
 */
function callOrderMismatch(recordedCalls: readonly string[], order: readonly TickStage[]): string | null {
  const expected = order.filter(isModuleStage).map((s) => s.stage);
  const listed = new Set(expected);
  const actual = recordedCalls.filter((c) => listed.has(c));

  if (actual.length === expected.length && actual.every((c, i) => c === expected[i])) return null;

  const missing = expected.filter((s) => !actual.includes(s));
  const at = actual.findIndex((c, i) => c !== expected[i]);

  return [
    `recorded diff calls differ from TICK_ORDER`,
    missing.length > 0 ? `never recorded (no vi.mock spy, or no longer called): ${missing.join(", ")}` : "",
    at >= 0 ? `first difference at position ${at}: recorded ${actual[at]}, TICK_ORDER has ${expected[at]}` : "",
    `recorded: ${actual.join(" → ")}`,
    `expected: ${expected.join(" → ")}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The emitter types in one diff module's source that escape its declared
 * list: an `EmitFn<…>` whose argument is not `(typeof <NAME>_EVENTS)[number]`
 * for a list the same file exports, or an emitter-shaped function type over
 * the whole `PendingEvent` union. Either lets the module emit an event no
 * `TICK_ORDER` row names.
 */
function wideEmitters(source: string): string[] {
  const declared = new Set([...source.matchAll(/export const ([A-Z][A-Z0-9_]*_EVENTS)\b/g)].map((m) => m[1]!));
  const problems: string[] = [];

  for (const m of source.matchAll(/EmitFn<([^>]*)>/g)) {
    const list = /^\(typeof ([A-Z][A-Z0-9_]*_EVENTS)\)\[number\]$/.exec(m[1]!.trim())?.[1];

    if (list === undefined || !declared.has(list)) problems.push(m[0]);
  }

  for (const m of source.matchAll(/\(\s*\w+\??\s*:\s*PendingEvent\s*\)\s*=>/g)) problems.push(m[0]);

  return problems;
}

/**
 * The exported functions in one module's source whose parameters take an
 * emitter (`EmitFn<…>`). Each is a stage the translator can call, so each
 * needs its own row — a second function sharing its module's list would
 * otherwise publish from a position the table never names. Parameters are
 * read to the matching parenthesis, since a callback-typed parameter carries
 * parentheses of its own.
 */
function exportedEmitters(source: string): string[] {
  const names: string[] = [];

  for (const m of source.matchAll(/export function (\w+)\s*(?:<[^>]*>)?\s*\(/g)) {
    let depth = 1;
    let i = m.index + m[0].length;

    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;

      i++;
    }

    if (/EmitFn</.test(source.slice(m.index + m[0].length, i))) names.push(m[1]!);
  }

  return names;
}

/**
 * The `emit` arguments in `translator.ts` — the pending emitter handed to a
 * call. Each must be a call of a pending row; one handed to anything else (a
 * translator-local helper typed over the whole union, which no `diff/` scan
 * sees) would queue events from a position the table never names.
 */
function pendingEmitArgs(source: string): number {
  return [...source.matchAll(/\bemit\s*[,)]/g)].length;
}

/**
 * Every `publish(self, …)` call in `translator.ts`, by what TICK_ORDER needs
 * to know of it: a literal event (a translator stage), a `(ev) => publish(self,
 * ev, …)` forwarder handed to a direct diff stage, the flush of `pending`
 * (`publish(self, p, …)`), or anything else, which the table cannot place.
 * Also counts `bus.publish` calls, of which `publish()` itself is the one.
 */
function classifyPublishSites(source: string): {
  literals: string[];
  forwards: number;
  flushes: number;
  other: string[];
  busPublishes: number;
} {
  const literals: string[] = [];
  const other: string[] = [];
  let forwards = 0;
  let flushes = 0;

  for (const m of source.matchAll(/\bpublish\(\s*self,\s*/g)) {
    const rest = source.slice(m.index + m[0].length);
    const literal = /^\{\s*event:\s*"([^"]+)"/.exec(rest)?.[1];

    if (literal !== undefined) literals.push(literal);
    else if (/^ev,/.test(rest) && /\(ev\)\s*=>\s*$/.test(source.slice(0, m.index))) forwards++;
    else if (/^p,/.test(rest)) flushes++;
    else other.push(`publish(self, ${rest.slice(0, 40).split("\n")[0]}`);
  }

  return { literals, forwards, flushes, other, busPublishes: [...source.matchAll(/\.bus\.publish\(/g)].length };
}

/**
 * Check one tick's log against `order`: diff calls advance through the table
 * in order; a publish made during the tick must belong to a `direct` stage at
 * or after the last call; once the flush begins (the first publish no direct
 * stage can account for) no call may follow, and each publish must belong to
 * a `pending` stage that was called this tick, at or after the previous one.
 * A probe publish must belong to exactly the stage that made it. Greedy
 * earliest matching, which is exact for "is this log a run of the table".
 * Returns the problems and, for each publish, the stage it was matched to.
 */
function checkTickLog(
  log: readonly LogEntry[],
  order: readonly TickStage[],
): { problems: string[]; matched: Array<{ event: string; stage: string }> } {
  const problems: string[] = [];
  const matched: Array<{ event: string; stage: string }> = [];
  const called = new Set<number>();
  let cursor = -1;
  let flushCursor = -1;
  let flushing = false;
  const where = (): string => (cursor < 0 ? "the start of the tick" : `\`${order[cursor]!.stage}\``);

  for (const entry of log) {
    if (entry.kind === "call") {
      if (flushing) {
        problems.push(`\`${entry.stage}\` was called after the pending flush began`);
        continue;
      }

      const i = order.findIndex((s, k) => k > cursor && s.stage === entry.stage);

      if (i < 0) {
        problems.push(`\`${entry.stage}\` was called after ${where()}, but TICK_ORDER lists it before that`);
        continue;
      }

      cursor = i;
      called.add(i);
      continue;
    }

    const belongs = (s: TickStage): boolean =>
      entry.probeOf !== undefined ? s.stage === entry.probeOf : s.events.includes(entry.event as SimEventName);
    const label = `\`${entry.event}\`${entry.probeOf !== undefined ? ` (probe of \`${entry.probeOf}\`)` : ""}`;

    if (!flushing) {
      const i = order.findIndex((s, k) => k >= Math.max(cursor, 0) && s.via === "direct" && belongs(s));

      if (i >= 0) {
        cursor = i;
        matched.push({ event: entry.event, stage: order[i]!.stage });
        continue;
      }
    }

    const j = order.findIndex((s, k) => k >= flushCursor && s.via === "pending" && called.has(k) && belongs(s));

    if (j < 0) {
      problems.push(`${label} was published after ${where()}, where TICK_ORDER has no stage that publishes it`);
      continue;
    }

    flushing = true;
    flushCursor = j;
    matched.push({ event: entry.event, stage: order[j]!.stage });
  }

  return { problems, matched };
}

// --- The translator under test ------------------------------------------

type Controller = SDKController & {
  tick: (telemetry: TelemetryData | null, isConnected?: boolean) => void;
  setSessionInfo: (info: Record<string, unknown> | null) => void;
};

/** The `translator.test.ts` controller, trimmed: the SDK's own replay tracker, stepped before each tick. */
function createController(): Controller {
  let callback: TelemetryCallback | null = null;
  let sessionInfo: Record<string, unknown> | null = null;
  const replayState = new ReplayStateTracker();
  const controller = {
    subscribe: (_id: string, cb: TelemetryCallback) => {
      callback = cb;
      cb(null, false);
    },
    unsubscribe: () => {
      callback = null;
    },
    getSessionInfo: () => sessionInfo,
    getReplayState: (nowMs: number = Date.now()) => replayState.read(nowMs),
    noteReplayLeftForLive: (nowMs: number = Date.now()) => replayState.noteLeftForLive(nowMs),
  } as unknown as Controller;

  controller.tick = (telemetry, isConnected = true) => {
    if (telemetry) replayState.step(telemetry, sessionInfo, Date.now());
    else replayState.reset();

    callback?.(telemetry, isConnected);
  };
  controller.setSessionInfo = (info) => {
    sessionInfo = info;
  };

  return controller;
}

/** A bus that only records, into the same log as the spies. */
function createRecordingBus(): IEventBus {
  return {
    publish: (ev: { event: string; data?: unknown }) => {
      const probeOf = (ev.data as Record<string, unknown> | undefined)?.[harness.PROBE_KEY];
      harness.log.push({ kind: "publish", event: ev.event, ...(typeof probeOf === "string" ? { probeOf } : {}) });
    },
    subscribe: () => () => undefined,
    unsubscribe: () => undefined,
  } as unknown as IEventBus;
}

function telemetry(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    IsOnTrack: true,
    PlayerTrackSurface: TrkLoc.OnTrack,
    PlayerCarMyIncidentCount: 0,
    SessionFlags: 0,
    SessionNum: 0,
    PitSvFlags: 0,
    EngineWarnings: 0,
    Speed: 0,
    CarLeftRight: CarLeftRight.Off,
    RPM: 0,
    Lap: 0,
    LapDistPct: 0,
    FuelLevel: 10,
    ...overrides,
  } as TelemetryData;
}

/** Run one tick and return only its log. */
function tickLog(controller: Controller, t: TelemetryData): LogEntry[] {
  harness.log.length = 0;
  controller.tick(t);

  return [...harness.log];
}

const callsOf = (log: readonly LogEntry[]): string[] => log.flatMap((e) => (e.kind === "call" ? [e.stage] : []));

describe("TICK_ORDER", () => {
  let controller: Controller;

  beforeEach(() => {
    harness.log.length = 0;
    harness.probe.active = false;
    harness.probe.events = new Map(TICK_ORDER.filter(isModuleStage).map((s) => [s.stage, s.events[0]!]));
    controller = createController();
    initializeSimEventsIracing(createRecordingBus(), controller, silentLogger);
  });

  afterEach(() => {
    _resetSimEventsIracing();
  });

  describe("is the code", () => {
    it("calls every module stage of a live tick in TICK_ORDER's order, and each stage publishes where its `via` says", () => {
      controller.tick(telemetry());
      harness.probe.active = true;
      const log = tickLog(controller, telemetry());

      expect(callOrderMismatch(callsOf(log), TICK_ORDER)).toBeNull();
      expect(checkTickLog(log, TICK_ORDER).problems).toEqual([]);

      // Every module stage's probe reached the bus exactly once: none was
      // swallowed, so none of the checks above passed for want of input.
      const probed = log.flatMap((e) => (e.kind === "publish" && e.probeOf !== undefined ? [e.probeOf] : []));
      expect([...probed].sort()).toEqual(
        TICK_ORDER.filter(isModuleStage)
          .map((s) => s.stage)
          .sort(),
      );
    });

    // The translator's own publish sites (`source: "translator.ts"`) are not
    // spied, so each is driven with a real tick that publishes from it, and
    // the publish must land between the stages around it.
    it("publishes from each of the translator's own sites where TICK_ORDER puts it", () => {
      const matched = new Set<string>();
      const run = (t: TelemetryData): void => {
        const { problems, matched: m } = checkTickLog(tickLog(controller, t), TICK_ORDER);
        expect(problems).toEqual([]);

        for (const { stage } of m) matched.add(stage);
      };

      // Fresh connect into a practice session: the synthetic session.changed,
      // published ahead of every pre-guard diff.
      controller.setSessionInfo({ SessionInfo: { Sessions: [{ SessionType: "Practice" }, { SessionType: "Race" }] } });
      run(telemetry({ SessionState: SessionState.Racing, IsOnTrack: false }));
      // On track: driver.firstOnTrack, after the replay recorders and before the live diffs.
      run(telemetry({ SessionState: SessionState.Racing }));
      // Radar active, then a session change: the teardown, then session.changed.
      run(telemetry({ SessionState: SessionState.Racing, CarLeftRight: CarLeftRight.CarLeft }));
      run(telemetry({ SessionState: SessionState.Racing, CarLeftRight: CarLeftRight.CarLeft, SessionNum: 1 }));
      // Radar active, then into a replay: the guard's entry teardown.
      run(telemetry({ SessionNum: 1, CarLeftRight: CarLeftRight.CarLeft }));
      run(telemetry({ SessionNum: 1, CarLeftRight: CarLeftRight.CarLeft, IsReplayPlaying: true, IsOnTrack: false }));

      const translatorStages = TICK_ORDER.filter((s) => s.source === "translator.ts").map((s) => s.stage);
      expect(translatorStages.filter((s) => !matched.has(s))).toEqual([]);
    });

    // The replay-entry teardown is the last thing its tick does — the guard
    // returns right after it — so no later stage can bound it from above in a
    // log. Its position is pinned instead: after every other direct stage (the
    // test above proves it is not earlier) and directly before the first
    // pending one, the only slot left.
    it("places the replay-entry teardown directly before the live diffs", () => {
      const teardown = TICK_ORDER.findIndex((s) => s.stage === "publishActiveStateTeardown (replay entry)");
      const firstPending = TICK_ORDER.findIndex((s) => s.via === "pending");

      expect(teardown).toBeGreaterThan(0);
      expect(teardown).toBe(firstPending - 1);
      expect(TICK_ORDER.slice(firstPending).every((s) => s.via === "pending")).toBe(true);
    });
  });

  describe("is complete", () => {
    it("lists every `_EVENTS` declaration of every diff module, as the stage of that module", async () => {
      const dir = new URL("./diff/", import.meta.url);
      const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
      let declarations = 0;
      const unlisted: string[] = [];

      for (const file of files) {
        // The `.ts` path, because vite turns this import into a glob over the
        // folder's real files. It resolves to the same module, mocks included.
        const mod = (await import(`./diff/${file.slice(0, -".ts".length)}.ts`)) as Record<string, unknown>;

        for (const [name, value] of Object.entries(mod)) {
          if (!name.endsWith("_EVENTS") || !Array.isArray(value)) continue;

          declarations++;
          const stage = TICK_ORDER.find((s) => s.events === value);

          if (stage?.source !== `diff/${file}`) unlisted.push(`${file}: ${name}`);
          else expect(typeof mod[stage.stage]).toBe("function");
        }
      }

      expect(files.length).toBeGreaterThan(0);
      expect(declarations).toBeGreaterThan(0);
      expect(unlisted).toEqual([]);
      // And the other way: each module stage's events are its module's own list.
      // Counted as distinct lists, since a diff called twice has two rows.
      expect(declarations).toBe(new Set(TICK_ORDER.filter(isModuleStage).map((s) => s.events)).size);
    });

    // The two checks above see a module only through its `_EVENTS` export, so
    // a module whose emitter is typed over the whole union would declare
    // nothing, need no row, and emit past the table with every test green.
    it("types every diff module's emitter by a list that module declares", () => {
      const files = readdirSync(new URL("./diff/", import.meta.url)).filter(
        (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "types.ts",
      );
      let emitters = 0;
      const wide: string[] = [];

      for (const file of files) {
        const source = readFileSync(new URL(`./diff/${file}`, import.meta.url), "utf-8");
        emitters += [...source.matchAll(/EmitFn</g)].length;

        for (const problem of wideEmitters(source)) wide.push(`${file}: ${problem}`);
      }

      expect(emitters).toBeGreaterThan(0);
      expect(wide).toEqual([]);
    });

    // A second exported function typed by its module's existing list passes
    // both scans above and goes unspied, so each one must be a row by name.
    it("gives every exported diff function that takes an emitter a row of its own", () => {
      const files = readdirSync(new URL("./diff/", import.meta.url)).filter(
        (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "types.ts",
      );
      let found = 0;
      const unlisted: string[] = [];

      for (const file of files) {
        const source = readFileSync(new URL(`./diff/${file}`, import.meta.url), "utf-8");

        for (const name of exportedEmitters(source)) {
          found++;

          if (!TICK_ORDER.some((s) => s.stage === name && s.source === `diff/${file}`))
            unlisted.push(`${file}: ${name}`);
        }
      }

      expect(found).toBe(new Set(TICK_ORDER.filter(isModuleStage).map((s) => s.stage)).size);
      expect(unlisted).toEqual([]);
    });

    it("hands the pending emitter in translator.ts to pending rows only", () => {
      const source = readFileSync(new URL("./translator.ts", import.meta.url), "utf-8");

      // One `emit` argument per pending call. The probe test proves each
      // listed one receives it, so a surplus is a call the table cannot see.
      expect(pendingEmitArgs(source)).toBe(TICK_ORDER.filter((s) => s.via === "pending").length);
    });

    it("accounts for every publish call in translator.ts", () => {
      const source = readFileSync(new URL("./translator.ts", import.meta.url), "utf-8");
      const sites = classifyPublishSites(source);
      const direct = new Set(TICK_ORDER.filter((s) => s.source === "translator.ts").flatMap((s) => s.events));

      // Five literal sites today: the two teardown publishes, driver.firstOnTrack
      // and the two session.changed paths. Zero would mean the scan is broken.
      expect(sites.literals.length).toBeGreaterThan(0);
      expect(sites.literals.filter((e) => !direct.has(e as SimEventName))).toEqual([]);
      expect([...direct].filter((e) => !sites.literals.includes(e))).toEqual([]);
      // Every other call is one the table already places: a forwarder handed
      // to a direct diff stage, or the end-of-tick flush of `pending`.
      expect(sites.other).toEqual([]);
      expect(sites.forwards).toBe(TICK_ORDER.filter((s) => isModuleStage(s) && s.via === "direct").length);
      expect(sites.flushes).toBe(1);
      expect(sites.busPublishes).toBe(1);
    });
  });

  describe("the checks fail on bad input", () => {
    it("the emitter-type scan reports an emitter that is not typed by the module's own list", () => {
      const declared = "export const FOO_EVENTS = [] as const;\n";

      expect(wideEmitters(`${declared}function diffFoo(emit: EmitFn<(typeof FOO_EVENTS)[number]>) {}`)).toEqual([]);
      expect(wideEmitters(`${declared}function diffFoo(emit: EmitFn<SimEventName>) {}`)).toEqual([
        "EmitFn<SimEventName>",
      ]);
      expect(wideEmitters(`function diffFoo(emit: EmitFn<(typeof BAR_EVENTS)[number]>) {}`)).toHaveLength(1);
      expect(wideEmitters(`function diffFoo(emit: (ev: PendingEvent) => void) {}`)).toHaveLength(1);
      // Reading the pending list is not emitting.
      expect(wideEmitters(`function has(pending: ReadonlyArray<PendingEvent>) {}`)).toEqual([]);
    });

    it("the emitter-function scan finds every exported function taking an emitter, past callback parameters", () => {
      const source =
        "export function diffFoo(s: S, pick: (a: number) => boolean, emit: EmitFn<(typeof FOO_EVENTS)[number]>) {}\n" +
        "export function diffBar(s: S, emit: EmitFn<(typeof FOO_EVENTS)[number]>): void {}\n" +
        "export function readFoo(s: S): number { return 0; }\n" +
        "function localHelper(emit: EmitFn<(typeof FOO_EVENTS)[number]>) {}\n";

      expect(exportedEmitters(source)).toEqual(["diffFoo", "diffBar"]);
    });

    it("the pending-emitter count sees a translator-local receiver", () => {
      const calls = "diffA(state, t, emit);\ndiffB(state, emit, now);\n";

      expect(pendingEmitArgs(calls)).toBe(2);
      expect(pendingEmitArgs(`${calls}queueLocal(t, emit);\n`)).toBe(3);
      expect(pendingEmitArgs("const emit = (ev: PendingEvent): void => {};")).toBe(0);
    });

    it("the publish-site scan reports a call the table cannot place", () => {
      const placed =
        'publish(self, { event: "radar.changed", data: {} }, t, now);\n' +
        "diffX(s, (ev) => publish(self, ev, t, now));\n" +
        "for (const p of pending) publish(self, p, t, now);\n" +
        "self.bus.publish(envelope);\n";

      expect(classifyPublishSites(placed)).toEqual({
        literals: ["radar.changed"],
        forwards: 1,
        flushes: 1,
        other: [],
        busPublishes: 1,
      });
      expect(classifyPublishSites(`${placed}publish(self, ended, t, now);\n`).other).toEqual([
        "publish(self, ended, t, now);",
      ]);
      expect(classifyPublishSites(`${placed}self.bus.publish(extra);\n`).busPublishes).toBe(2);
    });

    it("the call-order comparison reports a recorded order that differs from the table", () => {
      const expected = TICK_ORDER.filter(isModuleStage).map((s) => s.stage);
      const swapped = [...expected];
      const a = swapped.indexOf("diffLimiter");
      const b = swapped.indexOf("diffPitLane");
      [swapped[a], swapped[b]] = [swapped[b]!, swapped[a]!];

      expect(callOrderMismatch(expected, TICK_ORDER)).toBeNull();
      expect(callOrderMismatch(swapped, TICK_ORDER)).toContain("first difference at position");
      expect(callOrderMismatch(expected.slice(1), TICK_ORDER)).toContain("never recorded");
    });

    it("the log check reports a call out of order, a pending stage publishing directly, and a direct one flushed", () => {
      controller.tick(telemetry());
      harness.probe.active = true;
      const log = tickLog(controller, telemetry());
      expect(checkTickLog(log, TICK_ORDER).problems).toEqual([]);

      // Two calls swapped.
      const iLimiter = log.findIndex((e) => e.kind === "call" && e.stage === "diffLimiter");
      const iPitLane = log.findIndex((e) => e.kind === "call" && e.stage === "diffPitLane");
      const swapped = [...log];
      [swapped[iLimiter], swapped[iPitLane]] = [swapped[iPitLane]!, swapped[iLimiter]!];
      expect(checkTickLog(swapped, TICK_ORDER).problems.join("\n")).toContain("`diffLimiter` was called after");

      // diffLimiter's probe published right after its call, as a direct stage would.
      const probeAt = log.findIndex((e) => e.kind === "publish" && e.probeOf === "diffLimiter");
      const early = [...log];
      const [limiterProbe] = early.splice(probeAt, 1);
      early.splice(iLimiter + 1, 0, limiterProbe!);
      expect(checkTickLog(early, TICK_ORDER).problems.join("\n")).toContain("called after the pending flush began");

      // diffReplayLaps' probe moved into the flush, as a pending stage would.
      const replayAt = log.findIndex((e) => e.kind === "publish" && e.probeOf === "diffReplayLaps");
      const late = [...log];
      const [replayProbe] = late.splice(replayAt, 1);
      late.push(replayProbe!);
      expect(checkTickLog(late, TICK_ORDER).problems.join("\n")).toContain("probe of `diffReplayLaps`");

      // A direct translator publish (the replay-entry teardown) placed before the recorders in a table.
      const misplaced = [...TICK_ORDER];
      const t = misplaced.findIndex((s) => s.stage === "publishActiveStateTeardown (replay entry)");
      const [teardown] = misplaced.splice(t, 1);
      misplaced.splice(3, 0, teardown!);
      controller.tick(telemetry({ CarLeftRight: CarLeftRight.CarLeft }));
      harness.probe.active = false;
      const replayEntry = tickLog(controller, telemetry({ CarLeftRight: CarLeftRight.CarLeft, IsReplayPlaying: true }));
      expect(checkTickLog(replayEntry, TICK_ORDER).problems).toEqual([]);
      expect(checkTickLog(replayEntry, misplaced).problems.join("\n")).toContain("`radar.changed` was published after");
    });

    describe("findEndsOnOrderViolations", () => {
      const stage = (name: string, events: SimEventName[]): TickStage => ({
        stage: name,
        source: "diff/x.ts",
        via: "pending",
        events,
      });

      it("reports a trigger stage placed after its end stage", () => {
        const v = findEndsOnOrderViolations(
          [stage("diffEnd", ["pitLane.exited"]), stage("diffTrigger", ["limiter.dropped"])],
          "limiter.dropped",
          "pitLane.exited",
        );
        expect(v.map((x) => x.kind)).toEqual(["trigger-after-end"]);
        expect(v[0]!.message).toContain(
          "`diffTrigger` (stage 1) publishes `limiter.dropped` after `diffEnd` (stage 0)",
        );
      });

      it("fails closed on one stage that emits both", () => {
        const v = findEndsOnOrderViolations(
          [stage("diffBoth", ["limiter.dropped", "pitLane.exited"])],
          "limiter.dropped",
          "pitLane.exited",
        );
        expect(v.map((x) => x.kind)).toEqual(["same-stage"]);
        expect(v[0]!.message).toContain("Prove in that module's own tests");
      });

      it("finds nothing when the trigger stage comes first", () => {
        expect(
          findEndsOnOrderViolations(
            [stage("diffTrigger", ["limiter.dropped"]), stage("diffEnd", ["pitLane.exited"])],
            "limiter.dropped",
            "pitLane.exited",
          ),
        ).toEqual([]);
      });

      it("reports an event no stage publishes, on either side", () => {
        const order = [stage("diffEnd", ["pitLane.exited"])];
        expect(findEndsOnOrderViolations(order, "limiter.dropped", "pitLane.exited").map((x) => x.kind)).toEqual([
          "never-published",
        ]);
        expect(findEndsOnOrderViolations(order, "pitLane.exited", "limiter.dropped")).toEqual([
          expect.objectContaining({ kind: "never-published", event: "limiter.dropped" }),
        ]);
      });

      it("reports every offending pair when a stage repeats", () => {
        const v = findEndsOnOrderViolations(
          [
            stage("diffEnd", ["pitLane.exited"]),
            stage("diffTrigger", ["limiter.dropped"]),
            stage("diffEnd", ["pitLane.exited"]),
            stage("diffTrigger", ["limiter.dropped"]),
          ],
          "limiter.dropped",
          "pitLane.exited",
        );
        expect(v).toHaveLength(3);
      });
    });

    it("a module's emitter refuses an event its list does not name", () => {
      const emitted: string[] = [];
      const emit: EmitFn<(typeof LIMITER_EVENTS)[number]> = (ev) => emitted.push(ev.event);
      emit({ event: "limiter.dropped", data: {} });
      // @ts-expect-error -- `pitLane.exited` is not in LIMITER_EVENTS, so diffLimiter's emitter must refuse it (#1499)
      emit({ event: "pitLane.exited", data: {} });
      expect(emitted).toEqual(["limiter.dropped", "pitLane.exited"]);
    });
  });

  // The contract the table was built for (#1407): `pit-crew.limiter-dropped`
  // speaks on `limiter.dropped` and ends on `pitLane.exited`. `race-engineer-wiring`
  // applies the same check to every `endsOn` contract.
  it("never publishes limiter.dropped after pitLane.exited on one tick (pit-crew.limiter-dropped, #1407)", () => {
    expect(findEndsOnOrderViolations(TICK_ORDER, "limiter.dropped", "pitLane.exited")).toEqual([]);
  });
});
