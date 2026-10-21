import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The replay command gate is the one module that sends a replay command
 * (#1430): a send outside it skips the gate's rules for a jump or a search
 * under way. This scans every production source of the engine and of
 * `iracing-actions` for each way to reach the replay commands:
 * `getCommands().replay`, a destructuring of `replay` out of `getCommands()`,
 * and `.replay` read off a binding of `getCommands()`. Inside the engine the
 * commands are the injected env's `replay()` (#1467), which only the gate calls.
 */

const ENGINE_ROOT = import.meta.dirname;
const ACTIONS_ROOT = join(import.meta.dirname, "..", "..", "iracing-actions", "src");
const GATE_FILE = join(ENGINE_ROOT, "replay-command-gate.ts");

/** `getCommands()` followed, after any whitespace, by `.replay` (so a `const replay = getCommands().replay` too). */
const REPLAY_REACH = /getCommands\(\)\s*\??\.\s*replay\b/;

/** `const { replay } = getCommands()`, with or without other names beside it. */
const REPLAY_DESTRUCTURED = /\{[^}]*\breplay\b[^}]*\}\s*=\s*getCommands\(\)/;

/** `const commands = getCommands();`, whose name is then looked for followed by `.replay`. */
const COMMANDS_BOUND = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=\s*getCommands\(\)\s*;/g;

/** A call of the engine env's `replay()`: `engineEnv().replay()`, or `.replay()` off a binding of the env. */
const INJECTED_REPLAY = /\.\s*replay\s*\(\s*\)/;

/** True when the source reaches the replay commands directly. */
function sendsReplayOutsideGate(source: string): boolean {
  if (REPLAY_REACH.test(source) || REPLAY_DESTRUCTURED.test(source)) return true;

  for (const binding of source.matchAll(COMMANDS_BOUND)) {
    if (new RegExp(`\\b${binding[1]}\\s*\\??\\.\\s*replay\\b`).test(source)) return true;
  }

  return false;
}

/** True when the source calls the replay surface the engine was given. */
function readsInjectedReplay(source: string): boolean {
  return INJECTED_REPLAY.test(source);
}

/** Every `.ts` file under `dir` (absolute paths) that is not a test, test-support or the gate itself. */
function productionSources(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...productionSources(full));
      continue;
    }

    if (!entry.name.endsWith(".ts")) continue;

    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test-support.ts")) continue;

    if (full === GATE_FILE) continue;

    found.push(full);
  }

  return found;
}

/** The files among `files` whose source matches `check`, relative to the packages directory. */
function offendersOf(files: string[], check: (source: string) => boolean): string[] {
  return files
    .filter((file) => check(readFileSync(file, "utf8")))
    .map((file) =>
      relative(join(ENGINE_ROOT, "..", ".."), file)
        .split(sep)
        .join("/"),
    );
}

describe("the replay command gate is the single sender (#1430)", () => {
  it("flags a planted replay send (positive control)", () => {
    expect(sendsReplayOutsideGate("const replay = getCommands().replay;\nreplay.play();")).toBe(true);
    expect(sendsReplayOutsideGate("getCommands()\n  .replay.pause();")).toBe(true);
    expect(sendsReplayOutsideGate("const { replay } = getCommands();\nreplay.pause();")).toBe(true);
    expect(sendsReplayOutsideGate("const { camera, replay: r } = getCommands();\nr.nextLap();")).toBe(true);
    expect(sendsReplayOutsideGate("const c = getCommands();\nc.replay.nextLap();")).toBe(true);
    expect(sendsReplayOutsideGate("const c = getCommands();\nc?.replay.nextLap();")).toBe(true);
  });

  it("does not flag a send through the gate", () => {
    expect(sendsReplayOutsideGate(`pressReplayCommand({ kind: "pause" }, { by: "x" })`)).toBe(false);
    expect(sendsReplayOutsideGate("getCommands().pit.fuel(10);")).toBe(false);
    expect(sendsReplayOutsideGate("const c = getCommands();\nc.camera.switchNum(1, 0, 0);")).toBe(false);
    expect(sendsReplayOutsideGate("const { camera } = getCommands();\ncamera.switchNum(1, 0, 0);")).toBe(false);
  });

  it("flags an engine module reaching the injected replay surface (positive control)", () => {
    expect(readsInjectedReplay("engineEnv().replay().pause();")).toBe(true);
    expect(readsInjectedReplay("const env = engineEnv();\nenv.replay().nextLap();")).toBe(true);
    expect(readsInjectedReplay("engineEnv().camera().switchNum(1, 0, 0);")).toBe(false);
  });

  it("finds the production sources to scan", () => {
    expect(productionSources(ACTIONS_ROOT).length).toBeGreaterThan(100);
    expect(productionSources(ENGINE_ROOT).length).toBeGreaterThan(15);
  });

  it("no production source reaches the replay commands outside the gate", () => {
    const files = [...productionSources(ENGINE_ROOT), ...productionSources(ACTIONS_ROOT)];

    expect(offendersOf(files, sendsReplayOutsideGate)).toEqual([]);
  });

  it("no engine module but the gate calls the injected replay surface", () => {
    expect(offendersOf(productionSources(ENGINE_ROOT), readsInjectedReplay)).toEqual([]);
  });
});
