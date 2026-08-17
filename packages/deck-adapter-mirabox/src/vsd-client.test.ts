import { beforeEach, describe, expect, it, vi } from "vitest";

import { VSDClient, type VSDConnectionParams } from "./vsd-client.js";

/** WebSocket OPEN readyState constant (mirrors the client's WS_OPEN). */
const WS_OPEN = 1;

/**
 * Minimal fake WebSocket capturing outbound `send` payloads and exposing the
 * registered `open` handler so tests can simulate the connection opening.
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

const params: VSDConnectionParams = {
  port: "12345",
  pluginUuid: "com.iracedeck.sd.mirabox",
  registerEvent: "registerPlugin",
};

/** Parse the captured outbound messages back into objects for assertion. */
function sentMessages(): Array<Record<string, unknown>> {
  return lastSocket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

describe("VSDClient.openUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should send an openUrl event with the plugin context and url payload", async () => {
    const client = new VSDClient(params, undefined, () => {});
    await client.connect();
    lastSocket.emit("open");
    lastSocket.sent.length = 0; // drop registration + getGlobalSettings handshake

    client.openUrl("https://example.test/");

    expect(sentMessages()).toContainEqual({
      event: "openUrl",
      context: "com.iracedeck.sd.mirabox",
      payload: { url: "https://example.test/" },
    });
  });
});

describe("VSDClient.setGlobalSettings before the socket is open (#993)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defers a call made before connect(), then flushes it after the register + getGlobalSettings frames once open", async () => {
    const client = new VSDClient(params, undefined, () => {});

    // No socket exists yet — must not throw, and must not send anything.
    client.setGlobalSettings({ debugLogging: true });

    await client.connect();
    lastSocket.emit("open");

    expect(sentMessages()).toEqual([
      { uuid: params.pluginUuid, event: params.registerEvent },
      { event: "getGlobalSettings", context: params.pluginUuid },
      { event: "setGlobalSettings", context: params.pluginUuid, payload: { debugLogging: true } },
    ]);
  });

  it("keeps only the latest payload when called twice before the socket is open", async () => {
    const client = new VSDClient(params, undefined, () => {});
    await client.connect();
    lastSocket.readyState = 0; // CONNECTING — not open yet

    client.setGlobalSettings({ debugLogging: false });
    client.setGlobalSettings({ debugLogging: true });
    expect(lastSocket.sent).toEqual([]);

    lastSocket.readyState = WS_OPEN;
    lastSocket.emit("open");

    const flushed = sentMessages().filter((m) => m.event === "setGlobalSettings");
    expect(flushed).toEqual([
      { event: "setGlobalSettings", context: params.pluginUuid, payload: { debugLogging: true } },
    ]);
  });

  it("sends immediately once open, and does not re-flush on a later open", async () => {
    const client = new VSDClient(params, undefined, () => {});
    await client.connect();
    lastSocket.emit("open");
    lastSocket.sent.length = 0;

    client.setGlobalSettings({ debugLogging: true });
    expect(sentMessages()).toEqual([
      { event: "setGlobalSettings", context: params.pluginUuid, payload: { debugLogging: true } },
    ]);

    lastSocket.sent.length = 0;
    lastSocket.emit("open"); // a spurious/repeated open must not resend a stale value

    expect(sentMessages().filter((m) => m.event === "setGlobalSettings")).toEqual([]);
  });

  it("defers when readyState is CONNECTING even though a socket already exists, then flushes on open", async () => {
    const client = new VSDClient(params, undefined, () => {});
    await client.connect();
    lastSocket.readyState = 0; // CONNECTING

    client.setGlobalSettings({ debugLogging: true });
    expect(lastSocket.sent).toEqual([]);

    lastSocket.readyState = WS_OPEN;
    lastSocket.emit("open");

    expect(sentMessages()).toContainEqual({
      event: "setGlobalSettings",
      context: params.pluginUuid,
      payload: { debugLogging: true },
    });
  });
});
