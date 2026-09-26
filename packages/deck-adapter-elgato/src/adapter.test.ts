import type StreamDeck from "@elgato/streamdeck";
import {
  _resetGlobalSettings,
  _resetProfileSwitcher,
  _resetRasterizer,
  createMemorySettingsStore,
  getGlobalSettings,
  type IDeckActionHandler,
  initGlobalSettings,
  initializeRasterizer,
  initProfileSwitcher,
  isSettingsStoreReady,
  requestProfileSwitchBack,
  svgToDataUri,
} from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ElgatoPlatformAdapter } from "./adapter.js";

/**
 * Build a minimal mock of the Elgato `streamDeck` singleton sufficient to
 * register a `BridgeAction` and capture it. `registerAction` stores the
 * created instance so tests can drive its SDK event handlers directly.
 */
function createMockStreamDeck() {
  const registered: { instance: { manifestId: string } | null } = { instance: null };

  const sd = {
    logger: {
      createScope: vi.fn(() => ({
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        createScope: vi.fn(),
        setLevel: vi.fn(),
      })),
    },
    settings: {
      onDidReceiveGlobalSettings: vi.fn(),
      getGlobalSettings: vi.fn(),
      setGlobalSettings: vi.fn(),
    },
    system: {
      onApplicationDidLaunch: vi.fn(),
      onApplicationDidTerminate: vi.fn(),
    },
    ui: {
      onDidAppear: vi.fn(),
      onSendToPlugin: vi.fn(),
    },
    actions: {
      registerAction: vi.fn((instance: { manifestId: string }) => {
        registered.instance = instance;
      }),
      onKeyDown: vi.fn(),
      onDialDown: vi.fn(),
      onDialRotate: vi.fn(),
    },
    connect: vi.fn(),
  };

  return { sd, registered };
}

/** A dial action mock exposing the full feedback surface. */
function createMockDialAction(id: string) {
  return {
    id,
    setImage: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
    isKey: vi.fn().mockReturnValue(false),
    isDial: vi.fn().mockReturnValue(true),
    isNeoInfobar: vi.fn().mockReturnValue(false),
    setFeedback: vi.fn().mockResolvedValue(undefined),
    setFeedbackLayout: vi.fn().mockResolvedValue(undefined),
    setTriggerDescription: vi.fn().mockResolvedValue(undefined),
  };
}

/** A key action mock lacking the dial-only feedback methods. */
function createMockKeyAction(id: string) {
  return {
    id,
    setImage: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
    isKey: vi.fn().mockReturnValue(true),
    isNeoInfobar: vi.fn().mockReturnValue(false),
  };
}

describe("ElgatoPlatformAdapter", () => {
  let sd: ReturnType<typeof createMockStreamDeck>["sd"];
  let registered: ReturnType<typeof createMockStreamDeck>["registered"];
  let adapter: ElgatoPlatformAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockStreamDeck();
    sd = mock.sd;
    registered = mock.registered;
    adapter = new ElgatoPlatformAdapter(sd as unknown as ConstructorParameters<typeof ElgatoPlatformAdapter>[0]);
  });

  function registerAndGetBridge<T>(handler: IDeckActionHandler<T>) {
    adapter.registerAction("com.test.action", handler);
    const instance = registered.instance as unknown as Record<string, (ev: unknown) => Promise<void>> & {
      manifestId: string;
    };
    expect(instance).not.toBeNull();

    return instance;
  }

  describe("ElgatoActionContext feedback", () => {
    it("should forward setFeedback to the underlying dial action", async () => {
      const handler: IDeckActionHandler = { onWillAppear: vi.fn() };
      const bridge = registerAndGetBridge(handler);
      const action = createMockDialAction("ctx-dial");

      await bridge.onWillAppear({ action, payload: { settings: {} } });

      const ev = (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      await ev.action.setFeedback({ value: 42 });

      expect(action.setFeedback).toHaveBeenCalledWith({ value: 42 });
    });

    it("should forward setFeedbackLayout to the underlying dial action", async () => {
      const handler: IDeckActionHandler = { onWillAppear: vi.fn() };
      const bridge = registerAndGetBridge(handler);
      const action = createMockDialAction("ctx-dial");

      await bridge.onWillAppear({ action, payload: { settings: {} } });

      const ev = (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      await ev.action.setFeedbackLayout("$B1");

      expect(action.setFeedbackLayout).toHaveBeenCalledWith("$B1");
    });

    it("should forward setTriggerDescription to the underlying dial action", async () => {
      const handler: IDeckActionHandler = { onWillAppear: vi.fn() };
      const bridge = registerAndGetBridge(handler);
      const action = createMockDialAction("ctx-dial");

      await bridge.onWillAppear({ action, payload: { settings: {} } });

      const ev = (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      await ev.action.setTriggerDescription({ rotate: "Adjust", push: "Apply" });

      expect(action.setTriggerDescription).toHaveBeenCalledWith({ rotate: "Adjust", push: "Apply" });
    });

    it("should reflect isDial() from the underlying action", async () => {
      const handler: IDeckActionHandler = { onWillAppear: vi.fn() };
      const bridge = registerAndGetBridge(handler);
      const action = createMockDialAction("ctx-dial");

      await bridge.onWillAppear({ action, payload: { settings: {} } });

      const ev = (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ev.action.isDial()).toBe(true);
    });

    it("should no-op safely when the underlying action lacks feedback methods (key action)", async () => {
      const handler: IDeckActionHandler = { onWillAppear: vi.fn() };
      const bridge = registerAndGetBridge(handler);
      const action = createMockKeyAction("ctx-key");

      await bridge.onWillAppear({ action, payload: { settings: {} } });

      const ev = (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // Should resolve without throwing even though the action has no
      // setFeedback/setFeedbackLayout/setTriggerDescription/isDial.
      await expect(ev.action.setFeedback({ value: 1 })).resolves.toBeUndefined();
      await expect(ev.action.setFeedbackLayout("$B1")).resolves.toBeUndefined();
      await expect(ev.action.setTriggerDescription({ rotate: "Adjust" })).resolves.toBeUndefined();
      expect(ev.action.isDial()).toBe(false);
    });
  });

  describe("Neo Infobar instances (#1208)", () => {
    it("does not hand a Neo Infobar instance to the handler on willAppear or didReceiveSettings", async () => {
      const handler: IDeckActionHandler = { onWillAppear: vi.fn(), onDidReceiveSettings: vi.fn() };
      const bridge = registerAndGetBridge(handler);
      const action = { id: "ctx-infobar", isNeoInfobar: vi.fn().mockReturnValue(true) };

      await bridge.onWillAppear({ action, payload: { settings: {} } });
      await bridge.onDidReceiveSettings({ action, payload: { settings: {} } });

      expect(handler.onWillAppear).not.toHaveBeenCalled();
      expect(handler.onDidReceiveSettings).not.toHaveBeenCalled();
    });

    it("does not hand a Neo Infobar instance to the handler on willDisappear", async () => {
      const handler: IDeckActionHandler = { onWillDisappear: vi.fn() };
      const bridge = registerAndGetBridge(handler);

      await bridge.onWillDisappear({ action: { id: "ctx-infobar", controllerType: "Neo" }, payload: { settings: {} } });
      await bridge.onWillDisappear({ action: { id: "ctx-key", controllerType: "Keypad" }, payload: { settings: {} } });

      expect(handler.onWillDisappear).toHaveBeenCalledTimes(1);
    });

    it("still hands a key instance to the handler on didReceiveSettings", async () => {
      const handler: IDeckActionHandler = { onDidReceiveSettings: vi.fn() };
      const bridge = registerAndGetBridge(handler);

      await bridge.onDidReceiveSettings({ action: createMockKeyAction("ctx-key"), payload: { settings: { a: 1 } } });

      expect(handler.onDidReceiveSettings).toHaveBeenCalledTimes(1);
    });
  });

  describe("onTouchTap", () => {
    it("should delegate to handler.onTouchTap with mapped tapPos and hold", async () => {
      const handler: IDeckActionHandler = { onTouchTap: vi.fn() };
      const bridge = registerAndGetBridge(handler);
      const action = createMockDialAction("ctx-touch");

      await bridge.onTouchTap({
        action,
        payload: {
          settings: { mode: "fuel" },
          tapPos: [12, 34],
          hold: true,
          coordinates: { row: 0, column: 2 },
        },
      });

      expect(handler.onTouchTap).toHaveBeenCalledOnce();
      const ev = (handler.onTouchTap as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ev.action.id).toBe("ctx-touch");
      expect(ev.payload.settings).toEqual({ mode: "fuel" });
      expect(ev.payload.tapPos).toEqual([12, 34]);
      expect(ev.payload.hold).toBe(true);
      expect(ev.payload.coordinates).toEqual({ row: 0, column: 2 });
    });

    it("should not throw when no onTouchTap handler is provided", async () => {
      const bridge = registerAndGetBridge({});
      const action = createMockDialAction("ctx-touch");

      await expect(
        bridge.onTouchTap({ action, payload: { settings: {}, tapPos: [0, 0], hold: false } }),
      ).resolves.toBeUndefined();
    });
  });

  describe("onDialRotate", () => {
    it("should delegate to handler.onDialRotate with ticks", async () => {
      const handler: IDeckActionHandler = { onDialRotate: vi.fn() };
      const bridge = registerAndGetBridge(handler);
      const action = createMockDialAction("ctx-dial");

      await bridge.onDialRotate({ action, payload: { settings: {}, ticks: 4, pressed: true } });

      expect(handler.onDialRotate).toHaveBeenCalledOnce();
      const ev = (handler.onDialRotate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ev.payload.ticks).toBe(4);
      // `pressed` (rotate-while-pressed) passes straight through from the Elgato SDK.
      expect(ev.payload.pressed).toBe(true);
    });
  });

  describe("ElgatoActionContext image rasterization (#642)", () => {
    const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="#123"/></svg>`;
    const svgUri = svgToDataUri(SVG);

    afterEach(() => {
      _resetRasterizer();
    });

    it("passes SVG data URIs through unchanged when no rasterizer is initialized", async () => {
      const handler: IDeckActionHandler = { onWillAppear: vi.fn() };
      const bridge = registerAndGetBridge(handler);
      const action = createMockKeyAction("ctx-key");

      await bridge.onWillAppear({ action, payload: { settings: {} } });

      const ev = (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      await ev.action.setImage(svgUri);

      expect(action.setImage).toHaveBeenCalledWith(svgUri);
    });

    it("rasterizes setImage SVG data URIs to PNG at the device's key size", async () => {
      const rendered: number[] = [];
      initializeRasterizer(async (_svg, px) => {
        rendered.push(px);

        return Buffer.from("png");
      });

      const handler: IDeckActionHandler = { onWillAppear: vi.fn() };
      const bridge = registerAndGetBridge(handler);
      // StreamDeckPlus (device type 7) → 240px key image.
      const action = { ...createMockKeyAction("ctx-key"), device: { id: "dev1", type: 7 } };

      await bridge.onWillAppear({ action, payload: { settings: {} } });

      const ev = (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      await ev.action.setImage(svgUri);

      expect(rendered).toEqual([240]);
      expect(action.setImage).toHaveBeenCalledWith(`data:image/png;base64,${Buffer.from("png").toString("base64")}`);
    });

    it("rasterizes SVG pixmap values in setFeedback at the touch-strip slot width, leaving other values alone", async () => {
      const rendered: number[] = [];
      initializeRasterizer(async (_svg, px) => {
        rendered.push(px);

        return Buffer.from("png");
      });

      const handler: IDeckActionHandler = { onWillAppear: vi.fn() };
      const bridge = registerAndGetBridge(handler);
      const action = createMockDialAction("ctx-dial");

      await bridge.onWillAppear({ action, payload: { settings: {} } });

      const ev = (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      await ev.action.setFeedback({ box: svgUri, title: "FUEL" });

      expect(rendered).toEqual([200]);
      expect(action.setFeedback).toHaveBeenCalledWith({
        box: `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
        title: "FUEL",
      });
    });

    it("forwards an already-rasterized PNG data URI in setFeedback unchanged without invoking the renderer", async () => {
      const render = vi.fn().mockResolvedValue(Buffer.from("png"));
      initializeRasterizer(render);

      const handler: IDeckActionHandler = { onWillAppear: vi.fn() };
      const bridge = registerAndGetBridge(handler);
      const action = createMockDialAction("ctx-dial");

      await bridge.onWillAppear({ action, payload: { settings: {} } });

      const ev = (handler.onWillAppear as ReturnType<typeof vi.fn>).mock.calls[0][0];
      await ev.action.setFeedback({ box: "data:image/png;base64,AAAA" });

      expect(render).not.toHaveBeenCalled();
      expect(action.setFeedback).toHaveBeenCalledWith({ box: "data:image/png;base64,AAAA" });
    });
  });
});

/**
 * Build a minimal Stream Deck SDK mock covering the surfaces the adapter touches.
 * `ui.onSendToPlugin` captures its listener so tests can simulate a PI message.
 */
function createSdMock() {
  let sendToPluginListener: ((ev: unknown) => void) | undefined;

  const errorLog = vi.fn();
  const sd = {
    logger: {
      createScope: vi.fn(() => ({
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: errorLog,
        createScope: vi.fn(),
        setLevel: vi.fn(),
      })),
    },
    system: { openUrl: vi.fn().mockResolvedValue(undefined) },
    profiles: { switchToProfile: vi.fn().mockResolvedValue(undefined) },
    // The settings window names a device explicitly; its type is looked up here (#992).
    devices: { getDeviceById: vi.fn((id: string) => (id === "dev-xl" ? { type: 2 } : undefined)) },
    ui: {
      onSendToPlugin: vi.fn((listener: (ev: unknown) => void) => {
        sendToPluginListener = listener;
      }),
    },
  };

  return {
    sd: sd as unknown as typeof StreamDeck,
    switchToProfile: sd.profiles.switchToProfile,
    openUrl: sd.system.openUrl,
    errorLog,
    /** Simulate a Property Inspector `sendToPlugin` message from the given device (an XL by default). */
    emitSendToPlugin(deviceId: string, payload: unknown, deviceType: number | undefined = 2) {
      sendToPluginListener?.({ action: { device: { id: deviceId, type: deviceType } }, payload });
    },
  };
}

describe("ElgatoPlatformAdapter.openUrl", () => {
  it("delegates to streamDeck.system.openUrl", async () => {
    const { sd, openUrl } = createSdMock();
    const adapter = new ElgatoPlatformAdapter(sd);

    await adapter.openUrl("https://example.test/");

    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("https://example.test/");
  });
});

describe("ElgatoPlatformAdapter.switchToProfile", () => {
  it("delegates to streamDeck.profiles.switchToProfile with device, profile, and page", async () => {
    const { sd, switchToProfile } = createSdMock();
    const adapter = new ElgatoPlatformAdapter(sd);

    await adapter.switchToProfile("dev-1", "iRaceDeck Default", 2);

    expect(switchToProfile).toHaveBeenCalledWith("dev-1", "iRaceDeck Default", 2);
  });
});

describe("ElgatoPlatformAdapter sendToPlugin → switchToProfile routing", () => {
  afterEach(() => {
    _resetProfileSwitcher();
  });

  /** Create the adapter and wire the profile switcher exactly as plugin.ts does. */
  function setup() {
    const mock = createSdMock();
    const adapter = new ElgatoPlatformAdapter(mock.sd);

    initProfileSwitcher((deviceId, profile, page) => adapter.switchToProfile(deviceId, profile, page));

    return mock;
  }

  it("switches profile for the PI's device, resolving the device-suffixed name (#753)", () => {
    const { switchToProfile, emitSendToPlugin } = setup();

    // The accordion sends clean display names; the adapter appends the
    // pressing device's suffix (an XL here).
    emitSendToPlugin("dev-9", { event: "switchToProfile", profile: "iRaceDeck Replay" });

    expect(switchToProfile).toHaveBeenCalledWith("dev-9", "iRaceDeck Replay XL", undefined);
  });

  it("passes an already-suffixed profile name through unchanged", () => {
    const { switchToProfile, emitSendToPlugin } = setup();

    emitSendToPlugin("dev-9", { event: "switchToProfile", profile: "iRaceDeck Replay XL" });

    expect(switchToProfile).toHaveBeenCalledWith("dev-9", "iRaceDeck Replay XL", undefined);
  });

  it("passes the profile name through unchanged when the device has no suffix", () => {
    const { switchToProfile, emitSendToPlugin } = setup();

    // Device type 10 (Studio) has no bundled-profile suffix; 99 is unknown.
    emitSendToPlugin("dev-9", { event: "switchToProfile", profile: "iRaceDeck Replay" }, 10);
    emitSendToPlugin("dev-9", { event: "switchToProfile", profile: "iRaceDeck Default" }, 99);

    expect(switchToProfile).toHaveBeenNthCalledWith(1, "dev-9", "iRaceDeck Replay", undefined);
    expect(switchToProfile).toHaveBeenNthCalledWith(2, "dev-9", "iRaceDeck Default", undefined);
  });

  it("forwards an optional page", () => {
    const { switchToProfile, emitSendToPlugin } = setup();

    emitSendToPlugin("dev-1", { event: "switchToProfile", profile: "iRaceDeck Default", page: 3 });

    expect(switchToProfile).toHaveBeenCalledWith("dev-1", "iRaceDeck Default XL", 3);
  });

  it("defaults the profile to undefined when omitted (returns to the default profile)", () => {
    const { switchToProfile, emitSendToPlugin } = setup();

    emitSendToPlugin("dev-1", { event: "switchToProfile" });

    expect(switchToProfile).toHaveBeenCalledWith("dev-1", undefined, undefined);
  });

  it("switchToBundledProfile logs a rejected SDK switch instead of leaving an unhandled rejection", async () => {
    const { sd, switchToProfile, errorLog } = createSdMock();
    switchToProfile.mockRejectedValueOnce(new Error("device busy"));
    const adapter = new ElgatoPlatformAdapter(sd);
    initProfileSwitcher((deviceId, profile, page) => adapter.switchToProfile(deviceId, profile, page));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      adapter.switchToBundledProfile("dev-xl", "iRaceDeck Default");
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(errorLog).toHaveBeenCalledWith(expect.stringMatching(/Profile switch failed: .*device busy/));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("switchToBundledProfile is the same dispatch for an explicitly named device (the settings window, #992)", async () => {
    const { sd, switchToProfile } = createSdMock();
    const adapter = new ElgatoPlatformAdapter(sd);
    initProfileSwitcher((deviceId, profile, page) => adapter.switchToProfile(deviceId, profile, page));

    adapter.switchToBundledProfile("dev-xl", "iRaceDeck Default");
    adapter.switchToBundledProfile("dev-xl", "iRaceDeck Replay", 2);
    adapter.switchToBundledProfile("dev-unknown", "iRaceDeck Replay");
    await Promise.resolve();

    // Type resolved via the SDK's device store → suffixed like the PI path; unknown device → passed through.
    expect(switchToProfile).toHaveBeenNthCalledWith(1, "dev-xl", "iRaceDeck Default XL", undefined);
    expect(switchToProfile).toHaveBeenNthCalledWith(2, "dev-xl", "iRaceDeck Replay XL", 2);
    expect(switchToProfile).toHaveBeenNthCalledWith(3, "dev-unknown", "iRaceDeck Replay", undefined);
    // Recorded in the history exactly like an accordion switch (#762).
    await requestProfileSwitchBack("dev-xl");
    expect(switchToProfile).toHaveBeenLastCalledWith("dev-xl", "iRaceDeck Default XL", undefined);
  });

  it("records accordion switches in the profile history so Back can walk them (#762)", async () => {
    const { switchToProfile, emitSendToPlugin } = setup();

    emitSendToPlugin("dev-9", { event: "switchToProfile", profile: "iRaceDeck Default" });
    emitSendToPlugin("dev-9", { event: "switchToProfile", profile: "iRaceDeck Replay" });

    await requestProfileSwitchBack("dev-9");

    expect(switchToProfile).toHaveBeenLastCalledWith("dev-9", "iRaceDeck Default XL", undefined);
  });

  it("ignores unrelated events and non-object payloads", () => {
    const { switchToProfile, emitSendToPlugin } = setup();

    emitSendToPlugin("dev-1", { event: "somethingElse" });
    emitSendToPlugin("dev-1", "not-an-object");
    emitSendToPlugin("dev-1", null);
    emitSendToPlugin("dev-1", ["array"]);

    expect(switchToProfile).not.toHaveBeenCalled();
  });
});

describe("ElgatoPlatformAdapter sendToPlugin → openSettings routing (#992)", () => {
  it("invokes the registered listener when the PI sends an openSettings command", () => {
    const { sd, emitSendToPlugin } = createSdMock();
    const adapter = new ElgatoPlatformAdapter(sd);
    const listener = vi.fn();

    adapter.onOpenSettingsRequest(listener);
    emitSendToPlugin("dev-1", { event: "openSettings" });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not invoke the openSettings listener for other commands", () => {
    const { sd, emitSendToPlugin } = createSdMock();
    const adapter = new ElgatoPlatformAdapter(sd);
    const listener = vi.fn();

    adapter.onOpenSettingsRequest(listener);
    emitSendToPlugin("dev-1", { event: "switchToProfile", profile: "iRaceDeck Default" });

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("ElgatoPlatformAdapter global settings read (#1208)", () => {
  /**
   * The SDK 3.0 shape: `getGlobalSettings()` returns a promise carrying the
   * answer, and `onDidReceiveGlobalSettings` fires only for a PI's save.
   */
  function createSettingsMock(read: () => Promise<unknown>) {
    let sdkListener: ((ev: { settings: unknown }) => void) | undefined;
    const errorLog = vi.fn();
    const sd = {
      logger: {
        createScope: vi.fn(() => ({
          trace: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: errorLog,
          createScope: vi.fn(),
          setLevel: vi.fn(),
        })),
      },
      settings: {
        onDidReceiveGlobalSettings: vi.fn((listener: (ev: { settings: unknown }) => void) => {
          sdkListener = listener;
        }),
        getGlobalSettings: vi.fn(read),
        setGlobalSettings: vi.fn(),
      },
      ui: { onSendToPlugin: vi.fn() },
    };

    return {
      sd: sd as unknown as typeof StreamDeck,
      read: sd.settings.getGlobalSettings,
      errorLog,
      /** Simulate a Property Inspector saving global settings. */
      emitPiSave(settings: unknown) {
        expect(sdkListener).toBeDefined();
        sdkListener!({ settings });
      },
    };
  }

  it("delivers the read's answer to the subscriber exactly once", async () => {
    const { sd, read } = createSettingsMock(() => Promise.resolve({ focusIRacingWindow: true }));
    const adapter = new ElgatoPlatformAdapter(sd);
    const callback = vi.fn();

    adapter.onDidReceiveGlobalSettings(callback);
    adapter.getGlobalSettings();
    await vi.waitFor(() => expect(callback).toHaveBeenCalled());
    await Promise.resolve();

    expect(read).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ focusIRacingWindow: true });
  });

  it("delivers the answer to every subscriber", async () => {
    const { sd } = createSettingsMock(() => Promise.resolve({ a: 1 }));
    const adapter = new ElgatoPlatformAdapter(sd);
    const first = vi.fn();
    const second = vi.fn();

    adapter.onDidReceiveGlobalSettings(first);
    adapter.onDidReceiveGlobalSettings(second);
    adapter.getGlobalSettings();
    await vi.waitFor(() => expect(second).toHaveBeenCalled());

    expect(first).toHaveBeenCalledExactlyOnceWith({ a: 1 });
    expect(second).toHaveBeenCalledExactlyOnceWith({ a: 1 });
  });

  it("still forwards a Property Inspector save through the event", () => {
    const { sd, emitPiSave } = createSettingsMock(() => new Promise(() => {}));
    const adapter = new ElgatoPlatformAdapter(sd);
    const callback = vi.fn();

    adapter.onDidReceiveGlobalSettings(callback);
    emitPiSave({ debugLogging: true });

    expect(callback).toHaveBeenCalledExactlyOnceWith({ debugLogging: true });
  });

  it("logs a rejected read instead of leaving an unhandled rejection", async () => {
    const { sd, errorLog } = createSettingsMock(() => Promise.reject(new Error("socket closed")));
    const adapter = new ElgatoPlatformAdapter(sd);
    const callback = vi.fn();

    adapter.onDidReceiveGlobalSettings(callback);
    adapter.getGlobalSettings();
    await vi.waitFor(() => expect(errorLog).toHaveBeenCalled());

    expect(errorLog.mock.calls[0][0]).toContain("socket closed");
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("Elgato fresh-install migration through the SDK 3.0 read path (#1208)", () => {
  afterEach(() => {
    _resetGlobalSettings();
  });

  it("migrates the host's settings exactly once, and a later PI save echo is not ingested", async () => {
    let sdkListener: ((ev: { settings: unknown }) => void) | undefined;
    const hostSettings = {
      driverName: "host-nick",
      blackBoxLapTiming: JSON.stringify({ type: "keyboard", key: "f1", modifiers: [] }),
    };
    const sd = {
      logger: {
        createScope: vi.fn(() => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
      },
      settings: {
        // SDK 3.0: the event carries PI saves only; the read's reply goes to the promise.
        onDidReceiveGlobalSettings: vi.fn((listener: (ev: { settings: unknown }) => void) => {
          sdkListener = listener;
        }),
        getGlobalSettings: vi.fn(() => Promise.resolve({ ...hostSettings })),
        setGlobalSettings: vi.fn(),
      },
      ui: { onSendToPlugin: vi.fn() },
    };
    const adapter = new ElgatoPlatformAdapter(sd as unknown as typeof StreamDeck);
    const info = vi.fn();
    const log = {
      trace: vi.fn(),
      debug: vi.fn(),
      info,
      warn: vi.fn(),
      error: vi.fn(),
      createScope: vi.fn(),
    } as unknown as ILogger;
    const store = createMemorySettingsStore(); // no settings file: a fresh install of the file-backed store

    initGlobalSettings(adapter, log, store, { migrationTimeoutMs: 5_000 });
    await vi.waitFor(() => expect(isSettingsStoreReady()).toBe(true));

    expect(sd.settings.getGlobalSettings).toHaveBeenCalledTimes(1);
    expect(info.mock.calls.filter(([line]) => line === "Settings received from host for migration")).toHaveLength(1);
    expect(getGlobalSettings().driverName).toBe("host-nick");
    expect(store.saved.at(-1)).toMatchObject(hostSettings);

    const savesAfterMigration = store.saved.length;

    expect(sdkListener).toBeDefined();
    sdkListener!({ settings: { driverName: "pi-echo" } });

    expect(getGlobalSettings().driverName).toBe("host-nick");
    expect(store.saved).toHaveLength(savesAfterMigration);
  });
});

/**
 * A model of SDK 3.0's settings module, close enough to its `settings.js` to
 * exercise the double-delivery edge: every host frame resolves every pending
 * read (`connection.once`, uncorrelated), and only a frame WITHOUT a request id
 * reaches the event (a PI's save). Both are handed the frame's own
 * `payload.settings` object, the event listener first.
 */
function createSdkModel() {
  const eventListeners: Array<(ev: { settings: unknown }) => void> = [];
  let pending: Array<(settings: unknown) => void> = [];
  const errorLog = vi.fn();
  const info = vi.fn();
  const sd = {
    logger: {
      createScope: vi.fn(() => ({ trace: vi.fn(), debug: vi.fn(), info, warn: vi.fn(), error: errorLog })),
    },
    settings: {
      onDidReceiveGlobalSettings: vi.fn((listener: (ev: { settings: unknown }) => void) => {
        eventListeners.push(listener);
      }),
      getGlobalSettings: vi.fn(() => new Promise<unknown>((resolve) => pending.push(resolve))),
      setGlobalSettings: vi.fn(),
    },
    ui: { onSendToPlugin: vi.fn() },
  };

  function frame(settings: unknown, hasRequestId: boolean): void {
    if (!hasRequestId) for (const listener of eventListeners) listener({ settings });

    const waiting = pending;

    pending = [];

    for (const resolve of waiting) resolve(settings);
  }

  return {
    sd: sd as unknown as typeof StreamDeck,
    sdkSubscriptions: () => eventListeners.length,
    errorLog,
    /** The host's reply to a read (carries the request id: promise only). */
    reply: (settings: unknown) => frame(settings, true),
    /** A Property Inspector's save (no id: the event, and any pending read). */
    piSave: (settings: unknown) => frame(settings, false),
  };
}

/** Let resolved promises' handlers run. */
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ElgatoPlatformAdapter global settings fan-out against the SDK 3.0 model (#1208)", () => {
  it("subscribes to the SDK event once however many subscribers there are", () => {
    const model = createSdkModel();
    const adapter = new ElgatoPlatformAdapter(model.sd);

    adapter.onDidReceiveGlobalSettings(vi.fn());
    adapter.onDidReceiveGlobalSettings(vi.fn());

    expect(model.sdkSubscriptions()).toBe(1);
  });

  it("delivers a read's reply once", async () => {
    const model = createSdkModel();
    const adapter = new ElgatoPlatformAdapter(model.sd);
    const callback = vi.fn();

    adapter.onDidReceiveGlobalSettings(callback);
    adapter.getGlobalSettings();
    model.reply({ driverName: "host" });
    await flushMicrotasks();

    expect(callback).toHaveBeenCalledExactlyOnceWith({ driverName: "host" });
  });

  it("delivers an empty reply that arrives before any event", async () => {
    const model = createSdkModel();
    const adapter = new ElgatoPlatformAdapter(model.sd);
    const callback = vi.fn();

    adapter.onDidReceiveGlobalSettings(callback);
    adapter.getGlobalSettings();
    model.reply(undefined);
    await flushMicrotasks();

    expect(callback).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("delivers a PI save that lands while a read is pending once, not once per path", async () => {
    const model = createSdkModel();
    const adapter = new ElgatoPlatformAdapter(model.sd);
    const callback = vi.fn();

    adapter.onDidReceiveGlobalSettings(callback);
    adapter.getGlobalSettings();
    model.piSave({ debugLogging: true });
    await flushMicrotasks();

    expect(callback).toHaveBeenCalledExactlyOnceWith({ debugLogging: true });
  });

  it("still delivers a genuine reply that follows an earlier PI save", async () => {
    const model = createSdkModel();
    const adapter = new ElgatoPlatformAdapter(model.sd);
    const callback = vi.fn();

    adapter.onDidReceiveGlobalSettings(callback);
    model.piSave({ a: 1 });
    adapter.getGlobalSettings();
    model.reply({ a: 1 }); // equal, but a different frame
    await flushMicrotasks();

    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("logs a throwing subscriber and still delivers to the others, on both paths", async () => {
    const model = createSdkModel();
    const adapter = new ElgatoPlatformAdapter(model.sd);
    const after = vi.fn();

    adapter.onDidReceiveGlobalSettings(() => {
      throw new Error("listener blew up");
    });
    adapter.onDidReceiveGlobalSettings(after);

    adapter.getGlobalSettings();
    model.reply({ a: 1 });
    await flushMicrotasks();
    model.piSave({ b: 2 });

    expect(after).toHaveBeenNthCalledWith(1, { a: 1 });
    expect(after).toHaveBeenNthCalledWith(2, { b: 2 });
    expect(model.errorLog).toHaveBeenCalledTimes(2);
    expect(model.errorLog.mock.calls[0][0]).toContain("listener blew up");
  });
});

describe("Elgato migration when a PI save lands while the read is pending (#1208)", () => {
  afterEach(() => {
    _resetGlobalSettings();
  });

  it("takes the first payload as the answer once and asks nothing more", async () => {
    const model = createSdkModel();
    const adapter = new ElgatoPlatformAdapter(model.sd);
    const info = vi.fn();
    const log = {
      trace: vi.fn(),
      debug: vi.fn(),
      info,
      warn: vi.fn(),
      error: vi.fn(),
      createScope: vi.fn(),
    } as unknown as ILogger;
    const store = createMemorySettingsStore();

    initGlobalSettings(adapter, log, store, { migrationTimeoutMs: 5_000 });
    await vi.waitFor(() => expect(model.sd.settings.getGlobalSettings).toHaveBeenCalledTimes(1));

    model.piSave({ driverName: "pi-save" });
    await vi.waitFor(() => expect(isSettingsStoreReady()).toBe(true));
    model.reply({ driverName: "late-reply" });
    await flushMicrotasks();

    expect(info.mock.calls.filter(([line]) => line === "Settings received from host for migration")).toHaveLength(1);
    expect(getGlobalSettings().driverName).toBe("pi-save");
    expect(model.sd.settings.getGlobalSettings).toHaveBeenCalledTimes(1);
  });
});
