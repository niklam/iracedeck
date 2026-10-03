/**
 * The line check the merge gate falls back to for files a rebase conflicted
 * in (#1307).
 *
 * The gate's real test is a replay: the reviewed change re-applied onto the
 * head's base must give the head's exact tree (`replayRebase` in `lib.mjs`).
 * A file the replay reported as conflicted cannot match, since the replay
 * holds conflict markers where the head holds a resolution. For those files
 * this compares the added and removed lines of the two changes, each against
 * its own merge-base. It cannot see WHERE a line sits — hunk headers are
 * dropped, because a rebase shifts them — so a match is never a pass on its
 * own: the gate asks the maintainer to confirm. The design is in
 * `docs/superpowers/specs/2026-10-03-issue-1307-merge-gate-pure-rebase.md`.
 *
 * Pure. Input is the text of plumbing
 * `git diff-tree -p --no-renames --full-index -U0 <base> <commit> -- <paths>`,
 * decoded byte-for-byte (latin1), so no byte is lost or merged in decoding.
 */

/**
 * Parse that diff into `Map<header, string[]>`: per `diff --git` header, its
 * lines minus the `@@` hunk headers, and minus the `index` line unless the
 * file is binary (a binary file has no lines to compare, so its post-image
 * blob id is its content). Keyed by the WHOLE header, which is unique per
 * path — parsing a path out of it is ambiguous for a path containing ` b/`.
 * A header that repeats (git prints a typechange as a delete block plus a
 * create block for one path) appends to the same entry. Split on `\n` only:
 * git emits LF, and a CR is part of the file's bytes.
 */
export function parseChangeSignature(diffText) {
  const files = new Map();
  let lines = null;
  let index = null;
  let start = 0;
  const close = () => {
    if (lines && index !== null && lines.slice(start).some((l) => l.startsWith("Binary files ")))
      lines.splice(start + 1, 0, index);
  };
  const all = diffText.split("\n");
  if (all.at(-1) === "") all.pop();
  for (const line of all) {
    if (line.startsWith("diff --git ")) {
      close();
      lines = files.get(line) ?? [];
      start = lines.length;
      lines.push(line);
      index = null;
      files.set(line, lines);
    } else if (!lines || line.startsWith("@@")) {
      continue;
    } else if (line.startsWith("index ") && index === null) {
      index = line;
    } else {
      lines.push(line);
    }
  }
  close();
  return files;
}

/** The `diff --git` headers whose change differs between two signatures, sorted; `[]` means the lines match. */
export function changedFiles(a, b) {
  const out = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k);
    const y = b.get(k);
    if (!x || !y || x.length !== y.length || x.some((l, i) => l !== y[i])) out.push(k);
  }
  return out.sort();
}
