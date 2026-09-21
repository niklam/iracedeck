import { describe, expect, it } from "vitest";

import { resolveHarnessVoice } from "./active-voice.js";

describe("resolveHarnessVoice", () => {
  const available = ["default", "default::default", "luca::matt"];

  it("plays the source tree's bare voice when it is the one picked, even beside an installed default::default", () => {
    expect(resolveHarnessVoice("default", available)).toBe("default");
  });

  it("plays a picked composite voice as it is", () => {
    expect(resolveHarnessVoice("luca::matt", available)).toBe("luca::matt");
  });

  it("hands anything that is not an available voice to the plugins' resolver — the managed voice first", () => {
    // Nothing stored in deck-core's cache in this test, so the plugins' resolver
    // lands on its anchor, `default::default`.
    expect(resolveHarnessVoice("", available)).toBe("default::default");
    expect(resolveHarnessVoice(undefined, available)).toBe("default::default");
    expect(resolveHarnessVoice("titan", available)).toBe("default::default");
  });

  it("is null with no voices at all, as the plugins' resolver is", () => {
    expect(resolveHarnessVoice("default", [])).toBeNull();
  });
});
