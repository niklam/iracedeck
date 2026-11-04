/**
 * `runStepAsync` ends a step that outlives its timeout, every process the step
 * started included (#1613). Killing bash alone left a node it had started
 * holding the output pipes open on Windows, so the promise never settled and
 * the test waiting on it hung until vitest's own timeout.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { BASH, createStepSandbox } from "./workflow-step-runner.mjs";

/** Whether a process with this pid is still running. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

describe.skipIf(BASH === undefined)("runStepAsync", { timeout: 20_000 }, () => {
  const box = createStepSandbox("ird-step-runner-");
  afterAll(() => box.remove());

  it("resolves a step's exit status and output", async () => {
    const run = await box.runStepAsync('echo "out"\necho "err" >&2\nexit 3\n', box.work);
    expect(run.status).toBe(3);
    expect(run.output).toContain("out");
    expect(run.output).toContain("err");
  });

  it("ends a step that hangs in a process it started, within the timeout, with status null", async () => {
    const pidFile = path.join(box.work, "hanging.pid").replaceAll("\\", "/");
    // node, not bash, holds the pipes: it inherits them and never exits on its own.
    const script = [
      'echo "before the hang"',
      `node -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)" "${pidFile}"`,
      'echo "never reached"',
      "",
    ].join("\n");
    const started = Date.now();
    const run = await box.runStepAsync(script, box.work, {}, { timeoutMs: 2_000 });
    const elapsed = Date.now() - started;

    expect(run.status).toBeNull();
    expect(run.output).toContain("before the hang");
    expect(run.output).not.toContain("never reached");
    // The timeout plus the exit grace, with room for a loaded machine; a hang would run to vitest's 20 s.
    expect(elapsed).toBeLessThan(8_000);
    expect(existsSync(pidFile), "the hanging node never started").toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(pid), `the step's node (pid ${pid}) outlived the timeout`).toBe(false);
  });
});
