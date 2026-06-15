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
