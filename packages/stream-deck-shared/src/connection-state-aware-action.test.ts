import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionStateAwareAction } from "./connection-state-aware-action.js";

// Mock SDKController
function createMockSDKController(initialConnected: boolean = false) {
  let isConnected = initialConnected;

  return {
    getConnectionStatus: vi.fn(() => isConnected),
    setConnectionStatus: (status: boolean) => {
      isConnected = status;
    },
  };
}

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
  let mockController: ReturnType<typeof createMockSDKController>;
  let testAction: TestConnectionAction;

  beforeEach(() => {
    mockController = createMockSDKController(false);
    testAction = new TestConnectionAction(mockController as any);
  });

  describe("constructor", () => {
    it("should accept an SDKController via constructor", () => {
      const controller = createMockSDKController(true);
      const action = new TestConnectionAction(controller as any);

      expect(action.callGetConnectionStatus()).toBe(true);
    });
  });

  describe("getConnectionStatus", () => {
    it("should return the controller's connection status", () => {
      expect(testAction.callGetConnectionStatus()).toBe(false);

      mockController.setConnectionStatus(true);

      expect(testAction.callGetConnectionStatus()).toBe(true);
    });

    it("should call the controller's getConnectionStatus method", () => {
      testAction.callGetConnectionStatus();

      expect(mockController.getConnectionStatus).toHaveBeenCalled();
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
      mockController.setConnectionStatus(true);
      testAction.callUpdateConnectionState(); // false -> true (active)

      // Last call should set original image (active)
      expect(ev.action.setImage).toHaveBeenLastCalledWith(svg);
    });

    it("should set active to false when disconnected", async () => {
      // Start connected
      mockController.setConnectionStatus(true);
      testAction.callUpdateConnectionState(); // null -> true

      const ev = createMockEvent("context-1");
      const svg = '<svg fill="#ff0000"></svg>';

      await testAction.setImage(ev, svg);
      ev.action.setImage.mockClear();

      // Disconnect
      mockController.setConnectionStatus(false);
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
      mockController.setConnectionStatus(true);
      testAction.callUpdateConnectionState();

      expect(testAction.getIsActive()).toBe(true);

      // Disconnect: true -> false
      mockController.setConnectionStatus(false);
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

  describe("multiple instances with different controllers", () => {
    it("should have independent controllers", () => {
      const controller1 = createMockSDKController(true);
      const controller2 = createMockSDKController(false);

      const action1 = new TestConnectionAction(controller1 as any);
      const action2 = new TestConnectionAction(controller2 as any);

      expect(action1.callGetConnectionStatus()).toBe(true);
      expect(action2.callGetConnectionStatus()).toBe(false);
    });

    it("should track connection state independently", () => {
      const controller1 = createMockSDKController(true);
      const controller2 = createMockSDKController(false);

      const action1 = new TestConnectionAction(controller1 as any);
      const action2 = new TestConnectionAction(controller2 as any);

      action1.callUpdateConnectionState();
      action2.callUpdateConnectionState();

      expect(action1.getIsActive()).toBe(true);
      expect(action2.getIsActive()).toBe(false);
    });
  });
});
