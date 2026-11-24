import type StreamDeck from "@elgato/streamdeck";
import { LogLevel } from "@iracedeck/logger";
import { describe, expect, it, vi } from "vitest";

import { ElgatoPlatformAdapter } from "./adapter.js";
import { elgatoPluginLogFile } from "./log-file.js";

/** A registration-info fixture in the shape Stream Deck passes with `-info` (trimmed to what is read). */
const REGISTRATION_INFO = {
  application: {
    font: "Segoe UI",
    language: "en",
    platform: "windows",
    platformVersion: "10.0.26300",
    version: "7.1.0.21212",
  },
  plugin: { uuid: "com.iracedeck.sd.core", version: "3.10.0.0" },
};

/**
 * The smallest SDK the constructor and the contract members touch. `info` is
 * the SDK's registration-info getter; pass a function to make it throw, as the
 * real one does when the registration arguments are missing.
 */
function createSd(info: unknown = REGISTRATION_INFO) {
  const setLevel = vi.fn();
  const sd = {
    logger: { setLevel, createScope: vi.fn() },
    ui: { onSendToPlugin: vi.fn() },
    get info(): unknown {
      return typeof info === "function" ? info() : info;
    },
  };

  return { sd: sd as unknown as typeof StreamDeck, setLevel };
}

describe("ElgatoPlatformAdapter — the #1349 contract members", () => {
  it.each([
    // The SDK turns a level above its production minimum ("debug") into "info".
    [LogLevel.Trace, "debug"],
    [LogLevel.Debug, "debug"],
    [LogLevel.Info, "info"],
    [LogLevel.Warn, "warn"],
    [LogLevel.Error, "error"],
    // The SDK has no "silent"; error is the quietest level it offers.
    [LogLevel.Silent, "error"],
  ])("setLogLevel(%s) forwards %s to the SDK logger", (level, expected) => {
    const { sd, setLevel } = createSd();

    new ElgatoPlatformAdapter(sd).setLogLevel(level);

    expect(setLevel).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it("reports the file the SDK's logger writes as its log location", () => {
    const { sd } = createSd();

    expect(new ElgatoPlatformAdapter(sd).logLocation).toEqual({ kind: "file", path: elgatoPluginLogFile() });
  });
});

describe("ElgatoPlatformAdapter — hostApplication (#1678)", () => {
  it("names Stream Deck with the version from the registration info", () => {
    const { sd } = createSd();

    expect(new ElgatoPlatformAdapter(sd).hostApplication).toEqual({ name: "Stream Deck", version: "7.1.0.21212" });
  });

  it.each([
    ["no application.version", { application: { language: "en" } }],
    ["an empty application.version", { application: { version: "" } }],
    ["a non-string application.version", { application: { version: 7 } }],
    ["no application", {}],
    ["no registration info", null],
  ])("still names Stream Deck, with a null version, for %s", (_label, info) => {
    const { sd } = createSd(info);

    expect(new ElgatoPlatformAdapter(sd).hostApplication).toEqual({ name: "Stream Deck", version: null });
  });

  it("gives a null version when reading the registration info throws, never throwing itself", () => {
    const { sd } = createSd(() => {
      throw new Error("Unable to establish a connection with Stream Deck, missing command line arguments: -info");
    });

    expect(new ElgatoPlatformAdapter(sd).hostApplication).toEqual({ name: "Stream Deck", version: null });
  });
});
