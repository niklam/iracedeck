import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stagedSpecOffenders } from "./check-staged-spec-bytes.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-staged-spec-bytes.mjs");
const SPECS = "docs/superpowers/specs";

let repo;

function git(...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
}

function write(rel, bytes) {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), bytes);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ird-spec-bytes-"));
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("stagedSpecOffenders (#1466)", () => {
  it("reports a control byte in a staged spec with its position", () => {
    write(`${SPECS}/a.md`, Buffer.from("# T\nPK\x03\n", "latin1"));
    git("add", "-A");
    expect(stagedSpecOffenders(repo)).toEqual([`${SPECS}/a.md:2:3 0x03`]);
  });

  it("passes a clean spec, tab, CR and LF included", () => {
    write(`${SPECS}/a.md`, "# T\r\n\tx – ✓\n");
    git("add", "-A");
    expect(stagedSpecOffenders(repo)).toEqual([]);
  });

  it("reads the staged bytes, not the working copy", () => {
    write(`${SPECS}/a.md`, "# clean\n");
    git("add", "-A");
    write(`${SPECS}/a.md`, Buffer.from("# T\x00\n", "latin1"));
    expect(stagedSpecOffenders(repo)).toEqual([]);

    git("add", "-A");
    write(`${SPECS}/a.md`, "# clean again\n");
    expect(stagedSpecOffenders(repo)).toEqual([`${SPECS}/a.md:1:4 0x00`]);
  });

  it("checks an amended spec too", () => {
    write(`${SPECS}/a.md`, "# T\n");
    git("add", "-A");
    git("commit", "-q", "-m", "spec");
    write(`${SPECS}/a.md`, Buffer.from("# T\n\x0c\n", "latin1"));
    git("add", "-A");
    expect(stagedSpecOffenders(repo)).toEqual([`${SPECS}/a.md:2:1 0x0c`]);
  });

  it("leaves files outside specs, non-Markdown files and deletions to the rest of the gate", () => {
    write(`${SPECS}/gone.md`, "# T\n");
    git("add", "-A");
    git("commit", "-q", "-m", "spec");
    write("docs/other.md", Buffer.from("\x01", "latin1"));
    write(`${SPECS}/data.json`, Buffer.from("\x01", "latin1"));
    rmSync(join(repo, `${SPECS}/gone.md`));
    git("add", "-A");
    expect(stagedSpecOffenders(repo)).toEqual([]);
  });
});

describe("check-staged-spec-bytes.mjs as the pre-commit step", () => {
  const run = () => spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: "utf8" });

  it("exits 1 naming the offender", () => {
    write(`${SPECS}/a.md`, Buffer.from("\x7f", "latin1"));
    git("add", "-A");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${SPECS}/a.md:1:1 0x7f`);
  });

  it("exits 0 on a clean index", () => {
    write(`${SPECS}/a.md`, "# T\n");
    git("add", "-A");
    expect(run().status).toBe(0);
  });

  it("is what the husky pre-commit hook runs", () => {
    const hook = readFileSync(join(dirname(SCRIPT), "..", ".husky", "pre-commit"), "utf8");
    expect(hook).toMatch(/^node scripts\/check-staged-spec-bytes\.mjs$/m);
  });
});
