import { beforeEach, describe, expect, it, vi } from "vitest";

import { installUlanziBridge, readIdentity, UlanziBridgeSocket } from "./index.js";
import type { BridgeIdentity } from "./translate.js";

/** Fake native WebSocket capturing outbound frames + exposing event triggers. */
class FakeNativeWebSocket {
  static instances: FakeNativeWebSocket[] = [];
  readonly url: string;
  readonly sent: string[] = [];
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

  close(): void {}

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
  const makeBridge = (): { bridge: UlanziBridgeSocket; real: FakeNativeWebSocket } => {
    const bridge = new UlanziBridgeSocket(identity, FakeNativeWebSocket as unknown as typeof WebSocket);

    return { bridge, real: FakeNativeWebSocket.instances[0] };
  };

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
    expect(onopen).toHaveBeenCalledOnce();
    expect(bridge.readyState).toBe(1);
  });

  it("translates outbound Elgato frames to Ulanzi and swallows the registration frame", () => {
    const { bridge, real } = makeBridge();
    real.triggerOpen();
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
