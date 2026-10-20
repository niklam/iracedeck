import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { findControlBytes, hex } from "./lib/control-bytes.mjs";

// scripts/no-control-bytes.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Guards one invariant (#1103): no text file in the repo carries a raw control
// byte. Tab, line feed and carriage return are ordinary whitespace and allowed;
// every other byte in 0x00–0x1f, and 0x7f, is not. Write it as an escape
// (`\x00`, `\u001f`) instead — the escape states the same thing without
// containing it.
//
// Why it is worth a test. A NUL byte makes git classify the whole file as
// binary, so `git diff`, `gh pr diff` and CodeRabbit show `Bin 5770 -> 5791
// bytes` and no content at all. That is what happened to
// `deck-core/src/voice-pack-manifest.ts`, whose "no control characters" label
// rule was a character class holding the literal bytes: every change to the
// file that defined the pack id and label rules shipped unreviewed. The other
// control bytes do not flip git's detection, but they are invisible in an
// editor, break copy-paste into a shell, and are one keystroke from a NUL.
// The PreToolUse hook (`checkEdit` in `scripts/claude-hooks/rules-tools.mjs`)
// stops the byte when it is typed; this guards the committed tree.
//
// Which files are binary is read from `.gitattributes` — the explicit `binary`
// attribute, never git's own content sniffing, since the file this exists for
// was exactly one git had already decided was binary. So there is one list of
// binary types in the repo, and a new binary type fails here naming the file
// until it is declared there; a new text type is scanned without anyone having
// to remember it. A single genuinely binary file of a text type (a vendored
// asset, say) is declared the same way, by path.
//
// Tracked files only: CI sees exactly those, and an untracked scratch file or
// a sibling worker's half-written one must not turn a local run red.

//
// A spec-only push to master runs no CI (#1466), so specs are also checked
// before they are committed: `scripts/check-staged-spec-bytes.mjs` from the
// husky pre-commit hook, and the spec-commit rule in Claude Code sessions.

function git(args, input) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
}

/** Tracked files that `.gitattributes` does not declare binary. */
function listTextFiles() {
  const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  // `-z` output: path NUL attribute NUL value NUL, per file.
  const attrs = git(["check-attr", "-z", "--stdin", "binary"], tracked.join("\0")).split("\0");
  const binary = new Set();

  for (let i = 0; i + 2 < attrs.length; i += 3) {
    if (attrs[i + 2] === "set") binary.add(attrs[i]);
  }

  // A tracked file deleted in the working tree is not there to read.
  return tracked.filter((file) => !binary.has(file) && existsSync(join(repoRoot, file)));
}

describe("no raw control bytes in the repo's text files (#1103)", () => {
  const textFiles = listTextFiles();

  it("scans the files it exists for", () => {
    // Positive control: an empty or mis-rooted listing, or a binary attribute
    // gone wide, would pass the check below vacuously.
    expect(textFiles.length).toBeGreaterThan(1000);
    expect(textFiles).toContain("scripts/no-control-bytes.test.mjs");
    expect(textFiles.filter((file) => /^packages\/[^/]+\/src\/.+\.ts$/.test(file)).length).toBeGreaterThan(500);
  });

  it("finds none", () => {
    const offenders = [];

    for (const file of textFiles) {
      for (const { line, column, byte } of findControlBytes(readFileSync(join(repoRoot, file)))) {
        offenders.push(`${file}:${line}:${column} ${hex(byte)}`);
      }
    }

    // A binary file listed here needs a `binary` line in .gitattributes (by
    // extension, or by path for a one-off); a text file needs the byte written
    // as an escape sequence.
    expect(offenders).toEqual([]);
  });
});
