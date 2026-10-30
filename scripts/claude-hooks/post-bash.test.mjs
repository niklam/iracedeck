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
// FAKE_GH_REPLIES (keyed by the first two arguments, a missing key fails) and
// logs every call to FAKE_GH_LOG — offline, on every platform. The script does
// nothing in a process not named gh, the hook's own included.
const FAKE_GH = mkdtempSync(path.join(os.tmpdir(), "post-bash-fake-gh-"));
const FAKE_GH_SCRIPT = path.join(FAKE_GH, "fake-gh.cjs");
writeFileSync(
  FAKE_GH_SCRIPT,
  `const fs = require("node:fs");
const path = require("node:path");
if (path.basename(process.execPath).replace(/\\.exe$/i, "") === "gh") {
  const args = [path.basename(process.argv[1]), ...process.argv.slice(2)];
  fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, cwd: process.cwd(), GH_REPO: process.env.GH_REPO }) + "\\n");
  const reply = JSON.parse(process.env.FAKE_GH_REPLIES)[args.slice(0, 2).join(" ")];
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
function fireWithGh(command, replies, { stdout = "", cwd = ROOT, tool = "Bash" } = {}) {
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

  it("adds an iRaceDeck issue to the board and moves its card — the positive control", () => {
    for (const url of [
      "https://github.com/niklam/iracedeck/issues/1527",
      "https://github.com/Niklam/iRaceDeck/issues/1527",
    ]) {
      // Dry run: the add reports an item, and the lane move then asks gh for
      // the card, which fails without gh — proof the move was attempted.
      const note = fire("gh issue create --title x --body y", { stdout: `${url}\n`, withoutGh: true });
      expect(note, url).toContain(`Added ${url} to the Roadmap board`);
      expect(note, url).toMatch(/board: #1527 /);
    }
  });

  it("leaves the board alone for an issue filed in another repository", () => {
    for (const command of [
      "gh issue create -R lint-staged/lint-staged --title x --body y",
      "gh issue create --title x --body y", // gh resolved another checkout's repository
    ]) {
      const note = fire(command, { stdout: `Creating issue in lint-staged/lint-staged\n\n${FOREIGN}\n` });
      expect(note, command).toBe(
        `[hook] Filed ${FOREIGN} in lint-staged/lint-staged, not niklam/iracedeck: the Roadmap board is left alone.`,
      );
    }
    const ps = fire("gh issue create -R lint-staged/lint-staged --title x --body y", {
      stdout: FOREIGN,
      tool: "PowerShell",
    });
    expect(ps).toMatch(/left alone/);
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
    for (const command of [`gh pr merge 5 -R "$REPO" --squash`, "GH_REPO=$REPO gh pr merge 5 --squash"])
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

    it("moves the card of a worktree added in the iRaceDeck checkout — the positive control", () => {
      const { note } = fireWithGh("git worktree add ../ir-1321 -b fix/1321-x", {
        "issue view": { url: "https://github.com/niklam/iracedeck/issues/1321" },
        "api graphql": boardItem("Backlog"),
      });
      expect(note).toMatch(/^\[hook\] board \(dry run\): would move #1321 Backlog → In progress\./);
    });

    it("files an iRaceDeck issue into Backlog, and asks gh nothing for another repository's", () => {
      const replies = { "api graphql": boardItem(null) };
      const home = fireWithGh(
        "gh issue create --title x --body y",
        {},
        { stdout: "https://github.com/niklam/iracedeck/issues/1527\n" },
      );
      expect(home.note).toMatch(/board: #1527 is not on the Roadmap board/); // no reply given: the lookup ran
      expect(
        fireWithGh("gh issue create --title x --body y", replies, {
          stdout: "https://github.com/niklam/iracedeck/issues/1527\n",
        }).note,
      ).toContain("board (dry run): would move #1527 (none) → Backlog");
      const foreign = fireWithGh("gh issue create -R lint-staged/lint-staged --title x --body y", replies, {
        stdout: "https://github.com/lint-staged/lint-staged/issues/1527\n",
      });
      expect(foreign.note).toMatch(/the Roadmap board is left alone/);
      expect(foreign.calls).toEqual([]);
    });
  });
});
