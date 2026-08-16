import { describe, expect, it } from "vitest";

import { loopbackUrl, openLoopbackSocket } from "./loopback.js";
import type { LoopbackHandlers, PiFrame } from "./router.js";

class FakeNativeWebSocket {
  static instances: FakeNativeWebSocket[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed = 0;
  constructor(public readonly url: string) {
    FakeNativeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed++;
  }
}

const CHANNEL = { port: 55762, token: "cc29ab52f34a2a927663a0832b86a807b4cc329ebe68a98d" };
const Native = FakeNativeWebSocket as unknown as typeof WebSocket;

describe("loopbackUrl", () => {
  it("targets 127.0.0.1, the /ws path, and carries the token as ?t=", () => {
    expect(loopbackUrl(CHANNEL)).toBe(`ws://127.0.0.1:55762/ws?t=${CHANNEL.token}`);
  });

  it("URL-encodes the token", () => {
    expect(loopbackUrl({ port: 1, token: "a b" })).toBe("ws://127.0.0.1:1/ws?t=a%20b");
  });
});

describe("openLoopbackSocket", () => {
  it("opens the native socket, forwards open/message/close, JSON-encodes sends, ignores non-JSON", () => {
    FakeNativeWebSocket.instances = [];
    const seen: string[] = [];
    const messages: PiFrame[] = [];
    const handlers: LoopbackHandlers = {
      onOpen: () => seen.push("open"),
      onMessage: (f) => messages.push(f),
      onClose: () => seen.push("close"),
    };
    const socket = openLoopbackSocket(CHANNEL, handlers, Native);
    const native = FakeNativeWebSocket.instances[0]!;

    expect(native.url).toBe(loopbackUrl(CHANNEL));
    native.onopen?.({});
    native.onmessage?.({
      data: JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings: { a: 1 } } }),
    });
    native.onmessage?.({ data: "not json" });
    socket.send({ event: "getGlobalSettings" });
    socket.close();
    native.onclose?.({});

    expect(seen).toEqual(["open", "close"]);
    expect(messages).toEqual([{ event: "didReceiveGlobalSettings", payload: { settings: { a: 1 } } }]);
    expect(native.sent).toEqual([JSON.stringify({ event: "getGlobalSettings" })]);
    expect(native.closed).toBe(1);
  });

  it("reports onClose exactly once even when error and close both fire", () => {
    FakeNativeWebSocket.instances = [];
    let closes = 0;
    openLoopbackSocket(CHANNEL, { onOpen: () => {}, onMessage: () => {}, onClose: () => closes++ }, Native);
    const native = FakeNativeWebSocket.instances[0]!;
    native.onerror?.({});
    native.onclose?.({});

    expect(closes).toBe(1);
  });
});
