import { ConnectionStateAwareAction, overlayConfig } from "@iracedeck/deck-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSimConnection, type FakeSimConnection } from "../../../deck-core/src/fake-sim-connection.js";

// Serve deck-core a fake sim connection
const sim = vi.hoisted(() => ({ fake: null as FakeSimConnection | null, initialized: true }));

vi.mock("../../../deck-core/src/sim-connection.js", () => ({
  getSimConnection: () => sim.fake!.connection,
  isSimConnectionInitialized: () => sim.initialized,
  initializeSimConnection: vi.fn(),
  _resetSimConnection: vi.fn(),
}));

vi.mock("../../../deck-core/src/binding-dispatcher.js", () => ({
  getBindingDispatcher: vi.fn(() => ({
    tap: vi.fn().mockResolvedValue(true),
    tapSequence: vi.fn().mockResolvedValue(true),
    hold: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => true),
    isConfigured: vi.fn(() => true),
    isKeyboardBound: vi.fn(() => true),
  })),
}));

vi.mock("../../../deck-core/src/global-settings.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;

  return {
    ...original,
    onGlobalSettingsChange: vi.fn(() => vi.fn()),
  };
});

// Mock KeyAction
function createMockKeyAction(id: string) {
  return {
    id,
    isKey: vi.fn().mockReturnValue(true),
    setImage: vi.fn().mockResolvedValue(undefined),
  };
}

// Mock event with action
function createMockEvent<T>(actionId: string, settings: T = {} as T) {
  const action = createMockKeyAction(actionId);

  return {
    action,
    payload: { settings },
  };
}

// Concrete implementation for testing
class TestConnectionAction extends ConnectionStateAwareAction<{ testSetting?: string }> {
  async setImage(ev: any, svg: string): Promise<void> {
    await this.setKeyImage(ev, svg);
  }

  // Expose protected methods for testing
  callUpdateConnectionState(): void {
    this.updateConnectionState();
  }

  callGetConnectionStatus(): boolean {
    return this.getConnectionStatus();
  }

  getStoredImage(contextId: string): string | undefined {
    return this.getKeyImage(contextId);
  }
}

describe("ConnectionStateAwareAction", () => {
  let testAction: TestConnectionAction;

  beforeEach(() => {
    sim.fake = createFakeSimConnection();
    sim.fake.state.connected = false;
    sim.initialized = true;
    testAction = new TestConnectionAction();
    // Enable overlay for tests (disabled by default in production)
    overlayConfig.inactiveOverlayEnabled = true;
  });

  afterEach(() => {
    vi.clearAllMocks();
    overlayConfig.inactiveOverlayEnabled = false;
  });

  describe("getConnectionStatus", () => {
    it("should return the sim connection's status", () => {
      expect(testAction.callGetConnectionStatus()).toBe(false);

      sim.fake!.state.connected = true;

      expect(testAction.callGetConnectionStatus()).toBe(true);
    });

    it("should ask the sim connection", () => {
      const isConnected = vi.spyOn(sim.fake!.connection, "isConnected");

      testAction.callGetConnectionStatus();

      expect(isConnected).toHaveBeenCalled();
    });
  });

  describe("updateConnectionState", () => {
    it("should not change active state when connection status hasn't changed", async () => {
      const ev = createMockEvent("context-1");

      await testAction.setImage(ev, "<svg></svg>");
      ev.action.setImage.mockClear();

      // Call twice with same status (false)
      testAction.callUpdateConnectionState();
      testAction.callUpdateConnectionState();

      // setImage should only be called once (for the first change from null to false)
      expect(ev.action.setImage).toHaveBeenCalledTimes(1);
    });

    it("should set active to true when connected", async () => {
      const ev = createMockEvent("context-1");
      const svg = '<svg fill="#ff0000"></svg>';

      await testAction.setImage(ev, svg);
      ev.action.setImage.mockClear();

      // Initially disconnected, then connect
      testAction.callUpdateConnectionState(); // null -> false (inactive)
      sim.fake!.state.connected = true;
      testAction.callUpdateConnectionState(); // false -> true (active)

      // Last call should set original image (active)
      expect(ev.action.setImage).toHaveBeenLastCalledWith(svg);
    });

    it("should set active to false when disconnected", async () => {
      // Start connected
      sim.fake!.state.connected = true;
      testAction.callUpdateConnectionState(); // null -> true

      const ev = createMockEvent("context-1");
      const svg = '<svg fill="#ff0000"></svg>';

      await testAction.setImage(ev, svg);
      ev.action.setImage.mockClear();

      // Disconnect
      sim.fake!.state.connected = false;
      testAction.callUpdateConnectionState(); // true -> false

      // Should apply inactive overlay
      expect(ev.action.setImage).toHaveBeenCalled();
      // The image should have the overlay applied (will be different from original)
      const callArg = ev.action.setImage.mock.calls[0][0];

      expect(callArg).not.toBe(svg);
    });

    it("should track connection state changes correctly", () => {
      // Initial state: lastConnectionStatus is null
      expect(testAction.getIsActive()).toBe(true); // Default active state

      // First update: null -> false
      testAction.callUpdateConnectionState();

      expect(testAction.getIsActive()).toBe(false);

      // Second update: false -> false (no change)
      testAction.callUpdateConnectionState();

      expect(testAction.getIsActive()).toBe(false);

      // Connect: false -> true
      sim.fake!.state.connected = true;
      testAction.callUpdateConnectionState();

      expect(testAction.getIsActive()).toBe(true);

      // Disconnect: true -> false
      sim.fake!.state.connected = false;
      testAction.callUpdateConnectionState();

      expect(testAction.getIsActive()).toBe(false);
    });
  });

  describe("inheritance from BaseAction", () => {
    it("should inherit setKeyImage functionality", async () => {
      const ev = createMockEvent("context-1");
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

      await testAction.setImage(ev, svg);

      expect(testAction.getStoredImage("context-1")).toBe(svg);
      expect(ev.action.setImage).toHaveBeenCalledWith(svg);
    });

    it("should inherit setActive functionality", () => {
      expect(testAction.getIsActive()).toBe(true);

      testAction.setActive(false);

      expect(testAction.getIsActive()).toBe(false);
    });

    it("should inherit onWillDisappear functionality", async () => {
      const ev = createMockEvent("context-1") as any;

      await testAction.setImage(ev, "<svg></svg>");

      expect(testAction.getStoredImage("context-1")).toBeDefined();

      await testAction.onWillDisappear(ev);

      expect(testAction.getStoredImage("context-1")).toBeUndefined();
    });
  });

  describe("multiple action instances", () => {
    it("should share the same sim connection from the singleton", () => {
      const action1 = new TestConnectionAction();
      const action2 = new TestConnectionAction();
      const isConnected = vi.spyOn(sim.fake!.connection, "isConnected");

      action1.callGetConnectionStatus();
      action2.callGetConnectionStatus();

      // Both should read the same singleton connection
      expect(isConnected).toHaveBeenCalledTimes(2);
    });

    it("should have independent active state tracking", () => {
      const action1 = new TestConnectionAction();
      const action2 = new TestConnectionAction();

      // Both start with default active state
      expect(action1.getIsActive()).toBe(true);
      expect(action2.getIsActive()).toBe(true);

      // Update action1 connection state (will set to false since mock starts disconnected)
      action1.callUpdateConnectionState();

      // action1 should be inactive, action2 still default active
      expect(action1.getIsActive()).toBe(false);
      expect(action2.getIsActive()).toBe(true);
    });
  });
});
