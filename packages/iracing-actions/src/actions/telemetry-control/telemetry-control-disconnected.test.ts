/**
 * Telemetry Control and the disconnected look (#1599): Capture CPU Profile
 * records the plugin's own CPU profile and needs no sim; every other mode
 * does.
 *
 * Runs over the REAL deck-core — `BaseAction`'s image funnel, the real
 * `ConnectionStateAwareAction` and the real sim-presence signal — with real
 * zod settings, so the per-key decision is the one a deck sees. The canonical
 * action-test mock of deck-core in `telemetry-control.test.ts` replaces
 * `ConnectionStateAwareAction` with a stub that has no funnel, no presence and
 * no `showsDisconnected`, so these tests cannot live there.
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

import { TelemetryControl } from "./telemetry-control.js";

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
class TestTelemetryControl extends TelemetryControl {
  needsSimFor(settings: unknown): boolean {
    return this.needsSim(settings);
  }
}

function lastImage(action: KeyAction): string {
  const image = action.setImage.mock.lastCall?.[0];

  if (typeof image !== "string") throw new Error(`no image sent to ${action.id}`);

  return image;
}

describe("Telemetry Control and the disconnected look (#1599)", () => {
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
    const action = new TestTelemetryControl();

    it.each([
      ["toggle-logging", true],
      ["mark-event", true],
      ["start-recording", true],
      ["stop-recording", true],
      ["restart-recording", true],
      ["snapshot", true],
      ["capture-profile", false],
    ])("the %s mode needs the sim: %s", (mode, expected) => {
      expect(action.needsSimFor({ mode })).toBe(expected);
    });

    it("answers for the schema default, Toggle Logging, when the key has no settings yet", () => {
      expect(action.needsSimFor({})).toBe(true);
      expect(action.needsSimFor(undefined)).toBe(true);
    });

    it("answers for the mode the key draws, never throwing, on garbage settings", () => {
      // An unknown mode fails the parse, and the key draws the defaults.
      expect(action.needsSimFor({ mode: "nonsense" })).toBe(true);
      expect(action.needsSimFor(null)).toBe(true);
      expect(action.needsSimFor("capture-profile")).toBe(true);
    });

    it("reads a legacy `action` payload through the same migration the key's parse does", () => {
      expect(action.needsSimFor({ action: "capture-profile" })).toBe(false);
      expect(action.needsSimFor({ action: "mark-event" })).toBe(true);
    });
  });

  describe("the look on the key image", () => {
    /** Shows a key on `action` with `settings`; returns its context and the image it drew undecorated. */
    async function shownKey(
      action: TelemetryControl,
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

    it("leaves the Capture CPU Profile key undecorated and decorates a Start Recording key while the sim is absent", async () => {
      const action = new TelemetryControl();
      const capture = await shownKey(action, "ctx-capture", { mode: "capture-profile" });
      const recording = await shownKey(action, "ctx-recording", { mode: "start-recording" });

      expect(applyDisconnectedLook(recording.drawn)).not.toBe(recording.drawn);

      simGone();

      expect(isSimAbsent()).toBe(true);
      expect(lastImage(recording.key)).toBe(applyDisconnectedLook(recording.drawn));
      expect(lastImage(capture.key)).toBe(capture.drawn);
    });
  });
});
