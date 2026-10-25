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
// Astro configs) or compiles (its tsc program, Astro's pages); C, a narrowed
// `inputs` list against the package's `exports`; D and E, the folders and
// files the plugin build copies by path rather than imports.
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

// ---------------------------------------------------------------------------
// Paths and globs

const toPosix = (p) => p.replaceAll("\\", "/");
const repoRelative = (absPath) => toPosix(path.relative(repoRoot, absPath));
const isInside = (file, dir) => dir === "" || file === dir || file.startsWith(`${dir}/`);

// Node's own matcher (stable in Node 24, no warning). Paths are repo-relative
// with forward slashes on every platform, so posix is the right flavour.
const globMatches = (file, glob) => path.posix.matchesGlob(file, glob);

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
// parsed turbo.json and the repo facts passed in, so a test can hand it a
// deliberately broken config.

/** The config turbo uses for `task` in `pkg`: the per-package entry when there is one, else the generic task. */
function taskConfig(turbo, pkg, task) {
  const tasks = turbo.tasks ?? {};
  if (pkg === ROOT) return tasks[`${ROOT}#${task}`];
  return tasks[`${pkg}#${task}`] ?? tasks[task];
}

/** Whether `inputs` (of a task in the package at `pkgDir`) hash `file`. */
function inputsCover(inputs, pkgDir, file, workspace) {
  if (file === (pkgDir ? `${pkgDir}/package.json` : "package.json")) return true;
  // The root package's own files are everything not inside a workspace package.
  const isOwnFile = (f) =>
    pkgDir === "" ? ![...workspace.values()].some((p) => p.dir && isInside(f, p.dir)) : isInside(f, pkgDir);
  if (inputs === undefined) return isOwnFile(file);

  let included = false;
  let excluded = false;
  for (const raw of inputs) {
    const negated = raw.startsWith("!");
    const pattern = negated ? raw.slice(1) : raw;
    let hit;
    if (pattern === "$TURBO_DEFAULT$") {
      hit = isOwnFile(file);
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

/**
 * Every task whose hash ends up in `pkg#task`'s hash: the task itself and,
 * transitively, its `dependsOn`. `^x` is task x in each direct workspace
 * dependency; `p#x` names one task; a bare `x` is the same package's task x.
 */
function taskClosure(turbo, workspace, pkg, task) {
  const seen = new Map();
  const visit = (p, t) => {
    const key = `${p}#${t}`;
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
  return [...seen.values()];
}

/** Whether a change to `file` changes the hash of `pkg#task`. */
function isHashed(turbo, workspace, pkg, task, file) {
  if ((turbo.globalDependencies ?? []).some((glob) => globMatches(file, glob))) return true;
  return taskClosure(turbo, workspace, pkg, task).some(({ dir, config }) =>
    inputsCover(config?.inputs, dir, file, workspace),
  );
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
function fixFor(turbo, workspace, pkg, task, file) {
  const dir = workspace.get(pkg)?.dir ?? "";
  const key = `${pkg}#${task}`;
  const entry = inputEntryFor(file, dir);
  if (turbo.tasks?.[key]) return `add "${entry}" to the "inputs" of "${key}" in turbo.json`;
  return (
    `add a "${key}" entry to turbo.json with "inputs": ["$TURBO_DEFAULT$", "${entry}"] — it REPLACES the ` +
    `generic "${task}" task rather than merging, so copy that task's "dependsOn" and "outputs" into it`
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
 * and configs) or compiles (its tsc program, Astro's pages) is hashed by it.
 * A compile counts: with `allowJs` tsc infers types from an imported `.mjs`,
 * so a changed helper can turn a cached green typecheck red.
 */
function checkBuildReachableImports(turbo, workspace, taskReads) {
  const violations = [];
  for (const { pkg, task, verb, reads } of taskReads) {
    for (const [file, via] of reads) {
      if (isHashed(turbo, workspace, pkg, task, file)) continue;
      violations.push(
        `${pkg}#${task} ${verb} ${via.join(" -> ")}, which reads ${file}, but turbo does not hash it for that ` +
          `task: ${fixFor(turbo, workspace, pkg, task, file)}`,
      );
    }
  }
  return violations;
}

/**
 * C. A build task whose `inputs` leave out `$TURBO_DEFAULT$` hashes only what
 * it names, yet its dependents read whatever the package `exports`. Each export
 * target must be among those inputs, or a change to it is a cache hit for every
 * dependent (#1491: `manifest.json`, the bundled manifest and the catalog).
 */
function checkNarrowedInputsCoverExports(turbo, workspace, tracked) {
  const violations = [];
  for (const [pkg, { dir, manifest }] of workspace) {
    if (pkg === ROOT) continue;
    const key = `${pkg}#build`;
    const inputs = turbo.tasks?.[key]?.inputs;
    if (!inputs || inputs.includes("$TURBO_DEFAULT$")) continue;
    for (const target of exportTargets(manifest)) {
      for (const file of filesOfExportTarget(dir, target, tracked)) {
        if (inputsCover(inputs, dir, file, workspace)) continue;
        violations.push(
          `${pkg} exports "${target}", but the narrowed "inputs" of "${key}" do not hash ${file}, so its ` +
            `dependents keep a stale result when it changes: add a glob covering "${target.replace(/^\.\//, "")}" ` +
            `to the "inputs" of "${key}" in turbo.json`,
        );
      }
    }
  }
  return violations;
}

/** D. The folders the audio copy step ships into every plugin are hashed by `@iracedeck/audio-assets#build`. */
function checkShippedFolders(turbo, workspace, shippedFolders, tracked) {
  const pkg = "@iracedeck/audio-assets";
  const { dir } = workspace.get(pkg);
  const key = `${pkg}#build`;
  const inputs = taskConfig(turbo, pkg, "build")?.inputs;
  const violations = [];
  for (const folder of shippedFolders) {
    const missed = filesOfDirectory(`${dir}/${folder}`, tracked).filter(
      (file) => !inputsCover(inputs, dir, file, workspace),
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
function checkPluginSources(turbo, workspace, sources, plugins, tracked) {
  const violations = [];
  for (const pkg of plugins) {
    for (const { key, file, isDirectory } of sources) {
      const files = isDirectory ? filesOfDirectory(file, tracked) : [file];
      if (files.every((f) => isHashed(turbo, workspace, pkg, "build", f))) continue;
      const entry = isDirectory ? `${file}/**` : file;
      violations.push(
        `${pkg}#build copies SOURCES.${key} (${entry}), but turbo does not hash it for that task: ` +
          fixFor(turbo, workspace, pkg, "build", entry),
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

function isGitignored(file) {
  return spawnSync("git", ["check-ignore", "-q", file], { cwd: repoRoot }).status === 0;
}

function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
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
 * What one npm script reads, by the commands this repo uses: `entries`, the
 * files it RUNS (a `node` script, a Rollup or Astro config), and `programs`,
 * the files it COMPILES (a `tsc` program, the pages `astro` checks or bundles).
 * A command it cannot read is returned in `unrecognised`, which fails the
 * coverage guard — a new kind of build step has to be taught here rather than
 * skipped.
 */
function scriptReads(manifest, pkgDir, scriptName, tracked, depth = 0) {
  const result = { entries: [], programs: [], unrecognised: [] };
  const script = manifest.scripts?.[scriptName];
  if (script === undefined || depth > 5) return result;
  for (const segment of script.split("&&").map((s) => s.trim())) {
    const [command, ...args] = segment.split(/\s+/);
    const positional = args.filter((a) => !a.startsWith("-"));
    const firstExisting = (...candidates) =>
      candidates.map((c) => path.posix.join(pkgDir, c)).find((c) => existsSync(path.join(repoRoot, c)));
    if (/["'`|;<>$]/.test(segment)) {
      result.unrecognised.push(segment);
    } else if (command === "tsc") {
      const project = args[args.findIndex((a) => a === "-p" || a === "--project") + 1];
      const tsconfig = args.includes("-p") || args.includes("--project") ? project : "tsconfig.json";
      result.programs.push(...tsconfigProgram(path.join(repoRoot, pkgDir, tsconfig)));
    } else if ((command === "node" || command === "tsx") && positional.length > 0) {
      result.entries.push(path.posix.join(pkgDir, positional[0]));
    } else if (command === "rollup" && (args.includes("-c") || args.includes("--config"))) {
      const explicit = args[args.findIndex((a) => a === "-c" || a === "--config") + 1];
      const config =
        explicit && !explicit.startsWith("-")
          ? path.posix.join(pkgDir, explicit)
          : firstExisting("rollup.config.mjs", "rollup.config.js", "rollup.config.ts");
      if (config) result.entries.push(config);
      else result.unrecognised.push(segment);
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
        ...tsconfigProgram(path.join(repoRoot, pkgDir, "tsconfig.json")),
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
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
}

/**
 * Every file reachable by import from `entries`, mapped to the chain that
 * reaches it. Imports are read with TypeScript's preprocessor, so comments and
 * strings are skipped exactly as the compiler skips them, and static imports,
 * re-exports, `import("…")` and `require("…")` with a literal are all found.
 * Bare specifiers are followed only into workspace packages, through their
 * `exports`; external packages are hashed through the lockfile.
 */
function walkImports(entries, workspace, isGitignored) {
  const reads = new Map();
  const unresolved = [];
  const queue = entries.map((entry) => ({ file: entry, via: [entry] }));
  while (queue.length > 0) {
    const { file, via } = queue.shift();
    if (reads.has(file)) continue;
    reads.set(file, via);
    const abs = path.join(repoRoot, file);
    if (!CODE_EXTENSIONS.has(path.extname(file)) || file.endsWith(".d.ts") || !existsSync(abs)) continue;
    const { importedFiles } = ts.preProcessFile(readFileSync(abs, "utf-8"), true, true);
    for (const { fileName: specifier } of importedFiles) {
      let target;
      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(abs, specifier);
        if (!resolved) {
          // A gitignored target is generated by an earlier step of the same
          // script (the website's icon gallery); anything else is a walk bug.
          const missing = repoRelative(path.resolve(path.dirname(abs), specifier.split("?")[0]));
          if (!isGitignored(missing)) unresolved.push(`${file} imports "${specifier}"`);
          continue;
        }
        target = repoRelative(resolved);
      } else {
        // An external package resolves to nothing and is skipped. A workspace
        // target that is data, or a `dist/` entry not built yet, is still
        // recorded as read: its package's build must be in this task's hash.
        target = resolveWorkspaceSpecifier(specifier, workspace);
        if (target === undefined) continue;
      }
      if (!reads.has(target)) queue.push({ file: target, via: [...via, target] });
    }
  }
  return { reads, unresolved };
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
const walked = taskScripts
  .filter(({ entries }) => entries.length > 0)
  .map(({ pkg, task, entries }) => ({ pkg, task, verb: "runs", ...walkImports(entries, workspace, isGitignored) }));
const compiled = taskScripts
  .filter(({ programs }) => programs.length > 0)
  .map(({ pkg, task, programs }) => ({
    pkg,
    task,
    verb: "compiles",
    ...walkImports(programs, workspace, isGitignored),
  }));
const pluginSources = Object.entries(SOURCES)
  .filter(([key]) => !SOURCES_NOT_READ.has(key))
  .map(([key, absPath]) => ({
    key,
    file: repoRelative(absPath),
    isDirectory: existsSync(absPath) && statSync(absPath).isDirectory(),
  }));

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

    it("reads default inputs as the package's own files", () => {
      expect(inputsCover(undefined, "packages/a", "packages/a/src/x.ts", ws)).toBe(true);
      expect(inputsCover(undefined, "packages/a", "packages/b/src/x.ts", ws)).toBe(false);
      expect(inputsCover(undefined, "", "scripts/x.mjs", ws)).toBe(true);
      expect(inputsCover(undefined, "", "packages/a/x.mjs", ws)).toBe(false);
    });

    it("reads narrowed inputs, $TURBO_ROOT$, $TURBO_DEFAULT$ and negations", () => {
      const inputs = ["src/*.mjs", "!src/*.test.*", "$TURBO_ROOT$/LICENSE"];
      expect(inputsCover(inputs, "packages/a", "packages/a/src/x.mjs", ws)).toBe(true);
      expect(inputsCover(inputs, "packages/a", "packages/a/src/x.test.mjs", ws)).toBe(false);
      expect(inputsCover(inputs, "packages/a", "packages/a/other.mjs", ws)).toBe(false);
      expect(inputsCover(inputs, "packages/a", "packages/a/package.json", ws)).toBe(true);
      expect(inputsCover(inputs, "packages/a", "LICENSE", ws)).toBe(true);
      expect(inputsCover(["$TURBO_DEFAULT$"], "packages/a", "packages/a/other.mjs", ws)).toBe(true);
    });

    it("follows dependsOn into the dependencies' tasks, and a per-package entry replaces the generic one", () => {
      const config = {
        tasks: { build: { dependsOn: ["^build"] }, "b#build": { inputs: ["src/**"] } },
      };
      expect(isHashed(config, ws, "a", "build", "packages/b/src/x.ts")).toBe(true);
      expect(isHashed(config, ws, "a", "build", "packages/b/README.md")).toBe(false);
      expect(isHashed({ tasks: { build: {} } }, ws, "a", "build", "packages/b/src/x.ts")).toBe(false);
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
      const discovered = new Set(walked.map(({ pkg, task }) => `${pkg}#${task}`));
      const missing = EXPECTED_WALKED_TASKS.filter((key) => !discovered.has(key));
      expect(missing, `the import walk lost these tasks: ${missing.join(", ")}`).toEqual([]);
    });

    it("compiles a program for every typecheck task", () => {
      const compiledKeys = new Set(compiled.map(({ pkg, task }) => `${pkg}#${task}`));
      const missing = taskScripts
        .filter(({ task }) => task === "typecheck")
        .map(({ pkg, task }) => `${pkg}#${task}`)
        .filter((key) => !compiledKeys.has(key));
      expect(missing, `no program was found for: ${missing.join(", ")}`).toEqual([]);
      expect(compiled.length).toBeGreaterThan(40);
    });

    it("resolves every relative import it meets", () => {
      const unresolved = [...walked, ...compiled].flatMap(({ unresolved: u }) => u);
      expect(unresolved, `the walk could not resolve: ${unresolved.join("; ")}`).toEqual([]);
    });

    it("every file reached from what a task runs is hashed by it", () => {
      const violations = checkBuildReachableImports(turbo, workspace, walked);
      expect(violations, violations.join("\n")).toEqual([]);
    });

    it("every file reached from what a task compiles is hashed by it", () => {
      const violations = checkBuildReachableImports(turbo, workspace, compiled);
      expect(violations, violations.join("\n")).toEqual([]);
    });

    it("positive control: reports a scripts/lib helper a plugin build runs", () => {
      const key = "@iracedeck/iracing-plugin-mirabox#build";
      const violations = checkBuildReachableImports(
        brokenConfig(withoutInput(key, "$TURBO_ROOT$/scripts/lib/rollup-logs.mjs")),
        workspace,
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
        workspace,
        walked,
      );
      const reported = violations.filter((v) => v.startsWith(`${key} runs packages/website/astro.config.mjs`));
      expect(reported.some((v) => v.includes("reads scripts/lib/changelog-fragments.mjs"))).toBe(true);
    });

    it("positive control: reports a scripts/lib helper a typecheck compiles", () => {
      const key = "@iracedeck/plugin-build#typecheck";
      const violations = checkBuildReachableImports(
        brokenConfig(withoutInput(key, "$TURBO_ROOT$/scripts/lib/rollup-logs.mjs")),
        workspace,
        compiled,
      );
      const reported = violations.filter((v) => v.startsWith(`${key} compiles`));
      expect(reported.length).toBeGreaterThan(0);
      expect(reported.every((v) => v.includes("reads scripts/lib/rollup-logs.mjs"))).toBe(true);
    });
  });

  describe("C. narrowed inputs cover the package's exports", () => {
    it("checks at least the one narrowed build task, audio-assets", () => {
      expect(turbo.tasks["@iracedeck/audio-assets#build"].inputs).not.toContain("$TURBO_DEFAULT$");
    });

    it("every export target of a narrowed build task is among its inputs", () => {
      const violations = checkNarrowedInputsCoverExports(turbo, workspace, tracked);
      expect(violations, violations.join("\n")).toEqual([]);
    });

    it("positive control: reports manifest.json and the catalog when their inputs are dropped", () => {
      const key = "@iracedeck/audio-assets#build";
      const violations = checkNarrowedInputsCoverExports(
        brokenConfig((c) => {
          withoutInput(key, "manifest.json")(c);
          withoutInput(key, "catalog/**")(c);
        }),
        workspace,
        tracked,
      );
      expect(violations.some((v) => v.includes('exports "./manifest.json"'))).toBe(true);
      expect(violations.some((v) => v.includes('exports "./catalog/*.json"'))).toBe(true);
    });
  });

  describe("D. the folders the audio copy ships", () => {
    it("reads SHIPPED_FOLDERS", () => {
      expect([...SHIPPED_FOLDERS]).toContain("sfx");
    });

    it("every shipped folder is hashed by @iracedeck/audio-assets#build", () => {
      const violations = checkShippedFolders(turbo, workspace, SHIPPED_FOLDERS, tracked);
      expect(violations, violations.join("\n")).toEqual([]);
    });

    it("positive control: reports sfx/ when its input is dropped", () => {
      const violations = checkShippedFolders(
        brokenConfig(withoutInput("@iracedeck/audio-assets#build", "sfx/**")),
        workspace,
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
      const violations = checkPluginSources(turbo, workspace, pluginSources, PLUGIN_PACKAGES, tracked);
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
        workspace,
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
