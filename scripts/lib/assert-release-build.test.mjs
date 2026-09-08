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
import { describe, expect, it, vi } from "vitest";

import {
  assertReleaseBuild,
  DEV_VOICE_PACKS_ROOT_KEY,
  EXIT_CLEAN,
  EXIT_PROBLEM,
  EXIT_USAGE,
  USAGE,
} from "./assert-release-build.mjs";

const CONFIG = "com.iracedeck.sd.core.sdPlugin/bin/config.json";

function fakeLog() {
  return { log: vi.fn(), error: vi.fn() };
}

function output(log) {
  return [...log.log.mock.calls, ...log.error.mock.calls].map((args) => args.join(" ")).join("\n");
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
