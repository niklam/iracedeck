import { describe, expect, it } from "vitest";

import { authorizeSettingsRequest } from "./settings-window-guard.js";

const EXPECTED_ORIGIN = "http://127.0.0.1:61708";
const EXPECTED_TOKEN = "b6f1c0d2e3a4958677889900aabbccdd";

describe("authorizeSettingsRequest", () => {
  it("rejects a cross-site request even when it carries a valid token", () => {
    const result = authorizeSettingsRequest({
      origin: "https://evil.example",
      expectedOrigin: EXPECTED_ORIGIN,
      token: EXPECTED_TOKEN,
      expectedToken: EXPECTED_TOKEN,
    });

    expect(result).toEqual({ allowed: false, reason: "bad-origin" });
  });

  it("rejects a request that carries no token", () => {
    const result = authorizeSettingsRequest({
      origin: undefined,
      expectedOrigin: EXPECTED_ORIGIN,
      token: undefined,
      expectedToken: EXPECTED_TOKEN,
    });

    expect(result).toEqual({ allowed: false, reason: "bad-token" });
  });

  it("rejects a request whose token does not match the launch token", () => {
    const result = authorizeSettingsRequest({
      origin: undefined,
      expectedOrigin: EXPECTED_ORIGIN,
      token: "deadbeef",
      expectedToken: EXPECTED_TOKEN,
    });

    expect(result).toEqual({ allowed: false, reason: "bad-token" });
  });

  it("allows a top-level navigation (no Origin) that carries the launch token", () => {
    const result = authorizeSettingsRequest({
      origin: undefined,
      expectedOrigin: EXPECTED_ORIGIN,
      token: EXPECTED_TOKEN,
      expectedToken: EXPECTED_TOKEN,
    });

    expect(result).toEqual({ allowed: true });
  });

  it("allows a same-origin request that carries the launch token", () => {
    const result = authorizeSettingsRequest({
      origin: EXPECTED_ORIGIN,
      expectedOrigin: EXPECTED_ORIGIN,
      token: EXPECTED_TOKEN,
      expectedToken: EXPECTED_TOKEN,
    });

    expect(result).toEqual({ allowed: true });
  });

  it("checks origin before token, so a hostile origin is reported even with a bad token", () => {
    const result = authorizeSettingsRequest({
      origin: "https://evil.example",
      expectedOrigin: EXPECTED_ORIGIN,
      token: undefined,
      expectedToken: EXPECTED_TOKEN,
    });

    expect(result).toEqual({ allowed: false, reason: "bad-origin" });
  });
});

describe("authorizeSettingsRequest — session cookie", () => {
  it("allows a same-origin request that carries the session cookie but no token (relative script src)", () => {
    const result = authorizeSettingsRequest({
      origin: undefined,
      expectedOrigin: EXPECTED_ORIGIN,
      token: undefined,
      expectedToken: EXPECTED_TOKEN,
      cookie: EXPECTED_TOKEN,
    });

    expect(result).toEqual({ allowed: true });
  });

  it("rejects a request whose cookie does not match", () => {
    const result = authorizeSettingsRequest({
      origin: undefined,
      expectedOrigin: EXPECTED_ORIGIN,
      token: undefined,
      expectedToken: EXPECTED_TOKEN,
      cookie: "stale",
    });

    expect(result).toEqual({ allowed: false, reason: "bad-token" });
  });

  it("still checks origin first — a hostile origin loses even with a valid cookie", () => {
    const result = authorizeSettingsRequest({
      origin: "https://evil.example",
      expectedOrigin: EXPECTED_ORIGIN,
      token: undefined,
      expectedToken: EXPECTED_TOKEN,
      cookie: EXPECTED_TOKEN,
    });

    expect(result).toEqual({ allowed: false, reason: "bad-origin" });
  });
});
