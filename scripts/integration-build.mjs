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
 * 1. Refuses a git older than 2.38 (step 2 needs `merge-tree --write-tree`),
 *    a tree that is dirty (untracked files included), detached, on any branch
 *    but `integration`, or not a worktree of this repository — and every branch
 *    name it cannot resolve, or that names the integration branch under any
 *    spelling (`heads/integration`, `integration~0`, an earlier head's sha: a
 *    commit no ref but `integration` holds), which would bring the previous
 *    run's merges back unnamed — before anything is fetched, reset or merged.
 * 2. Fetches, then merges the whole chain without a work tree: from
 *    `origin/master`'s sha, `git merge-tree --write-tree` merges each branch in
 *    turn and `git commit-tree` records the result as the base for the next.
 *    Both write objects only, never a ref, and nothing touches the tree. A
 *    conflict anywhere in the chain is reported here — which branch, its
 *    conflicted files, what was merged before it — and the run stops (exit 1)
 *    with the tree exactly as it was. A deck host may be running from that
 *    tree, and a reset plus part of the chain, unbuilt and unrestarted, would
 *    take away the build the maintainer was testing. A conflict is resolved in
 *    the issue worktrees, never here.
 * 3. Only once the whole chain merged clean: resets `integration` hard to that
 *    `origin/master` sha (a missing tree is created there first, with no
 *    upstream) and merges each branch with `--no-ff` in the order given. Each is
 *    merged by the full sha it resolved to at the start, so the pass the
 *    maintainer gives belongs to exactly the commit he tested, and the sha is in
 *    the merge commit's subject. Should a real merge conflict all the same (a
 *    fallback that step 2 is there to make unreachable), it collects the
 *    conflicted files, runs `git merge --abort`, checks the tree came back
 *    clean, reports the conflict and stops; the earlier merges stay, and nothing
 *    is left half-merged.
 * 4. Unless `--no-build`: `pnpm install` and `pnpm build` in the tree, output
 *    streamed and scanned for `TS<n>:` diagnostics (fatal even on exit 0, as
 *    `build-and-commit.md` says). The deck hosts whose plugin link points into
 *    the tree — and only those — are stopped before the install and started
 *    after the build, since a host left running would hold the plugin open
 *    while `bin/` is rewritten. Stream Deck through the root `stop:stream-deck`
 *    and `start:stream-deck` scripts (starting the app loads the new plugin, so
 *    no `restart:stream-deck` follows), Mirabox and Ulanzi through
 *    `scripts/host-app.mjs`. A host that cannot be stopped stops the run before
 *    the install, and the hosts already stopped are started again on the
 *    untouched plugin. `pnpm build:with-restart` is deliberately not used: it
 *    finds Stream Deck through `wmic`, which current Windows 11 no longer
 *    ships, and then silently restarts nothing. Any host whose stop or start
 *    failed is named for the maintainer to restart himself. When the install
 *    or the build fails, nothing is started: a host started then would load a
 *    half-written plugin, so every host this run stopped stays stopped and is
 *    named (`stoppedHosts`) for the maintainer to start once the build is
 *    fixed.
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
const INTEGRATION_REF = `refs/heads/${BRANCH}`;
export const BASE = "origin/master";
export const USAGE = "usage: node scripts/integration-build.mjs [--no-build] <branch…>";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** A refusal: nothing was changed, and the message says why. */
export class IntegrationRefusal extends Error {}

/** Deck hosts stopped and started with `scripts/host-app.mjs`, by the label `linkTargets` reports. */
const HOST_APP_IDS = { Mirabox: "mirabox", Ulanzi: "ulanzi" };
const STREAM_DECK = "Stream Deck";

/** Whether this script stops and starts `host` around a build. */
const isControlledHost = (host) => host === STREAM_DECK || Boolean(HOST_APP_IDS[host]);

/**
 * The command that stops or starts `host`, as `[cmd, args]`: Stream Deck
 * through the root `stop:stream-deck` / `start:stream-deck` scripts (a
 * `taskkill` and a `start /B` of StreamDeck.exe), the others through
 * `scripts/host-app.mjs`.
 */
function hostCommand(action, host) {
  return host === STREAM_DECK
    ? ["pnpm", [`${action}:stream-deck`]]
    : ["node", ["scripts/host-app.mjs", action, HOST_APP_IDS[host]]];
}

/**
 * Stops or starts `host` in `tree`, output streamed. Starting Stream Deck gets
 * no pipes instead: `start /B` hands them to StreamDeck.exe, which outlives the
 * command (`host-app.mjs` detaches its app with no output of its own).
 */
function controlHost(action, host, exec, tree) {
  const [cmd, args] = hostCommand(action, host);
  const noOutput = action === "start" && host === STREAM_DECK;

  return exec(cmd, args, noOutput ? { cwd: tree, noOutput } : { cwd: tree, stream: true });
}

/** The integration worktree: the `ir-integration` sibling of the main checkout. */
export function integrationTreePath(mainRoot) {
  return path.join(path.dirname(path.resolve(mainRoot)), TREE_NAME);
}

/** The first git whose `merge-tree` has `--write-tree`, which the dry run of the chain needs. */
export const MIN_GIT_VERSION = [2, 38];

/** Whether `git --version` output names a git at least `MIN_GIT_VERSION`; false when unreadable. */
export function supportsWriteTree(versionText) {
  const m = /\bgit version (\d+)\.(\d+)/.exec(versionText ?? "");
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  const [needMajor, needMinor] = MIN_GIT_VERSION;

  return major > needMajor || (major === needMajor && minor >= needMinor);
}

/**
 * `git merge-tree --write-tree --name-only` output: `{ tree, files, messages }`,
 * or undefined when the first line is no object id (git's own error, which
 * also exits 1). The conflicted names run from the second line to the first
 * blank one; git's informational messages follow it.
 */
export function parseMergeTree(out) {
  const lines = out.split(/\r?\n/);
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(lines[0] ?? "")) return undefined;
  const blank = lines.indexOf("", 1);
  const end = blank === -1 ? lines.length : blank;
  const messages = lines.slice(end + 1).join("\n");

  return { tree: lines[0], files: [...new Set(lines.slice(1, end))], messages: messages.trim() };
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
 * With `noOutput`, the command gets no pipes at all and nothing is captured:
 * for one that leaves a process running behind it (`start:stream-deck` leaves
 * StreamDeck.exe), which would inherit a pipe and hold it open, so a run that
 * reads to the end of the output would wait for as long as the app runs.
 */
export function defaultExec(cmd, args, { cwd, stream = false, noOutput = false } = {}) {
  const direct = cmd === "git" || cmd === "node";
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  if (noOutput) {
    // No windowsHide: the app it starts should open as it would from a shortcut.
    const options = { cwd, env, stdio: "ignore" };
    const res = direct ? spawnSync(cmd, args, options) : spawnSyncShim(cmd, args, options);

    return Promise.resolve({
      ok: res.status === 0 && !res.error,
      code: res.status,
      out: "",
      err: res.error ? String(res.error.message) : "",
    });
  }

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
    if (branch === BRANCH || branch === INTEGRATION_REF) {
      throw new IntegrationRefusal(`Refusing to merge the ${BRANCH} branch itself.`);
    }
    if (seen.has(branch)) throw new IntegrationRefusal(`${branch} is named more than once.`);
    seen.add(branch);
  }
}

const samePath = (a, b) => isInside(a, b) && isInside(b, a);

/**
 * Refuses a name that resolved to the integration branch under another
 * spelling (`heads/integration`, `integration~0`, `integration^0`, an
 * earlier head by its sha or through the reflog). Merging one would bring the
 * previous run's merges back without naming them, so the printout of what the
 * tree holds would lie. Two checks: the name's full ref, and whether any ref
 * but `refs/heads/integration` contains the commit — a commit only the
 * integration branch holds, or none at all, is not an issue branch's head.
 * `--count=2` is enough: of two refs that contain it, one is another ref.
 */
async function refuseIntegrationCommit({ branch, sha, cwd, git, must }) {
  const full = await git(["rev-parse", "--symbolic-full-name", branch], cwd);
  if (full.ok && full.out.trim() === INTEGRATION_REF) {
    throw new IntegrationRefusal(`Refusing to merge the ${BRANCH} branch itself (${branch}).`);
  }

  const holders = await must(["for-each-ref", "--count=2", "--contains", sha, "--format=%(refname)"], cwd);
  if (!holders.split(/\r?\n/).some((ref) => ref !== "" && ref !== INTEGRATION_REF)) {
    throw new IntegrationRefusal(
      `Refusing to merge ${branch}: its commit ${sha} is on no ref but ${BRANCH}'s, so it would bring an earlier integration build back unnamed. Name the issue branch instead.`,
    );
  }
}

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
 *   treeChanged: boolean,
 *   conflict?: { branch: string, files: string[], mergedBefore: string[] },
 *   build?: Awaited<ReturnType<typeof runBuild>> }>} `merged` lists what the
 *   tree really holds; `treeChanged` is false when the dry run found a
 *   conflict, so nothing was reset, merged or built
 * @throws {IntegrationRefusal} before anything is reset or merged
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

  const version = await git(["--version"], main);
  if (!version.ok || !supportsWriteTree(version.out)) {
    const found = version.ok ? version.out.trim() : `no version (${version.err.trim()})`;
    throw new IntegrationRefusal(
      `git ${MIN_GIT_VERSION.join(".")} or later is needed for merge-tree --write-tree; found ${found}.`,
    );
  }

  const existed = existsSync(tree);
  if (existed) await checkTree(tree, main, git);

  const resolve = async (branch) => {
    const r = await git(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], main);

    return r.ok ? r.out.trim() : undefined;
  };

  // Every name that resolves before the fetch is checked before it. The fetch
  // cannot change the verdict for one of them, since it never moves the
  // integration branch, which is never pushed; the names it makes resolvable
  // are remote-tracking ones, checked again below once resolved.
  for (const branch of branches) {
    const sha = await resolve(branch);
    if (sha) await refuseIntegrationCommit({ branch, sha, cwd: main, git, must });
  }

  await must(["fetch", "origin"], main);
  const base = await must(["rev-parse", "--verify", "--quiet", `${BASE}^{commit}`], main);

  const heads = [];
  for (const branch of branches) {
    const sha = await resolve(branch);
    if (!sha) throw new IntegrationRefusal(`No branch or commit named ${branch}.`);
    await refuseIntegrationCommit({ branch, sha, cwd: main, git, must });
    heads.push({ branch, sha });
  }

  const dryRunConflict = await mergeChainDryRun({ base, heads, cwd: main, git, must, log });
  if (dryRunConflict) return { tree, merged: [], treeChanged: false, conflict: dryRunConflict };

  if (!existed) {
    const hasBranch = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`], main)).ok;
    await must(
      hasBranch ? ["worktree", "add", tree, BRANCH] : ["worktree", "add", "--no-track", "-b", BRANCH, tree, base],
      main,
    );
    log.log(`Created ${tree} on branch ${BRANCH}.`);
  }

  await must(["reset", "--hard", "--quiet", base], tree);

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

    return {
      tree,
      merged,
      treeChanged: true,
      conflict: { branch, files, mergedBefore: merged.map((m) => m.branch) },
    };
  }

  if (!build) return { tree, merged, treeChanged: true };

  return { tree, merged, treeChanged: true, build: await runBuild({ tree, exec, links, log }) };
}

/**
 * Merges `heads` onto `base` one after another without a work tree, as the
 * real `--no-ff` merges will: `merge-tree --write-tree` gives each merge's
 * tree, and `commit-tree` turns it into the two-parent commit the next branch
 * is merged onto, so every merge sees the same merge base the real one will.
 * Both write objects only — no ref, no index, no work tree — and run in the
 * main checkout, never the integration tree.
 *
 * @returns {Promise<{ branch: string, files: string[], mergedBefore: string[] } | undefined>}
 *   the first conflict, or undefined when the whole chain merges clean
 * @throws {IntegrationRefusal} when git fails for any reason but a conflict
 */
async function mergeChainDryRun({ base, heads, cwd, git, must, log }) {
  let current = base;
  for (const [i, { branch, sha }] of heads.entries()) {
    const r = await git(["merge-tree", "--write-tree", "--name-only", current, sha], cwd);
    const result = r.ok || r.code === 1 ? parseMergeTree(r.out) : undefined;
    if (!result) {
      throw new IntegrationRefusal(`git merge-tree of ${branch} failed in ${cwd}:\n${(r.err || r.out).trim()}`);
    }

    if (!r.ok) {
      if (result.files.length === 0 && result.messages) log.error(result.messages);

      return { branch, files: result.files, mergedBefore: heads.slice(0, i).map((h) => h.branch) };
    }

    current = await must(
      ["commit-tree", result.tree, "-p", current, "-p", sha, "-m", `Dry run: merge ${branch} at ${sha}`],
      cwd,
    );
  }

  return undefined;
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
 * Installs and builds the integration tree, stopping exactly the deck hosts
 * whose plugin link points into it first and starting them after — and none of
 * them when the install or the build fails, since a host started then would
 * load a half-written plugin.
 *
 * @returns {Promise<{ ok: boolean, failure?: string, tsErrors: string[],
 *   linkedHosts: string[], restartYourself: string[], stoppedHosts: string[] }>}
 *   `stoppedHosts` are the hosts this run stopped and left stopped because the
 *   install or the build failed; empty otherwise
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
  const restartYourself = [];
  const stopped = [];
  const stoppedHosts = [];
  let tsErrors = [];
  let failure;
  // "untouched" until the install starts writing into the tree, "built" once
  // the build passed; anything between leaves the plugin on disk half-written.
  let plugin = "untouched";

  try {
    for (const host of linkedHosts.filter(isControlledHost)) {
      if (!(await controlHost("stop", host, exec, tree)).ok) {
        restartYourself.push(host);
        failure = `could not stop ${host}; not building under a host that holds the plugin open`;
        break;
      }
      stopped.push(host);
    }

    if (!failure) {
      plugin = "building";
      if (!(await run("pnpm", ["install"])).ok) failure = "pnpm install failed";
    }

    if (!failure) {
      const built = await run("pnpm", ["build"]);
      tsErrors = tsDiagnostics(`${built.out}\n${built.err}`);
      if (!built.ok) failure = `pnpm build exited ${built.code}`;
      else if (tsErrors.length > 0) failure = `pnpm build printed ${tsErrors.length} TypeScript diagnostic(s)`;
      else plugin = "built";
    }
  } finally {
    if (plugin === "building") {
      stoppedHosts.push(...stopped);
    } else {
      for (const host of stopped) {
        if (!(await controlHost("start", host, exec, tree)).ok) restartYourself.push(host);
      }
    }
  }

  return { ok: !failure, ...(failure ? { failure } : {}), tsErrors, linkedHosts, restartYourself, stoppedHosts };
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

  const { tree, merged, treeChanged, conflict, build } = result;
  const conflictFiles = () => {
    for (const file of conflict.files) log.error(`  ${file}`);
  };
  const before = () => (conflict.mergedBefore.length ? conflict.mergedBefore.join(", ") : `${BASE} alone`);

  if (conflict && !treeChanged) {
    log.error(
      `\n${conflict.branch} conflicts with ${before()}. Found before the reset: ${tree} was left as it was, with nothing reset, merged or built.`,
    );
    conflictFiles();

    return EXIT_FAILED;
  }

  log.log(`\n${tree} is ${BASE}${merged.length ? " plus:" : " alone."}`);
  for (const { branch, sha } of merged) log.log(`  ${branch}  ${sha}`);

  if (conflict) {
    log.error(`\n${conflict.branch} conflicts with ${before()}; that merge was aborted and nothing was built.`);
    conflictFiles();

    return EXIT_FAILED;
  }

  if (!build) return EXIT_OK;

  for (const host of build.restartYourself) log.error(`Restart ${host} yourself: its scripted restart failed.`);
  if (!build.ok) {
    log.error(`\nThe build failed: ${build.failure}.`);
    for (const line of build.tsErrors) log.error(`  ${line}`);
    for (const host of build.stoppedHosts) {
      const [cmd, args] = hostCommand("start", host);
      log.error(
        `${host} is stopped because the build failed, and needs starting once it is fixed: the next run of this script whose build passes starts it, or ${[cmd, ...args].join(" ")}.`,
      );
    }

    return EXIT_FAILED;
  }
  log.log("\nBuilt.");

  return EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
