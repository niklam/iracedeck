import type StreamDeck from "@elgato/streamdeck";
import type { IDeckActionHandler } from "@iracedeck/deck-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
});

describe("ElgatoPlatformAdapter.openUrl", () => {
  it("should delegate to streamDeck.system.openUrl", async () => {
    const sdMock = {
      system: { openUrl: vi.fn().mockResolvedValue(undefined) },
    } as unknown as typeof StreamDeck;

    const adapter = new ElgatoPlatformAdapter(sdMock);
    await adapter.openUrl("https://example.test/");

    expect(sdMock.system.openUrl).toHaveBeenCalledTimes(1);
    expect(sdMock.system.openUrl).toHaveBeenCalledWith("https://example.test/");
  });
});
