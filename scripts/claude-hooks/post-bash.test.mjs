import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The post-hook's triggers, fired as the harness fires them (#1321). Only
// paths whose step needs no network are used, and the board helpers run dry.
const HOOK = path.join(import.meta.dirname, "post-bash.mjs");

// A PATH with no `gh` on it, so a step that asks gh fails at once — offline
// and deterministic — and reports that it could not, which proves it ran.
const NO_GH = mkdtempSync(path.join(os.tmpdir(), "post-bash-no-gh-"));

// Scratch for paths the hook resolves. Removed after the suite: a temp dir
// left holding `ir-<n>` directories is the very shape these hooks key on.
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "post-bash-tree-"));

// A fake `gh` for the steps that read GitHub (#1527): this Node binary under
// the name `gh`, which `NODE_OPTIONS` hands a script that answers from
// FAKE_GH_REPLIES (keyed by the first two arguments, a missing key fails; a
// reply of `{ byDir: { <dir name>: reply } }` answers by the directory gh runs
// in) and logs every call to FAKE_GH_LOG — offline, on every platform. The
// script does nothing in a process not named gh, the hook's own included.
const FAKE_GH = mkdtempSync(path.join(os.tmpdir(), "post-bash-fake-gh-"));
const FAKE_GH_SCRIPT = path.join(FAKE_GH, "fake-gh.cjs");
writeFileSync(
  FAKE_GH_SCRIPT,
  `const fs = require("node:fs");
const path = require("node:path");
if (path.basename(process.execPath).replace(/\\.exe$/i, "") === "gh") {
  const args = [path.basename(process.argv[1]), ...process.argv.slice(2)];
  fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, cwd: process.cwd(), GH_REPO: process.env.GH_REPO }) + "\\n");
  let reply = JSON.parse(process.env.FAKE_GH_REPLIES)[args.slice(0, 2).join(" ")];
  if (reply && reply.byDir) reply = reply.byDir[path.basename(process.cwd())];
  if (reply === undefined) {
    fs.writeSync(2, "fake gh: no reply for " + args.join(" "));
    process.exit(1);
  }
  fs.writeSync(1, JSON.stringify(reply));
  process.exit(0);
}
`,
);
const fakeGhBinary = path.join(FAKE_GH, process.platform === "win32" ? "gh.exe" : "gh");
try {
  linkSync(process.execPath, fakeGhBinary);
} catch {
  copyFileSync(process.execPath, fakeGhBinary);
}

afterAll(() => {
  for (const dir of [NO_GH, SCRATCH, FAKE_GH]) rmSync(dir, { recursive: true, force: true });
});

// The repo root: the cwd a session hands the hook, which is where an add of
// `../ir-<n>` is meant to run from (#1358).
const ROOT = path.resolve(import.meta.dirname, "../..");

function fire(command, { stdout = "", withoutGh = false, cwd = ROOT, tool = "Bash" } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !withoutGh || k.toLowerCase() !== "path"));
  if (withoutGh) env.PATH = NO_GH;
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      tool_name: tool,
      tool_input: { command },
      tool_response: { stdout },
      cwd,
    }),
    encoding: "utf8",
    timeout: 60_000,
    env: { ...env, IRACEDECK_HOOKS_DRY_RUN: "1" },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : null;
}

let fakeCalls = 0;

/** {@link fire} with the fake gh first on PATH: the hook's note, and every gh call it made. */
function fireWithGh(command, replies, { stdout = "", cwd = ROOT, tool = "Bash", env: extra = {} } = {}) {
  const log = path.join(FAKE_GH, `calls-${++fakeCalls}.jsonl`);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !["path", "gh_repo", "node_options"].includes(k.toLowerCase())),
  );
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command }, tool_response: { stdout }, cwd }),
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...env,
      PATH: [FAKE_GH, process.env.PATH ?? process.env.Path ?? ""].join(path.delimiter),
      // Forward slashes: NODE_OPTIONS reads a backslash in quotes as an escape.
      NODE_OPTIONS: `--require "${FAKE_GH_SCRIPT.replaceAll("\\", "/")}"`,
      FAKE_GH_REPLIES: JSON.stringify(replies),
      FAKE_GH_LOG: log,
      IRACEDECK_HOOKS_DRY_RUN: "1",
      ...extra,
    },
  });
  expect(r.status, r.stderr).toBe(0);
  const calls = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
  return { note: r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : null, calls };
}

/** The board lookup's reply: the issue's card in `lane`, or with no lane when `lane` is null. */
const boardItem = (lane) => ({
  data: {
    repository: {
      issue: {
        projectItems: {
          nodes: [{ id: "PVTI_fake", project: { number: 1 }, fieldValueByName: lane ? { name: lane } : null }],
        },
      },
    },
  },
});

const issueRef = (repo, number) => ({ number, url: `https://github.com/${repo}/issues/${number}` });

describe("post-bash.mjs triggers", () => {
  it("stays silent on a mention of every trigger", () => {
    for (const command of [
      `grep -rn "gh pr merge" scripts`,
      `git commit -q -F - <<'EOF'\nsubject\n\nafter gh pr merge 7 the card moves\nEOF`,
      `git commit -m "$(cat <<'EOF'\nsubject\n\ngit worktree add ../ir-77 -b fix/77-x\nEOF\n)"`,
      `echo "gh issue create --title x"`,
      `printf '%s' 'sed -i s/a/b/ f'`,
      `grep -n 'git worktree add ../ir-5' notes.md`,
    ])
      expect(fire(command), command).toBeNull();
  });

  it("runs the issue step on a real `gh issue create`, behind a wrapper too", () => {
    expect(fire("gh issue create --title x --body y")).toMatch(/no issue URL in the output/);
    expect(fire("timeout 60 gh issue create --title x --body y")).toMatch(/no issue URL in the output/);
  });

  it("runs the sed step on a real `sed -i`, after a chain or through xargs", () => {
    expect(fire("ls && sed -i s/a/b/ nothing.txt")).toMatch(/sed -i ran/);
    expect(fire("git ls-files '*.nothing' | xargs sed -i 's/a/b/'")).toMatch(/sed -i ran/);
  });

  it("runs the merge step on a real `gh pr merge`, behind a wrapper too", () => {
    for (const command of ["gh pr merge 7 --squash", "timeout 120 gh pr merge 7 --squash"])
      expect(fire(command, { withoutGh: true }), command).toMatch(/could not read the PR back/);
    expect(fire(`gh pr merge "7" --squash`)).toMatch(/its PR argument could not be read/);
  });

  it("moves the card of the tree the add created, not of one a comment names", () => {
    const note = fire("# superseded: git worktree add ../ir-1400\ngit worktree add ../ir-1321 -b fix/1321-x", {
      withoutGh: true,
    });
    expect(note).toMatch(/Worktree for #1321 created/);
    expect(note).not.toMatch(/1400/);
  });

  it("moves the card of the tree the add created when an ancestor is named ir-<n> too (#1358)", () => {
    // Every checkout of this suite run from an ir-* worktree has that shape:
    // the first ir- segment in the path is the ancestor, the last is the add.
    const repo = path.join(SCRATCH, "ir-1325", "repo", "master");
    mkdirSync(repo, { recursive: true });
    const note = fire("git worktree add ../ir-1321 -b fix/1321-x", { withoutGh: true, cwd: repo });
    expect(note).toMatch(/Worktree for #1321 created/);
    expect(note).not.toMatch(/1325/);
  });

  // #1520 second read: the PowerShell tool's commands reached the pre-hook
  // only, so a merge, a worktree or a filing there moved no card, silently.
  it("is wired for both tools in .claude/settings.json", () => {
    const settings = JSON.parse(readFileSync(path.join(ROOT, ".claude", "settings.json"), "utf8"));
    const entries = settings.hooks.PostToolUse.filter((e) => e.hooks.some((h) => h.command.includes("post-bash.mjs")));
    expect(entries).toHaveLength(1);
    const matcher = new RegExp(`^(?:${entries[0].matcher})$`);
    for (const tool of ["Bash", "PowerShell"]) expect(matcher.test(tool), tool).toBe(true);
    expect(matcher.test("Edit")).toBe(false);
  });

  it("runs the merge, issue and worktree steps on a PowerShell command too", () => {
    const tool = "PowerShell";
    expect(fire("gh pr merge 7 --squash", { withoutGh: true, tool })).toMatch(/could not read the PR back/);
    expect(fire("gh issue create --title x --body y", { tool })).toMatch(/no issue URL in the output/);
    expect(fire("git worktree add ..\\ir-1321 -b fix/1321-x", { withoutGh: true, tool })).toMatch(
      /Worktree for #1321 created/,
    );
    // Read as PowerShell reads it: a backtick continues the line, which bash
    // would take for a command substitution and lose the path behind.
    const continued = "git worktree add `\n  ..\\ir-1323 -b fix/1323-x";
    expect(fire(continued, { withoutGh: true, tool })).toMatch(/Worktree for #1323 created/);
    expect(fire(continued, { withoutGh: true })).toBeNull();
    expect(fire("Write-Output 'gh pr merge 7'", { tool })).toBeNull();
  });
});

// #1527: a card is found by issue number alone, so a filing or a merge in
// another repository moved the iRaceDeck card that shares its number.
describe("post-bash.mjs acts on niklam/iracedeck only (#1527)", () => {
  const FOREIGN = "https://github.com/lint-staged/lint-staged/issues/1865";

  it("names an iRaceDeck issue it cannot date rather than file it", () => {
    // Without gh the issue's creation time is unknown, so it may not be the one
    // the create made; the filing with gh answering is the positive control below.
    const url = "https://github.com/niklam/iracedeck/issues/1527";
    expect(fire("gh issue create --title x --body y", { stdout: `${url}\n`, withoutGh: true })).toBe(
      `[hook] gh issue create: could not tell whether ${url} was just filed; add any that was to the Roadmap board by hand (Backlog).`,
    );
  });

  it("leaves the board alone for an issue filed in another repository", () => {
    for (const command of [
      "gh issue create -R lint-staged/lint-staged --title x --body y",
      "gh issue create --repo=git@github.com:lint-staged/lint-staged.git --title x --body y",
      "GH_REPO=lint-staged/lint-staged gh issue create --title x --body y",
    ]) {
      // withoutGh: a create that names its repository needs no gh read.
      const note = fire(command, {
        stdout: `Creating issue in lint-staged/lint-staged\n\n${FOREIGN}\n`,
        withoutGh: true,
      });
      expect(note, command).toBe(
        `[hook] Filed ${FOREIGN} in lint-staged/lint-staged, not niklam/iracedeck: the Roadmap board is left alone.`,
      );
    }
    const ps = fire("gh issue create -R lint-staged/lint-staged --title x --body y", {
      stdout: FOREIGN,
      tool: "PowerShell",
      withoutGh: true,
    });
    expect(ps).toMatch(/left alone/);
  });

  // CodeRabbit on #1535: a create that prints no URL was always sent to this board by hand.
  it("sends a foreign create that printed no URL nowhere, and a home one to the board by hand", () => {
    expect(fire("gh issue create -R lint-staged/lint-staged --web", { withoutGh: true })).toBe(
      "[hook] gh issue create ran in lint-staged/lint-staged, not niklam/iracedeck: the Roadmap board is left alone.",
    );
    for (const command of ["gh issue create -R niklam/iracedeck --web", `gh issue create -R "$R" --web`])
      expect(fire(command, { withoutGh: true }), command).toBe(
        "[hook] gh issue create: no issue URL in the output; add the card to the Roadmap board by hand (Backlog).",
      );
  });

  it("reads a merge in another repository from its arguments, before asking gh anything", () => {
    for (const command of [
      "gh pr merge 5 -R other/repo --squash",
      "gh pr merge 5 --repo=Other/Repo --squash",
      "gh pr merge 5 -Rother/repo --squash",
      "gh pr merge 5 --repo 'other/repo' --squash",
      "gh pr merge 5 --repo github.com/other/repo --squash",
      "gh pr merge https://github.com/other/repo/pull/5 --squash",
      "GH_REPO=other/repo gh pr merge 5 --squash",
      "export GH_REPO=other/repo && gh pr merge 5 --squash",
    ]) {
      // Without gh on PATH a read-back would say "could not read the PR back".
      const note = fire(command, { withoutGh: true });
      expect(note, command).toMatch(/gh pr merge ran in other\/repo, not niklam\/iracedeck: no Roadmap card moved/i);
    }
    expect(fire("gh pr merge 5 --repo ghe.example.com/niklam/iracedeck --squash", { withoutGh: true })).toMatch(
      /ran in ghe\.example\.com\/niklam\/iracedeck, not niklam\/iracedeck/,
    );
    expect(
      fire("$env:GH_REPO = 'other/repo'; gh pr merge 5 --squash", { withoutGh: true, tool: "PowerShell" }),
    ).toMatch(/ran in other\/repo/);
  });

  it("still reads an iRaceDeck merge back, however it names the repository", () => {
    for (const command of [
      "gh pr merge 5 --squash",
      "gh pr merge 5 -R niklam/iracedeck --squash",
      "gh pr merge 5 --repo NIKLAM/IRACEDECK --squash",
      "gh pr merge https://github.com/niklam/iracedeck/pull/5 --squash",
      "GH_REPO=niklam/iracedeck gh pr merge 5 --squash",
      // The flag beats the environment, as in gh.
      "GH_REPO=other/repo gh pr merge 5 -R niklam/iracedeck --squash",
    ])
      expect(fire(command, { withoutGh: true }), command).toMatch(/could not read the PR back/);
  });

  it("says so when the repository a merge names cannot be read", () => {
    for (const command of [
      `gh pr merge 5 -R "$REPO" --squash`,
      "GH_REPO=$REPO gh pr merge 5 --squash",
      // The literal prefix is not what the shell passes (CodeRabbit on #1535).
      "GH_REPO=niklam/iracedeck$SUFFIX gh pr merge 5 --squash",
      "gh pr merge 5 -R niklam/iracedeck$SUFFIX --squash",
    ])
      expect(fire(command, { withoutGh: true }), command).toMatch(/a --repo or GH_REPO the hook cannot read/);
  });

  // Each case spawns the hook and a gh per call: several to a test, which
  // outlasts the 5 s default under a full suite's load.
  describe("with gh answering (a fake gh, the board run dry)", { timeout: 30_000 }, () => {
    const graphqlFor = (calls) =>
      calls.filter((c) => c.args[0] === "api").map((c) => c.args.find((a) => /^n=/.test(a)));
    const merged = (url, closing, title = "fix(x): y (#1527)") => ({
      "pr view": { number: 1529, state: "MERGED", title, url, mergeCommit: null, closingIssuesReferences: closing },
      "api graphql": boardItem("In progress"),
    });

    it("moves the closing issues of niklam/iracedeck and names the others — the positive control", () => {
      const { note, calls } = fireWithGh(
        "gh pr merge 1529 --squash",
        merged("https://github.com/niklam/iracedeck/pull/1529", [
          issueRef("niklam/iracedeck", 1527),
          issueRef("lint-staged/lint-staged", 1865),
        ]),
      );
      expect(note).toContain("board (dry run): would move #1527 In progress → Testing");
      expect(note).toContain(
        "Closing issues outside niklam/iracedeck have no Roadmap card: lint-staged/lint-staged#1865.",
      );
      expect(graphqlFor(calls)).toEqual(["n=1527"]);
    });

    it("moves the title's card when every closing issue is in another repository", () => {
      const { note, calls } = fireWithGh(
        "gh pr merge 1529 --squash",
        merged("https://github.com/niklam/iracedeck/pull/1529", [issueRef("lint-staged/lint-staged", 1865)]),
      );
      expect(note).toContain("would move #1527 In progress → Testing");
      expect(graphqlFor(calls)).toEqual(["n=1527"]);
    });

    it("stops at a PR gh read back from another repository", () => {
      // gh resolved the repository from where the merge ran: no flag named it.
      const { note, calls } = fireWithGh(
        "gh pr merge 1529 --squash",
        merged("https://github.com/lint-staged/lint-staged/pull/1529", [issueRef("lint-staged/lint-staged", 1527)]),
      );
      expect(note).toBe(
        "[hook] gh pr merge: PR https://github.com/lint-staged/lint-staged/pull/1529 is in lint-staged/lint-staged, not niklam/iracedeck: no Roadmap card moved and no post-merge runs listed.",
      );
      expect(calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual(["pr view"]);
    });

    const open = {
      "pr view": { number: 5, state: "OPEN", title: "x", url: "https://github.com/niklam/iracedeck/pull/5" },
    };
    /** The one gh call a merge's read-back made, for a home PR that is still open. */
    const readBack = (command) => {
      const { note, calls } = fireWithGh(command, open);
      expect(note, command).toMatch(/PR #5 is OPEN, not MERGED/);
      expect(calls, command).toHaveLength(1);
      return calls[0];
    };

    it("reads the PR back from the repository the merge used", () => {
      // No PR argument: gh refuses --repo without one, so the repository goes as GH_REPO.
      const bare = readBack("GH_REPO=niklam/iracedeck gh pr merge --squash");
      expect(bare.GH_REPO).toBe("niklam/iracedeck");
      expect(bare.args.slice(0, 3)).toEqual(["pr", "view", "--json"]);
      expect(readBack("gh pr merge 5 -R NIKLAM/IRACEDECK --squash")).toMatchObject({ GH_REPO: "NIKLAM/IRACEDECK" });
      const byUrl = readBack("gh pr merge https://github.com/niklam/iracedeck/pull/5");
      expect(byUrl.GH_REPO).toBeUndefined();
      expect(byUrl.args).toContain("https://github.com/niklam/iracedeck/pull/5");
      // An assignment that never reaches the merge is not the merge's: after it,
      // in a body, a prefix of another command, or not exported.
      for (const command of [
        "gh pr merge 5 --squash && GH_REPO=other/repo gh issue list",
        `gh pr merge 5 --squash --body "GH_REPO=other/repo"`,
        "GH_REPO=other/repo gh pr view 3 && gh pr merge 5 --squash",
        "GH_REPO=other/repo; gh pr merge 5 --squash",
      ])
        expect(readBack(command).GH_REPO, command).toBeUndefined();
      expect(readBack("export GH_REPO=niklam/iracedeck; gh pr merge 5 --squash").GH_REPO).toBe("niklam/iracedeck");
    });

    it("reads the PR back in the directory the merge ran in", () => {
      const sameDir = (call, dir) => expect(path.resolve(call.cwd).toLowerCase()).toBe(path.resolve(dir).toLowerCase());
      const elsewhere = path.join(SCRATCH, "merge-cwd");
      mkdirSync(elsewhere, { recursive: true });
      const there = elsewhere.replaceAll("\\", "/");
      sameDir(readBack(`cd ${there} && gh pr merge 5 --squash`), elsewhere);
      // A cd after the merge, behind a wrapper the anchor does not know, is not where it ran.
      sameDir(readBack(`winpty gh pr merge 5 --squash && cd ${there}`), ROOT);
      // The chain removed the directory the merge ran in: the session's is used.
      sameDir(readBack(`cd ${there}/removed && gh pr merge 5 --squash`), ROOT);
    });

    it("moves no card for a worktree added in another repository's checkout", () => {
      const checkout = path.join(SCRATCH, "foreign", "master");
      mkdirSync(checkout, { recursive: true });
      const { note, calls } = fireWithGh(`git -C ${checkout.replaceAll("\\", "/")} worktree add ../ir-1321 -b fix/x`, {
        "issue view": { url: "https://github.com/lint-staged/lint-staged/issues/1321" },
        "api graphql": boardItem("Backlog"),
      });
      expect(note).toBe(
        "[hook] Worktree ir-1321 created in a checkout of lint-staged/lint-staged, not niklam/iracedeck: no Roadmap card moved.",
      );
      expect(calls).toHaveLength(1);
      expect(path.resolve(calls[0].cwd).toLowerCase()).toBe(path.resolve(checkout).toLowerCase());
    });

    // CodeRabbit on #1535: an inherited GH_REPO names the session's default, not the checkout.
    it("looks a worktree's issue up with an inherited GH_REPO cleared", () => {
      const { calls } = fireWithGh(
        "git worktree add ../ir-1321 -b fix/1321-x",
        {
          "issue view": { url: "https://github.com/niklam/iracedeck/issues/1321" },
          "api graphql": boardItem("Backlog"),
        },
        { env: { GH_REPO: "lint-staged/lint-staged" } },
      );
      const view = calls.find((c) => c.args[0] === "issue");
      expect(view.GH_REPO).toBe("");
    });

    it("moves the card of a worktree added in the iRaceDeck checkout — the positive control", () => {
      const { note } = fireWithGh("git worktree add ../ir-1321 -b fix/1321-x", {
        "issue view": { url: "https://github.com/niklam/iracedeck/issues/1321" },
        "api graphql": boardItem("Backlog"),
      });
      expect(note).toMatch(/^\[hook\] board \(dry run\): would move #1321 Backlog → In progress\./);
    });

    const home = (n, tail = "") => `https://github.com/niklam/iracedeck/issues/${n}${tail}`;
    /** The fake gh's answer to the hook's age lookup of `repo`#`n`. */
    const created = (n, at, repo = "niklam/iracedeck") => ({
      [`api repos/${repo}/issues/${n}`]: { created_at: new Date(at).toISOString() },
    });
    const justNow = () => Date.now() - 60_000;
    /** The fake gh's answer to `gh repo view`: the repository of the checkout a create ran in. */
    const checkout = (nameWithOwner) => ({ "repo view": { nameWithOwner } });
    const OLD = "2026-09-01T00:00:00Z";
    const filed = (note) => [...note.matchAll(/Added (\S+) to the Roadmap board/g)].map((m) => m[1]);

    // #1527, found by the PO: a chain's output carried a comment's URL first,
    // and the hook filed the commented issue rather than the created one.
    it("files the issue a chained create printed, not one a comment, an edit or a view printed", () => {
      const comment = fireWithGh(
        "gh issue comment 1483 --body x && gh issue create --title y --body z",
        { ...created(1534, justNow()), "api graphql": boardItem(null) },
        { stdout: `${home(1483, "#issuecomment-4242")}\n${home(1534)}\n` },
      );
      expect(filed(comment.note)).toEqual([home(1534)]);
      expect(comment.calls.some((c) => c.args.some((a) => a.includes("1483")))).toBe(false);

      // An edit prints a bare URL too: GitHub's creation time tells them apart.
      const edit = fireWithGh(
        "gh issue edit 1483 --add-label x && gh issue create --title y --body z",
        { ...created(1483, OLD), ...created(1534, justNow()), "api graphql": boardItem(null) },
        { stdout: `${home(1483)}\n${home(1534)}\n` },
      );
      expect(filed(edit.note)).toEqual([home(1534)]);

      // A `--web` create prints no URL, so a view's is the only one in the output (CodeRabbit).
      const web = fireWithGh(
        "gh issue view 1483 --json url --jq .url && gh issue create --web",
        { ...created(1483, OLD), "api graphql": boardItem(null) },
        { stdout: `${home(1483)}\n` },
      );
      expect(web.note).toBe(
        "[hook] gh issue create: no issue in the output was just created; add the card to the Roadmap board by hand (Backlog).",
      );
      expect(web.calls.some((c) => c.args[0] === "api" && c.args[1] === "graphql")).toBe(false);

      // Two creates, two URLs: both filed.
      const two = fireWithGh(
        "gh issue create --title a --body b && gh issue create --title c --body d",
        { ...created(1534, justNow()), ...created(1535, justNow()), "api graphql": boardItem(null) },
        { stdout: `${home(1534)}\n${home(1535)}\n` },
      );
      expect(filed(two.note)).toEqual([home(1534), home(1535)]);
    });

    // CodeRabbit on #1535: whether a create that named no repository was home
    // is the checkout's repository, asked of gh only when the reminder needs it.
    // CodeRabbit on #1535: two creates in one chain, each in its own checkout.
    it("judges each create by its own checkout when the chain moves between them", () => {
      const [foreignCo, homeCo] = ["co-lint", "co-home"].map((name) => {
        const dir = path.join(SCRATCH, name);
        mkdirSync(dir, { recursive: true });
        return dir.replaceAll("\\", "/");
      });
      const command = `cd ${foreignCo} && gh issue create --web && cd ${homeCo} && gh issue create --web`;
      const { note, calls } = fireWithGh(command, {
        "repo view": {
          byDir: {
            "co-lint": { nameWithOwner: "lint-staged/lint-staged" },
            "co-home": { nameWithOwner: "niklam/iracedeck" },
          },
        },
      });
      expect(note).toBe(
        "[hook] gh issue create: no issue URL in the output; add the card to the Roadmap board by hand (Backlog).",
      );
      expect(calls.map((c) => path.basename(c.cwd))).toEqual(["co-lint", "co-home"]);
      // Both in the foreign checkout: nothing for this board.
      const bothForeign = fireWithGh(`cd ${foreignCo} && gh issue create --web && gh issue create --web`, {
        "repo view": { byDir: { "co-lint": { nameWithOwner: "lint-staged/lint-staged" } } },
      });
      expect(bothForeign.note).toBe(
        "[hook] gh issue create ran in lint-staged/lint-staged, not niklam/iracedeck: the Roadmap board is left alone.",
      );
      expect(bothForeign.calls).toHaveLength(1); // asked once per directory
    });

    it("judges a create that named no repository by the checkout it ran in", () => {
      const foreign = "https://github.com/lint-staged/lint-staged/issues/1865";
      // A foreign view's URL beside a home `--web` create: the home card still needs a hand.
      const homeWeb = fireWithGh(
        "gh issue view 1865 -R lint-staged/lint-staged --json url --jq .url && gh issue create --web",
        checkout("niklam/iracedeck"),
        { stdout: `${foreign}\n` },
      );
      expect(homeWeb.note).toBe(
        `[hook] Filed ${foreign} in lint-staged/lint-staged, not niklam/iracedeck: the Roadmap board is left alone.\n` +
          "[hook] gh issue create: no issue in the output was just created; add the card to the Roadmap board by hand (Backlog).",
      );
      // The same output from a create run in a lint-staged checkout: no hand move.
      const elsewhere = fireWithGh("gh issue create --title x --body y", checkout("lint-staged/lint-staged"), {
        stdout: `${foreign}\n`,
      });
      expect(elsewhere.note).toBe(
        `[hook] Filed ${foreign} in lint-staged/lint-staged, not niklam/iracedeck: the Roadmap board is left alone.`,
      );
      // A create in this checkout files its issue; one naming this repository needs no ask.
      const filedHome = fireWithGh(
        "gh issue create --title x --body y",
        { ...checkout("niklam/iracedeck"), ...created(1534, justNow()), "api graphql": boardItem(null) },
        { stdout: `${home(1534)}\n` },
      );
      expect(filed(filedHome.note)).toEqual([home(1534)]);
      const named = fireWithGh(
        "gh issue create -R niklam/iracedeck --title x --body y",
        { ...created(1534, justNow()), "api graphql": boardItem(null) },
        { stdout: `${home(1534)}\n` },
      );
      expect(filed(named.note)).toEqual([home(1534)]);
      expect(named.calls.some((c) => c.args[0] === "repo")).toBe(false);
    });

    // CodeRabbit on #1535: a just-created iRaceDeck issue another command printed
    // is not filed when every create ran in another repository.
    it("files no iRaceDeck URL beside creates that all ran elsewhere", () => {
      const viewThenForeign =
        "gh issue view 1534 --json url --jq .url && gh issue create -R lint-staged/lint-staged --web";
      const named = fireWithGh(
        viewThenForeign,
        { ...created(1534, justNow()), "api graphql": boardItem(null) },
        {
          stdout: `${home(1534)}\n`,
        },
      );
      expect(named.note).toBe(
        "[hook] gh issue create ran in lint-staged/lint-staged, not niklam/iracedeck: the Roadmap board is left alone.",
      );
      expect(named.calls).toEqual([]);
      // The same when the checkout, not a flag, says so.
      const byCheckout = fireWithGh(
        "gh issue view 1534 --json url --jq .url && gh issue create --web",
        { ...checkout("lint-staged/lint-staged"), ...created(1534, justNow()), "api graphql": boardItem(null) },
        { stdout: `${home(1534)}\n` },
      );
      expect(filed(byCheckout.note)).toEqual([]);
      expect(byCheckout.note).toMatch(/ran in lint-staged\/lint-staged, not niklam\/iracedeck/);
    });

    it("names the candidates rather than guess when it cannot read their ages", () => {
      const note = fire("gh issue edit 1483 --add-label x && gh issue create --title y --body z", {
        stdout: "https://github.com/niklam/iracedeck/issues/1483\nhttps://github.com/niklam/iracedeck/issues/1534\n",
        withoutGh: true,
      });
      expect(note).toBe(
        "[hook] gh issue create: could not tell whether https://github.com/niklam/iracedeck/issues/1483, https://github.com/niklam/iracedeck/issues/1534 were just filed; add any that was to the Roadmap board by hand (Backlog).",
      );
    });

    it("files an iRaceDeck issue into Backlog — the positive control — and asks gh nothing for another repository's", () => {
      for (const [url, repo] of [
        [home(1527), "niklam/iracedeck"],
        ["https://github.com/Niklam/iRaceDeck/issues/1527", "Niklam/iRaceDeck"],
      ]) {
        const { note } = fireWithGh(
          "gh issue create --title x --body y",
          { ...created(1527, justNow(), repo), "api graphql": boardItem(null) },
          { stdout: `${url}\n` },
        );
        expect(filed(note), url).toEqual([url]);
        expect(note, url).toContain("board (dry run): would move #1527 (none) → Backlog");
      }
      const foreign = fireWithGh(
        "gh issue create -R lint-staged/lint-staged --title x --body y",
        { "api graphql": boardItem(null) },
        { stdout: "https://github.com/lint-staged/lint-staged/issues/1527\n" },
      );
      expect(foreign.note).toMatch(/the Roadmap board is left alone/);
      expect(foreign.calls).toEqual([]);
    });
  });
});
