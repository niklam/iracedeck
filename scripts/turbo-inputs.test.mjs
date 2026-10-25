import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { SHIPPED_FOLDERS } from "../packages/audio-assets/src/build/index.mjs";
import { SOURCES } from "../packages/plugin-build/src/plugin-rollup.mjs";

// Guards one invariant (#1491): every file a cached turbo task reads is hashed
// by that task, so a change to the file is a cache miss.
//
// Why it is worth a test rather than a convention. Turbo reuses a task's output
// while the hash of its declared inputs is unchanged, and by default that hash
// covers only the git-tracked files of the task's own package. A file read from
// anywhere else — the repo root, a sibling package that is not a dependency, or
// a file a narrowed `inputs` list leaves out — is invisible to it. Edit such a
// file and the next run replays the old output: the build is green, the bundle
// is stale, and nothing anywhere goes red. Once CI persists the cache (#1492)
// that is a false green on a PR. An audit found eight such reads at once, every
// one confirmed by editing the file and watching no task hash move.
//
// What turbo hashes, as this test models it (turbo 2.11, verified against
// `turbo run build typecheck --dry=json`):
//   * `globalDependencies` (repo-root globs) are in every task's hash.
//   * A task's `inputs` are globs relative to its package, or to the repo root
//     behind `$TURBO_ROOT$/`; `!` excludes; `$TURBO_DEFAULT$` stands for the
//     package's own files. Without `inputs` the default is the package's files.
//     A list WITHOUT `$TURBO_DEFAULT$` hashes only what it names (and the
//     package's package.json, which is always hashed).
//   * The default inputs skip gitignored files; an explicit glob does not, which
//     is how `$TURBO_ROOT$/feature-flags.local.json` is hashed. So a gitignored
//     file a task reads — a dependency's `dist/`, a generated JSON — is covered
//     only by an explicit input, or by being the `outputs` of a task in its
//     `dependsOn`, whose hash then stands for whatever produced it.
//   * A per-package entry (`@iracedeck/x#build`) REPLACES the generic `build`
//     task; it does not merge with it.
//   * A task's hash includes the hashes of the tasks in its `dependsOn`, so a
//     file is also covered when a task it (transitively) depends on hashes it.
//     That holds even for a package without the script: turbo still hashes its
//     `<NONEXISTENT>` task, which is how `iracing-actions#build` covers the
//     action sources the website and the plugins read.
//
// The checks: A, a tsconfig `extends` outside its package; B, every file
// reachable by import from what a task runs (its `node` scripts, Rollup and
// Astro configs) or compiles (its tsc program, the program Rollup bundles
// through, Astro's pages); C, a narrowed `inputs` list against the package's
// `exports`; D and E, the folders and files the plugin build copies by path
// rather than imports.
//
// What it does NOT see: a read through a computed path (`readFileSync` of a
// string built at runtime) other than the copy sources D and E check; a file
// a build reads through an npm package's own code; and an environment variable
// a build reads (`env`). Where its model and turbo differ it errs strict: `**`
// here does not match a dot-directory, while turbo's explicit globs hash such
// files too.

// scripts/turbo-inputs.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// The pseudo package name turbo gives the repo root, as in `//#generate:changelog-data`.
const ROOT = "//";

// Directories that never hold a project config worth checking.
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo"]);

// Tasks the import walk (check B) must find an entry point for. The walk finds
// its tasks from the package scripts, so this is not the list it checks — it is
// the floor under it: a parser change that quietly stopped recognising
// `rollup -c` would otherwise shrink check B to nothing while it stayed green.
const EXPECTED_WALKED_TASKS = [
  "//#generate:changelog-data",
  "@iracedeck/audio-assets#build",
  "@iracedeck/audio-native#build",
  "@iracedeck/iracing-native#build",
  "@iracedeck/iracing-plugin-mirabox#build",
  "@iracedeck/iracing-plugin-stream-deck#build",
  "@iracedeck/iracing-plugin-ulanzi#build",
  "@iracedeck/pi-components#build",
  "@iracedeck/website#build",
  "@iracedeck/website#typecheck",
];

// Gitignored files a task writes itself, in an earlier step of the same npm
// script, before a later step reads them. No hash has to cover such a file:
// the task's own inputs decide what the generator writes. Each entry names the
// generator — a script or config the task runs — and is checked to be
// gitignored, run by every task listed, and still read, so a stale entry fails
// rather than excusing something else.
const GENERATED_IN_SCRIPT = [
  {
    file: "packages/website/src/data/icon-gallery.json",
    generator: "packages/website/scripts/generate-icon-gallery.mts",
    why: "`pnpm generate:gallery`, the first step of both scripts, writes it",
    tasks: ["@iracedeck/website#build", "@iracedeck/website#typecheck"],
  },
  {
    file: "packages/website/.astro/types.d.ts",
    generator: "packages/website/astro.config.mjs",
    why: "`astro check` and `astro build` sync the project's types before they read them",
    tasks: ["@iracedeck/website#build", "@iracedeck/website#typecheck"],
  },
];

// Keys of the plugin factory's SOURCES that are not a file or folder the build
// reads, and why. Every other key is checked (E), so a source added there is
// checked without anyone remembering this test.
const SOURCES_NOT_READ = new Map([["repoRoot", "the anchor the other sources are joined onto, not itself read"]]);

// The three plugins whose build runs the shared factory (`rollup -c` over `createPluginRollupConfig`).
const PLUGIN_PACKAGES = [
  "@iracedeck/iracing-plugin-mirabox",
  "@iracedeck/iracing-plugin-stream-deck",
  "@iracedeck/iracing-plugin-ulanzi",
];

// Code a build runs or compiles is walked for its imports; anything else it
// imports (JSON, SVG, a `dist/` file) is recorded as read but not opened.
const CODE_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".astro", ".mdx"]);

// Node flags whose value is the next argument, so `node --import tsx gen.mjs`
// runs `gen.mjs` rather than a file named `tsx`.
const NODE_FLAGS_WITH_VALUE = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader"]);

// ---------------------------------------------------------------------------
// Paths and globs

const toPosix = (p) => p.replaceAll("\\", "/");
const repoRelative = (absPath) => toPosix(path.relative(repoRoot, absPath));
const isInside = (file, dir) => dir === "" || file === dir || file.startsWith(`${dir}/`);
const taskKey = (pkg, task) => `${pkg}#${task}`;

// Node's own matcher (stable in Node 24, no warning). Paths are repo-relative
// with forward slashes on every platform, so posix is the right flavour. It
// compiles the glob on every call, and the checks ask the same question for
// every task that reaches a file, so answers are memoised.
const globAnswers = new Map();
function globMatches(file, glob) {
  const key = `${glob}\0${file}`;
  let answer = globAnswers.get(key);
  if (answer === undefined) {
    answer = path.posix.matchesGlob(file, glob);
    globAnswers.set(key, answer);
  }
  return answer;
}

// A path that stands for "any file under this directory, including one added
// tomorrow". Inputs that list today's files one by one do not cover it, which is
// the point: a new file there would not be hashed.
const PROBE = "__turbo_inputs_probe__/probe.file";

// JSONC, like tsconfig and turbo.json allow: parse with TypeScript's own reader
// so this test accepts exactly what the tools do.
function readJsonc(absPath) {
  const { config, error } = ts.parseConfigFileTextToJson(absPath, readFileSync(absPath, "utf-8"));
  if (error) {
    const detail = ts.flattenDiagnosticMessageText(error.messageText, " ");
    throw new Error(`${absPath} is not valid JSON: ${detail}`);
  }
  return config ?? {};
}

// ---------------------------------------------------------------------------
// The turbo model. Every function from here to the checks is pure over the
// parsed turbo.json and the repo facts passed in (`repo`: the workspace, a
// gitignore lookup and the generated-in-script table), so a test can hand it
// a deliberately broken config or a made-up repo.

/** The config turbo uses for `task` in `pkg`: the per-package entry when there is one, else the generic task. */
function taskConfig(turbo, pkg, task) {
  const tasks = turbo.tasks ?? {};
  if (pkg === ROOT) return tasks[taskKey(ROOT, task)];
  return tasks[taskKey(pkg, task)] ?? tasks[task];
}

/** The turbo.json key that holds `pkg#task`'s config: its own entry, or the generic task it falls back to. */
function configKey(turbo, pkg, task) {
  return turbo.tasks?.[taskKey(pkg, task)] || pkg === ROOT ? taskKey(pkg, task) : task;
}

/**
 * Whether a list of turbo globs (task `inputs` or `outputs`, of a task in the
 * package at `pkgDir`) matches `file`. `$TURBO_DEFAULT$` is decided by
 * `matchesDefault`; `!` excludes whatever else matched.
 */
function globsCover(globs, pkgDir, file, matchesDefault) {
  let included = false;
  let excluded = false;
  for (const raw of globs) {
    const negated = raw.startsWith("!");
    const pattern = negated ? raw.slice(1) : raw;
    let hit;
    if (pattern === "$TURBO_DEFAULT$") {
      hit = matchesDefault(file);
    } else {
      const glob = pattern.startsWith("$TURBO_ROOT$/")
        ? pattern.slice("$TURBO_ROOT$/".length)
        : path.posix.join(pkgDir, pattern);
      hit = globMatches(file, glob);
    }
    if (hit && negated) excluded = true;
    if (hit && !negated) included = true;
  }
  return included && !excluded;
}

/** Whether `inputs` (of a task in the package at `pkgDir`) hash `file`. */
function inputsCover(inputs, pkgDir, file, repo) {
  if (file === (pkgDir ? `${pkgDir}/package.json` : "package.json")) return true;
  // The default inputs are the package's own files that git does not ignore.
  // The root package's own files are everything not inside a workspace package.
  const isDefaultInput = (f) =>
    (pkgDir === "" ? ![...repo.workspace.values()].some((p) => p.dir && isInside(f, p.dir)) : isInside(f, pkgDir)) &&
    !repo.isIgnored(f);
  if (inputs === undefined) return isDefaultInput(file);
  return globsCover(inputs, pkgDir, file, isDefaultInput);
}

/** Whether `outputs` (of a task in the package at `pkgDir`) include `file`. */
function outputsCover(outputs, pkgDir, file) {
  return globsCover(outputs ?? [], pkgDir, file, () => false);
}

/**
 * Every task whose hash ends up in `pkg#task`'s hash: the task itself and,
 * transitively, its `dependsOn`. `^x` is task x in each direct workspace
 * dependency; `p#x` names one task; a bare `x` is the same package's task x.
 */
function taskClosure(turbo, workspace, pkg, task) {
  // Memoised per config and workspace object: the checks ask for the same
  // closure once per file, tens of thousands of times.
  if (!closureCache.has(turbo)) closureCache.set(turbo, new WeakMap());
  if (!closureCache.get(turbo).has(workspace)) closureCache.get(turbo).set(workspace, new Map());
  const memo = closureCache.get(turbo).get(workspace);
  const memoKey = taskKey(pkg, task);
  if (memo.has(memoKey)) return memo.get(memoKey);
  const seen = new Map();
  const visit = (p, t) => {
    const key = taskKey(p, t);
    if (seen.has(key)) return;
    const config = taskConfig(turbo, p, t);
    seen.set(key, { pkg: p, task: t, dir: workspace.get(p)?.dir ?? "", config });
    for (const dep of config?.dependsOn ?? []) {
      if (dep.startsWith("^")) {
        for (const d of workspace.get(p)?.deps ?? []) visit(d, dep.slice(1));
      } else if (dep.includes("#")) {
        const at = dep.lastIndexOf("#");
        visit(dep.slice(0, at), dep.slice(at + 1));
      } else {
        visit(p, dep);
      }
    }
  };
  visit(pkg, task);
  const closure = [...seen.values()];
  memo.set(memoKey, closure);
  return closure;
}
const closureCache = new WeakMap();

/**
 * Whether a change to `file` changes the hash of `pkg#task`. A gitignored file
 * no input names is generated: it counts when a task the task depends on lists
 * it in its `outputs` (that task's hash covers what produced it), or when the
 * task's own script writes it first (GENERATED_IN_SCRIPT). The task's own
 * outputs do not count: reading them means reading the previous run's result.
 */
function isHashed(turbo, repo, pkg, task, file) {
  if ((turbo.globalDependencies ?? []).some((glob) => globMatches(file, glob))) return true;
  const closure = taskClosure(turbo, repo.workspace, pkg, task);
  if (closure.some(({ dir, config }) => inputsCover(config?.inputs, dir, file, repo))) return true;
  if (!repo.isIgnored(file)) return false;
  if (repo.generatedInScript.get(taskKey(pkg, task))?.has(file)) return true;
  return closure.some((t) => !(t.pkg === pkg && t.task === task) && outputsCover(t.config?.outputs, t.dir, file));
}

/** The files that stand for a directory: a probe for files yet to be added, and each tracked file under it. */
function filesOfDirectory(dir, tracked) {
  return [`${dir}/${PROBE}`, ...tracked.filter((f) => isInside(f, dir))];
}

/** The `inputs` entry that would hash `file` for a task of the package at `pkgDir`. */
function inputEntryFor(file, pkgDir) {
  if (pkgDir === "") return file;
  return isInside(file, pkgDir) ? file.slice(pkgDir.length + 1) : `$TURBO_ROOT$/${file}`;
}

/** What to add, and where, so `pkg#task` hashes `file`. */
function fixFor(turbo, repo, pkg, task, file) {
  const dir = repo.workspace.get(pkg)?.dir ?? "";
  const key = taskKey(pkg, task);
  const entry = inputEntryFor(file, dir);
  const add = turbo.tasks?.[key]
    ? `add "${entry}" to the "inputs" of "${key}" in turbo.json`
    : `add a "${key}" entry to turbo.json with "inputs": ["$TURBO_DEFAULT$", "${entry}"] — it REPLACES the ` +
      `generic "${task}" task rather than merging, so copy that task's "dependsOn" and "outputs" into it`;
  if (!repo.isIgnored(file)) return add;
  return (
    `it is gitignored, so default inputs skip it — make "${key}" depend on the task whose "outputs" ` +
    `produce it, or ${add}`
  );
}

// ---------------------------------------------------------------------------
// The checks. Each returns a list of violations, one self-contained sentence
// apiece; an empty list is a pass.

/**
 * A. A tsconfig `extends` that leaves its package names a file no package task
 * hashes by default, and every build and typecheck reads it. It belongs in
 * `globalDependencies`: a task's `inputs` would not do, since each per-package
 * override replaces the generic task and would have to repeat it.
 */
function checkTsconfigExtends(turbo, tsconfigs) {
  const violations = [];
  for (const { file, pkgDir, extendsFiles } of tsconfigs) {
    for (const target of extendsFiles) {
      if (isInside(target, pkgDir)) continue;
      if ((turbo.globalDependencies ?? []).some((glob) => globMatches(target, glob))) continue;
      violations.push(
        `${file} extends ${target}, which no task hashes: add "${target}" to "globalDependencies" in turbo.json`,
      );
    }
  }
  return violations;
}

/**
 * B. Every file reachable by import from what a cached task runs (its scripts
 * and configs) or compiles (its tsc program, the program Rollup bundles
 * through, Astro's pages) is hashed by it. A compile counts: with `allowJs` tsc
 * infers types from an imported `.mjs`, so a changed helper can turn a cached
 * green typecheck red.
 */
function checkBuildReachableImports(turbo, repo, taskReads) {
  const violations = [];
  for (const { pkg, task, verb, reads } of taskReads) {
    for (const [file, via] of reads) {
      if (isHashed(turbo, repo, pkg, task, file)) continue;
      violations.push(
        `${pkg}#${task} ${verb} ${via.join(" -> ")}, which reads ${file}, but turbo does not hash it for that ` +
          `task: ${fixFor(turbo, repo, pkg, task, file)}`,
      );
    }
  }
  return violations;
}

/**
 * The tasks a dependent's hash takes from every dependency: each `x` named as
 * `^x` in some `dependsOn`. Here that is `build`. An explicit `pkg#x` (the
 * plugins' `audio-assets#stage:dev-voices`) is one named step, not the task
 * that stands for the package's contents, so it is left out. Nor is
 * `typecheck`: nothing depends on another package's typecheck, so narrowed
 * typecheck inputs are no business of the exports, and what a typecheck reads
 * itself is check B's.
 */
function upstreamTasks(turbo) {
  const names = new Set();
  for (const config of Object.values(turbo.tasks ?? {})) {
    for (const dep of config.dependsOn ?? []) {
      if (dep.startsWith("^")) names.add(dep.slice(1));
    }
  }
  return names;
}

/**
 * C. A task its dependents hash (`build`) whose inputs leave out
 * `$TURBO_DEFAULT$` hashes only what it names, yet those dependents read
 * whatever the package `exports`. Each export target must be among the inputs,
 * or a change to it is a cache hit for every dependent (#1491: `manifest.json`,
 * the bundled manifest and the catalog) — unless the target is a gitignored
 * file the task itself outputs (`dist/`), which its inputs produce.
 */
function checkNarrowedInputsCoverExports(turbo, repo, tracked) {
  const violations = [];
  for (const task of upstreamTasks(turbo)) {
    for (const [pkg, { dir, manifest }] of repo.workspace) {
      if (pkg === ROOT) continue;
      const config = taskConfig(turbo, pkg, task);
      const inputs = config?.inputs;
      if (!inputs || inputs.includes("$TURBO_DEFAULT$")) continue;
      const key = configKey(turbo, pkg, task);
      for (const target of exportTargets(manifest)) {
        for (const file of filesOfExportTarget(dir, target, tracked)) {
          if (inputsCover(inputs, dir, file, repo)) continue;
          if (repo.isIgnored(file) && outputsCover(config.outputs, dir, file)) continue;
          violations.push(
            `${pkg} exports "${target}", but the narrowed "inputs" of "${key}" do not hash ${file}, so its ` +
              `dependents keep a stale result when it changes: add a glob covering ` +
              `"${inputEntryFor(file, dir).replaceAll("__turbo_inputs_probe__", "*")}" to the "inputs" of "${key}" ` +
              `in turbo.json`,
          );
        }
      }
    }
  }
  return violations;
}

/** D. The folders the audio copy step ships into every plugin are hashed by `@iracedeck/audio-assets#build`. */
function checkShippedFolders(turbo, repo, shippedFolders, tracked) {
  const pkg = "@iracedeck/audio-assets";
  const { dir } = repo.workspace.get(pkg);
  const key = configKey(turbo, pkg, "build");
  const inputs = taskConfig(turbo, pkg, "build")?.inputs;
  const violations = [];
  for (const folder of shippedFolders) {
    const missed = filesOfDirectory(`${dir}/${folder}`, tracked).filter(
      (file) => !inputsCover(inputs, dir, file, repo),
    );
    if (missed.length === 0) continue;
    violations.push(
      `the plugin builds copy ${dir}/${folder}/ (SHIPPED_FOLDERS), but "${key}" does not hash ` +
        `${missed.slice(0, 3).join(", ")}${missed.length > 3 ? `, … (${missed.length} files)` : ""}: ` +
        `add "${folder}/**" to the "inputs" of "${key}" in turbo.json`,
    );
  }
  return violations;
}

/**
 * E. Every file and folder the plugin factory reads (its SOURCES) is hashed by
 * each plugin's build: inside the plugin, inside a dependency whose build
 * hashes it, or named in the plugin's own inputs.
 */
function checkPluginSources(turbo, repo, sources, plugins, tracked) {
  const violations = [];
  for (const pkg of plugins) {
    for (const { key, file, isDirectory } of sources) {
      const files = isDirectory ? filesOfDirectory(file, tracked) : [file];
      if (files.every((f) => isHashed(turbo, repo, pkg, "build", f))) continue;
      const entry = isDirectory ? `${file}/**` : file;
      violations.push(
        `${pkg}#build copies SOURCES.${key} (${entry}), but turbo does not hash it for that task: ` +
          fixFor(turbo, repo, pkg, "build", entry),
      );
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// package.json `exports`

/** Every file target an `exports` map (or `main` / `types`) names, all conditions included. */
function exportTargets(manifest) {
  const targets = new Set();
  const collect = (value) => {
    if (typeof value === "string") targets.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(manifest.exports);
  for (const field of ["main", "module", "types"]) {
    if (typeof manifest[field] === "string") targets.add(manifest[field]);
  }
  return [...targets].filter((t) => !t.endsWith("/"));
}

/**
 * The repo files an export target stands for. A `*` in a subpath pattern
 * matches any string, `/` included; a probe stands for a file added later.
 */
function filesOfExportTarget(pkgDir, target, tracked) {
  const file = path.posix.join(pkgDir, target);
  if (!file.includes("*")) return [file];
  const escaped = file.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`^${escaped.join(".+")}$`);
  return [file.replaceAll("*", "__turbo_inputs_probe__"), ...tracked.filter((f) => pattern.test(f))];
}

/** The file a workspace package specifier (`@iracedeck/x/sub`) resolves to, by its `exports`. */
function resolveWorkspaceSpecifier(specifier, workspace) {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const pkg = workspace.get(name);
  if (!pkg) return undefined;
  const rest = specifier.slice(name.length);
  const subpath = rest ? `.${rest}` : ".";
  const { exports: exp, main } = pkg.manifest;

  const pickCondition = (value) => {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return undefined;
    for (const condition of ["import", "node", "default", "require", "types"]) {
      const picked = pickCondition(value[condition]);
      if (picked) return picked;
    }
    return undefined;
  };

  let target;
  if (exp === undefined) {
    target = subpath === "." ? (main ?? "index.js") : subpath;
  } else if (typeof exp === "string" || !Object.keys(exp).some((k) => k.startsWith("."))) {
    target = subpath === "." ? pickCondition(exp) : undefined;
  } else if (subpath in exp) {
    target = pickCondition(exp[subpath]);
  } else {
    for (const [key, value] of Object.entries(exp)) {
      const star = key.indexOf("*");
      if (star < 0) continue;
      const [before, after] = [key.slice(0, star), key.slice(star + 1)];
      if (subpath.startsWith(before) && subpath.endsWith(after) && subpath.length > key.length - 1) {
        const matched = subpath.slice(before.length, subpath.length - after.length);
        target = pickCondition(value)?.replaceAll("*", matched);
        break;
      }
    }
  }
  return target === undefined ? undefined : path.posix.join(pkg.dir, target);
}

// ---------------------------------------------------------------------------
// Repo facts. Gathered once, independent of turbo.json.

function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
}

/**
 * Whether git ignores a path, asked in batches: `prime(paths)` answers many in
 * one `git check-ignore --stdin` call, and `isIgnored` asks for a path nothing
 * primed on its own. Tracked files are never ignored. The path need not exist,
 * which is what lets a `dist/` entry that is not built yet be recognised.
 */
function createIgnoreLookup(tracked) {
  const trackedSet = new Set(tracked);
  const known = new Map();
  const stats = { calls: 0 };
  const prime = (paths) => {
    const fresh = [...new Set(paths)].filter((p) => !trackedSet.has(p) && !known.has(p));
    if (fresh.length === 0) return;
    stats.calls += 1;
    const result = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
      cwd: repoRoot,
      encoding: "utf-8",
      input: `${fresh.join("\0")}\0`,
      maxBuffer: 64 * 1024 * 1024,
    });
    // Exit 1 means none of them is ignored; anything else is an error.
    if (result.status !== 0 && result.status !== 1) throw new Error(`git check-ignore failed: ${result.stderr}`);
    const ignored = new Set(result.stdout.split("\0").filter(Boolean));
    for (const p of fresh) known.set(p, ignored.has(p));
  };
  const isIgnored = (p) => {
    if (trackedSet.has(p)) return false;
    if (!known.has(p)) prime([p]);
    return known.get(p);
  };
  return { prime, isIgnored, stats };
}

/** Every workspace package, plus the root as `//`: name -> { dir, manifest, deps } (deps = workspace names). */
function loadWorkspace() {
  const manifests = [{ dir: "", manifest: JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8")) }];
  for (const entry of readdirSync(path.join(repoRoot, "packages"), { withFileTypes: true })) {
    const file = path.join(repoRoot, "packages", entry.name, "package.json");
    if (entry.isDirectory() && existsSync(file)) {
      manifests.push({ dir: `packages/${entry.name}`, manifest: JSON.parse(readFileSync(file, "utf-8")) });
    }
  }
  const names = new Set(manifests.slice(1).map(({ manifest }) => manifest.name));
  const workspace = new Map();
  for (const { dir, manifest } of manifests) {
    const declared = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((field) =>
      Object.keys(manifest[field] ?? {}),
    );
    workspace.set(dir === "" ? ROOT : manifest.name, {
      dir,
      manifest,
      deps: [...new Set(declared.filter((d) => names.has(d)))],
    });
  }
  return workspace;
}

function findTsconfigs(absDir) {
  const found = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...findTsconfigs(path.join(absDir, entry.name)));
    } else if (/^tsconfig.*\.json$/.test(entry.name)) {
      found.push(path.join(absDir, entry.name));
    }
  }
  return found;
}

/**
 * Every package tsconfig with the files its relative `extends` entries name.
 * A non-relative `extends` (`astro/tsconfigs/strict`) is an npm package, hashed
 * through the lockfile, and skipped.
 */
function loadTsconfigs() {
  return findTsconfigs(path.join(repoRoot, "packages"))
    .sort()
    .map((absPath) => {
      const config = readJsonc(absPath);
      const entries = Array.isArray(config.extends) ? config.extends : [config.extends];
      const extendsFiles = entries
        .filter((e) => typeof e === "string" && (e.startsWith("./") || e.startsWith("../")))
        .map((e) => repoRelative(path.resolve(path.dirname(absPath), e)));
      const file = repoRelative(absPath);
      return { file, pkgDir: file.split("/").slice(0, 2).join("/"), extendsFiles };
    });
}

/** The files a tsconfig's program compiles, as TypeScript itself computes them. */
function tsconfigProgram(absTsconfig) {
  const { config, error } = ts.readConfigFile(absTsconfig, ts.sys.readFile);
  if (error) throw new Error(`${absTsconfig}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`);
  return ts
    .parseJsonConfigFileContent(config, ts.sys, path.dirname(absTsconfig), undefined, absTsconfig)
    .fileNames.map(repoRelative);
}

/**
 * The tsconfigs a Rollup config compiles through: each `tsconfig*.json` it
 * names as a string (pi-components' one per bundle), else the package's
 * `tsconfig.json`, which `@rollup/plugin-typescript` finds by itself (the
 * plugins). The plugin type-checks that whole program, tests included, and
 * fails the build on an error (`noEmitOnError`, #987), so all of it is read.
 */
function rollupTsconfigs(configRel, pkgDir) {
  const text = readFileSync(path.join(repoRoot, configRel), "utf-8");
  const named = [...text.matchAll(/["'](?:\.\/)?(tsconfig[\w.-]*\.json)["']/g)].map((m) => m[1]);
  return [...new Set(named.length > 0 ? named : ["tsconfig.json"])].map((name) => path.posix.join(pkgDir, name));
}

/**
 * What one npm script reads, by the commands this repo uses: `entries`, the
 * files it RUNS (a `node` script, a Rollup or Astro config), and `programs`,
 * the files it COMPILES (a `tsc` program, the program Rollup bundles through,
 * the pages `astro` checks or bundles). A command it cannot read is returned
 * in `unrecognised`, which fails the coverage guard — a new kind of build step
 * has to be taught here rather than skipped. An entry that does not exist is
 * left for the walk, which reports it.
 */
function scriptReads(manifest, pkgDir, scriptName, tracked, depth = 0) {
  const result = { entries: [], programs: [], unrecognised: [] };
  const script = manifest.scripts?.[scriptName];
  if (script === undefined || depth > 5) return result;
  for (const segment of script.split("&&").map((s) => s.trim())) {
    const [command, ...args] = segment.split(/\s+/);
    const positional = args.filter((a, i) => !a.startsWith("-") && !NODE_FLAGS_WITH_VALUE.has(args[i - 1]));
    const firstExisting = (...candidates) =>
      candidates.map((c) => path.posix.join(pkgDir, c)).find((c) => existsSync(path.join(repoRoot, c)));
    const programOf = (tsconfigRel) => {
      if (existsSync(path.join(repoRoot, tsconfigRel))) return tsconfigProgram(path.join(repoRoot, tsconfigRel));
      result.unrecognised.push(`${segment} (no ${tsconfigRel})`);
      return [];
    };
    if (/["'`|;<>$]/.test(segment)) {
      result.unrecognised.push(segment);
    } else if (command === "tsc") {
      const project = args[args.findIndex((a) => a === "-p" || a === "--project") + 1];
      const tsconfig = args.includes("-p") || args.includes("--project") ? project : "tsconfig.json";
      result.programs.push(...programOf(path.posix.join(pkgDir, tsconfig)));
    } else if ((command === "node" || command === "tsx") && positional.length > 0) {
      result.entries.push(path.posix.join(pkgDir, positional[0]));
    } else if (command === "rollup" && (args.includes("-c") || args.includes("--config"))) {
      const explicit = args[args.findIndex((a) => a === "-c" || a === "--config") + 1];
      const config =
        explicit && !explicit.startsWith("-")
          ? path.posix.join(pkgDir, explicit)
          : firstExisting("rollup.config.mjs", "rollup.config.js", "rollup.config.ts");
      if (!config) {
        result.unrecognised.push(segment);
        continue;
      }
      result.entries.push(config);
      for (const tsconfig of rollupTsconfigs(config, pkgDir)) result.programs.push(...programOf(tsconfig));
    } else if (command === "astro" && ["build", "check"].includes(positional[0])) {
      const config = firstExisting("astro.config.mjs", "astro.config.ts", "astro.config.js");
      if (!config) {
        result.unrecognised.push(segment);
        continue;
      }
      // Astro checks (and bundles) the whole project: its tsconfig program plus
      // the .astro and .mdx files TypeScript does not list.
      result.entries.push(config);
      result.programs.push(
        ...programOf(path.posix.join(pkgDir, "tsconfig.json")),
        ...tracked.filter((f) => isInside(f, pkgDir) && /\.(astro|mdx)$/.test(f)),
      );
    } else if (command === "pnpm") {
      const target = positional[0] === "run" ? positional[1] : positional[0];
      if (target && manifest.scripts?.[target] !== undefined) {
        const nested = scriptReads(manifest, pkgDir, target, tracked, depth + 1);
        result.entries.push(...nested.entries);
        result.programs.push(...nested.programs);
        result.unrecognised.push(...nested.unrecognised);
      } else {
        result.unrecognised.push(segment);
      }
    } else {
      result.unrecognised.push(segment);
    }
  }
  return result;
}

/** Resolve a relative import the way the runtimes here do, `.js` written for a `.ts` source included. */
function resolveRelative(fromAbs, specifier) {
  const base = path.resolve(path.dirname(fromAbs), specifier.split("?")[0]);
  const candidates = [base];
  const swapped = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] }[path.extname(base)];
  for (const ext of swapped ?? []) candidates.push(base.slice(0, -path.extname(base).length) + ext);
  for (const ext of [".ts", ".mts", ".mjs", ".js", "/index.ts", "/index.mjs", "/index.js"]) candidates.push(base + ext);
  return repoRelative(candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? base);
}

/**
 * The repo files one file imports, resolved. Read with TypeScript's
 * preprocessor, so comments and strings are skipped exactly as the compiler
 * skips them, and static imports, re-exports, `import("…")` and `require("…")`
 * with a literal are all found. Bare specifiers are followed only into
 * workspace packages, through their `exports`; external packages are hashed
 * through the lockfile. A file is read once however many walks reach it.
 */
function createImportReader(workspace) {
  const cache = new Map();
  return (file) => {
    if (cache.has(file)) return cache.get(file);
    const abs = path.join(repoRoot, file);
    let targets = [];
    if (CODE_EXTENSIONS.has(path.extname(file)) && !file.endsWith(".d.ts") && existsSync(abs)) {
      targets = ts
        .preProcessFile(readFileSync(abs, "utf-8"), true, true)
        .importedFiles.map(({ fileName: specifier }) =>
          specifier.startsWith(".") ? resolveRelative(abs, specifier) : resolveWorkspaceSpecifier(specifier, workspace),
        )
        .filter((target) => target !== undefined);
    }
    cache.set(file, targets);
    return targets;
  };
}

/**
 * Every file reachable by import from `entries`, mapped to the chain that
 * reaches it, and the reached files that do not exist. A missing file is still
 * recorded as read: when git ignores it, it is generated (a `dist/` entry not
 * built yet, a JSON an earlier step writes) and the hash check decides; when
 * git does not, the walk resolved it wrongly or an entry is misnamed, and the
 * caller reports it.
 */
function walkImports(entries, readImports) {
  const reads = new Map();
  const missing = [];
  const queue = entries.map((entry) => ({ file: entry, via: [entry] }));
  for (let i = 0; i < queue.length; i++) {
    const { file, via } = queue[i];
    if (reads.has(file)) continue;
    reads.set(file, via);
    if (!existsSync(path.join(repoRoot, file))) {
      missing.push(file);
      continue;
    }
    for (const target of readImports(file)) {
      if (!reads.has(target)) queue.push({ file: target, via: [...via, target] });
    }
  }
  return { reads, missing };
}

/** The cached tasks turbo runs, per package that has the script: [{ pkg, task, entries, programs, unrecognised }]. */
function discoverTaskScripts(turbo, workspace, tracked) {
  const taskNames = new Set(Object.keys(turbo.tasks ?? {}).map((key) => key.slice(key.lastIndexOf("#") + 1)));
  const found = [];
  for (const [pkg, { dir, manifest }] of workspace) {
    for (const task of taskNames) {
      const config = taskConfig(turbo, pkg, task);
      if (!config || config.cache === false || config.persistent) continue;
      if (manifest.scripts?.[task] === undefined) continue;
      found.push({ pkg, task, ...scriptReads(manifest, dir, task, tracked) });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------

const turbo = readJsonc(path.join(repoRoot, "turbo.json"));
const tracked = trackedFiles();
const workspace = loadWorkspace();
const tsconfigs = loadTsconfigs();
const taskScripts = discoverTaskScripts(turbo, workspace, tracked);
const readImports = createImportReader(workspace);
const walked = taskScripts
  .filter(({ entries }) => entries.length > 0)
  .map(({ pkg, task, entries }) => ({ pkg, task, verb: "runs", ...walkImports(entries, readImports) }));
const compiled = taskScripts
  .filter(({ programs }) => programs.length > 0)
  .map(({ pkg, task, programs }) => ({ pkg, task, verb: "compiles", ...walkImports(programs, readImports) }));
const pluginSources = Object.entries(SOURCES)
  .filter(([key]) => !SOURCES_NOT_READ.has(key))
  .map(([key, absPath]) => ({
    key,
    file: repoRelative(absPath),
    isDirectory: existsSync(absPath) && statSync(absPath).isDirectory(),
  }));

// One batched gitignore lookup for every path the checks will ask about.
const ignore = createIgnoreLookup(tracked);
ignore.prime([
  ...[...walked, ...compiled].flatMap(({ reads }) => [...reads.keys()]),
  ...pluginSources.flatMap(({ file, isDirectory }) => (isDirectory ? [`${file}/${PROBE}`] : [file])),
  ...[...workspace.values()].flatMap(({ dir, manifest }) =>
    exportTargets(manifest).flatMap((target) => filesOfExportTarget(dir, target, tracked)),
  ),
  ...[...SHIPPED_FOLDERS].map((folder) => `${workspace.get("@iracedeck/audio-assets").dir}/${folder}/${PROBE}`),
  ...GENERATED_IN_SCRIPT.map(({ file }) => file),
]);
const generatedInScript = new Map();
for (const { file, tasks } of GENERATED_IN_SCRIPT) {
  for (const key of tasks) generatedInScript.set(key, new Set([...(generatedInScript.get(key) ?? []), file]));
}
const repo = { workspace, isIgnored: ignore.isIgnored, generatedInScript };

// A deliberately broken copy of the real config, for the positive controls.
function brokenConfig(mutate) {
  const copy = structuredClone(turbo);
  mutate(copy);
  return copy;
}
const withoutInput = (key, input) => (config) => {
  const inputs = config.tasks[key].inputs;
  const index = inputs.indexOf(input);
  if (index < 0) throw new Error(`positive control is stale: "${key}" has no input "${input}"`);
  inputs.splice(index, 1);
};

describe("turbo hashes every file a cached task reads (#1491)", () => {
  describe("the model of turbo's hashing", () => {
    const ws = new Map([
      [ROOT, { dir: "", deps: [] }],
      ["a", { dir: "packages/a", deps: ["b"] }],
      ["b", { dir: "packages/b", deps: [] }],
    ]);
    const ignored = new Set(["packages/a/local.json", "packages/b/dist/index.js", "packages/a/src/gen.json"]);
    const fake = { workspace: ws, isIgnored: (f) => ignored.has(f), generatedInScript: new Map() };

    it("reads default inputs as the package's own files", () => {
      expect(inputsCover(undefined, "packages/a", "packages/a/src/x.ts", fake)).toBe(true);
      expect(inputsCover(undefined, "packages/a", "packages/b/src/x.ts", fake)).toBe(false);
      expect(inputsCover(undefined, "", "scripts/x.mjs", fake)).toBe(true);
      expect(inputsCover(undefined, "", "packages/a/x.mjs", fake)).toBe(false);
    });

    it("reads narrowed inputs, $TURBO_ROOT$, $TURBO_DEFAULT$ and negations", () => {
      const inputs = ["src/*.mjs", "!src/*.test.*", "$TURBO_ROOT$/LICENSE"];
      expect(inputsCover(inputs, "packages/a", "packages/a/src/x.mjs", fake)).toBe(true);
      expect(inputsCover(inputs, "packages/a", "packages/a/src/x.test.mjs", fake)).toBe(false);
      expect(inputsCover(inputs, "packages/a", "packages/a/other.mjs", fake)).toBe(false);
      expect(inputsCover(inputs, "packages/a", "packages/a/package.json", fake)).toBe(true);
      expect(inputsCover(inputs, "packages/a", "LICENSE", fake)).toBe(true);
      expect(inputsCover(["$TURBO_DEFAULT$"], "packages/a", "packages/a/other.mjs", fake)).toBe(true);
    });

    it("leaves gitignored files out of the default inputs, but not out of an explicit glob", () => {
      expect(inputsCover(undefined, "packages/a", "packages/a/local.json", fake)).toBe(false);
      expect(inputsCover(["$TURBO_DEFAULT$"], "packages/a", "packages/a/local.json", fake)).toBe(false);
      expect(inputsCover(["$TURBO_DEFAULT$", "local.json"], "packages/a", "packages/a/local.json", fake)).toBe(true);
    });

    it("counts a gitignored file a dependency outputs, or the task's own script generates", () => {
      const withOutputs = { tasks: { build: { dependsOn: ["^build"], outputs: ["dist/**"] } } };
      expect(isHashed(withOutputs, fake, "a", "build", "packages/b/dist/index.js")).toBe(true);
      expect(
        isHashed({ tasks: { build: { dependsOn: ["^build"] } } }, fake, "a", "build", "packages/b/dist/index.js"),
      ).toBe(false);
      // Its own outputs are the previous run's result, not something a hash covers.
      expect(isHashed(withOutputs, fake, "b", "build", "packages/b/dist/index.js")).toBe(false);

      expect(isHashed(withOutputs, fake, "a", "build", "packages/a/src/gen.json")).toBe(false);
      const generated = { ...fake, generatedInScript: new Map([["a#build", new Set(["packages/a/src/gen.json"])]]) };
      expect(isHashed(withOutputs, generated, "a", "build", "packages/a/src/gen.json")).toBe(true);
    });

    it("follows dependsOn into the dependencies' tasks, and a per-package entry replaces the generic one", () => {
      const config = {
        tasks: { build: { dependsOn: ["^build"] }, "b#build": { inputs: ["src/**"] } },
      };
      expect(isHashed(config, fake, "a", "build", "packages/b/src/x.ts")).toBe(true);
      expect(isHashed(config, fake, "a", "build", "packages/b/README.md")).toBe(false);
      expect(isHashed({ tasks: { build: {} } }, fake, "a", "build", "packages/b/src/x.ts")).toBe(false);
    });

    it("resolves workspace specifiers through exports, patterns included", () => {
      expect(resolveWorkspaceSpecifier("@iracedeck/audio-assets/build", workspace)).toBe(
        "packages/audio-assets/src/build/index.mjs",
      );
      expect(resolveWorkspaceSpecifier("@iracedeck/audio-assets/catalog/default.json", workspace)).toBe(
        "packages/audio-assets/catalog/default.json",
      );
      expect(resolveWorkspaceSpecifier("@rollup/plugin-json", workspace)).toBeUndefined();
    });

    it("reads the script a node flag's value would otherwise hide", () => {
      const manifest = { scripts: { build: "node --import tsx scripts/gen.mjs --out x" } };
      expect(scriptReads(manifest, "packages/a", "build", []).entries).toEqual(["packages/a/scripts/gen.mjs"]);
    });

    it("reports an entry that does not exist instead of counting it as read", () => {
      const { reads, missing } = walkImports(["packages/a/scripts/no-such-file.mjs"], () => []);
      expect(missing).toEqual(["packages/a/scripts/no-such-file.mjs"]);
      expect(reads.has("packages/a/scripts/no-such-file.mjs")).toBe(true);
    });

    it("answers the gitignore questions from a batched lookup", () => {
      expect(repo.isIgnored("packages/app-constants/dist/index.js")).toBe(true);
      expect(repo.isIgnored("packages/app-constants/package.json")).toBe(false);
      expect(ignore.stats.calls).toBeLessThan(5);
    });
  });

  describe("A. tsconfig extends", () => {
    // Coverage guard: discovery must find the package tsconfigs that leave their package.
    it("finds the tsconfigs that extend a file outside their package", () => {
      const leaving = tsconfigs.filter(({ pkgDir, extendsFiles }) => extendsFiles.some((f) => !isInside(f, pkgDir)));
      expect(leaving.length, "tsconfig discovery found almost nothing to check; it has broken").toBeGreaterThan(30);
    });

    it("every extended file outside its package is a global dependency", () => {
      const violations = checkTsconfigExtends(turbo, tsconfigs);
      expect(violations, violations.join("\n")).toEqual([]);
    });

    it("positive control: reports every tsconfig when globalDependencies is gone", () => {
      const violations = checkTsconfigExtends(
        brokenConfig((c) => delete c.globalDependencies),
        tsconfigs,
      );
      expect(violations.length).toBeGreaterThan(30);
      expect(violations[0]).toContain('add "tsconfig.base.json" to "globalDependencies"');
    });
  });

  describe("B. imports reachable from what a build runs or compiles", () => {
    // Coverage guard: every script segment of a cached task is understood, and
    // the floor of known script-running tasks is all discovered.
    it("reads every command in the scripts of cached tasks", () => {
      const unrecognised = taskScripts.flatMap(({ pkg, task, unrecognised: u }) =>
        u.map((segment) => `${pkg}#${task}: ${segment}`),
      );
      expect(
        unrecognised,
        `these build steps are not understood by scripts/turbo-inputs.test.mjs, so the files they read are not ` +
          `checked: ${unrecognised.join("; ")}. Teach scriptReads() the command.`,
      ).toEqual([]);
    });

    it("walks every task known to run repo code", () => {
      const discovered = new Set(walked.map(({ pkg, task }) => taskKey(pkg, task)));
      const missing = EXPECTED_WALKED_TASKS.filter((key) => !discovered.has(key));
      expect(missing, `the import walk lost these tasks: ${missing.join(", ")}`).toEqual([]);
    });

    it("compiles a program for every typecheck task and every Rollup build", () => {
      const compiledKeys = new Set(compiled.map(({ pkg, task }) => taskKey(pkg, task)));
      const expected = [
        ...taskScripts.filter(({ task }) => task === "typecheck").map(({ pkg, task }) => taskKey(pkg, task)),
        ...PLUGIN_PACKAGES.map((pkg) => taskKey(pkg, "build")),
        "@iracedeck/pi-components#build",
      ];
      const missing = expected.filter((key) => !compiledKeys.has(key));
      expect(missing, `no program was found for: ${missing.join(", ")}`).toEqual([]);
      expect(compiled.length).toBeGreaterThan(40);
    });

    it("finds every file it reaches, or knows it is generated", () => {
      const unresolved = [...walked, ...compiled].flatMap(({ pkg, task, reads, missing }) =>
        missing
          .filter((file) => !repo.isIgnored(file))
          .map((file) => `${pkg}#${task}: ${reads.get(file).join(" -> ")}`),
      );
      expect(
        [...new Set(unresolved)],
        `these entries or imports name a file that does not exist and is not gitignored, so what they read ` +
          `is not checked: ${unresolved.join("; ")}`,
      ).toEqual([]);
    });

    // Coverage guard for GENERATED_IN_SCRIPT: every entry still describes something true.
    it.each(GENERATED_IN_SCRIPT.flatMap(({ file, generator, tasks }) => tasks.map((key) => [key, file, generator])))(
      "%s generates %s itself",
      (key, file, generator) => {
        expect(repo.isIgnored(file), `${file} is not gitignored, so default inputs hash it`).toBe(true);
        const script = taskScripts.find(({ pkg, task }) => taskKey(pkg, task) === key);
        expect(script?.entries, `${key} no longer runs ${generator}`).toContain(generator);
        const reached = [...walked, ...compiled].some((w) => taskKey(w.pkg, w.task) === key && w.reads.has(file));
        expect(reached, `${key} no longer reads ${file}; drop it from GENERATED_IN_SCRIPT`).toBe(true);
      },
    );

    it("every file reached from what a task runs is hashed by it", () => {
      const violations = checkBuildReachableImports(turbo, repo, walked);
      expect(violations, violations.join("\n")).toEqual([]);
    });

    it("every file reached from what a task compiles is hashed by it", () => {
      const violations = checkBuildReachableImports(turbo, repo, compiled);
      expect(violations, violations.join("\n")).toEqual([]);
    });

    it("positive control: reports a scripts/lib helper a plugin build runs", () => {
      const key = "@iracedeck/iracing-plugin-mirabox#build";
      const violations = checkBuildReachableImports(
        brokenConfig(withoutInput(key, "$TURBO_ROOT$/scripts/lib/rollup-logs.mjs")),
        repo,
        walked,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(`${key} runs`);
      expect(violations[0]).toContain('add "$TURBO_ROOT$/scripts/lib/rollup-logs.mjs" to the "inputs" of');
    });

    it("positive control: reports the changelog helpers astro.config.mjs loads", () => {
      const key = "@iracedeck/website#typecheck";
      const violations = checkBuildReachableImports(
        brokenConfig(withoutInput(key, "$TURBO_ROOT$/scripts/lib/changelog-*.mjs")),
        repo,
        walked,
      );
      const reported = violations.filter((v) => v.startsWith(`${key} runs packages/website/astro.config.mjs`));
      expect(reported.some((v) => v.includes("reads scripts/lib/changelog-fragments.mjs"))).toBe(true);
    });

    it("positive control: reports a scripts/lib helper a typecheck compiles", () => {
      const key = "@iracedeck/plugin-build#typecheck";
      const violations = checkBuildReachableImports(
        brokenConfig(withoutInput(key, "$TURBO_ROOT$/scripts/lib/rollup-logs.mjs")),
        repo,
        compiled,
      );
      const reported = violations.filter((v) => v.startsWith(`${key} compiles`));
      expect(reported.length).toBeGreaterThan(0);
      expect(reported.every((v) => v.includes("reads scripts/lib/rollup-logs.mjs"))).toBe(true);
    });

    it("positive control: reports a dependency's dist/ once no task outputs it", () => {
      const violations = checkBuildReachableImports(
        brokenConfig((c) => {
          c.tasks.build.outputs = c.tasks.build.outputs.filter((glob) => glob !== "dist/**");
        }),
        repo,
        compiled,
      );
      const reported = violations.filter(
        (v) =>
          v.startsWith("@iracedeck/iracing-plugin-mirabox#build compiles") && /reads packages\/[\w-]+\/dist\//.test(v),
      );
      expect(reported.length).toBeGreaterThan(0);
      expect(reported[0]).toContain("it is gitignored, so default inputs skip it");
    });

    it("positive control: reports the icon gallery once it is not known to be generated in-script", () => {
      const violations = checkBuildReachableImports(turbo, { ...repo, generatedInScript: new Map() }, compiled);
      const reported = violations.filter((v) => v.includes("reads packages/website/src/data/icon-gallery.json"));
      expect(new Set(reported.map((v) => v.split(" ")[0]))).toEqual(
        new Set(["@iracedeck/website#build", "@iracedeck/website#typecheck"]),
      );
    });
  });

  describe("C. narrowed inputs cover the package's exports", () => {
    it("checks the task dependents hash, and the one narrowed build task, audio-assets", () => {
      expect([...upstreamTasks(turbo)]).toEqual(["build"]);
      expect(turbo.tasks["@iracedeck/audio-assets#build"].inputs).not.toContain("$TURBO_DEFAULT$");
    });

    it("every export target of a narrowed build task is among its inputs", () => {
      const violations = checkNarrowedInputsCoverExports(turbo, repo, tracked);
      expect(violations, violations.join("\n")).toEqual([]);
    });

    it("positive control: reports manifest.json and the catalog when their inputs are dropped", () => {
      const key = "@iracedeck/audio-assets#build";
      const violations = checkNarrowedInputsCoverExports(
        brokenConfig((c) => {
          withoutInput(key, "manifest.json")(c);
          withoutInput(key, "catalog/**")(c);
        }),
        repo,
        tracked,
      );
      expect(violations.some((v) => v.includes('exports "./manifest.json"'))).toBe(true);
      expect(violations.some((v) => v.includes('exports "./catalog/*.json"'))).toBe(true);
    });

    it("positive control: reads narrowed inputs on the generic task, and accepts the dist/ it outputs", () => {
      const violations = checkNarrowedInputsCoverExports(
        brokenConfig((c) => {
          c.tasks.build.inputs = ["src/**/*.ts"];
        }),
        repo,
        tracked,
      );
      expect(violations.some((v) => v.startsWith('@iracedeck/pi-components exports "./src/build/index.mjs"'))).toBe(
        true,
      );
      expect(violations.some((v) => v.includes('of "build"'))).toBe(true);
      expect(violations.filter((v) => /do not hash packages\/[\w-]+\/dist\//.test(v))).toEqual([]);
    });
  });

  describe("D. the folders the audio copy ships", () => {
    it("reads SHIPPED_FOLDERS", () => {
      expect([...SHIPPED_FOLDERS]).toContain("sfx");
    });

    it("every shipped folder is hashed by @iracedeck/audio-assets#build", () => {
      const violations = checkShippedFolders(turbo, repo, SHIPPED_FOLDERS, tracked);
      expect(violations, violations.join("\n")).toEqual([]);
    });

    it("positive control: reports sfx/ when its input is dropped", () => {
      const violations = checkShippedFolders(
        brokenConfig(withoutInput("@iracedeck/audio-assets#build", "sfx/**")),
        repo,
        SHIPPED_FOLDERS,
        tracked,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('add "sfx/**" to the "inputs"');
    });
  });

  describe("E. the plugin factory's SOURCES", () => {
    // Coverage guard: every SOURCES key is checked or excused with a reason.
    it("checks every key of SOURCES", () => {
      const checked = new Set(pluginSources.map(({ key }) => key));
      const unaccounted = Object.keys(SOURCES).filter((key) => !checked.has(key) && !SOURCES_NOT_READ.has(key));
      expect(unaccounted).toEqual([]);
      expect(pluginSources.map(({ key }) => key)).toEqual(
        expect.arrayContaining(["licensePath", "thirdPartyLicensesPath", "elgatoPluginImgsDir"]),
      );
    });

    it("names the three plugins that run the factory", () => {
      for (const pkg of PLUGIN_PACKAGES) {
        expect(workspace.get(pkg)?.manifest.scripts?.build, pkg).toMatch(/^rollup -c\b/);
      }
    });

    it("every source is hashed by each plugin's build", () => {
      const violations = checkPluginSources(turbo, repo, pluginSources, PLUGIN_PACKAGES, tracked);
      expect(violations, violations.join("\n")).toEqual([]);
    });

    it("positive control: reports the license files and the Stream Deck images when undeclared", () => {
      const violations = checkPluginSources(
        brokenConfig((c) => {
          withoutInput("@iracedeck/iracing-plugin-ulanzi#build", "$TURBO_ROOT$/LICENSE")(c);
          withoutInput("@iracedeck/iracing-plugin-ulanzi#build", "$TURBO_ROOT$/THIRD-PARTY-LICENSES.md")(c);
          withoutInput(
            "@iracedeck/iracing-plugin-mirabox#build",
            "$TURBO_ROOT$/packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/imgs/plugin/**",
          )(c);
        }),
        repo,
        pluginSources,
        PLUGIN_PACKAGES,
        tracked,
      );
      expect(violations.map((v) => v.split(" copies ")[0] + " " + v.match(/SOURCES\.\w+/)[0]).sort()).toEqual([
        "@iracedeck/iracing-plugin-mirabox#build SOURCES.elgatoPluginImgsDir",
        "@iracedeck/iracing-plugin-ulanzi#build SOURCES.licensePath",
        "@iracedeck/iracing-plugin-ulanzi#build SOURCES.thirdPartyLicensesPath",
      ]);
    });
  });
});
