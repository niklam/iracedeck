/**
 * Covers the branches `scripts/CLAUDE.md` calls load-bearing: junction/symlink
 * removal vs a real directory, and the link success path. These run against a
 * real temp filesystem because the whole point of the branch is how the OS
 * treats a link differently from a directory — a mocked `fs` would assert the
 * code's own assumptions back at itself.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DECK_HOSTS } from "./deck-hosts.mjs";
import { linkPlugin, unlinkPlugin } from "./plugin-link.mjs";

const HOST = DECK_HOSTS.ulanzi;
const PLATFORM = process.platform;

let workspace;
let root;
let dest;
let link;

function fakeLog() {
  return { log: vi.fn(), error: vi.fn() };
}

function output(log) {
  return [...log.log.mock.calls, ...log.error.mock.calls].map((args) => args.join(" ")).join("\n");
}

/** A built plugin source tree — `bin/plugin.js` is what the guard looks for. */
function makeBuiltPlugin() {
  const source = join(root, "packages", HOST.package, HOST.pluginFolder);
  mkdirSync(join(source, "bin"), { recursive: true });
  writeFileSync(join(source, "bin", "plugin.js"), "// built");

  return source;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "iracedeck-link-"));
  root = join(workspace, "repo");
  dest = join(workspace, "plugins");
  mkdirSync(root, { recursive: true });
  mkdirSync(dest, { recursive: true });
  link = join(dest, HOST.pluginFolder);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function options(log) {
  return { root, env: { [HOST.pluginsDirEnv]: dest }, platform: PLATFORM, log };
}

describe("linkPlugin", () => {
  it("creates a link pointing at the built plugin", () => {
    const source = makeBuiltPlugin();
    const log = fakeLog();

    expect(linkPlugin(HOST, options(log))).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // The printed source path is the only signal of which worktree owns the host.
    expect(output(log)).toContain(source);
  });

  it("refuses to overwrite anything already at the link path", () => {
    makeBuiltPlugin();
    expect(linkPlugin(HOST, options(fakeLog()))).toBe(0);

    const log = fakeLog();
    expect(linkPlugin(HOST, options(log))).toBe(1);
    expect(output(log)).toContain(HOST.unlinkScript);
  });

  it("reports a missing plugins directory without blaming an unset env var", () => {
    makeBuiltPlugin();
    const log = fakeLog();
    const missing = join(workspace, "gone");

    expect(linkPlugin(HOST, { root, env: { [HOST.pluginsDirEnv]: missing }, platform: PLATFORM, log })).toBe(1);
    expect(output(log)).toContain(missing);
    // Came from the env var, so naming it is correct here.
    expect(output(log)).toContain(HOST.pluginsDirEnv);
  });
});

describe("unlinkPlugin", () => {
  it("removes a link without touching its target", () => {
    const source = makeBuiltPlugin();
    linkPlugin(HOST, options(fakeLog()));

    const log = fakeLog();
    expect(unlinkPlugin(HOST, options(log))).toBe(0);
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
    // The whole point of the symlink branch: the source survives.
    expect(existsSync(join(source, "bin", "plugin.js"))).toBe(true);
  });

  it("moves a real directory aside instead of deleting it, preserving logs", () => {
    mkdirSync(join(link, "log"), { recursive: true });
    writeFileSync(join(link, "log", "2026.8.28.log"), "evidence");
    writeFileSync(join(link, "manifest.json"), "{}");

    const log = fakeLog();
    expect(unlinkPlugin(HOST, options(log))).toBe(0);

    // Nothing is at the link path any more...
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();

    // ...but the directory still exists under a `.replaced-*` name, with the
    // log file intact. Nothing irreversible happened.
    const aside = readdirSync(dest).find((name) => name.startsWith(`${HOST.pluginFolder}.replaced-`));
    expect(aside).toBeDefined();
    expect(existsSync(join(dest, aside, "log", "2026.8.28.log"))).toBe(true);

    // The aside name must NOT end in the host's scan suffix, or the host would
    // load the stale copy as a second plugin.
    expect(aside.endsWith(".ulanziPlugin")).toBe(false);
    expect(output(log)).toContain("1 plugin log file(s) preserved");
  });

  it("counts only real log files, not other entries in log/", () => {
    mkdirSync(join(link, "log", "archive"), { recursive: true });
    writeFileSync(join(link, "log", "2026.8.28.log"), "one");
    writeFileSync(join(link, "log", "notes.txt"), "not a log");

    const log = fakeLog();
    expect(unlinkPlugin(HOST, options(log))).toBe(0);
    expect(output(log)).toContain("1 plugin log file(s) preserved");
  });

  it("is a no-op when nothing is linked", () => {
    const log = fakeLog();

    expect(unlinkPlugin(HOST, options(log))).toBe(0);
    expect(output(log)).toContain("nothing to unlink");
  });
});
