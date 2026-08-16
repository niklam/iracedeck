import { describe, expect, it, vi } from "vitest";

import { installPiSettingsBridge, PiSettingsBridgeSocket } from "./index.js";

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
  triggerOpen(): void {
    this.onopen?.({});
  }
  triggerMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const Native = FakeNativeWebSocket as unknown as typeof WebSocket;
const CHANNEL = { port: 55762, token: "cc29ab52f34a2a927663a0832b86a807b4cc329ebe68a98d" };
const IDENTITY = { context: "pi-uuid-1", action: "com.iracedeck.sd.core.car-control" };

function json(frames: string[]): unknown[] {
  return frames.map((f) => JSON.parse(f) as unknown);
}

describe("PiSettingsBridgeSocket", () => {
  function make() {
    FakeNativeWebSocket.instances = [];
    const warn = vi.fn();
    const socket = new PiSettingsBridgeSocket("ws://localhost:28196", IDENTITY, Native, {
      warn,
      bootstrapTimeoutMs: 1000,
    });
    const host = FakeNativeWebSocket.instances[0]!;
    const received: unknown[] = [];
    socket.onmessage = (ev) => received.push(JSON.parse(ev.data) as unknown);
    const opened = vi.fn();
    socket.onopen = opened;

    return { socket, host, received, warn, opened };
  }

  it("opens the host socket, runs sdpi's onopen first (register frame goes out), then bootstraps", () => {
    const { socket, host, opened } = make();

    expect(host.url).toBe("ws://localhost:28196");
    // sdpi's onopen sends the register frame through the bridged socket
    opened.mockImplementation(() =>
      socket.send(JSON.stringify({ event: "registerPropertyInspector", uuid: IDENTITY.context })),
    );
    host.triggerOpen();

    expect(json(host.sent)).toEqual([
      { event: "registerPropertyInspector", uuid: IDENTITY.context },
      { event: "getGlobalSettings", context: IDENTITY.context, action: IDENTITY.action },
    ]);
  });

  it("switches to the loopback on a channel and routes global frames there; host pushes are dropped; loopback pushes reach sdpi", () => {
    const { socket, host, received } = make();
    host.triggerOpen();
    socket.send(JSON.stringify({ event: "getGlobalSettings", context: IDENTITY.context, action: IDENTITY.action }));
    host.triggerMessage({
      event: "didReceiveGlobalSettings",
      payload: { settings: { _settingsChannel: CHANNEL, driverName: "host" } },
    });

    const loop = FakeNativeWebSocket.instances[1]!;
    expect(loop.url).toBe(`ws://127.0.0.1:${CHANNEL.port}/ws?t=${CHANNEL.token}`);
    loop.triggerOpen();

    expect(json(loop.sent)).toEqual([
      { event: "getGlobalSettings", context: IDENTITY.context, action: IDENTITY.action },
      { event: "getGlobalSettings", context: IDENTITY.context, action: IDENTITY.action },
    ]);
    socket.send(
      JSON.stringify({ event: "setGlobalSettings", context: IDENTITY.context, payload: { driverName: "n" } }),
    );
    expect(json(loop.sent).at(-1)).toEqual({
      event: "setGlobalSettings",
      context: IDENTITY.context,
      payload: { driverName: "n" },
    });

    loop.triggerMessage({ event: "didReceiveGlobalSettings", payload: { settings: { driverName: "file" } } });
    host.triggerMessage({ event: "didReceiveGlobalSettings", payload: { settings: { driverName: "stale" } } });
    expect(received).toEqual([{ event: "didReceiveGlobalSettings", payload: { settings: { driverName: "file" } } }]);
  });

  it("passes non-global frames through in both directions untouched", () => {
    const { socket, host, received } = make();
    host.triggerOpen();
    socket.send(
      JSON.stringify({ event: "sendToPlugin", context: IDENTITY.context, payload: { event: "openSettings" } }),
    );
    host.triggerMessage({ event: "didReceiveSettings", payload: { settings: { mode: "x" } } });

    expect(json(host.sent).at(-1)).toEqual({
      event: "sendToPlugin",
      context: IDENTITY.context,
      payload: { event: "openSettings" },
    });
    expect(received).toEqual([{ event: "didReceiveSettings", payload: { settings: { mode: "x" } } }]);
  });

  it("falls back to the host path (warning) when the host copy carries no channel", () => {
    const { socket, host, received, warn } = make();
    host.triggerOpen();
    host.triggerMessage({ event: "didReceiveGlobalSettings", payload: { settings: { driverName: "host-only" } } });
    socket.send(JSON.stringify({ event: "setGlobalSettings", payload: { a: 1 } }));

    expect(FakeNativeWebSocket.instances).toHaveLength(1);
    expect(received).toEqual([
      { event: "didReceiveGlobalSettings", payload: { settings: { driverName: "host-only" } } },
    ]);
    expect(json(host.sent).at(-1)).toEqual({ event: "setGlobalSettings", payload: { a: 1 } });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("forwards non-JSON host data to sdpi untouched and forwards close/error", () => {
    const { socket, host } = make();
    const raw: string[] = [];
    socket.onmessage = (ev) => raw.push(ev.data);
    const closed = vi.fn();
    socket.onclose = closed;
    host.onmessage?.({ data: "not json" });
    host.onclose?.({});

    expect(raw).toEqual(["not json"]);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("close() closes the host socket and any loopback", () => {
    const { socket, host } = make();
    host.triggerOpen();
    host.triggerMessage({ event: "didReceiveGlobalSettings", payload: { settings: { _settingsChannel: CHANNEL } } });
    const loop = FakeNativeWebSocket.instances[1]!;
    socket.close();

    expect(host.closed).toBe(1);
    expect(loop.closed).toBe(1);
  });
});

describe("installPiSettingsBridge", () => {
  function fakeWin() {
    FakeNativeWebSocket.instances = [];
    const win = { WebSocket: Native, setTimeout, clearTimeout, console: { warn: vi.fn() } } as unknown as Window &
      typeof globalThis & { connectElgatoStreamDeckSocket?: (...a: unknown[]) => void };

    return win;
  }

  /** What sdpi-components.js does at load: wrap the prior definition, then connect synchronously. */
  function loadSdpi(win: ReturnType<typeof fakeWin>) {
    const prior = win.connectElgatoStreamDeckSocket;
    win.connectElgatoStreamDeckSocket = (port, uuid, event, info, actionInfo) => {
      prior?.(port, uuid, event, info, actionInfo);
      new win.WebSocket(`ws://localhost:${String(port)}`);
    };
  }

  const ACTION_INFO = JSON.stringify({
    action: "com.iracedeck.sd.core.car-control",
    context: "pi-uuid-1",
    device: "d",
    payload: { settings: {} },
  });

  it("runs before sdpi's connect and turns sdpi's host socket into a bridged socket, then restores WebSocket", () => {
    const win = fakeWin();
    installPiSettingsBridge(win);
    loadSdpi(win);

    win.connectElgatoStreamDeckSocket!("28196", "pi-uuid-1", "registerPropertyInspector", "{}", ACTION_INFO);

    expect(FakeNativeWebSocket.instances).toHaveLength(1);
    expect(FakeNativeWebSocket.instances[0]!.url).toBe("ws://localhost:28196");
    expect(win.WebSocket).toBe(Native);
    // the socket sdpi got is the bridge: opening the host triggers the bootstrap read
    FakeNativeWebSocket.instances[0]!.triggerOpen();
    expect(json(FakeNativeWebSocket.instances[0]!.sent)).toEqual([
      { event: "getGlobalSettings", context: "pi-uuid-1", action: "com.iracedeck.sd.core.car-control" },
    ]);
  });

  it("does not intercept sockets to other URLs and restores WebSocket even if sdpi never connects", async () => {
    const win = fakeWin();
    installPiSettingsBridge(win);
    // no sdpi: the pre-hook is the only definition
    win.connectElgatoStreamDeckSocket!("28196", "pi-uuid-1", "registerPropertyInspector", "{}", ACTION_INFO);
    new win.WebSocket("ws://127.0.0.1:9999/other");

    expect(FakeNativeWebSocket.instances[0]!.url).toBe("ws://127.0.0.1:9999/other");
    await new Promise((r) => setTimeout(r, 0));
    expect(win.WebSocket).toBe(Native);
  });

  it("tolerates a missing/invalid actionInfo (uses an empty action) — never throws in the host's call", () => {
    const win = fakeWin();
    installPiSettingsBridge(win);
    loadSdpi(win);

    expect(() =>
      win.connectElgatoStreamDeckSocket!("1", "u", "registerPropertyInspector", "{}", "not json"),
    ).not.toThrow();
    expect(FakeNativeWebSocket.instances).toHaveLength(1);
  });
});
