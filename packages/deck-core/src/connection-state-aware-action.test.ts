/**
 * ConnectionStateAwareAction over a mocked BaseAction: the binding delegates,
 * the per-key "needs the sim" decision behind the disconnected look, and the
 * sim-presence listener's lifetime (#1599). The look reaching the key image
 * through the real BaseAction is `connection-state-aware-action.real-base.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BaseAction } from "./base-action.js";
import { ConnectionStateAwareAction } from "./connection-state-aware-action.js";
import { createFakeSimConnection, type FakeSimConnection } from "./fake-sim-connection.test-support.js";
import { _resetSimConnection, initializeSimConnection } from "./sim-connection.js";

// The real sim-connection singleton, initialised with a fake per test, so the
// pre-initialisation queue and its replay are exercised as they run in the plugin.
const sim: { fake: FakeSimConnection | null } = { fake: null };

const {
  mockTap,
  mockHold,
  mockRelease,
  mockIsConfigured,
  mockIsKeyboardBound,
  mockGetGlobalSettings,
  mockIsSimAbsent,
  mockOnSimPresenceChange,
  presenceListeners,
} = vi.hoisted(() => {
  const presenceListeners = new Set<(absent: boolean) => void>();

  return {
    mockTap: vi.fn().mockResolvedValue(true),
    mockHold: vi.fn().mockResolvedValue(undefined),
    mockRelease: vi.fn().mockResolvedValue(undefined),
    mockIsConfigured: vi.fn((_key: string) => true),
    mockIsKeyboardBound: vi.fn((_key: string) => true),
    mockGetGlobalSettings: vi.fn((): Record<string, unknown> => ({ showDisconnectedState: true })),
    mockIsSimAbsent: vi.fn(() => false),
    mockOnSimPresenceChange: vi.fn((listener: (absent: boolean) => void) => {
      presenceListeners.add(listener);

      return () => {
        presenceListeners.delete(listener);
      };
    }),
    presenceListeners,
  };
});

vi.mock("./binding-dispatcher.js", () => ({
  getBindingDispatcher: () => ({
    tap: mockTap,
    hold: mockHold,
    release: mockRelease,
    isConfigured: mockIsConfigured,
    isKeyboardBound: mockIsKeyboardBound,
  }),
}));

vi.mock("./base-action.js", () => ({
  BaseAction: class MockBaseAction {
    logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    /** Settings per context, as the real BaseAction keeps them. */
    readonly settingsByContext = new Map<string, unknown>();

    refreshAllImages = vi.fn();

    getContextSettings(contextId: string): unknown {
      return this.settingsByContext.get(contextId);
    }

    showsDisconnected(): boolean {
      return false;
    }

    async onWillAppear() {}
    async onWillDisappear() {}
    async onDidReceiveSettings() {}
  },
}));

// The real singleton for the connection; the presence signal is replaced so a
// test sets the value and fires the change itself.
vi.mock("./sim-connection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sim-connection.js")>()),
  isSimAbsent: mockIsSimAbsent,
  onSimPresenceChange: mockOnSimPresenceChange,
}));

vi.mock("@iracedeck/settings", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;

  return {
    ...original,
    getGlobalSettings: mockGetGlobalSettings,
    onGlobalSettingsChange: vi.fn(() => vi.fn()),
  };
});

/** An action whose mode `"local"` needs no sim (like Pit Crew or Audio Controls' Radar category). */
class TestAction extends ConnectionStateAwareAction {
  readonly needsSimCalls: unknown[] = [];

  protected override needsSim(settings: unknown): boolean {
    this.needsSimCalls.push(settings);

    return (settings as { mode?: string } | undefined)?.mode !== "local";
  }

  setContextSettings(contextId: string, settings: unknown): void {
    (this as unknown as { settingsByContext: Map<string, unknown> }).settingsByContext.set(contextId, settings);
  }

  callShowsDisconnected(contextId: string): boolean {
    return this.showsDisconnected(contextId);
  }

  callUpdateConnectionState(): void {
    this.updateConnectionState();
  }

  callSetActiveBinding(key: string | string[] | null): void {
    this.setActiveBinding(key);
  }

  callGetConnectionStatus(): boolean {
    return this.getConnectionStatus();
  }

  async callTapBinding(key: string): Promise<boolean> {
    return this.tapBinding(key);
  }

  async callHoldBinding(actionId: string, key: string): Promise<void> {
    return this.holdBinding(actionId, key);
  }

  async callReleaseBinding(actionId: string): Promise<void> {
    return this.releaseBinding(actionId);
  }

  callIsBindingMissing(keys: string | string[] | null | undefined): boolean {
    return this.isBindingMissing(keys);
  }

  callIsBindingKeyboardBound(key: string): boolean {
    return this.isBindingKeyboardBound(key);
  }
}

/** The default hook, unchanged. */
class DefaultAction extends ConnectionStateAwareAction {
  callNeedsSim(settings: unknown): boolean {
    return this.needsSim(settings);
  }
}

function getRefreshAllImages(action: ConnectionStateAwareAction): ReturnType<typeof vi.fn> {
  return (action as unknown as { refreshAllImages: ReturnType<typeof vi.fn> }).refreshAllImages;
}

function contextEvent(id: string) {
  return {
    action: { id, setTitle: vi.fn(), setImage: vi.fn(), isKey: vi.fn().mockReturnValue(true) },
    payload: { settings: {} },
  } as never;
}

describe("ConnectionStateAwareAction", () => {
  let action: TestAction;

  beforeEach(() => {
    vi.clearAllMocks();
    presenceListeners.clear();
    mockGetGlobalSettings.mockReturnValue({ showDisconnectedState: true });
    mockIsSimAbsent.mockReturnValue(false);
    _resetSimConnection();
    sim.fake = createFakeSimConnection();
    initializeSimConnection(sim.fake.connection);
    action = new TestAction();
  });

  // --- The disconnected look (#1599) ---

  describe("needsSim", () => {
    it("is true by default, whatever the settings", () => {
      const defaultAction = new DefaultAction();

      expect(defaultAction.callNeedsSim(undefined)).toBe(true);
      expect(defaultAction.callNeedsSim({ mode: "local" })).toBe(true);
    });
  });

  describe("showsDisconnected", () => {
    it("is true when the setting is on, the sim is absent and the key's mode needs the sim", () => {
      mockIsSimAbsent.mockReturnValue(true);
      action.setContextSettings("ctx-1", { mode: "sim" });

      expect(action.callShowsDisconnected("ctx-1")).toBe(true);
    });

    it("is false while the sim is present", () => {
      action.setContextSettings("ctx-1", { mode: "sim" });

      expect(action.callShowsDisconnected("ctx-1")).toBe(false);
    });

    it.each([{ showDisconnectedState: false }, {}])("is false with the setting off (%o)", (globals) => {
      mockGetGlobalSettings.mockReturnValue(globals);
      mockIsSimAbsent.mockReturnValue(true);
      action.setContextSettings("ctx-1", { mode: "sim" });

      expect(action.callShowsDisconnected("ctx-1")).toBe(false);
    });

    it("is false for a key whose mode needs no sim", () => {
      mockIsSimAbsent.mockReturnValue(true);
      action.setContextSettings("ctx-1", { mode: "local" });

      expect(action.callShowsDisconnected("ctx-1")).toBe(false);
    });

    it("hands needsSim the raw settings of the context being drawn, not another key's", () => {
      mockIsSimAbsent.mockReturnValue(true);
      const simMode = { mode: "sim" };
      const localMode = { mode: "local" };
      action.setContextSettings("ctx-sim", simMode);
      action.setContextSettings("ctx-local", localMode);

      expect([action.callShowsDisconnected("ctx-sim"), action.callShowsDisconnected("ctx-local")]).toEqual([
        true,
        false,
      ]);
      expect(action.needsSimCalls).toEqual([simMode, localMode]);
    });
  });

  describe("the sim-presence listener", () => {
    it("is added when the first context appears, once for the action", async () => {
      expect(mockOnSimPresenceChange).not.toHaveBeenCalled();

      await action.onWillAppear(contextEvent("ctx-1"));
      await action.onWillAppear(contextEvent("ctx-2"));

      expect(mockOnSimPresenceChange).toHaveBeenCalledOnce();
      expect(presenceListeners.size).toBe(1);
    });

    it("pushes every live key's image again on a presence change", async () => {
      await action.onWillAppear(contextEvent("ctx-1"));

      for (const listener of presenceListeners) listener(true);

      expect(getRefreshAllImages(action)).toHaveBeenCalledOnce();
    });

    it("stays while another context is live, so one key leaving never stops the other's updates", async () => {
      await action.onWillAppear(contextEvent("ctx-1"));
      await action.onWillAppear(contextEvent("ctx-2"));

      await action.onWillDisappear(contextEvent("ctx-1"));

      expect(presenceListeners.size).toBe(1);

      for (const listener of presenceListeners) listener(true);

      expect(getRefreshAllImages(action)).toHaveBeenCalledOnce();
    });

    it("is removed when the last context disappears", async () => {
      await action.onWillAppear(contextEvent("ctx-1"));
      await action.onWillAppear(contextEvent("ctx-2"));

      await action.onWillDisappear(contextEvent("ctx-2"));
      await action.onWillDisappear(contextEvent("ctx-1"));

      expect(presenceListeners.size).toBe(0);
    });

    it("is added again when a context appears after the last one left", async () => {
      await action.onWillAppear(contextEvent("ctx-1"));
      await action.onWillDisappear(contextEvent("ctx-1"));
      await action.onWillAppear(contextEvent("ctx-1"));

      expect(mockOnSimPresenceChange).toHaveBeenCalledTimes(2);
      expect(presenceListeners.size).toBe(1);
    });

    it("belongs to its action: another action's last key leaving does not remove it", async () => {
      const other = new TestAction();
      await action.onWillAppear(contextEvent("ctx-1"));
      await other.onWillAppear(contextEvent("ctx-2"));

      await other.onWillDisappear(contextEvent("ctx-2"));

      expect(presenceListeners.size).toBe(1);

      for (const listener of presenceListeners) listener(false);

      expect(getRefreshAllImages(action)).toHaveBeenCalledOnce();
      expect(getRefreshAllImages(other)).not.toHaveBeenCalled();
    });

    it("subscribes nothing to the sim connection per context: there is no per-tick evaluation", async () => {
      await action.onWillAppear(contextEvent("ctx-1"));

      expect(sim.fake!.subscribers.size).toBe(0);
    });
  });

  describe("deprecated shims", () => {
    it("setActiveBinding and updateConnectionState do nothing", async () => {
      await action.onWillAppear(contextEvent("ctx-1"));
      vi.clearAllMocks();

      action.callSetActiveBinding("someKey");
      action.callSetActiveBinding(["a", "b"]);
      action.callSetActiveBinding(null);
      action.callUpdateConnectionState();

      expect(getRefreshAllImages(action)).not.toHaveBeenCalled();
      expect(mockIsConfigured).not.toHaveBeenCalled();
      expect(sim.fake!.subscribers.size).toBe(0);
    });
  });

  // --- Delegate methods ---

  describe("tapBinding", () => {
    it("should delegate to dispatcher tap", async () => {
      await action.callTapBinding("settingKey");

      expect(mockTap).toHaveBeenCalledWith("settingKey");
    });

    it("passes the dispatcher's success result through (#962)", async () => {
      mockTap.mockResolvedValueOnce(true);
      await expect(action.callTapBinding("settingKey")).resolves.toBe(true);

      mockTap.mockResolvedValueOnce(false);
      await expect(action.callTapBinding("settingKey")).resolves.toBe(false);
    });
  });

  describe("isBindingKeyboardBound (#962)", () => {
    it("delegates to the dispatcher's isKeyboardBound", () => {
      mockIsKeyboardBound.mockImplementation((k: string) => k === "keyboardKey");

      expect(action.callIsBindingKeyboardBound("keyboardKey")).toBe(true);
      expect(action.callIsBindingKeyboardBound("simHubKey")).toBe(false);
      expect(mockIsKeyboardBound).toHaveBeenCalledWith("simHubKey");
    });
  });

  describe("holdBinding", () => {
    it("should delegate to dispatcher hold", async () => {
      await action.callHoldBinding("action-1", "settingKey");

      expect(mockHold).toHaveBeenCalledWith("action-1", "settingKey");
    });
  });

  describe("releaseBinding", () => {
    it("should delegate to dispatcher release", async () => {
      await action.callReleaseBinding("action-1");

      expect(mockRelease).toHaveBeenCalledWith("action-1");
    });
  });

  describe("getConnectionStatus", () => {
    it("should return the current sim connection status", () => {
      sim.fake!.state.connected = true;
      expect(action.callGetConnectionStatus()).toBe(true);

      sim.fake!.state.connected = false;
      expect(action.callGetConnectionStatus()).toBe(false);
    });

    it("reads the one singleton connection live, so every action follows a change made after it was built", () => {
      const action1 = new TestAction();
      const action2 = new TestAction();

      sim.fake!.state.connected = false;
      expect([action1.callGetConnectionStatus(), action2.callGetConnectionStatus()]).toEqual([false, false]);

      sim.fake!.state.connected = true;
      expect([action1.callGetConnectionStatus(), action2.callGetConnectionStatus()]).toEqual([true, true]);

      // A connection initialised after construction is the one they read.
      _resetSimConnection();
      const replacement = createFakeSimConnection();
      replacement.state.connected = false;
      initializeSimConnection(replacement.connection);

      expect([action1.callGetConnectionStatus(), action2.callGetConnectionStatus()]).toEqual([false, false]);
    });
  });

  describe("isBindingMissing (per-context, stateless)", () => {
    it("returns false for null/empty keys (api/chat/fixed modes)", () => {
      mockIsConfigured.mockClear();
      expect(action.callIsBindingMissing(null)).toBe(false);
      expect(action.callIsBindingMissing("")).toBe(false);
      expect(action.callIsBindingMissing([])).toBe(false);
      expect(mockIsConfigured).not.toHaveBeenCalled();
    });

    it("returns true when the binding is not configured, false when it is", () => {
      mockIsConfigured.mockImplementation((k: string) => k === "myKey");

      expect(action.callIsBindingMissing("myKey")).toBe(false);
      expect(action.callIsBindingMissing("otherKey")).toBe(true);
    });

    it("warns when any of several keys is unconfigured", () => {
      mockIsConfigured.mockImplementation((k: string) => k !== "decKey");
      expect(action.callIsBindingMissing(["incKey", "decKey"])).toBe(true);
      expect(action.callIsBindingMissing(["incKey"])).toBe(false);
    });

    it("ignores empty-string keys (fixed-key modes track nothing)", () => {
      mockIsConfigured.mockReturnValue(false);
      expect(action.callIsBindingMissing(["", ""])).toBe(false);
    });
  });

  // --- Lifecycle hand-off ---

  describe("lifecycle", () => {
    it("hands onWillAppear on to BaseAction", async () => {
      const baseOnWillAppear = vi.spyOn(BaseAction.prototype, "onWillAppear");
      const ev = contextEvent("ctx-1");

      try {
        await action.onWillAppear(ev);

        expect(baseOnWillAppear).toHaveBeenCalledWith(ev);
      } finally {
        baseOnWillAppear.mockRestore();
      }
    });

    it("hands onWillDisappear on to BaseAction", async () => {
      const baseOnWillDisappear = vi.spyOn(BaseAction.prototype, "onWillDisappear");
      const ev = contextEvent("ctx-1");

      try {
        await action.onWillDisappear(ev);

        expect(baseOnWillDisappear).toHaveBeenCalledWith(ev);
      } finally {
        baseOnWillDisappear.mockRestore();
      }
    });
  });
});
