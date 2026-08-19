import { describe, expect, it, vi } from "vitest";

import { connectCdp, waitForDebuggerUrl } from "./cdp.mjs";

describe("waitForDebuggerUrl", () => {
  it("returns the debugger URL once the endpoint answers", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" }),
    }));

    await expect(waitForDebuggerUrl(9222, { fetchImpl, delay: async () => {} })).resolves.toBe(
      "ws://127.0.0.1:9222/devtools/browser/abc",
    );
  });

  it("keeps polling while the browser is still starting", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;

      if (attempts < 3) throw new Error("ECONNREFUSED");

      return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://ok" }) };
    });

    await expect(waitForDebuggerUrl(9222, { fetchImpl, delay: async () => {} })).resolves.toBe("ws://ok");
    expect(attempts).toBe(3);
  });

  it("gives up with a useful message once the deadline passes", async () => {
    let clock = 0;

    await expect(
      waitForDebuggerUrl(9222, {
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
        now: () => (clock += 5_000),
        delay: async () => {},
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/did not come up on port 9222/);
  });
});

/** A WebSocket double driven by the test rather than a real socket. */
class FakeSocket {
  constructor() {
    this.sent = [];
    this.listeners = {};
    this.closed = false;
    queueMicrotask(() => this.emit("open", {}));
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type, event) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  /** Answer the most recent command as the browser would. */
  reply(result) {
    const last = this.sent.at(-1);
    this.emit("message", { data: JSON.stringify({ id: last.id, result }) });
  }
  replyError(message) {
    const last = this.sent.at(-1);
    this.emit("message", { data: JSON.stringify({ id: last.id, error: { message } }) });
  }
}

async function connectFake(extraDeps = {}) {
  let socket;
  const cdp = await connectCdp("ws://fake", {
    WebSocketImpl: class {
      constructor() {
        socket = new FakeSocket();

        return socket;
      }
    },
    ...extraDeps,
  });

  return { cdp, socket };
}

describe("connectCdp", () => {
  it("resolves a command with its result", async () => {
    const { cdp, socket } = await connectFake();

    const pending = cdp.send("Page.captureScreenshot", { format: "png" });
    socket.reply({ data: "base64" });

    await expect(pending).resolves.toEqual({ data: "base64" });
    expect(socket.sent[0]).toMatchObject({ method: "Page.captureScreenshot", params: { format: "png" } });
  });

  it("includes the sessionId when one is given", async () => {
    const { cdp, socket } = await connectFake();

    const pending = cdp.send("Page.enable", {}, "S1");
    socket.reply({});
    await pending;

    expect(socket.sent[0].sessionId).toBe("S1");
  });

  it("rejects when the browser reports an error", async () => {
    const { cdp, socket } = await connectFake();

    const pending = cdp.send("Bad.method");
    socket.replyError("no such method");

    await expect(pending).rejects.toThrow(/no such method/);
  });

  it("gives each command its own id so replies cannot cross", async () => {
    const { cdp, socket } = await connectFake();

    const first = cdp.send("A");
    const second = cdp.send("B");
    // Answer the SECOND command first — ids, not arrival order, must match.
    socket.emit("message", { data: JSON.stringify({ id: socket.sent[1].id, result: { which: "B" } }) });
    socket.emit("message", { data: JSON.stringify({ id: socket.sent[0].id, result: { which: "A" } }) });

    await expect(first).resolves.toEqual({ which: "A" });
    await expect(second).resolves.toEqual({ which: "B" });
  });

  it("routes unsolicited protocol events to listeners instead of failing", async () => {
    const { cdp, socket } = await connectFake();
    const seen = [];
    cdp.onEvent((message) => seen.push(message.method));

    socket.emit("message", { data: JSON.stringify({ method: "Page.loadEventFired", params: {} }) });

    expect(seen).toEqual(["Page.loadEventFired"]);
  });

  it("ignores a malformed frame rather than tearing the run down", async () => {
    const { cdp, socket } = await connectFake();

    expect(() => socket.emit("message", { data: "not json" })).not.toThrow();
    expect(cdp).toBeDefined();
  });

  it("rejects in-flight commands when the connection is closed", async () => {
    const { cdp, socket } = await connectFake();

    const pending = cdp.send("Never.answered");
    cdp.close();

    await expect(pending).rejects.toThrow(/closed while the command was in flight/);
    expect(socket.closed).toBe(true);
  });

  it("times out a command the browser never answers", async () => {
    const { cdp } = await connectFake({ commandTimeoutMs: 10 });

    await expect(cdp.send("Slow.method")).rejects.toThrow(/timed out after 10ms/);
  });
});
