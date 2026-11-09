/**
 * Audio Controls and the disconnected look (#1599): which keys need the sim,
 * category by category, and the look reaching each key image on its own.
 *
 * Runs over the REAL deck-core — `BaseAction`'s image funnel, the real
 * `ConnectionStateAwareAction` and the real sim-presence signal — with real
 * zod settings, so the per-key decision is the one a deck sees. The canonical
 * action-test mock of deck-core replaces `ConnectionStateAwareAction` with a
 * stub that has no funnel, no presence and no `showsDisconnected`, so this
 * cannot live in `audio-controls.test.ts`. Presence arrives the way it does in
 * the plugin: the keys appear, the sim's ticks go disconnected, and the look
 * turns on once the absent delay has passed.
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

import { AudioControls } from "./audio-controls.js";

const ABSENT_DELAY_MS = 1000;

const { mockGetGlobalSettings } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn((): Record<string, unknown> => ({ showDisconnectedState: true })),
}));

vi.mock("@iracedeck/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/settings")>()),
  getGlobalSettings: mockGetGlobalSettings,
  getGlobalColors: () => ({}),
  onGlobalSettingsChange: vi.fn(() => () => {}),
}));

vi.mock("../../audio/audio-volume.js", () => ({
  stepRaceEngineerVolumeBy: vi.fn(() => 50),
  stepRadarVolumeBy: vi.fn(() => 50),
  readRaceEngineerVolume: () => 50,
  readRadarVolume: () => 50,
  isRaceEngineerEnabled: () => true,
  isRadarEnabled: () => true,
}));

vi.mock("../../audio/feature-gates.js", () => ({
  toggleRaceEngineerFeature: vi.fn(),
  toggleRadarFeature: vi.fn(),
}));

vi.mock("../../audio/volume-tick.js", () => ({ tickIRacingVolumeStep: vi.fn() }));

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

/** Lets the action's protected hook be called from the test. */
class TestAudioControls extends AudioControls {
  needsSimFor(settings: unknown): boolean {
    return this.needsSim(settings);
  }
}

function lastImage(action: KeyAction): string {
  const image = action.setImage.mock.lastCall?.[0];

  if (typeof image !== "string") throw new Error(`no image sent to ${action.id}`);

  return image;
}

describe("Audio Controls and the disconnected look (#1599)", () => {
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
    const action = new TestAudioControls();

    it.each([
      ["race-engineer", false],
      ["radar", false],
      ["push-to-talk", true],
      ["voice-chat", true],
      ["master", true],
    ])("the %s category needs the sim: %s", (category, expected) => {
      expect(action.needsSimFor({ category, action: "volume-up" })).toBe(expected);
    });

    it("answers by category whatever the keypad action", () => {
      expect(action.needsSimFor({ category: "radar", action: "mute" })).toBe(false);
      expect(action.needsSimFor({ category: "master", action: "mute" })).toBe(true);
      expect(action.needsSimFor({ category: "voice-chat", action: "mute-driver" })).toBe(true);
    });

    it("answers for the schema default, Push to Talk, when the key has no settings yet", () => {
      expect(action.needsSimFor({})).toBe(true);
      expect(action.needsSimFor(undefined)).toBe(true);
    });

    it("answers for the category the key draws, never throwing, on garbage settings", () => {
      // An unknown category is caught to Push to Talk, as the key draws it.
      expect(action.needsSimFor({ category: "nonsense" })).toBe(true);
      expect(action.needsSimFor(null)).toBe(true);
      expect(action.needsSimFor("radar")).toBe(true);
      expect(action.needsSimFor(42)).toBe(true);
    });

    it("reads the keypad category from a dial's payload without throwing", () => {
      // A dial stores its own category under `dial`; the keypad one decides.
      expect(action.needsSimFor({ dial: { category: "radar", pressAction: "mute-unmute" } })).toBe(true);
      expect(action.needsSimFor({ category: "radar", dial: { category: "master", pressAction: "none" } })).toBe(false);
      // The #1015 legacy dial shape goes through the same migration the key's parse does.
      expect(
        action.needsSimFor({ category: "race-engineer", dial: { category: "spotter", pressAction: "mute-unmute" } }),
      ).toBe(false);
    });
  });

  describe("the look on the key image", () => {
    /** Shows a key on `action` with `settings`; returns its context and the image it drew undecorated. */
    async function shownKey(
      action: AudioControls,
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

    it("the look changes the image, so the assertions below can tell the two states apart", async () => {
      const { drawn } = await shownKey(new AudioControls(), "ctx-master", { category: "master" });

      expect(applyDisconnectedLook(drawn)).not.toBe(drawn);
    });

    it("decorates only the Master key of two keys of one instance, Radar and Master, while the sim is absent", async () => {
      const action = new AudioControls();
      const radar = await shownKey(action, "ctx-radar", { category: "radar", action: "volume-up" });
      const master = await shownKey(action, "ctx-master", { category: "master", action: "volume-up" });

      simGone();

      expect(isSimAbsent()).toBe(true);
      expect(lastImage(master.key)).toBe(applyDisconnectedLook(master.drawn));
      expect(lastImage(radar.key)).toBe(radar.drawn);
    });

    it("decorates neither key while the setting is off", async () => {
      mockGetGlobalSettings.mockReturnValue({ showDisconnectedState: false });
      const action = new AudioControls();
      const radar = await shownKey(action, "ctx-radar", { category: "radar", action: "volume-up" });
      const master = await shownKey(action, "ctx-master", { category: "master", action: "volume-up" });

      simGone();

      expect(isSimAbsent()).toBe(true);
      expect(lastImage(master.key)).toBe(master.drawn);
      expect(lastImage(radar.key)).toBe(radar.drawn);
    });

    it("draws a Race Engineer key that appears while the sim is absent without the look, and a Voice Chat key with it", async () => {
      const action = new AudioControls();
      await shownKey(action, "ctx-first", { category: "master", action: "volume-up" });
      simGone();

      const engineer = keyAction("ctx-engineer");
      await action.onWillAppear({
        action: engineer,
        payload: { settings: { category: "race-engineer", action: "volume-down" } },
      } as never);
      const voice = keyAction("ctx-voice");
      await action.onWillAppear({
        action: voice,
        payload: { settings: { category: "voice-chat", action: "mute" } },
      } as never);

      expect(lastImage(voice)).toBe(
        applyDisconnectedLook(await undecorated({ category: "voice-chat", action: "mute" })),
      );
      expect(lastImage(engineer)).toBe(await undecorated({ category: "race-engineer", action: "volume-down" }));
    });
  });
});

/** The image a key with `settings` draws with the setting off: the funnel then sends it undecorated. */
async function undecorated(settings: Record<string, unknown>): Promise<string> {
  const key = keyAction(`ctx-plain-${String(settings.category)}`);

  mockGetGlobalSettings.mockReturnValue({ showDisconnectedState: false });

  try {
    await new AudioControls().onWillAppear({ action: key, payload: { settings } } as never);
  } finally {
    mockGetGlobalSettings.mockReturnValue({ showDisconnectedState: true });
  }

  return lastImage(key);
}
