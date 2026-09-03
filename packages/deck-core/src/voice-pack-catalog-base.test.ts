import type { ILogger } from "@iracedeck/logger";
import { describe, expect, it, vi } from "vitest";

import { resolveVoicePackCatalogUrl } from "./voice-pack-catalog-base.js";
import { VOICE_PACK_CATALOG_URL } from "./voice-pack-catalog-client.js";

function logger() {
  const log = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: () => log,
    createScope: () => log,
  };

  return log as unknown as ILogger & typeof log;
}

describe("resolveVoicePackCatalogUrl", () => {
  // THE pin. Everything else here is an addition on top of behaviour that must
  // not move, and this asserts it against the shipped constant itself rather
  // than against a copy of the string — so the two cannot drift apart.
  it.each([
    ["undefined", undefined],
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("resolves to exactly the published URL when the override is %s", (_label, base) => {
    expect(resolveVoicePackCatalogUrl({ base })).toBe(VOICE_PACK_CATALOG_URL);
  });

  it("uses an https override, at any host", () => {
    expect(resolveVoicePackCatalogUrl({ base: "https://staging.example.com" })).toBe(
      "https://staging.example.com/voice-catalog.json",
    );
  });

  // The whole point of the loopback exception: a developer serving a catalog
  // from a local file server, where plaintext costs nothing.
  it.each([
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080/voice-catalog.json"],
    ["http://localhost:3000", "http://localhost:3000/voice-catalog.json"],
  ])("accepts plaintext to loopback: %s", (base, expected) => {
    expect(resolveVoicePackCatalogUrl({ base })).toBe(expected);
  });

  it("refuses plaintext to a real host, and says so", () => {
    const log = logger();

    expect(resolveVoicePackCatalogUrl({ base: "http://example.com", logger: log })).toBe(VOICE_PACK_CATALOG_URL);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  // Never throws, whatever is in the file — the value is hand-edited by
  // definition, so every one of these is a realistic typo.
  it.each([
    ["not a URL at all", "iracedeck.com"],
    ["a bare word", "localhost"],
    ["a file URL", "file:///C:/catalog"],
    ["a data URL", "data:application/json,{}"],
    ["a javascript URL", "javascript:alert(1)"],
    ["an ftp URL", "ftp://example.com"],
  ])("ignores %s and uses the default", (_label, base) => {
    const log = logger();

    expect(() => resolveVoicePackCatalogUrl({ base, logger: log })).not.toThrow();
    expect(resolveVoicePackCatalogUrl({ base, logger: log })).toBe(VOICE_PACK_CATALOG_URL);
    expect(log.warn).toHaveBeenCalled();
  });

  it("joins onto a base that carries a path, with or without a trailing slash", () => {
    expect(resolveVoicePackCatalogUrl({ base: "http://127.0.0.1:8080/fixtures" })).toBe(
      "http://127.0.0.1:8080/fixtures/voice-catalog.json",
    );
    expect(resolveVoicePackCatalogUrl({ base: "http://127.0.0.1:8080/fixtures/" })).toBe(
      "http://127.0.0.1:8080/fixtures/voice-catalog.json",
    );
    expect(resolveVoicePackCatalogUrl({ base: "http://127.0.0.1:8080///" })).toBe(
      "http://127.0.0.1:8080/voice-catalog.json",
    );
  });

  // The value names a LOCATION and nothing else. It cannot choose the file, and
  // it cannot append parameters to the request.
  it.each([
    ["a query", "https://example.com/x?token=abc"],
    ["a fragment", "https://example.com/x#frag"],
  ])("refuses a base carrying %s", (_label, base) => {
    const log = logger();

    expect(resolveVoicePackCatalogUrl({ base, logger: log })).toBe(VOICE_PACK_CATALOG_URL);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("always asks for the catalog filename, never one the base names", () => {
    expect(resolveVoicePackCatalogUrl({ base: "https://example.com/evil.json" })).toBe(
      "https://example.com/evil.json/voice-catalog.json",
    );
  });

  it("says nothing when no override is set", () => {
    const log = logger();

    resolveVoicePackCatalogUrl({ logger: log });

    expect(log.warn).not.toHaveBeenCalled();
  });
});
