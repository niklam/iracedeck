/**
 * `pnpm dev:voices on|off` (#1143) — the one switch that turns the development
 * voice root on and off for this worktree.
 *
 * Everything impure is injected: a temp `root` for the marker file, an `exec`
 * double recording `[cmd, args, options]`, and a `links` double standing in for
 * the deck hosts' junctions. The two things that must never regress are the
 * relink decision (a host linked to ANOTHER worktree is reported and left
 * alone — relinking it would silently switch someone's test environment) and
 * that a failed build never reaches the relink step.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DEV_VOICE_PACKS_ROOT, DEV_LOCAL_FILE } from "./dev-local.mjs";
import { HOST_RELINKS, runDevVoices } from "./dev-voices.mjs";
import { linkLocations } from "./plugin-links.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const BUILD_ARGS = [
  "exec",
  "turbo",
  "run",
  "build",
  "--filter=@iracedeck/iracing-plugin-stream-deck",
  "--filter=@iracedeck/iracing-plugin-mirabox",
  "--filter=@iracedeck/iracing-plugin-ulanzi",
];

let root;
let marker;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iracedeck-dev-voices-"));
  marker = join(root, DEV_LOCAL_FILE);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakeLog() {
  return { log: vi.fn(), error: vi.fn() };
}

function output(log) {
  return [...log.log.mock.calls, ...log.error.mock.calls].map((args) => args.join(" ")).join("\n");
}

/** An `exec` double: records every call, reports success unless told otherwise. */
function fakeExec(results = {}) {
  const calls = [];
  const exec = vi.fn((cmd, args, options) => {
    calls.push({ cmd, args, options });
    const key = args.join(" ");
    return { status: results[key] ?? 0 };
  });
  exec.calls = calls;

  return exec;
}

function buildCalls(exec) {
  return exec.calls.filter((call) => call.args.includes("turbo"));
}

function relinkCalls(exec) {
  return exec.calls.filter((call) => call.args.some((arg) => String(arg).startsWith("relink:")));
}

/** The Stream Deck host linked at THIS root, Mirabox elsewhere, Ulanzi not linked. */
function mixedLinks() {
  return [
    { host: "Stream Deck", link: "C:\\hosts\\sd", target: join(root, HOST_RELINKS[0].pluginDir) },
    { host: "Mirabox", link: "C:\\hosts\\mb", target: "C:\\elsewhere\\ir-999\\packages\\x\\plugin" },
    { host: "Ulanzi", link: "C:\\hosts\\ul", target: undefined },
  ];
}

function options(overrides = {}) {
  return { root, env: {}, log: fakeLog(), exec: fakeExec(), links: () => [], ...overrides };
}

describe("runDevVoices('on')", () => {
  it("writes the marker with exactly the documented contents", () => {
    const log = fakeLog();

    expect(runDevVoices("on", options({ log }))).toBe(0);
    const written = readFileSync(marker, "utf-8");
    expect(JSON.parse(written)).toEqual({ voicePacksRoot: DEFAULT_DEV_VOICE_PACKS_ROOT });
    expect(written).toBe(`${JSON.stringify({ voicePacksRoot: DEFAULT_DEV_VOICE_PACKS_ROOT }, null, 2)}\n`);
  });

  it("writes exactly what dev.local.json.example documents", () => {
    expect(runDevVoices("on", options())).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe(readFileSync(join(repoRoot, `${DEV_LOCAL_FILE}.example`), "utf-8"));
  });

  it("refuses a marker carrying another key, writes nothing, and names the key", () => {
    const before = `${JSON.stringify({ voicePacksRoot: "x", somethingElse: 1 }, null, 2)}\n`;
    writeFileSync(marker, before);
    const log = fakeLog();
    const exec = fakeExec();

    expect(runDevVoices("on", options({ log, exec }))).toBe(1);
    expect(readFileSync(marker, "utf-8")).toBe(before);
    expect(output(log)).toContain("somethingElse");
    expect(exec.calls).toHaveLength(0);
  });

  it("refuses a marker that is not valid JSON", () => {
    writeFileSync(marker, "{ not json");
    const log = fakeLog();
    const exec = fakeExec();

    expect(runDevVoices("on", options({ log, exec }))).toBe(1);
    expect(readFileSync(marker, "utf-8")).toBe("{ not json");
    expect(output(log)).toContain(DEV_LOCAL_FILE);
    expect(exec.calls).toHaveLength(0);
  });

  it.each([
    ["an array", "[]"],
    ["null", "null"],
    ["a non-string root", '{ "voicePacksRoot": 7 }'],
    // A blank root is the one the hand-rolled validation used to accept: it is
    // a string, so it passed, and the build then resolved it to the repo root
    // and scanned the whole checkout as a voice packs folder. `readDevLocal`
    // has always refused it — sharing the reader is what makes the two agree.
    ["a blank root", '{ "voicePacksRoot": "" }'],
    ["a whitespace-only root", '{ "voicePacksRoot": "   " }'],
    ["no root at all", "{}"],
  ])("refuses a marker holding %s", (_label, contents) => {
    writeFileSync(marker, contents);
    const log = fakeLog();
    const exec = fakeExec();

    expect(runDevVoices("on", options({ log, exec }))).toBe(1);
    expect(readFileSync(marker, "utf-8")).toBe(contents);
    expect(exec.calls).toHaveLength(0);
  });

  it("accepts an identical marker without complaining about a rewrite", () => {
    const same = `${JSON.stringify({ voicePacksRoot: DEFAULT_DEV_VOICE_PACKS_ROOT }, null, 2)}\n`;
    writeFileSync(marker, same);
    const log = fakeLog();
    const exec = fakeExec();

    expect(runDevVoices("on", options({ log, exec }))).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe(same);
    expect(buildCalls(exec)).toHaveLength(1);
    expect(output(log)).not.toMatch(/refus|Error/i);
  });

  it("keeps a hand-picked root rather than overwriting it with the default", () => {
    const custom = `${JSON.stringify({ voicePacksRoot: "local/my-packs" }, null, 2)}\n`;
    writeFileSync(marker, custom);
    const log = fakeLog();

    expect(runDevVoices("on", options({ log }))).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe(custom);
    // The RESOLVED directory, not the text in the file: the message names the
    // folder that will be scanned, which is what tells two clones apart.
    expect(output(log)).toContain(join(root, "local", "my-packs"));
  });

  it("names the staging command when the dev root holds no pack yet", () => {
    const log = fakeLog();

    expect(runDevVoices("on", options({ log }))).toBe(0);
    expect(output(log)).toContain("No staged pack under");
    expect(output(log)).toContain(join(root, ...DEFAULT_DEV_VOICE_PACKS_ROOT.split("/")));
    expect(output(log)).toContain("pack:voice default --no-catalog");
  });

  it("says nothing about staging when a pack is already staged", () => {
    mkdirSync(join(root, ...DEFAULT_DEV_VOICE_PACKS_ROOT.split("/"), "default"), { recursive: true });
    const log = fakeLog();

    expect(runDevVoices("on", options({ log }))).toBe(0);
    expect(output(log)).not.toContain("No staged pack under");
  });
});

describe("runDevVoices('off')", () => {
  it("removes the marker", () => {
    writeFileSync(marker, `${JSON.stringify({ voicePacksRoot: DEFAULT_DEV_VOICE_PACKS_ROOT }, null, 2)}\n`);

    expect(runDevVoices("off", options())).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("is a no-op success when there is no marker, and still rebuilds", () => {
    const exec = fakeExec();

    expect(runDevVoices("off", options({ exec }))).toBe(0);
    expect(existsSync(marker)).toBe(false);
    // The key lives in the BUILT config.json, so clearing it needs the rebuild
    // even when the marker was already gone.
    expect(buildCalls(exec)).toHaveLength(1);
  });

  it("never prints the staging hint", () => {
    const log = fakeLog();

    expect(runDevVoices("off", options({ log }))).toBe(0);
    expect(output(log)).not.toContain("No staged pack under");
  });
});

describe("the build step", () => {
  it.each(["on", "off"])("runs exactly one plugin build for %s", (mode) => {
    const exec = fakeExec();

    expect(runDevVoices(mode, options({ exec }))).toBe(0);
    const builds = buildCalls(exec);
    expect(builds).toHaveLength(1);
    expect(builds[0].cmd).toBe("pnpm");
    expect(builds[0].args).toEqual(BUILD_ARGS);
    expect(builds[0].options.cwd).toBe(root);
  });

  it("stops before relinking and fails when the build fails", () => {
    const exec = fakeExec({ [BUILD_ARGS.join(" ")]: 1 });
    const log = fakeLog();

    expect(runDevVoices("on", options({ exec, log, links: mixedLinks }))).toBe(1);
    expect(relinkCalls(exec)).toHaveLength(0);
    expect(output(log)).toMatch(/build failed/i);
  });
});

describe("relinking", () => {
  it("relinks only the host pointing at this worktree", () => {
    const exec = fakeExec();
    const log = fakeLog();

    expect(runDevVoices("on", options({ exec, log, links: mixedLinks }))).toBe(0);
    expect(relinkCalls(exec).map((call) => call.args)).toEqual([["relink:stream-deck"]]);

    const text = output(log);
    expect(text).toMatch(/Mirabox: linked elsewhere/);
    expect(text).toContain("C:\\elsewhere\\ir-999\\packages\\x\\plugin");
    expect(text).toMatch(/Ulanzi: not linked/);
  });

  it("compares link targets case-insensitively on Windows", () => {
    const exec = fakeExec();
    const links = () => [
      { host: "Stream Deck", link: "L", target: join(root, HOST_RELINKS[0].pluginDir).toUpperCase() },
    ];

    expect(runDevVoices("on", options({ exec, links, platform: "win32" }))).toBe(0);
    expect(relinkCalls(exec).map((call) => call.args)).toEqual([["relink:stream-deck"]]);
  });

  it("prints the restart hint after a Mirabox relink", () => {
    const exec = fakeExec();
    const log = fakeLog();
    const links = () => [{ host: "Mirabox", link: "L", target: join(root, HOST_RELINKS[1].pluginDir) }];

    expect(runDevVoices("on", options({ exec, log, links }))).toBe(0);
    expect(relinkCalls(exec).map((call) => call.args)).toEqual([["relink:mirabox"]]);
    expect(output(log)).toContain("pnpm stop:mirabox && pnpm start:mirabox");
  });

  it("prints the restart hint after a Ulanzi relink", () => {
    const exec = fakeExec();
    const log = fakeLog();
    const links = () => [{ host: "Ulanzi", link: "L", target: join(root, HOST_RELINKS[2].pluginDir) }];

    expect(runDevVoices("on", options({ exec, log, links }))).toBe(0);
    expect(output(log)).toContain("pnpm stop:ulanzi && pnpm start:ulanzi");
  });

  it("does not print a restart hint for Stream Deck (its relink reloads the plugin)", () => {
    const log = fakeLog();
    const links = () => [{ host: "Stream Deck", link: "L", target: join(root, HOST_RELINKS[0].pluginDir) }];

    expect(runDevVoices("on", options({ log, links }))).toBe(0);
    expect(output(log)).not.toContain("stop:stream-deck");
  });

  it("leaves a real directory alone rather than reading it as another worktree", () => {
    const exec = fakeExec();
    const log = fakeLog();
    const links = () => [{ host: "Ulanzi", link: "C:\\hosts\\ul", target: "(a real directory, not a link)" }];

    expect(runDevVoices("on", options({ exec, log, links }))).toBe(0);
    expect(relinkCalls(exec)).toHaveLength(0);
    expect(output(log)).toContain("real directory");
    expect(output(log)).toContain("C:\\hosts\\ul");
  });

  it("fails when a relink fails", () => {
    const exec = fakeExec({ "relink:stream-deck": 1 });
    const log = fakeLog();
    const links = () => [{ host: "Stream Deck", link: "L", target: join(root, HOST_RELINKS[0].pluginDir) }];

    expect(runDevVoices("on", options({ exec, log, links }))).toBe(1);
    expect(output(log)).toMatch(/relink:stream-deck/);
  });

  it("has a relink descriptor for every host the link locations report", () => {
    const hosts = linkLocations({ APPDATA: "C:\\Users\\dev\\AppData\\Roaming" }).map((location) => location.host);

    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.sort()).toEqual(HOST_RELINKS.map((entry) => entry.host).sort());
  });
});

describe("argument handling", () => {
  it.each([undefined, "", "ON", "enable"])("refuses %o with usage and exit code 2", (mode) => {
    const log = fakeLog();
    const exec = fakeExec();

    expect(runDevVoices(mode, options({ log, exec }))).toBe(2);
    expect(output(log)).toContain("pnpm dev:voices");
    expect(exec.calls).toHaveLength(0);
    expect(existsSync(marker)).toBe(false);
  });
});
