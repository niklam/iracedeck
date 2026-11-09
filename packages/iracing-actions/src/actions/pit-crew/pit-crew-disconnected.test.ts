/**
 * Pit Crew and the disconnected look (#1599): every mode changes one of the
 * plugin's own settings, so no Pit Crew key needs the sim.
 *
 * Runs over the REAL deck-core — `BaseAction`'s image funnel, the real
 * `ConnectionStateAwareAction` and the real sim-presence signal — so the
 * decision is the one a deck sees. The canonical action-test mock of
 * deck-core in `pit-crew.test.ts` replaces `ConnectionStateAwareAction` with a
 * stub that has no funnel, no presence and no `showsDisconnected`, so these
 * tests cannot live there. The audio layer is mocked: these tests are about
 * the image, not the buses.
 */
import {
  _resetBindingDispatcher,
  _resetSimConnection,
  initializeBindingDispatcher,
  initializeSimConnection,
  isSimAbsent,
  type SimConnection,
} from "@iracedeck/deck-core";
import { applyDisconnectedLook } from "@iracedeck/icon-composer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PitCrew } from "./pit-crew.js";

const ABSENT_DELAY_MS = 1000;

const { mockGetGlobalSettings } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn((): Record<string, unknown> => ({ showDisconnectedState: true })),
}));

vi.mock("@iracedeck/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/settings")>()),
  getGlobalSettings: mockGetGlobalSettings,
  getGlobalColors: () => ({}),
  isCalloutEnabled: () => true,
  onGlobalSettingsChange: vi.fn(() => () => {}),
}));

vi.mock("@iracedeck/audio-scenarios/pit-crew", () => ({
  driverNameClipPath: vi.fn(() => "voice/x/names/x.mp3"),
  isBackgroundTestInFlight: vi.fn(() => false),
  playBackgroundTest: vi.fn(),
  playRadarTest: vi.fn(),
  setRadarEnabled: vi.fn(),
  stopRaceEngineerScenarios: vi.fn(),
}));

vi.mock("../../audio/audio-volume.js", () => ({
  applyRaceEngineerAudio: vi.fn(),
  applyRadarVolume: vi.fn(),
  isRaceEngineerEnabled: () => true,
  isRadarEnabled: () => true,
  readRadarVolume: () => 50,
  setRaceEngineerTestInFlight: vi.fn(),
  setRaceEngineerToggleInFlight: vi.fn(),
  stepRadarVolume: vi.fn(() => 50),
}));

vi.mock("../../audio/audio-toggles.js", () => ({
  isCornerNamesEnabled: () => true,
  playVoiceSequence: vi.fn(),
  readJsonStringArray: () => [],
  toggleCornerNamesFeature: vi.fn(),
}));

vi.mock("../../audio/feature-gates.js", () => ({
  toggleRaceEngineerFeature: vi.fn(),
  toggleRadarFeature: vi.fn(),
}));

/** A sim connection whose ticks the test sends: disconnected from the start. */
function createDisconnectedSim(): { connection: SimConnection; tick: () => void } {
  const subscribers = new Map<string, (isConnected: boolean) => void>();

  return {
    connection: {
      isConnected: () => false,
      subscribe: (id, onTick) => {
        subscribers.set(id, onTick);
      },
      unsubscribe: (id) => {
        subscribers.delete(id);
      },
      activeFlags: () => [],
      resolveTitleTemplate: (text) => text,
    },
    tick: () => {
      for (const onTick of [...subscribers.values()]) onTick(false);
    },
  };
}

function keyAction(id: string) {
  return {
    id,
    isDial: () => false,
    isKey: () => true,
    dialCanvas: () => null,
    setTitle: vi.fn().mockResolvedValue(undefined),
    setImage: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
  };
}

type KeyAction = ReturnType<typeof keyAction>;

/**
 * The action with the SDK controller it reads for its radio check replaced:
 * the real one needs an initialised SDK, and only the subscribe calls run here.
 */
class TestPitCrew extends PitCrew {
  protected override get sdkController() {
    return {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getConnectionStatus: () => false,
    } as unknown as PitCrew["sdkController"];
  }

  needsSimFor(settings: unknown): boolean {
    return this.needsSim(settings);
  }
}

/**
 * POSITIVE CONTROL ONLY: the same action with the base class's answer (every
 * key needs the sim), to prove the harness below would show the look.
 */
class SimNeedingPitCrew extends TestPitCrew {
  protected override needsSim(): boolean {
    return true;
  }
}

function lastImage(action: KeyAction): string {
  const image = action.setImage.mock.lastCall?.[0];

  if (typeof image !== "string") throw new Error(`no image sent to ${action.id}`);

  return image;
}

const MODES = [
  { mode: "race-engineer" },
  { mode: "radar" },
  { mode: "radar-volume", direction: "up" },
  { mode: "radar-volume", direction: "down" },
  { mode: "corner-names" },
] as const;

describe("Pit Crew and the disconnected look (#1599)", () => {
  let sim: ReturnType<typeof createDisconnectedSim>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockGetGlobalSettings.mockReturnValue({ showDisconnectedState: true });
    _resetSimConnection();
    _resetBindingDispatcher();
    initializeBindingDispatcher();
    sim = createDisconnectedSim();
    initializeSimConnection(sim.connection, { absentDelayMs: ABSENT_DELAY_MS });
  });

  afterEach(() => {
    _resetSimConnection();
    _resetBindingDispatcher();
    vi.useRealTimers();
  });

  describe("needsSim", () => {
    it.each(MODES)("is false for %o", (settings) => {
      expect(new TestPitCrew().needsSimFor(settings)).toBe(false);
    });

    it.each([
      ["no settings", undefined],
      ["empty settings (the Race Engineer default)", {}],
      ["garbage", { mode: "nonsense" }],
    ])("is false for %s", (_label, settings) => {
      expect(new TestPitCrew().needsSimFor(settings)).toBe(false);
    });
  });

  describe("the look on the key image", () => {
    async function shownKey(
      action: PitCrew,
      contextId: string,
      settings: Record<string, unknown>,
    ): Promise<{ key: KeyAction; drawn: string }> {
      const key = keyAction(contextId);

      await action.onWillAppear({ action: key, payload: { settings } } as never);

      return { key, drawn: lastImage(key) };
    }

    /** The sim's ticks go disconnected and stay so past the absent delay. */
    function simGone(): void {
      sim.tick();
      vi.advanceTimersByTime(ABSENT_DELAY_MS);
    }

    it("leaves a key of every mode undecorated while the sim is absent", async () => {
      const action = new TestPitCrew();
      const keys = await Promise.all(MODES.map((settings, i) => shownKey(action, `ctx-${i}`, { ...settings })));

      simGone();

      expect(isSimAbsent()).toBe(true);

      for (const { key, drawn } of keys) expect(lastImage(key)).toBe(drawn);
    });

    it("POSITIVE CONTROL: the same key with the base class's answer is decorated", async () => {
      const { key, drawn } = await shownKey(new SimNeedingPitCrew(), "ctx-1", { mode: "radar" });

      expect(applyDisconnectedLook(drawn)).not.toBe(drawn);

      simGone();

      expect(lastImage(key)).toBe(applyDisconnectedLook(drawn));
    });
  });
});
