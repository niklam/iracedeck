/**
 * What a branch changes, reduced to what survives a rebase (#1307).
 *
 * The merge gate accepts a head whose change is identical to the commit
 * CodeRabbit last reviewed: file by file, the same added and removed lines.
 * A rebase shifts line numbers, changes the surrounding context and gives a
 * touched text file a new post-image blob, so those are dropped; everything
 * that says what the branch itself did is kept. The design and the rejected
 * alternatives are in
 * `docs/superpowers/specs/2026-10-03-issue-1307-merge-gate-pure-rebase.md`.
 *
 * Pure: the git side is `changeSignature` in `lib.mjs`, which feeds this the
 * text of `git diff --no-renames --full-index --unified=0 <merge-base> <sha>`.
 */

/**
 * Parse that diff into `Map<path, string[]>`: per file, its diff lines minus
 * the `@@` hunk headers, and minus the `index` line unless the file is binary
 * (a binary file has no lines to compare, so its post-image blob id is its
 * content). With `--unified=0` there are no context lines to drop.
 */
export function parseChangeSignature(diffText) {
  const files = new Map();
  let lines = null;
  let index = null;
  const close = () => {
    if (lines && index !== null && lines.some((l) => l.startsWith("Binary files "))) lines.splice(1, 0, index);
  };
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      close();
      lines = [line];
      index = null;
      files.set(pathOf(line), lines);
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

/** The `b/` path of a `diff --git a/<p> b/<p>` header (the same path under `--no-renames`). */
function pathOf(header) {
  const rest = header.slice("diff --git ".length);
  const at = rest.lastIndexOf(" b/");
  return at >= 0 ? rest.slice(at + 3) : rest;
}

/** The paths whose change differs between two signatures, sorted; `[]` means a pure rebase. */
export function changedFiles(a, b) {
  const out = [];
  for (const p of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(p);
    const y = b.get(p);
    if (!x || !y || x.length !== y.length || x.some((l, i) => l !== y[i])) out.push(p);
  }
  return out.sort();
}
