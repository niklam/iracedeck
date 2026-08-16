import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_TIMEOUT_MS,
  createSettingsChannelRouter,
  type LoopbackHandlers,
  type LoopbackSocket,
  parseSettingsChannel,
  type PiFrame,
  type SettingsChannel,
} from "./router.js";

const CHANNEL: SettingsChannel = { port: 55762, token: "cc29ab52f34a2a927663a0832b86a807b4cc329ebe68a98d" };
const IDENTITY = { context: "ctx-1", action: "com.iracedeck.sd.core.car-control" };
const BOOTSTRAP = { event: "getGlobalSettings", context: IDENTITY.context, action: IDENTITY.action };

function hostReply(settings: Record<string, unknown>): PiFrame {
  return { event: "didReceiveGlobalSettings", payload: { settings } };
}

/** A router harness with fake host, fake sdpi, fake loopback and manual timers. */
function harness(opts: { openThrows?: boolean; bootstrapTimeoutMs?: number } = {}) {
  const host: PiFrame[] = [];
  const pi: PiFrame[] = [];
  const loop: PiFrame[] = [];
  const warnings: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const opened: SettingsChannel[] = [];
  let handlers: LoopbackHandlers | undefined;
  let closedLoop = 0;

  const router = createSettingsChannelRouter({
    identity: IDENTITY,
    toHost: (f) => host.push(f),
    toPi: (f) => pi.push(f),
    openLoopback: (channel, h): LoopbackSocket => {
      opened.push(channel);

      if (opts.openThrows) throw new Error("refused");

      handlers = h;

      return { send: (f) => loop.push(f), close: () => closedLoop++ };
    },
    warn: (m) => warnings.push(m),
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);

      return t;
    },
    clearTimeout: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
    bootstrapTimeoutMs: opts.bootstrapTimeoutMs,
  });

  return {
    router,
    host,
    pi,
    loop,
    warnings,
    timers,
    opened,
    closedLoop: () => closedLoop,
    loopOpen: () => handlers!.onOpen(),
    loopMessage: (f: PiFrame) => handlers!.onMessage(f),
    loopClose: () => handlers!.onClose(),
    fireTimer: () => timers.filter((t) => !t.cleared).forEach((t) => t.fn()),
  };
}

describe("parseSettingsChannel", () => {
  it("accepts a well-formed channel", () => {
    expect(parseSettingsChannel({ _settingsChannel: CHANNEL, other: 1 })).toEqual(CHANNEL);
  });

  it("rejects a missing key, a bad port, a short token, and non-objects", () => {
    expect(parseSettingsChannel({})).toBeUndefined();
    expect(parseSettingsChannel({ _settingsChannel: { port: 0, token: CHANNEL.token } })).toBeUndefined();
    expect(parseSettingsChannel({ _settingsChannel: { port: 70000, token: CHANNEL.token } })).toBeUndefined();
    expect(parseSettingsChannel({ _settingsChannel: { port: 8080, token: "abc" } })).toBeUndefined();
    expect(parseSettingsChannel({ _settingsChannel: { port: "8080", token: CHANNEL.token } })).toBeUndefined();
    expect(parseSettingsChannel(null)).toBeUndefined();
    expect(parseSettingsChannel("x")).toBeUndefined();
  });
});

describe("createSettingsChannelRouter", () => {
  it("bootstraps on host open with sdpi's own envelope shape and arms the timer", () => {
    const h = harness();

    expect(h.router.state).toBe("idle");
    h.router.onHostOpen();

    expect(h.router.state).toBe("bootstrapping");
    expect(h.host).toEqual([BOOTSTRAP]);
    expect(h.timers[0]?.ms).toBe(BOOTSTRAP_TIMEOUT_MS);
  });

  it("passes every non-global frame straight through in both directions", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onPiSend({ event: "registerPropertyInspector", uuid: "ctx-1" });
    h.router.onPiSend({ event: "sendToPlugin", context: "ctx-1", payload: { event: "openSettings" } });
    h.router.onHostMessage({ event: "didReceiveSettings", payload: { settings: { a: 1 } } });

    expect(h.host.slice(1)).toEqual([
      { event: "registerPropertyInspector", uuid: "ctx-1" },
      { event: "sendToPlugin", context: "ctx-1", payload: { event: "openSettings" } },
    ]);
    expect(h.pi).toEqual([{ event: "didReceiveSettings", payload: { settings: { a: 1 } } }]);
  });

  it("queues global frames while bootstrapping, switches to the loopback on a channel, and replays the queue there", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onPiSend({ event: "getGlobalSettings", context: "ctx-1" });
    h.router.onPiSend({ event: "setGlobalSettings", context: "ctx-1", payload: { driverName: "n" } });

    expect(h.host).toHaveLength(1); // only the bootstrap read went to the host
    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL, driverName: "host" }));

    expect(h.router.state).toBe("connecting");
    expect(h.opened).toEqual([CHANNEL]);
    expect(h.timers[0]?.cleared).toBe(true);
    expect(h.pi).toEqual([]); // the host's payload is NOT delivered — the store is truth

    h.loopOpen();

    expect(h.router.state).toBe("loopback");
    expect(h.loop).toEqual([
      BOOTSTRAP, // the router's own read of the file's values
      { event: "getGlobalSettings", context: "ctx-1" },
      { event: "setGlobalSettings", context: "ctx-1", payload: { driverName: "n" } },
    ]);
  });

  it("in loopback state: sdpi's global frames go to the loopback, loopback pushes reach sdpi, host pushes are dropped", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL }));
    h.loopOpen();
    h.loop.length = 0;

    h.router.onPiSend({ event: "setGlobalSettings", payload: { a: 1 } });
    h.loopMessage(hostReply({ a: 1, fromLoop: true }));
    h.router.onHostMessage(hostReply({ a: "stale-host" }));

    expect(h.loop).toEqual([{ event: "setGlobalSettings", payload: { a: 1 } }]);
    expect(h.pi).toEqual([hostReply({ a: 1, fromLoop: true })]);
    expect(h.host).toHaveLength(1);
  });

  it("falls back to the host path when the reply carries no channel: delivers the host payload and flushes the queue to the host", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onPiSend({ event: "getGlobalSettings", context: "ctx-1" });
    h.router.onHostMessage(hostReply({ driverName: "host-only" }));

    expect(h.router.state).toBe("fallback");
    expect(h.pi).toEqual([hostReply({ driverName: "host-only" })]);
    expect(h.host).toEqual([BOOTSTRAP, { event: "getGlobalSettings", context: "ctx-1" }]);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatch(/_settingsChannel/);
    // and stays on the host path afterwards
    h.router.onPiSend({ event: "setGlobalSettings", payload: { x: 1 } });
    h.router.onHostMessage(hostReply({ x: 1 }));
    expect(h.host.at(-1)).toEqual({ event: "setGlobalSettings", payload: { x: 1 } });
    expect(h.pi.at(-1)).toEqual(hostReply({ x: 1 }));
  });

  it("falls back when the loopback connect fails, using the last host payload", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onPiSend({ event: "getGlobalSettings" });
    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL, driverName: "host" }));
    h.loopClose(); // closed before it ever opened

    expect(h.router.state).toBe("fallback");
    expect(h.pi).toEqual([hostReply({ _settingsChannel: CHANNEL, driverName: "host" })]);
    expect(h.host).toEqual([BOOTSTRAP, { event: "getGlobalSettings" }]);
    expect(h.warnings[0]).toMatch(/refused/);
  });

  it("treats a throwing openLoopback like an immediate close", () => {
    const h = harness({ openThrows: true });
    h.router.onHostOpen();
    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL }));

    expect(h.router.state).toBe("fallback");
    expect(h.pi).toEqual([hostReply({ _settingsChannel: CHANNEL })]);
  });

  it("falls back on the bootstrap timeout and flushes the queue to the host", () => {
    const h = harness({ bootstrapTimeoutMs: 10 });
    h.router.onHostOpen();
    h.router.onPiSend({ event: "getGlobalSettings" });
    h.fireTimer();

    expect(h.router.state).toBe("fallback");
    expect(h.host).toEqual([BOOTSTRAP, { event: "getGlobalSettings" }]);
    expect(h.warnings[0]).toMatch(/did not answer/);
    // a late reply is now delivered like any host push
    h.router.onHostMessage(hostReply({ late: true }));
    expect(h.pi).toEqual([hostReply({ late: true })]);
  });

  it("switches late: a host push carrying a channel while in fallback triggers the connect", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onHostMessage(hostReply({ noChannel: true }));
    expect(h.router.state).toBe("fallback");

    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL }));

    expect(h.router.state).toBe("connecting");
    expect(h.opened).toEqual([CHANNEL]);
    expect(h.pi).toHaveLength(2); // the fallback delivery continues until the loopback is up
  });

  it("does not retry the same channel that already failed, but tries a new one", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL }));
    h.loopClose();
    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL }));

    expect(h.router.state).toBe("fallback");
    expect(h.opened).toHaveLength(1);
    h.router.onHostMessage(hostReply({ _settingsChannel: { ...CHANNEL, port: 60000 } }));
    expect(h.opened).toHaveLength(2);
  });

  it("a loopback close after switch-over falls back to the host for later frames and warns once", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL }));
    h.loopOpen();
    h.loopClose();
    h.router.onPiSend({ event: "getGlobalSettings" });

    expect(h.router.state).toBe("fallback");
    expect(h.host.at(-1)).toEqual({ event: "getGlobalSettings" });
    expect(h.warnings).toEqual([expect.stringMatching(/closed/)]);
  });

  it("onHostClose closes the loopback and clears a pending timer", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL }));
    h.loopOpen();
    h.router.onHostClose();

    expect(h.closedLoop()).toBe(1);
    const h2 = harness();
    h2.router.onHostOpen();
    h2.router.onHostClose();
    expect(h2.timers[0]?.cleared).toBe(true);
  });
});
