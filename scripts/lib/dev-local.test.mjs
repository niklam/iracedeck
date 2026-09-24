/**
 * The gitignored developer marker `dev.local.json` (#1143) and the machine-wide
 * `IRACEDECK_DEV_VOICES` opt-in it overrides (#1214). These run against a real
 * temp filesystem (like `plugin-link.test.mjs`) because the reader's whole job
 * is deciding what is on disk and resolving a path against the repo root — a
 * mocked `fs` would assert the code's own assumptions back at itself.
 *
 * The throwing cases are the point of the file: unlike `feature-flags.local.json`,
 * which warns and ignores an unknown key, this file has exactly one key, so a
 * typo must be loud instead of silently switching development mode back off —
 * and the variable is held to the same standard, since a machine-wide opt-in
 * that silently failed to take is the same failure with a longer search.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DEV_VOICE_PACKS_ROOT,
  DEV_LOCAL_FILE,
  DEV_VOICES_ENV,
  readDevLocal,
  readDevVoicesEnv,
  resolveDevVoicePacksRoot,
} from "./dev-local.mjs";

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

/** An environment holding only the opt-in, or nothing at all for `undefined`. */
function envWith(value) {
  return value === undefined ? {} : { [DEV_VOICES_ENV]: value };
}

describe("constants", () => {
  it("names the marker file", () => {
    expect(DEV_LOCAL_FILE).toBe("dev.local.json");
  });

  it("defaults the voice-pack root to the packer's staged output", () => {
    expect(DEFAULT_DEV_VOICE_PACKS_ROOT).toBe("packages/audio-assets/dist/voice-packs");
  });

  it("names the machine-wide opt-in variable", () => {
    expect(DEV_VOICES_ENV).toBe("IRACEDECK_DEV_VOICES");
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

  it("returns voicePacksRoot: false as-is — the explicit per-worktree off (#1214)", () => {
    writeMarker(JSON.stringify({ voicePacksRoot: false }));

    expect(readDevLocal(root)).toEqual({ voicePacksRoot: false });
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

  it.each([
    ["a number", "42"],
    // `true` is the one a developer reaching for "on" would type; only `false`
    // has a meaning, and it must not be read as "on at some default".
    ["true", "true"],
    ["null", "null"],
    ["an object", "{}"],
  ])("throws on a voicePacksRoot that is %s", (_label, literal) => {
    writeMarker(`{ "voicePacksRoot": ${literal} }`);

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

describe("readDevVoicesEnv", () => {
  it("is off when the variable is unset", () => {
    expect(readDevVoicesEnv({})).toBe(false);
  });

  it("is off for 0 and on for 1", () => {
    expect(readDevVoicesEnv(envWith("0"))).toBe(false);
    expect(readDevVoicesEnv(envWith("1"))).toBe(true);
  });

  it.each(["", " 1", "1 ", "true", "yes", "on", "01", "2"])("throws naming the variable for %o", (value) => {
    expect(() => readDevVoicesEnv(envWith(value))).toThrow(/IRACEDECK_DEV_VOICES/);
    expect(() => readDevVoicesEnv(envWith(value))).toThrow(JSON.stringify(value));
  });

  it("defaults to process.env", () => {
    const saved = process.env[DEV_VOICES_ENV];
    try {
      process.env[DEV_VOICES_ENV] = "1";
      expect(readDevVoicesEnv()).toBe(true);
      delete process.env[DEV_VOICES_ENV];
      expect(readDevVoicesEnv()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env[DEV_VOICES_ENV];
      else process.env[DEV_VOICES_ENV] = saved;
    }
  });
});

/**
 * The spec's §2 table as a matrix: every marker state crossed with every
 * variable state. `expected` is a function of the temp root because the
 * resolved paths are absolute.
 */
describe("resolveDevVoicePacksRoot", () => {
  const defaultRoot = () => path.resolve(root, DEFAULT_DEV_VOICE_PACKS_ROOT);
  const customRoot = () => path.resolve(root, "local", "my-packs");

  const OFF_NO_SOURCE = () => ({ voicePacksRoot: undefined, source: undefined, isDefaultRoot: false });
  const OFF_BY_MARKER = () => ({ voicePacksRoot: undefined, source: DEV_LOCAL_FILE, isDefaultRoot: false });
  const ON_BY_ENV = () => ({ voicePacksRoot: defaultRoot(), source: DEV_VOICES_ENV, isDefaultRoot: true });
  const ON_BY_MARKER_DEFAULT = () => ({ voicePacksRoot: defaultRoot(), source: DEV_LOCAL_FILE, isDefaultRoot: true });
  const ON_BY_MARKER_CUSTOM = () => ({ voicePacksRoot: customRoot(), source: DEV_LOCAL_FILE, isDefaultRoot: false });

  /** [label, marker text or undefined for absent, env value, expected] */
  const MATRIX = [
    // Marker absent: the variable decides.
    ["absent", undefined, undefined, OFF_NO_SOURCE],
    ["absent", undefined, "0", OFF_NO_SOURCE],
    ["absent", undefined, "1", ON_BY_ENV],
    // An empty marker claims nothing, so it is the same as absent.
    ["{}", "{}", undefined, OFF_NO_SOURCE],
    ["{}", "{}", "0", OFF_NO_SOURCE],
    ["{}", "{}", "1", ON_BY_ENV],
    // A path in the marker wins over the variable in every state.
    [
      "the default path",
      JSON.stringify({ voicePacksRoot: DEFAULT_DEV_VOICE_PACKS_ROOT }),
      undefined,
      ON_BY_MARKER_DEFAULT,
    ],
    ["the default path", JSON.stringify({ voicePacksRoot: DEFAULT_DEV_VOICE_PACKS_ROOT }), "0", ON_BY_MARKER_DEFAULT],
    ["the default path", JSON.stringify({ voicePacksRoot: DEFAULT_DEV_VOICE_PACKS_ROOT }), "1", ON_BY_MARKER_DEFAULT],
    ["a hand-picked path", JSON.stringify({ voicePacksRoot: "local/my-packs" }), undefined, ON_BY_MARKER_CUSTOM],
    ["a hand-picked path", JSON.stringify({ voicePacksRoot: "local/my-packs" }), "0", ON_BY_MARKER_CUSTOM],
    ["a hand-picked path", JSON.stringify({ voicePacksRoot: "local/my-packs" }), "1", ON_BY_MARKER_CUSTOM],
    // `false` is the explicit per-worktree off, and it beats the machine opt-in.
    ["false", JSON.stringify({ voicePacksRoot: false }), undefined, OFF_BY_MARKER],
    ["false", JSON.stringify({ voicePacksRoot: false }), "0", OFF_BY_MARKER],
    ["false", JSON.stringify({ voicePacksRoot: false }), "1", OFF_BY_MARKER],
  ];

  it.each(MATRIX)("marker %s × IRACEDECK_DEV_VOICES=%o", (_label, markerText, envValue, expected) => {
    if (markerText !== undefined) writeMarker(markerText);

    expect(resolveDevVoicePacksRoot(root, { env: envWith(envValue) })).toEqual(expected());
  });

  it("resolves a hand-picked absolute path as-is, and does not call it the default root", () => {
    const absolute = path.resolve(root, "elsewhere", "voice-packs");
    writeMarker(JSON.stringify({ voicePacksRoot: absolute }));

    expect(resolveDevVoicePacksRoot(root, { env: envWith("1") })).toEqual({
      voicePacksRoot: absolute,
      source: DEV_LOCAL_FILE,
      isDefaultRoot: false,
    });
  });

  it("recognises the default root however the marker spells it", () => {
    // Backslashes and a trailing separator resolve to the same directory.
    writeMarker(
      JSON.stringify({ voicePacksRoot: `${DEFAULT_DEV_VOICE_PACKS_ROOT.replaceAll("/", path.sep)}${path.sep}` }),
    );

    expect(resolveDevVoicePacksRoot(root, { env: {} }).isDefaultRoot).toBe(true);
  });

  describe("an invalid marker throws in every variable state", () => {
    it.each([
      ["a non-string, non-false root", JSON.stringify({ voicePacksRoot: 7 })],
      ["a blank root", JSON.stringify({ voicePacksRoot: "" })],
      ["true", JSON.stringify({ voicePacksRoot: true })],
      ["an unknown key", JSON.stringify({ voicePackRoot: "x" })],
      ["invalid JSON", "{ not json"],
      ["an array", "[]"],
    ])("%s", (_label, markerText) => {
      writeMarker(markerText);

      for (const envValue of [undefined, "0", "1"]) {
        expect(() => resolveDevVoicePacksRoot(root, { env: envWith(envValue) })).toThrow(/dev\.local\.json/);
      }
    });
  });

  describe("a garbage variable throws in every marker state", () => {
    // Including the rows the marker would decide on its own: the value is a
    // typo in someone's user environment, and a worktree that happens to carry
    // a marker is the wrong place for it to pass unnoticed.
    it.each([
      ["absent", undefined],
      ["{}", "{}"],
      ["the default path", JSON.stringify({ voicePacksRoot: DEFAULT_DEV_VOICE_PACKS_ROOT })],
      ["a hand-picked path", JSON.stringify({ voicePacksRoot: "local/my-packs" })],
      ["false", JSON.stringify({ voicePacksRoot: false })],
    ])("marker %s", (_label, markerText) => {
      if (markerText !== undefined) writeMarker(markerText);

      for (const value of ["true", "yes", "", "01"]) {
        expect(() => resolveDevVoicePacksRoot(root, { env: envWith(value) })).toThrow(/IRACEDECK_DEV_VOICES/);
      }
    });
  });

  it("reads the marker through an injected fs", () => {
    const file = path.join(root, DEV_LOCAL_FILE);
    const fs = {
      existsSync: (p) => p === file,
      readFileSync: () => JSON.stringify({ voicePacksRoot: false }),
    };

    expect(resolveDevVoicePacksRoot(root, { env: envWith("1"), fs })).toEqual(OFF_BY_MARKER());
  });

  it("defaults to process.env", () => {
    const saved = process.env[DEV_VOICES_ENV];
    try {
      process.env[DEV_VOICES_ENV] = "1";
      expect(resolveDevVoicePacksRoot(root)).toEqual(ON_BY_ENV());
      delete process.env[DEV_VOICES_ENV];
      expect(resolveDevVoicePacksRoot(root)).toEqual(OFF_NO_SOURCE());
    } finally {
      if (saved === undefined) delete process.env[DEV_VOICES_ENV];
      else process.env[DEV_VOICES_ENV] = saved;
    }
  });
});
