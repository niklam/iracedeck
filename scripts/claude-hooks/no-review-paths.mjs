/**
 * The files a PR may change and still skip CodeRabbit (#1648): Claude-facing
 * prose only. Such a PR is opened with `--label no-coderabbit`, nobody can
 * approve it, and it merges under `--admin`, which the merge gate in
 * `rules-bash.mjs` lets through unasked only when every file the PR changes
 * matches this list, a skill's or agent's frontmatter unchanged, or Dependabot
 * wrote the whole PR. A `CLAUDE.md` counts only where the repo keeps
 * them, never at any depth: one under the website's content folder would be
 * published as a page.
 *
 * The one list: `.claude/rules/code-review.md` ("PRs that skip CodeRabbit")
 * states the same globs in prose, and `no-review-paths.test.mjs` fails when the
 * two differ, so widening it is an edit here plus that rule's sentence. Spec:
 * `docs/superpowers/specs/2026-11-07-issue-1648-no-coderabbit-admin-merge.md`.
 *
 * Pure: no git, no filesystem.
 */

/** Repo-relative globs, `/`-separated: `**` spans directories, `*` stays within one. */
export const NO_REVIEW_PATHS = Object.freeze([
  ".claude/rules/**/*.md",
  ".claude/skills/**/*.md",
  ".claude/agents/**/*.md",
  ".claude/CLAUDE.md",
  "packages/*/CLAUDE.md",
  "scripts/CLAUDE.md",
]);

/**
 * Not `path.matchesGlob`: its `**` does not cross a dot-segment
 * (`.claude/CLAUDE.md` fails), it takes no option to make it, it is
 * case-insensitive on Windows, and it accepts `..`, `.` and empty segments —
 * each a way for this list to match more than it says.
 *
 * A glob as an anchored, case-sensitive regular expression: `**` followed by
 * a slash matches zero or more directories, a trailing `/**` one or more path
 * segments below, `*` anything but a `/`, every other character itself.
 */
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length;) {
    if (glob.startsWith("**/", i)) {
      out += "(?:[^/]+/)*";
      i += 3;
    } else if (glob.startsWith("/**", i) && i + 3 === glob.length) {
      out += "/.+";
      i += 3;
    } else if (glob[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else {
      out += glob[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

const MATCHERS = NO_REVIEW_PATHS.map(globToRegExp);

/**
 * Whether `file`, a repo-relative path as git prints it, is on the list. A
 * path git would never print — absolute, backslash-separated, or with an
 * empty, `.` or `..` segment — is never on it, so `.claude/rules/../x.mjs`
 * cannot pass for prose: the gate fails closed on anything it cannot read as
 * one plain path.
 */
export function isNoReviewPath(file) {
  if (typeof file !== "string" || file === "" || file.includes("\\")) return false;
  if (file.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return MATCHERS.some((re) => re.test(file));
}

/**
 * Where a file's frontmatter is configuration rather than prose: a skill's or
 * an agent's (`tools`, `allowed-tools`, `hooks`, a permission mode). Such a
 * file stays on the list only while its frontmatter is unchanged
 * ({@link frontmatterChanged}); a rule's `paths` frontmatter only scopes when
 * it loads, and is not checked.
 */
export const CONFIG_FRONTMATTER_DIRS = Object.freeze([".claude/skills/", ".claude/agents/"]);

/** Whether `file`'s frontmatter is configuration (see {@link CONFIG_FRONTMATTER_DIRS}). */
export const hasConfigFrontmatter = (file) =>
  typeof file === "string" && CONFIG_FRONTMATTER_DIRS.some((dir) => file.startsWith(dir));

/**
 * The frontmatter block of a file's text, read wider than any loader reads it
 * so a change no loader would miss is never outside it: when the text, past
 * an optional byte-order mark and any leading whitespace, opens with `---`,
 * the block is everything from the first byte through the end of the next
 * line that opens with `---` — or the whole text when no such line follows.
 * Otherwise the block is empty. The text may be read as latin1, so the
 * comparison is byte for byte.
 */
export function frontmatterBlock(text) {
  const lead = /^(?:\uFEFF|\xEF\xBB\xBF)?\s*/.exec(text)[0].length;
  if (!text.startsWith("---", lead)) return "";
  const firstEnd = text.indexOf("\n", lead);
  if (firstEnd < 0) return text;
  // `m`, so `^` is any line's start; `[^\n]*` keeps a CR in the closing line, and the text may end there.
  const m = /^---[^\n]*(?:\n|(?![^]))/m.exec(text.slice(firstEnd + 1));
  return m ? text.slice(0, firstEnd + 1 + m.index + m[0].length) : text;
}

/**
 * Whether a file's frontmatter block differs between the merge-base text and
 * the head text — or either side is missing (`null` or `undefined`: the file
 * was added or deleted, or its text could not be read), which counts as a
 * change, so a new skill or agent is never prose alone.
 */
export function frontmatterChanged(baseText, headText) {
  if (typeof baseText !== "string" || typeof headText !== "string") return true;
  return frontmatterBlock(baseText) !== frontmatterBlock(headText);
}
