import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
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
// What turbo hashes, as this test models it (the turbo MODELLED_TURBO_VERSION
// names, and the cross-check below holds it to):
//   * `globalDependencies` (repo-root globs) are in every task's hash, and so
//     is `.gitattributes`, which turbo adds itself (TURBO_IMPLICIT_GLOBAL_FILES).
//   * A task's `inputs` are globs relative to its package, or to the repo root
//     behind `$TURBO_ROOT$/`; `!` excludes; `$TURBO_DEFAULT$` stands for the
//     package's own files. Without `inputs` the default is the package's files.
//     A list WITHOUT `$TURBO_DEFAULT$` hashes only what it names (and the
//     package's package.json and turbo.json, which are always hashed).
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
// That model is a re-implementation, so nothing would tie it to turbo but the
// claims above (#1503): a turbo bump that hashed differently would leave every
// check green while checking the wrong thing. Two things tie it. The version it
// models is pinned (MODELLED_TURBO_VERSION) and must be the one the root
// package.json declares, node_modules holds and turbo.json's `$schema` names,
// so a bump fails here until someone re-verifies. And every run asks turbo itself: "the model against
// turbo's own dry run" runs `turbo run build typecheck --dry=json` and holds
// the model to it, task by task — the files each task hashes, in both
// directions; the config entry it resolves; its direct dependency edges; the
// task graph; and the global hash's files. Beside TURBO_IMPLICIT_GLOBAL_FILES,
// the one disagreement it allows is the model's documented strictness about
// dot-directories (below).
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
// files too (today only `packages/icons/node_modules/.bin/`, which the website's
// `$TURBO_ROOT$/packages/icons/**` reaches). In a `!` exclusion the same
// strictness would err the other way, hashing what turbo excludes; the
// cross-check reports that rather than allowing it.

// scripts/turbo-inputs.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// The pseudo package name turbo gives the repo root, as in `//#generate:changelog-data`.
const ROOT = "//";

// The turbo whose hashing the model describes (#1503). A turbo bump fails the
// version test until someone has re-verified the model against the new turbo:
// the claims in the header comment, then the dry-run cross-check, whose
// allowances (TURBO_IMPLICIT_GLOBAL_FILES and the dot-directory strictness)
// must still be the only differences. Only then does this constant move.
const MODELLED_TURBO_VERSION = "2.11.9";

// The tasks the cross-check asks turbo to plan. Their dependsOn closure reaches
// every task the checks reason about (`//#generate:changelog-data` through the
// plugins' builds), and a test holds that, so a check on a task outside it
// fails rather than going unverified.
const DRY_RUN_TASKS = ["build", "typecheck"];

// How long the dry run may take. This is enforced by `spawnSync`, NOT by a
// Vitest timeout: the dry run runs while the file is collected, and Vitest
// cannot interrupt a synchronous `spawnSync`, so a hung turbo would block the
// worker until the CI job limit. Generous against the <1 s it takes (measured
// 2026-10-30, turbo 2.11.9).
const DRY_RUN_TIMEOUT_MS = 60_000;

// Files turbo puts in the global hash with no `globalDependencies` glob naming
// them, and why. The model leaves them out: no build reads them as input, and
// the cross-check holds both this list and turbo to each other.
const TURBO_IMPLICIT_GLOBAL_FILES = new Map([
  [
    ".gitattributes",
    "turbo hashes a file as git stores it, line endings normalised by `.gitattributes`, so the file is in every hash",
  ],
]);

// Directories that never hold a project config worth checking. `build/` is
// skipped only at a package root, where node-gyp writes it: `src/build/` in
// audio-assets and pi-components is source (#1125).
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo"]);

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

// Node and tsx flags whose value is the next argument, so `node --import tsx
// gen.mjs` runs `gen.mjs` rather than a file named `tsx`.
const NODE_FLAGS_WITH_VALUE = new Set([
  "--import",
  "--require",
  "-r",
  "--loader",
  "--experimental-loader",
  "--tsconfig",
]);

// ---------------------------------------------------------------------------
// Paths and globs

const toPosix = (p) => p.replaceAll("\\", "/");
const repoRelative = (absPath) => toPosix(path.relative(repoRoot, absPath));
const isInside = (file, dir) => dir === "" || file === dir || file.startsWith(`${dir}/`);
const taskKey = (pkg, task) => `${pkg}#${task}`;

// Node's own matcher (stable in Node 24, no warning). Paths are repo-relative
// with forward slashes on every platform, so posix is the right flavour. It
// compiles the glob on every call, and the checks ask the same question for
// every task that reaches a file, so answers are memoised. The cross-check
// asks every task about every tracked file, so a file outside the glob's
// literal leading directories is turned away before the matcher or the memo:
// no glob character can stand for a `/` in front of the first one.
const globAnswers = new Map();
const globPrefixes = new Map();
function globMatches(file, glob) {
  let prefix = globPrefixes.get(glob);
  if (prefix === undefined) {
    const firstMeta = glob.search(/[*?[\]{}()!+@\\]/);
    prefix = firstMeta < 0 ? glob : glob.slice(0, glob.lastIndexOf("/", firstMeta) + 1);
    globPrefixes.set(glob, prefix);
  }
  if (!file.startsWith(prefix)) return false;
  const key = `${glob}\0${file}`;
  let answer = globAnswers.get(key);
  if (answer === undefined) {
    answer = path.posix.matchesGlob(file, glob);
    globAnswers.set(key, answer);
  }
  return answer;
}

// The files of a package turbo adds to each of its tasks' inputs, narrowed or not.
const ALWAYS_HASHED = ["package.json", "turbo.json"];

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
  // Turbo hashes the package's package.json and turbo.json whatever `inputs` say.
  if (ALWAYS_HASHED.some((name) => file === (pkgDir ? `${pkgDir}/${name}` : name))) return true;
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
 * The tasks `pkg#task`'s `dependsOn` names directly, as [{ pkg, task }]. `^x`
 * is task x in each direct workspace dependency; `p#x` names one task; a bare
 * `x` is the same package's task x.
 */
function directDependencies(turbo, workspace, pkg, task) {
  return (taskConfig(turbo, pkg, task)?.dependsOn ?? []).flatMap((dep) => {
    if (dep.startsWith("^")) return (workspace.get(pkg)?.deps ?? []).map((d) => ({ pkg: d, task: dep.slice(1) }));
    if (dep.includes("#")) {
      const at = dep.lastIndexOf("#");
      return [{ pkg: dep.slice(0, at), task: dep.slice(at + 1) }];
    }
    return [{ pkg, task: dep }];
  });
}

/** Every task whose hash ends up in `pkg#task`'s hash: the task itself and, transitively, its `dependsOn`. */
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
    seen.set(key, { pkg: p, task: t, dir: workspace.get(p)?.dir ?? "", config: taskConfig(turbo, p, t) });
    for (const dep of directDependencies(turbo, workspace, p, t)) visit(dep.pkg, dep.task);
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

/**
 * The files that stand for a directory: a probe for files yet to be added, and
 * each listed file under it — tracked files, plus for a copy source the
 * gitignored files on disk there, which the copy picks up too.
 */
function filesOfDirectory(dir, files) {
  return [`${dir}/${PROBE}`, ...files.filter((f) => isInside(f, dir))];
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
function checkPluginSources(turbo, repo, sources, plugins, copiedFiles) {
  const violations = [];
  for (const pkg of plugins) {
    for (const { key, file, isDirectory } of sources) {
      const files = isDirectory ? filesOfDirectory(file, copiedFiles) : [file];
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
// Turbo's own answer (#1503). The model above re-implements turbo's hashing;
// these hold it to what the installed turbo's dry run says it hashes. Pure over
// the parsed config, the repo facts and the parsed `--dry=json`, so a positive
// control can hand them a doctored dry run.

/**
 * The version tripwire: the turbo the model describes is the one the root
 * package.json declares, node_modules holds, the dry run reports and
 * turbo.json's `$schema` names (`https://v2-11-9.turborepo.dev/schema.json`
 * is 2.11.9). A `$schema` naming no version is reported as such.
 */
function checkTurboVersion({ modelled, declared, installed, dryRun, schema }) {
  const schemaVersion = /^https:\/\/v(\d+)-(\d+)-(\d+)\.turborepo\.dev\//
    .exec(schema ?? "")
    ?.slice(1)
    .join(".");
  const seen = [
    ["the root package.json's turbo devDependency", declared],
    ["the installed turbo (node_modules/turbo/package.json)", installed],
    ["the dry run's turboVersion", dryRun],
    ...(schemaVersion === undefined ? [] : [[`turbo.json's "$schema"`, schemaVersion]]),
  ];
  const violations = seen
    .filter(([, version]) => version !== modelled)
    .map(
      ([where, version]) =>
        `${where} is ${version}, but scripts/turbo-inputs.test.mjs models turbo ${modelled}: re-verify the model ` +
        `against turbo ${version} — the claims in the file's header comment, then "the model against turbo's own ` +
        `dry run" — before moving MODELLED_TURBO_VERSION`,
    );
  if (schemaVersion === undefined) {
    violations.push(
      `turbo.json's "$schema" is ${schema}, which names no turbo version, but scripts/turbo-inputs.test.mjs models ` +
        `turbo ${modelled}: point it at https://v${modelled.replaceAll(".", "-")}.turborepo.dev/schema.json, the ` +
        `schema of the turbo the model is verified against`,
    );
  }
  return violations;
}

/** The repo-relative files turbo's dry run lists as one task's own inputs. */
function dryRunInputFiles(dryTask) {
  const dir = toPosix(dryTask.directory ?? "");
  return Object.keys(dryTask.inputs ?? {}).map((f) => path.posix.normalize(path.posix.join(dir, toPosix(f))));
}

/**
 * Globs as the dry run's `resolvedTaskDefinition` prints them: `$TURBO_ROOT$/`
 * rewritten to the package-relative `../../`, `$TURBO_DEFAULT$` dropped (the
 * file comparison covers what it stands for), sorted.
 */
function asResolvedGlobs(globs, pkgDir) {
  const up = pkgDir
    ? `${pkgDir
        .split("/")
        .map(() => "..")
        .join("/")}/`
    : "";
  return (globs ?? [])
    .filter((glob) => glob !== "$TURBO_DEFAULT$")
    .map((glob) => glob.replace(/^(!?)\$TURBO_ROOT\$\//, (_, bang) => `${bang}${up}`))
    .sort();
}

/**
 * A path with each segment's leading dot swapped for a stand-in, so `*` and
 * `**` match it as turbo's globs do. A `.` or `..` segment is a step, not a
 * dotfile, and is left alone, so a glob that reaches up still does.
 */
const undot = (p) => p.replace(/(^|\/)\.(?!\.?(?:\/|$))/g, "$1․");

/**
 * Whether the explicit globs of `inputs` would hash `file` if `*` and `**`
 * matched a dot-directory or dotfile, as turbo's do — the one way the model is
 * documented to be stricter than turbo. `$TURBO_DEFAULT$` is no glob: the
 * default inputs hash dotfiles in the model too.
 */
function inputsCoverWithDots(inputs, pkgDir, file) {
  const globs = (inputs ?? [])
    .filter((glob) => glob !== "$TURBO_DEFAULT$")
    .map((glob) => (glob.startsWith("!") ? `!${undot(glob.slice(1))}` : undot(glob)));
  return globsCover(globs, undot(pkgDir), undot(file), () => false);
}

/** Up to five items of a list, and how many there are in all. */
function sample(list) {
  return `${list.slice(0, 5).join(", ")}${list.length > 5 ? `, … (${list.length} in all)` : ""}`;
}

/**
 * Every way the model disagrees with turbo's dry run of DRY_RUN_TASKS (`dry`),
 * one sentence apiece; an empty list is a pass. Per planned task: the files it
 * hashes itself, in both directions; the config entry it resolves; its direct
 * dependency edges. Then the task graph, and the global hash's files.
 *
 * The files each task is asked about are `onDisk` (onDiskSnapshot: tracked
 * and present, untracked and not ignored, and gitignored but named by an
 * explicit glob — in practice the stable files of two snapshots) and every
 * file turbo lists for that task, so a deleted file is asked about nowhere and
 * a gitignored one that no explicit glob names only where turbo hashes it.
 * Turbo hashing a file the model says it does not is the
 * documented strictness when the file sits in a dot-directory an explicit glob
 * would otherwise match, and a violation otherwise; the model hashing a file
 * turbo does not is always one, since checks A–E would then pass on a file
 * turbo never looks at.
 *
 * `scope` narrows it for a positive control, which doctors one corner of the
 * dry run and need not pay for the rest: `tasks`, the task ids whose files,
 * definition and edges are compared (every planned task when absent); `graph`
 * and `global`, whether the task graph and the global hash are (both by
 * default).
 */
function compareModelWithDryRun(turbo, repo, dry, onDisk, scope = {}) {
  const { workspace } = repo;
  const { tasks: scopedTasks, graph = true, global = true } = scope;
  const violations = [];
  const sorted = (list) => [...new Set(list)].sort();
  const fixModel = `scripts/turbo-inputs.test.mjs models turbo ${MODELLED_TURBO_VERSION}; fix the model to match`;

  // The graph. Turbo runs a root script only as a `//#` task turbo.json
  // declares, so the root's own `build` and `typecheck` scripts are not roots.
  if (graph) {
    const modelled = new Set();
    for (const pkg of workspace.keys()) {
      if (pkg === ROOT) continue;
      for (const task of DRY_RUN_TASKS) {
        for (const t of taskClosure(turbo, workspace, pkg, task)) modelled.add(taskKey(t.pkg, t.task));
      }
    }
    const planned = new Set(dry.tasks.map(({ taskId }) => taskId));
    for (const id of [...modelled].filter((id) => !planned.has(id)).sort()) {
      violations.push(`the model's dependsOn closure reaches ${id}, but turbo's dry run does not plan it: ${fixModel}`);
    }
    for (const id of [...planned].filter((id) => !modelled.has(id)).sort()) {
      violations.push(`turbo's dry run plans ${id}, but the model's dependsOn closure does not reach it: ${fixModel}`);
    }
  }

  for (const dryTask of dry.tasks) {
    const { taskId: id, package: pkg, task } = dryTask;
    if (scopedTasks !== undefined && !scopedTasks.includes(id)) continue;
    const entry = workspace.get(pkg);
    if (!entry) {
      violations.push(`turbo plans ${id} in a package the model's workspace lacks: teach loadWorkspace() about it`);
      continue;
    }
    const { dir } = entry;
    if (toPosix(dryTask.directory ?? "") !== dir) {
      violations.push(`turbo runs ${id} in "${toPosix(dryTask.directory)}", the model in "${dir}": ${fixModel}`);
      continue;
    }
    const config = taskConfig(turbo, pkg, task);
    if (!config) {
      violations.push(`turbo plans ${id}, but the model finds no entry for it in turbo.json: ${fixModel}`);
      continue;
    }

    // The definition: the entry the model picks resolves to what turbo resolved.
    const key = configKey(turbo, pkg, task);
    const resolved = dryTask.resolvedTaskDefinition ?? {};
    const fields = [
      ["inputs", sorted(asResolvedGlobs(config.inputs, dir)), sorted(resolved.inputs ?? [])],
      ["outputs", sorted(asResolvedGlobs(config.outputs, dir)), sorted(resolved.outputs ?? [])],
      ["dependsOn", sorted(config.dependsOn ?? []), sorted(resolved.dependsOn ?? [])],
      ["cache", [String(config.cache ?? true)], [String(resolved.cache)]],
    ];
    for (const [field, mine, theirs] of fields) {
      if (mine.join("\n") === theirs.join("\n")) continue;
      violations.push(
        `${id}: turbo resolves its "${field}" to [${theirs.join(", ")}], but the model reads ` +
          `[${mine.join(", ")}] from "${key}": taskConfig() picks another entry than turbo does — ${fixModel}`,
      );
    }

    // The direct edges, `<NONEXISTENT>` tasks included.
    const mineDeps = sorted(directDependencies(turbo, workspace, pkg, task).map((d) => taskKey(d.pkg, d.task)));
    const theirDeps = sorted(dryTask.dependencies ?? []);
    const extraDeps = mineDeps.filter((d) => !theirDeps.includes(d));
    const missingDeps = theirDeps.filter((d) => !mineDeps.includes(d));
    if (extraDeps.length > 0) {
      violations.push(`${id}: the model has it depend on ${sample(extraDeps)}, turbo does not: ${fixModel}`);
    }
    if (missingDeps.length > 0) {
      violations.push(`${id}: turbo has it depend on ${sample(missingDeps)}, the model does not: ${fixModel}`);
    }

    // The files it hashes itself.
    const listed = new Set(dryRunInputFiles(dryTask));
    const modelOnly = [];
    const turboOnly = [];
    for (const file of new Set([...onDisk, ...listed])) {
      const hashed = inputsCover(config.inputs, dir, file, repo);
      if (hashed && !listed.has(file)) modelOnly.push(file);
      if (!hashed && listed.has(file) && !inputsCoverWithDots(config.inputs, dir, file)) turboOnly.push(file);
    }
    if (modelOnly.length > 0) {
      violations.push(
        `${id}: the model says the task hashes ${sample(modelOnly.sort())}, but turbo's dry run does not list it, ` +
          `so checks A–E pass on files turbo never hashes: ${fixModel} (inputsCover)`,
      );
    }
    if (turboOnly.length > 0) {
      violations.push(
        `${id}: turbo hashes ${sample(turboOnly.sort())}, which the model says the task does not, and not ` +
          `because of the documented dot-directory strictness: find out why turbo hashes it — ${fixModel}`,
      );
    }
  }

  // The global hash: every file `globalDependencies` names, and only the implicit ones beside them.
  if (!global) return violations;
  const globs = turbo.globalDependencies ?? [];
  const turboGlobal = Object.keys(dry.globalCacheInputs?.files ?? {}).map(toPosix);
  const modelGlobal = [...new Set([...onDisk, ...turboGlobal])].filter((f) =>
    globs.some((glob) => globMatches(f, glob)),
  );
  for (const file of modelGlobal.filter((f) => !turboGlobal.includes(f)).sort()) {
    violations.push(`the model treats ${file} as a global dependency, but turbo's global hash lacks it: ${fixModel}`);
  }
  for (const file of turboGlobal.filter((f) => !modelGlobal.includes(f) && !TURBO_IMPLICIT_GLOBAL_FILES.has(f))) {
    violations.push(
      `turbo's global hash has ${file}, which no "globalDependencies" glob names: find out why turbo hashes it, ` +
        `then add it to TURBO_IMPLICIT_GLOBAL_FILES with the reason`,
    );
  }
  for (const file of TURBO_IMPLICIT_GLOBAL_FILES.keys()) {
    if (onDisk.includes(file) && !turboGlobal.includes(file)) {
      violations.push(`TURBO_IMPLICIT_GLOBAL_FILES names ${file}, but turbo's global hash lacks it: drop the entry`);
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

// Export conditions in the order a runtime picks them, and the order tsc does.
const RUNTIME_CONDITIONS = ["import", "node", "default", "require", "types"];
const TYPES_CONDITIONS = ["types", "import", "node", "default", "require"];

/** The file a workspace package specifier (`@iracedeck/x/sub`) resolves to, by its `exports`. */
function resolveWorkspaceSpecifier(specifier, workspace, conditions = RUNTIME_CONDITIONS) {
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
    for (const condition of conditions) {
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
 * The repo-relative globs that hash files whether git ignores them or not:
 * every positive, explicit `inputs` entry of every task (a generic task's
 * against each package) and every `globalDependencies` glob. Negations only
 * take files away, and `$TURBO_DEFAULT$` skips ignored files.
 */
function explicitInputGlobs(turbo, workspace) {
  const globs = new Set(turbo.globalDependencies ?? []);
  const packageDirs = [...workspace].filter(([pkg]) => pkg !== ROOT).map(([, { dir }]) => dir);
  for (const [key, config] of Object.entries(turbo.tasks ?? {})) {
    const at = key.lastIndexOf("#");
    const dirs = at < 0 ? packageDirs : [workspace.get(key.slice(0, at))?.dir ?? ""];
    for (const glob of config.inputs ?? []) {
      if (glob.startsWith("!") || glob === "$TURBO_DEFAULT$") continue;
      for (const dir of dirs) {
        globs.add(glob.startsWith("$TURBO_ROOT$/") ? glob.slice("$TURBO_ROOT$/".length) : path.posix.join(dir, glob));
      }
    }
  }
  return [...globs].sort();
}

/**
 * The gitignored regular files on disk that `globs` may match, by git's own
 * pathspec globbing, whose `*` and `**` match dotfiles too — a superset of what
 * the model's stricter matcher accepts, which then decides. A symlink is left
 * out: pnpm's `node_modules/<dep>` links are one, turbo hashes none of them,
 * and the model has no business with them.
 */
function ignoredFilesMatching(globs) {
  if (globs.length === 0) return [];
  const result = spawnSync(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...globs.map((g) => `:(glob)${g}`)],
    { cwd: repoRoot, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`git ls-files --ignored failed: ${result.stderr}`);
  return result.stdout.split("\0").filter((f) => {
    if (!f) return false;
    try {
      return lstatSync(path.join(repoRoot, f)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * The files on disk the cross-check asks every task about, at one moment:
 * tracked and present, untracked and not ignored (turbo's default inputs hash
 * both), and gitignored but matched by an explicit glob (which hashes them).
 */
function onDiskSnapshot(tracked, explicitGlobs) {
  const deleted = deletedTrackedFiles();
  return [...tracked.filter((f) => !deleted.has(f)), ...untrackedFiles(), ...ignoredFilesMatching(explicitGlobs)];
}

/**
 * The files in both of two snapshots, taken either side of the dry run. A file
 * another process creates or deletes meanwhile — `typecheck-script-coverage`
 * plants a website test file for seconds in a full run — is in one only, and
 * turbo may or may not have seen it, so it is asked about only where turbo
 * lists it rather than reported as a model error.
 */
function stableOnDisk(before, after) {
  const later = new Set(after);
  return [...new Set(before)].filter((f) => later.has(f));
}

/** The tracked files a working tree has deleted: turbo hashes none of them, so the cross-check asks about none. */
function deletedTrackedFiles() {
  const result = spawnSync("git", ["ls-files", "--deleted", "-z"], { cwd: repoRoot, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ls-files --deleted failed: ${result.stderr}`);
  return new Set(result.stdout.split("\0").filter(Boolean));
}

/** git's untracked files that are not ignored: turbo's default inputs hash them, so the cross-check asks about them. */
function untrackedFiles() {
  const result = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git ls-files --others failed: ${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
}

/**
 * The installed turbo's version and its parsed `turbo run <tasks> --dry=json`,
 * which plans the tasks and lists every file each one hashes without running
 * any — or, in `error`, why there is none. It never throws: it runs while the
 * file is collected, and a turbo that cannot run must fail the cross-check's
 * tests, not checks A–E, which never needed turbo. Turbo runs through its own
 * JS entry under this Node rather than a `.bin` shim, which differs by
 * platform. Every `TURBO_*` variable is dropped (CI sets `TURBO_CACHE`;
 * `TURBO_BINARY_PATH` would swap the binary), so the answer is the tree's
 * alone, and telemetry is off, so a test run phones nobody.
 */
function runTurboDryRun(tasks) {
  let installedVersion;
  try {
    const require = createRequire(path.join(repoRoot, "package.json"));
    const manifestPath = require.resolve("turbo/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    installedVersion = manifest.version;
    const bin = path.join(
      path.dirname(manifestPath),
      typeof manifest.bin === "string" ? manifest.bin : manifest.bin.turbo,
    );
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^TURBO_/i.test(name)));
    const result = spawnSync(process.execPath, [bin, "run", ...tasks, "--dry=json"], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...env, TURBO_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
      maxBuffer: 256 * 1024 * 1024,
      timeout: DRY_RUN_TIMEOUT_MS,
    });
    return { installedVersion, ...readDryRun(tasks, result) };
  } catch (error) {
    return { installedVersion, error: `turbo could not be run: ${error.message}` };
  }
}

/**
 * The parsed dry run from a `spawnSync` result, as `{ dry }`, or as `{ error }`
 * with turbo's own stderr. A spawn error is "could not start" only when no
 * process ever ran (no pid); one that ran and was cut off says how: killed at
 * DRY_RUN_TIMEOUT_MS, or the error's code (ENOBUFS: its output outgrew
 * `maxBuffer`).
 */
function readDryRun(tasks, result) {
  const command = `turbo run ${tasks.join(" ")} --dry=json`;
  const stderr = result.stderr?.trim() || "(no stderr)";
  if (result.error && !result.pid) return { error: `${command} could not start: ${result.error.message}` };
  if (result.error?.code === "ETIMEDOUT") {
    return { error: `${command} was killed after ${DRY_RUN_TIMEOUT_MS} ms without finishing: ${stderr}` };
  }
  if (result.error) {
    return { error: `${command} failed after it started (${result.error.code ?? result.error.message}): ${stderr}` };
  }
  if (result.status !== 0) {
    return { error: `${command} exited ${result.status ?? `on ${result.signal}`}: ${stderr}` };
  }
  let dry;
  try {
    dry = JSON.parse(result.stdout);
  } catch (error) {
    return { error: `${command} printed no JSON (${error.message}): ${stderr}` };
  }
  if (!Array.isArray(dry?.tasks)) return { error: `${command} printed JSON without a "tasks" list: ${stderr}` };
  return { dry };
}

/**
 * The gitignored files on disk under `dirs`. A copy step picks these up with
 * the tracked ones (`iracing-actions/src/actions/data/changelog.json` under the
 * action templates), so check E must see them. An ignored directory is listed
 * as one `dir/` entry and not descended, which keeps `node_modules/` out.
 */
function ignoredFilesUnder(dirs) {
  if (dirs.length === 0) return [];
  const result = spawnSync(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", "--", ...dirs],
    { cwd: repoRoot, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`git ls-files --ignored failed: ${result.stderr}`);
  return result.stdout.split("\0").filter((f) => f && !f.endsWith("/"));
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
  const atPackageRoot = path.dirname(absDir) === path.join(repoRoot, "packages");
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const skip = SKIP_DIRS.has(entry.name) || (atPackageRoot && entry.name === "build");
      if (!skip) found.push(...findTsconfigs(path.join(absDir, entry.name)));
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
 * with a literal are all found, in a `.d.ts` too. Bare specifiers are followed
 * only into workspace packages, through their `exports` — both the target a
 * runtime loads and the one tsc reads for types; external packages are hashed
 * through the lockfile. A file is read once however many walks reach it.
 */
function createImportReader(workspace) {
  const cache = new Map();
  return (file) => {
    if (cache.has(file)) return cache.get(file);
    const abs = path.join(repoRoot, file);
    let targets = [];
    if (CODE_EXTENSIONS.has(path.extname(file)) && existsSync(abs)) {
      const resolved = ts
        .preProcessFile(readFileSync(abs, "utf-8"), true, true)
        .importedFiles.flatMap(({ fileName: specifier }) =>
          specifier.startsWith(".")
            ? [resolveRelative(abs, specifier)]
            : [
                resolveWorkspaceSpecifier(specifier, workspace),
                resolveWorkspaceSpecifier(specifier, workspace, TYPES_CONDITIONS),
              ],
        );
      targets = [...new Set(resolved.filter((target) => target !== undefined))];
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
// What a SOURCES directory copy picks up: its tracked files and the gitignored ones on disk.
const copiedFiles = [
  ...tracked,
  ...ignoredFilesUnder(pluginSources.filter(({ isDirectory }) => isDirectory).map(({ file }) => file)),
];
// The generated changelog the action templates directory carries once `//#generate:changelog-data` has run.
const GENERATED_CHANGELOG = "packages/iracing-actions/src/actions/data/changelog.json";
// Turbo's own answer, for the cross-check.
// A failed run is held in `turboRun.error` for the cross-check's tests to report.
// The files on disk are taken either side of it, and only those in both are
// asked about everywhere (stableOnDisk).
const explicitGlobs = explicitInputGlobs(turbo, workspace);
const onDiskBefore = onDiskSnapshot(tracked, explicitGlobs);
const turboRun = runTurboDryRun(DRY_RUN_TASKS);
const onDisk = stableOnDisk(onDiskBefore, onDiskSnapshot(tracked, explicitGlobs));

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
  ...copiedFiles,
  GENERATED_CHANGELOG,
  ...(turboRun.dry?.tasks ?? []).flatMap(dryRunInputFiles),
  ...onDisk,
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
      expect(inputsCover(inputs, "packages/a", "packages/a/turbo.json", fake)).toBe(true);
      expect(inputsCover(["x.mjs"], "", "turbo.json", fake)).toBe(true);
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

    it("reads the direct edges of ^x, p#x and a bare x", () => {
      const config = { tasks: { build: { dependsOn: ["^build", "gen", "//#data"] } } };
      expect(directDependencies(config, ws, "a", "build")).toEqual([
        { pkg: "b", task: "build" },
        { pkg: "a", task: "gen" },
        { pkg: ROOT, task: "data" },
      ]);
      expect(directDependencies(config, ws, "a", "gen")).toEqual([]);
    });

    it("turns a glob away by its literal leading directories without changing the answer", () => {
      expect(globMatches("packages/a/src/x.ts", "packages/a/src/**")).toBe(true);
      expect(globMatches("packages/b/src/x.ts", "packages/a/src/**")).toBe(false);
      expect(globMatches("packages/a/src/x.ts", "packages/*/src/*.ts")).toBe(true);
      expect(globMatches("tsconfig.base.json", "tsconfig.base.json")).toBe(true);
      expect(globMatches("tsconfig.base.json.bak", "tsconfig.base.json")).toBe(false);
      expect(globMatches("scripts/lib/changelog-parse.mjs", "scripts/lib/changelog-*.mjs")).toBe(true);
    });

    it("resolves workspace specifiers through exports, patterns included", () => {
      expect(resolveWorkspaceSpecifier("@iracedeck/audio-assets/build", workspace)).toBe(
        "packages/audio-assets/src/build/index.mjs",
      );
      expect(resolveWorkspaceSpecifier("@iracedeck/audio-assets/catalog/default.json", workspace)).toBe(
        "packages/audio-assets/catalog/default.json",
      );
      expect(resolveWorkspaceSpecifier("@iracedeck/audio-assets/build", workspace, TYPES_CONDITIONS)).toBe(
        "packages/audio-assets/src/build/index.d.ts",
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

  describe("the model against turbo's own dry run (#1503)", () => {
    // Every test here needs the dry run. One that could not run fails each of
    // them with turbo's own words, while checks A–E, which never needed turbo,
    // still run: nothing in this block passes without it.
    const requireDryRun = (run = turboRun) => {
      if (run.error) throw new Error(`the cross-check has no dry run to compare with: ${run.error}`);
      return run.dry;
    };
    // A doctored copy of the real dry run, for the positive controls. Only what
    // a control changes is cloned: the task list, the global hash, and each
    // task it reaches through dryTaskOf.
    const doctored = (mutate) => {
      const real = requireDryRun();
      const copy = { ...real, globalCacheInputs: structuredClone(real.globalCacheInputs), tasks: [...real.tasks] };
      mutate(copy);
      return copy;
    };
    const dryTaskOf = (dry, id) => {
      const index = dry.tasks.findIndex(({ taskId }) => taskId === id);
      if (index < 0) throw new Error(`positive control is stale: the dry run plans no ${id}`);
      dry.tasks[index] = structuredClone(dry.tasks[index]);
      return dry.tasks[index];
    };
    const compare = (dry, { config = turbo, files = onDisk, ...scope } = {}) =>
      compareModelWithDryRun(config, repo, dry, files, scope);
    // A control compares only the task it doctors: no graph, no global hash.
    const onlyTasks = (...tasks) => ({ tasks, graph: false, global: false });
    const fixModel = `scripts/turbo-inputs.test.mjs models turbo ${MODELLED_TURBO_VERSION}; fix the model to match`;

    it("ran turbo's dry run", () => {
      expect(turboRun.error, turboRun.error).toBeUndefined();
      expect(requireDryRun().tasks.length).toBeGreaterThan(40);
    });

    it("positive control: fails the block, with turbo's stderr, when the dry run could not run", () => {
      const tasks = DRY_RUN_TASKS;
      const failed = readDryRun(tasks, { status: 1, stdout: "", stderr: "  x Could not find task `nope`\n" });
      expect(failed).toEqual({
        error: "turbo run build typecheck --dry=json exited 1: x Could not find task `nope`",
      });
      expect(() => requireDryRun(failed)).toThrow("exited 1: x Could not find task `nope`");
      const spawnError = (code) => Object.assign(new Error(`spawnSync node ${code}`), { code });
      expect(readDryRun(tasks, { pid: 0, status: null, error: spawnError("ENOENT") }).error).toBe(
        "turbo run build typecheck --dry=json could not start: spawnSync node ENOENT",
      );
      const killed = { pid: 4242, status: null, signal: "SIGTERM", stderr: "half a plan\n" };
      expect(readDryRun(tasks, { ...killed, error: spawnError("ETIMEDOUT") }).error).toBe(
        `turbo run build typecheck --dry=json was killed after ${DRY_RUN_TIMEOUT_MS} ms without finishing: half a plan`,
      );
      expect(readDryRun(tasks, { ...killed, error: spawnError("ENOBUFS") }).error).toBe(
        "turbo run build typecheck --dry=json failed after it started (ENOBUFS): half a plan",
      );
      expect(readDryRun(tasks, { status: null, signal: "SIGKILL", stderr: "" }).error).toContain(
        "exited on SIGKILL: (no stderr)",
      );
      expect(readDryRun(tasks, { status: 0, stdout: "Turbo telemetry notice", stderr: "" }).error).toContain(
        "printed no JSON",
      );
      expect(readDryRun(tasks, { status: 0, stdout: "{}", stderr: "" }).error).toContain('without a "tasks" list');
      expect(readDryRun(tasks, { status: 0, stdout: '{"tasks":[]}', stderr: "" })).toEqual({ dry: { tasks: [] } });
    });

    it("models the turbo that is declared, installed and named by turbo.json's $schema", () => {
      const violations = checkTurboVersion({
        modelled: MODELLED_TURBO_VERSION,
        declared: workspace.get(ROOT).manifest.devDependencies?.turbo,
        installed: turboRun.installedVersion,
        dryRun: requireDryRun().turboVersion,
        schema: turbo.$schema,
      });
      expect(violations, violations.join("\n")).toEqual([]);
    });

    it("positive control: reports a turbo bump the model has not been re-verified against", () => {
      const violations = checkTurboVersion({
        modelled: MODELLED_TURBO_VERSION,
        declared: "2.12.0",
        installed: "2.12.0",
        dryRun: "2.12.0",
        schema: "https://v2-12-0.turborepo.dev/schema.json",
      });
      expect(violations).toHaveLength(4);
      expect(violations.every((v) => v.includes("re-verify the model against turbo 2.12.0"))).toBe(true);
      expect(violations[0]).toContain("before moving MODELLED_TURBO_VERSION");
      expect(violations[3]).toMatch(/^turbo\.json's "\$schema" is 2\.12\.0, but /);
    });

    it("positive control: reports a $schema that is stale, or names no version", () => {
      const at = (schema) =>
        checkTurboVersion({
          modelled: MODELLED_TURBO_VERSION,
          declared: MODELLED_TURBO_VERSION,
          installed: MODELLED_TURBO_VERSION,
          dryRun: MODELLED_TURBO_VERSION,
          schema,
        });
      expect(at("https://v2-11-9.turborepo.dev/schema.json")).toEqual([]);
      expect(at("https://v2-11-8.turborepo.dev/schema.json")).toEqual([
        `turbo.json's "$schema" is 2.11.8, but scripts/turbo-inputs.test.mjs models turbo ${MODELLED_TURBO_VERSION}: ` +
          `re-verify the model against turbo 2.11.8 — the claims in the file's header comment, then "the model ` +
          `against turbo's own dry run" — before moving MODELLED_TURBO_VERSION`,
      ]);
      expect(at("https://turborepo.dev/schema.json")).toHaveLength(1);
      expect(at("https://turborepo.dev/schema.json")[0]).toContain(
        `turbo.json's "$schema" is https://turborepo.dev/schema.json, which names no turbo version, but ` +
          `scripts/turbo-inputs.test.mjs models turbo ${MODELLED_TURBO_VERSION}: point it at ` +
          `https://v${MODELLED_TURBO_VERSION.replaceAll(".", "-")}.turborepo.dev/schema.json`,
      );
      expect(at(undefined)).toHaveLength(1);
    });

    it("plans every task the checks reason about", () => {
      const dry = requireDryRun();
      const planned = new Set(dry.tasks.map(({ taskId }) => taskId));
      const checked = [...taskScripts.map(({ pkg, task }) => taskKey(pkg, task)), ...EXPECTED_WALKED_TASKS];
      const unplanned = [...new Set(checked)].filter((key) => !planned.has(key));
      expect(
        unplanned,
        `the dry run of ${DRY_RUN_TASKS.join(" ")} does not plan ${unplanned.join(", ")}, so the model is not ` +
          `cross-checked for them: add their task to DRY_RUN_TASKS`,
      ).toEqual([]);
      expect(dry.tasks.some(({ command }) => command === "<NONEXISTENT>")).toBe(true);
    });

    it("agrees with turbo on every task's files, definition and edges, and on the global hash", () => {
      const violations = compare(requireDryRun());
      expect(violations, violations.join("\n")).toEqual([]);
    });

    it("leaves `.` and `..` segments alone when it lets a glob match a dotfile", () => {
      expect(undot("../shared/**")).toBe("../shared/**");
      expect(undot("./src/../x")).toBe("./src/../x");
      expect(undot(".bin/tsc")).toBe("․bin/tsc");
      expect(undot("packages/icons/node_modules/.bin/..x")).toBe("packages/icons/node_modules/․bin/․.x");
      expect(inputsCoverWithDots(["../b/**"], "packages/a", "packages/b/.hidden/x.svg")).toBe(true);
      expect(inputsCoverWithDots(["../b/**", "!../b/.hidden/**"], "packages/a", "packages/b/.hidden/x.svg")).toBe(
        false,
      );
    });

    it("positive control: reports a file the model hashes but turbo does not", () => {
      const id = "@iracedeck/iracing-plugin-mirabox#build";
      const violations = compare(
        doctored((dry) => {
          const { inputs } = dryTaskOf(dry, id);
          if (!("../../scripts/lib/rollup-logs.mjs" in inputs)) throw new Error("positive control is stale");
          delete inputs["../../scripts/lib/rollup-logs.mjs"];
        }),
        onlyTasks(id),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(`${id}: the model says the task hashes scripts/lib/rollup-logs.mjs`);
    });

    it("positive control: asks about an untracked file turbo does not list", () => {
      const id = "@iracedeck/logger#build";
      const probe = "packages/logger/__turbo_inputs_untracked_probe__.txt";
      expect(repo.isIgnored(probe)).toBe(false);
      const violations = compare(requireDryRun(), { files: [...onDisk, probe], ...onlyTasks(id) });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(`${id}: the model says the task hashes ${probe}, but turbo's dry run`);
    });

    it("positive control: asks about no file another process created or deleted while turbo ran", () => {
      const id = "@iracedeck/logger#build";
      const created = "packages/logger/__turbo_inputs_created_meanwhile__.txt";
      const deleted = "packages/logger/__turbo_inputs_deleted_meanwhile__.txt";
      expect(stableOnDisk(["a", "b", "b", deleted], ["b", "c", created])).toEqual(["b"]);
      // Either file alone, in a snapshot the comparison trusted, would be a model error.
      expect(compare(requireDryRun(), { files: [...onDisk, created], ...onlyTasks(id) })).toHaveLength(1);
      const files = stableOnDisk([...onDisk, deleted], [...onDisk, created]);
      expect(files).toEqual([...new Set(onDisk)]);
      expect(compare(requireDryRun(), { files, ...onlyTasks(id) })).toEqual([]);
      // A file turbo lists is still asked about, whatever the snapshots say.
      const listed = doctored((dry) => {
        dryTaskOf(dry, id).inputs["__turbo_inputs_created_meanwhile__.txt"] = "0";
      });
      expect(compare(listed, { files, ...onlyTasks(id) })).toEqual([]);
      const listedOutside = doctored((dry) => {
        dryTaskOf(dry, id).inputs["../../__turbo_inputs_created_meanwhile__.txt"] = "0";
      });
      expect(compare(listedOutside, { files, ...onlyTasks(id) })).toEqual([
        `${id}: turbo hashes __turbo_inputs_created_meanwhile__.txt, which the model says the task does not, and ` +
          `not because of the documented dot-directory strictness: find out why turbo hashes it — ${fixModel}`,
      ]);
    });

    it("asks about the gitignored files an explicit glob names", () => {
      expect(explicitGlobs).toEqual(
        expect.arrayContaining(["feature-flags.local.json", "dev.local.json", "tsconfig.base.json"]),
      );
      expect(explicitGlobs).toContain("packages/audio-assets/sfx/**");
      expect(explicitGlobs.some((g) => g.includes("$TURBO_") || g.startsWith("!"))).toBe(false);
      // They reach the candidates: an installed tree always has some, the
      // `node_modules/.bin/` shims the website's `packages/icons/**` names.
      const ignoredOnDisk = onDisk.filter((f) => repo.isIgnored(f));
      expect(ignoredOnDisk.length, "no gitignored file on disk reached the cross-check's candidates").toBeGreaterThan(
        0,
      );
      expect(ignoredFilesMatching(["packages/icons/**"]).every((f) => repo.isIgnored(f))).toBe(true);
      // pnpm's dependency links are symlinks, not files turbo hashes.
      expect(ignoredOnDisk.filter((f) => /\/node_modules\/(typescript|vitest)$/.test(f))).toEqual([]);
    });

    it("positive control: reports a gitignored file an explicit glob hashes when turbo does not list it", () => {
      const id = "@iracedeck/iracing-plugin-mirabox#build";
      const file = "feature-flags.local.json";
      expect(repo.isIgnored(file)).toBe(true);
      const violations = compare(
        doctored((dry) => {
          delete dryTaskOf(dry, id).inputs[`../../${file}`];
        }),
        // Present in the snapshots whether or not this tree has the file.
        { files: [...new Set([...onDisk, file])], ...onlyTasks(id) },
      );
      expect(violations).toEqual([
        `${id}: the model says the task hashes ${file}, but turbo's dry run does not list it, so checks A–E pass ` +
          `on files turbo never hashes: ${fixModel} (inputsCover)`,
      ]);
    });

    it("positive control: reports a file turbo hashes that the model does not", () => {
      const id = "@iracedeck/logger#build";
      const violations = compare(
        doctored((dry) => {
          dryTaskOf(dry, id).inputs["../../README.md"] = "0";
        }),
        onlyTasks(id),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(`${id}: turbo hashes README.md, which the model says the task does not`);
    });

    it("positive control: allows a dot-directory file only where an explicit glob would match it", () => {
      const id = "@iracedeck/website#build";
      const violations = compare(
        doctored((dry) => {
          const { inputs } = dryTaskOf(dry, id);
          inputs["../../packages/icons/.hidden/icon.svg"] = "0";
          inputs["../../.hidden/icon.svg"] = "0";
        }),
        onlyTasks(id),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(`${id}: turbo hashes .hidden/icon.svg,`);
    });

    it("positive control: reports a per-package entry the model would not resolve", () => {
      const key = "@iracedeck/plugin-build#build";
      const violations = compare(requireDryRun(), {
        config: brokenConfig((c) => {
          if (!c.tasks[key]) throw new Error("positive control is stale");
          delete c.tasks[key];
        }),
        ...onlyTasks(key),
      });
      const expected = [
        `${key}: turbo resolves its "inputs"`,
        `${key}: turbo resolves its "outputs"`,
        `${key}: the model says the task hashes`,
      ];
      expect(violations.map((v) => expected.find((prefix) => v.startsWith(prefix)) ?? v)).toEqual(expected);
    });

    it("positive control: reports a dependency edge, and a <NONEXISTENT> task, the model and turbo disagree on", () => {
      const id = "@iracedeck/website#build";
      const violations = compare(
        doctored((dry) => {
          const task = dryTaskOf(dry, id);
          task.dependencies = task.dependencies.filter((d) => d !== "@iracedeck/iracing-actions#build");
          dry.tasks = dry.tasks.filter(({ taskId }) => taskId !== "@iracedeck/icons#build");
        }),
        { tasks: [id], graph: true, global: false },
      );
      expect(violations).toEqual([
        `the model's dependsOn closure reaches @iracedeck/icons#build, but turbo's dry run does not plan it: ${fixModel}`,
        `${id}: the model has it depend on @iracedeck/iracing-actions#build, turbo does not: ${fixModel}`,
      ]);
    });

    it("positive control: reports a global dependency turbo does not hash, and a stale implicit one", () => {
      const violations = compare(
        doctored((dry) => {
          delete dry.globalCacheInputs.files["tsconfig.base.json"];
          delete dry.globalCacheInputs.files[".gitattributes"];
          dry.globalCacheInputs.files["LICENSE"] = "0";
        }),
        { tasks: [], graph: false, global: true },
      );
      expect(violations.sort()).toEqual([
        "TURBO_IMPLICIT_GLOBAL_FILES names .gitattributes, but turbo's global hash lacks it: drop the entry",
        `the model treats tsconfig.base.json as a global dependency, but turbo's global hash lacks it: ${fixModel}`,
        `turbo's global hash has LICENSE, which no "globalDependencies" glob names: find out why turbo hashes it, ` +
          "then add it to TURBO_IMPLICIT_GLOBAL_FILES with the reason",
      ]);
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
        // Whether it is still read can only be told while the file exists: a
        // tsconfig program lists only files on disk, and a file nothing has
        // generated yet is read by nobody. CI's warm cache replays the website
        // tasks without running Astro, so there `.astro/types.d.ts` is absent
        // and the check waits for a tree that has built it (#1506).
        const reached = [...walked, ...compiled].some((w) => taskKey(w.pkg, w.task) === key && w.reads.has(file));
        const generated = existsSync(path.join(repoRoot, file));
        expect(reached || !generated, `${key} no longer reads ${file}; drop it from GENERATED_IN_SCRIPT`).toBe(true);
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
      const violations = checkPluginSources(turbo, repo, pluginSources, PLUGIN_PACKAGES, copiedFiles);
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
        copiedFiles,
      );
      expect(violations.map((v) => v.split(" copies ")[0] + " " + v.match(/SOURCES\.\w+/)[0]).sort()).toEqual([
        "@iracedeck/iracing-plugin-mirabox#build SOURCES.elgatoPluginImgsDir",
        "@iracedeck/iracing-plugin-ulanzi#build SOURCES.licensePath",
        "@iracedeck/iracing-plugin-ulanzi#build SOURCES.thirdPartyLicensesPath",
      ]);
    });

    it("positive control: reports a gitignored file a copied directory carries when nothing generates it first", () => {
      const key = "@iracedeck/iracing-plugin-mirabox#build";
      const violations = checkPluginSources(
        brokenConfig((c) => {
          const dependsOn = c.tasks[key].dependsOn;
          if (!dependsOn.includes("//#generate:changelog-data")) throw new Error("positive control is stale");
          c.tasks[key].dependsOn = dependsOn.filter((d) => d !== "//#generate:changelog-data");
        }),
        repo,
        pluginSources,
        PLUGIN_PACKAGES,
        // Listed whether or not a build has written it yet, so the control does not depend on the tree.
        [...new Set([...copiedFiles, GENERATED_CHANGELOG])],
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(`${key} copies SOURCES.actionTemplatesDir`);
    });
  });
});
