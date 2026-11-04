/**
 * The workspace packages, as git tracks them (#1375).
 *
 * A directory under `packages/` is a package only when it has a tracked
 * `package.json`. Listing the directories instead picks up a leftover one — a
 * removed package whose untracked `node_modules` survived a branch switch — and
 * fails a guard locally that CI, on a clean checkout, never sees.
 */
import { execFileSync } from "node:child_process";

/**
 * The directory names under `packages/` that hold a git-tracked `package.json`,
 * sorted.
 *
 * @param {string} root The repository root.
 * @returns {string[]}
 */
export function trackedPackageDirs(root) {
  return (
    execFileSync("git", ["ls-files", "packages/*/package.json"], { cwd: root, encoding: "utf-8" })
      .split("\n")
      // git's `*` crosses `/`, so keep only a package root's own manifest, not a nested fixture's.
      .filter((file) => file.split("/").length === 3)
      .map((file) => file.split("/")[1])
      .sort()
  );
}
