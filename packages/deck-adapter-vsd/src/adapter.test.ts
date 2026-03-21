import type { IDeckActionHandler } from "@iracedeck/deck-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VSDPlatformAdapter } from "./adapter.js";

// Store mock instances so tests can inspect them
const mockInstances: Array<Record<string, ReturnType<typeof vi.fn>>> = [];

// Mock VSDClient — factory must not reference variables defined after vi.mock
vi.mock("./vsd-client.js", () => ({
  parseConnectionParams: () => ({ port: "12345", pluginUuid: "com.test", registerEvent: "register" }),
  VSDClient: class {
    onActionEvent = vi.fn();
    onGlobalEvent = vi.fn();
    connect = vi.fn();
    requestGlobalSettings = vi.fn();
    setImage = vi.fn();
    setTitle = vi.fn();

    constructor() {
      mockInstances.push(this as unknown as Record<string, ReturnType<typeof vi.fn>>);
    }
  },
}));

describe("VSDPlatformAdapter", () => {
  let adapter: VSDPlatformAdapter;
  let client: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstances.length = 0;
    adapter = new VSDPlatformAdapter();
    client = mockInstances[0];
  });

  describe("connect", () => {
    it("should delegate to VSDClient.connect", () => {
      adapter.connect();
      expect(client.connect).toHaveBeenCalledOnce();
    });
  });

  describe("getGlobalSettings", () => {
    it("should delegate to VSDClient.requestGlobalSettings", () => {
      adapter.getGlobalSettings();
      expect(client.requestGlobalSettings).toHaveBeenCalledOnce();
    });
  });

  describe("onDidReceiveGlobalSettings", () => {
    it("should register a global event handler for didReceiveGlobalSettings", () => {
      const callback = vi.fn();
      adapter.onDidReceiveGlobalSettings(callback);

      expect(client.onGlobalEvent).toHaveBeenCalledWith("didReceiveGlobalSettings", expect.any(Function));
    });

    it("should pass settings to the callback when event fires", () => {
      const callback = vi.fn();
      adapter.onDidReceiveGlobalSettings(callback);

      const handler = client.onGlobalEvent.mock.calls[0][1];
      handler({ event: "didReceiveGlobalSettings", payload: { settings: { key: "value" } } });

      expect(callback).toHaveBeenCalledWith({ key: "value" });
    });
  });

  describe("onApplicationDidLaunch", () => {
    it("should register a global event handler for applicationDidLaunch", () => {
      const callback = vi.fn();
      adapter.onApplicationDidLaunch(callback);

      expect(client.onGlobalEvent).toHaveBeenCalledWith("applicationDidLaunch", expect.any(Function));
    });

    it("should pass application name to the callback", () => {
      const callback = vi.fn();
      adapter.onApplicationDidLaunch(callback);

      const handler = client.onGlobalEvent.mock.calls[0][1];
      handler({ event: "applicationDidLaunch", payload: { application: "iRacingSim64DX11.exe" } });

      expect(callback).toHaveBeenCalledWith("iRacingSim64DX11.exe");
    });
  });

  describe("onApplicationDidTerminate", () => {
    it("should register a global event handler for applicationDidTerminate", () => {
      const callback = vi.fn();
      adapter.onApplicationDidTerminate(callback);

      expect(client.onGlobalEvent).toHaveBeenCalledWith("applicationDidTerminate", expect.any(Function));
    });
  });

  describe("createLogger", () => {
    it("should create a logger with the given scope", () => {
      const logger = adapter.createLogger("TestScope");
      expect(logger).toBeDefined();
      expect(logger.info).toBeDefined();
      expect(logger.debug).toBeDefined();
      expect(logger.error).toBeDefined();
    });
  });

  describe("registerAction", () => {
    it("should register all 8 event handlers on the client", () => {
      const handler: IDeckActionHandler = {};
      adapter.registerAction("com.test.action", handler);

      expect(client.onActionEvent).toHaveBeenCalledTimes(8);

      const registeredEvents = client.onActionEvent.mock.calls.map((call: [string, string, unknown]) => call[1]);
      expect(registeredEvents).toContain("willAppear");
      expect(registeredEvents).toContain("willDisappear");
      expect(registeredEvents).toContain("didReceiveSettings");
      expect(registeredEvents).toContain("keyDown");
      expect(registeredEvents).toContain("keyUp");
      expect(registeredEvents).toContain("dialRotate");
      expect(registeredEvents).toContain("dialDown");
      expect(registeredEvents).toContain("dialUp");
    });

    it("should pass correct UUID to all event registrations", () => {
      const handler: IDeckActionHandler = {};
      adapter.registerAction("com.test.my-action", handler);

      for (const call of client.onActionEvent.mock.calls) {
        expect(call[0]).toBe("com.test.my-action");
      }
    });

    it("should call handler.onWillAppear with wrapped event", async () => {
      const handler: IDeckActionHandler = {
        onWillAppear: vi.fn(),
      };
      adapter.registerAction("com.test.action", handler);

      const willAppearCall = client.onActionEvent.mock.calls.find(
        (call: [string, string, unknown]) => call[1] === "willAppear",
      );

      await willAppearCall[2]({
        event: "willAppear",
        action: "com.test.action",
        context: "ctx-123",
        payload: { settings: { mode: "direct" }, controller: "Keypad" },
      });

      expect(handler.onWillAppear).toHaveBeenCalledOnce();
      const ev = (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ev.action.id).toBe("ctx-123");
      expect(ev.payload.settings).toEqual({ mode: "direct" });
    });

    it("should call handler.onKeyDown with wrapped event", async () => {
      const handler: IDeckActionHandler = {
        onKeyDown: vi.fn(),
      };
      adapter.registerAction("com.test.action", handler);

      const keyDownCall = client.onActionEvent.mock.calls.find(
        (call: [string, string, unknown]) => call[1] === "keyDown",
      );

      await keyDownCall[2]({
        event: "keyDown",
        action: "com.test.action",
        context: "ctx-456",
        payload: { settings: {} },
      });

      expect(handler.onKeyDown).toHaveBeenCalledOnce();
      const ev = (handler.onKeyDown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ev.action.id).toBe("ctx-456");
    });

    it("should call handler.onDialRotate with ticks", async () => {
      const handler: IDeckActionHandler = {
        onDialRotate: vi.fn(),
      };
      adapter.registerAction("com.test.action", handler);

      const dialRotateCall = client.onActionEvent.mock.calls.find(
        (call: [string, string, unknown]) => call[1] === "dialRotate",
      );

      await dialRotateCall[2]({
        event: "dialRotate",
        action: "com.test.action",
        context: "ctx-789",
        payload: { settings: {}, ticks: 3 },
      });

      expect(handler.onDialRotate).toHaveBeenCalledOnce();
      const ev = (handler.onDialRotate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ev.payload.ticks).toBe(3);
    });

    it("should provide no-op stubs for willDisappear context", async () => {
      const handler: IDeckActionHandler = {
        onWillDisappear: vi.fn(),
      };
      adapter.registerAction("com.test.action", handler);

      const disappearCall = client.onActionEvent.mock.calls.find(
        (call: [string, string, unknown]) => call[1] === "willDisappear",
      );

      await disappearCall[2]({
        event: "willDisappear",
        action: "com.test.action",
        context: "ctx-gone",
        payload: { settings: {} },
      });

      expect(handler.onWillDisappear).toHaveBeenCalledOnce();
      const ev = (handler.onWillDisappear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ev.action.id).toBe("ctx-gone");
      // setImage/setTitle should be no-ops (not throw)
      await ev.action.setImage("test");
      await ev.action.setTitle("test");
    });
  });

  describe("broadcast callbacks", () => {
    it("should fire onKeyDown callbacks before handler.onKeyDown", async () => {
      const callOrder: string[] = [];
      const broadcastCb = vi.fn(() => callOrder.push("broadcast"));
      const handler: IDeckActionHandler = {
        onKeyDown: vi.fn(async () => callOrder.push("handler")),
      };

      adapter.onKeyDown(broadcastCb);
      adapter.registerAction("com.test.action", handler);

      const keyDownCall = client.onActionEvent.mock.calls.find(
        (call: [string, string, unknown]) => call[1] === "keyDown",
      );
      await keyDownCall[2]({
        event: "keyDown",
        action: "com.test.action",
        context: "ctx",
        payload: { settings: {} },
      });

      expect(callOrder).toEqual(["broadcast", "handler"]);
    });

    it("should fire onDialRotate callbacks before handler.onDialRotate", async () => {
      const callOrder: string[] = [];
      const broadcastCb = vi.fn(() => callOrder.push("broadcast"));
      const handler: IDeckActionHandler = {
        onDialRotate: vi.fn(async () => callOrder.push("handler")),
      };

      adapter.onDialRotate(broadcastCb);
      adapter.registerAction("com.test.action", handler);

      const dialRotateCall = client.onActionEvent.mock.calls.find(
        (call: [string, string, unknown]) => call[1] === "dialRotate",
      );
      await dialRotateCall[2]({
        event: "dialRotate",
        action: "com.test.action",
        context: "ctx",
        payload: { settings: {}, ticks: 1 },
      });

      expect(callOrder).toEqual(["broadcast", "handler"]);
    });

    it("should fire onDialDown callbacks before handler.onDialDown", async () => {
      const broadcastCb = vi.fn();
      const handler: IDeckActionHandler = {
        onDialDown: vi.fn(),
      };

      adapter.onDialDown(broadcastCb);
      adapter.registerAction("com.test.action", handler);

      const dialDownCall = client.onActionEvent.mock.calls.find(
        (call: [string, string, unknown]) => call[1] === "dialDown",
      );
      await dialDownCall[2]({
        event: "dialDown",
        action: "com.test.action",
        context: "ctx",
        payload: { settings: {} },
      });

      expect(broadcastCb).toHaveBeenCalledOnce();
      expect(handler.onDialDown).toHaveBeenCalledOnce();
    });
  });

  describe("VSDActionContext", () => {
    it("should delegate setImage to VSDClient", async () => {
      const handler: IDeckActionHandler = {
        onWillAppear: vi.fn(),
      };
      adapter.registerAction("com.test.action", handler);

      const willAppearCall = client.onActionEvent.mock.calls.find(
        (call: [string, string, unknown]) => call[1] === "willAppear",
      );
      await willAppearCall[2]({
        event: "willAppear",
        action: "com.test.action",
        context: "ctx-img",
        payload: { settings: {}, controller: "Keypad" },
      });

      const ev = (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      await ev.action.setImage("data:image/svg+xml,test");

      expect(client.setImage).toHaveBeenCalledWith("ctx-img", "data:image/svg+xml,test");
    });

    it("should delegate setTitle to VSDClient", async () => {
      const handler: IDeckActionHandler = {
        onWillAppear: vi.fn(),
      };
      adapter.registerAction("com.test.action", handler);

      const willAppearCall = client.onActionEvent.mock.calls.find(
        (call: [string, string, unknown]) => call[1] === "willAppear",
      );
      await willAppearCall[2]({
        event: "willAppear",
        action: "com.test.action",
        context: "ctx-title",
        payload: { settings: {}, controller: "Keypad" },
      });

      const ev = (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      await ev.action.setTitle("Hello");

      expect(client.setTitle).toHaveBeenCalledWith("ctx-title", "Hello");
    });

    it("should return isKey=true for Keypad controller", async () => {
      const handler: IDeckActionHandler = {
        onWillAppear: vi.fn(),
      };
      adapter.registerAction("com.test.action", handler);

      const willAppearCall = client.onActionEvent.mock.calls.find(
        (call: [string, string, unknown]) => call[1] === "willAppear",
      );
      await willAppearCall[2]({
        event: "willAppear",
        action: "com.test.action",
        context: "ctx-key",
        payload: { settings: {}, controller: "Keypad" },
      });

      const ev = (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ev.action.isKey()).toBe(true);
    });

    it("should return isKey=false for Knob controller", async () => {
      const handler: IDeckActionHandler = {
        onWillAppear: vi.fn(),
      };
      adapter.registerAction("com.test.action", handler);

      const willAppearCall = client.onActionEvent.mock.calls.find(
        (call: [string, string, unknown]) => call[1] === "willAppear",
      );
      await willAppearCall[2]({
        event: "willAppear",
        action: "com.test.action",
        context: "ctx-knob",
        payload: { settings: {}, controller: "Knob" },
      });

      const ev = (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ev.action.isKey()).toBe(false);
    });
  });
});
