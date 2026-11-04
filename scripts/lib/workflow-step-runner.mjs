/**
 * Runs a GitHub Actions workflow's shell steps for real, in a test.
 *
 * A workflow step's `run` is code no unit test reaches, and a step that refuses
 * a deploy is exactly the kind whose breakage reads as a green run. The tests
 * that guard those steps (#1392's `voice-pack-publish-workflow.test.mjs`,
 * #1613's `voice-pack-tag-catalog-workflow.test.mjs`) read the step out of the
 * YAML and run it with bash against throwaway directories and git repositories,
 * isolated from the git configuration of the machine running the suite. This
 * module is what they share; it imports nothing from vitest, so each test owns
 * its lifecycle.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";

/** The repository root. */
export const REPO = path.resolve(import.meta.dirname, "..", "..");

/** The parsed workflow at `rel`, a path relative to the repository root. */
export const readWorkflow = (rel) => parse(readFileSync(path.join(REPO, rel), "utf8"));

/** The step called `name` in `job`, or a failure naming what is missing. */
export function stepNamed(doc, job, name) {
  const steps = doc?.jobs?.[job]?.steps ?? [];
  const index = steps.findIndex((s) => s?.name === name);
  if (index === -1) throw new Error(`job "${job}" has no step named "${name}"`);
  return { step: steps[index], index };
}

/**
 * A bash that runs the steps as the runner would. On Windows that is Git's own
 * bash, found from git's exec path: a bare `bash` there can be WSL's, which
 * sees a different filesystem and a different git. Undefined when none is
 * found, which each test file turns red rather than letting its behavioural
 * tests skip in silence.
 */
export function findBash() {
  if (process.platform !== "win32") return "bash";
  const git = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  if (git.status !== 0) return undefined;
  const gitRoot = path.resolve(git.stdout.trim(), "..", "..", "..");
  return [path.join(gitRoot, "bin", "bash.exe"), path.join(gitRoot, "usr", "bin", "bash.exe")].find(existsSync);
}

/** The bash `runStep` uses, resolved once. */
export const BASH = findBash();

/** Writes `text` to `rel` under `root`, creating its directories. */
export function writeFile(root, rel, text) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
}

/**
 * A temporary directory (`work`) with a git environment (`env`) that reads no
 * user, system or hook configuration of the machine running the suite, plus
 * `git` and `runStep` bound to both. Call `remove()` when done.
 */
export function createStepSandbox(prefix) {
  const work = mkdtempSync(path.join(tmpdir(), prefix));
  const emptyConfig = path.join(work, "empty.gitconfig");
  writeFileSync(emptyConfig, "");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };

  /** Runs git in `cwd` and returns its trimmed stdout; throws on a non-zero exit. */
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  /** Writes `script` to a file and runs it with bash in `cwd`; returns its exit status and combined output. */
  function runStep(script, cwd, extraEnv = {}) {
    if (BASH === undefined) throw new Error("no bash found to run a workflow step with");
    const file = path.join(work, `step-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(file, script);
    const result = spawnSync(BASH, [file.replaceAll("\\", "/")], {
      cwd,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  /**
   * `runStep` without blocking the event loop, for a step that talks to a server
   * the test itself runs (`spawnSync` would hold the loop the server answers
   * on, so the step could never be answered). Resolves its exit status and
   * combined output; a step still running after `timeoutMs` is killed, and its
   * status is then null.
   */
  function runStepAsync(script, cwd, extraEnv = {}, { timeoutMs = 60_000 } = {}) {
    if (BASH === undefined) return Promise.reject(new Error("no bash found to run a workflow step with"));
    const file = path.join(work, `step-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(file, script);
    return new Promise((resolve, reject) => {
      const child = spawn(BASH, [file.replaceAll("\\", "/")], {
        cwd,
        env: { ...env, ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
      });
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, output }));
    });
  }

  return { work, env, git, runStep, runStepAsync, remove: () => rmSync(work, { recursive: true, force: true }) };
}
