/**
 * SessionStart hook: one short report of the state four "verify before you
 * act" rules used to ask for one at a time — the worktrees and which are
 * dirty, where each deck host's plugin link points, whether origin/master is
 * behind the remote, and any build watchers already running. Plain stdout
 * becomes session context.
 */
import path from "node:path";

import { dirtyCount, linkTargets, listWorktrees, originMasterFresh, run } from "./lib.mjs";

const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const lines = ["[iRaceDeck session]"];

const trees = listWorktrees(cwd);
if (trees.length) {
  lines.push("Worktrees:");
  for (const t of trees) {
    const dirty = dirtyCount(t.path);
    lines.push(
      `  ${path.basename(t.path).padEnd(12)} ${t.branch.padEnd(14)} ${t.head}  ${dirty > 0 ? `${dirty} dirty` : dirty === 0 ? "clean" : "unreadable"}${samePath(t.path, cwd) ? "  <- this session" : ""}`,
    );
  }
}

const links = linkTargets();
if (links.length) {
  lines.push("Deck-host plugin links:");
  for (const l of links)
    lines.push(`  ${l.host.padEnd(12)} -> ${l.target ? worktreeOf(l.target, trees) : "(not linked)"}`);
}

const fresh = originMasterFresh(cwd);
lines.push(
  fresh === undefined
    ? "origin/master: could not reach the remote (offline?)"
    : fresh.fresh
      ? `origin/master: up to date (${fresh.local})`
      : `origin/master: STALE — local ${fresh.local}, remote ${fresh.remote}; run git fetch origin before branching`,
);

const watchers = nodeWatchers();
if (watchers.length) {
  lines.push("Running watchers (do not fire a full build into a tree they write):");
  for (const w of watchers) lines.push(`  ${w}`);
}

process.stdout.write(lines.join("\n") + "\n");

function samePath(a, b) {
  const n = (p) => path.resolve(p).toLowerCase();
  return n(a) === n(b);
}

function worktreeOf(target, list) {
  const hit = list.find((t) => target.toLowerCase().startsWith(t.path.toLowerCase() + path.sep));
  return hit ? `${path.basename(hit.path)} (${hit.branch})` : target;
}

/** Command lines of node processes that look like watchers. Windows only; elsewhere returns []. */
function nodeWatchers() {
  if (process.platform !== "win32") return [];
  const r = run(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }",
    ],
    { timeoutMs: 15_000, shell: false },
  );
  if (!r.ok) return [];
  return r.out
    .split(/\r?\n/)
    .filter((l) =>
      /rollup(\.js)?\s.*-w\b|--watch|tsx\s+watch|vitest(?!.*\brun\b)|turbo.*watch|astro\s+dev|scenario-harness/.test(l),
    )
    .map((l) =>
      l
        .replace(/^"?[^"]*node(\.exe)?"?\s*/i, "")
        .trim()
        .slice(0, 120),
    );
}
