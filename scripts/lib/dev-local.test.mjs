/**
 * The gitignored developer marker `dev.local.json` (#1143). These run against a
 * real temp filesystem (like `plugin-link.test.mjs`) because the reader's whole
 * job is deciding what is on disk and resolving a path against the repo root —
 * a mocked `fs` would assert the code's own assumptions back at itself.
 *
 * The throwing cases are the point of the file: unlike `feature-flags.local.json`,
 * which warns and ignores an unknown key, this file has exactly one key, so a
 * typo must be loud instead of silently switching development mode back off.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_DEV_VOICE_PACKS_ROOT, DEV_LOCAL_FILE, readDevLocal } from "./dev-local.mjs";

let root;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "iracedeck-dev-local-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write `dev.local.json` at the temp repo root with raw text (so invalid JSON is expressible). */
function writeMarker(text) {
  writeFileSync(path.join(root, DEV_LOCAL_FILE), text);
}

describe("constants", () => {
  it("names the marker file", () => {
    expect(DEV_LOCAL_FILE).toBe("dev.local.json");
  });

  it("defaults the voice-pack root to the packer's staged output", () => {
    expect(DEFAULT_DEV_VOICE_PACKS_ROOT).toBe("packages/audio-assets/dist/voice-packs");
  });
});

describe("readDevLocal", () => {
  it("returns {} when the file is absent — the release-build case", () => {
    expect(readDevLocal(root)).toEqual({});
  });

  it("resolves a relative voicePacksRoot against the repo root", () => {
    writeMarker(JSON.stringify({ voicePacksRoot: DEFAULT_DEV_VOICE_PACKS_ROOT }));

    expect(readDevLocal(root)).toEqual({
      voicePacksRoot: path.resolve(root, DEFAULT_DEV_VOICE_PACKS_ROOT),
    });
  });

  it("returns an absolute voicePacksRoot as-is", () => {
    const absolute = path.resolve(root, "elsewhere", "voice-packs");
    writeMarker(JSON.stringify({ voicePacksRoot: absolute }));

    expect(readDevLocal(root).voicePacksRoot).toBe(absolute);
  });

  it("returns {} for an empty object — the file exists but claims nothing", () => {
    writeMarker("{}");

    expect(readDevLocal(root)).toEqual({});
  });

  it("throws naming the unknown key and the file (a typo must not silently disable dev mode)", () => {
    writeMarker(JSON.stringify({ voicePackRoot: "packages/audio-assets/dist/voice-packs" }));

    expect(() => readDevLocal(root)).toThrow(/dev\.local\.json/);
    expect(() => readDevLocal(root)).toThrow(/voicePackRoot/);
    expect(() => readDevLocal(root)).toThrow(/voicePacksRoot/);
  });

  it("throws on a non-string voicePacksRoot", () => {
    writeMarker(JSON.stringify({ voicePacksRoot: 42 }));

    expect(() => readDevLocal(root)).toThrow(/dev\.local\.json.*voicePacksRoot/s);
  });

  it("throws on an empty voicePacksRoot", () => {
    writeMarker(JSON.stringify({ voicePacksRoot: "   " }));

    expect(() => readDevLocal(root)).toThrow(/dev\.local\.json.*voicePacksRoot/s);
  });

  it("throws naming the file on invalid JSON", () => {
    writeMarker("{ not json");

    expect(() => readDevLocal(root)).toThrow(/dev\.local\.json.*not valid JSON/s);
  });

  it("throws when the file holds an array", () => {
    writeMarker("[]");

    expect(() => readDevLocal(root)).toThrow(/dev\.local\.json.*expected an object/s);
  });

  it("throws when the file holds null", () => {
    writeMarker("null");

    expect(() => readDevLocal(root)).toThrow(/dev\.local\.json.*expected an object/s);
  });

  it("reads through an injected fs, so callers can test without a real file", () => {
    const file = path.join(root, DEV_LOCAL_FILE);
    const fs = {
      existsSync: (p) => p === file,
      readFileSync: () => JSON.stringify({ voicePacksRoot: "voices" }),
    };

    expect(readDevLocal(root, { fs })).toEqual({ voicePacksRoot: path.resolve(root, "voices") });
  });
});
