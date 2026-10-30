import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  cQuote,
  createRepoFormatter,
  isOnlyCommitIndex,
  parseRawDiff,
  samePath,
  STAGED_TASKS,
  toolsFor,
} from "./format-staged.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const scriptUrl = url.pathToFileURL(path.join(import.meta.dirname, "format-staged.mjs")).href;

// The hook the temp repos run: the real step with a formatter the test controls.
// The formatter saves sibling.json while it runs, the way a sibling worker's
// editor would mid-hook, and refuses any file containing FAIL.
const HARNESS = `
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { formatStaged } from ${JSON.stringify(scriptUrl)};

const config = JSON.parse(readFileSync(process.env.FORMAT_STAGED_TEST_CONFIG, "utf8"));

const createFormatter = () => async (files) => {
  writeFileSync(process.env.FORMAT_STAGED_TEST_SEEN, JSON.stringify(files.map(({ path, tools }) => ({ path, tools }))));

  if (config.siblingSave) writeFileSync(path.join(process.cwd(), config.siblingSave.path), config.siblingSave.content);

  const refused = files.filter((file) => file.text.includes("FAIL")).map((file) => file.path);

  return {
    outputs: files.map((file) =>
      file.path.endsWith(".json") ? JSON.stringify(JSON.parse(file.text), null, 2) + "\\n" : file.text.replace(/[ \\t]+$/gm, ""),
    ),
    failure: refused.length ? "fake formatter refused " + refused.join(", ") : null,
  };
};

process.exitCode = await formatStaged({ createFormatter });
`;

const FORMATTED = (value) => `{\n  "a": ${value}\n}\n`;
const SIBLING_BEFORE = `{\n  "sibling": "before"\n}\n`;
const SIBLING_MID_HOOK = `{\n  "sibling": "saved while the hook ran"\n}\n`;
const MID_HOOK_SAVE = { siblingSave: { path: "sibling.json", content: SIBLING_MID_HOOK } };

const roots = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const forSh = (p) => p.replaceAll("\\", "/");

/** A temp repo whose pre-commit hook runs the harness, isolated from the user's and the system's git config. */
function sandbox({ autocrlf = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "format-staged-"));

  roots.push(root);

  const hooks = path.join(root, "hooks");
  const harness = path.join(root, "harness.mjs");
  const globalConfig = path.join(root, "gitconfig");
  const hookConfig = path.join(root, "hook-config.json");
  const seen = path.join(root, "seen.json");
  const repo = path.join(root, "repo");

  mkdirSync(hooks);
  writeFileSync(harness, HARNESS);
  writeFileSync(path.join(hooks, "pre-commit"), `#!/bin/sh\nexec "${forSh(process.execPath)}" "${forSh(harness)}"\n`, {
    mode: 0o755,
  });
  writeFileSync(
    globalConfig,
    [
      "[user]",
      "\tname = Test",
      "\temail = test@example.com",
      "[core]",
      `\tautocrlf = ${autocrlf}`,
      "\tsafecrlf = false",
      `\thooksPath = ${forSh(hooks)}`,
      "[commit]",
      "\tgpgsign = false",
      "[init]",
      "\tdefaultBranch = master",
      "",
    ].join("\n"),
  );

  const env = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig };

  // Nothing of the outer git (a hook running this suite) may leak into the temp repos.
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;

  env.FORMAT_STAGED_TEST_CONFIG = hookConfig;
  env.FORMAT_STAGED_TEST_SEEN = seen;

  const box = {
    root,
    repo,
    env,
    git: (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }),
    commit: (cwd, ...args) => {
      const result = spawnSync("git", ["commit", ...args], { cwd, env, encoding: "utf8" });

      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    },
    hook: (config = {}) => writeFileSync(hookConfig, JSON.stringify(config)),
    seen: () => JSON.parse(readFileSync(seen, "utf8")),
  };

  box.git(root, "init", "-q", repo);
  write(repo, "own.json", FORMATTED(1));
  write(repo, "sibling.json", SIBLING_BEFORE);
  write(repo, "staged.json", FORMATTED(10));
  write(repo, "old.json", FORMATTED(20));
  write(repo, "notes.md", "# Notes\n");
  box.git(repo, "add", "-A");
  box.hook();

  const first = box.commit(repo, "-q", "-m", "fixture");

  if (first.status !== 0) throw new Error(`fixture commit failed:\n${first.output}`);

  return box;
}

function write(dir, file, content) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
}

const read = (dir, file) => readFileSync(path.join(dir, file), "utf8");
const lines = (text) => text.split("\n").filter(Boolean);

/** The paths the HEAD commit changed. */
const committed = (box, cwd) => lines(box.git(cwd, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"));
const porcelain = (box, cwd) => lines(box.git(cwd, "status", "--porcelain", "--untracked-files=no"));

describe("format-staged in a commit", { timeout: 60_000 }, () => {
  // The bug (#1402): lint-staged staged every path whose unstaged diff moved
  // while it ran, so a sibling's save rode into this commit even under --only.
  it.each([
    ["git commit --only -- own.json", (box, cwd) => box.commit(cwd, "-m", "own", "--only", "--", "own.json")],
    [
      "git add own.json && git commit",
      (box, cwd) => {
        box.git(cwd, "add", "own.json");

        return box.commit(cwd, "-m", "own");
      },
    ],
    ["git commit -a", (box, cwd) => box.commit(cwd, "-a", "-m", "own")],
    ["git commit -i -- own.json", (box, cwd) => box.commit(cwd, "-m", "own", "-i", "--", "own.json")],
  ])("%s records only own.json, formatted, and leaves the sibling's mid-hook save unstaged", (_form, commit) => {
    const box = sandbox();

    write(box.repo, "own.json", '{"a":2}');
    box.hook(MID_HOOK_SAVE);

    const result = commit(box, box.repo);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("format-staged: formatted own.json");
    expect(committed(box, box.repo)).toEqual(["own.json"]);
    expect(box.git(box.repo, "show", "HEAD:own.json")).toBe(FORMATTED(2));
    expect(read(box.repo, "sibling.json")).toBe(SIBLING_MID_HOOK);
    expect(porcelain(box, box.repo)).toEqual([" M sibling.json"]);
    expect(read(box.repo, "own.json")).toBe(FORMATTED(2));
  });

  it("formats what an --amend records", () => {
    const box = sandbox();

    write(box.repo, "own.json", '{"a":5}');
    box.git(box.repo, "add", "own.json");

    const result = box.commit(box.repo, "--amend", "-m", "fixture, amended");

    expect(result.status, result.output).toBe(0);
    expect(box.git(box.repo, "rev-list", "--count", "HEAD")).toBe("1\n");
    expect(box.git(box.repo, "show", "HEAD:own.json")).toBe(FORMATTED(5));
    expect(porcelain(box, box.repo)).toEqual([]);
  });

  // A gate reached through a junction or symlink must still run, not exit 0 having done nothing.
  it("runs as the main module when its directory is reached through a junction", () => {
    const box = sandbox();
    const link = path.join(box.root, "scripts-link");

    symlinkSync(path.join(repoRoot, "scripts"), link, "junction");
    write(box.repo, "own.json", '{"a":6}');
    box.git(box.repo, "add", "own.json");

    const result = spawnSync(process.execPath, [path.join(link, "format-staged.mjs")], {
      cwd: box.repo,
      env: box.env,
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("format-staged: formatted own.json");
    expect(box.git(box.repo, "show", ":own.json")).not.toBe('{"a":6}');

    // Node then keeps the link path as the module's URL, so both sides of the guard are resolved.
    write(box.repo, "own.json", '{"a":7}');
    box.git(box.repo, "add", "own.json");

    const preserved = spawnSync(process.execPath, ["--preserve-symlinks-main", path.join(link, "format-staged.mjs")], {
      cwd: box.repo,
      env: box.env,
      encoding: "utf8",
    });

    // Only scripts/ is linked, so the tools do not resolve from the link path and the step refuses;
    // what matters here is that it ran at all rather than exiting 0 silently.
    expect(`${preserved.stdout}${preserved.stderr}`).toMatch(/format-staged: /);
    expect(preserved.status).not.toBe(0);
  });

  // A file name cannot hold a quote on Windows; Linux CI covers it.
  it.skipIf(process.platform === "win32")("rewrites the working copy of a file whose name starts with a quote", () => {
    const box = sandbox();

    write(box.repo, '"q.json', '{"a":8}');
    box.git(box.repo, "add", "--", '"q.json');
    box.hook();

    const result = box.commit(box.repo, "-m", "quoted");

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('format-staged: formatted "q.json');
    expect(read(box.repo, '"q.json')).toBe(FORMATTED(8));
    expect(porcelain(box, box.repo)).toEqual([]);
  });

  it("keeps another staged path staged and out of a --only commit", () => {
    const box = sandbox();

    write(box.repo, "staged.json", FORMATTED(11));
    box.git(box.repo, "add", "staged.json");
    write(box.repo, "own.json", '{"a":2}');
    box.hook(MID_HOOK_SAVE);

    const result = box.commit(box.repo, "-m", "own", "--only", "--", "own.json");

    expect(result.status, result.output).toBe(0);
    expect(committed(box, box.repo)).toEqual(["own.json"]);
    // The index after the commit holds the formatted own.json (no leftover diff) and still stages staged.json.
    expect(porcelain(box, box.repo)).toEqual([" M sibling.json", "M  staged.json"]);
    expect(box.git(box.repo, "show", ":own.json")).toBe(FORMATTED(2));
  });

  it.each([
    ["--only", (box, cwd) => box.commit(cwd, "-m", "own", "--only", "--", "own.json")],
    [
      "plain",
      (box, cwd) => {
        box.git(cwd, "add", "own.json");

        return box.commit(cwd, "-m", "own");
      },
    ],
  ])("works the same in a linked worktree (%s)", (_form, commit) => {
    const box = sandbox();
    const worktree = path.join(box.root, "linked");

    box.git(box.repo, "worktree", "add", "-q", "-b", "side", worktree);
    write(worktree, "own.json", '{"a":3}');
    box.hook(MID_HOOK_SAVE);

    const result = commit(box, worktree);

    expect(result.status, result.output).toBe(0);
    expect(committed(box, worktree)).toEqual(["own.json"]);
    expect(box.git(worktree, "show", "HEAD:own.json")).toBe(FORMATTED(3));
    expect(read(worktree, "sibling.json")).toBe(SIBLING_MID_HOOK);
    expect(porcelain(box, worktree)).toEqual([" M sibling.json"]);
    expect(read(worktree, "own.json")).toBe(FORMATTED(3));
    // The main checkout is not touched by a commit in the linked one.
    expect(porcelain(box, box.repo)).toEqual([]);
  });

  it("formats the staged copy of a partially staged file and leaves its working copy byte for byte", () => {
    const box = sandbox();

    write(box.repo, "own.json", '{"a":2}');
    box.git(box.repo, "add", "own.json");
    write(box.repo, "own.json", '{"a":3}  ');
    box.hook();

    const result = box.commit(box.repo, "-m", "own");

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("format-staged: formatted the staged own.json; its working copy differs");
    expect(box.git(box.repo, "show", "HEAD:own.json")).toBe(FORMATTED(2));
    expect(box.git(box.repo, "diff", "--cached", "--name-only")).toBe("");
    expect(read(box.repo, "own.json")).toBe('{"a":3}  ');
  });

  it.each([
    ["--only", (box) => box.commit(box.repo, "-m", "own", "--only", "--", "own.json")],
    [
      "plain",
      (box) => {
        box.git(box.repo, "add", "own.json");

        return box.commit(box.repo, "-m", "own");
      },
    ],
  ])(
    "refuses the commit on a formatter error and changes nothing, the sibling's save included (%s)",
    (form, commit) => {
      const box = sandbox();
      const head = box.git(box.repo, "rev-parse", "HEAD");
      const failing = '{"FAIL":1}';

      write(box.repo, "own.json", failing);
      box.hook(MID_HOOK_SAVE);

      const result = commit(box);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("format-staged: commit refused.");
      expect(result.output).toContain("fake formatter refused own.json");
      expect(box.git(box.repo, "rev-parse", "HEAD")).toBe(head);
      expect(read(box.repo, "own.json")).toBe(failing);
      expect(read(box.repo, "sibling.json")).toBe(SIBLING_MID_HOOK);
      // The index is as it was before the commit: nothing staged under --only, the unformatted blob after `git add`.
      expect(box.git(box.repo, "show", ":own.json")).toBe(form === "plain" ? failing : FORMATTED(1));
      expect(box.git(box.repo, "show", ":sibling.json")).toBe(SIBLING_BEFORE);
    },
  );

  it.each([
    ["--only", (box) => box.commit(box.repo, "-m", "own", "--only", "--", "own.json")],
    [
      "plain",
      (box) => {
        box.git(box.repo, "add", "own.json");

        return box.commit(box.repo, "-m", "own");
      },
    ],
  ])("refuses a commit whose every change formatting reverts, and writes nothing (%s)", (form, commit) => {
    const box = sandbox();
    const head = box.git(box.repo, "rev-parse", "HEAD");
    const reformatted = '{ "a": 1 }';

    write(box.repo, "own.json", reformatted);
    box.hook();

    const result = commit(box);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Formatting reverts every staged change");
    expect(box.git(box.repo, "rev-parse", "HEAD")).toBe(head);
    expect(read(box.repo, "own.json")).toBe(reformatted);
    expect(box.git(box.repo, "show", ":own.json")).toBe(form === "plain" ? reformatted : FORMATTED(1));
  });

  it("commits a file no task covers untouched, a deletion, and a path with spaces", () => {
    const box = sandbox();
    const notes = "# Notes   \nkept as written  \n";

    write(box.repo, "notes.md", notes);
    write(box.repo, "sub dir/own file.json", '{"a":4}');
    write(box.repo, "tool.mjs", "export const a = 1;   \n");
    unlinkSync(path.join(box.repo, "old.json"));
    box.git(box.repo, "add", "-A");
    box.hook();

    const result = box.commit(box.repo, "-m", "mixed");

    expect(result.status, result.output).toBe(0);
    expect(committed(box, box.repo)).toEqual(["notes.md", "old.json", "sub dir/own file.json", "tool.mjs"]);
    expect(box.git(box.repo, "show", "HEAD:notes.md")).toBe(notes);
    expect(box.git(box.repo, "ls-tree", "--name-only", "HEAD", "old.json")).toBe("");
    expect(box.git(box.repo, "show", "HEAD:sub dir/own file.json")).toBe(FORMATTED(4));
    expect(box.git(box.repo, "show", "HEAD:tool.mjs")).toBe("export const a = 1;\n");
    expect(box.seen()).toEqual([
      { path: "sub dir/own file.json", tools: ["prettier"] },
      { path: "tool.mjs", tools: ["eslint", "prettier"] },
    ]);
    expect(porcelain(box, box.repo)).toEqual([]);
  });

  it("checks the working copy out through the eol conversion (core.autocrlf=true)", () => {
    const box = sandbox({ autocrlf: true });

    write(box.repo, "own.json", '{"a":2}');
    box.git(box.repo, "add", "own.json");
    box.hook();

    const result = box.commit(box.repo, "-m", "own");

    expect(result.status, result.output).toBe(0);
    expect(box.git(box.repo, "show", "HEAD:own.json")).toBe(FORMATTED(2));
    expect(read(box.repo, "own.json")).toBe(FORMATTED(2).replaceAll("\n", "\r\n"));
    expect(porcelain(box, box.repo)).toEqual([]);
  });

  it("does nothing, and loads no formatter, when no staged file is covered", () => {
    const box = sandbox();

    write(box.repo, "notes.md", "# Changed\n");
    box.git(box.repo, "add", "notes.md");
    box.hook();
    writeFileSync(path.join(box.root, "seen.json"), "null");

    const result = box.commit(box.repo, "-m", "notes");

    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain("format-staged");
    expect(box.seen()).toBeNull();
  });
});

describe("the husky pre-commit hook", () => {
  it("runs this step, and lint-staged no longer", () => {
    const hook = readFileSync(path.join(repoRoot, ".husky", "pre-commit"), "utf8");

    expect(hook).toMatch(/^node scripts\/format-staged\.mjs$/m);
    expect(hook).not.toMatch(/lint-staged/);
  });
});

describe("STAGED_TASKS and toolsFor", () => {
  it("runs ESLint then Prettier on .ts and .mjs, Prettier alone on .json, and nothing on the rest", () => {
    expect(toolsFor("packages/x/src/a.ts")).toEqual(["eslint", "prettier"]);
    expect(toolsFor("packages/x/src/a.d.ts")).toEqual(["eslint", "prettier"]);
    expect(toolsFor("scripts/a.mjs")).toEqual(["eslint", "prettier"]);
    expect(toolsFor("package.json")).toEqual(["prettier"]);
    expect(toolsFor("README.md")).toBeNull();
    expect(toolsFor("scripts/a.js")).toBeNull();
    expect(toolsFor("Makefile")).toBeNull();
  });

  it("is frozen, so a caller cannot change what the hook runs", () => {
    expect(Object.isFrozen(STAGED_TASKS)).toBe(true);
    expect(STAGED_TASKS.every((task) => Object.isFrozen(task.extensions) && Object.isFrozen(task.tools))).toBe(true);
  });
});

describe("cQuote", () => {
  it("quotes a path so git hash-object --stdin-paths reads it back as itself", () => {
    expect(cQuote('a "b"\\c\nd')).toBe('"a \\"b\\"\\\\c\\nd"');

    // Windows forbids a quote in a file name; a backslash-free name with spaces still exercises the unquoting.
    const box = sandbox();
    const name = process.platform === "win32" ? "a b.json" : 'a "b"\\c.json';

    write(box.repo, name, "{}\n");

    const quoted = execFileSync("git", ["hash-object", "--stdin-paths"], {
      cwd: box.repo,
      env: box.env,
      encoding: "utf8",
      input: `${cQuote(name)}\n`,
    });

    expect(quoted).toBe(box.git(box.repo, "hash-object", "--", name));
  });
});

describe("parseRawDiff", () => {
  it("reads modes, shas, status and path, including a path with spaces", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const z = "0".repeat(40);
    const raw = `:100644 100644 ${a} ${b} M\0own.json\0:000000 100644 ${z} ${b} A\0sub dir/x.ts\0:100644 000000 ${a} ${z} D\0old.json\0`;

    expect(parseRawDiff(raw)).toEqual([
      { srcMode: "100644", dstMode: "100644", srcSha: a, dstSha: b, status: "M", path: "own.json" },
      { srcMode: "000000", dstMode: "100644", srcSha: z, dstSha: b, status: "A", path: "sub dir/x.ts" },
      { srcMode: "100644", dstMode: "000000", srcSha: a, dstSha: z, status: "D", path: "old.json" },
    ]);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseRawDiff("")).toEqual([]);
  });
});

describe("index paths", () => {
  it("compares Windows paths across slashes and case", () => {
    expect(samePath("C:/Repo/.git/index.lock", "c:\\repo\\.git\\INDEX.lock", "win32")).toBe(true);
    expect(samePath("C:/Repo/.git/index", "C:/Repo/.git/index.lock", "win32")).toBe(false);
    expect(samePath("/repo/.git/Index.lock", "/repo/.git/index.lock", "linux")).toBe(false);
    expect(samePath("/repo/.git/../.git/index.lock", "/repo/.git/index.lock", "linux")).toBe(true);
  });

  it("recognises the temporary index of git commit --only, and nothing else", () => {
    const lock = "C:/Repo/.git/worktrees/ir-1/index.lock";

    expect(isOnlyCommitIndex("C:\\Repo\\.git\\worktrees\\ir-1\\next-index-4242.lock", lock, "win32")).toBe(true);
    expect(isOnlyCommitIndex("c:/repo/.git/worktrees/ir-1/INDEX.LOCK", lock, "win32")).toBe(false);
    expect(isOnlyCommitIndex("C:/Repo/.git/worktrees/ir-1/index", lock, "win32")).toBe(false);
    expect(isOnlyCommitIndex("/repo/.git/next-index-7.lock", "/repo/.git/index.lock", "linux")).toBe(true);
    expect(isOnlyCommitIndex("/repo/.git/index", "/repo/.git/index.lock", "linux")).toBe(false);
  });
});

describe("createRepoFormatter on this repository", { timeout: 60_000 }, () => {
  const format = createRepoFormatter(repoRoot);
  const file = (filePath, text) => ({ path: filePath, text, tools: toolsFor(filePath) });

  it("fixes a .ts file with ESLint and Prettier", async () => {
    const source = "export function probe(x: number): number {\n  const doubled =    x * 2;\n  return doubled;\n}\n";
    const result = await format([file("packages/fetch-utils/src/format-staged-probe.ts", source)]);

    expect(result.failure).toBeNull();
    expect(result.outputs).toEqual([
      "export function probe(x: number): number {\n  const doubled = x * 2;\n\n  return doubled;\n}\n",
    ]);
  });

  it("reports an error ESLint cannot fix, naming the file", async () => {
    const result = await format([
      file("packages/fetch-utils/src/format-staged-probe.ts", "const unused = 1;\n\nexport const used = 2;\n"),
    ]);

    expect(result.failure).toContain("@typescript-eslint/no-unused-vars");
    expect(result.failure).toContain("format-staged-probe.ts");
  });

  it("formats .json with Prettier alone", async () => {
    const result = await format([file("packages/fetch-utils/format-staged-probe.json", '{"a":1,\n"b":[1,2]}')]);

    expect(result.failure).toBeNull();
    expect(result.outputs).toEqual(['{ "a": 1, "b": [1, 2] }\n']);
  });

  it("returns ignored paths unchanged", async () => {
    const messy = "const unused =    1;\nexport const used = 2;\n";
    const json = '{"a":1}';
    const result = await format([
      file("packages/fetch-utils/dist/format-staged-probe.ts", messy),
      file("packages/audio-assets/generate.config.json", json),
      file("node_modules/format-staged-probe/package.json", json),
    ]);

    expect(result.failure).toBeNull();
    expect(result.outputs).toEqual([messy, json, json]);
  });
});
