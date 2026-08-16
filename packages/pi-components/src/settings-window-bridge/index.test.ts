import { beforeEach, describe, expect, it, vi } from "vitest";

import { installSettingsWindowBridge, readSettingsWindowIdentity, SETTINGS_WINDOW_ACTION } from "./index.js";

/** Fake native WebSocket capturing the URL it was opened with. */
class FakeNativeWebSocket {
  static instances: FakeNativeWebSocket[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeNativeWebSocket.instances.push(this);
  }

  send(): void {}
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
    const win = {
      location: { search, host },
      WebSocket: FakeNativeWebSocket,
      connectElgatoStreamDeckSocket: connect,
    };

    return { win: win as unknown as Window & typeof globalThis, connect };
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

  it("restores the native WebSocket even when connect throws", () => {
    const { win, connect } = fakeWindow("?t=tok");

    connect.mockImplementation(() => {
      throw new Error("boom");
    });

    expect(() => installSettingsWindowBridge(win)).toThrow("boom");
    expect((win as unknown as { WebSocket: unknown }).WebSocket).toBe(FakeNativeWebSocket);
  });
});
