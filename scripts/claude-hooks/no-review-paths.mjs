/**
 * The files a PR may change and still skip CodeRabbit (#1648): Claude-facing
 * prose only. Such a PR is opened with `--label no-coderabbit`, nobody can
 * approve it, and it merges under `--admin`, which the merge gate in
 * `rules-bash.mjs` allows past a missing approval only when every file the PR
 * changes matches this list.
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
  "**/CLAUDE.md",
]);

/**
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
