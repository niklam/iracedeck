import { beforeEach, describe, expect, it, vi } from "vitest";

import { installUlanziBridge, readIdentity, UlanziBridgeSocket } from "./index.js";
import type { BridgeIdentity } from "./translate.js";

/** Fake native WebSocket capturing outbound frames + exposing event triggers. */
class FakeNativeWebSocket {
  static instances: FakeNativeWebSocket[] = [];
  readonly url: string;
  readonly sent: string[] = [];
  closed = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
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

  triggerMessage(data: string): void {
    this.onmessage?.({ data });
  }
}

const identity: BridgeIdentity = {
  address: "127.0.0.1",
  port: "49200",
  uuid: "com.x.action",
  key: "5",
  actionid: "abc",
  device: "D200X",
  language: "en",
  controller: "Keypad",
};

beforeEach(() => {
  FakeNativeWebSocket.instances = [];
});

/** Shared by the `UlanziBridgeSocket` behavior tests and the settings-channel tests below. */
function makeBridge(): { bridge: UlanziBridgeSocket; real: FakeNativeWebSocket } {
  const bridge = new UlanziBridgeSocket(identity, FakeNativeWebSocket as unknown as typeof WebSocket);

  return { bridge, real: FakeNativeWebSocket.instances[0] };
}

describe("readIdentity", () => {
  it("parses every param from the query string", () => {
    expect(
      readIdentity("?address=10.0.0.1&port=5000&uuid=u&key=k&actionid=a&device=D200&language=de&controller=Encoder"),
    ).toEqual({
      address: "10.0.0.1",
      port: "5000",
      uuid: "u",
      key: "k",
      actionid: "a",
      device: "D200",
      language: "de",
      controller: "Encoder",
    });
  });

  it("falls back to defaults for an empty query string", () => {
    expect(readIdentity("")).toEqual({
      address: "127.0.0.1",
      port: "3906",
      uuid: "",
      key: "",
      actionid: "",
      device: "",
      language: "en",
      controller: "Keypad",
    });
  });
});

describe("UlanziBridgeSocket", () => {
  it("opens the real socket to the Ulanzi address/port", () => {
    const { real } = makeBridge();
    expect(real.url).toBe("ws://127.0.0.1:49200");
  });

  it("sends the Ulanzi handshake + PI-appear marker and signals onopen", () => {
    const { bridge, real } = makeBridge();
    const onopen = vi.fn();
    bridge.onopen = onopen;

    real.triggerOpen();

    expect(JSON.parse(real.sent[0])).toEqual({
      code: 0,
      cmd: "connected",
      uuid: "com.x.action",
      key: "5",
      actionid: "abc",
    });
    expect(JSON.parse(real.sent[1])).toEqual({
      cmd: "sendToPlugin",
      uuid: "com.x.action",
      key: "5",
      actionid: "abc",
      payload: { event: "propertyInspectorDidAppear" },
    });
    // Bootstrap read of the host's global-settings copy (plugin scope) — the
    // settings-channel router decides from here where global settings go (#993 phase 2).
    expect(JSON.parse(real.sent[2])).toEqual({
      cmd: "getGlobalSettings",
      uuid: "com.iracedeck.sd.core",
      key: "",
      actionid: "",
    });
    expect(onopen).toHaveBeenCalledOnce();
    expect(bridge.readyState).toBe(1);
  });

  it("translates outbound Elgato frames to Ulanzi and swallows the registration frame", () => {
    const { bridge, real } = makeBridge();
    real.triggerOpen();
    // No _settingsChannel in the host's copy — the router falls back to the
    // host path immediately, so the queued bootstrap frame flushes to Ulanzi.
    real.triggerMessage(JSON.stringify({ cmd: "didReceiveGlobalSettings", settings: {} }));
    real.sent.length = 0;

    // Global-settings frames are plugin-scoped, not PI-identity-scoped (#868).
    bridge.send(JSON.stringify({ event: "getGlobalSettings", context: "x" }));
    expect(JSON.parse(real.sent[0])).toEqual({
      cmd: "getGlobalSettings",
      uuid: "com.iracedeck.sd.core",
      key: "",
      actionid: "",
    });

    bridge.send(JSON.stringify({ event: "registerPropertyInspector", uuid: "x" }));
    expect(real.sent).toHaveLength(1); // swallowed — nothing new sent
  });

  it("translates inbound Ulanzi frames to Elgato events", () => {
    const { bridge, real } = makeBridge();
    const onmessage = vi.fn();
    bridge.onmessage = onmessage;

    real.triggerMessage(JSON.stringify({ cmd: "didReceiveGlobalSettings", settings: { a: 1 } }));

    expect(onmessage).toHaveBeenCalledOnce();
    expect(JSON.parse((onmessage.mock.calls[0][0] as { data: string }).data)).toEqual({
      event: "didReceiveGlobalSettings",
      payload: { settings: { a: 1 } },
    });
  });

  it("drops inbound frames with no Elgato equivalent", () => {
    const { bridge, real } = makeBridge();
    const onmessage = vi.fn();
    bridge.onmessage = onmessage;

    real.triggerMessage(JSON.stringify({ cmd: "state", param: {} }));

    expect(onmessage).not.toHaveBeenCalled();
  });
});

describe("installUlanziBridge", () => {
  it("monkeypatches WebSocket, drives connect with Elgato-shape args, then restores", () => {
    let bridgeDuringConnect: unknown = null;

    const fakeWin = {
      location: {
        search: "?address=127.0.0.1&port=49200&uuid=com.x.action&key=5&actionid=abc&device=D200X&language=en",
      },
      WebSocket: FakeNativeWebSocket,
      connectElgatoStreamDeckSocket: vi.fn(() => {
        // The monkeypatch must be active while sdpi opens its socket.
        bridgeDuringConnect = new (fakeWin.WebSocket as unknown as typeof WebSocket)("ws://localhost:49200");
      }),
    };

    installUlanziBridge(fakeWin as unknown as Window & typeof globalThis);

    expect(fakeWin.connectElgatoStreamDeckSocket).toHaveBeenCalledOnce();
    const [port, context, registerEvent, info, actionInfo] = fakeWin.connectElgatoStreamDeckSocket.mock.calls[0] as [
      string,
      string,
      string,
      string,
      string,
    ];

    expect(port).toBe("49200");
    expect(context).toBe("com.x.action___5___abc");
    expect(registerEvent).toBe("registerPropertyInspector");
    expect(JSON.parse(info)).toMatchObject({ application: { language: "en" } });
    expect(JSON.parse(actionInfo)).toMatchObject({
      action: "com.x.action",
      context: "com.x.action___5___abc",
      device: "D200X",
      payload: { settings: {} },
    });

    expect(bridgeDuringConnect).toBeInstanceOf(UlanziBridgeSocket);
    // Native WebSocket restored after install.
    expect(fakeWin.WebSocket).toBe(FakeNativeWebSocket);
  });
});

describe("UlanziBridgeSocket — settings channel (#993 phase 2)", () => {
  const CHANNEL = { port: 55762, token: "cc29ab52f34a2a927663a0832b86a807b4cc329ebe68a98d" };
  const parsed = (s: string[]) => s.map((x) => JSON.parse(x) as Record<string, unknown>);

  it("bootstraps with a plugin-scoped Ulanzi getGlobalSettings right after the handshake", () => {
    const { bridge, real } = makeBridge();
    bridge.onopen = () => {};
    real.triggerOpen();

    expect(parsed(real.sent).at(-1)).toEqual({
      cmd: "getGlobalSettings",
      uuid: "com.iracedeck.sd.core",
      key: "",
      actionid: "",
    });
  });

  it("switches to the loopback when the host reply carries _settingsChannel and routes global frames there", () => {
    const { bridge, real } = makeBridge();
    const received: Record<string, unknown>[] = [];
    bridge.onmessage = (ev) => received.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    real.triggerOpen();
    bridge.send(JSON.stringify({ event: "getGlobalSettings", context: "c", action: "a" })); // queued
    real.triggerMessage(
      JSON.stringify({ cmd: "didReceiveGlobalSettings", settings: { _settingsChannel: CHANNEL, driverName: "host" } }),
    );

    const loop = FakeNativeWebSocket.instances[1]!;
    expect(loop.url).toBe(`ws://127.0.0.1:${CHANNEL.port}/ws?t=${CHANNEL.token}`);
    expect(received).toEqual([]); // the host copy is not delivered
    loop.triggerOpen();
    expect(parsed(loop.sent)[0]).toMatchObject({ event: "getGlobalSettings" });

    bridge.send(JSON.stringify({ event: "setGlobalSettings", payload: { driverName: "n" } }));
    expect(parsed(loop.sent).at(-1)).toEqual({ event: "setGlobalSettings", payload: { driverName: "n" } });
    // and NOT translated to the Ulanzi host
    expect(parsed(real.sent).some((f) => f.cmd === "setGlobalSettings")).toBe(false);

    loop.triggerMessage(
      JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings: { driverName: "file" } } }),
    );
    real.triggerMessage(JSON.stringify({ cmd: "didReceiveGlobalSettings", settings: { driverName: "stale" } }));
    expect(received).toEqual([{ event: "didReceiveGlobalSettings", payload: { settings: { driverName: "file" } } }]);
  });

  it("falls back to today's host path when the host copy has no channel", () => {
    const { bridge, real } = makeBridge();
    const received: Record<string, unknown>[] = [];
    bridge.onmessage = (ev) => received.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    real.triggerOpen();
    real.triggerMessage(JSON.stringify({ cmd: "didReceiveGlobalSettings", settings: { driverName: "host-only" } }));
    bridge.send(JSON.stringify({ event: "setGlobalSettings", payload: { a: 1 } }));

    expect(FakeNativeWebSocket.instances).toHaveLength(1);
    expect(received).toEqual([
      { event: "didReceiveGlobalSettings", payload: { settings: { driverName: "host-only" } } },
    ]);
    expect(parsed(real.sent).at(-1)).toEqual({
      cmd: "setGlobalSettings",
      uuid: "com.iracedeck.sd.core",
      key: "",
      actionid: "",
      settings: { a: 1 },
    });
  });

  it("keeps per-action settings, sendToPlugin markers, and openUrl relay on the host path", () => {
    const { bridge, real } = makeBridge();
    const received: Record<string, unknown>[] = [];
    bridge.onmessage = (ev) => received.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    real.triggerOpen();
    real.triggerMessage(JSON.stringify({ cmd: "didReceiveGlobalSettings", settings: { _settingsChannel: CHANNEL } }));
    FakeNativeWebSocket.instances[1]!.triggerOpen();

    bridge.send(JSON.stringify({ event: "openUrl", payload: { url: "https://iracedeck.com/" } }));
    bridge.send(JSON.stringify({ event: "setSettings", payload: { mode: "x" } }));
    real.triggerMessage(JSON.stringify({ cmd: "didReceiveSettings", settings: { mode: "x" } }));

    expect(parsed(real.sent).at(-2)).toMatchObject({
      cmd: "sendToPlugin",
      payload: { event: "openUrl", url: "https://iracedeck.com/" },
    });
    expect(parsed(real.sent).at(-1)).toMatchObject({ cmd: "setSettings", settings: { mode: "x" } });
    expect(received.at(-1)).toMatchObject({ event: "didReceiveSettings", payload: { settings: { mode: "x" } } });
  });
});
