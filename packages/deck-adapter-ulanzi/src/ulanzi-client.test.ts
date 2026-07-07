import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decodeContext,
  encodeContext,
  normalizeFrame,
  parseConnectionParams,
  PLUGIN_UUID,
  UlanziClient,
  type UlanziConnectionParams,
  type UlanziEvent,
} from "./ulanzi-client.js";

/** WebSocket OPEN readyState constant (mirrors the client's WS_OPEN). */
const WS_OPEN = 1;

/**
 * Minimal fake WebSocket capturing outbound `send` payloads and exposing the
 * registered handlers so tests can simulate connection + inbound frames.
 */
class FakeWebSocket {
  readyState = WS_OPEN;
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, (...args: unknown[]) => void>();

  on(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.set(event, handler);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.(...args);
  }
}

let lastSocket: FakeWebSocket;

vi.mock("ws", () => ({
  WebSocket: class {
    constructor() {
      lastSocket = new FakeWebSocket();

      return lastSocket as unknown as object;
    }
  },
}));

const params: UlanziConnectionParams = {
  address: "127.0.0.1",
  port: "3906",
  language: "en",
};

/** Parse captured outbound messages back into objects for assertion. */
function sentMessages(): Array<Record<string, unknown>> {
  return lastSocket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

describe("context encoding", () => {
  it("encodes uuid/key/actionid with a triple-underscore separator", () => {
    expect(encodeContext("com.x.action", "5", "abc")).toBe("com.x.action___5___abc");
  });

  it("decodes a context string back into its parts", () => {
    expect(decodeContext("com.x.action___5___abc")).toEqual({ uuid: "com.x.action", key: "5", actionid: "abc" });
  });

  it("round-trips", () => {
    const ctx = encodeContext("u", "k", "a");
    expect(decodeContext(ctx)).toEqual({ uuid: "u", key: "k", actionid: "a" });
  });
});

describe("parseConnectionParams", () => {
  const original = process.argv;

  afterEach(() => {
    process.argv = original;
  });

  it("reads address/port/language from argv[2..4] and stamps the plugin UUID", () => {
    process.argv = ["node", "plugin.js", "192.168.0.5", "49200", "de"];

    expect(parseConnectionParams()).toEqual({
      address: "192.168.0.5",
      port: "49200",
      language: "de",
    });
  });

  it("falls back to documented defaults when argv is absent", () => {
    process.argv = ["node", "plugin.js"];

    expect(parseConnectionParams()).toEqual({
      address: "127.0.0.1",
      port: "3906",
      language: "en",
    });
  });
});

describe("normalizeFrame", () => {
  it("maps `add` to willAppear with settings from param", () => {
    const events = normalizeFrame({ cmd: "add", uuid: "u", key: "5", actionid: "a", param: { mode: "next" } });

    expect(events).toEqual([
      { event: "willAppear", action: "u", context: "u___5___a", payload: { settings: { mode: "next" } } },
    ]);
  });

  it("maps `keydown` / `keyup` to keyDown / keyUp", () => {
    expect(normalizeFrame({ cmd: "keydown", uuid: "u", key: "5", actionid: "a" })[0].event).toBe("keyDown");
    expect(normalizeFrame({ cmd: "keyup", uuid: "u", key: "5", actionid: "a" })[0].event).toBe("keyUp");
  });

  it("maps `dialdown` / `dialup` to dialDown / dialUp", () => {
    expect(normalizeFrame({ cmd: "dialdown", uuid: "u", key: "5", actionid: "a" })[0].event).toBe("dialDown");
    expect(normalizeFrame({ cmd: "dialup", uuid: "u", key: "5", actionid: "a" })[0].event).toBe("dialUp");
  });

  it("maps `dialrotate` directions to ±1 ticks", () => {
    const ticks = (rotateEvent: string): number =>
      normalizeFrame({ cmd: "dialrotate", uuid: "u", key: "5", actionid: "a", rotateEvent })[0].payload?.ticks ?? 0;

    expect(ticks("left")).toBe(-1);
    expect(ticks("hold-left")).toBe(-1);
    expect(ticks("right")).toBe(1);
    expect(ticks("hold-right")).toBe(1);
  });

  it("flags `hold-` dialrotate directions as pressed (rotate-while-pressed)", () => {
    const pressed = (rotateEvent: string): boolean =>
      normalizeFrame({ cmd: "dialrotate", uuid: "u", key: "5", actionid: "a", rotateEvent })[0].payload?.pressed ??
      false;

    expect(pressed("left")).toBe(false);
    expect(pressed("right")).toBe(false);
    expect(pressed("hold-left")).toBe(true);
    expect(pressed("hold-right")).toBe(true);
  });

  it("maps settings-change frames to didReceiveSettings", () => {
    for (const cmd of ["didReceiveSettings", "paramfromapp", "paramfromplugin"]) {
      const ev = normalizeFrame({ cmd, uuid: "u", key: "5", actionid: "a", param: { x: 1 } })[0];
      expect(ev.event).toBe("didReceiveSettings");
      expect(ev.payload?.settings).toEqual({ x: 1 });
    }
  });

  it("fans `clear` out to one willDisappear per param item", () => {
    const events = normalizeFrame({
      cmd: "clear",
      param: [
        { uuid: "u1", key: "1", actionid: "a1" },
        { uuid: "u2", key: "2", actionid: "a2" },
      ],
    });

    expect(events).toEqual([
      { event: "willDisappear", action: "u1", context: "u1___1___a1", payload: { settings: {} } },
      { event: "willDisappear", action: "u2", context: "u2___2___a2", payload: { settings: {} } },
    ]);
  });

  it("maps `didReceiveGlobalSettings` to a global event with settings", () => {
    const ev = normalizeFrame({ cmd: "didReceiveGlobalSettings", settings: { debugLogging: true } })[0];

    expect(ev).toEqual({ event: "didReceiveGlobalSettings", payload: { settings: { debugLogging: true } } });
  });

  it("surfaces `sendToPlugin` only for the PI-appear marker", () => {
    const marker = normalizeFrame({
      cmd: "sendToPlugin",
      uuid: "u",
      key: "5",
      actionid: "a",
      payload: { event: "propertyInspectorDidAppear" },
    });
    expect(marker[0].event).toBe("propertyInspectorDidAppear");

    const other = normalizeFrame({ cmd: "sendToPlugin", uuid: "u", key: "5", actionid: "a", payload: { foo: 1 } });
    expect(other).toEqual([]);
  });

  it("ignores unused frames (`run`, `setactive`, acks)", () => {
    expect(normalizeFrame({ cmd: "run", uuid: "u", key: "5", actionid: "a" })).toEqual([]);
    expect(normalizeFrame({ cmd: "setactive", uuid: "u", key: "5", actionid: "a", active: true })).toEqual([]);
  });
});

describe("UlanziClient connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the connected handshake and requests global settings on open", async () => {
    const client = new UlanziClient(params, undefined, () => {});
    await client.connect();
    lastSocket.emit("open");

    expect(sentMessages()).toEqual([
      { code: 0, cmd: "connected", uuid: PLUGIN_UUID },
      { cmd: "getGlobalSettings", uuid: PLUGIN_UUID, key: "", actionid: "" },
    ]);
  });

  it("invokes onClose when the socket closes", async () => {
    const onClose = vi.fn();
    const client = new UlanziClient(params, undefined, onClose);
    await client.connect();

    lastSocket.emit("close");

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("UlanziClient routing + settings cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const connected = async (): Promise<UlanziClient> => {
    const client = new UlanziClient(params, undefined, () => {});
    await client.connect();
    lastSocket.emit("open");
    lastSocket.sent.length = 0;

    return client;
  };

  it("routes a normalized event to the matching action handler", async () => {
    const client = await connected();
    const handler = vi.fn();
    client.onActionEvent("com.x.action", "willAppear", handler);

    lastSocket.emit(
      "message",
      JSON.stringify({ cmd: "add", uuid: "com.x.action", key: "5", actionid: "a", param: { mode: "next" } }),
    );

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as UlanziEvent).payload?.settings).toEqual({ mode: "next" });
  });

  it("backfills cached settings onto press frames (which carry none on the wire)", async () => {
    const client = await connected();
    const keyDown = vi.fn();
    client.onActionEvent("com.x.action", "keyDown", keyDown);

    // add caches the settings...
    lastSocket.emit(
      "message",
      JSON.stringify({ cmd: "add", uuid: "com.x.action", key: "5", actionid: "a", param: { mode: "next" } }),
    );
    // ...then a settings-less keydown should still see them.
    lastSocket.emit("message", JSON.stringify({ cmd: "keydown", uuid: "com.x.action", key: "5", actionid: "a" }));

    expect((keyDown.mock.calls[0][0] as UlanziEvent).payload?.settings).toEqual({ mode: "next" });
  });

  it("updates the cache on a settings change", async () => {
    const client = await connected();
    const keyDown = vi.fn();
    client.onActionEvent("com.x.action", "keyDown", keyDown);

    lastSocket.emit(
      "message",
      JSON.stringify({ cmd: "add", uuid: "com.x.action", key: "5", actionid: "a", param: { mode: "next" } }),
    );
    lastSocket.emit(
      "message",
      JSON.stringify({
        cmd: "paramfromapp",
        uuid: "com.x.action",
        key: "5",
        actionid: "a",
        param: { mode: "previous" },
      }),
    );
    lastSocket.emit("message", JSON.stringify({ cmd: "keydown", uuid: "com.x.action", key: "5", actionid: "a" }));

    expect((keyDown.mock.calls[0][0] as UlanziEvent).payload?.settings).toEqual({ mode: "previous" });
  });

  it("drops the cache for a context on clear", async () => {
    const client = await connected();
    const keyDown = vi.fn();
    client.onActionEvent("com.x.action", "keyDown", keyDown);

    lastSocket.emit(
      "message",
      JSON.stringify({ cmd: "add", uuid: "com.x.action", key: "5", actionid: "a", param: { mode: "next" } }),
    );
    lastSocket.emit(
      "message",
      JSON.stringify({ cmd: "clear", param: [{ uuid: "com.x.action", key: "5", actionid: "a" }] }),
    );
    lastSocket.emit("message", JSON.stringify({ cmd: "keydown", uuid: "com.x.action", key: "5", actionid: "a" }));

    expect((keyDown.mock.calls[0][0] as UlanziEvent).payload?.settings).toEqual({});
  });

  it("routes the global didReceiveGlobalSettings event", async () => {
    const client = await connected();
    const handler = vi.fn();
    client.onGlobalEvent("didReceiveGlobalSettings", handler);

    lastSocket.emit("message", JSON.stringify({ cmd: "didReceiveGlobalSettings", settings: { debugLogging: true } }));

    expect((handler.mock.calls[0][0] as UlanziEvent).payload?.settings).toEqual({ debugLogging: true });
  });

  it("ignores ack/response frames (code set without cmdType REQUEST)", async () => {
    const client = await connected();
    const handler = vi.fn();
    client.onActionEvent("com.x.action", "willAppear", handler);

    lastSocket.emit("message", JSON.stringify({ code: 0, cmd: "add", uuid: "com.x.action", key: "5", actionid: "a" }));

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("UlanziClient outbound commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const connected = async (): Promise<UlanziClient> => {
    const client = new UlanziClient(params, undefined, () => {});
    await client.connect();
    lastSocket.emit("open");
    lastSocket.sent.length = 0;

    return client;
  };

  it("setImage sends a base64-data state frame with showtext disabled", async () => {
    const client = await connected();
    client.setImage("com.x.action___5___a", "data:image/svg+xml,FOO");

    expect(sentMessages()).toEqual([
      {
        cmd: "state",
        uuid: "com.x.action",
        key: "5",
        actionid: "a",
        param: {
          statelist: [
            {
              uuid: "com.x.action",
              key: "5",
              actionid: "a",
              type: 1,
              data: "data:image/svg+xml,FOO",
              textData: "",
              showtext: false,
            },
          ],
        },
      },
    ]);
  });

  it("setSettings sends a setSettings frame for the context", async () => {
    const client = await connected();
    client.setSettings("com.x.action___5___a", { mode: "next" });

    expect(sentMessages()).toContainEqual({
      cmd: "setSettings",
      uuid: "com.x.action",
      key: "5",
      actionid: "a",
      settings: { mode: "next" },
    });
  });

  it("setGlobalSettings sends a setGlobalSettings frame for the plugin", async () => {
    const client = await connected();
    client.setGlobalSettings({ debugLogging: true });

    expect(sentMessages()).toContainEqual({
      cmd: "setGlobalSettings",
      uuid: PLUGIN_UUID,
      key: "",
      actionid: "",
      settings: { debugLogging: true },
    });
  });

  it("openUrl sends an openurl frame", async () => {
    const client = await connected();
    client.openUrl("https://iracedeck.com/");

    expect(sentMessages()).toContainEqual({ cmd: "openurl", url: "https://iracedeck.com/", local: false, param: "" });
  });
});
