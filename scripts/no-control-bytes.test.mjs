import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
//
// The scan is keyed on a list of BINARY extensions, never on a list of text
// ones, and never on git's own binary detection — the file this exists for was
// exactly one git had already decided was binary. A new binary type therefore
// fails here naming the file, and is added to the list below; a new text type
// is scanned without anyone having to remember it.
const BINARY_EXTENSIONS = new Set([
  ".ico",
  ".mp3",
  ".png",
  ".psd",
  ".streamdeckprofile", // a zip archive
  ".ttf",
  ".wav",
]);

/**
 * Every control byte in `buffer` other than tab, LF and CR, as 1-based
 * line/column positions.
 */
function findControlBytes(buffer) {
  const found = [];
  let line = 1;
  let column = 1;

  for (const byte of buffer) {
    if (byte === 0x0a) {
      line += 1;
      column = 1;
      continue;
    }

    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0d) || byte === 0x7f) {
      found.push({ line, column, byte });
    }

    column += 1;
  }

  return found;
}

/** Tracked files plus untracked, non-ignored ones, so a new file is caught before it is staged. */
function listRepoFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  return [...new Set(out.split("\0").filter(Boolean))];
}

function hex(byte) {
  return `0x${byte.toString(16).padStart(2, "0")}`;
}

describe("findControlBytes", () => {
  it("allows tab, LF and CR", () => {
    expect(findControlBytes(Buffer.from("a\tb\r\nc\n"))).toEqual([]);
  });

  it("reports NUL, the other C0 bytes and DEL with their position", () => {
    const buffer = Buffer.from([0x61, 0x00, 0x0a, 0x62, 0x63, 0x03, 0x1f, 0x0a, 0x7f]);

    expect(findControlBytes(buffer)).toEqual([
      { line: 1, column: 2, byte: 0x00 },
      { line: 2, column: 3, byte: 0x03 },
      { line: 2, column: 4, byte: 0x1f },
      { line: 3, column: 1, byte: 0x7f },
    ]);
  });

  it("does not report the bytes of a multi-byte UTF-8 character", () => {
    expect(findControlBytes(Buffer.from("– “é” ✓", "utf8"))).toEqual([]);
  });
});

describe("no raw control bytes in the repo's text files (#1103)", () => {
  const files = listRepoFiles().filter((file) => existsSync(join(repoRoot, file)));
  const textFiles = files.filter((file) => !BINARY_EXTENSIONS.has(extname(file).toLowerCase()));

  it("scans the files it exists for", () => {
    // Positive control: an empty or mis-rooted listing would pass the check below vacuously.
    expect(textFiles.length).toBeGreaterThan(1000);
    expect(textFiles).toContain("scripts/no-control-bytes.test.mjs");
    // Where the #1103 rule lives since #1250, written with escapes.
    expect(textFiles).toContain("packages/callout-script/src/voice-pack.ts");
  });

  it("finds none", () => {
    const offenders = [];

    for (const file of textFiles) {
      for (const { line, column, byte } of findControlBytes(readFileSync(join(repoRoot, file)))) {
        offenders.push(`${file}:${line}:${column} ${hex(byte)}`);
      }
    }

    // A binary file listed here needs its extension added to BINARY_EXTENSIONS;
    // a text file needs the byte written as an escape sequence.
    expect(offenders).toEqual([]);
  });
});
