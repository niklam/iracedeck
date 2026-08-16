import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSettingsWindowBridge,
  readSettingsWindowIdentity,
  SETTINGS_WINDOW_ACTION,
  SETTINGS_WINDOW_FLAG,
} from "./index.js";

/** Fake native WebSocket capturing the URL it was opened with. */
class FakeNativeWebSocket {
  static instances: FakeNativeWebSocket[] = [];
  readonly url: string;
  private listeners: Record<string, Array<() => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeNativeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  /** 0 CONNECTING → 1 OPEN on "open", 3 CLOSED on "close" — like the real thing. */
  readyState = 0;

  fire(type: string): void {
    if (type === "open") this.readyState = 1;

    if (type === "close") this.readyState = 3;

    for (const fn of this.listeners[type] ?? []) fn();
  }

  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}
}

beforeEach(() => {
  FakeNativeWebSocket.instances = [];
});

describe("readSettingsWindowIdentity", () => {
  it("reads the token from the page URL", () => {
    expect(readSettingsWindowIdentity("?t=abc123")).toEqual({ token: "abc123" });
  });

  it("yields an empty token when none is present", () => {
    expect(readSettingsWindowIdentity("")).toEqual({ token: "" });
  });
});

describe("installSettingsWindowBridge", () => {
  function fakeWindow(search: string, host = "127.0.0.1:61708") {
    const connect = vi.fn();
    const close = vi.fn();
    const win = {
      location: { search, host },
      WebSocket: FakeNativeWebSocket,
      connectElgatoStreamDeckSocket: connect,
      close,
      closed: false,
      setTimeout: (fn: () => void) => {
        fn();

        return 0;
      },
      clearTimeout: () => {},
      // The bounds watcher polls; capture the tick so tests drive it by hand.
      tick: undefined as (() => void) | undefined,
      setInterval(fn: () => void) {
        this.tick = fn;

        return 1;
      },
      clearInterval: () => {},
      outerWidth: 1300,
      outerHeight: 900,
      screenX: 40,
      screenY: 60,
      listeners: {} as Record<string, Array<() => void>>,
      addEventListener(type: string, fn: () => void) {
        (this.listeners[type] ??= []).push(fn);
      },
      fire(type: string) {
        for (const fn of this.listeners[type] ?? []) fn();
      },
      document: { body: { appendChild: vi.fn() }, createElement: () => ({ style: {}, textContent: "" }) },
    };

    return {
      win: win as unknown as Window & typeof globalThis & { fire: (t: string) => void; tick?: () => void },
      connect,
      close,
    };
  }

  it("redirects sdpi's socket to the same host with the launch token, then restores WebSocket", () => {
    const { win, connect } = fakeWindow("?t=tok");

    // sdpi's connect() would do `new WebSocket("ws://localhost:<port>")` synchronously.
    connect.mockImplementation((port: string) => {
      new (win as unknown as { WebSocket: typeof FakeNativeWebSocket }).WebSocket(`ws://localhost:${port}`);
    });

    installSettingsWindowBridge(win);

    expect(FakeNativeWebSocket.instances).toHaveLength(1);
    expect(FakeNativeWebSocket.instances[0]?.url).toBe("ws://127.0.0.1:61708/ws?t=tok");
    expect((win as unknown as { WebSocket: unknown }).WebSocket).toBe(FakeNativeWebSocket);
  });

  it("drives connectElgatoStreamDeckSocket with a synthetic settings-window identity", () => {
    const { win, connect } = fakeWindow("?t=tok");

    installSettingsWindowBridge(win);

    expect(connect).toHaveBeenCalledTimes(1);
    const [port, context, registerEvent, , actionInfo] = connect.mock.calls[0] as string[];

    expect(port).toBe("61708");
    expect(typeof context).toBe("string");
    expect(registerEvent).toBe("registerPropertyInspector");
    expect(JSON.parse(actionInfo ?? "{}")).toMatchObject({ action: SETTINGS_WINDOW_ACTION, payload: { settings: {} } });
  });

  it("closes the window when the plugin's socket closes — the plugin (or the deck host) has gone away", () => {
    const { win, connect, close } = fakeWindow("?t=tok");

    connect.mockImplementation((port: string) => {
      new (win as unknown as { WebSocket: typeof FakeNativeWebSocket }).WebSocket(`ws://localhost:${port}`);
    });
    installSettingsWindowBridge(win);

    FakeNativeWebSocket.instances[0]?.fire("close");

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("marks the page as the settings window so shared components can adapt (SimHub proxy)", () => {
    const { win } = fakeWindow("?t=tok");

    installSettingsWindowBridge(win);

    expect((win as unknown as Record<string, unknown>)[SETTINGS_WINDOW_FLAG]).toBe(true);
  });

  function boundsFrames(socket: FakeNativeWebSocket | undefined): unknown[] {
    return (socket?.sent ?? [])
      .map((f) => JSON.parse(f) as { event: string; payload: { event?: string } })
      .filter((f) => f.event === "sendToPlugin" && f.payload.event === "windowBounds")
      .map((f) => f.payload);
  }

  it("reports the window's outer bounds when they change — a MOVE has no DOM event, so it polls", () => {
    const { win, connect } = fakeWindow("?t=tok");

    connect.mockImplementation((port: string) => {
      new (win as unknown as { WebSocket: typeof FakeNativeWebSocket }).WebSocket(`ws://localhost:${port}`);
    });
    installSettingsWindowBridge(win);
    const socket = FakeNativeWebSocket.instances[0];

    socket?.fire("open");
    win.tick?.(); // first tick: nothing changed since load → no report
    expect(boundsFrames(socket)).toEqual([]);

    (win as unknown as { screenX: number }).screenX = 400; // user dragged the window
    win.tick?.();

    expect(boundsFrames(socket)).toEqual([{ event: "windowBounds", width: 1300, height: 900, x: 400, y: 60 }]);
  });

  it("does not repeat a report while nothing changes", () => {
    const { win, connect } = fakeWindow("?t=tok");

    connect.mockImplementation((port: string) => {
      new (win as unknown as { WebSocket: typeof FakeNativeWebSocket }).WebSocket(`ws://localhost:${port}`);
    });
    installSettingsWindowBridge(win);
    const socket = FakeNativeWebSocket.instances[0];

    socket?.fire("open");
    (win as unknown as { outerWidth: number }).outerWidth = 1400;
    win.tick?.();
    win.tick?.();
    win.tick?.();

    expect(boundsFrames(socket)).toHaveLength(1);
  });

  it("sends a final report on pagehide so a move right before closing is kept", () => {
    const { win, connect } = fakeWindow("?t=tok");

    connect.mockImplementation((port: string) => {
      new (win as unknown as { WebSocket: typeof FakeNativeWebSocket }).WebSocket(`ws://localhost:${port}`);
    });
    installSettingsWindowBridge(win);
    const socket = FakeNativeWebSocket.instances[0];

    socket?.fire("open");
    (win as unknown as { screenY: number }).screenY = 300;
    win.fire("pagehide");

    expect(boundsFrames(socket)).toEqual([{ event: "windowBounds", width: 1300, height: 900, x: 40, y: 300 }]);
  });

  it("restores the native WebSocket even when connect throws", () => {
    const { win, connect } = fakeWindow("?t=tok");

    connect.mockImplementation(() => {
      throw new Error("boom");
    });

    expect(() => installSettingsWindowBridge(win)).toThrow("boom");
    expect((win as unknown as { WebSocket: unknown }).WebSocket).toBe(FakeNativeWebSocket);
  });
});
