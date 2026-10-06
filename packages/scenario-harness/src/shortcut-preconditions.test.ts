import type { IAudioService } from "@iracedeck/audio-service";
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import type { SessionInfo } from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import { resolvePlayerCarIdx } from "@iracedeck/sim-events-iracing";
import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
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

// A pass-through spy on the translator's own reader (issue #1127 review): the
// precondition must ASK it rather than restate its rule, and only a spy can
// tell the two apart — a restatement answers every table below identically.
vi.mock("@iracedeck/sim-events-iracing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/sim-events-iracing")>();

  return { ...actual, resolvePlayerCarIdx: vi.fn(actual.resolvePlayerCarIdx) };
});

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The ids that must refuse to run without a session preset (issue #1127). */
const CAUTION_SHORTCUT_IDS = ["flag-caution-restart", "flag-caution-lineup-change", "flag-caution-extra-lap"];

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
  return { sessionInfo, isConnected: true };
}

/** The harness as it boots: no session preset, mock SDK disconnected. */
const AT_BOOT: HarnessPreconditionState = { sessionInfo: null, isConnected: false };

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
    // `resolveCautionLineup` cannot read `DriverInfo.DriverCarIdx`.
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
    // translator's `diff/caution-lineup.ts`. A copy of its rule here would drift
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

  it("permits a caution shortcut once the race session preset is applied", async () => {
    controller.setSessionInfo(readSessionPreset("race") as unknown as SessionInfo);

    for (const id of CAUTION_SHORTCUT_IDS) {
      expect((await start(id)).statusCode, `"${id}" was refused`).toBe(204);
    }
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
