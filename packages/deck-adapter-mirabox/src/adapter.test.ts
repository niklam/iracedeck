import {
  _resetRasterizer,
  DEFAULT_KEY_IMAGE_SIZE,
  type IDeckActionHandler,
  initializeRasterizer,
  svgToDataUri,
} from "@iracedeck/deck-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    setGlobalSettings = vi.fn();
    openUrl = vi.fn();
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

  describe("setGlobalSettings", () => {
    it("should delegate to VSDClient.setGlobalSettings", () => {
      const settings = { foo: "bar" };
      adapter.setGlobalSettings(settings);
      expect(client.setGlobalSettings).toHaveBeenCalledWith(settings);
    });
  });

  describe("openUrl", () => {
    it("should delegate to VSDClient.openUrl", async () => {
      await adapter.openUrl("https://example.test/");
      expect(client.openUrl).toHaveBeenCalledWith("https://example.test/");
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

  describe("onPropertyInspectorDidAppear", () => {
    it("should register a global event handler for propertyInspectorDidAppear", () => {
      const callback = vi.fn();
      adapter.onPropertyInspectorDidAppear(callback);

      expect(client.onGlobalEvent).toHaveBeenCalledWith("propertyInspectorDidAppear", expect.any(Function));
    });

    it("should invoke the callback (parameterless) when the PI-appear event arrives", () => {
      const callback = vi.fn();
      adapter.onPropertyInspectorDidAppear(callback);

      const handler = client.onGlobalEvent.mock.calls[0][1];
      handler({ event: "propertyInspectorDidAppear", action: "com.iracedeck.sd.core.pit-crew", context: "abc" });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith();
    });
  });

  describe("onOpenSettingsRequest (#992)", () => {
    it("registers a global handler for the PI's sendToPlugin frames", () => {
      adapter.onOpenSettingsRequest(vi.fn());

      expect(client.onGlobalEvent).toHaveBeenCalledWith("sendToPlugin", expect.any(Function));
    });

    it("invokes the listener when the PI sends an openSettings command", () => {
      const listener = vi.fn();
      adapter.onOpenSettingsRequest(listener);

      const handler = client.onGlobalEvent.mock.calls[0][1];
      handler({
        event: "sendToPlugin",
        action: "com.iracedeck.sd.core.car-control",
        payload: { event: "openSettings" },
      });

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("ignores other sendToPlugin commands and malformed payloads", () => {
      const listener = vi.fn();
      adapter.onOpenSettingsRequest(listener);

      const handler = client.onGlobalEvent.mock.calls[0][1];
      handler({ event: "sendToPlugin", payload: { event: "switchToProfile", profile: "x" } });
      handler({ event: "sendToPlugin", payload: "not-an-object" });
      handler({ event: "sendToPlugin" });

      expect(listener).not.toHaveBeenCalled();
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
        payload: { settings: {}, ticks: 3, pressed: true },
      });

      expect(handler.onDialRotate).toHaveBeenCalledOnce();
      const ev = (handler.onDialRotate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ev.payload.ticks).toBe(3);
      // Mirabox sends `pressed` natively (rotate-while-pressed); pass it through.
      expect(ev.payload.pressed).toBe(true);
    });

    it("defaults onDialRotate pressed to false when the frame omits it", async () => {
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
        payload: { settings: {}, ticks: 1 },
      });

      const ev = (handler.onDialRotate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ev.payload.pressed).toBe(false);
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
      // setImage/setTitle should be no-ops that don't delegate to VSDClient
      client.setImage.mockClear();
      client.setTitle.mockClear();
      await ev.action.setImage("test");
      await ev.action.setTitle("test");
      expect(client.setImage).not.toHaveBeenCalled();
      expect(client.setTitle).not.toHaveBeenCalled();
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
      const callOrder: string[] = [];
      const broadcastCb = vi.fn(() => callOrder.push("broadcast"));
      const handler: IDeckActionHandler = {
        onDialDown: vi.fn(async () => callOrder.push("handler")),
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

      expect(callOrder).toEqual(["broadcast", "handler"]);
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

    it("should return isKey=true for Information controller because 293S updates the info area with setImage", async () => {
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
        context: "ctx-info",
        payload: { settings: {}, controller: "Information" },
      });

      const ev = (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ev.action.isKey()).toBe(true);
    });

    async function getContextForController(controller: string) {
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
        context: "ctx",
        payload: { settings: {}, controller },
      });

      return (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0].action;
    }

    it("should return isDial=true for Knob controller", async () => {
      const action = await getContextForController("Knob");
      expect(action.isDial()).toBe(true);
    });

    it("should return isDial=true for Encoder controller", async () => {
      const action = await getContextForController("Encoder");
      expect(action.isDial()).toBe(true);
    });

    it("should return isDial=false for Keypad controller", async () => {
      const action = await getContextForController("Keypad");
      expect(action.isDial()).toBe(false);
    });

    it("should treat setFeedback and setFeedbackLayout as safe no-ops", async () => {
      const action = await getContextForController("Knob");

      // Stream Dock has no plugin-facing touch-strip feedback; these resolve
      // without touching the client.
      await expect(action.setFeedback({ value: 1 })).resolves.toBeUndefined();
      await expect(action.setFeedbackLayout("$B1")).resolves.toBeUndefined();
      expect(client.setImage).not.toHaveBeenCalled();
    });

    it("should treat setTriggerDescription as a safe no-op", async () => {
      const action = await getContextForController("Knob");

      // Stream Dock knobs have no trigger descriptions; this resolves without
      // touching the client.
      await expect(action.setTriggerDescription({ rotate: "Adjust", push: "Apply" })).resolves.toBeUndefined();
      expect(client.setImage).not.toHaveBeenCalled();
    });
  });

  describe("VSDActionContext image rasterization (#642)", () => {
    const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="#123"/></svg>`;
    const svgUri = svgToDataUri(SVG);

    async function getWillAppearEvent(context: string) {
      const handler: IDeckActionHandler = { onWillAppear: vi.fn() };
      adapter.registerAction("com.test.action", handler);

      const willAppearCall = client.onActionEvent.mock.calls.find(
        (call: [string, string, unknown]) => call[1] === "willAppear",
      );
      await willAppearCall[2]({
        event: "willAppear",
        action: "com.test.action",
        context,
        payload: { settings: {}, controller: "Keypad" },
      });

      return (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
    }

    afterEach(() => {
      _resetRasterizer();
    });

    it("passes SVG data URIs through unchanged when no rasterizer is initialized", async () => {
      const ev = await getWillAppearEvent("ctx-img");
      await ev.action.setImage(svgUri);

      expect(client.setImage).toHaveBeenCalledWith("ctx-img", svgUri);
    });

    it("rasterizes setImage SVG data URIs at the default key size", async () => {
      const rendered: number[] = [];
      initializeRasterizer(async (_svg, px) => {
        rendered.push(px);

        return Buffer.from("png");
      });

      const ev = await getWillAppearEvent("ctx-img");
      await ev.action.setImage(svgUri);

      expect(rendered).toEqual([DEFAULT_KEY_IMAGE_SIZE]);
      expect(client.setImage).toHaveBeenCalledWith(
        "ctx-img",
        `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
      );
    });
  });
});
