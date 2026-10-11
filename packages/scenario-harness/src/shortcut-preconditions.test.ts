import type { IAudioService } from "@iracedeck/audio-service";
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import type { SessionInfo, TelemetryData } from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import { isOvalTrack, type PaceLineup, resolvePaceLineup, resolvePlayerCarIdx } from "@iracedeck/sim-events-iracing";
import type { FastifyInstance } from "fastify";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MockPlatformAdapter } from "./mock-platform-adapter.js";
import { MockSDKController } from "./mock-sdk-controller.js";
import { AT_RACING_SPEED, SCENARIO_SHORTCUTS } from "./scenario-shortcuts.js";
import { createServer } from "./server.js";
import {
  checkShortcutPreconditions,
  type HarnessPreconditionState,
  type ShortcutPrecondition,
} from "./shortcut-preconditions.js";

// Pass-through spies on the translator's own readers (issue #1127 review): a
// precondition must ASK them rather than restate their rules, and only a spy
// can tell the two apart — a restatement answers every table below identically.
vi.mock("@iracedeck/sim-events-iracing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/sim-events-iracing")>();

  return {
    ...actual,
    resolvePlayerCarIdx: vi.fn(actual.resolvePlayerCarIdx),
    resolvePaceLineup: vi.fn(actual.resolvePaceLineup),
    isOvalTrack: vi.fn(actual.isOvalTrack),
  };
});

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The ids that must refuse to run without a session preset (issue #1127; the catch-up button since #1168). */
const CAUTION_SHORTCUT_IDS = [
  "flag-caution-restart",
  "flag-caution-lineup-change",
  "flag-caution-extra-lap",
  "flag-caution-catch-up",
];

/** The caution button that also refuses to run while the mock SDK is disconnected (issue #1168). */
const CATCH_UP_SHORTCUT_ID = "flag-caution-catch-up";

/** The whole-formation run, which needs its grid read on an OVAL (issue #1167). */
const FORMATION_SHORTCUT_ID = "rolling-start-formation";

/** The formation's three calls on their own, which need the grid read as a grid and no more. */
const FORMATION_CALL_SHORTCUT_IDS = [
  "rolling-start-pace-car-moving",
  "rolling-start-lineup-changed",
  "flag-one-lap-to-green",
];

/** Every session preset the harness ships, by name — read from the folder, so a new one is judged too. */
const SESSION_PRESETS = readdirSync(join(PACKAGE_ROOT, "presets", "session"))
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length));

/** The mock SDK's boot telemetry: session 0, and nothing a precondition reads beyond that. */
const BOOT_TELEMETRY = new MockSDKController().getState().telemetry;

/**
 * The ids that must refuse to run while the mock SDK is disconnected (#1349):
 * every shortcut that sets the car up for the overtake gate. Which shortcuts
 * those are is pinned in `scenario-shortcuts.test.ts`.
 */
const GATED_SHORTCUT_IDS = SCENARIO_SHORTCUTS.filter((s) => s.telemetrySequence?.[0] === AT_RACING_SPEED).map(
  (s) => s.id,
);

/** A connected harness holding `sessionInfo` — isolates the session-preset rule from the connection one. */
function connectedWith(sessionInfo: Record<string, unknown> | null): HarnessPreconditionState {
  return { sessionInfo, isConnected: true, telemetry: BOOT_TELEMETRY };
}

/** The harness as it boots: no session preset, mock SDK disconnected. */
const AT_BOOT: HarnessPreconditionState = { sessionInfo: null, isConnected: false, telemetry: BOOT_TELEMETRY };

function readSessionPreset(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "presets", "session", `${name}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

function requiresOf(id: string): readonly ShortcutPrecondition[] | undefined {
  return SCENARIO_SHORTCUTS.find((s) => s.id === id)?.requires;
}

describe("checkShortcutPreconditions", () => {
  it("refuses a caution shortcut when no session info is applied", () => {
    // The failure this exists to replace: the sequence runs, the flag lines
    // play, and every lineup line is silently dropped because
    // `resolvePaceLineup` cannot read `DriverInfo.DriverCarIdx`.
    for (const id of CAUTION_SHORTCUT_IDS) {
      const refusal = checkShortcutPreconditions(requiresOf(id), connectedWith(null));

      expect(refusal, `"${id}" ran with no session info`).toEqual(expect.stringContaining("session preset"));
    }
  });

  it("permits a caution shortcut once a session preset naming the player's car is applied", () => {
    for (const id of CAUTION_SHORTCUT_IDS) {
      expect(
        checkShortcutPreconditions(requiresOf(id), connectedWith(readSessionPreset("race"))),
        `"${id}" on race`,
      ).toBeNull();
      expect(
        checkShortcutPreconditions(requiresOf(id), connectedWith(readSessionPreset("race-oval"))),
        `"${id}" on race-oval`,
      ).toBeNull();
    }
  });

  it("asks the lineup resolver itself whether the session names the player — never a restated rule", () => {
    // The read this precondition gets ahead of is `resolvePlayerCarIdx` in the
    // translator's `diff/pace-lineup.ts`. A copy of its rule here would drift
    // the moment that one tightened and admit the half-silent run anyway, so
    // the check has to BE that function: called with the session, and obeyed.
    const sessionInfo = { DriverInfo: { DriverCarIdx: 7 } };

    vi.mocked(resolvePlayerCarIdx).mockClear();
    expect(checkShortcutPreconditions(["player-car-index"], connectedWith(sessionInfo))).toBeNull();
    expect(vi.mocked(resolvePlayerCarIdx)).toHaveBeenCalledWith(sessionInfo);

    // A session the resolver rejects is refused here too, whatever it holds —
    // the resolver's verdict is the rule, not the shape of `DriverCarIdx`.
    vi.mocked(resolvePlayerCarIdx).mockReturnValueOnce(null);
    expect(checkShortcutPreconditions(["player-car-index"], connectedWith(sessionInfo))).not.toBeNull();

    // And the real resolver's own refusals hold through it.
    for (const refused of [{}, { DriverInfo: { DriverCarIdx: -1 } }, { DriverInfo: { DriverCarIdx: "7" } }]) {
      expect(
        checkShortcutPreconditions(["player-car-index"], connectedWith(refused)),
        JSON.stringify(refused),
      ).not.toBeNull();
    }
  });

  it("permits a shortcut that declares no preconditions, whatever the harness holds", () => {
    // The ~dozen shortcuts that set up everything they need are untouched by
    // this: no `requires`, no refusal, not even with an empty harness.
    const plain = SCENARIO_SHORTCUTS.filter((s) => s.requires === undefined);

    expect(plain.length).toBeGreaterThan(0);

    for (const shortcut of plain) {
      expect(checkShortcutPreconditions(shortcut.requires, AT_BOOT), `"${shortcut.id}"`).toBeNull();
    }
  });

  it("names both what is missing and how to fix it", () => {
    // The message is the whole point — it is shown verbatim to a tester who
    // would otherwise be listening for audio that was never going to play.
    const refusal = checkShortcutPreconditions(["player-car-index"], connectedWith(null)) ?? "";

    expect(refusal).toContain("DriverInfo.DriverCarIdx");
    expect(refusal).toContain("race");
  });

  it("refuses an overtake or gap shortcut while the mock SDK is disconnected, naming the toggle (#1349)", () => {
    // The gate these buttons set the car up for reads the translator's latest
    // telemetry, which a disconnected translator never receives: the line
    // would be refused by its own gate while the button looked as if it ran.
    // A session preset does not help, so this holds with one applied.
    expect(GATED_SHORTCUT_IDS).toHaveLength(13);

    for (const id of GATED_SHORTCUT_IDS) {
      const refusal = checkShortcutPreconditions(requiresOf(id), {
        sessionInfo: readSessionPreset("race"),
        isConnected: false,
        telemetry: BOOT_TELEMETRY,
      });

      expect(refusal, `"${id}" ran disconnected`).toEqual(expect.stringContaining("Connect the mock SDK"));
      expect(refusal).toContain("Connected");
    }
  });

  it("permits an overtake or gap shortcut once the mock SDK is connected, with no session preset", () => {
    for (const id of GATED_SHORTCUT_IDS) {
      expect(checkShortcutPreconditions(requiresOf(id), connectedWith(null)), `"${id}"`).toBeNull();
    }
  });

  it("refuses the catch-up shortcut while the mock SDK is disconnected, on the right session too (#1168)", () => {
    // Both its calls are the translator's decision and are gated on the
    // translator's state when they speak. Disconnected, the translator sees no
    // ticks: the button would be accepted, run for a minute, and play nothing.
    // The session is asked for first, since without one no connection helps.
    expect(requiresOf(CATCH_UP_SHORTCUT_ID)).toEqual(["player-car-index", "sdk-connected"]);
    expect(checkShortcutPreconditions(requiresOf(CATCH_UP_SHORTCUT_ID), AT_BOOT)).toEqual(
      expect.stringContaining("session preset"),
    );

    for (const preset of ["race", "race-oval"]) {
      const refusal = checkShortcutPreconditions(requiresOf(CATCH_UP_SHORTCUT_ID), {
        sessionInfo: readSessionPreset(preset),
        isConnected: false,
        telemetry: BOOT_TELEMETRY,
      });

      expect(refusal, `ran disconnected on ${preset}`).toEqual(expect.stringContaining("Connect the mock SDK"));
      expect(refusal).toContain("catch-up");
      expect(
        checkShortcutPreconditions(requiresOf(CATCH_UP_SHORTCUT_ID), connectedWith(readSessionPreset(preset))),
      ).toBeNull();
    }
  });
});

describe("the rolling-start preconditions (issue #1167)", () => {
  it("refuses every rolling-start shortcut with no session preset, naming the two that work", () => {
    // The formation calls are race-only, and read the driver list for the car
    // to form up behind: with no session they are silent to the last one.
    for (const id of [FORMATION_SHORTCUT_ID, ...FORMATION_CALL_SHORTCUT_IDS]) {
      const refusal = checkShortcutPreconditions(requiresOf(id), connectedWith(null));

      expect(refusal, `"${id}" ran with no session info`).toEqual(expect.stringContaining("session preset"));
      expect(refusal).toContain("race-oval");
    }
  });

  it.each(SESSION_PRESETS)("permits the formation's three calls on exactly the race presets (%s)", (preset) => {
    // `practice` names a player car and passes the caution buttons' check;
    // here it is refused, because no formation call speaks outside a race.
    const isRace = preset === "race" || preset === "race-oval";

    for (const id of FORMATION_CALL_SHORTCUT_IDS) {
      const refusal = checkShortcutPreconditions(requiresOf(id), connectedWith(readSessionPreset(preset)));

      expect(refusal === null, `"${id}" on ${preset}: ${refusal}`).toBe(isRace);
    }
  });

  it.each(SESSION_PRESETS)("permits the whole formation on the oval race preset alone (%s)", (preset) => {
    // Unlike the caution buttons, which run on a road course and merely lose
    // the lane: the lane wording is what this button is for.
    const refusal = checkShortcutPreconditions(
      requiresOf(FORMATION_SHORTCUT_ID),
      connectedWith(readSessionPreset(preset)),
    );

    expect(refusal === null, `on ${preset}: ${refusal}`).toBe(preset === "race-oval");

    if (preset !== "race-oval") expect(refusal).toContain('"race-oval" session preset');
  });

  it("refuses every rolling-start shortcut while the mock SDK is disconnected, even on the right preset", () => {
    // Their callouts ask the translator whether a formation is running, and a
    // translator that sees no ticks never opens one.
    for (const id of [FORMATION_SHORTCUT_ID, ...FORMATION_CALL_SHORTCUT_IDS]) {
      const refusal = checkShortcutPreconditions(requiresOf(id), {
        sessionInfo: readSessionPreset("race-oval"),
        isConnected: false,
        telemetry: BOOT_TELEMETRY,
      });

      expect(refusal, `"${id}" ran disconnected`).toEqual(expect.stringContaining("Connect the mock SDK"));
      expect(refusal).toContain("formation");
    }
  });

  it("asks the translator's lineup reader and its oval reader — never restated rules", () => {
    // The grid frame is five rules at once, and "is this an oval" a sixth; a
    // copy of any here would drift the day the reader tightened. So the check
    // has to BE those functions: called with the session, and obeyed.
    const sessionInfo = readSessionPreset("race-oval");

    vi.mocked(resolvePaceLineup).mockClear();
    vi.mocked(isOvalTrack).mockClear();
    expect(checkShortcutPreconditions(["rolling-start-oval-grid"], connectedWith(sessionInfo))).toBeNull();
    expect(vi.mocked(isOvalTrack)).toHaveBeenCalledWith(sessionInfo);
    expect(vi.mocked(resolvePaceLineup)).toHaveBeenCalledWith(expect.anything(), sessionInfo, true);

    // The lineup the reader was asked about is the buttons' own grid, in the
    // session the mock is in: the pace car without a row, the player at
    // line 0 row 3.
    const asked = vi.mocked(resolvePaceLineup).mock.calls[0][0] as Record<string, unknown>;

    expect(asked.SessionNum).toBe(BOOT_TELEMETRY.SessionNum);
    expect((asked.CarIdxPaceRow as number[])[0]).toBe(-1);
    expect([(asked.CarIdxPaceLine as number[])[7], (asked.CarIdxPaceRow as number[])[7]]).toEqual([0, 3]);

    // Whatever the session holds, the readers' verdict is the rule. No lineup:
    // refused. A grid with no lane: the calls run, the whole formation does not.
    vi.mocked(resolvePaceLineup).mockReturnValueOnce(null);
    expect(checkShortcutPreconditions(["rolling-start-grid"], connectedWith(sessionInfo))).not.toBeNull();

    const noLane = { anchor: "grid", line: null } as PaceLineup;

    vi.mocked(resolvePaceLineup).mockReturnValueOnce(noLane).mockReturnValueOnce(noLane);
    expect(checkShortcutPreconditions(["rolling-start-grid"], connectedWith(sessionInfo))).toBeNull();
    expect(checkShortcutPreconditions(["rolling-start-oval-grid"], connectedWith(sessionInfo))).not.toBeNull();

    // A lineup read in the caution's frame, or in none, is not a grid.
    for (const anchor of ["pace-car", null] as const) {
      vi.mocked(resolvePaceLineup).mockReturnValueOnce({ anchor, line: "inside" } as PaceLineup);
      expect(
        checkShortcutPreconditions(["rolling-start-grid"], connectedWith(sessionInfo)),
        `${anchor}`,
      ).not.toBeNull();
    }
  });

  it("judges the session the mock is IN, not the first one the session info lists", () => {
    // Whether a session is a race is a question about one entry of the session
    // list. A weekend with practice ahead of the race is refused while the
    // mock sits in the practice and permitted once it is in the race.
    const weekend = readSessionPreset("race-oval");
    const sessions = (weekend.SessionInfo as { Sessions: Record<string, unknown>[] }).Sessions;

    expect(sessions).toHaveLength(1);

    const sessionInfo = {
      ...weekend,
      SessionInfo: {
        Sessions: [
          { ...sessions[0], SessionNum: 0, SessionType: "Practice" },
          { ...sessions[0], SessionNum: 1 },
        ],
      },
    };
    const inSession = (SessionNum: number): HarnessPreconditionState => ({
      sessionInfo,
      isConnected: true,
      telemetry: { ...BOOT_TELEMETRY, SessionNum } as TelemetryData,
    });

    expect(checkShortcutPreconditions(["rolling-start-oval-grid"], inSession(0))).not.toBeNull();
    expect(checkShortcutPreconditions(["rolling-start-oval-grid"], inSession(1))).toBeNull();
  });
});

describe("POST /api/shortcut/start", () => {
  let app: FastifyInstance;
  let controller: MockSDKController;

  beforeEach(async () => {
    initializeEventBus(silentLogger);
    controller = new MockSDKController();
    app = await createServer({
      controller,
      adapter: {} as unknown as MockPlatformAdapter,
      bus: getEventBus(),
      audio: { setPlaybackObserver: () => {} } as unknown as IAudioService,
      packageRoot: PACKAGE_ROOT,
      logger: silentLogger,
      refreshAudioAssets: async () => {},
      wipeAudioCache: async () => {},
    });
  });

  afterEach(async () => {
    await app.close();
    _resetEventBus();
  });

  async function start(id: string): Promise<{ statusCode: number; error?: string }> {
    const res = await app.inject({ method: "POST", url: "/api/shortcut/start", payload: { id } });

    return {
      statusCode: res.statusCode,
      error: res.statusCode === 204 ? undefined : (res.json() as { error?: string }).error,
    };
  }

  it("refuses a caution shortcut with the reason when no session preset is applied", async () => {
    // Asserted at the ROUTE, not only at the pure check: this is the one call
    // that means "a shortcut is starting", so a check the route forgot to make
    // would leave the button running half-silent exactly as before.
    for (const id of CAUTION_SHORTCUT_IDS) {
      const res = await start(id);

      expect(res.statusCode, `"${id}" was not refused`).toBe(409);
      expect(res.error).toEqual(expect.stringContaining("session preset"));
    }
  });

  it("permits a caution shortcut once the race session preset is applied — the catch-up one once connected too", async () => {
    controller.setSessionInfo(readSessionPreset("race") as unknown as SessionInfo);

    for (const id of CAUTION_SHORTCUT_IDS.filter((caution) => caution !== CATCH_UP_SHORTCUT_ID)) {
      expect((await start(id)).statusCode, `"${id}" was refused`).toBe(204);
    }

    // The right session, still disconnected, as the harness boots: the three
    // older buttons run (their own descriptions ask for the connection), and
    // the catch-up one is refused, because a minute of nothing is what it
    // would otherwise be (#1168).
    const disconnected = await start(CATCH_UP_SHORTCUT_ID);

    expect(disconnected.statusCode).toBe(409);
    expect(disconnected.error).toEqual(expect.stringContaining("Connect the mock SDK"));

    controller.setConnected(true);

    expect((await start(CATCH_UP_SHORTCUT_ID)).statusCode).toBe(204);
  });

  it("refuses an overtake or gap shortcut with the reason while the mock SDK is disconnected (#1349)", async () => {
    // The harness boots disconnected, so this is the first press of the day.
    for (const id of GATED_SHORTCUT_IDS) {
      const res = await start(id);

      expect(res.statusCode, `"${id}" was not refused`).toBe(409);
      expect(res.error).toEqual(expect.stringContaining("Connect the mock SDK"));
    }
  });

  it("permits an overtake or gap shortcut once the mock SDK is connected", async () => {
    controller.setConnected(true);

    for (const id of GATED_SHORTCUT_IDS) {
      expect((await start(id)).statusCode, `"${id}" was refused`).toBe(204);
    }
  });

  it("refuses the rolling-start shortcuts as the harness boots, then on the wrong session, then lets them run (#1167)", async () => {
    const all = [FORMATION_SHORTCUT_ID, ...FORMATION_CALL_SHORTCUT_IDS];

    // No session preset, disconnected: the session is asked for first.
    for (const id of all) {
      const res = await start(id);

      expect(res.statusCode, `"${id}" was not refused`).toBe(409);
      expect(res.error).toEqual(expect.stringContaining("session preset"));
    }

    // The right session, still disconnected.
    controller.setSessionInfo(readSessionPreset("race-oval") as unknown as SessionInfo);

    for (const id of all) {
      const res = await start(id);

      expect(res.statusCode, `"${id}" was not refused`).toBe(409);
      expect(res.error).toEqual(expect.stringContaining("Connect the mock SDK"));
    }

    controller.setConnected(true);

    for (const id of all) expect((await start(id)).statusCode, `"${id}" was refused`).toBe(204);

    // A road course: the calls run, the whole formation is refused by name.
    controller.setSessionInfo(readSessionPreset("race") as unknown as SessionInfo);

    for (const id of FORMATION_CALL_SHORTCUT_IDS) {
      expect((await start(id)).statusCode, `"${id}" was refused`).toBe(204);
    }

    const onRoad = await start(FORMATION_SHORTCUT_ID);

    expect(onRoad.statusCode).toBe(409);
    expect(onRoad.error).toContain("race-oval");
  });

  it("hands the rolling-start check the session the mock is in (#1167)", async () => {
    // The route passes the mock's live telemetry, so a session number patched
    // through `/api/telemetry` decides which entry of the session list is read.
    const weekend = readSessionPreset("race-oval");
    const sessions = (weekend.SessionInfo as { Sessions: Record<string, unknown>[] }).Sessions;

    controller.setSessionInfo({
      ...weekend,
      SessionInfo: {
        Sessions: [
          { ...sessions[0], SessionNum: 0, SessionType: "Practice" },
          { ...sessions[0], SessionNum: 1 },
        ],
      },
    } as unknown as SessionInfo);
    controller.setConnected(true);

    expect((await start(FORMATION_SHORTCUT_ID)).statusCode).toBe(409);

    controller.mutateTelemetry({ SessionNum: 1 });

    expect((await start(FORMATION_SHORTCUT_ID)).statusCode).toBe(204);
  });

  it("permits an ordinary shortcut with nothing set up at all", async () => {
    const plain = SCENARIO_SHORTCUTS.find((s) => s.requires === undefined);

    expect(plain).toBeDefined();
    expect((await start(plain?.id ?? "")).statusCode).toBe(204);
  });

  it("rejects an unknown id rather than silently permitting it", async () => {
    const res = await start("no-such-shortcut");

    expect(res.statusCode).toBe(400);
    expect(res.error).toContain("no-such-shortcut");
  });
});
