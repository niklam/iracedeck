/**
 * `pnpm dev:voices on|off|auto` (#1143, #1214) — the one switch that decides the
 * development voice root for this worktree.
 *
 * Everything impure is injected: a temp `root` for the marker file, an `exec`
 * double recording `[cmd, args, options]`, a `links` double standing in for
 * the deck hosts' junctions, and an `env` carrying (or not) the machine-wide
 * opt-in. The things that must never regress are the relink decision (a host
 * linked to ANOTHER worktree is reported and left alone — relinking it would
 * silently switch someone's test environment), that a failed build never
 * reaches the relink step and always puts the marker back, that `off` writes
 * `false` rather than deleting (deleting under the machine opt-in would turn
 * development mode back ON), and that a hand-picked root is never overwritten.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DEV_VOICE_PACKS_ROOT, DEV_LOCAL_FILE, DEV_VOICES_ENV } from "./dev-local.mjs";
import { HOST_RELINKS, runDevVoices, shellCommandLine } from "./dev-voices.mjs";
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

const DEFAULT_MARKER = `${JSON.stringify({ voicePacksRoot: DEFAULT_DEV_VOICE_PACKS_ROOT }, null, 2)}\n`;
const OFF_MARKER = `${JSON.stringify({ voicePacksRoot: false }, null, 2)}\n`;
const CUSTOM_MARKER = `${JSON.stringify({ voicePacksRoot: "local/my-packs" }, null, 2)}\n`;

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

const defaultRoot = () => join(root, ...DEFAULT_DEV_VOICE_PACKS_ROOT.split("/"));

describe("runDevVoices('on')", () => {
  it("writes the marker with exactly the documented contents", () => {
    const log = fakeLog();

    expect(runDevVoices("on", options({ log }))).toBe(0);
    const written = readFileSync(marker, "utf-8");
    expect(JSON.parse(written)).toEqual({ voicePacksRoot: DEFAULT_DEV_VOICE_PACKS_ROOT });
    expect(written).toBe(DEFAULT_MARKER);
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
    // `true` is what someone reaching for "on" would type; only `false` means
    // anything, and `true` must not be read as "on at some default".
    ["a true root", '{ "voicePacksRoot": true }'],
    // A blank root is the one the hand-rolled validation used to accept: it is
    // a string, so it passed, and the build then resolved it to the repo root
    // and scanned the whole checkout as a voice packs folder. `readDevLocal`
    // has always refused it — sharing the reader is what makes the two agree.
    ["a blank root", '{ "voicePacksRoot": "" }'],
    ["a whitespace-only root", '{ "voicePacksRoot": "   " }'],
  ])("refuses a marker holding %s", (_label, contents) => {
    writeFileSync(marker, contents);
    const log = fakeLog();
    const exec = fakeExec();

    expect(runDevVoices("on", options({ log, exec }))).toBe(1);
    expect(readFileSync(marker, "utf-8")).toBe(contents);
    expect(exec.calls).toHaveLength(0);
  });

  it("accepts an identical marker without complaining about a rewrite", () => {
    writeFileSync(marker, DEFAULT_MARKER);
    const log = fakeLog();
    const exec = fakeExec();

    expect(runDevVoices("on", options({ log, exec }))).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe(DEFAULT_MARKER);
    expect(buildCalls(exec)).toHaveLength(1);
    expect(output(log)).not.toMatch(/refus|Error/i);
  });

  it("keeps a hand-picked root rather than overwriting it with the default", () => {
    writeFileSync(marker, CUSTOM_MARKER);
    const log = fakeLog();

    expect(runDevVoices("on", options({ log }))).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe(CUSTOM_MARKER);
    // The RESOLVED directory, not the text in the file: the message names the
    // folder that will be scanned, which is what tells two clones apart.
    expect(output(log)).toContain(join(root, "local", "my-packs"));
  });

  // `false` and `{}` hold no choice worth keeping — the first is the explicit
  // off `on` exists to undo, the second means the same as no file at all.
  it.each([
    ["the explicit off", OFF_MARKER],
    ["an empty object", "{}\n"],
  ])("overwrites %s with the default root", (_label, contents) => {
    writeFileSync(marker, contents);
    const exec = fakeExec();

    expect(runDevVoices("on", options({ exec }))).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe(DEFAULT_MARKER);
    expect(buildCalls(exec)).toHaveLength(1);
  });

  it("says development mode is on via the marker, naming the root", () => {
    const log = fakeLog();

    expect(runDevVoices("on", options({ log, env: { [DEV_VOICES_ENV]: "0" } }))).toBe(0);
    expect(output(log)).toContain(`Development voices: on via ${DEV_LOCAL_FILE} — ${defaultRoot()}`);
  });

  it("names the stage task when the default root holds no pack after the build", () => {
    const log = fakeLog();

    expect(runDevVoices("on", options({ log }))).toBe(0);
    expect(output(log)).toContain("No staged pack under");
    expect(output(log)).toContain(defaultRoot());
    expect(output(log)).toContain("stage:dev-voices");
  });

  it("says nothing about staging when a pack is already staged", () => {
    mkdirSync(join(defaultRoot(), "default"), { recursive: true });
    const log = fakeLog();

    expect(runDevVoices("on", options({ log }))).toBe(0);
    expect(output(log)).not.toContain("No staged pack under");
  });

  // The scanner lists DIRECTORIES, so the hint has to count the same things it
  // does. `pack:voice` leaves an `<id>-<version>.zip` beside the staged folder,
  // and a leftover zip from a run whose tree was since deleted used to suppress
  // the hint while the plugin still warned that the root was empty — the switch
  // and the plugin disagreeing about the same directory.
  it("still names the stage task when the default root holds only a stray zip", () => {
    mkdirSync(defaultRoot(), { recursive: true });
    writeFileSync(join(defaultRoot(), "default-1.2.3.zip"), "not a pack");
    const log = fakeLog();

    expect(runDevVoices("on", options({ log }))).toBe(0);
    expect(output(log)).toContain("No staged pack under");
  });

  it("says a hand-picked root is filled by hand, not by the build", () => {
    writeFileSync(marker, CUSTOM_MARKER);
    const log = fakeLog();

    expect(runDevVoices("on", options({ log }))).toBe(0);
    expect(output(log)).toContain(`No pack under ${join(root, "local", "my-packs")}`);
    expect(output(log)).toContain("stages only the default root");
    expect(output(log)).not.toContain("stage:dev-voices");
  });
});

describe("runDevVoices('off')", () => {
  it("writes voicePacksRoot: false rather than deleting — deleting would follow the machine opt-in", () => {
    writeFileSync(marker, DEFAULT_MARKER);

    expect(runDevVoices("off", options({ env: { [DEV_VOICES_ENV]: "1" } }))).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe(OFF_MARKER);
  });

  it.each([
    ["no marker", undefined],
    ["an empty object", "{}\n"],
  ])("writes the explicit off over %s, and rebuilds", (_label, contents) => {
    if (contents !== undefined) writeFileSync(marker, contents);
    const exec = fakeExec();

    expect(runDevVoices("off", options({ exec }))).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe(OFF_MARKER);
    // The key lives in the BUILT config.json, so clearing it needs the rebuild
    // even when nothing said "on" before.
    expect(buildCalls(exec)).toHaveLength(1);
  });

  it("is a no-op success over an existing explicit off, and still rebuilds", () => {
    writeFileSync(marker, OFF_MARKER);
    const exec = fakeExec();
    const log = fakeLog();

    expect(runDevVoices("off", options({ exec, log }))).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe(OFF_MARKER);
    expect(buildCalls(exec)).toHaveLength(1);
    expect(output(log)).not.toMatch(/Error/);
  });

  it("refuses to overwrite a hand-picked root, writes nothing and does not build", () => {
    writeFileSync(marker, CUSTOM_MARKER);
    const exec = fakeExec();
    const log = fakeLog();

    expect(runDevVoices("off", options({ exec, log }))).toBe(1);
    expect(readFileSync(marker, "utf-8")).toBe(CUSTOM_MARKER);
    expect(exec.calls).toHaveLength(0);
    expect(output(log)).toContain(join(root, "local", "my-packs"));
    expect(output(log)).toContain("dev:voices auto");
  });

  it("refuses an invalid marker", () => {
    writeFileSync(marker, "{ not json");
    const exec = fakeExec();

    expect(runDevVoices("off", options({ exec }))).toBe(1);
    expect(readFileSync(marker, "utf-8")).toBe("{ not json");
    expect(exec.calls).toHaveLength(0);
  });

  it("says development mode is off for this worktree even with the machine opt-in set", () => {
    const log = fakeLog();

    expect(runDevVoices("off", options({ log, env: { [DEV_VOICES_ENV]: "1" } }))).toBe(0);
    expect(output(log)).toContain(`Development voices: off for this worktree via ${DEV_LOCAL_FILE}`);
    expect(output(log)).toContain(`${DEV_VOICES_ENV}=1`);
  });

  it("never prints a staging hint", () => {
    const log = fakeLog();

    expect(runDevVoices("off", options({ log, env: { [DEV_VOICES_ENV]: "1" } }))).toBe(0);
    expect(output(log)).not.toMatch(/No (staged )?pack under/);
  });
});

describe("runDevVoices('auto')", () => {
  it.each([
    ["the default root", DEFAULT_MARKER],
    ["the explicit off", OFF_MARKER],
    ["an empty object", "{}\n"],
  ])("removes a marker holding %s", (_label, contents) => {
    writeFileSync(marker, contents);
    const exec = fakeExec();

    expect(runDevVoices("auto", options({ exec }))).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(buildCalls(exec)).toHaveLength(1);
  });

  it("removes a hand-picked root too, but names what it held so the path is not lost silently", () => {
    writeFileSync(marker, CUSTOM_MARKER);
    const log = fakeLog();

    expect(runDevVoices("auto", options({ log }))).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(output(log)).toContain(`Removed ${DEV_LOCAL_FILE}`);
    expect(output(log)).toContain(join(root, "local", "my-packs"));
  });

  it("is a no-op success when there is no marker, and still rebuilds", () => {
    const exec = fakeExec();
    const log = fakeLog();

    expect(runDevVoices("auto", options({ exec, log }))).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(buildCalls(exec)).toHaveLength(1);
    expect(output(log)).toContain(DEV_VOICES_ENV);
  });

  it("refuses an invalid marker rather than deleting a hand edit in progress", () => {
    writeFileSync(marker, "{ not json");
    const exec = fakeExec();
    const log = fakeLog();

    expect(runDevVoices("auto", options({ exec, log }))).toBe(1);
    expect(readFileSync(marker, "utf-8")).toBe("{ not json");
    expect(exec.calls).toHaveLength(0);
    expect(output(log)).toContain(DEV_LOCAL_FILE);
  });

  it("reports the machine setting it now follows: on via the variable, at this worktree's default root", () => {
    writeFileSync(marker, OFF_MARKER);
    const log = fakeLog();

    expect(runDevVoices("auto", options({ log, env: { [DEV_VOICES_ENV]: "1" } }))).toBe(0);
    expect(output(log)).toContain(`Development voices: on via ${DEV_VOICES_ENV}=1 — ${defaultRoot()}`);
    // The stage task fills the default root, so the empty-root line names it.
    expect(output(log)).toContain("No staged pack under");
  });

  it("reports the machine setting it now follows: off when the variable is unset", () => {
    writeFileSync(marker, DEFAULT_MARKER);
    const log = fakeLog();

    expect(runDevVoices("auto", options({ log }))).toBe(0);
    expect(output(log)).toContain(`Development voices: off (${DEV_VOICES_ENV} unset`);
    expect(output(log)).not.toMatch(/No (staged )?pack under/);
  });
});

describe("the machine opt-in", () => {
  it.each(["on", "off", "auto"])("refuses a garbage IRACEDECK_DEV_VOICES before %s writes anything", (mode) => {
    writeFileSync(marker, DEFAULT_MARKER);
    const exec = fakeExec();
    const log = fakeLog();

    expect(runDevVoices(mode, options({ exec, log, env: { [DEV_VOICES_ENV]: "yes" } }))).toBe(1);
    expect(readFileSync(marker, "utf-8")).toBe(DEFAULT_MARKER);
    expect(exec.calls).toHaveLength(0);
    expect(output(log)).toContain(DEV_VOICES_ENV);
    expect(output(log)).toContain('"yes"');
  });

  it("accepts 0 as off", () => {
    const exec = fakeExec();

    expect(runDevVoices("auto", options({ exec, env: { [DEV_VOICES_ENV]: "0" } }))).toBe(0);
    expect(buildCalls(exec)).toHaveLength(1);
  });
});

describe("the build step", () => {
  it.each(["on", "off", "auto"])("runs exactly one plugin build for %s", (mode) => {
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

  // The marker and the built config.json must never disagree. The build is the
  // step that carries the marker INTO every bin/config.json, and it is exactly
  // the step that fails while a deck host linked to this worktree is running
  // (EPERM on the native addon) — so a marker changed before it and left there
  // afterwards says development mode is on while all three plugin folders say
  // it is off, a state nothing in the plugin can report.
  it("restores an absent marker when the build fails during 'on'", () => {
    const exec = fakeExec({ [BUILD_ARGS.join(" ")]: 1 });
    const log = fakeLog();

    expect(runDevVoices("on", options({ exec, log }))).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(output(log)).toMatch(/restored to its previous state/);
    expect(output(log)).toMatch(/nothing was relinked/i);
  });

  it("restores an absent marker when the build fails during 'off'", () => {
    const exec = fakeExec({ [BUILD_ARGS.join(" ")]: 1 });

    expect(runDevVoices("off", options({ exec }))).toBe(1);
    expect(existsSync(marker)).toBe(false);
  });

  it("restores the exact previous bytes when the build fails during 'off'", () => {
    // CRLF, odd indentation and a trailing blank line: what a hand-written
    // marker may carry, and what a decode-and-re-encode round trip would
    // quietly normalise away.
    const before = `{\r\n    "voicePacksRoot":   "${DEFAULT_DEV_VOICE_PACKS_ROOT}"\r\n}\r\n\r\n`;
    writeFileSync(marker, before);
    const exec = fakeExec({ [BUILD_ARGS.join(" ")]: 1 });
    const log = fakeLog();

    expect(runDevVoices("off", options({ exec, log }))).toBe(1);
    expect(readFileSync(marker, "utf-8")).toBe(before);
    expect(output(log)).toMatch(/restored to its previous state/);
  });

  it.each([
    ["the default root", DEFAULT_MARKER],
    ["the explicit off", OFF_MARKER],
    ["a hand-picked root", CUSTOM_MARKER],
  ])("restores the exact previous bytes when the build fails during 'auto' over %s", (_label, before) => {
    writeFileSync(marker, before);
    const exec = fakeExec({ [BUILD_ARGS.join(" ")]: 1 });

    expect(runDevVoices("auto", options({ exec }))).toBe(1);
    expect(readFileSync(marker, "utf-8")).toBe(before);
  });

  it("restores the exact previous bytes when the build fails over a kept marker", () => {
    writeFileSync(marker, CUSTOM_MARKER);
    const exec = fakeExec({ [BUILD_ARGS.join(" ")]: 1 });

    expect(runDevVoices("on", options({ exec }))).toBe(1);
    expect(readFileSync(marker, "utf-8")).toBe(CUSTOM_MARKER);
  });

  it("names the hosts to stop in the failure message", () => {
    const exec = fakeExec({ [BUILD_ARGS.join(" ")]: 1 });
    const log = fakeLog();

    expect(runDevVoices("on", options({ exec, log }))).toBe(1);
    expect(output(log)).toContain("pnpm stop:mirabox");
    expect(output(log)).toContain("stop:ulanzi");
  });
});

describe("the pre-build hint", () => {
  it("names only the hosts linked to this worktree", () => {
    const log = fakeLog();

    expect(runDevVoices("on", options({ log, links: mixedLinks }))).toBe(0);
    const hint = [...log.log.mock.calls]
      .map((args) => args.join(" "))
      .find((line) => /must not be RUNNING/i.test(line));
    expect(hint, "the build locks the native addon — the hosts holding it must be named").toBeDefined();
    expect(hint).toContain("Stream Deck");
    // Mirabox points at another worktree and Ulanzi is not linked at all —
    // neither can be holding THIS tree's addon open.
    expect(hint).not.toContain("Mirabox");
    expect(hint).not.toContain("Ulanzi");
  });

  it("says nothing when no host points at this worktree", () => {
    const log = fakeLog();

    expect(runDevVoices("on", options({ log, links: () => mixedLinks().slice(1) }))).toBe(0);
    expect(output(log)).not.toMatch(/must not be RUNNING/i);
  });

  it("is printed before the build runs", () => {
    const order = [];
    const log = { log: vi.fn((line) => order.push(String(line))), error: vi.fn() };
    const exec = vi.fn((_cmd, args) => {
      order.push(`EXEC ${args.join(" ")}`);

      return { status: 0 };
    });

    expect(runDevVoices("on", options({ log, exec, links: mixedLinks }))).toBe(0);
    const hintAt = order.findIndex((line) => /must not be RUNNING/i.test(line));
    const buildAt = order.findIndex((line) => line.startsWith("EXEC exec turbo"));
    expect(hintAt).toBeGreaterThanOrEqual(0);
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(hintAt).toBeLessThan(buildAt);
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

describe("shellCommandLine", () => {
  it("space-joins plain arguments with no quoting", () => {
    expect(shellCommandLine("pnpm", ["exec", "turbo", "run", "build"])).toBe("pnpm exec turbo run build");
  });

  it("quotes an argument containing a space", () => {
    expect(shellCommandLine("pnpm", ["--filter=@iracedeck/iracing-plugin-stream-deck", "with space"])).toBe(
      'pnpm --filter=@iracedeck/iracing-plugin-stream-deck "with space"',
    );
  });

  it("quotes and escapes an argument containing a double quote", () => {
    expect(shellCommandLine("pnpm", ['say "hi"'])).toBe('pnpm "say \\"hi\\""');
  });
});

describe("argument handling", () => {
  it.each([undefined, "", "ON", "enable", "delete"])("refuses %o with usage and exit code 2", (mode) => {
    const log = fakeLog();
    const exec = fakeExec();

    expect(runDevVoices(mode, options({ log, exec }))).toBe(2);
    expect(output(log)).toContain("pnpm dev:voices <on|off|auto>");
    expect(exec.calls).toHaveLength(0);
    expect(existsSync(marker)).toBe(false);
  });
});
