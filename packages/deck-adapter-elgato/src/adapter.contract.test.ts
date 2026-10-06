import type StreamDeck from "@elgato/streamdeck";
import { LogLevel } from "@iracedeck/logger";
import { describe, expect, it, vi } from "vitest";

import { ElgatoPlatformAdapter } from "./adapter.js";
import { elgatoPluginLogFile } from "./log-file.js";

/** The smallest SDK the constructor and the two new members touch. */
function createSd() {
  const setLevel = vi.fn();
  const sd = {
    logger: { setLevel, createScope: vi.fn() },
    ui: { onSendToPlugin: vi.fn() },
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
