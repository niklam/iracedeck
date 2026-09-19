/**
 * The Rollup log policy the three plugin builds share (#1176), wired into each
 * `packages/iracing-plugin-*\/rollup.config.mjs` as `onLog: pluginBuildOnLog`.
 *
 * Three rules, each narrow on purpose — everything they do not name reaches
 * Rollup's default handler unchanged:
 *
 * 1. **Drop `INVALID_ANNOTATION` from inside zod.** Since 4.5.4 (still true in
 *    4.6.x), zod carries two comments that mention `@__PURE__` in prose
 *    (`v4/core/util.js`, `v4/core/regexes.js`). Rollup reads any comment containing that token as an
 *    annotation, finds it in a position where none can apply, removes it and
 *    logs a warning — six per build. The bundles are unaffected: the real
 *    `/*@__PURE__*\/` annotations on the following lines are separate comments.
 *    The same code from our own sources or any other dependency still prints,
 *    and `rollup-logs.test.mjs` fails once zod stops carrying the comments, so
 *    this rule is removed rather than outliving its reason.
 * 2. **Drop `CIRCULAR_DEPENDENCY` that runs through zod or semver** — their
 *    internal cycles, which the configs have always silenced.
 * 3. **Fail the build on `CIRCULAR_DEPENDENCY` among workspace sources only.**
 *    A cycle whose every module is ours is ours to break, and a warning nobody
 *    reads is how the deck-core `sdk-singleton` → `window-focus-service` →
 *    `app-monitor` cycle sat on `master` unnoticed. A cycle that touches any
 *    other dependency still prints as a warning.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: this file lives in `scripts/lib/`. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Packages whose `INVALID_ANNOTATION` logs are dropped — see rule 1. */
export const ANNOTATION_NOISE_PACKAGES = ["zod"];

/** Packages whose internal cycles are dropped — see rule 2. */
export const CYCLE_NOISE_PACKAGES = ["zod", "semver"];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a module id lies inside an installed package's own directory, with
 * either path separator. Matches `…/node_modules/zod/…` but never
 * `…/node_modules/zod-extra/…` or a workspace folder that happens to be named
 * after the package.
 *
 * @param {unknown} id A Rollup module id.
 * @param {string} packageName `zod`, or a scoped `@scope/name`.
 */
export function isInsidePackage(id, packageName) {
  if (typeof id !== "string") return false;
  const name = packageName.split("/").map(escapeRegExp).join("[\\\\/]");
  return new RegExp(`[\\\\/]node_modules[\\\\/]${name}[\\\\/]`).test(id);
}

/**
 * Whether a module id is one of the repository's own sources: a real file
 * inside the repo root and outside every `node_modules`. Virtual ids (`\0…`,
 * the commonjs plugin's helpers and proxies) are not — they are no one's
 * source file, so a cycle through one is not provably ours.
 *
 * @param {unknown} id A Rollup module id.
 * @param {string} [repoRoot] Defaults to this repository.
 */
export function isWorkspaceSource(id, repoRoot = REPO_ROOT) {
  if (typeof id !== "string" || id === "" || id.startsWith("\0")) return false;
  if (/[\\/]node_modules[\\/]/.test(id)) return false;
  if (!path.isAbsolute(id)) return false;
  const relative = path.relative(repoRoot, id);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const WORKSPACE_CYCLE_HINT =
  "Every module in this cycle is a workspace source, so the plugin builds fail on it rather than warn " +
  "(#1176). Break it — inject the function across the seam instead of importing it — rather than " +
  "suppressing the log. See .claude/rules/plugin-structure.md.";

/**
 * Rollup `onLog` for the plugin builds. Signature and semantics are Rollup's:
 * returning without calling `handler` drops the log, `handler("error", log)`
 * fails the build, and `handler(level, log)` is the default behaviour.
 *
 * @param {import("rollup").LogLevel} level
 * @param {import("rollup").RollupLog} log
 * @param {(level: import("rollup").LogLevel | "error", log: import("rollup").RollupLog) => void} handler
 */
export function pluginBuildOnLog(level, log, handler) {
  if (level === "warn" && log.code === "INVALID_ANNOTATION") {
    if (ANNOTATION_NOISE_PACKAGES.some((pkg) => isInsidePackage(log.id, pkg))) return;
  }

  if (level === "warn" && log.code === "CIRCULAR_DEPENDENCY") {
    const ids = Array.isArray(log.ids) ? log.ids : [];
    if (ids.some((id) => CYCLE_NOISE_PACKAGES.some((pkg) => isInsidePackage(id, pkg)))) return;
    if (ids.length > 0 && ids.every((id) => isWorkspaceSource(id))) {
      handler("error", { ...log, message: `${log.message}\n${WORKSPACE_CYCLE_HINT}` });
      return;
    }
  }

  handler(level, log);
}
