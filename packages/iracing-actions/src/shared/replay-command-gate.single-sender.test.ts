import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The replay command gate is the one module that sends a replay command
 * (#1430): a send outside it skips the gate's rules for a jump or a search
 * under way. This scans every production source for each way to reach the
 * replay commands: `getCommands().replay`, a destructuring of `replay` out of
 * `getCommands()`, and `.replay` read off a binding of `getCommands()`.
 */

const SRC_ROOT = join(import.meta.dirname, "..");
const GATE_FILE = "shared/replay-command-gate.ts";

/** `getCommands()` followed, after any whitespace, by `.replay` (so a `const replay = getCommands().replay` too). */
const REPLAY_REACH = /getCommands\(\)\s*\??\.\s*replay\b/;

/** `const { replay } = getCommands()`, with or without other names beside it. */
const REPLAY_DESTRUCTURED = /\{[^}]*\breplay\b[^}]*\}\s*=\s*getCommands\(\)/;

/** `const commands = getCommands();`, whose name is then looked for followed by `.replay`. */
const COMMANDS_BOUND = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=\s*getCommands\(\)\s*;/g;

/** True when the source reaches the replay commands directly. */
function sendsReplayOutsideGate(source: string): boolean {
  if (REPLAY_REACH.test(source) || REPLAY_DESTRUCTURED.test(source)) return true;

  for (const binding of source.matchAll(COMMANDS_BOUND)) {
    if (new RegExp(`\\b${binding[1]}\\s*\\??\\.\\s*replay\\b`).test(source)) return true;
  }

  return false;
}

/** Every `.ts` file under `dir` (relative to the source root, `/`-separated) that is not a test, test-support or the gate itself. */
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

    const rel = relative(SRC_ROOT, full).split(sep).join("/");

    if (rel === GATE_FILE) continue;

    found.push(rel);
  }

  return found;
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

  it("finds the production sources to scan", () => {
    expect(productionSources(SRC_ROOT).length).toBeGreaterThan(100);
  });

  it("no production source reaches the replay commands outside the gate", () => {
    const offenders = productionSources(SRC_ROOT).filter((rel) =>
      sendsReplayOutsideGate(readFileSync(join(SRC_ROOT, rel), "utf8")),
    );

    expect(offenders).toEqual([]);
  });
});
