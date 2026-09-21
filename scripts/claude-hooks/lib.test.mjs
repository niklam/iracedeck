import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readIndexFile, SPEC_DIR, specFilenames } from "./lib.mjs";

let root;
const git = (...args) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, stdio: "pipe" });
const writeSpec = (name, text = "# spec\n") => {
  mkdirSync(join(root, SPEC_DIR), { recursive: true });
  writeFileSync(join(root, SPEC_DIR, name), text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ird-hooks-lib-"));
  git("init", "-q", "-b", "master");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// #1193 review: the worktree gate asks "is there a spec for #n on master?",
// and the local working tree answers a different question in both directions.
describe("specFilenames", () => {
  it("lists what origin/master carries, not what the working tree holds", () => {
    writeSpec("2026-01-01-issue-7-on-master.md");
    git("add", "-A");
    git("commit", "-qm", "spec");
    git("update-ref", "refs/remotes/origin/master", "HEAD");
    // A spec pushed to master that this checkout has not pulled is modelled by
    // deleting the file locally; one written here and never committed, by adding one.
    unlinkSync(join(root, SPEC_DIR, "2026-01-01-issue-7-on-master.md"));
    writeSpec("2026-01-02-issue-8-uncommitted.md");
    expect(specFilenames(root)).toEqual(["2026-01-01-issue-7-on-master.md"]);
  });

  it("falls back to the working tree when there is no origin/master to ask", () => {
    writeSpec("2026-01-02-issue-8-local.md");
    expect(specFilenames(root)).toEqual(["2026-01-02-issue-8-local.md"]);
  });

  it("is empty — the side that asks — when neither can answer", () => {
    expect(specFilenames(root)).toEqual([]);
  });
});

// #1193 review (CodeRabbit): a plain commit takes the STAGED bytes.
describe("readIndexFile", () => {
  const rel = `${SPEC_DIR}2026-01-01-issue-7-a.md`;
  it("returns what is staged, not the edit made after staging", () => {
    writeSpec("2026-01-01-issue-7-a.md", "staged\n");
    git("add", "-A");
    writeSpec("2026-01-01-issue-7-a.md", "edited\n");
    expect(readIndexFile(root, rel)).toBe("staged\n");
  });

  it("is undefined — the side that passes — for a path the index does not hold", () => {
    writeSpec("2026-01-01-issue-7-a.md");
    expect(readIndexFile(root, rel)).toBeUndefined();
  });
});
