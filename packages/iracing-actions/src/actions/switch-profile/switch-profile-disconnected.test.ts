/**
 * Switch Profile and the disconnected look (#1599): switching a deck profile
 * works with iRacing closed, so no Switch Profile key needs the sim.
 *
 * Runs over the REAL deck-core — `BaseAction`'s image funnel, the real
 * `ConnectionStateAwareAction` and the real sim-presence signal — so the
 * decision is the one a deck sees. The canonical action-test mock of
 * deck-core in `switch-profile.test.ts` replaces `ConnectionStateAwareAction`
 * with a stub that has no funnel, no presence and no `showsDisconnected`, so
 * these tests cannot live there.
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

import { SwitchProfile } from "./switch-profile.js";

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
    deviceId: "device-1",
    deviceType: 0,
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
class TestSwitchProfile extends SwitchProfile {
  needsSimFor(settings: unknown): boolean {
    return this.needsSim(settings);
  }
}

/**
 * POSITIVE CONTROL ONLY: the same action with the base class's answer (every
 * key needs the sim), to prove the harness below would show the look.
 */
class SimNeedingSwitchProfile extends SwitchProfile {
  protected override needsSim(): boolean {
    return true;
  }
}

function lastImage(action: KeyAction): string {
  const image = action.setImage.mock.lastCall?.[0];

  if (typeof image !== "string") throw new Error(`no image sent to ${action.id}`);

  return image;
}

describe("Switch Profile and the disconnected look (#1599)", () => {
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

  it.each([
    ["no settings", undefined],
    ["empty settings", {}],
    ["the default profile", { profile: "default" }],
    ["Back to Previous", { profile: "previous" }],
    ["a host profile marker", { profile: "race", hostProfile: "race" }],
    ["garbage", { profile: 42 }],
  ])("needsSim is false for %s", (_label, settings) => {
    expect(new TestSwitchProfile().needsSimFor(settings)).toBe(false);
  });

  describe("the look on the key image", () => {
    async function shownKey(action: SwitchProfile, contextId: string): Promise<{ key: KeyAction; drawn: string }> {
      const key = keyAction(contextId);

      await action.onWillAppear({ action: key, payload: { settings: { profile: "race" } } } as never);

      return { key, drawn: lastImage(key) };
    }

    /** The sim's ticks go disconnected and stay so past the absent delay. */
    function simGone(): void {
      sim.tick();
      vi.advanceTimersByTime(ABSENT_DELAY_MS);
    }

    it("leaves a Switch Profile key undecorated while the sim is absent", async () => {
      const { key, drawn } = await shownKey(new SwitchProfile(), "ctx-1");

      simGone();

      expect(isSimAbsent()).toBe(true);
      expect(lastImage(key)).toBe(drawn);
    });

    it("POSITIVE CONTROL: the same key with the base class's answer is decorated", async () => {
      const { key, drawn } = await shownKey(new SimNeedingSwitchProfile(), "ctx-1");

      expect(applyDisconnectedLook(drawn)).not.toBe(drawn);

      simGone();

      expect(lastImage(key)).toBe(applyDisconnectedLook(drawn));
    });
  });
});
