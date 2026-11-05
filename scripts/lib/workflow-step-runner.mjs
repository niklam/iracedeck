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

/** How long a step's output may trail its bash's exit before `runStepAsync` settles without it. */
const EXIT_GRACE_MS = 500;

/**
 * Kills `child` and every process it started. On Windows a signal reaches the
 * one process only, so `taskkill /T` walks the tree; elsewhere `child` leads
 * its own process group (spawned `detached`), which one signal reaches whole.
 */
export function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
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
   * combined output. A step still running after `timeoutMs` is killed with
   * every process it started, and resolves with status null and the output so
   * far.
   *
   * Killing bash alone is not enough: a node or git it started outlives it,
   * holding the output pipes open, so 'close' never fires and the promise
   * would hang past any timeout (on Windows, where a signal reaches only the
   * one process, that is the norm). So the whole tree is killed, and the
   * promise also settles a short grace after bash exits, whether or not the
   * pipes have closed by then.
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
        // Its own process group off Windows, so one signal reaches every process it starts.
        detached: process.platform !== "win32",
      });
      let output = "";
      let timedOut = false;
      let settled = false;
      let grace;
      let backstop;
      const finish = (status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        clearTimeout(backstop);
        // A descendant may still hold the pipes; stop reading them so nothing keeps the loop alive.
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ status: timedOut ? null : status, output });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        // Settles even if the kill reached nothing and bash never reports its exit.
        backstop = setTimeout(() => finish(null), EXIT_GRACE_MS * 4);
      }, timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        clearTimeout(backstop);
        reject(error);
      });
      child.on("exit", (status) => {
        grace = setTimeout(() => finish(status), EXIT_GRACE_MS);
      });
      child.on("close", (status) => finish(status));
    });
  }

  return { work, env, git, runStep, runStepAsync, remove: () => rmSync(work, { recursive: true, force: true }) };
}
