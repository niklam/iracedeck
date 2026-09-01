import {
  _resetRasterizer,
  DEFAULT_KEY_IMAGE_SIZE,
  type IDeckActionHandler,
  initializeRasterizer,
  svgToDataUri,
} from "@iracedeck/deck-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UlanziPlatformAdapter } from "./adapter.js";

// Store mock instances so tests can inspect them
const mockInstances: Array<Record<string, ReturnType<typeof vi.fn>>> = [];

// Mock UlanziClient — factory must not reference variables defined after vi.mock
vi.mock("./ulanzi-client.js", () => ({
  parseConnectionParams: () => ({ address: "127.0.0.1", port: "3906", language: "en" }),
  PLUGIN_UUID: "com.iracedeck.sd.core",
  UlanziClient: class {
    onActionEvent = vi.fn();
    onGlobalEvent = vi.fn();
    connect = vi.fn();
    requestGlobalSettings = vi.fn();
    onHostReady = vi.fn();
    setGlobalSettings = vi.fn();
    openUrl = vi.fn();
    setImage = vi.fn();
    setSettings = vi.fn();

    constructor() {
      mockInstances.push(this as unknown as Record<string, ReturnType<typeof vi.fn>>);
    }
  },
}));

describe("UlanziPlatformAdapter", () => {
  let adapter: UlanziPlatformAdapter;
  let client: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstances.length = 0;
    adapter = new UlanziPlatformAdapter();
    client = mockInstances[0];
  });

  describe("connect", () => {
    it("should delegate to UlanziClient.connect", () => {
      adapter.connect();
      expect(client.connect).toHaveBeenCalledOnce();
    });
  });

  describe("getGlobalSettings", () => {
    it("should delegate to UlanziClient.requestGlobalSettings", () => {
      adapter.getGlobalSettings();
      expect(client.requestGlobalSettings).toHaveBeenCalledOnce();
    });
  });

  describe("onHostReady (#1056)", () => {
    it("delegates to the client, so deck-core can restart the migration deadline from the connect", () => {
      const callback = vi.fn();

      adapter.onHostReady(callback);

      expect(client.onHostReady).toHaveBeenCalledWith(callback);
    });
  });

  describe("setGlobalSettings (#993: no write gate)", () => {
    it("forwards immediately — the plugin owns the settings store, so an early write can no longer wipe anything", () => {
      adapter.setGlobalSettings({ _settingsChannel: { port: 1, token: "t" } });

      expect(client.setGlobalSettings).toHaveBeenCalledWith({ _settingsChannel: { port: 1, token: "t" } });
    });
  });

  describe("openUrl", () => {
    it("should delegate to UlanziClient.openUrl", async () => {
      await adapter.openUrl("https://example.test/");
      expect(client.openUrl).toHaveBeenCalledWith("https://example.test/");
    });
  });

  // The Ulanzi PI bridge relays external-link clicks as a `sendToPlugin` openUrl
  // marker (the host ignores `openurl` sent on the PI socket, #845); the adapter
  // forwards them out the plugin socket, which the host honours.
  describe("PI openUrl relay", () => {
    const openUrlHandler = () => client.onGlobalEvent.mock.calls.find((call) => call[0] === "openUrl")?.[1];

    it("registers a global openUrl handler on construction", () => {
      expect(client.onGlobalEvent).toHaveBeenCalledWith("openUrl", expect.any(Function));
    });

    it("forwards the relayed url out the plugin socket via client.openUrl", () => {
      openUrlHandler()({ event: "openUrl", action: "u", context: "u___5___a", payload: { url: "https://x/" } });

      expect(client.openUrl).toHaveBeenCalledWith("https://x/");
    });

    it("ignores a relay without a usable url", () => {
      openUrlHandler()({ event: "openUrl", action: "u", context: "u___5___a", payload: {} });

      expect(client.openUrl).not.toHaveBeenCalled();
    });

    it("forwards only http(s) urls — other schemes and malformed urls are dropped", () => {
      for (const url of ["javascript:alert(1)", "file:///C:/Windows/system.ini", "app://open", "not a url", "   "]) {
        openUrlHandler()({ event: "openUrl", action: "u", context: "u___5___a", payload: { url } });
      }

      expect(client.openUrl).not.toHaveBeenCalled();
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

      const handler = client.onGlobalEvent.mock.calls.find((call) => call[0] === "didReceiveGlobalSettings")?.[1];
      handler({ event: "didReceiveGlobalSettings", payload: { settings: { key: "value" } } });

      expect(callback).toHaveBeenCalledWith({ key: "value" });
    });

    it("forwards a pre-settle action-scoped reply (boot bootstrap fallback)", () => {
      // Before any plugin-scoped reply has arrived, an action-scoped reply is
      // the only data the boot bootstrap read can produce — forward it (#868).
      const callback = vi.fn();
      adapter.onDidReceiveGlobalSettings(callback);

      const handler = client.onGlobalEvent.mock.calls.find((call) => call[0] === "didReceiveGlobalSettings")?.[1];
      handler({ event: "didReceiveGlobalSettings", action: "com.test.action", payload: { settings: { a: 1 } } });

      expect(callback).toHaveBeenCalledWith({ a: 1 });
    });

    it("drops an action-scoped reply after a non-empty plugin-scoped reply has been applied", () => {
      // A late action-scoped reply carries a per-action bucket's stale
      // contents — it must not clobber authoritative plugin-scoped data (#868).
      const callback = vi.fn();
      adapter.onDidReceiveGlobalSettings(callback);

      const handler = client.onGlobalEvent.mock.calls.find((call) => call[0] === "didReceiveGlobalSettings")?.[1];
      handler({
        event: "didReceiveGlobalSettings",
        action: "com.iracedeck.sd.core",
        payload: { settings: { debugLogging: true } },
      });
      handler({ event: "didReceiveGlobalSettings", action: "com.test.action", payload: { settings: { stale: 1 } } });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({ debugLogging: true });
    });

    it("keeps forwarding plugin-scoped replies after settling", () => {
      const callback = vi.fn();
      adapter.onDidReceiveGlobalSettings(callback);

      const handler = client.onGlobalEvent.mock.calls.find((call) => call[0] === "didReceiveGlobalSettings")?.[1];
      handler({ event: "didReceiveGlobalSettings", payload: { settings: { debugLogging: true } } });
      handler({ event: "didReceiveGlobalSettings", payload: { settings: { debugLogging: false } } });

      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenLastCalledWith({ debugLogging: false });
    });
  });

  describe("global-settings willAppear re-drive — a fallback since #1041 (#868)", () => {
    const willAppear = () =>
      client.onActionEvent.mock.calls.find((call: [string, string, unknown]) => call[1] === "willAppear")?.[2] as (
        data: unknown,
      ) => Promise<void>;

    const globalSettingsHandler = () =>
      client.onGlobalEvent.mock.calls.find((call) => call[0] === "didReceiveGlobalSettings")?.[1];

    it("re-requests global settings with the first appearing action's context when no reply has arrived", async () => {
      // The connect-time read is addressed and answered since #1041, so in the
      // field a reply has always arrived before any key appears and this is
      // skipped. It stays for a host that ever stopped echoing an actionid it
      // has never seen, where a real action context is the one shape left.
      adapter.registerAction("com.test.action", {});

      await willAppear()({
        event: "willAppear",
        action: "com.test.action",
        context: "com.test.action___5___abc",
        payload: { settings: {} },
      });

      expect(client.requestGlobalSettings).toHaveBeenCalledWith("com.test.action___5___abc");
    });

    it("bootstraps only once even when more actions appear", async () => {
      adapter.registerAction("com.test.action", {});

      await willAppear()({ event: "willAppear", action: "com.test.action", context: "c1", payload: { settings: {} } });
      await willAppear()({ event: "willAppear", action: "com.test.action", context: "c2", payload: { settings: {} } });

      expect(client.requestGlobalSettings).toHaveBeenCalledTimes(1);
    });

    it("does not bootstrap once a global-settings reply has arrived", async () => {
      adapter.registerAction("com.test.action", {});
      globalSettingsHandler()({ event: "didReceiveGlobalSettings", payload: { settings: { debugLogging: true } } });

      await willAppear()({ event: "willAppear", action: "com.test.action", context: "c1", payload: { settings: {} } });

      expect(client.requestGlobalSettings).not.toHaveBeenCalled();
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

      const handler = client.onGlobalEvent.mock.calls.find((call) => call[0] === "applicationDidLaunch")?.[1];
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

      const handler = client.onGlobalEvent.mock.calls.find((call) => call[0] === "propertyInspectorDidAppear")?.[1];
      handler({ event: "propertyInspectorDidAppear", action: "com.test.action", context: "abc" });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith();
    });
  });

  describe("onOpenSettingsRequest (#992)", () => {
    it("registers a global handler for the normalized openSettings event", () => {
      adapter.onOpenSettingsRequest(vi.fn());

      expect(client.onGlobalEvent).toHaveBeenCalledWith("openSettings", expect.any(Function));
    });

    it("invokes the listener when the openSettings event arrives", () => {
      const listener = vi.fn();
      adapter.onOpenSettingsRequest(listener);

      const handler = client.onGlobalEvent.mock.calls.find((call) => call[0] === "openSettings")?.[1];
      handler({ event: "openSettings", action: "com.iracedeck.sd.core.car-control", context: "abc" });

      expect(listener).toHaveBeenCalledTimes(1);
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
      const handler: IDeckActionHandler = { onWillAppear: vi.fn() };
      adapter.registerAction("com.test.action", handler);

      const willAppearCall = client.onActionEvent.mock.calls.find(
        (call: [string, string, unknown]) => call[1] === "willAppear",
      );

      await willAppearCall[2]({
        event: "willAppear",
        action: "com.test.action",
        context: "com.test.action___5___abc",
        payload: { settings: { mode: "direct" } },
      });

      expect(handler.onWillAppear).toHaveBeenCalledOnce();
      const ev = (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ev.action.id).toBe("com.test.action___5___abc");
      expect(ev.payload.settings).toEqual({ mode: "direct" });
    });

    it("should call handler.onKeyDown with wrapped event", async () => {
      const handler: IDeckActionHandler = { onKeyDown: vi.fn() };
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
      const handler: IDeckActionHandler = { onDialRotate: vi.fn() };
      adapter.registerAction("com.test.action", handler);

      const dialRotateCall = client.onActionEvent.mock.calls.find(
        (call: [string, string, unknown]) => call[1] === "dialRotate",
      );

      await dialRotateCall[2]({
        event: "dialRotate",
        action: "com.test.action",
        context: "ctx-789",
        payload: { settings: {}, ticks: -1, pressed: true },
      });

      expect(handler.onDialRotate).toHaveBeenCalledOnce();
      const ev = (handler.onDialRotate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ev.payload.ticks).toBe(-1);
      expect(ev.payload.pressed).toBe(true);
    });

    it("defaults onDialRotate pressed to false when the frame omits it", async () => {
      const handler: IDeckActionHandler = { onDialRotate: vi.fn() };
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
      const handler: IDeckActionHandler = { onWillDisappear: vi.fn() };
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
      // setImage should be a no-op that does not delegate to UlanziClient
      client.setImage.mockClear();
      await ev.action.setImage("test");
      await ev.action.setTitle("test");
      expect(client.setImage).not.toHaveBeenCalled();
    });

    it("reflects the tracked controller type in willDisappear isKey()", async () => {
      const handler: IDeckActionHandler = { onWillAppear: vi.fn(), onWillDisappear: vi.fn() };
      adapter.registerAction("com.test.action", handler);
      const find = (event: string) =>
        client.onActionEvent.mock.calls.find((call: [string, string, unknown]) => call[1] === event)[2];

      // willAppear tracks the Encoder controller for this context...
      await find("willAppear")({
        event: "willAppear",
        action: "com.test.action",
        context: "ctx",
        payload: { settings: {}, controller: "Encoder" },
      });
      // ...so willDisappear's isKey() reflects it (Encoder → not a key).
      await find("willDisappear")({
        event: "willDisappear",
        action: "com.test.action",
        context: "ctx",
        payload: { settings: {} },
      });

      const ev = (handler.onWillDisappear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ev.action.isKey()).toBe(false);
    });

    it("deletes controller tracking even when onWillDisappear throws", async () => {
      const handler: IDeckActionHandler = {
        onWillAppear: vi.fn(),
        onWillDisappear: vi.fn().mockRejectedValue(new Error("boom")),
        onKeyDown: vi.fn(),
      };
      adapter.registerAction("com.test.action", handler);
      const find = (event: string) =>
        client.onActionEvent.mock.calls.find((call: [string, string, unknown]) => call[1] === event)[2];

      await find("willAppear")({
        event: "willAppear",
        action: "com.test.action",
        context: "ctx",
        payload: { settings: {}, controller: "Encoder" },
      });
      await expect(
        find("willDisappear")({
          event: "willDisappear",
          action: "com.test.action",
          context: "ctx",
          payload: { settings: {} },
        }),
      ).rejects.toThrow("boom");

      // The finally cleared the cache → a later event for the same context defaults to
      // Keypad (it would still report Encoder if cleanup were skipped on throw).
      await find("keyDown")({
        event: "keyDown",
        action: "com.test.action",
        context: "ctx",
        payload: { settings: {} },
      });
      const keyEv = (handler.onKeyDown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(keyEv.action.isKey()).toBe(true);
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
      await keyDownCall[2]({ event: "keyDown", action: "com.test.action", context: "ctx", payload: { settings: {} } });

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

  describe("UlanziActionContext", () => {
    const fireWillAppear = async (context: string, controller?: string) => {
      const handler: IDeckActionHandler = { onWillAppear: vi.fn() };
      adapter.registerAction("com.test.action", handler);

      const willAppearCall = client.onActionEvent.mock.calls.find(
        (call: [string, string, unknown]) => call[1] === "willAppear",
      );
      await willAppearCall[2]({
        event: "willAppear",
        action: "com.test.action",
        context,
        payload: { settings: {}, controller },
      });

      return (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
    };

    it("should delegate setImage to UlanziClient", async () => {
      const ev = await fireWillAppear("ctx-img");
      await ev.action.setImage("data:image/svg+xml,test");

      expect(client.setImage).toHaveBeenCalledWith("ctx-img", "data:image/svg+xml,test");
    });

    it("should treat setTitle as a no-op (Ulanzi has no native title)", async () => {
      const ev = await fireWillAppear("ctx-title");
      await expect(ev.action.setTitle("Hello")).resolves.toBeUndefined();
      // No client method exists for titles — nothing is sent.
      expect(client.setImage).not.toHaveBeenCalled();
      expect(client.setSettings).not.toHaveBeenCalled();
    });

    it("should delegate setSettings to UlanziClient", async () => {
      const ev = await fireWillAppear("ctx-set");
      await ev.action.setSettings({ mode: "next" });

      expect(client.setSettings).toHaveBeenCalledWith("ctx-set", { mode: "next" });
    });

    it("should return isKey=true for the default (Keypad) controller", async () => {
      const ev = await fireWillAppear("ctx-key");
      expect(ev.action.isKey()).toBe(true);
    });

    it("should return isKey=true for Information controller", async () => {
      const ev = await fireWillAppear("ctx-info", "Information");
      expect(ev.action.isKey()).toBe(true);
    });

    it("should return isKey=false for Encoder controller", async () => {
      const ev = await fireWillAppear("ctx-enc", "Encoder");
      expect(ev.action.isKey()).toBe(false);
    });
  });

  describe("UlanziActionContext image rasterization (#642)", () => {
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
