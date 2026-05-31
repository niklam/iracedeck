import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionStateAwareAction } from "./connection-state-aware-action.js";

const {
  mockGetConnectionStatus,
  mockSubscribe,
  mockUnsubscribe,
  mockTap,
  mockHold,
  mockRelease,
  mockIsReady,
  mockIsConfigured,
  mockOnGlobalSettingsChange,
  mockOnSimHubReachabilityChange,
} = vi.hoisted(() => ({
  mockGetConnectionStatus: vi.fn(() => true),
  mockSubscribe: vi.fn(),
  mockUnsubscribe: vi.fn(),
  mockTap: vi.fn().mockResolvedValue(undefined),
  mockHold: vi.fn().mockResolvedValue(undefined),
  mockRelease: vi.fn().mockResolvedValue(undefined),
  mockIsReady: vi.fn(() => true),
  mockIsConfigured: vi.fn((_key: string) => true),
  mockOnGlobalSettingsChange: vi.fn(() => vi.fn()),
  mockOnSimHubReachabilityChange: vi.fn(() => vi.fn()),
}));

vi.mock("./sdk-singleton.js", () => ({
  getController: () => ({
    getConnectionStatus: mockGetConnectionStatus,
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
  }),
}));

vi.mock("./binding-dispatcher.js", () => ({
  getBindingDispatcher: () => ({
    tap: mockTap,
    hold: mockHold,
    release: mockRelease,
    isReady: mockIsReady,
    isConfigured: mockIsConfigured,
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

    setActive = vi.fn();

    async onWillAppear() {}
    async onWillDisappear() {}
    async onDidReceiveSettings() {}
  },
}));

vi.mock("./simhub-service.js", () => ({
  onSimHubReachabilityChange: mockOnSimHubReachabilityChange,
}));

vi.mock("./global-settings.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;

  return {
    ...original,
    getGlobalSettings: vi.fn(() => ({})),
    onGlobalSettingsChange: mockOnGlobalSettingsChange,
  };
});

class TestAction extends ConnectionStateAwareAction {
  callUpdateConnectionState(): void {
    this.updateConnectionState();
  }

  callGetConnectionStatus(): boolean {
    return this.getConnectionStatus();
  }

  callSetActiveBinding(key: string | string[] | null): void {
    this.setActiveBinding(key);
  }

  async callTapBinding(key: string): Promise<void> {
    return this.tapBinding(key);
  }

  async callHoldBinding(actionId: string, key: string): Promise<void> {
    return this.holdBinding(actionId, key);
  }

  async callReleaseBinding(actionId: string): Promise<void> {
    return this.releaseBinding(actionId);
  }

  callIsActiveBindingMissing(): boolean {
    return this.isActiveBindingMissing();
  }

  callIsBindingMissing(keys: string | string[] | null | undefined): boolean {
    return this.isBindingMissing(keys);
  }
}

function getSetActive(action: TestAction) {
  return (action as unknown as { setActive: ReturnType<typeof vi.fn> }).setActive;
}

function getLogger(action: TestAction) {
  return (
    action as unknown as {
      logger: { info: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
    }
  ).logger;
}

describe("ConnectionStateAwareAction", () => {
  let action: TestAction;

  beforeEach(() => {
    vi.clearAllMocks();
    action = new TestAction();
  });

  // --- Connection state (no active binding) ---

  describe("updateConnectionState (no active binding)", () => {
    it("should set active when iRacing connected", () => {
      mockGetConnectionStatus.mockReturnValue(true);

      action.callUpdateConnectionState();

      expect(getSetActive(action)).toHaveBeenCalledWith(true);
    });

    it("should set inactive when iRacing disconnected", () => {
      mockGetConnectionStatus.mockReturnValue(false);

      action.callUpdateConnectionState();

      expect(getSetActive(action)).toHaveBeenCalledWith(false);
    });

    it("should not call setActive when status unchanged", () => {
      mockGetConnectionStatus.mockReturnValue(true);

      action.callUpdateConnectionState();
      vi.clearAllMocks();

      action.callUpdateConnectionState();

      expect(getSetActive(action)).not.toHaveBeenCalled();
    });

    it("should log state transitions", () => {
      mockGetConnectionStatus.mockReturnValue(true);

      action.callUpdateConnectionState();

      expect(getLogger(action).debug).toHaveBeenCalledWith("Readiness changed: null -> true");
    });
  });

  // --- Binding-aware readiness ---

  describe("setActiveBinding", () => {
    it("should immediately evaluate readiness", () => {
      mockIsReady.mockReturnValue(true);

      action.callSetActiveBinding("myKey");

      expect(mockIsReady).toHaveBeenCalledWith("myKey", expect.any(Boolean));
      expect(getSetActive(action)).toHaveBeenCalledWith(true);
    });

    it("should show inactive when binding is not ready", () => {
      mockIsReady.mockReturnValue(false);

      action.callSetActiveBinding("myKey");

      expect(getSetActive(action)).toHaveBeenCalledWith(false);
    });

    it("should subscribe to global settings changes", () => {
      action.callSetActiveBinding("myKey");

      expect(mockOnGlobalSettingsChange).toHaveBeenCalledOnce();
    });

    it("should only subscribe once even with multiple setActiveBinding calls", () => {
      action.callSetActiveBinding("keyA");
      action.callSetActiveBinding("keyB");

      expect(mockOnGlobalSettingsChange).toHaveBeenCalledOnce();
    });

    it("should re-evaluate readiness when global settings change", () => {
      let globalSettingsCallback: unknown = null;
      (mockOnGlobalSettingsChange as ReturnType<typeof vi.fn>).mockImplementation((cb: () => void) => {
        globalSettingsCallback = cb;

        return vi.fn();
      });

      // Start ready
      mockIsReady.mockReturnValue(true);
      action.callSetActiveBinding("myKey");
      expect(getSetActive(action)).toHaveBeenCalledWith(true);

      // Simulate global settings change making binding not ready
      mockIsReady.mockReturnValue(false);
      (globalSettingsCallback as () => void)();

      expect(getSetActive(action)).toHaveBeenCalledWith(false);
    });

    it("should fall back to iRacing status when active binding cleared", () => {
      // Start with SimHub binding ready, iRacing disconnected
      mockIsReady.mockReturnValue(true);
      mockGetConnectionStatus.mockReturnValue(false);
      action.callSetActiveBinding("myKey");
      expect(getSetActive(action)).toHaveBeenCalledWith(true);

      // Clear active binding — falls back to iRacing status (disconnected)
      action.callSetActiveBinding(null);
      expect(getSetActive(action)).toHaveBeenCalledWith(false);

      // iRacing connects — now ready
      mockGetConnectionStatus.mockReturnValue(true);
      action.callUpdateConnectionState();
      expect(getSetActive(action)).toHaveBeenCalledWith(true);
    });
  });

  describe("updateConnectionState (with active binding)", () => {
    it("should use dispatcher isReady when active binding is set", () => {
      action.callSetActiveBinding("myKey");
      vi.clearAllMocks();

      mockIsReady.mockReturnValue(true);
      mockGetConnectionStatus.mockReturnValue(false);

      action.callUpdateConnectionState();

      expect(mockIsReady).toHaveBeenCalledWith("myKey", false);
    });
  });

  // --- Delegate methods ---

  describe("tapBinding", () => {
    it("should delegate to dispatcher tap", async () => {
      await action.callTapBinding("settingKey");

      expect(mockTap).toHaveBeenCalledWith("settingKey");
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
    it("should return current iRacing connection status", () => {
      mockGetConnectionStatus.mockReturnValue(true);
      expect(action.callGetConnectionStatus()).toBe(true);

      mockGetConnectionStatus.mockReturnValue(false);
      expect(action.callGetConnectionStatus()).toBe(false);
    });
  });

  describe("isActiveBindingMissing", () => {
    it("returns false when no binding is active (api/chat modes)", () => {
      action.callSetActiveBinding(null);
      expect(action.callIsActiveBindingMissing()).toBe(false);
      // Must not even consult the dispatcher when there is no active key.
      mockIsConfigured.mockClear();
      action.callIsActiveBindingMissing();
      expect(mockIsConfigured).not.toHaveBeenCalled();
    });

    it("returns true when the active binding is not configured", () => {
      action.callSetActiveBinding("myKey");
      mockIsConfigured.mockReturnValue(false);
      expect(action.callIsActiveBindingMissing()).toBe(true);
      expect(mockIsConfigured).toHaveBeenCalledWith("myKey");
    });

    it("returns false when the active binding is configured (keyboard or SimHub)", () => {
      action.callSetActiveBinding("myKey");
      mockIsConfigured.mockReturnValue(true);
      expect(action.callIsActiveBindingMissing()).toBe(false);
    });

    it("warns for a multi-key mode when ANY key is unconfigured", () => {
      action.callSetActiveBinding(["incKey", "decKey"]);
      mockIsConfigured.mockImplementation((k: string) => k !== "decKey");
      expect(action.callIsActiveBindingMissing()).toBe(true);
    });

    it("does not warn for a multi-key mode when all keys are configured", () => {
      action.callSetActiveBinding(["incKey", "decKey"]);
      mockIsConfigured.mockReturnValue(true);
      expect(action.callIsActiveBindingMissing()).toBe(false);
    });

    it("ignores empty-string keys (fixed-key modes track nothing)", () => {
      action.callSetActiveBinding("");
      mockIsConfigured.mockClear();
      expect(action.callIsActiveBindingMissing()).toBe(false);
      expect(mockIsConfigured).not.toHaveBeenCalled();
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

    it("does not depend on setActiveBinding (no cross-context bleed)", () => {
      // Another context declared a missing binding...
      action.callSetActiveBinding("otherKey");
      mockIsConfigured.mockReturnValue(false);
      // ...but THIS context's own configured key must read as present.
      mockIsConfigured.mockImplementation((k: string) => k === "myKey");
      expect(action.callIsBindingMissing("myKey")).toBe(false);
      expect(action.callIsBindingMissing("otherKey")).toBe(true);
    });

    it("warns when any of several keys is unconfigured", () => {
      mockIsConfigured.mockImplementation((k: string) => k !== "decKey");
      expect(action.callIsBindingMissing(["incKey", "decKey"])).toBe(true);
      expect(action.callIsBindingMissing(["incKey"])).toBe(false);
    });
  });

  // --- Lifecycle: onWillAppear / onWillDisappear ---

  describe("onWillAppear", () => {
    it("should subscribe to SDK controller for readiness tracking", async () => {
      const ev = {
        action: { id: "ctx-1", setTitle: vi.fn(), setImage: vi.fn(), isKey: vi.fn().mockReturnValue(true) },
        payload: { settings: {} },
      };

      await action.onWillAppear(ev as never);

      expect(mockSubscribe).toHaveBeenCalledWith("_readiness:ctx-1", expect.any(Function));
    });
  });

  describe("onWillDisappear", () => {
    it("should unsubscribe from SDK controller readiness tracking", async () => {
      const ev = {
        action: { id: "ctx-1", setTitle: vi.fn(), setImage: vi.fn(), isKey: vi.fn().mockReturnValue(true) },
        payload: { settings: {} },
      };

      await action.onWillAppear(ev as never);
      vi.clearAllMocks();

      await action.onWillDisappear(ev as never);

      expect(mockUnsubscribe).toHaveBeenCalledWith("_readiness:ctx-1");
    });

    it("should clean up global settings listener to prevent memory leaks", async () => {
      const unsubscribeSpy = vi.fn();
      (mockOnGlobalSettingsChange as ReturnType<typeof vi.fn>).mockReturnValue(unsubscribeSpy);

      const ev = {
        action: { id: "ctx-1", setTitle: vi.fn(), setImage: vi.fn(), isKey: vi.fn().mockReturnValue(true) },
        payload: { settings: {} },
      };

      await action.onWillAppear(ev as never);
      action.callSetActiveBinding("myKey");

      await action.onWillDisappear(ev as never);

      expect(unsubscribeSpy).toHaveBeenCalled();
    });

    it("should allow re-subscription after disappear and re-appear", async () => {
      const ev = {
        action: { id: "ctx-1", setTitle: vi.fn(), setImage: vi.fn(), isKey: vi.fn().mockReturnValue(true) },
        payload: { settings: {} },
      };

      await action.onWillAppear(ev as never);
      await action.onWillDisappear(ev as never);
      vi.clearAllMocks();

      await action.onWillAppear(ev as never);

      expect(mockSubscribe).toHaveBeenCalledWith("_readiness:ctx-1", expect.any(Function));
    });
  });
});
