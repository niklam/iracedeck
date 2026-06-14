import { describe, expect, it } from "vitest";

import { type BridgeIdentity, elgatoToUlanzi, encodeContext, ulanziToElgato } from "./translate.js";

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
  it("translates settings reads/writes to Ulanzi cmds carrying the PI identity", () => {
    expect(elgatoToUlanzi({ event: "getGlobalSettings" }, identity)).toEqual({
      cmd: "getGlobalSettings",
      uuid: identity.uuid,
      key: "5",
      actionid: "abc",
    });

    expect(elgatoToUlanzi({ event: "setGlobalSettings", payload: { debugLogging: true } }, identity)).toEqual({
      cmd: "setGlobalSettings",
      uuid: identity.uuid,
      key: "5",
      actionid: "abc",
      settings: { debugLogging: true },
    });

    expect(elgatoToUlanzi({ event: "getSettings" }, identity)).toMatchObject({ cmd: "getSettings" });

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

    expect(elgatoToUlanzi({ event: "openUrl", payload: { url: "https://x/" } }, identity)).toEqual({
      cmd: "openurl",
      url: "https://x/",
      local: false,
      param: "",
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
