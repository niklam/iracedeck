import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetBindingDispatcher,
  getBindingDispatcher,
  initializeBindingDispatcher,
  isBindingDispatcherInitialized,
} from "./binding-dispatcher.js";

const {
  mockSendKeyCombination,
  mockPressKeyCombination,
  mockReleaseKeyCombination,
  mockStartRole,
  mockStopRole,
  mockGetGlobalSettings,
  mockIsSimHubInitialized,
} = vi.hoisted(() => ({
  mockSendKeyCombination: vi.fn().mockResolvedValue(true),
  mockPressKeyCombination: vi.fn().mockResolvedValue(true),
  mockReleaseKeyCombination: vi.fn().mockResolvedValue(true),
  mockStartRole: vi.fn().mockResolvedValue(true),
  mockStopRole: vi.fn().mockResolvedValue(true),
  mockGetGlobalSettings: vi.fn<() => Record<string, unknown>>(() => ({})),
  mockIsSimHubInitialized: vi.fn(() => true),
}));

vi.mock("./keyboard-service.js", () => ({
  getKeyboard: () => ({
    sendKeyCombination: mockSendKeyCombination,
    pressKeyCombination: mockPressKeyCombination,
    releaseKeyCombination: mockReleaseKeyCombination,
  }),
}));

vi.mock("./simhub-service.js", () => ({
  isSimHubInitialized: mockIsSimHubInitialized,
  getSimHub: () => ({
    startRole: mockStartRole,
    stopRole: mockStopRole,
  }),
}));

vi.mock("./global-settings.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;

  return {
    ...original,
    getGlobalSettings: mockGetGlobalSettings,
  };
});

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withLevel: vi.fn(),
  createScope: vi.fn(),
};

describe("BindingDispatcher", () => {
  beforeEach(() => {
    _resetBindingDispatcher();
    vi.clearAllMocks();
    mockIsSimHubInitialized.mockReturnValue(true);
  });

  // --- Initialization ---

  describe("initialization", () => {
    it("should initialize successfully", () => {
      initializeBindingDispatcher(mockLogger);
      expect(isBindingDispatcherInitialized()).toBe(true);
    });

    it("should throw if initialized twice", () => {
      initializeBindingDispatcher(mockLogger);
      expect(() => initializeBindingDispatcher(mockLogger)).toThrow("already initialized");
    });

    it("should throw getBindingDispatcher before init", () => {
      expect(() => getBindingDispatcher()).toThrow("not initialized");
    });

    it("should reset correctly", () => {
      initializeBindingDispatcher(mockLogger);
      _resetBindingDispatcher();
      expect(isBindingDispatcherInitialized()).toBe(false);
    });
  });

  // --- tap ---

  describe("tap", () => {
    beforeEach(() => {
      initializeBindingDispatcher(mockLogger);
    });

    describe("keyboard bindings", () => {
      it("should call sendKeyCombination with correct key and modifiers", async () => {
        mockGetGlobalSettings.mockReturnValue({
          myKey: JSON.stringify({ key: "f1", modifiers: ["ctrl", "shift"], code: "F1" }),
        });

        await getBindingDispatcher().tap("myKey");

        expect(mockSendKeyCombination).toHaveBeenCalledWith({
          key: "f1",
          modifiers: ["ctrl", "shift"],
          code: "F1",
        });
      });

      it("should pass undefined modifiers when modifiers array is empty", async () => {
        mockGetGlobalSettings.mockReturnValue({
          myKey: JSON.stringify({ key: "f3", modifiers: [], code: "F3" }),
        });

        await getBindingDispatcher().tap("myKey");

        expect(mockSendKeyCombination).toHaveBeenCalledWith({
          key: "f3",
          modifiers: undefined,
          code: "F3",
        });
      });

      it("should handle keyboard binding without code field", async () => {
        mockGetGlobalSettings.mockReturnValue({
          myKey: JSON.stringify({ key: "a", modifiers: [] }),
        });

        await getBindingDispatcher().tap("myKey");

        expect(mockSendKeyCombination).toHaveBeenCalledWith({
          key: "a",
          modifiers: undefined,
          code: undefined,
        });
      });

      it("should not call SimHub for keyboard bindings", async () => {
        mockGetGlobalSettings.mockReturnValue({
          myKey: JSON.stringify({ key: "f1", modifiers: [], code: "F1" }),
        });

        await getBindingDispatcher().tap("myKey");

        expect(mockStartRole).not.toHaveBeenCalled();
        expect(mockStopRole).not.toHaveBeenCalled();
      });
    });

    describe("SimHub bindings", () => {
      it("should call startRole and stopRole for SimHub tap", async () => {
        mockGetGlobalSettings.mockReturnValue({
          myKey: JSON.stringify({ type: "simhub", role: "My Role" }),
        });

        await getBindingDispatcher().tap("myKey");

        expect(mockStartRole).toHaveBeenCalledWith("My Role");
        expect(mockStopRole).toHaveBeenCalledWith("My Role");
      });

      it("should call startRole before stopRole", async () => {
        const callOrder: string[] = [];
        mockStartRole.mockImplementation(async () => {
          callOrder.push("start");

          return true;
        });
        mockStopRole.mockImplementation(async () => {
          callOrder.push("stop");

          return true;
        });

        mockGetGlobalSettings.mockReturnValue({
          myKey: JSON.stringify({ type: "simhub", role: "TestRole" }),
        });

        await getBindingDispatcher().tap("myKey");

        expect(callOrder).toEqual(["start", "stop"]);
      });

      it("should not call keyboard for SimHub bindings", async () => {
        mockGetGlobalSettings.mockReturnValue({
          myKey: JSON.stringify({ type: "simhub", role: "My Role" }),
        });

        await getBindingDispatcher().tap("myKey");

        expect(mockSendKeyCombination).not.toHaveBeenCalled();
      });

      it("should warn and skip when SimHub is not initialized", async () => {
        mockIsSimHubInitialized.mockReturnValue(false);
        mockGetGlobalSettings.mockReturnValue({
          myKey: JSON.stringify({ type: "simhub", role: "My Role" }),
        });

        await getBindingDispatcher().tap("myKey");

        expect(mockStartRole).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith("SimHub service not initialized");
      });

      it("should not call stopRole when startRole fails", async () => {
        mockStartRole.mockResolvedValue(false);
        mockGetGlobalSettings.mockReturnValue({
          myKey: JSON.stringify({ type: "simhub", role: "FailRole" }),
        });

        await getBindingDispatcher().tap("myKey");

        expect(mockStartRole).toHaveBeenCalledWith("FailRole");
        expect(mockStopRole).not.toHaveBeenCalled();
      });
    });

    describe("missing bindings", () => {
      it("should warn when setting key is not in global settings", async () => {
        mockGetGlobalSettings.mockReturnValue({});

        await getBindingDispatcher().tap("nonExistentKey");

        expect(mockSendKeyCombination).not.toHaveBeenCalled();
        expect(mockStartRole).not.toHaveBeenCalled();
        expect(mockLogger.debug).toHaveBeenCalledWith("No binding configured for nonExistentKey");
      });

      it("should warn when setting value is empty string", async () => {
        mockGetGlobalSettings.mockReturnValue({ myKey: "" });

        await getBindingDispatcher().tap("myKey");

        expect(mockSendKeyCombination).not.toHaveBeenCalled();
        expect(mockLogger.debug).toHaveBeenCalledWith("No binding configured for myKey");
      });
    });
  });

  // --- hold ---

  describe("hold", () => {
    beforeEach(() => {
      initializeBindingDispatcher(mockLogger);
    });

    describe("keyboard bindings", () => {
      it("should call pressKeyCombination with correct key and modifiers", async () => {
        mockGetGlobalSettings.mockReturnValue({
          myKey: JSON.stringify({ key: "numpad4", modifiers: ["ctrl"], code: "Numpad4" }),
        });

        await getBindingDispatcher().hold("ctx-1", "myKey");

        expect(mockPressKeyCombination).toHaveBeenCalledWith({
          key: "numpad4",
          modifiers: ["ctrl"],
          code: "Numpad4",
        });
      });

      it("should not call SimHub for keyboard hold", async () => {
        mockGetGlobalSettings.mockReturnValue({
          myKey: JSON.stringify({ key: "f1", modifiers: [], code: "F1" }),
        });

        await getBindingDispatcher().hold("ctx-1", "myKey");

        expect(mockStartRole).not.toHaveBeenCalled();
      });
    });

    describe("SimHub bindings", () => {
      it("should call startRole without stopRole for SimHub hold", async () => {
        mockGetGlobalSettings.mockReturnValue({
          myKey: JSON.stringify({ type: "simhub", role: "HoldRole" }),
        });

        await getBindingDispatcher().hold("ctx-1", "myKey");

        expect(mockStartRole).toHaveBeenCalledWith("HoldRole");
        expect(mockStopRole).not.toHaveBeenCalled();
      });
    });
  });

  // --- release ---

  describe("release", () => {
    beforeEach(() => {
      initializeBindingDispatcher(mockLogger);
    });

    describe("keyboard release", () => {
      it("should call releaseKeyCombination for a held keyboard binding", async () => {
        mockGetGlobalSettings.mockReturnValue({
          myKey: JSON.stringify({ key: "f1", modifiers: ["shift"], code: "F1" }),
        });

        await getBindingDispatcher().hold("ctx-1", "myKey");
        vi.clearAllMocks();

        await getBindingDispatcher().release("ctx-1");

        expect(mockReleaseKeyCombination).toHaveBeenCalledWith({
          key: "f1",
          modifiers: ["shift"],
          code: "F1",
        });
      });

      it("should not call releaseKeyCombination twice for same context", async () => {
        mockGetGlobalSettings.mockReturnValue({
          myKey: JSON.stringify({ key: "f1", modifiers: [], code: "F1" }),
        });

        await getBindingDispatcher().hold("ctx-1", "myKey");

        await getBindingDispatcher().release("ctx-1");
        await getBindingDispatcher().release("ctx-1");

        expect(mockReleaseKeyCombination).toHaveBeenCalledTimes(1);
      });
    });

    describe("SimHub release", () => {
      it("should call stopRole for a held SimHub binding", async () => {
        mockGetGlobalSettings.mockReturnValue({
          myKey: JSON.stringify({ type: "simhub", role: "HoldRole" }),
        });

        await getBindingDispatcher().hold("ctx-1", "myKey");
        vi.clearAllMocks();

        await getBindingDispatcher().release("ctx-1");

        expect(mockStopRole).toHaveBeenCalledWith("HoldRole");
        expect(mockReleaseKeyCombination).not.toHaveBeenCalled();
      });
    });

    describe("no-op cases", () => {
      it("should be safe to call with no held binding", async () => {
        await getBindingDispatcher().release("nonexistent-ctx");

        expect(mockReleaseKeyCombination).not.toHaveBeenCalled();
        expect(mockStopRole).not.toHaveBeenCalled();
      });
    });

    describe("concurrent contexts", () => {
      it("should track and release multiple contexts independently", async () => {
        mockGetGlobalSettings.mockReturnValue({
          keyA: JSON.stringify({ key: "f1", modifiers: [], code: "F1" }),
          keyB: JSON.stringify({ type: "simhub", role: "RoleB" }),
        });

        await getBindingDispatcher().hold("ctx-1", "keyA");
        await getBindingDispatcher().hold("ctx-2", "keyB");

        vi.clearAllMocks();

        await getBindingDispatcher().release("ctx-1");

        expect(mockReleaseKeyCombination).toHaveBeenCalledWith({
          key: "f1",
          modifiers: undefined,
          code: "F1",
        });
        expect(mockStopRole).not.toHaveBeenCalled();

        vi.clearAllMocks();

        await getBindingDispatcher().release("ctx-2");

        expect(mockStopRole).toHaveBeenCalledWith("RoleB");
        expect(mockReleaseKeyCombination).not.toHaveBeenCalled();
      });
    });
  });

  // --- isReady ---

  describe("isReady", () => {
    beforeEach(() => {
      initializeBindingDispatcher(mockLogger);
    });

    it("should return false when no binding is configured", () => {
      mockGetGlobalSettings.mockReturnValue({});

      expect(getBindingDispatcher().isReady("nonExistentKey", true)).toBe(false);
    });

    it("should return iRacingConnected for keyboard bindings", () => {
      mockGetGlobalSettings.mockReturnValue({
        myKey: JSON.stringify({ key: "f1", modifiers: [], code: "F1" }),
      });

      expect(getBindingDispatcher().isReady("myKey", true)).toBe(true);
      expect(getBindingDispatcher().isReady("myKey", false)).toBe(false);
    });

    it("should return true for SimHub bindings when SimHub is initialized", () => {
      mockIsSimHubInitialized.mockReturnValue(true);
      mockGetGlobalSettings.mockReturnValue({
        myKey: JSON.stringify({ type: "simhub", role: "MyRole" }),
      });

      expect(getBindingDispatcher().isReady("myKey", false)).toBe(true);
    });

    it("should return false for SimHub bindings when SimHub is not initialized", () => {
      mockIsSimHubInitialized.mockReturnValue(false);
      mockGetGlobalSettings.mockReturnValue({
        myKey: JSON.stringify({ type: "simhub", role: "MyRole" }),
      });

      expect(getBindingDispatcher().isReady("myKey", true)).toBe(false);
    });
  });
});
