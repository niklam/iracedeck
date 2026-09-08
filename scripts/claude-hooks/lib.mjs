/**
 * Shared plumbing for the Claude Code hooks wired in `.claude/settings.json`.
 *
 * Every hook is a small Node entry point (`pre-bash.mjs`, `post-edit.mjs`, …)
 * that reads the hook payload from stdin, decides, and prints the JSON the
 * harness expects. The decisions themselves live in pure `rules-*.mjs`
 * modules so they can be tested without a shell, a git checkout, or `gh`;
 * this file is the impure edge: process I/O, `git`, `gh`, the filesystem.
 *
 * Why Node and not bash + jq: `jq` is not installed on the maintainer's
 * machine and a jq pipeline fails SILENTLY there (empty fields, exit 0) —
 * see the memory note that produced this rule. Node is always present.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

export const SPEC_DIR = "docs/superpowers/specs/";
export const MAIN_BRANCH = "master";
export const BOARD = { number: 1, owner: "niklam", statusField: "Status" };

// ---------------------------------------------------------------------------
// Hook I/O

/** Reads the whole hook payload from stdin. Returns `{}` on malformed input. */
export async function readInput() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** PreToolUse: refuse the call. The reason is shown to the model. */
export function deny(reason) {
  emit({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
}

/** PreToolUse: force the permission prompt even for an allow-listed command. */
export function ask(reason) {
  emit({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason },
  });
}

/** PostToolUse: inject text into the model's context after the tool ran. */
export function postContext(text) {
  emit({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } });
}

/** Applies a rule verdict: a string denies, `{ ask }` prompts, nothing passes. */
export function applyVerdict(verdict) {
  if (!verdict) return;
  if (typeof verdict === "string") deny(verdict);
  else if (verdict.ask) ask(verdict.ask);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Processes

/**
 * Runs a command synchronously and returns `{ ok, out, err, code }`.
 * `.cmd` shims (pnpm, tsx, streamdeck) need a shell on Windows; `.exe`
 * binaries (git, gh, node) do not, and spawning them without one keeps
 * arguments intact.
 */
export function run(cmd, args, { cwd, timeoutMs = 60_000, shell } = {}) {
  const needsShell = shell ?? (process.platform === "win32" && !/^(git|gh|node)$/.test(cmd));
  const res = spawnSync(cmd, args, {
    cwd,
    shell: needsShell,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    ok: res.status === 0 && !res.error,
    out: (res.stdout ?? "").toString(),
    err: (res.stderr ?? "").toString() + (res.error ? String(res.error.message) : ""),
    code: res.status,
  };
}

export const git = (args, cwd, opts) => run("git", args, { cwd, ...opts });
export const gh = (args, cwd, opts) => run("gh", args, { cwd, timeoutMs: 45_000, ...opts });

/** `gh … --format json` / `gh api …` parsed, or `undefined` on any failure. */
export function ghJson(args, cwd) {
  const r = gh(args, cwd);
  if (!r.ok) return undefined;
  try {
    return JSON.parse(r.out);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Git topology

/** Toplevel of the worktree containing `dir`, or `undefined` outside a repo. */
export function toplevel(dir) {
  const r = git(["rev-parse", "--show-toplevel"], dir);
  return r.ok ? path.resolve(r.out.trim()) : undefined;
}

/** The main repository checkout (the one whose `.git` is a directory). */
export function mainRepoRoot(dir) {
  const r = git(["rev-parse", "--git-common-dir"], dir);
  if (!r.ok) return undefined;
  return path.resolve(dir, r.out.trim(), "..");
}

export function currentBranch(dir) {
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  return r.ok ? r.out.trim() : undefined;
}

/** `[{ path, head, branch }]` for every worktree of the repo containing `dir`. */
export function listWorktrees(dir) {
  const r = git(["worktree", "list", "--porcelain"], dir);
  if (!r.ok) return [];
  const out = [];
  let cur = null;
  for (const line of r.out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) cur = { path: path.resolve(line.slice(9)), head: "", branch: "(detached)" };
    else if (line.startsWith("HEAD ") && cur) cur.head = line.slice(5, 14);
    else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "" && cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Number of lines in `git status --porcelain`, or -1 when unreadable. */
export function dirtyCount(dir) {
  const r = git(["status", "--porcelain"], dir);
  return r.ok ? r.out.split(/\r?\n/).filter(Boolean).length : -1;
}

/** Files the branch would push: merge-base diff against origin/master (three dots, never two). */
export function branchFiles(dir) {
  const r = git(["diff", "--name-only", `origin/${MAIN_BRANCH}...HEAD`], dir);
  return r.ok ? r.out.split(/\r?\n/).filter(Boolean) : undefined;
}

/** True when the local `origin/master` ref matches the remote's `master`. `undefined` when offline. */
export function originMasterFresh(dir) {
  const local = git(["rev-parse", `origin/${MAIN_BRANCH}`], dir);
  const remote = git(["ls-remote", "--heads", "origin", MAIN_BRANCH], dir, { timeoutMs: 8_000 });
  if (!local.ok || !remote.ok) return undefined;
  const remoteSha = remote.out.trim().split(/\s+/)[0];
  if (!remoteSha) return undefined;
  return { fresh: remoteSha === local.out.trim(), local: local.out.trim().slice(0, 9), remote: remoteSha.slice(0, 9) };
}

/** Is `candidate` inside `parent` (both absolute)? Case-insensitive on Windows. */
export function isInside(candidate, parent) {
  const norm = (p) => {
    let s = path.resolve(p).replace(/[\\/]+$/, "");
    if (process.platform === "win32") s = s.toLowerCase();
    return s;
  };
  const c = norm(candidate);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep);
}

// ---------------------------------------------------------------------------
// Deck-host plugin links

/** Where each deck host expects the dev plugin to be linked. */
export function linkLocations(env = process.env) {
  const appdata = env.APPDATA;
  if (!appdata) return [];
  return [
    {
      host: "Stream Deck",
      link: path.join(appdata, "Elgato", "StreamDeck", "Plugins", "com.iracedeck.sd.core.sdPlugin"),
    },
    {
      host: "Mirabox",
      link: path.join(
        env.MIRABOX_PLUGINS_DIR ?? path.join(appdata, "HotSpot", "StreamDock", "plugins"),
        "com.iracedeck.sd.core.sdPlugin",
      ),
    },
    {
      host: "Ulanzi",
      link: path.join(
        env.ULANZI_PLUGINS_DIR ?? path.join(appdata, "Ulanzi", "UlanziDeck", "Plugins"),
        "com.ulanzi.iracedeck.ulanziPlugin",
      ),
    },
  ];
}

/** `[{ host, target }]` — the symlink/junction target per host, `undefined` when not linked. */
export function linkTargets(env = process.env) {
  return linkLocations(env).map(({ host, link }) => {
    let target;
    try {
      target = path.resolve(readlinkSync(link));
    } catch {
      target = existsSync(link) ? "(a real directory, not a link)" : undefined;
    }
    return { host, link, target };
  });
}

// ---------------------------------------------------------------------------
// Workspace packages

/** `{ name → { dir, scripts } }` for every package under packages/ plus the root. */
export function workspacePackages(root) {
  const out = {};
  const add = (dir) => {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg.name) out[pkg.name] = { dir, scripts: Object.keys(pkg.scripts ?? {}) };
    } catch {
      /* not a package */
    }
  };
  add(root);
  const pkgs = path.join(root, "packages");
  if (existsSync(pkgs)) for (const d of readdirSync(pkgs)) add(path.join(pkgs, d));
  return out;
}

// ---------------------------------------------------------------------------
// Roadmap board (GitHub Projects v2)

/** The board's node id plus its Status field and option ids, read fresh — never hardcoded (the ids regenerate if the option list is ever rewritten). */
export function boardStatusField(cwd) {
  const project = ghJson(["project", "view", String(BOARD.number), "--owner", BOARD.owner, "--format", "json"], cwd);
  const fields = ghJson(
    ["project", "field-list", String(BOARD.number), "--owner", BOARD.owner, "--format", "json"],
    cwd,
  );
  const status = fields?.fields?.find((f) => f.name === BOARD.statusField);
  if (!project?.id || !status?.id) return undefined;
  const options = Object.fromEntries((status.options ?? []).map((o) => [o.name, o.id]));
  return { projectId: project.id, fieldId: status.id, options };
}

/** The board item for an issue: `{ itemId, status }`, or `undefined` when the issue is not on the board. */
export function boardItemForIssue(issueNumber, cwd) {
  const query =
    'query($n:Int!){repository(owner:"' +
    BOARD.owner +
    '",name:"iracedeck"){issue(number:$n){projectItems(first:10){nodes{id project{number} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}';
  const data = ghJson(["api", "graphql", "-f", `query=${query}`, "-F", `n=${issueNumber}`], cwd);
  const node = data?.data?.repository?.issue?.projectItems?.nodes?.find((n) => n.project?.number === BOARD.number);
  if (!node) return undefined;
  return { itemId: node.id, status: node.fieldValueByName?.name ?? "(none)" };
}

/** Lanes a card may be moved FROM for each automated move — never backwards (a Done card stays Done). */
export const BOARD_MOVES = {
  Backlog: ["(none)"],
  "In progress": ["(none)", "Backlog", "Planned", "Next"],
  Testing: ["(none)", "Backlog", "Planned", "Next", "In progress"],
};

/** Set `IRACEDECK_HOOKS_DRY_RUN=1` to have every board mutation report instead of run (tests, pipe-checks). */
export const dryRun = () => !!process.env.IRACEDECK_HOOKS_DRY_RUN;

/**
 * Moves one board item into a lane, only from the lanes `BOARD_MOVES` allows.
 * Returns a human-readable line either way.
 */
export function setBoardStatus(issueNumber, lane, cwd) {
  const allowedFrom = BOARD_MOVES[lane];
  if (!allowedFrom)
    return `board: "${lane}" is not a lane the hooks move cards into (${Object.keys(BOARD_MOVES).join(", ")})`;
  const item = boardItemForIssue(issueNumber, cwd);
  if (!item) return `board: #${issueNumber} is not on the Roadmap board`;
  if (item.status === lane) return `board: #${issueNumber} already in ${lane}`;
  if (!allowedFrom.includes(item.status))
    return `board: #${issueNumber} is in ${item.status}; not moving it to ${lane} (only from ${allowedFrom.join("/")})`;
  if (dryRun()) return `board (dry run): would move #${issueNumber} ${item.status} → ${lane}`;
  const field = boardStatusField(cwd);
  if (!field)
    return `board: could not read the Status field (missing \`project\` token scope? \`gh auth refresh -s project,read:project\`)`;
  const optionId = field.options[lane];
  if (!optionId) return `board: no lane named "${lane}" (have: ${Object.keys(field.options).join(", ")})`;
  const r = gh(
    [
      "project",
      "item-edit",
      "--project-id",
      field.projectId,
      "--id",
      item.itemId,
      "--field-id",
      field.fieldId,
      "--single-select-option-id",
      optionId,
    ],
    cwd,
  );
  return r.ok
    ? `board: #${issueNumber} moved ${item.status} → ${lane}`
    : `board: moving #${issueNumber} to ${lane} failed: ${r.err.trim()}`;
}

/** Adds an issue URL to the board and returns its item id, or `undefined`. */
export function addToBoard(issueUrl, cwd) {
  if (dryRun()) return "dry-run-item";
  const r = ghJson(
    ["project", "item-add", String(BOARD.number), "--owner", BOARD.owner, "--url", issueUrl, "--format", "json"],
    cwd,
  );
  return r?.id;
}
