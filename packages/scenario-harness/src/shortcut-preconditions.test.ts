import type { IAudioService } from "@iracedeck/audio-service";
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import type { SessionInfo } from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MockPlatformAdapter } from "./mock-platform-adapter.js";
import { MockSDKController } from "./mock-sdk-controller.js";
import { SCENARIO_SHORTCUTS } from "./scenario-shortcuts.js";
import { createServer } from "./server.js";
import { checkShortcutPreconditions, type ShortcutPrecondition } from "./shortcut-preconditions.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The ids that must refuse to run without a session preset (issue #1127). */
const CAUTION_SHORTCUT_IDS = ["flag-caution-restart", "flag-caution-lineup-change", "flag-caution-extra-lap"];

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
      const refusal = checkShortcutPreconditions(requiresOf(id), null);

      expect(refusal, `"${id}" ran with no session info`).toEqual(expect.stringContaining("session preset"));
    }
  });

  it("permits a caution shortcut once a session preset naming the player's car is applied", () => {
    for (const id of CAUTION_SHORTCUT_IDS) {
      expect(checkShortcutPreconditions(requiresOf(id), readSessionPreset("race")), `"${id}" on race`).toBeNull();
      expect(
        checkShortcutPreconditions(requiresOf(id), readSessionPreset("race-oval")),
        `"${id}" on race-oval`,
      ).toBeNull();
    }
  });

  it("reads the player's car index exactly as the lineup resolver does", () => {
    // Mirrors `resolvePlayerCarIdx` in `diff/caution-lineup.ts`: a value that
    // resolver rejects has to be refused here too, or the run proceeds into
    // the half-silent case anyway.
    const permitted = [{ DriverInfo: { DriverCarIdx: 0 } }, { DriverInfo: { DriverCarIdx: 7 } }];
    const refused = [
      {},
      { DriverInfo: {} },
      { DriverInfo: { DriverCarIdx: -1 } },
      { DriverInfo: { DriverCarIdx: 1.5 } },
      { DriverInfo: { DriverCarIdx: "7" } },
    ];

    for (const sessionInfo of permitted) {
      expect(checkShortcutPreconditions(["player-car-index"], sessionInfo), JSON.stringify(sessionInfo)).toBeNull();
    }

    for (const sessionInfo of refused) {
      expect(checkShortcutPreconditions(["player-car-index"], sessionInfo), JSON.stringify(sessionInfo)).not.toBeNull();
    }
  });

  it("permits a shortcut that declares no preconditions, whatever the harness holds", () => {
    // The ~dozen shortcuts that set up everything they need are untouched by
    // this: no `requires`, no refusal, not even with an empty harness.
    const plain = SCENARIO_SHORTCUTS.filter((s) => s.requires === undefined);

    expect(plain.length).toBeGreaterThan(0);

    for (const shortcut of plain) {
      expect(checkShortcutPreconditions(shortcut.requires, null), `"${shortcut.id}"`).toBeNull();
    }
  });

  it("names both what is missing and how to fix it", () => {
    // The message is the whole point — it is shown verbatim to a tester who
    // would otherwise be listening for audio that was never going to play.
    const refusal = checkShortcutPreconditions(["player-car-index"], null) ?? "";

    expect(refusal).toContain("DriverInfo.DriverCarIdx");
    expect(refusal).toContain("race");
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
