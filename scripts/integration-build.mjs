#!/usr/bin/env node
/**
 * Builds the combined test tree: `origin/master` plus the named issue branches,
 * merged in `../ir-integration` on a local branch `integration` (#1520).
 *
 *   node scripts/integration-build.mjs [--no-build] <branch…>
 *
 * One permanent worktree, a sibling of the main checkout, that a deck host is
 * linked to once by the maintainer; the PO session runs this to put every issue
 * that is ready to test into one build. In order:
 *
 * 1. Refuses a tree that is dirty (untracked files included), detached, on any
 *    branch but `integration`, or not a worktree of this repository — and every
 *    branch name it cannot resolve — before anything is fetched, reset or
 *    merged. A missing tree is created from `origin/master`, with no upstream.
 * 2. Fetches, resets `integration` hard to `origin/master`, and merges each
 *    branch with `--no-ff` in the order given. Each is merged by the full sha it
 *    resolved to at the start, so the pass the maintainer gives belongs to
 *    exactly the commit he tested, and the sha is in the merge commit's subject.
 * 3. On a conflict, collects the conflicted files, runs `git merge --abort`,
 *    checks the tree came back clean, reports which branch conflicted with what
 *    was already merged, and stops (exit 1). The earlier merges stay; nothing is
 *    left half-merged. A conflict is resolved in the issue worktrees, never here.
 * 4. Unless `--no-build`: `pnpm install` and `pnpm build` in the tree, output
 *    streamed and scanned for `TS<n>:` diagnostics (fatal even on exit 0, as
 *    `build-and-commit.md` says), then restarts the deck hosts whose plugin
 *    link points into the tree — and only those. Stream Deck through `pnpm
 *    restart:stream-deck` (the `streamdeck` CLI reloads the plugin); Mirabox and
 *    Ulanzi have no plugin restart and read their plugins at start only, so they
 *    are stopped before the install and started after the build with
 *    `scripts/host-app.mjs`. `pnpm build:with-restart` is deliberately not used:
 *    it finds Stream Deck through `wmic`, which current Windows 11 no longer
 *    ships, and then silently restarts nothing. Any host whose stop or start
 *    failed is named for the maintainer to restart himself.
 * 5. Prints every merged branch with its full head sha.
 *
 * It never pushes, and never links or relinks a host: no command it runs is a
 * `git push`, and the `integration` branch has no upstream. It is run only on
 * the maintainer's go — a reset or a build under a host he is racing on breaks
 * his session — which the Bash hook enforces with an ask.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { parseArgs } from "node:util";

import { isInside, linkTargets, mainRepoRoot, REAL_DIRECTORY } from "./claude-hooks/lib.mjs";
import { shellCommandLine, spawnSyncShim } from "./lib/spawn-shim.mjs";

export const TREE_NAME = "ir-integration";
export const BRANCH = "integration";
export const BASE = "origin/master";
export const USAGE = "usage: node scripts/integration-build.mjs [--no-build] <branch…>";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** A refusal: nothing was changed, and the message says why. */
export class IntegrationRefusal extends Error {}

/** Deck hosts restarted with `scripts/host-app.mjs`, by the label `linkTargets` reports. */
const HOST_APP_IDS = { Mirabox: "mirabox", Ulanzi: "ulanzi" };
const STREAM_DECK = "Stream Deck";

/** The integration worktree: the `ir-integration` sibling of the main checkout. */
export function integrationTreePath(mainRoot) {
  return path.join(path.dirname(path.resolve(mainRoot)), TREE_NAME);
}

/** Every line of `text` that carries a TypeScript diagnostic code (`TS2345:`). */
export function tsDiagnostics(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => /\bTS\d+:/.test(line))
    .map((line) => line.trim());
}

/**
 * Runs a command and resolves to `{ ok, code, out, err }`; never rejects.
 * `git` and `node` are spawned directly; anything else is a `.cmd` shim on
 * Windows (`pnpm`) and goes through the shell as one quoted command line
 * (`lib/spawn-shim.mjs`). With `stream`, output is echoed as it arrives and
 * captured as well, so a long build is watchable and still scanned afterwards.
 */
export function defaultExec(cmd, args, { cwd, stream = false } = {}) {
  const direct = cmd === "git" || cmd === "node";
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  if (!stream) {
    const options = { cwd, env, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
    const res = direct ? spawnSync(cmd, args, options) : spawnSyncShim(cmd, args, options);

    return Promise.resolve({
      ok: res.status === 0 && !res.error,
      code: res.status,
      out: res.stdout ?? "",
      err: (res.stderr ?? "") + (res.error ? String(res.error.message) : ""),
    });
  }

  return new Promise((resolve) => {
    const stdio = ["ignore", "pipe", "pipe"];
    let child;
    try {
      child =
        !direct && process.platform === "win32"
          ? spawn(shellCommandLine(cmd, args), { cwd, env, stdio, shell: true })
          : spawn(cmd, args, { cwd, env, stdio });
    } catch (error) {
      resolve({ ok: false, code: null, out: "", err: String(error.message) });

      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      err += chunk;
    });
    child.on("error", (error) => resolve({ ok: false, code: null, out, err: err + String(error.message) }));
    child.on("close", (code) => resolve({ ok: code === 0, code, out, err }));
  });
}

function validateBranches(branches) {
  if (!Array.isArray(branches) || branches.length === 0) {
    throw new IntegrationRefusal("Name at least one branch to merge.");
  }
  const seen = new Set();
  for (const branch of branches) {
    if (typeof branch !== "string" || branch.trim() === "") throw new IntegrationRefusal("A branch name is empty.");
    if (branch.startsWith("-")) throw new IntegrationRefusal(`A branch name cannot start with "-": ${branch}`);
    if (branch === BRANCH || branch === `refs/heads/${BRANCH}`) {
      throw new IntegrationRefusal(`Refusing to merge the ${BRANCH} branch itself.`);
    }
    if (seen.has(branch)) throw new IntegrationRefusal(`${branch} is named more than once.`);
    seen.add(branch);
  }
}

const samePath = (a, b) => isInside(a, b) && isInside(b, a);

/**
 * Merges `branches` onto a fresh `origin/master` in the integration tree, and
 * builds it unless `build` is false.
 *
 * @param {object} options
 * @param {string} options.repoRoot any checkout of the repository (the main one or a worktree)
 * @param {string[]} options.branches merged in this order
 * @param {boolean} [options.build] install, build and restart the linked hosts (default true)
 * @param {typeof defaultExec} [options.exec] injected by the tests
 * @param {typeof linkTargets} [options.links] the deck hosts' plugin links, injected by the tests
 * @param {{ log: Function, error: Function }} [options.log]
 * @returns {Promise<{ tree: string, merged: { branch: string, sha: string }[],
 *   conflict?: { branch: string, files: string[], mergedBefore: string[] },
 *   build?: Awaited<ReturnType<typeof runBuild>> }>}
 * @throws {IntegrationRefusal} before anything is fetched, reset or merged
 */
export async function buildIntegration({
  repoRoot,
  branches,
  build = true,
  exec = defaultExec,
  links = linkTargets,
  log = console,
}) {
  validateBranches(branches);

  const main = mainRepoRoot(repoRoot);
  if (!main || !existsSync(main)) throw new IntegrationRefusal(`${repoRoot} is not inside a git repository.`);
  const tree = integrationTreePath(main);
  const git = (args, cwd) => exec("git", args, { cwd });
  const must = async (args, cwd) => {
    const r = await git(args, cwd);
    if (!r.ok) throw new IntegrationRefusal(`git ${args.join(" ")} failed in ${cwd}:\n${(r.err || r.out).trim()}`);

    return r.out.trim();
  };

  const existed = existsSync(tree);
  if (existed) await checkTree(tree, main, git);

  await must(["fetch", "origin"], main);
  await must(["rev-parse", "--verify", "--quiet", `${BASE}^{commit}`], main);

  const heads = [];
  for (const branch of branches) {
    const r = await git(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], main);
    if (!r.ok) throw new IntegrationRefusal(`No branch or commit named ${branch}.`);
    heads.push({ branch, sha: r.out.trim() });
  }

  if (!existed) {
    const hasBranch = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`], main)).ok;
    await must(
      hasBranch ? ["worktree", "add", tree, BRANCH] : ["worktree", "add", "--no-track", "-b", BRANCH, tree, BASE],
      main,
    );
    log.log(`Created ${tree} on branch ${BRANCH}.`);
  }

  await must(["reset", "--hard", "--quiet", BASE], tree);

  const merged = [];
  for (const { branch, sha } of heads) {
    const r = await git(["merge", "--no-ff", "-m", `Merge branch '${branch}' at ${sha} into ${BRANCH}`, sha], tree);
    if (r.ok) {
      merged.push({ branch, sha });
      continue;
    }

    const conflicted = await git(["diff", "--name-only", "--diff-filter=U"], tree);
    const files = conflicted.out.split(/\r?\n/).filter(Boolean);
    if ((await git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], tree)).ok) {
      await must(["merge", "--abort"], tree);
    }
    const left = await git(["status", "--porcelain"], tree);
    if (!left.ok || left.out.trim() !== "") {
      throw new Error(`The failed merge of ${branch} left ${tree} dirty; inspect it by hand:\n${left.out}${left.err}`);
    }
    if (files.length === 0) log.error((r.err || r.out).trim());

    return { tree, merged, conflict: { branch, files, mergedBefore: merged.map((m) => m.branch) } };
  }

  if (!build) return { tree, merged };

  return { tree, merged, build: await runBuild({ tree, exec, links, log }) };
}

/** Refuses an existing tree that is not a clean `integration` worktree of `main`. */
async function checkTree(tree, main, git) {
  const top = await git(["rev-parse", "--show-toplevel"], tree);
  const owner = top.ok ? mainRepoRoot(tree) : undefined;
  if (!top.ok || !samePath(top.out.trim(), tree) || !owner || !samePath(owner, main)) {
    throw new IntegrationRefusal(`${tree} exists but is not a worktree of ${main}; move it aside first.`);
  }

  const head = await git(["symbolic-ref", "--short", "--quiet", "HEAD"], tree);
  if (!head.ok) throw new IntegrationRefusal(`${tree} has a detached HEAD, not branch ${BRANCH}.`);
  const name = head.out.trim();
  if (name !== BRANCH) throw new IntegrationRefusal(`${tree} is on branch ${name}, not ${BRANCH}.`);

  const status = await git(["status", "--porcelain"], tree);
  if (!status.ok) throw new IntegrationRefusal(`Could not read the status of ${tree}:\n${status.err.trim()}`);
  if (status.out.trim() !== "") {
    throw new IntegrationRefusal(`${tree} has uncommitted changes; nothing was reset:\n${status.out.trimEnd()}`);
  }
}

/**
 * Installs and builds the integration tree, restarting exactly the deck hosts
 * whose plugin link points into it.
 *
 * @returns {Promise<{ ok: boolean, failure?: string, tsErrors: string[],
 *   linkedHosts: string[], restartYourself: string[] }>}
 */
export async function runBuild({ tree, exec = defaultExec, links = linkTargets, log = console }) {
  const linkedHosts = links()
    .filter(({ target }) => target && target !== REAL_DIRECTORY && isInside(target, tree))
    .map(({ host }) => host);
  if (linkedHosts.length === 0) {
    log.log(`No deck host links to ${tree}: building without a restart. Linking one is the maintainer's call.`);
  } else {
    log.log(`Linked to ${tree}: ${linkedHosts.join(", ")}.`);
  }

  const run = (cmd, args) => exec(cmd, args, { cwd: tree, stream: true });
  const hostApp = (action, id) => run("node", ["scripts/host-app.mjs", action, id]);
  const restartYourself = [];
  const stopped = [];
  let tsErrors = [];
  let failure;

  try {
    for (const host of linkedHosts.filter((h) => HOST_APP_IDS[h])) {
      if (!(await hostApp("stop", HOST_APP_IDS[host])).ok) {
        restartYourself.push(host);
        failure = `could not stop ${host}; not building under a host that holds the plugin open`;
        break;
      }
      stopped.push(host);
    }

    if (!failure && !(await run("pnpm", ["install"])).ok) failure = "pnpm install failed";

    if (!failure) {
      const built = await run("pnpm", ["build"]);
      tsErrors = tsDiagnostics(`${built.out}\n${built.err}`);
      if (!built.ok) failure = `pnpm build exited ${built.code}`;
      else if (tsErrors.length > 0) failure = `pnpm build printed ${tsErrors.length} TypeScript diagnostic(s)`;
    }

    if (!failure && linkedHosts.includes(STREAM_DECK) && !(await run("pnpm", ["restart:stream-deck"])).ok) {
      restartYourself.push(STREAM_DECK);
    }
  } finally {
    for (const host of stopped) {
      if (!(await hostApp("start", HOST_APP_IDS[host])).ok) restartYourself.push(host);
    }
  }

  return { ok: !failure, ...(failure ? { failure } : {}), tsErrors, linkedHosts, restartYourself };
}

/** `{ build, branches }` from the command line; throws on anything else. */
export function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "no-build": { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length === 0) throw new Error("Name at least one branch to merge.");

  return { build: !values["no-build"], branches: positionals };
}

/** The CLI, with its edges injectable. Resolves to the exit code. */
export async function main(argv, { cwd = process.cwd(), exec, links, log = console } = {}) {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    log.error(`${error.message}\n${USAGE}`);

    return EXIT_USAGE;
  }

  let result;
  try {
    result = await buildIntegration({ repoRoot: cwd, ...args, exec, links, log });
  } catch (error) {
    if (!(error instanceof IntegrationRefusal)) throw error;
    log.error(`Refused: ${error.message}`);

    return EXIT_FAILED;
  }

  const { tree, merged, conflict, build } = result;
  log.log(`\n${tree} is ${BASE}${merged.length ? " plus:" : " alone."}`);
  for (const { branch, sha } of merged) log.log(`  ${branch}  ${sha}`);

  if (conflict) {
    const before = conflict.mergedBefore.length ? conflict.mergedBefore.join(", ") : `${BASE} alone`;
    log.error(`\n${conflict.branch} conflicts with ${before}; that merge was aborted and nothing was built.`);
    for (const file of conflict.files) log.error(`  ${file}`);

    return EXIT_FAILED;
  }

  if (!build) return EXIT_OK;

  for (const host of build.restartYourself) log.error(`Restart ${host} yourself: its scripted restart failed.`);
  if (!build.ok) {
    log.error(`\nThe build failed: ${build.failure}.`);
    for (const line of build.tsErrors) log.error(`  ${line}`);

    return EXIT_FAILED;
  }
  log.log("\nBuilt.");

  return EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
