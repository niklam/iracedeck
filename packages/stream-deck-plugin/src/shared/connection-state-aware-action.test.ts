import { ConnectionStateAwareAction, overlayConfig } from "@iracedeck/deck-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock sdk-singleton before importing deck-core (same approach as app-monitor.test.ts)
const mockGetConnectionStatus = vi.fn();
const mockSetReconnectEnabled = vi.fn();
const mockGetController = vi.fn(() => ({
  getConnectionStatus: mockGetConnectionStatus,
  setReconnectEnabled: mockSetReconnectEnabled,
}));

vi.mock("../../../deck-core/src/sdk-singleton.js", () => ({
  getController: () => mockGetController(),
  getSDK: vi.fn(),
  getCommands: vi.fn(),
  initializeSDK: vi.fn(),
  isSDKInitialized: vi.fn(() => true),
  _resetSDK: vi.fn(),
}));

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
    mockGetConnectionStatus.mockReturnValue(false);
    mockGetController.mockReturnValue({
      getConnectionStatus: mockGetConnectionStatus,
      setReconnectEnabled: mockSetReconnectEnabled,
    });
    testAction = new TestConnectionAction();
    // Enable overlay for tests (disabled by default in production)
    overlayConfig.inactiveOverlayEnabled = true;
  });

  afterEach(() => {
    vi.clearAllMocks();
    overlayConfig.inactiveOverlayEnabled = false;
  });

  describe("sdkController getter", () => {
    it("should get controller from SDK singleton", () => {
      testAction.callGetConnectionStatus();

      expect(mockGetController).toHaveBeenCalled();
    });
  });

  describe("getConnectionStatus", () => {
    it("should return the controller's connection status", () => {
      expect(testAction.callGetConnectionStatus()).toBe(false);

      mockGetConnectionStatus.mockReturnValue(true);

      expect(testAction.callGetConnectionStatus()).toBe(true);
    });

    it("should call the controller's getConnectionStatus method", () => {
      testAction.callGetConnectionStatus();

      expect(mockGetConnectionStatus).toHaveBeenCalled();
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
      mockGetConnectionStatus.mockReturnValue(true);
      testAction.callUpdateConnectionState(); // false -> true (active)

      // Last call should set original image (active)
      expect(ev.action.setImage).toHaveBeenLastCalledWith(svg);
    });

    it("should set active to false when disconnected", async () => {
      // Start connected
      mockGetConnectionStatus.mockReturnValue(true);
      testAction.callUpdateConnectionState(); // null -> true

      const ev = createMockEvent("context-1");
      const svg = '<svg fill="#ff0000"></svg>';

      await testAction.setImage(ev, svg);
      ev.action.setImage.mockClear();

      // Disconnect
      mockGetConnectionStatus.mockReturnValue(false);
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
      mockGetConnectionStatus.mockReturnValue(true);
      testAction.callUpdateConnectionState();

      expect(testAction.getIsActive()).toBe(true);

      // Disconnect: true -> false
      mockGetConnectionStatus.mockReturnValue(false);
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
    it("should share the same controller from singleton", () => {
      const action1 = new TestConnectionAction();
      const action2 = new TestConnectionAction();

      action1.callGetConnectionStatus();
      action2.callGetConnectionStatus();

      // Both should use the same singleton controller
      expect(mockGetController).toHaveBeenCalledTimes(2);
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
