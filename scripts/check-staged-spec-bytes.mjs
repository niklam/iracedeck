/**
 * Refuses a commit that stages a spec carrying a raw control byte (#1466).
 * Run by the husky pre-commit hook, so it covers every local committer: a
 * terminal, an editor, and every Claude Code tool, not only the Bash tool the
 * spec-commit rule in `scripts/claude-hooks/rules-bash.mjs` sees.
 *
 * Why specs: a push to master that changes only spec Markdown starts no CI
 * run, so `scripts/no-control-bytes.test.mjs` would not see the byte until the
 * next code push, where it fails a change that never touched the spec. The
 * paths here match the workflows' `paths-ignore`.
 *
 * Reads the bytes from the index git is about to commit. A hook inherits
 * `GIT_INDEX_FILE`, so `git commit --only -- <paths>` and `-a` are judged on
 * the index they actually record.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import url from "node:url";

import { findControlBytes, hex } from "./lib/control-bytes.mjs";

const SPEC_DIR = "docs/superpowers/specs/";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

/** `file:line:column 0xNN` for every control byte in a staged spec. */
export function stagedSpecOffenders(cwd = process.cwd()) {
  const staged = git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR", "--", SPEC_DIR], cwd)
    .toString("utf8")
    .split("\0")
    .filter((file) => file.endsWith(".md"));
  const offenders = [];
  for (const file of staged) {
    for (const { line, column, byte } of findControlBytes(git(["show", `:${file}`], cwd))) {
      offenders.push(`${file}:${line}:${column} ${hex(byte)}`);
    }
  }
  return offenders;
}

// Real paths, as in format-staged.mjs: through a junction a bare href comparison is false and the check would pass silently.
if (process.argv[1] && realpathSync(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  const offenders = stagedSpecOffenders();
  if (offenders.length) {
    console.error(
      [
        "A staged spec carries a raw control byte. Write it as an escape (\\x00) instead (#1103);",
        "a spec-only push runs no CI, so nothing after this commit would catch it (#1466):",
        ...offenders.map((o) => `  ${o}`),
      ].join("\n"),
    );
    process.exit(1);
  }
}
