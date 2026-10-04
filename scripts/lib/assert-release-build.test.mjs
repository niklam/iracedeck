/**
 * The packed-artifact guard (#1143).
 *
 * `dev-voice-root-guard.test.mjs` proves the SOURCE cannot emit
 * `devVoicePacksRoot` unconditionally. This proves the ARTIFACT does not carry
 * it — the thing the spec's *Failure modes* row actually promises — and it is a
 * different question, because `pnpm pack:plugin` packs whatever is on disk in
 * the plugin folder, including a build made from a worktree with `dev:voices
 * on` in effect.
 *
 * Everything is injected: a `fs` port with just the two calls, and a `log`
 * double. The function returns an exit code rather than calling `process.exit`,
 * the shape every `scripts/lib` helper uses.
 */
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  assertReleaseBuild,
  DEV_VOICE_PACKS_ROOT_KEY,
  EXIT_CLEAN,
  EXIT_PROBLEM,
  EXIT_USAGE,
  USAGE,
} from "./assert-release-build.mjs";
import { DEBUG_VALUE } from "./debug-plugin.mjs";

const CONFIG = "com.iracedeck.sd.core.sdPlugin/bin/config.json";
// The manifest sits beside `bin/`; the guard derives it from the config path.
const MANIFEST = path.join("com.iracedeck.sd.core.sdPlugin", "manifest.json");
const RELEASE_CONFIG = JSON.stringify({ version: "3.3.0", platform: "stream-deck", featureFlags: {} });
const MANIFEST_OFF = '{\n  "Nodejs": {\n    "Version": "24"\n  },\n  "UUID": "com.iracedeck.sd.core"\n}\n';
const manifestWith = (value) => MANIFEST_OFF.replace('"24"\n', `"24",\n    "Debug": ${JSON.stringify(value)}\n`);

function fakeLog() {
  return { log: vi.fn(), error: vi.fn() };
}

function output(log) {
  return [...log.log.mock.calls, ...log.error.mock.calls].map((args) => args.join(" ")).join("\n");
}

/** A `fs` port answering each path in `files`; anything else is absent. */
function filesFs(files) {
  return {
    existsSync: (file) => file in files,
    readFileSync: (file) => {
      if (!(file in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (files[file] instanceof Error) throw files[file];

      return files[file];
    },
  };
}

/** A `fs` port answering one path with `contents`; anything else is absent. */
function fakeFs(path, contents) {
  return {
    existsSync: (file) => file === path,
    readFileSync: (file) => {
      if (file !== path) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });

      return contents;
    },
  };
}

describe("assertReleaseBuild", () => {
  it("passes a release build", () => {
    const log = fakeLog();
    const fs = fakeFs(CONFIG, JSON.stringify({ version: "3.3.0", platform: "stream-deck", featureFlags: {} }));

    expect(assertReleaseBuild(CONFIG, { fs, log })).toBe(EXIT_CLEAN);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("fails a development build, naming the key and the file", () => {
    const log = fakeLog();
    const fs = fakeFs(
      CONFIG,
      JSON.stringify({
        version: "3.3.0",
        [DEV_VOICE_PACKS_ROOT_KEY]: "C:/repo/packages/audio-assets/dist/voice-packs",
      }),
    );

    expect(assertReleaseBuild(CONFIG, { fs, log })).toBe(EXIT_PROBLEM);
    expect(output(log)).toContain(DEV_VOICE_PACKS_ROOT_KEY);
    expect(output(log)).toContain(CONFIG);
    // The remedy, because the person who hits this is packing a release from a
    // worktree they had been developing a voice in.
    expect(output(log)).toContain("pnpm dev:voices off");
    // Both sources of development mode (#1214), and what `off` actually does
    // under a machine-wide opt-in: it writes `false`, it does not delete.
    expect(output(log)).toContain("IRACEDECK_DEV_VOICES");
    expect(output(log)).toContain("voicePacksRoot: false");
    expect(output(log)).not.toContain("removes dev.local.json");
  });

  it("fails a development build whose value is empty, null or false", () => {
    // PRESENCE is the property, not truthiness: the key is emitted through a
    // conditional spread, so its presence at all means the marker was read.
    for (const value of ["", null, false, 0]) {
      const log = fakeLog();
      const fs = fakeFs(CONFIG, JSON.stringify({ version: "3.3.0", [DEV_VOICE_PACKS_ROOT_KEY]: value }));

      expect(assertReleaseBuild(CONFIG, { fs, log })).toBe(EXIT_PROBLEM);
    }
  });

  it("fails when the config is missing — the plugin is not built", () => {
    const log = fakeLog();
    const fs = fakeFs("/somewhere/else.json", "{}");

    expect(assertReleaseBuild(CONFIG, { fs, log })).toBe(EXIT_PROBLEM);
    expect(output(log)).toContain(CONFIG);
    expect(output(log)).toMatch(/not built/i);
  });

  it("fails when the config cannot be parsed", () => {
    // A config we cannot read is one we cannot clear, and packing on an
    // unanswerable question is the failure this guard exists to prevent.
    const log = fakeLog();
    const fs = fakeFs(CONFIG, "{ not json");

    expect(assertReleaseBuild(CONFIG, { fs, log })).toBe(EXIT_PROBLEM);
    expect(output(log)).toContain(CONFIG);
  });

  it("fails when the config does not hold an object", () => {
    for (const contents of ["[]", "null", '"a string"', "7"]) {
      const log = fakeLog();

      expect(assertReleaseBuild(CONFIG, { fs: fakeFs(CONFIG, contents), log })).toBe(EXIT_PROBLEM);
    }
  });

  it("fails when the config cannot be opened at all", () => {
    const log = fakeLog();
    const fs = {
      existsSync: () => true,
      readFileSync: () => {
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      },
    };

    expect(assertReleaseBuild(CONFIG, { fs, log })).toBe(EXIT_PROBLEM);
    expect(output(log)).toContain("EBUSY");
  });

  it("reports usage with no path", () => {
    const log = fakeLog();

    expect(assertReleaseBuild(undefined, { fs: fakeFs(CONFIG, "{}"), log })).toBe(EXIT_USAGE);
    expect(output(log)).toContain(USAGE);
  });

  it("uses three distinct exit codes", () => {
    // The pack script chains on `&&`, so only 0 may continue.
    expect(new Set([EXIT_CLEAN, EXIT_PROBLEM, EXIT_USAGE]).size).toBe(3);
    expect(EXIT_CLEAN).toBe(0);
  });
});

describe("assertReleaseBuild — the manifest carries no Debug key (#1338)", () => {
  it("finds the manifest beside bin/, and passes one without the key", () => {
    const log = fakeLog();
    const fs = filesFs({ [CONFIG]: RELEASE_CONFIG, [MANIFEST]: MANIFEST_OFF });

    expect(assertReleaseBuild(CONFIG, { fs, log })).toBe(EXIT_CLEAN);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("fails a manifest carrying the switch's Debug value, naming the file and the fix", () => {
    const log = fakeLog();
    const fs = filesFs({ [CONFIG]: RELEASE_CONFIG, [MANIFEST]: manifestWith(DEBUG_VALUE) });

    expect(assertReleaseBuild(CONFIG, { fs, log })).toBe(EXIT_PROBLEM);
    expect(output(log)).toContain(MANIFEST);
    expect(output(log)).toContain(DEBUG_VALUE);
    expect(output(log)).toContain("pnpm debug:plugin off");
  });

  it("fails any Debug value — presence is the property — and names a foreign one", () => {
    for (const value of ["enabled", "", null, false]) {
      const log = fakeLog();
      const fs = filesFs({ [CONFIG]: RELEASE_CONFIG, [MANIFEST]: manifestWith(value) });

      expect(assertReleaseBuild(CONFIG, { fs, log })).toBe(EXIT_PROBLEM);
      expect(output(log)).toContain(JSON.stringify(value));
    }
  });

  it("checks the development config first, so both problems are not hidden behind one", () => {
    const log = fakeLog();
    const fs = filesFs({
      [CONFIG]: JSON.stringify({ [DEV_VOICE_PACKS_ROOT_KEY]: "x" }),
      [MANIFEST]: manifestWith(DEBUG_VALUE),
    });

    expect(assertReleaseBuild(CONFIG, { fs, log })).toBe(EXIT_PROBLEM);
    expect(output(log)).toContain(DEV_VOICE_PACKS_ROOT_KEY);
  });

  it("fails a manifest it cannot read or parse", () => {
    for (const contents of ["{ not json", Object.assign(new Error("EBUSY"), { code: "EBUSY" })]) {
      const log = fakeLog();
      const fs = filesFs({ [CONFIG]: RELEASE_CONFIG, [MANIFEST]: contents });

      expect(assertReleaseBuild(CONFIG, { fs, log })).toBe(EXIT_PROBLEM);
      expect(output(log)).toContain(MANIFEST);
    }
  });

  it("leaves a folder with no manifest to the packer", () => {
    const log = fakeLog();

    expect(assertReleaseBuild(CONFIG, { fs: filesFs({ [CONFIG]: RELEASE_CONFIG }), log })).toBe(EXIT_CLEAN);
  });
});
