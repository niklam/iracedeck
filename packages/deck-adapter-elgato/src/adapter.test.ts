import type StreamDeck from "@elgato/streamdeck";
import {
  _resetProfileSwitcher,
  _resetRasterizer,
  type IDeckActionHandler,
  initializeRasterizer,
  initProfileSwitcher,
  requestProfileSwitchBack,
  svgToDataUri,
} from "@iracedeck/deck-core";
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

  const sd = {
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
