import { describe, expect, it } from "vitest";

import {
  type BridgeIdentity,
  elgatoToUlanzi,
  encodeContext,
  PI_READ_ACTIONID,
  PLUGIN_UUID,
  ulanziToElgato,
} from "./translate.js";

const identity: BridgeIdentity = {
  address: "127.0.0.1",
  port: "49200",
  uuid: "com.iracedeck.sd.core.black-box-selector",
  key: "5",
  actionid: "abc",
  device: "D200X",
  language: "en",
  controller: "Keypad",
};

const context = "com.iracedeck.sd.core.black-box-selector___5___abc";

describe("encodeContext", () => {
  it("joins parts with triple underscores", () => {
    expect(encodeContext("u", "k", "a")).toBe("u___k___a");
  });
});

describe("elgatoToUlanzi", () => {
  it("scopes a global-settings WRITE to the plugin UUID with a blank context", () => {
    // UlanziStudio persists global settings bucketed by the frame's `uuid`
    // verbatim. The plugin main service reads with the plugin UUID, so a PI
    // write carrying the action UUID lands in a per-action bucket the plugin
    // never reads back at boot — key bindings then vanish on restart (#868).
    expect(PLUGIN_UUID).toBe("com.iracedeck.sd.core");

    expect(elgatoToUlanzi({ event: "setGlobalSettings", payload: { debugLogging: true } }, identity)).toEqual({
      cmd: "setGlobalSettings",
      uuid: PLUGIN_UUID,
      key: "",
      actionid: "",
      settings: { debugLogging: true },
    });
  });

  it("carries the PI's routing identity on a global-settings READ (#1039)", () => {
    // The host answers a read only when `actionid` is non-empty — it routes the
    // reply by that field — while the bucket it returns is plugin-wide either
    // way. So the read keeps the plugin UUID but must carry the PI's own
    // key/actionid, or no reply ever arrives and every `global` control in the
    // PI stays empty.
    expect(elgatoToUlanzi({ event: "getGlobalSettings" }, identity)).toEqual({
      cmd: "getGlobalSettings",
      uuid: PLUGIN_UUID,
      key: "5",
      actionid: "abc",
    });
  });

  it("substitutes an actionid on a read when the PI URL carried none (#1039)", () => {
    // `readIdentity` defaults `actionid` to "" when the query string omits it,
    // and a blank one is exactly what the host will not answer. Any non-empty
    // value is routed (the host echoes it back rather than looking it up), so
    // an unaddressed PI still gets its settings.
    const anonymous: BridgeIdentity = { ...identity, actionid: "" };
    const frame = elgatoToUlanzi({ event: "getGlobalSettings" }, anonymous);

    expect(frame).toEqual({
      cmd: "getGlobalSettings",
      uuid: PLUGIN_UUID,
      key: "5",
      actionid: PI_READ_ACTIONID,
    });
    expect(PI_READ_ACTIONID).not.toBe("");
  });

  it("translates per-action settings reads/writes carrying the PI identity", () => {
    expect(elgatoToUlanzi({ event: "getSettings" }, identity)).toEqual({
      cmd: "getSettings",
      uuid: identity.uuid,
      key: "5",
      actionid: "abc",
    });

    expect(elgatoToUlanzi({ event: "setSettings", payload: { mode: "next" } }, identity)).toEqual({
      cmd: "setSettings",
      uuid: identity.uuid,
      key: "5",
      actionid: "abc",
      settings: { mode: "next" },
    });
  });

  it("translates sendToPlugin, openUrl, and logMessage", () => {
    expect(elgatoToUlanzi({ event: "sendToPlugin", payload: { foo: 1 } }, identity)).toMatchObject({
      cmd: "sendToPlugin",
      payload: { foo: 1 },
    });

    // openUrl relays through the plugin socket (sendToPlugin marker): the host
    // ignores `openurl` sent on the PI socket, so the plugin re-sends it (#845).
    expect(elgatoToUlanzi({ event: "openUrl", payload: { url: "https://x/" } }, identity)).toEqual({
      cmd: "sendToPlugin",
      uuid: identity.uuid,
      key: "5",
      actionid: "abc",
      payload: { event: "openUrl", url: "https://x/" },
    });

    expect(elgatoToUlanzi({ event: "logMessage", payload: { message: "hi" } }, identity)).toEqual({
      cmd: "logMessage",
      message: "hi",
      level: "info",
    });
  });

  it("swallows the Elgato registration frame (and anything unmapped)", () => {
    expect(elgatoToUlanzi({ event: "registerPropertyInspector", uuid: context }, identity)).toBeNull();
    expect(elgatoToUlanzi({ event: "somethingElse" }, identity)).toBeNull();
  });
});

describe("ulanziToElgato", () => {
  it("translates didReceiveGlobalSettings", () => {
    expect(ulanziToElgato({ cmd: "didReceiveGlobalSettings", settings: { a: 1 } }, identity)).toEqual({
      event: "didReceiveGlobalSettings",
      payload: { settings: { a: 1 } },
    });
  });

  it("translates settings-change frames to didReceiveSettings with the action filter fields", () => {
    for (const cmd of ["didReceiveSettings", "paramfromapp", "paramfromplugin"]) {
      expect(ulanziToElgato({ cmd, param: { mode: "next" } }, identity)).toEqual({
        event: "didReceiveSettings",
        action: identity.uuid,
        context,
        device: "D200X",
        payload: { settings: { mode: "next" } },
      });
    }
  });

  it("translates sendToPropertyInspector", () => {
    expect(ulanziToElgato({ cmd: "sendToPropertyInspector", payload: { items: [] } }, identity)).toEqual({
      event: "sendToPropertyInspector",
      action: identity.uuid,
      context,
      payload: { items: [] },
    });
  });

  it("drops unmapped frames", () => {
    expect(ulanziToElgato({ cmd: "state" }, identity)).toBeNull();
    expect(ulanziToElgato({ cmd: "toast", msg: "x" }, identity)).toBeNull();
  });
});
