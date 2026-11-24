// No package reaches into another package's files by a relative path (#1375).
//
// A package's code reaches another package by its name — `@iracedeck/<pkg>`,
// or `@iracedeck/<pkg>/testing` for a test that needs a real implementation
// past a mocked barrel (`action-tests.md`). A relative path into a sibling's
// `src/` instead bypasses its `exports`, its build and its declared dependency
// edge, and copies itself into every new test written beside it: #1375 found
// eighteen iracing-actions tests importing
// `../../../../deck-core/src/dial-gesture.js` and its like, plus audio-scenarios'
// caution test reading two sim-events-iracing captures by such a path, and
// removed them. This keeps them from growing back.
//
// For every tracked source under `packages/<pkg>/` (`trackedPackageSources`,
// which leaves out `dist/`, plugin bundle folders and vendored files), the
// website's `.astro` components and `.mdx` pages included and read by their
// module code alone — an `.astro` frontmatter and `<script>` bodies, an `.mdx`
// page's import and export blocks (`moduleSources`, #1662) — every path the
// file names relative to itself is resolved and must not land inside
// `packages/<other>/`:
//   * a relative module specifier — import, export, dynamic import, `require`,
//     `import("…")` type, triple-slash `path` — read with `ts.preProcessFile`,
//     resolved against the file's directory;
//   * any other string literal starting `./` or `../` (a fixture path, a glob),
//     resolved against the file's directory and against the directory it runs
//     from (the repository root for a test, since the root suite runs every
//     test from there; the package root for anything else, where pnpm runs a
//     package's scripts and Rollup its config);
//   * a string starting `packages/`, resolved against the directory it runs
//     from, as `fs` opens it — so a test's `"packages/audio-assets/sfx/x.wav"`
//     is a reach, while the same string in a package's own test, or in a
//     non-test (which runs from its package root), is not;
//   * a path built from the file's own location by constants — `join` /
//     `resolve` / `dirname` from `node:path`, `fileURLToPath` and `new URL(…,
//     import.meta.url)`, `import.meta.dirname`, `__dirname`, `process.cwd()`,
//     template literals and `+`, through any `const` the file declares once —
//     so `join(import.meta.dirname, "..", "..", "app-constants", "src")` is the
//     same reach as the one-string spelling, and so is a path joined onto a
//     repo-root constant derived the same way. A `join` or `normalize` of plain
//     segments, or a constant string built any other way, is read as the one
//     string it makes. A `\` in any of these is read as `/`, as Node's `path`
//     reads it on Windows.
// A path that lands outside `packages/` — the root `scripts/lib/`, the root
// `changelog.d/`, the repository root itself, `packages/` as a whole — is not
// a reach. Neither is a path that cannot be worked out from constants (a
// function's parameter, a loop variable): this reads what the file says, not
// what it computes.
//
// ALLOWED names each file that reaches on purpose, the packages it reaches and
// why. A listed file that reaches a package its entry does not name fails; so
// does an entry whose file is gone or no longer reaches one of its packages.
// NAMED_NOT_OPENED names the exact `packages/…` strings a test records or
// compares as repo-relative names without opening them, with the same
// staleness check.
//
// A sim-neutral package must also load no sim package at runtime (#1662). The
// sim-neutral ESLint block (SIM_NEUTRAL_PACKAGES in eslint.config.js) matches
// static and type import specifiers only: a relative path launders a sim import
// past it — the website's icon-gallery generator imported iracing-actions' dial
// renderers by path, and they imported @iracedeck/iracing-sdk, whose native
// addon loads in module scope — and no-restricted-imports reads no dynamic
// `import()` or `require` at all. So every non-test source of a sim-neutral
// package that runs, in any extension, `.astro` components and `.mdx` pages
// included, is a root (`closureRoots`), and the files they load at runtime are
// walked as one closure (`runtimeClosure`, whose comments state each rule of
// the walk), every load form read (`runtimeImports`). The closure may load a
// workspace package only if that package is sim-neutral; a failure names the
// chain of files that leads to the import, so it says where to cut. The walk
// does not descend into a sim-neutral package by its specifier, because that
// package's own sources are roots themselves. A load the walk cannot follow
// fails, unless UNREAD_LOADS names it with the reason it loads nothing that is
// not sim-neutral. The ESLint block stays as the editor's early word on a
// static or type import.
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { SIM_NEUTRAL_PACKAGES } from "../eslint.config.js";
import {
  isModuleSource,
  isTestSource,
  markupLoads,
  moduleReferences,
  moduleSources,
  packageOf,
  trackedPackageSources,
  unclosedComment,
} from "./lib/source-imports.mjs";
import { trackedPackageDirs } from "./lib/workspace-packages.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const P = path.posix;

/**
 * The repository root in the virtual tree paths are resolved in. Unlike `/`,
 * a path that climbs above it cannot be clamped back into `packages/`.
 */
const REPO = "/@repo";

/**
 * Files that reach into another package on purpose: the packages each one
 * reaches (directory names under `packages/`) and the reason.
 */
const ALLOWED = {
  "packages/plugin-build/src/plugin-rollup.mjs": {
    reaches: ["icons", "iracing-actions", "iracing-plugin-stream-deck", "plugin-runtime", "rasterizer"],
    reason:
      "the shared plugin Rollup config (#1349). Its TypeScript include globs `../iracing-actions/src/**/*.ts` and " +
      "`../plugin-runtime/src/**/*.ts` are relative to the calling plugin's directory and compile the two " +
      "raw-TypeScript packages into each bundle; its SOURCES copy the action PI templates, the icons package, the " +
      "rasterizer's fonts and the Elgato plugin's category art into every plugin folder, anchored on the repo root " +
      "because the factory runs from plugin-build rather than from the plugin",
  },
  "packages/website/scripts/generate-icon-gallery.mts": {
    reaches: ["icons", "iracing-actions", "iracing-plugin-stream-deck"],
    reason:
      "renders the website's icon gallery from the icon SVGs, the dial strips from iracing-actions' own render " +
      "functions and the action list from the Elgato manifest; the website declares iracing-actions for build " +
      "ordering only, held by scripts/website-workspace-deps.test.mjs (#1458). The website is sim-neutral, so the " +
      "files this reach loads must stay sim-free: the runtime-closure check below holds it (#1662)",
  },
  "packages/diagnostics/src/cpu-profile-capture.test.ts": {
    reaches: ["app-constants"],
    reason:
      "transpiles the capture module with its one workspace import, app-constants, into a temp directory and runs it " +
      "in a child process, which cannot resolve the workspace package by name",
  },
  "packages/diagnostics/src/main-thread-watchdog.test.ts": {
    reaches: ["plugin-build"],
    reason:
      "resolves the plugins' own terser through plugin-build, the package that declares @rollup/plugin-terser, to " +
      "minify the watchdog the way the plugins ship it. It stays undeclared on purpose: declaring plugin-build would " +
      "make diagnostics' build and typecheck (turbo's ^build) wait on plugin-build's whole chain, including " +
      "audio-assets#build's ffmpeg encode over every clip, for one test",
  },
  "packages/iracing-actions/src/actions/dial-surface-base-coverage.test.ts": {
    reaches: ["iracing-plugin-stream-deck"],
    reason:
      "reads the Elgato manifest for the actions that declare the Encoder controller, so every dial action's folder " +
      "holds a dial surface on the shared base and every surface's action is a dial",
  },
  "packages/iracing-actions/src/actions/press-shape-coverage.test.ts": {
    reaches: ["iracing-plugin-stream-deck"],
    reason:
      "reads the Elgato manifest for the actions that declare the Encoder controller, each of which must declare " +
      "dialPressShape",
  },
  "packages/replay-engine/src/camera-switch-waiter.single-policy.test.ts": {
    reaches: ["iracing-actions", "iracing-sdk"],
    reason:
      "scans iracing-actions' sources and iracing-sdk's CameraCommand for camera switches, so the engine's waiter " +
      "stays the one policy for them",
  },
  "packages/replay-engine/src/replay-command-gate.single-sender.test.ts": {
    reaches: ["iracing-actions"],
    reason: "scans iracing-actions' sources so the engine's command gate stays the one sender of replay commands",
  },
  "packages/voice-packs/src/voice-pack-no-window.test.ts": {
    reaches: ["app-constants", "callout-script", "fetch-utils"],
    reason:
      "holds the voice-pack modules that live in callout-script, fetch-utils and app-constants to the same " +
      "no-window source rule as its own (#1034); they run on the install and catalog paths while iRacing is running",
  },
};

/**
 * Paths into another package that a test spells as a repo-relative name it
 * never opens — provenance it records or compares — each file with the exact
 * paths and the reason. Exact, so any other path into that package still fails.
 */
const NAMED_NOT_OPENED = {
  "packages/audio-scenarios/src/reference/pack-reference.test.ts": {
    paths: ["packages/audio-assets/voice/default/callouts.json"],
    reason:
      "hands buildPackReference the repo-relative source paths the generator records as `_meta.generatedFrom`, " +
      "and checks they come back unchanged; the test never reads the file",
  },
  "packages/website/src/pack-reference-types.test.ts": {
    paths: ["packages/audio-assets/voice/default/callouts.json"],
    reason:
      "asserts the committed pack reference names audio-assets' callouts.json among its `_meta.generatedFrom` " +
      "provenance; the test never reads the file",
  },
};

/**
 * Loads in a sim-neutral package's runtime closure that the walk cannot follow
 * and that load no workspace package which is not sim-neutral (#1662): each
 * file with the exact calls, as `runtimeImports` spells them, and the reason.
 * A call is excused as many times as the file makes it: once, or `count` times
 * when it is written `{ call, count }`. Exact, so any other unread load in that
 * file still fails, and so does a second call site spelled the same, and an
 * entry whose call is gone or made another number of times fails too.
 */
const UNREAD_LOADS = {
  "packages/audio-native/src/index.ts": {
    calls: ['require(join(__dirname, "..", "build", "Release", "audio_native.node"))'],
    reason: "loads the package's own compiled native addon, a binary that imports no JavaScript module",
  },
  "packages/audio-native/scripts/reroute-probe.mjs": {
    calls: ["import(pathToFileURL(entryPath).href)"],
    reason:
      "the hand-run reroute probe (#1411) loads its own package's built dist/index.js, the build of " +
      "packages/audio-native/src/index.ts, which is a root of the walk itself",
  },
  "packages/diagnostics/src/main-thread-watchdog.ts": {
    calls: ["require(id)"],
    reason:
      "the watchdog worker's body loads Node builtins by name (node:worker_threads, node:fs), through require " +
      "or process.getBuiltinModule, since an eval worker cannot import",
  },
  "packages/pi-components/src/build/callout-pi-groups.mjs": {
    calls: ["import(entryUrl)"],
    reason:
      'imports what import.meta.resolve("@iracedeck/callout-settings") names, a sim-neutral package, in a child ' +
      "process so Rollup's watch mode reads the registry fresh each build",
  },
};

/**
 * The problems of a walk that UNREAD_LOADS does not excuse, and a line for each
 * entry whose call the walk finds another number of times than it allows: none
 * at all, which is stale, or more or fewer, when none of them is excused.
 */
export function unexcusedProblems(problems, unreadLoads) {
  const excused = new Set();
  const lines = [];

  for (const [file, { calls }] of Object.entries(unreadLoads)) {
    for (const entry of calls) {
      const { call, count = 1 } = typeof entry === "string" ? { call: entry } : entry;
      const made = `${file} makes ${call}, `;
      const found = problems.flatMap((problem, at) =>
        problem.startsWith(made) || problem.includes(` → ${made}`) ? [at] : [],
      );

      if (found.length === count) {
        for (const at of found) excused.add(at);
      } else if (found.length === 0) {
        lines.push(`UNREAD_LOADS says ${file} makes ${call}, but the walk no longer finds it: remove it`);
      } else {
        lines.push(
          `UNREAD_LOADS says ${file} makes ${call} ${count} time(s), but the walk finds it ${found.length} times: ` +
            "excuse each call site the entry's reason holds for, and no other",
        );
      }
    }
  }

  return [...problems.filter((_problem, at) => !excused.has(at)), ...lines];
}

/** A relative module specifier: `./x`, `../x`, `.` or `..`. */
const RELATIVE_SPECIFIER = /^\.\.?(\/|$)/;

/** A string literal read as a relative path. */
const RELATIVE_LITERAL = /^\.\.?\//;

/**
 * A string read as a path relative to the directory the code runs from, as
 * `fs` opens one: `packages/…`. Only a test can reach a sibling this way, since
 * it runs from the repository root; from a package root it names the package's
 * own (nonexistent) `packages/` folder.
 */
const RUN_DIR_LITERAL = /^packages\//;

/** `text` with Windows separators turned into `/`, as Node's `path` reads them on Windows. */
const forwardSlashes = (text) => text.replaceAll("\\", "/");

const PATH_MODULES = new Set(["path", "node:path", "path/posix", "node:path/posix"]);
const URL_MODULES = new Set(["url", "node:url"]);

function scriptKind(file) {
  // An .astro component's frontmatter is TypeScript; an .mdx page's ESM may hold JSX.
  if (file.endsWith(".astro")) return ts.ScriptKind.TS;
  if (/\.[cm]?tsx$|\.mdx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(file)) return ts.ScriptKind.TS;
  if (/\.[cm]?jsx$/.test(file)) return ts.ScriptKind.JSX;

  return ts.ScriptKind.JS;
}

/** `node` without the parentheses, `as`, `satisfies` and `!` around it. */
function unwrap(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }

  return node;
}

/**
 * The names `sf` gives `node:path` and `node:url` and their functions: a
 * default or namespace import (`path`), a named import (`join`, or its alias),
 * or a `require` of either into a `const`.
 */
function moduleBindings(sf) {
  const pathModules = new Set();
  const urlModules = new Set();
  const functions = new Map();
  const bind = (moduleName, local, imported) => {
    const isPath = PATH_MODULES.has(moduleName);

    if (!isPath && !URL_MODULES.has(moduleName)) return;
    if (imported === undefined) (isPath ? pathModules : urlModules).add(local);
    else functions.set(local, imported);
  };

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const moduleName = statement.moduleSpecifier.text;
      const clause = statement.importClause;

      if (clause?.name) bind(moduleName, clause.name.text);
      const bindings = clause?.namedBindings;

      if (bindings && ts.isNamespaceImport(bindings)) bind(moduleName, bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          bind(moduleName, element.name.text, (element.propertyName ?? element.name).text);
        }
      }
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer && unwrap(declaration.initializer);

        if (!init || !ts.isCallExpression(init) || init.expression.getText(sf) !== "require") continue;
        const [argument] = init.arguments;

        if (!argument || !ts.isStringLiteralLike(argument)) continue;
        if (ts.isIdentifier(declaration.name)) bind(argument.text, declaration.name.text);
        if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const imported =
              element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName : element.name;

            bind(argument.text, element.name.text, imported.text);
          }
        }
      }
    }
  }

  return { pathModules, urlModules, functions };
}

/** Each `const` the file declares exactly once by a plain name → its initializer. */
function constInitializers(sf) {
  const found = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const
    ) {
      found.set(node.name.text, found.has(node.name.text) ? null : node.initializer);
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);

  return found;
}

/**
 * Every path inside the repository that `file` names relative to itself or to
 * the directory it runs from, repo-relative with `/` separators and sorted. A
 * path is a module specifier, a `./` or `../` string literal, or a path the
 * file builds from its own location by constants (the header says which), read
 * in each of its modules (`moduleSources`). Pure: `source` is the file's text,
 * so the positive controls can plant one.
 *
 * @param {object} input
 * @param {string} input.file repo-relative, `/`-separated (`packages/<pkg>/…`)
 * @param {string} input.source
 * @returns {string[]}
 */
export function pathsNamed({ file, source: text }) {
  return [...new Set(moduleSources(file, text).flatMap((source) => modulePathsNamed(file, source)))].sort();
}

/** The paths one module of `file`, whose text laid out at the file's offsets is `source`, names. */
function modulePathsNamed(file, source) {
  const pkg = file.split("/")[1];
  const fileAbs = `${REPO}/${file}`;
  const dir = P.dirname(fileAbs);
  const runDir = isTestSource(file) ? REPO : `${REPO}/packages/${pkg}`;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const { pathModules, urlModules, functions } = moduleBindings(sf);
  const consts = constInitializers(sf);
  const named = new Set();
  const note = (abs) => {
    if (abs === REPO || abs.startsWith(`${REPO}/`)) named.add(P.relative(REPO, abs));
  };

  const specifierAt = new Set();

  for (const reference of moduleReferences(source)) {
    if (reference.kind === "import") specifierAt.add(reference.pos);
    if (reference.kind === "reference" || RELATIVE_SPECIFIER.test(reference.specifier)) {
      note(P.resolve(dir, reference.specifier));
    }
  }

  /** The `node:path` or `node:url` function a call's callee names, or undefined. */
  const calleeFunction = (callee) => {
    if (ts.isIdentifier(callee)) return functions.get(callee.text);
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const object = unwrap(callee.expression);
    const name = callee.name.text;
    const ofPath = (node) =>
      (ts.isIdentifier(node) && pathModules.has(node.text)) ||
      (ts.isPropertyAccessExpression(node) &&
        ["posix", "win32"].includes(node.name.text) &&
        ofPath(unwrap(node.expression)));

    if (ofPath(object)) return name;
    if (ts.isIdentifier(object) && urlModules.has(object.text)) return name;

    return undefined;
  };

  /**
   * What `node` evaluates to as a path: `{ abs, dir }` for a location in the
   * virtual tree (`dir` when it names a directory as a URL would), `{ seg }` for
   * a string that is not anchored yet, or undefined when constants cannot say.
   */
  const evaluate = (node, depth = 0) => {
    if (depth > 32) return undefined;
    node = unwrap(node);

    if (ts.isStringLiteralLike(node)) return { seg: forwardSlashes(node.text) };

    // Only a property access or an argument-less call can spell one of these, so a large node is never stringified.
    const text =
      ts.isPropertyAccessExpression(node) || (ts.isCallExpression(node) && node.arguments.length === 0)
        ? node.getText(sf).replace(/\s+/g, "")
        : "";

    if (text === "import.meta.dirname") return { abs: dir, dir: true };
    if (text === "import.meta.filename" || text === "import.meta.url") return { abs: fileAbs, dir: false };
    if (text === "process.cwd()") return { abs: runDir, dir: true };

    if (ts.isIdentifier(node)) {
      const init = consts.get(node.text);

      if (init) return evaluate(init, depth + 1);
      if (node.text === "__dirname") return { abs: dir, dir: true };
      if (node.text === "__filename") return { abs: fileAbs, dir: false };

      return undefined;
    }

    if (ts.isPropertyAccessExpression(node) && ["href", "pathname"].includes(node.name.text)) {
      return evaluate(node.expression, depth + 1);
    }

    if (ts.isNewExpression(node) && node.expression.getText(sf) === "URL" && node.arguments?.length === 2) {
      const [segment, base] = node.arguments.map((argument) => evaluate(argument, depth + 1));

      if (segment?.seg === undefined || base?.abs === undefined) return undefined;

      return {
        abs: P.resolve(base.dir ? base.abs : P.dirname(base.abs), segment.seg),
        dir: /(^|\/)\.{0,2}$/.test(segment.seg),
      };
    }

    if (
      ts.isTemplateExpression(node) ||
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      const parts = ts.isTemplateExpression(node)
        ? [
            { seg: forwardSlashes(node.head.text) },
            ...node.templateSpans.flatMap((span) => [
              evaluate(span.expression, depth + 1),
              { seg: forwardSlashes(span.literal.text) },
            ]),
          ]
        : [evaluate(node.left, depth + 1), evaluate(node.right, depth + 1)];

      if (parts.some((part) => part === undefined)) return undefined;
      const anchored = parts.filter((part) => part.seg !== "");

      if (anchored.slice(1).some((part) => part.abs !== undefined)) return undefined;
      const joined = parts.map((part) => part.abs ?? part.seg).join("");

      return anchored[0]?.abs === undefined ? { seg: joined } : { abs: P.normalize(joined), dir: joined.endsWith("/") };
    }

    if (ts.isCallExpression(node)) {
      const fn = calleeFunction(node.expression);

      if (fn === undefined) return undefined;
      const args = node.arguments.map((argument) => evaluate(argument, depth + 1));

      if (args.some((arg) => arg === undefined)) return undefined;
      const values = args.map((arg) => arg.abs ?? arg.seg);

      switch (fn) {
        case "fileURLToPath":
        case "pathToFileURL":
          return args[0]?.abs === undefined ? undefined : { abs: P.normalize(args[0].abs), dir: args[0].dir };
        case "normalize":
          if (args[0]?.abs !== undefined) return { abs: P.normalize(args[0].abs), dir: args[0].dir };

          return args[0]?.seg === undefined ? undefined : { seg: P.normalize(args[0].seg) };
        case "dirname":
          return args[0]?.abs === undefined ? undefined : { abs: P.dirname(args[0].abs), dir: true };
        case "join":
          if (args[0]?.abs !== undefined) return { abs: P.join(...values), dir: false };

          // Plain segments join to a relative path, read as a string literal would be.
          return args.length > 0 && args.every((arg) => arg.abs === undefined) ? { seg: P.join(...values) } : undefined;
        case "resolve":
          // A relative first segment resolves against the directory the code runs from, as Node's does.
          return { abs: P.resolve(runDir, ...values), dir: false };
        default:
          return undefined;
      }
    }

    return undefined;
  };

  /**
   * A path the file spells without anchoring it: `./` or `../` against the
   * file's directory and the run directory, `packages/…` against the run
   * directory, as `fs` and `path.resolve` read it.
   */
  const noteUnanchored = (seg) => {
    if (RELATIVE_LITERAL.test(seg)) {
      note(P.resolve(dir, seg));
      note(P.resolve(runDir, seg));
    } else if (RUN_DIR_LITERAL.test(seg)) {
      note(P.resolve(runDir, seg));
    }
  };

  const visit = (node, insidePath) => {
    let inside = insidePath;

    if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isTemplateExpression(node) ||
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      const value = evaluate(node);

      if (value?.abs !== undefined) {
        note(value.abs);
        inside = true;
      } else if (value?.seg !== undefined && !inside) {
        noteUnanchored(value.seg);
        inside = true;
      }
    } else if (ts.isStringLiteralLike(node) && !inside && !specifierAt.has(node.getStart(sf))) {
      noteUnanchored(forwardSlashes(node.text));
    }

    ts.forEachChild(node, (child) => visit(child, inside));
  };

  visit(sf, false);

  return [...named];
}

/**
 * The packages other than its own that `file` reaches into: package directory
 * → the paths inside it, sorted. `packages` is the set of package directory
 * names; a path under `packages/` that names none of them is no package's.
 */
export function reachesOf({ file, source, packages }) {
  const own = file.split("/")[1];
  const reaches = new Map();

  for (const named of pathsNamed({ file, source })) {
    const [top, pkg] = named.split("/");

    if (top !== "packages" || pkg === undefined || pkg === own || !packages.has(pkg)) continue;
    if (!reaches.has(pkg)) reaches.set(pkg, []);
    reaches.get(pkg).push(named);
  }

  return new Map([...reaches].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Every way the reaches found disagree with `allowed`, one line each; empty
 * when they agree.
 *
 * @param {Map<string, Map<string, string[]>>} found file → its reaches (files with none may be left out)
 * @param {Record<string, { reaches: string[], reason: string }>} allowed
 * @param {Set<string>} files every file scanned
 * @param {Record<string, { paths: string[], reason: string }>} [namedNotOpened] exact paths a file names but never opens
 * @returns {string[]}
 */
export function reachProblems(found, allowed, files, namedNotOpened = {}) {
  const problems = [];

  for (const [file, reaches] of found) {
    for (const [pkg, named] of reaches) {
      const paths = named.filter((p) => !namedNotOpened[file]?.paths.includes(p));

      if (paths.length === 0 || allowed[file]?.reaches.includes(pkg)) continue;
      problems.push(
        `${file} reaches into packages/${pkg}/ by a relative path (${paths.join(", ")}): import it by package name — ` +
          `a test that needs a real implementation past a mocked barrel takes it from @iracedeck/${pkg}/testing ` +
          `(action-tests.md) — or, if the reach is deliberate, name the file in ALLOWED with the reason`,
      );
    }
  }

  for (const [file, { reaches }] of Object.entries(allowed)) {
    if (!files.has(file)) {
      problems.push(`ALLOWED names ${file}, which is not a tracked package source any more: remove the entry`);
      continue;
    }

    for (const pkg of reaches) {
      if (!found.get(file)?.has(pkg)) {
        problems.push(
          `ALLOWED says ${file} reaches packages/${pkg}/, but it no longer does: remove ${pkg} from the entry`,
        );
      }
    }
  }

  for (const [file, { paths }] of Object.entries(namedNotOpened)) {
    if (!files.has(file)) {
      problems.push(`NAMED_NOT_OPENED names ${file}, which is not a tracked package source any more: remove the entry`);
      continue;
    }

    const named = [...(found.get(file)?.values() ?? [])].flat();

    for (const p of paths) {
      if (!named.includes(p)) {
        problems.push(`NAMED_NOT_OPENED says ${file} names ${p}, but it no longer does: remove it from the entry`);
      }
    }
  }

  return problems;
}

/** The modules `createRequire` comes from. */
const CREATE_REQUIRE_MODULES = new Set(["module", "node:module"]);

/** The methods of a function that call it, and so would load through a require function. */
const CALLING_METHODS = new Set(["call", "apply", "bind"]);

/** `node` and the parentheses, `as`, `satisfies` and `!` around it, outermost. */
function wrapped(node) {
  while (
    node.parent &&
    (ts.isParenthesizedExpression(node.parent) ||
      ts.isAsExpression(node.parent) ||
      ts.isNonNullExpression(node.parent) ||
      ts.isSatisfiesExpression(node.parent))
  ) {
    node = node.parent;
  }

  return node;
}

/** The spellings of the file's own location, as a `createRequire` base: its path or its URL. */
const OWN_LOCATION = new Set(["import.meta.url", "import.meta.filename", "__filename"]);

/** The functions that turn a path into a URL or back, which keep a base the file's own. */
const LOCATION_CONVERTERS = new Set(["pathToFileURL", "fileURLToPath"]);

/**
 * True when `node`, a `createRequire` argument, is literally the file's own
 * location (#1662): `import.meta.url`, `import.meta.filename`, `__filename`,
 * either passed through `pathToFileURL` or `fileURLToPath` (by name or as a
 * property, `url.pathToFileURL(…)`), or the `.href` of such a URL. A require
 * function made from it resolves a relative load beside the file, where the
 * walk resolves it. Any other base — another file's URL, a directory such as
 * `import.meta.dirname` (which `createRequire` reads as a file, so its relative
 * loads resolve from the parent) or a computed one — is not.
 */
function isOwnBase(node) {
  node = unwrap(node);
  if (OWN_LOCATION.has(node.getText().replace(/\s+/g, ""))) return true;
  if (ts.isPropertyAccessExpression(node) && node.name.text === "href") return isOwnBase(node.expression);
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return false;
  const callee = unwrap(node.expression);
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;

  return LOCATION_CONVERTERS.has(name) && isOwnBase(node.arguments[0]);
}

/**
 * The require functions of `sf` (#1662): the names that load the module their
 * call names — `require` itself and every name the file binds to the result of
 * a `createRequire(…)` call — and a test for such a call. `createRequire` is the
 * name, or the alias of one imported from `node:module` or `module` (or taken
 * from it by destructuring), or any `.createRequire` property, so
 * `module.createRequire(…)` counts. Names are file-wide, not scoped: a shadowing
 * name reads as the require function too, which can only fail a file, never pass one.
 *
 * `requireNames` maps each name to whether its base is the file's own
 * location (`isOwnBase`; `require` itself always is), so a relative load
 * through it resolves where the walk looks. A name bound more than once is
 * own-based only if every binding is.
 */
function requireFunctions(sf) {
  const createRequireNames = new Set(["createRequire"]);
  const findCreateRequire = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      CREATE_REQUIRE_MODULES.has(node.moduleSpecifier.text) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        if ((element.propertyName ?? element.name).text === "createRequire") createRequireNames.add(element.name.text);
      }
    }
    if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      (node.propertyName ?? node.name).getText(sf) === "createRequire"
    ) {
      createRequireNames.add(node.name.text);
    }
    ts.forEachChild(node, findCreateRequire);
  };

  findCreateRequire(sf);
  const isCreateRequire = (node) => {
    if (!ts.isCallExpression(node)) return false;
    const callee = unwrap(node.expression);

    return (
      (ts.isIdentifier(callee) && createRequireNames.has(callee.text)) ||
      (ts.isPropertyAccessExpression(callee) && callee.name.text === "createRequire")
    );
  };
  /** True when a `createRequire(…)` call's base is the file's own location. */
  const madeHere = (call) => call.arguments.length === 1 && isOwnBase(call.arguments[0]);
  const requireNames = new Map([["require", true]]);
  const findHolders = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isCreateRequire(unwrap(node.initializer))
    ) {
      const here = madeHere(unwrap(node.initializer));

      requireNames.set(node.name.text, (requireNames.get(node.name.text) ?? true) && here);
    }
    ts.forEachChild(node, findHolders);
  };

  findHolders(sf);
  /**
   * True when `node` names the `createRequire` factory itself: one of its
   * names, or any `.createRequire` property.
   */
  const isFactory = (node) =>
    (ts.isIdentifier(node) && createRequireNames.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) && node.name.text === "createRequire");

  return { requireNames, isCreateRequire, madeHere, isFactory };
}

/**
 * True when a `createRequire(…)` call's result is used only in a way the walk
 * reads: held by a variable of a plain name (a require name then), called on
 * the spot, or asked for a property other than one that calls it
 * (`createRequire(…).resolve(…)` loads nothing).
 */
function heldOrCalled(call) {
  const outer = wrapped(call);
  const parent = outer.parent;

  return (
    (ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isIdentifier(parent.name)) ||
    (ts.isCallExpression(parent) && parent.expression === outer) ||
    (ts.isPropertyAccessExpression(parent) && parent.expression === outer && !CALLING_METHODS.has(parent.name.text))
  );
}

/**
 * True when a reference to a require name hands the function on rather than
 * calling it — passed, returned, assigned, shorthand into an object, exported —
 * so a load through it cannot be read. A call, a property other than one that
 * calls it (`require.resolve`, `require.main`), `typeof`, a type position and
 * the name's own declaration are not.
 */
function escapes(id) {
  const parent = id.parent;

  if (ts.isShorthandPropertyAssignment(parent) || ts.isExportSpecifier(parent)) return true;
  if (parent.name === id || parent.propertyName === id) return false;
  for (let at = parent; at !== undefined; at = at.parent) if (ts.isTypeNode(at)) return false;
  const outer = wrapped(id);
  const user = outer.parent;

  if (ts.isCallExpression(user) && user.expression === outer) return false;
  if (ts.isPropertyAccessExpression(user) && user.expression === outer) return CALLING_METHODS.has(user.name.text);

  return !ts.isTypeOfExpression(user);
}

/** A Vite import query that hands over a file's text or URL rather than running it. */
const DATA_QUERY = /^\?(raw|url)$/;

/**
 * True when a Vite `import.meta.glob(…)` call loads no module code, so it is a
 * leaf as a `.json` or `.svg` import is (#1662): its patterns are string
 * literals, and either its `query` option is `?raw` or `?url`, or every pattern
 * that is not an exclusion (`!…`) ends in an extension, or a `{a,b}` set of
 * them, each written as itself (no `[…]`, `?`, `*` or extglob in it) and
 * holding no module code (`isDataSpecifier`). The website's
 * components glob their images and brand marks this way. Any other glob is one
 * this check does not expand.
 */
function isDataGlob(call) {
  const [patterns, options] = call.arguments.map(unwrap);
  const literals = patterns && ts.isArrayLiteralExpression(patterns) ? patterns.elements.map(unwrap) : [patterns];

  if (literals.length === 0 || !literals.every((pattern) => pattern && ts.isStringLiteralLike(pattern))) return false;
  const query =
    options &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText() === "query" &&
        ts.isStringLiteralLike(property.initializer),
    );

  if (query && DATA_QUERY.test(query.initializer.text)) return true;

  const included = literals.map((pattern) => pattern.text).filter((pattern) => !pattern.startsWith("!"));

  return (
    included.length > 0 &&
    included.every((pattern) => {
      const extensions = /\.(?:\{([^{}/]+)\}|([^./{}*]+))$/.exec(pattern);

      return (
        extensions !== null &&
        (extensions[1]?.split(",") ?? [extensions[2]])
          .map((extension) => extension.trim())
          // A literal extension only: `[jt]s`, `?s`, `@(png|ts)` match module code as readily as data.
          .every((extension) => LITERAL_EXTENSION.test(extension) && isDataSpecifier(`./x.${extension}`))
      );
    })
  );
}

/** A file extension written as itself, with no glob metacharacter in it. */
const LITERAL_EXTENSION = /^[\w-]+$/;

/**
 * The module specifiers `source` loads when it runs, and the module references
 * it makes that this cannot follow (#1662). Read from TypeScript's syntax tree,
 * so a comment or a string that merely mentions a package is no edge.
 *
 * What loads: `import … from`, `export … from` (`export *` included), a
 * side-effect `import "x"`, `import x = require("x")`, and a dynamic
 * `import("x")` or `require("x")` with a literal specifier, where `require` is
 * any require function of the file (`requireFunctions`): `require` itself, a
 * name holding a `createRequire(…)` result whatever it is called, or that
 * result called on the spot. A relative load through a require function made
 * from another base than the file's own location (`isOwnBase`) is reported
 * rather than followed, since it resolves somewhere else; a package name loaded
 * through one is read as loading that package, since the base can change only
 * which copy of it resolves, not which package it is. What does not:
 * `import type`, `export type`, `import type x = require()` and the type
 * `import("x").T`, which TypeScript and esbuild drop whatever the config.
 *
 * Any other import counts as loading, even when every name it binds is marked
 * `type` (`import { type A } from "x"`) or none is used as a value. Whether
 * those are dropped depends on the tsconfig governing the file: tsx applies the
 * website's (Astro's `verbatimModuleSyntax`) to the website's own files, where
 * `import { type A } from "x"` stays as `import {} from "x"` and loads `x`,
 * and TypeScript's default to the files it reaches outside the website, where
 * it is dropped (measured with the website's tsx on 2026-11-24). This check
 * does not model which config governs which file, so it reads them as loading;
 * the fix for a red it gives is `import type`. A mixed `import { type A, b }`
 * loads under either.
 *
 * A dynamic import or `require` whose specifier is not a literal cannot be
 * followed, so it is reported rather than skipped, and so is any module
 * reference `ts.preProcessFile` finds that the tree walk did not classify:
 * an edge this cannot read fails instead of passing unseen. So does a require
 * function handed on rather than called (`escapes`, `heldOrCalled`), since a
 * load through it is out of sight, and so does the `createRequire` factory
 * itself (`isFactory`), since a require function an alias of it makes is one
 * under a name this does not know, a Vite `import.meta.glob(…)` of module
 * code, which this does not expand (one of data files is a leaf,
 * `isDataGlob`), and an
 * `import(` or `require(` in an `.astro` component's or `.mdx` page's markup
 * (`markupLoads`), since Astro and MDX evaluate a template expression and this
 * does not parse one. An `.astro` `<script src>` that names a module is read as
 * the import of it (`moduleSources`), since Astro bundles what it names. An
 * `.astro` HTML comment that never closes fails too (`unclosedComment`), since
 * it hides the rest of the file.
 *
 * @param {object} input
 * @param {string} input.file repo-relative, `/`-separated
 * @param {string} input.source
 * @returns {{ loads: string[], unread: string[] }}
 */
export function runtimeImports({ file, source: text }) {
  const loads = [];
  const unread = [];

  for (const source of moduleSources(file, text)) {
    const made = moduleImports(file, source);

    loads.push(...made.loads);
    unread.push(...made.unread);
  }
  for (const { call, line } of markupLoads(file, text)) {
    unread.push(
      `an ${call} call in its markup (line ${line}), where a template expression is not read: make the load in ` +
        `the module code (an .astro frontmatter or <script>, an .mdx import) so it can be followed`,
    );
  }
  const openComment = unclosedComment(file, text);

  if (openComment !== undefined) {
    unread.push(
      `an HTML comment opened on line ${openComment} that never closes, which hides the rest of the file: close ` +
        "it with --> so what follows can be read",
    );
  }

  return { loads, unread };
}

/**
 * What one module of `file` loads and makes that this cannot follow, as
 * `runtimeImports` reads it: `source` is the module's text laid out at the
 * file's offsets (`moduleSources`).
 */
function moduleImports(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const loads = [];
  const unread = [];
  const classified = new Set();
  const load = (literal) => {
    classified.add(literal.getStart(sf));
    loads.push(literal.text);
  };
  const typeOnly = (literal) => classified.add(literal.getStart(sf));
  const { requireNames, isCreateRequire, madeHere, isFactory } = requireFunctions(sf);
  const spelled = (node) => node.getText(sf).replace(/\s+/g, " ");
  /**
   * What `node` is as a function that loads its argument: undefined when it is
   * none, `"here"` when it is a require name or a createRequire call's result
   * whose base is the file's own location, `"elsewhere"` when its base is not.
   */
  const requireKind = (node) => {
    const callee = unwrap(node);
    const here =
      ts.isIdentifier(callee) && requireNames.has(callee.text)
        ? requireNames.get(callee.text)
        : isCreateRequire(callee)
          ? madeHere(callee)
          : undefined;

    return here === undefined ? undefined : here ? "here" : "elsewhere";
  };

  const visit = (node) => {
    if (isCreateRequire(node) && !heldOrCalled(node)) {
      unread.push(
        `${spelled(node)}, a require function used other than by a call or a const that holds it: bind it to a ` +
          "const and call that with a string literal so it can be followed",
      );
    }
    // An alias of the factory makes require functions under a name this does not know: refused, not followed.
    if (isFactory(node) && escapes(node)) {
      unread.push(
        `a reference to ${spelled(node)}, the createRequire factory, used other than by a call: call it directly, ` +
          "as createRequire(import.meta.url), so the require function it makes can be followed",
      );
    }
    if (ts.isIdentifier(node) && requireNames.has(node.text) && escapes(node)) {
      unread.push(
        `a reference to ${node.text}, a require function, used other than by a call: call it with a string ` +
          "literal so it can be followed",
      );
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isMetaProperty(node.expression.expression) &&
      node.expression.name.text.startsWith("glob") &&
      !isDataGlob(node)
    ) {
      unread.push(
        `${spelled(node)}, a Vite glob import, which this check does not expand: import each module by a ` +
          "string literal so it can be followed",
      );
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      (node.importClause?.isTypeOnly ? typeOnly : load)(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      (node.isTypeOnly ? typeOnly : load)(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      (node.isTypeOnly ? typeOnly : load)(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      typeOnly(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || requireKind(node.expression) !== undefined)
    ) {
      const [specifier] = node.arguments;

      if (!specifier || !ts.isStringLiteralLike(specifier)) {
        unread.push(`${spelled(node)}, whose specifier is not a string literal: write it so it can be followed`);
      } else if (requireKind(node.expression) === "elsewhere" && RELATIVE_SPECIFIER.test(specifier.text)) {
        // Resolved from another base than this file, so not where the walk would look: reported, not loaded.
        classified.add(specifier.getStart(sf));
        unread.push(
          `${spelled(node)}, a relative load through a require function made from another base than this file: ` +
            "make it with createRequire(import.meta.url), or load by package name, so it can be followed",
        );
      } else {
        load(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);

  for (const reference of moduleReferences(source)) {
    if (reference.kind === "import" && !classified.has(reference.pos)) {
      unread.push(
        `a reference to ${reference.specifier} in a form this check does not read: write it so it can be followed`,
      );
    }
  }

  return { loads, unread };
}

/**
 * The extensions a relative specifier's file may have, in the order TypeScript
 * resolves them under `moduleResolution: "Bundler"` and tsx loads them: a `.js`
 * specifier names the `.ts` source beside it, `.mjs` the `.mts`, `.cjs` the
 * `.cts`. A `.d.ts` is never a candidate, since a declaration loads nothing.
 */
const SOURCE_EXTENSIONS = {
  ".js": [".ts", ".tsx", ".js", ".jsx"],
  ".jsx": [".tsx", ".jsx"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
};

/** What an extensionless specifier, or a folder's `index`, may be. */
const EXTENSIONLESS = [".ts", ".tsx", ".js", ".jsx"];

/**
 * Every repo-relative file a relative `specifier` in `fromFile` may load, in
 * TypeScript's order, so the first is the one it resolves to: each candidate
 * `read` returns text for. Empty when none exists, or the path climbs out of
 * the repository. A specifier spelling another extension (`.ts`, `.mts`,
 * `.json`) is tried as written first, then as extensionless, then as a folder
 * holding an `index`.
 *
 * Every existing candidate is returned, not only the first, because which one
 * runs depends on the loader: plain Node loads `./helper.cjs` as written, while
 * TypeScript and tsx may take a `helper.cts` beside it, and Vite tries an
 * extensionless `./a` as `.js` before `.ts`. A walk that followed one would let
 * the other hide a load (#1662).
 *
 * A folder with a `package.json` loads the file its `main` names, before any
 * `index` (Node's and Vite's rule), so that `main` is resolved as a relative
 * specifier from the folder in place of the `index` candidates. A folder whose
 * `package.json` has `exports`, a `main` that is not a string or resolves to
 * no file, or is not JSON at all, is `unread`: this does not follow those, and
 * a load it does not follow fails rather than passing.
 *
 * @param {string} fromFile
 * @param {string} specifier
 * @param {(file: string) => string | undefined} read
 * @returns {{ files: string[], unread: string[] }} `unread` says why the folder named is not followed
 */
export function resolveRuntimeFiles(fromFile, specifier, read, depth = 0) {
  const target = P.normalize(P.join(P.dirname(fromFile), specifier));
  const existing = (candidates) => candidates.filter((candidate) => read(candidate) !== undefined);

  if (target === ".." || target.startsWith("../") || P.isAbsolute(target)) return { files: [], unread: [] };
  const ext = P.extname(target);

  if (Object.hasOwn(SOURCE_EXTENSIONS, ext)) {
    return { files: existing(SOURCE_EXTENSIONS[ext].map((to) => target.slice(0, -ext.length) + to)), unread: [] };
  }
  const files = existing([target, ...EXTENSIONLESS.map((to) => target + to)]);
  const manifest = read(`${target}/package.json`);

  if (manifest === undefined) {
    return { files: [...files, ...existing(EXTENSIONLESS.map((to) => `${target}/index${to}`))], unread: [] };
  }
  const folder = `a folder, ${target}, whose package.json`;
  let pkg;

  try {
    pkg = JSON.parse(manifest);
  } catch {
    pkg = null;
  }
  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
    return { files, unread: [`${folder} is not a JSON object this check can read`] };
  }
  if (Object.hasOwn(pkg, "exports")) {
    return { files, unread: [`${folder} has "exports", which this check does not follow`] };
  }
  if (!Object.hasOwn(pkg, "main")) {
    return { files: [...files, ...existing(EXTENSIONLESS.map((to) => `${target}/index${to}`))], unread: [] };
  }
  if (typeof pkg.main !== "string" || P.normalize(P.join(target, pkg.main)) === target || depth > 8) {
    return { files, unread: [`${folder} has a "main" this check cannot follow`] };
  }
  const entry = resolveRuntimeFiles(`${target}/package.json`, `./${pkg.main}`, read, depth + 1);

  if (entry.files.length === 0 && entry.unread.length === 0) {
    return { files, unread: [`${folder} has a "main", ${pkg.main}, that resolves to no file`] };
  }

  return { files: [...files, ...entry.files], unread: entry.unread };
}

/** A specifier with a URL scheme or an absolute path, which this cannot follow; `node:` is a builtin. */
const UNFOLLOWABLE = /^(\/|\\|[a-z][a-z\d+.-]*:)/i;

/**
 * One of Astro's virtual modules (`astro:assets`, `astro:content`): the
 * `astro` package's own, third-party like `astro` itself, so ignored as a bare
 * third-party specifier is.
 */
const ASTRO_VIRTUAL = /^astro:/;

/** A Vite query or a fragment on a relative specifier: `?worker`, `?url`, `#x`. */
const QUERY = /[?#]/;

/**
 * True when a relative specifier loads no module code, so it is a leaf whether
 * or not its file exists: it names a file that holds none by its extension
 * (`.json`, `.svg`, `.png`) — a generated, gitignored data file such as the
 * website's `src/data/icon-gallery.json` loads nothing on a fresh clone either
 * — or it carries exactly the Vite query `?url` or `?raw` (`DATA_QUERY`), which
 * hands over the file's URL or text instead of running it, whatever the file
 * (`./x.ts?raw`). A code extension, `.astro`, `.mdx` or none at all must
 * resolve to a file, and any other query (`?worker` runs code, `?inline`,
 * `?worker&url`) is one this check does not follow.
 */
function isDataSpecifier(specifier) {
  const query = QUERY.exec(specifier);

  if (query !== null) return DATA_QUERY.test(specifier.slice(query.index));
  const ext = P.extname(specifier);

  return ext !== "" && !isModuleSource(specifier) && !Object.hasOwn(SOURCE_EXTENSIONS, ext);
}

/** `runtimeImports` by file and text, so walks over the same tree parse each file once. */
const IMPORTS_MEMO = new Map();

function memoizedImports(file, source) {
  const key = `${file}
${source}`;

  if (!IMPORTS_MEMO.has(key)) IMPORTS_MEMO.set(key, runtimeImports({ file, source }));

  return IMPORTS_MEMO.get(key);
}

/**
 * Walks the files `roots` load when they run, each file once, and reports
 * every workspace package that closure loads which is not sim-neutral (#1662),
 * and every root that does not exist. Pure: `read`
 * returns a repo-relative file's text, or undefined when there is no such file,
 * so the controls need no disk.
 *
 * The rules of the walk:
 *   * Only what loads at runtime is an edge, as `runtimeImports` reads it; an
 *     `.astro` component and an `.mdx` page are read by their module code
 *     (`moduleSources`), so a walk passes through the website's pages too.
 *   * A relative specifier is followed file by file, to every file it may
 *     load (`resolveRuntimeFiles`: TypeScript, tsx, Node and Vite can pick
 *     different ones), across package boundaries too. One that resolves to no
 *     file is a failure, not a skip: an instrument that drops what it cannot
 *     read passes vacuously. A file that holds no module code (`.json`,
 *     `.svg`), or one imported by `?raw` or `?url`, is a leaf, and need not
 *     exist (`isDataSpecifier`): a gitignored generated data file loads
 *     nothing either way. Any other query fails. A file with no extension at
 *     all is read as JavaScript, as Node loads one, and a folder with a
 *     package.json is followed to its `main`, or fails where that cannot be
 *     read (`resolveRuntimeFiles`).
 *   * A workspace package's specifier (`@iracedeck/<name>[/sub]`) is checked by
 *     the package's directory, mapped through each package.json's `name`, and is
 *     not descended into. A non-sim-neutral one is the failure. A sim-neutral
 *     one needs no walk from here, because the live check takes every
 *     non-test source of every sim-neutral package as a root of its own
 *     (`closureRoots`), so what that package loads, by any form and in any
 *     extension, is walked from there. A specifier naming the `@iracedeck`
 *     scope but no workspace package fails.
 *   * A bare third-party specifier (`zod`), an Astro virtual module
 *     (`astro:assets`) and a Node builtin (`node:fs`, `fs`) are ignored; an
 *     absolute path or other URL scheme cannot be followed and fails, and so
 *     does a `#subpath` of a package.json `imports` map, which this does not
 *     read (no package defines one).
 * Each failure names the chain of files from a root to the importing one, the
 * first chain the breadth-first walk met, so it says where to cut.
 *
 * @param {object} input
 * @param {string[]} input.roots repo-relative, `/`-separated
 * @param {(file: string) => string | undefined} input.read
 * @param {Map<string, string>} input.packageDirs workspace package name → its directory under `packages/`
 * @param {Set<string>} input.neutral the sim-neutral package directories
 * @returns {{ visited: string[], problems: string[] }}
 */
export function runtimeClosure({ roots, read, packageDirs, neutral }) {
  const present = roots.filter((root) => read(root) !== undefined);
  const from = new Map(present.map((root) => [root, null]));
  const queue = [...present];
  const problems = roots.filter((root) => read(root) === undefined).map((root) => `${root} does not exist`);
  const chain = (file) => {
    const files = [];

    for (let at = file; at !== null; at = from.get(at)) files.unshift(at);

    return files.join(" → ");
  };

  while (queue.length > 0) {
    const file = queue.shift();

    // A file with no extension at all is JavaScript to Node, which loads it as CommonJS.
    if (!isModuleSource(file) && P.extname(file) !== "") continue;
    const { loads, unread } = memoizedImports(file, read(file));

    for (const what of unread) problems.push(`${chain(file)} makes ${what}`);

    for (const specifier of loads) {
      if (RELATIVE_SPECIFIER.test(specifier)) {
        if (QUERY.test(specifier) && !isDataSpecifier(specifier)) {
          problems.push(
            `${chain(file)} imports ${specifier}, whose query this check does not follow: only ?raw and ?url, ` +
              "which load no code, pass; import the module itself so it can be followed",
          );
          continue;
        }
        const { files: targets, unread: folders } = QUERY.test(specifier)
          ? { files: [], unread: [] }
          : resolveRuntimeFiles(file, specifier, read);

        for (const folder of folders) {
          problems.push(
            `${chain(file)} imports ${specifier}, ${folder}: import the file it loads by its own path so it can be followed`,
          );
        }
        if (targets.length === 0 && folders.length === 0 && isDataSpecifier(specifier)) continue;
        if (targets.length === 0 && folders.length === 0) {
          problems.push(`${chain(file)} imports ${specifier}, which resolves to no file in the repository`);
        }
        for (const target of targets) {
          if (from.has(target)) continue;
          from.set(target, file);
          queue.push(target);
        }
        continue;
      }

      if (specifier.startsWith("#")) {
        problems.push(
          `${chain(file)} imports ${specifier}, a package.json "imports" subpath: this check does not follow ` +
            "package.json imports; import by relative path or package name",
        );
        continue;
      }

      if (ASTRO_VIRTUAL.test(specifier)) continue;

      if (UNFOLLOWABLE.test(specifier) && !specifier.startsWith("node:")) {
        problems.push(`${chain(file)} imports ${specifier}, an absolute path or URL this check cannot follow`);
        continue;
      }

      const name = packageOf(specifier);
      const dir = name === null ? undefined : packageDirs.get(name);

      if (dir === undefined) {
        if (name?.startsWith("@iracedeck/")) {
          problems.push(`${chain(file)} imports ${specifier}, which names no workspace package`);
        }
        continue;
      }

      if (!neutral.has(dir)) {
        problems.push(
          `${chain(file)} imports ${specifier}: packages/${dir}/ is not sim-neutral (SIM_NEUTRAL_PACKAGES in ` +
            `eslint.config.js), so ${chain(file).split(" → ")[0]} loads it at runtime. Cut the chain, or import only types from it ` +
            "with `import type` (#1662)",
        );
      }
    }
  }

  return { visited: [...from.keys()], problems };
}

const PACKAGES = new Set(trackedPackageDirs(ROOT));
// The .astro components and .mdx pages too, read by their module code (#1662).
const FILES = trackedPackageSources(ROOT, { components: true });

function scan(files = FILES) {
  const found = new Map();

  for (const file of files) {
    const reaches = reachesOf({ file, source: readFileSync(path.join(ROOT, file), "utf-8"), packages: PACKAGES });

    if (reaches.size > 0) found.set(file, reaches);
  }

  return found;
}

/** Workspace package name → its directory under `packages/`. */
const PACKAGE_DIRS = new Map(
  [...PACKAGES].map((dir) => [
    JSON.parse(readFileSync(path.join(ROOT, "packages", dir, "package.json"), "utf-8")).name,
    dir,
  ]),
);
const NEUTRAL = new Set(SIM_NEUTRAL_PACKAGES);
const GALLERY = "packages/website/scripts/generate-icon-gallery.mts";

/** A repo-relative file's text as tsx would read it from disk, or undefined when there is no such file. */
function readRepoFile(file) {
  try {
    return readFileSync(path.join(ROOT, file), "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * The roots of the closure check (#1662): every source of a sim-neutral
 * package that runs, in any extension — `.ts`, `.mts`, `.mjs`, `.js`, an
 * `.astro` component, an `.mdx` page — inside its `src/` or out of it (a
 * build script, a Rollup config, the website's `public/` browser script). So
 * every load such a file makes is read here, the dynamic `import()` and
 * `require` the ESLint block cannot see as much as a static import, and the
 * walk stops at a sim-neutral package's specifier because that package's own
 * sources are roots too.
 *
 * Left out: a declaration file (`.d.ts`), which loads nothing, and tests
 * (`isTestSource`): Vitest alone loads them, never a package's build or a
 * plugin, and it loads them against the native mocks (`testing.md`). Their
 * reaches read another package's files as text, a fixture or a manifest, or
 * transpile one into a child process; none puts a sim package into what the
 * package ships or builds. The ESLint block still refuses a sim specifier in
 * them.
 */
function closureRoots() {
  return FILES.filter((file) => NEUTRAL.has(file.split("/")[1]) && !isTestSource(file) && !/\.d\.[cm]?ts$/.test(file));
}

describe("no package reaches into another by a relative path (#1375)", () => {
  const found = scan();

  it("scans every package's sources and finds the deliberate reaches, so the check is not vacuous", () => {
    expect(FILES.length).toBeGreaterThan(1000);
    expect(new Set(FILES.map((file) => file.split("/")[1])).size).toBe(PACKAGES.size - 0);
    expect([...found.keys()].sort()).toEqual(
      [...new Set([...Object.keys(ALLOWED), ...Object.keys(NAMED_NOT_OPENED)])].sort(),
    );
  });

  it("finds a reach only in a file ALLOWED names, to a package its entry names, and no stale entry", () => {
    expect(reachProblems(found, ALLOWED, new Set(FILES), NAMED_NOT_OPENED)).toEqual([]);
  });

  it("gives every ALLOWED and NAMED_NOT_OPENED entry a reason", () => {
    for (const [file, { reaches, reason }] of Object.entries(ALLOWED)) {
      expect(reaches.length, file).toBeGreaterThan(0);
      expect(reason.length, file).toBeGreaterThan(20);
    }
    for (const [file, { paths, reason }] of Object.entries(NAMED_NOT_OPENED)) {
      expect(paths.length, file).toBeGreaterThan(0);
      expect(reason.length, file).toBeGreaterThan(20);
    }
  });
});

describe("a sim-neutral package loads no sim package at runtime (#1662)", () => {
  const roots = closureRoots();
  const closure = (from) =>
    runtimeClosure({ roots: from, read: readRepoFile, packageDirs: PACKAGE_DIRS, neutral: NEUTRAL });
  // One walk from every root at once, so each file is read once and each failure is named once.
  const all = closure(roots);

  it("takes every runnable source of every sim-neutral package as a root, and no test or declaration", () => {
    const neutralFiles = FILES.filter((file) => NEUTRAL.has(file.split("/")[1]));

    expect(PACKAGE_DIRS.size).toBe(PACKAGES.size);
    expect(new Set(roots.map((file) => file.split("/")[1]))).toEqual(
      new Set(neutralFiles.filter((file) => !isTestSource(file)).map((file) => file.split("/")[1])),
    );
    expect(roots.length).toBeGreaterThan(300);
    expect(roots.some((file) => isTestSource(file) || file.endsWith(".d.ts"))).toBe(false);
    expect(roots).toEqual(
      expect.arrayContaining([
        "packages/deck-core/src/index.ts",
        "packages/website/astro.config.mjs",
        "packages/website/src/components/IconGallery.astro",
        "packages/website/src/content/docs/docs/development/icon-gallery.mdx",
        // A .js source, which no ESLint block reads, is a root the same way.
        "packages/website/public/diagram-zoom.js",
        ...Object.keys(ALLOWED).filter((file) => NEUTRAL.has(file.split("/")[1]) && !isTestSource(file)),
      ]),
    );
    expect(all.visited).toEqual(expect.arrayContaining(roots));
  });

  it("walks out of a sim-neutral package by its relative reaches, the icon gallery deep into iracing-actions", () => {
    const gallery = closure([GALLERY]).visited;

    expect(gallery.length).toBeGreaterThan(10);
    expect(gallery.filter((file) => file.startsWith("packages/iracing-actions/")).length).toBeGreaterThan(5);
    expect(all.visited.filter((file) => !NEUTRAL.has(file.split("/")[1]) && file.startsWith("packages/"))).toEqual(
      expect.arrayContaining(gallery.filter((file) => file.startsWith("packages/iracing-actions/"))),
    );
    expect(closure(["packages/website/src/content/docs/docs/development/icon-gallery.mdx"]).visited).toEqual(
      expect.arrayContaining(["packages/website/src/components/IconGallery.astro"]),
    );
  });

  it("loads only sim-neutral workspace packages from any of them, and reads every load it does not excuse", () => {
    expect(unexcusedProblems(all.problems, UNREAD_LOADS)).toEqual([]);
  });

  // The gap #1662's second read found: lint reads no dynamic import or require, and a
  // file was a root only when it reached out of its package by a relative path.
  it.each([
    ["packages/deck-core/src/index.ts", 'const actions = await import("@iracedeck/iracing-actions");\n'],
    ["packages/settings/src/index.ts", 'const sdk = require("@iracedeck/iracing-sdk");\n'],
    // Into the page's own frontmatter, after its opening fence.
    ["packages/website/src/pages/404.astro", '---\nconst actions = await import("@iracedeck/iracing-actions");\n'],
  ])("finds a runtime load of a non-neutral package planted in %s, a file no reach made a root", (file, plant) => {
    const real = readRepoFile(file);
    const planted = plant.startsWith("---\n") ? plant + real.slice(real.indexOf("\n") + 1) : plant + real;
    const loadsIn = (source) =>
      runtimeClosure({
        roots,
        read: (at) => (at === file ? source : readRepoFile(at)),
        packageDirs: PACKAGE_DIRS,
        neutral: NEUTRAL,
      }).problems.filter((problem) => problem.includes(`${file} imports @iracedeck/`));

    expect(roots).toContain(file);
    expect(loadsIn(real)).toEqual([]);
    expect(loadsIn(planted)).toEqual([
      expect.stringMatching(new RegExp(`^${file} imports @iracedeck/iracing-(actions|sdk): packages/iracing-`)),
    ]);
  });

  it("gives every UNREAD_LOADS entry a reason", () => {
    for (const [file, { calls, reason }] of Object.entries(UNREAD_LOADS)) {
      expect(calls.length, file).toBeGreaterThan(0);
      expect(reason.length, file).toBeGreaterThan(20);
    }
  });
});

describe("the check itself (positive controls)", () => {
  const packages = new Set(["audio-assets", "deck-core", "iracing-actions", "plugin-build", "sim-events-iracing"]);
  const reach = (file, source) => Object.fromEntries(reachesOf({ file, source, packages }));
  const ACTION = "packages/iracing-actions/src/actions/fuel-service/fuel-dial-surface.test.ts";

  it("refuses the import #1375 removed, in every module form", () => {
    for (const source of [
      'import { classifyDialRelease } from "../../../../deck-core/src/dial-gesture.js";',
      'import type { X } from "../../../../deck-core/src/dial-gesture.js";',
      'export * from "../../../../deck-core/src/dial-gesture.js";',
      'const m = await import("../../../../deck-core/src/dial-gesture.js");',
      'const m = require("../../../../deck-core/src/dial-gesture.js");',
      'type T = typeof import("../../../../deck-core/src/dial-gesture.js");',
      'vi.mock("../../../../deck-core/src/dial-gesture.js", () => ({}));',
    ]) {
      expect(reach(ACTION, source), source).toEqual({ "deck-core": ["packages/deck-core/src/dial-gesture.js"] });
    }
  });

  it("refuses a fixture path, whether one string, joined segments, a URL or through constants", () => {
    const file = "packages/deck-core/src/a.test.ts";
    const target = { "audio-assets": ["packages/audio-assets/voice/x.json"] };

    for (const source of [
      'readFileSync("../../audio-assets/voice/x.json");',
      'import { join } from "node:path";\nreadFileSync(join(import.meta.dirname, "..", "..", "audio-assets", "voice", "x.json"));',
      'import path from "node:path";\nimport { fileURLToPath } from "node:url";\nconst HERE = path.dirname(fileURLToPath(import.meta.url));\nconst ROOT = path.resolve(HERE, "../../..");\nreadFileSync(path.join(ROOT, "packages/audio-assets/voice/x.json"));',
      'import { fileURLToPath } from "node:url";\nreadFileSync(fileURLToPath(new URL("../../audio-assets/voice/x.json", import.meta.url)));',
      'import { join } from "node:path";\nreadFileSync(join(process.cwd(), "packages/audio-assets/voice/x.json"));',
      "const ROOT = `${import.meta.dirname}/../..`;\nreadFileSync(`${ROOT}/audio-assets/voice/x.json`);",
      'readFileSync(import.meta.dirname + "/../../audio-assets/voice/x.json");',
    ]) {
      expect(reach(file, source), source).toEqual(target);
    }

    // The shape #1375 removed from audio-scenarios' caution test: capture paths in an array.
    const caution = "packages/audio-scenarios/src/catalog/pit-crew/caution.test.ts";
    const captures = [
      "const CAPTURES = [",
      '  "../../../../sim-events-iracing/src/diff/__fixtures__/caution-road.json",',
      "];",
    ].join("\n");

    expect(reach(caution, captures)).toEqual({
      "sim-events-iracing": ["packages/sim-events-iracing/src/diff/__fixtures__/caution-road.json"],
    });
  });

  it("refuses a path spelled from the run directory, and one with Windows separators", () => {
    const file = "packages/deck-core/src/a.test.ts";
    const target = { "audio-assets": ["packages/audio-assets/sfx/x.wav"] };

    for (const source of [
      'readFileSync("packages/audio-assets/sfx/x.wav");',
      'import { join } from "node:path";\nreadFileSync(join("packages", "audio-assets", "sfx", "x.wav"));',
      'import path from "node:path";\nreadFileSync(path.normalize("packages/audio-assets/./sfx/x.wav"));',
      'readFileSync("packages/audio-assets/sfx/" + "x.wav");',
      'readFileSync("packages\\\\audio-assets\\\\sfx\\\\x.wav");',
      'readFileSync("..\\\\..\\\\audio-assets\\\\sfx\\\\x.wav");',
      'import { join } from "node:path";\nreadFileSync(join(import.meta.dirname, "..\\\\..\\\\audio-assets", "sfx", "x.wav"));',
      'import { join } from "node:path";\nreadFileSync(join("packages\\\\audio-assets", "sfx\\\\x.wav"));',
    ]) {
      expect(reach(file, source), source).toEqual(target);
    }

    expect(reach(file, 'const SFX = "packages/audio-assets/sfx";\nreadFileSync(`${SFX}/x.wav`);')).toEqual({
      "audio-assets": ["packages/audio-assets/sfx", "packages/audio-assets/sfx/x.wav"],
    });
  });

  it("passes a package's own path spelled from the run directory, and a bare path from a non-test", () => {
    const own = [
      'const BASELINE = "packages/deck-core/src/__fixtures__/x.json";',
      'import { join } from "node:path";\nreadFileSync(join("packages", "deck-core", "src", "x.json"));',
    ].join("\n");

    expect(reach("packages/deck-core/src/a.test.ts", own)).toEqual({});
    // A non-test runs from its package root, where `packages/…` is a folder of its own.
    expect(reach("packages/deck-core/src/a.ts", 'readFileSync("packages/audio-assets/sfx/x.wav");')).toEqual({});
    expect(pathsNamed({ file: "packages/deck-core/src/a.ts", source: 'readFileSync("packages/x");' })).toEqual([
      "packages/deck-core/packages/x",
    ]);
  });

  it("resolves a non-test file's relative string against its package root too, as a glob handed to Rollup is", () => {
    expect(
      reach("packages/plugin-build/src/plugin-rollup.mjs", 'const include = ["../iracing-actions/src/**/*.ts"];'),
    ).toEqual({
      "iracing-actions": ["packages/iracing-actions/src/**/*.ts"],
    });
  });

  it("passes a path to the root scripts/, the repo root, packages/ as a whole and the file's own package", () => {
    const file = "packages/plugin-build/src/plugin-rollup.mjs";
    const source = [
      'import { pluginBuildOnLog } from "../../../scripts/lib/rollup-logs.mjs";',
      'import path from "node:path";',
      'const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../..");',
      'const all = path.join(repoRoot, "packages");',
      'const own = path.join(import.meta.dirname, "..", "package.json");',
      'const fragments = path.join(repoRoot, "changelog.d");',
      'import { x } from "./externals.mjs";',
    ].join("\n");

    expect(reach(file, source)).toEqual({});
    expect(pathsNamed({ file, source })).toContain("scripts/lib/rollup-logs.mjs");
  });

  it("passes a bare package import, a comment, a path beneath packages/ that is no package, and a non-path resolve", () => {
    const source = [
      'import { createHoldPreview } from "@iracedeck/deck-core/testing";',
      '// import x from "../../../../deck-core/src/dial-gesture.js";',
      '/* readFileSync("../../audio-assets/x") */',
      'expect(resolveSafe("../../etc/passwd")).toBeNull();',
      'await Promise.resolve("../../deck-core");',
      'const r = createRequire(import.meta.url).resolve("@iracedeck/audio-assets/package.json");',
    ].join("\n");

    expect(reach("packages/deck-core/src/a.test.ts", source)).toEqual({});
  });

  // The website's components and pages, read by their module code (#1662).
  it("refuses a reach from an .astro frontmatter or <script>, and from an .mdx import", () => {
    const astro = "packages/deck-core/src/components/Planted.astro";
    const mdx = "packages/deck-core/src/content/planted.mdx";
    const target = { "iracing-actions": ["packages/iracing-actions/src/rows.js"] };

    for (const [file, source] of [
      [astro, '---\nimport { rows } from "../../../iracing-actions/src/rows.js";\n---\n\n<p>{rows}</p>\n'],
      [astro, '---\nconst ROWS = "../../../iracing-actions/src/rows.js";\n---\n\n<p>{ROWS}</p>\n'],
      [astro, '<p>x</p>\n\n<script>\n  import { rows } from "../../../iracing-actions/src/rows.js";\n</script>\n'],
      [astro, '<p>x</p>\n<script src="../../../iracing-actions/src/rows.js"></script>\n'],
      [mdx, '---\ntitle: x\n---\n\nimport { rows } from "../../../iracing-actions/src/rows.js";\n\n# Planted\n'],
      [mdx, 'import {\n  rows,\n} from "../../../iracing-actions/src/rows.js";\n\nProse.\n'],
    ]) {
      expect(reach(file, source), source).toEqual(target);
    }
  });

  it("passes a mention in .astro markup or a comment, and in .mdx frontmatter, prose or fenced code", () => {
    const astro = [
      "---",
      'import Card from "./Card.astro";',
      "---",
      "",
      '<p>import { rows } from "../../../iracing-actions/src/rows.js"</p>',
      '<a href="../../../iracing-actions/src/rows.js">rows</a>',
      '<!-- <script>import "../../../iracing-actions/src/rows.js";</script> -->',
      '<script type="application/json">{ "rows": "../../../iracing-actions/src/rows.js" }</script>',
      "",
    ].join("\n");
    const mdx = [
      "---",
      'hero: "../../../iracing-actions/src/rows.js"',
      "---",
      "",
      'Prose: import { rows } from "../../../iracing-actions/src/rows.js".',
      "",
      "```ts",
      'import { rows } from "../../../iracing-actions/src/rows.js";',
      "```",
      "",
      '<Card src="../../../iracing-actions/src/rows.js" />',
      "",
    ].join("\n");

    expect(reach("packages/deck-core/src/components/Planted.astro", astro)).toEqual({});
    expect(reach("packages/deck-core/src/content/planted.mdx", mdx)).toEqual({});
  });

  it("does not guess a path built on something constants cannot say", () => {
    const source =
      'import { join } from "node:path";\nfunction f(root) { return join(root, "packages", "audio-assets"); }';

    expect(reach("packages/deck-core/src/a.test.ts", source)).toEqual({});
  });

  const found = (entries) =>
    new Map(entries.map(([file, pkgs]) => [file, new Map(pkgs.map((pkg) => [pkg, [`packages/${pkg}/x`]]))]));
  const allowed = { "packages/a/src/a.ts": { reaches: ["b"], reason: "a deliberate reach for the control" } };
  const files = new Set(["packages/a/src/a.ts", "packages/c/src/c.ts"]);

  it("passes an allow-listed reach", () => {
    expect(reachProblems(found([["packages/a/src/a.ts", ["b"]]]), allowed, files)).toEqual([]);
  });

  it("refuses a reach no entry names, and one to a package the file's entry does not name", () => {
    expect(
      reachProblems(
        found([
          ["packages/a/src/a.ts", ["b", "d"]],
          ["packages/c/src/c.ts", ["b"]],
        ]),
        allowed,
        files,
      ),
    ).toEqual([
      expect.stringContaining("packages/a/src/a.ts reaches into packages/d/"),
      expect.stringContaining("packages/c/src/c.ts reaches into packages/b/"),
    ]);
  });

  it("passes only the exact paths NAMED_NOT_OPENED names, and fails a stale entry of it", () => {
    const named = { "packages/a/src/a.ts": { paths: ["packages/b/x"], reason: "provenance for the control" } };
    const reaching = (paths) => new Map([["packages/a/src/a.ts", new Map([["b", paths]])]]);

    expect(reachProblems(reaching(["packages/b/x"]), {}, files, named)).toEqual([]);
    expect(reachProblems(reaching(["packages/b/x", "packages/b/y"]), {}, files, named)).toEqual([
      expect.stringContaining("packages/a/src/a.ts reaches into packages/b/ by a relative path (packages/b/y)"),
    ]);
    expect(reachProblems(found([]), {}, files, named)).toEqual([
      "NAMED_NOT_OPENED says packages/a/src/a.ts names packages/b/x, but it no longer does: remove it from the entry",
    ]);
    expect(reachProblems(found([]), {}, new Set(), named)).toEqual([
      "NAMED_NOT_OPENED names packages/a/src/a.ts, which is not a tracked package source any more: remove the entry",
    ]);
  });

  it("fails a stale entry: its file gone, or no longer reaching", () => {
    expect(reachProblems(found([]), allowed, files)).toEqual([
      "ALLOWED says packages/a/src/a.ts reaches packages/b/, but it no longer does: remove b from the entry",
    ]);
    expect(reachProblems(found([]), allowed, new Set())).toEqual([
      "ALLOWED names packages/a/src/a.ts, which is not a tracked package source any more: remove the entry",
    ]);
  });

  it("finds a reach #1375 removed when it is put back into a real test file", () => {
    const file = "packages/iracing-actions/src/actions/fuel-service/fuel-dial-surface.test.ts";
    const real = readFileSync(path.join(ROOT, file), "utf-8");
    const planted = `import { classifyDialRelease } from "../../../../deck-core/src/dial-gesture.js";\n${real}`;

    expect(
      reachProblems(new Map([[file, reachesOf({ file, source: real, packages: PACKAGES })]]), {}, new Set([file])),
    ).toEqual([]);
    expect(
      reachProblems(new Map([[file, reachesOf({ file, source: planted, packages: PACKAGES })]]), {}, new Set([file])),
    ).toEqual([
      expect.stringContaining(
        `${file} reaches into packages/deck-core/ by a relative path (packages/deck-core/src/dial-gesture.js)`,
      ),
    ]);
  });
});

describe("the runtime-closure check itself (positive controls, #1662)", () => {
  const ROOT_FILE = "packages/website/scripts/gallery.mts";
  const packageDirs = new Map([
    ["@iracedeck/deck-core", "deck-core"],
    ["@iracedeck/iracing-actions", "iracing-actions"],
    ["@iracedeck/iracing-sdk", "iracing-sdk"],
    ["@iracedeck/website", "website"],
  ]);
  const neutral = new Set(["deck-core", "website"]);
  /** The closure of ROOT_FILE over an in-memory tree: repo-relative path → source. */
  const walk = (tree, root = ROOT_FILE) =>
    runtimeClosure({ roots: [root], read: (file) => tree[file], packageDirs, neutral });
  /** A tree whose root holds `source` and nothing else. */
  const only = (source) => walk({ [ROOT_FILE]: source });

  it("fails a two-hop relative chain into a file that imports a sim package, naming the chain", () => {
    const { visited, problems } = walk({
      [ROOT_FILE]: 'import { render } from "../../iracing-actions/src/a.ts";',
      "packages/iracing-actions/src/a.ts": 'import { helper } from "./b.js";\nexport const render = helper;',
      "packages/iracing-actions/src/b.ts":
        'import { Flags } from "@iracedeck/iracing-sdk";\nexport const helper = Flags;',
    });

    expect(visited).toEqual([ROOT_FILE, "packages/iracing-actions/src/a.ts", "packages/iracing-actions/src/b.ts"]);
    expect(problems).toEqual([
      expect.stringMatching(
        /^packages\/website\/scripts\/gallery\.mts → packages\/iracing-actions\/src\/a\.ts → packages\/iracing-actions\/src\/b\.ts imports @iracedeck\/iracing-sdk: packages\/iracing-sdk\/ is not sim-neutral/,
      ),
    ]);
  });

  it("fails every form that loads: a dynamic import, a side-effect import, a re-export, require and import =", () => {
    for (const source of [
      'const sdk = await import("@iracedeck/iracing-sdk");',
      "const sdk = await import(`@iracedeck/iracing-sdk`);",
      'import "@iracedeck/iracing-sdk/dist/setup.js";',
      'export * from "@iracedeck/iracing-sdk";',
      'export { Flags } from "@iracedeck/iracing-sdk";',
      'export * as sdk from "@iracedeck/iracing-sdk";',
      'const sdk = require("@iracedeck/iracing-sdk");',
      'import sdk = require("@iracedeck/iracing-sdk");',
      'import sdk from "@iracedeck/iracing-sdk";',
      'import * as sdk from "@iracedeck/iracing-sdk";',
      'import {} from "@iracedeck/iracing-sdk";',
    ]) {
      expect(only(source).problems, source).toEqual([expect.stringContaining("imports @iracedeck/iracing-sdk")]);
    }
  });

  it("follows a createRequire result as require under any name, however createRequire is reached", () => {
    const sim = 'load("@iracedeck/iracing-sdk");';

    for (const source of [
      `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\n${sim}`,
      `import { createRequire } from "module";\nconst load = createRequire(import.meta.url);\n${sim}`,
      `import { createRequire as make } from "node:module";\nconst load = make(import.meta.url);\n${sim}`,
      `import module from "node:module";\nconst load = module.createRequire(import.meta.url);\n${sim}`,
      `import * as nodeModule from "module";\nconst load = (nodeModule.createRequire(import.meta.url) as NodeRequire);\n${sim}`,
      `const { createRequire: make } = await import("node:module");\nconst load = make(import.meta.url);\n${sim}`,
      'import { createRequire } from "node:module";\ncreateRequire(import.meta.url)("@iracedeck/iracing-sdk");',
    ]) {
      expect(only(source).problems, source).toEqual([expect.stringContaining("imports @iracedeck/iracing-sdk")]);
    }
  });

  // A relative load resolves against the require function's base, which only the file's own location makes this file.
  it("follows a relative load only through a require function made from the file's own location", () => {
    const tree = (source) => ({
      [ROOT_FILE]: `import { createRequire } from "node:module";\nimport url, { pathToFileURL, fileURLToPath } from "node:url";\n${source}`,
      "packages/website/scripts/x.js": 'import "@iracedeck/iracing-sdk";',
    });
    const followed = `${ROOT_FILE} → packages/website/scripts/x.js imports @iracedeck/iracing-sdk`;

    for (const base of [
      "import.meta.url",
      "import.meta.filename",
      "__filename",
      "pathToFileURL(__filename)",
      "pathToFileURL(__filename).href",
      "url.pathToFileURL(import.meta.filename).href",
      "fileURLToPath(import.meta.url)",
      "(import.meta.url as string)",
    ]) {
      for (const source of [
        `const load = createRequire(${base});\nload("./x.js");`,
        `createRequire(${base})("./x.js");`,
      ]) {
        expect(walk(tree(source)).problems, source).toEqual([expect.stringContaining(followed)]);
      }
    }
    for (const base of [
      'new URL("../package.json", import.meta.url)',
      "import.meta.dirname",
      "__dirname",
      "somewhere",
      'pathToFileURL("/elsewhere/x.js")',
    ]) {
      for (const source of [
        `const load = createRequire(${base});\nload("./x.js");`,
        `createRequire(${base})("./x.js");`,
        // A name bound twice is own-based only if every binding is.
        `let load = createRequire(import.meta.url);\nvar load = createRequire(${base});\nload("./x.js");`,
      ]) {
        expect(walk(tree(source)).problems, source).toEqual([
          expect.stringContaining(
            "a relative load through a require function made from another base than this file: make it with " +
              "createRequire(import.meta.url), or load by package name, so it can be followed",
          ),
        ]);
      }
      // A package name names the same package from any base, so it is still checked as one.
      expect(
        walk(tree(`const load = createRequire(${base});\nload("@iracedeck/iracing-sdk");`)).problems,
        base,
      ).toEqual([expect.stringContaining(`${ROOT_FILE} imports @iracedeck/iracing-sdk: packages/iracing-sdk/`)]);
    }
  });

  it("fails a require function it cannot follow: a computed specifier, one handed on, and a glob import", () => {
    const made = 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\n';
    const cases = {
      [`${made}load(name);`]: "load(name), whose specifier is not a string literal",
      [`${made}use(load);`]: "a reference to load, a require function, used other than by a call",
      [`${made}load.call(null, "@iracedeck/iracing-sdk");`]: "a reference to load, a require function",
      [`${made}export default { load };`]: "a reference to load, a require function",
      'import { createRequire } from "node:module";\nuse(createRequire(import.meta.url));':
        "createRequire(import.meta.url), a require function used other than by a call or a const that holds it",
      "const r = require;": "a reference to require, a require function, used other than by a call",
      'const modules = import.meta.glob("./*.ts", { eager: true });': "a Vite glob import",
      // An alias of the factory makes require functions under a name the walk does not know.
      'import { createRequire } from "node:module";\nconst make = createRequire;\nconst load = make(import.meta.url);\nload("@iracedeck/iracing-sdk");':
        "a reference to createRequire, the createRequire factory, used other than by a call",
      'import module from "node:module";\nconst make = module.createRequire;\nmake(import.meta.url)("@iracedeck/iracing-sdk");':
        "a reference to module.createRequire, the createRequire factory, used other than by a call",
      'import { createRequire as cr } from "node:module";\nuse(cr);': "a reference to cr, the createRequire factory",
      'import { createRequire } from "node:module";\nexport { createRequire };':
        "a reference to createRequire, the createRequire factory",
      'import { createRequire } from "node:module";\ncreateRequire.call(null, import.meta.url);':
        "a reference to createRequire, the createRequire factory",
    };

    for (const [source, message] of Object.entries(cases)) {
      expect(only(source).problems, source).toEqual([expect.stringContaining(message)]);
    }
  });

  // The website's components glob their images; a glob of module code is one the walk does not expand.
  it("passes a Vite glob of data files or by a ?raw or ?url query, and fails a glob of module code", () => {
    for (const source of [
      'import.meta.glob("../assets/*.png", { eager: true });',
      'import.meta.glob<string>("../assets/*.{svg, png,webp}", { eager: true, query: "?url", import: "default" });',
      'import.meta.glob(["./*.json", "!./skip.json"]);',
      'import.meta.glob("./*.ts", { query: "?raw" });',
    ]) {
      expect(only(source).problems, source).toEqual([]);
    }
    for (const source of [
      'import.meta.glob("./*.ts");',
      'import.meta.glob(["./**/*.ts", "!./**/*.test.ts"], { eager: true });',
      'import.meta.glob("./*.{svg,mjs}");',
      'import.meta.glob("./**/*");',
      'import.meta.glob(["!./*.png"]);',
      "import.meta.glob(pattern);",
      'import.meta.glob("./*.ts", { query: "?worker" });',
      'import.meta.globEager("./*.ts");',
      // An extension that is itself a glob matches module code as readily as data.
      'import.meta.glob("./*.[jt]s");',
      'import.meta.glob("./*.{png,[jt]s}");',
      'import.meta.glob("./*.?s");',
      'import.meta.glob("./*.@(png|ts)");',
      'import.meta.glob("./*.!(png)");',
    ]) {
      expect(only(source).problems, source).toEqual([expect.stringContaining("a Vite glob import")]);
    }
  });

  it("passes what a require function does without loading: resolve, main, typeof, a type, a property name", () => {
    const source = [
      'import { createRequire } from "node:module";',
      "const load = createRequire(import.meta.url);",
      'const where = load.resolve("@iracedeck/iracing-sdk");',
      'const there = createRequire(import.meta.url).resolve("@iracedeck/iracing-sdk");',
      "const isMain = require.main === module;",
      'const hasRequire = typeof require === "function";',
      "type R = typeof require;",
      "const holder = { require: 1, load() {} };",
      "holder.require;",
    ].join("\n");

    expect(only(source)).toEqual({ visited: [ROOT_FILE], problems: [] });
  });

  it("fails an import whose every name is marked type, as tsx keeps it under the website's verbatimModuleSyntax", () => {
    // `import { type A } from "x"` stays as `import {} from "x"` in a file the website's tsconfig governs.
    for (const source of [
      'import { type Flags } from "@iracedeck/iracing-sdk";',
      'import { type Flags, SessionState } from "@iracedeck/iracing-sdk";',
      'export { type Flags } from "@iracedeck/iracing-sdk";',
    ]) {
      expect(only(source).problems, source).toEqual([expect.stringContaining("imports @iracedeck/iracing-sdk")]);
    }
  });

  it("passes what loads nothing: import type, export type, a type import(), a comment and a string", () => {
    const source = [
      'import type { Flags } from "@iracedeck/iracing-sdk";',
      'import type Sdk from "@iracedeck/iracing-sdk";',
      'export type { Flags } from "@iracedeck/iracing-sdk";',
      'export type * from "@iracedeck/iracing-sdk";',
      'import type sdk = require("@iracedeck/iracing-sdk");',
      'type T = import("@iracedeck/iracing-sdk").Flags;',
      '// import { Flags } from "@iracedeck/iracing-sdk";',
      '/* await import("@iracedeck/iracing-sdk"); */',
      'const name = "@iracedeck/iracing-sdk";',
      "const line = 'import \"@iracedeck/iracing-sdk\";';",
      'const template = `require("@iracedeck/iracing-sdk")`;',
    ].join("\n");

    expect(only(source)).toEqual({ visited: [ROOT_FILE], problems: [] });
  });

  it("passes a sim-neutral workspace package without descending into it, and ignores third-party and builtins", () => {
    const { visited, problems } = walk({
      [ROOT_FILE]: [
        'import { SimConnection } from "@iracedeck/deck-core";',
        'import { x } from "@iracedeck/website/sub";',
        'import { z } from "zod";',
        'import fs from "node:fs";',
        'import path from "path";',
      ].join("\n"),
      // Never read: deck-core is held by its own ESLint block.
      "packages/deck-core/src/index.ts": 'import "@iracedeck/iracing-sdk";',
    });

    expect({ visited, problems }).toEqual({ visited: [ROOT_FILE], problems: [] });
  });

  it("fails a specifier it cannot follow: unresolvable, out of the repository, absolute, computed, or no package", () => {
    const cases = {
      'import { x } from "./missing.js";': "imports ./missing.js, which resolves to no file",
      'import { x } from "../../../../outside.ts";': "imports ../../../../outside.ts, which resolves to no file",
      'import { x } from "/abs/x.ts";': "an absolute path or URL",
      'import { x } from "file:///C:/x.ts";': "an absolute path or URL",
      "const m = await import(name);": "import(name), whose specifier is not a string literal",
      "const m = require(name);": "require(name), whose specifier is not a string literal",
      'import { x } from "@iracedeck/nope";': "imports @iracedeck/nope, which names no workspace package",
    };

    for (const [source, message] of Object.entries(cases)) {
      expect(only(source).problems, source).toEqual([expect.stringContaining(message)]);
    }
  });

  it("resolves a relative specifier as tsx does: .js to .ts, .mjs to .mts, extensionless, a folder's index", () => {
    const sim = 'import "@iracedeck/iracing-sdk";';
    const cases = [
      ["./a.js", "packages/website/scripts/a.ts"],
      ["./a.js", "packages/website/scripts/a.tsx"],
      ["./a.js", "packages/website/scripts/a.js"],
      ["./a.mjs", "packages/website/scripts/a.mts"],
      ["./a.cjs", "packages/website/scripts/a.cts"],
      ["./a", "packages/website/scripts/a.ts"],
      ["./a.ts", "packages/website/scripts/a.ts"],
      ["./dir", "packages/website/scripts/dir/index.ts"],
      ["../src/a.js", "packages/website/src/a.ts"],
    ];

    for (const [specifier, file] of cases) {
      const { visited, problems } = walk({ [ROOT_FILE]: `import "${specifier}";`, [file]: sim });

      expect(visited, specifier).toEqual([ROOT_FILE, file]);
      expect(problems, specifier).toEqual([
        expect.stringContaining(`${ROOT_FILE} → ${file} imports @iracedeck/iracing-sdk`),
      ]);
    }

    // A .d.ts loads nothing, so a specifier only it answers resolves to no file.
    expect(walk({ [ROOT_FILE]: 'import "./a.js";', "packages/website/scripts/a.d.ts": "" }).problems).toEqual([
      expect.stringContaining("imports ./a.js, which resolves to no file"),
    ]);
  });

  it("treats a non-code file as a leaf, and walks a cycle once", () => {
    const { visited, problems } = walk({
      [ROOT_FILE]: 'import data from "./data.json";\nimport "./b.ts";',
      "packages/website/scripts/data.json": '{ "import": "@iracedeck/iracing-sdk" }',
      "packages/website/scripts/b.ts": `import "./gallery.mts";`,
    });

    expect(visited).toEqual([ROOT_FILE, "packages/website/scripts/data.json", "packages/website/scripts/b.ts"]);
    expect(problems).toEqual([]);
  });

  // An .mdx page is a root, since ESLint reads none (#1662), and the walk
  // passes through the .astro components it renders.
  it("fails an .mdx page's package import and an .astro frontmatter's, through the chain, and no markup mention", () => {
    const page = "packages/website/src/content/docs/planted.mdx";
    const card = "packages/website/src/components/Card.astro";
    const { visited, problems } = walk(
      {
        [page]: [
          "---",
          "title: Planted",
          "---",
          "",
          'import Card from "../../components/Card.astro";',
          'import { rows } from "@iracedeck/iracing-actions";',
          "",
          'Prose naming "@iracedeck/iracing-sdk" and `import("@iracedeck/deck-iracing")` in a code span.',
          "",
          "<Card />",
        ].join("\n"),
        [card]: [
          "---",
          'import { Image } from "astro:assets";',
          'import data from "../data/generated.json";',
          'import { Flags } from "@iracedeck/iracing-sdk";',
          "---",
          "",
          '<p>import x from "@iracedeck/deck-iracing"</p>',
          "<script>",
          '  import "@iracedeck/iracing-sdk/dist/setup.js";',
          "</script>",
        ].join("\n"),
      },
      page,
    );

    expect(visited).toEqual([page, card]);
    expect(problems).toEqual([
      expect.stringMatching(
        /^packages\/website\/src\/content\/docs\/planted\.mdx imports @iracedeck\/iracing-actions: /,
      ),
      expect.stringMatching(
        /planted\.mdx → packages\/website\/src\/components\/Card\.astro imports @iracedeck\/iracing-sdk: /,
      ),
      expect.stringMatching(/Card\.astro imports @iracedeck\/iracing-sdk\/dist\/setup\.js: /),
    ]);
  });

  it("follows an .astro <script src> as the import Astro bundles it into, and fails a template's load", () => {
    const card = "packages/website/src/components/Card.astro";
    const viaSrc = walk(
      {
        [card]: '<p>x</p>\n<script src="../../../iracing-actions/src/a.ts"></script>\n',
        "packages/iracing-actions/src/a.ts": 'import "@iracedeck/iracing-sdk";',
      },
      card,
    );

    expect(viaSrc.visited).toEqual([card, "packages/iracing-actions/src/a.ts"]);
    expect(viaSrc.problems).toEqual([
      expect.stringContaining(`${card} → packages/iracing-actions/src/a.ts imports @iracedeck/iracing-sdk: `),
    ]);
    expect(walk({ [card]: "<script src='@iracedeck/iracing-sdk'></script>" }, card).problems).toEqual([
      expect.stringContaining(`${card} imports @iracedeck/iracing-sdk: `),
    ]);
    expect(walk({ [card]: '---\n---\n<p>{import("@iracedeck/iracing-sdk")}</p>\n' }, card).problems).toEqual([
      `${card} makes an import( call in its markup (line 3), where a template expression is not read: make the load ` +
        "in the module code (an .astro frontmatter or <script>, an .mdx import) so it can be followed",
    ]);
    // The browser's own fetch is no module of the repository's, and nor is an is:inline script's src.
    expect(walk({ [card]: '<script src="https://cdn.example.com/x.js"></script>' }, card).problems).toEqual([]);
    expect(walk({ [card]: '<script is:inline src="/diagram-zoom.js"></script>' }, card)).toEqual({
      visited: [card],
      problems: [],
    });
    // A processed script's root-absolute src is an absolute path the walk cannot follow.
    expect(walk({ [card]: '<script src="/diagram-zoom.js"></script>' }, card).problems).toEqual([
      `${card} imports /diagram-zoom.js, an absolute path or URL this check cannot follow`,
    ]);
  });

  it("reads a <script> body past a comment opener in it, and fails a markup comment that never closes", () => {
    const card = "packages/website/src/components/Card.astro";
    const script = '<script>\n  const marker = "<!--";\n  await import("@iracedeck/iracing-sdk");\n</script>\n';

    expect(walk({ [card]: script }, card).problems).toEqual([
      expect.stringContaining(`${card} imports @iracedeck/iracing-sdk: `),
    ]);
    expect(walk({ [card]: `<!-- ${script} -->` }, card).problems).toEqual([]);
    expect(walk({ [card]: `<p>x</p><!-- never closed\n${script}` }, card).problems).toEqual([
      `${card} makes an HTML comment opened on line 1 that never closes, which hides the rest of the file: close it ` +
        "with --> so what follows can be read",
    ]);
  });

  // A template expression is JavaScript, where "<!--" opens no comment and so hides nothing after it.
  it("reads past a comment opener in a template expression to the <script src> and body after it", () => {
    const card = "packages/website/src/components/Card.astro";

    for (const source of [
      '<p>{"<!--"}</p>\n<script src="../../../iracing-actions/src/a.ts"></script>\n<!-- note -->\n',
      "<p>{`<!--`}</p>\n<script>import \"@iracedeck/iracing-sdk\";</script>\n<p>-->{'x'}</p>\n",
    ]) {
      const { problems } = walk(
        { [card]: source, "packages/iracing-actions/src/a.ts": 'import "@iracedeck/iracing-sdk";' },
        card,
      );

      expect(problems, source).toEqual([expect.stringMatching(/imports @iracedeck\/iracing-sdk: /)]);
    }
  });

  // Astro compiles each script alone: a `//` comment ending one hides nothing after it on its line.
  it("reads a <script src> after a script that ends in a line comment on the same line", () => {
    const card = "packages/website/src/components/Card.astro";
    const { problems } = walk(
      {
        [card]: '<script>// Setup</script><script src="../../../iracing-actions/src/a.ts"></script>\n',
        "packages/iracing-actions/src/a.ts": 'import "@iracedeck/iracing-sdk";',
      },
      card,
    );

    expect(problems).toEqual([
      expect.stringContaining(`${card} → packages/iracing-actions/src/a.ts imports @iracedeck/iracing-sdk: `),
    ]);
  });

  // A backtick in an MDX expression opens a template literal, not a code span, so the load in it runs.
  it("fails a load in a template literal inside an .mdx expression, and passes one in a code span", () => {
    const page = "packages/website/src/content/docs/planted.mdx";

    expect(walk({ [page]: 'Prose {`${String(import("./client.js"))}`}.\n' }, page).problems).toEqual([
      `${page} makes an import( call in its markup (line 1), where a template expression is not read: make the ` +
        "load in the module code (an .astro frontmatter or <script>, an .mdx import) so it can be followed",
    ]);
    expect(walk({ [page]: 'Prose `import("./client.js")` in a code span.\n' }, page).problems).toEqual([]);
  });

  it("passes a missing data file, which loads nothing, and still fails a missing component or module", () => {
    expect(only('import data from "./generated.json";\nimport logo from "./logo.svg";').problems).toEqual([]);
    for (const specifier of ["./Missing.astro", "./missing.mdx", "./missing", "./missing.mjs"]) {
      expect(only(`import x from "${specifier}";`).problems, specifier).toEqual([
        expect.stringContaining(`imports ${specifier}, which resolves to no file`),
      ]);
    }
  });

  // Vite hands over a ?url import's URL and a ?raw import's text: no module code runs.
  it("passes a ?url or ?raw import of any file as a leaf, and fails every other query, the file there or not", () => {
    const tree = {
      "packages/website/scripts/x.ts": 'import "@iracedeck/iracing-sdk";',
      "packages/website/scripts/x.json": "{}",
      "packages/website/scripts/x.css": "a {}",
    };

    for (const specifier of ["./logo.svg?url", "./x.ts?raw", "./x.ts?url", "./missing.mts?raw"]) {
      expect(walk({ ...tree, [ROOT_FILE]: `import x from "${specifier}";` }), specifier).toEqual({
        visited: [ROOT_FILE],
        problems: [],
      });
    }
    for (const specifier of [
      "./x.ts?worker",
      "./x.ts?worker&url",
      "./x.ts?url&worker",
      "./x.css?inline",
      "./x.ts?raw&x",
      "./x.json?worker",
      "./x.ts?",
      "./x.ts#frag",
    ]) {
      expect(walk({ ...tree, [ROOT_FILE]: `import x from "${specifier}";` }).problems, specifier).toEqual([
        `${ROOT_FILE} imports ${specifier}, whose query this check does not follow: only ?raw and ?url, which load ` +
          "no code, pass; import the module itself so it can be followed",
      ]);
    }
  });

  // Plain Node loads ./helper.cjs as written; TypeScript and tsx may take helper.cts beside it.
  it("follows every file a relative specifier may load, so neither of two candidates can hide a load", () => {
    const sim = 'import "@iracedeck/iracing-sdk";';
    const dir = "packages/website/scripts";

    for (const [specifier, a, b] of [
      ["./helper.cjs", "helper.cjs", "helper.cts"],
      ["./helper.mjs", "helper.mjs", "helper.mts"],
      ["./helper.js", "helper.js", "helper.ts"],
      ["./helper", "helper.js", "helper.ts"],
      ["./helper", "helper.ts", "helper/index.ts"],
    ]) {
      for (const [dirty, clean] of [
        [a, b],
        [b, a],
      ]) {
        const { visited, problems } = walk({
          [ROOT_FILE]: `import "${specifier}";`,
          [`${dir}/${dirty}`]: sim,
          [`${dir}/${clean}`]: "export const clean = 1;",
        });

        expect(visited, `${specifier}: ${dirty}`).toEqual(expect.arrayContaining([`${dir}/${a}`, `${dir}/${b}`]));
        expect(problems, `${specifier}: ${dirty}`).toEqual([
          expect.stringContaining(`${ROOT_FILE} → ${dir}/${dirty} imports @iracedeck/iracing-sdk`),
        ]);
      }
    }
  });

  // Node loads a file with no extension as CommonJS: it is code, not a leaf.
  it("reads a file with no extension that a specifier names exactly as JavaScript", () => {
    const helper = "packages/website/scripts/helper";
    const { visited, problems } = walk({
      [ROOT_FILE]: 'const h = require("./helper");',
      [helper]: 'module.exports = require("@iracedeck/iracing-sdk");',
    });

    expect(visited).toEqual([ROOT_FILE, helper]);
    expect(problems).toEqual([expect.stringContaining(`${ROOT_FILE} → ${helper} imports @iracedeck/iracing-sdk: `)]);
  });

  // A folder's package.json main is loaded before its index.
  it("follows a folder with a package.json to its main, not its index, and its index without a main", () => {
    const dir = "packages/website/scripts/dir";
    const sim = 'require("@iracedeck/iracing-sdk");';

    for (const [manifest, entry] of [
      ['{ "main": "lib/entry.js" }', `${dir}/lib/entry.js`],
      ['{ "main": "./lib/entry" }', `${dir}/lib/entry.ts`],
      ['{ "main": "lib" }', `${dir}/lib/index.js`],
      ['{ "name": "x" }', `${dir}/index.js`],
    ]) {
      const { visited, problems } = walk({
        [ROOT_FILE]: 'require("./dir");',
        [`${dir}/package.json`]: manifest,
        [entry]: sim,
        ...(entry === `${dir}/index.js` ? {} : { [`${dir}/index.js`]: "module.exports = 1;" }),
      });

      expect(visited, manifest).toEqual([ROOT_FILE, entry]);
      expect(problems, manifest).toEqual([
        expect.stringContaining(`${ROOT_FILE} → ${entry} imports @iracedeck/iracing-sdk`),
      ]);
    }
  });

  it("fails a folder whose package.json it cannot follow: exports, a main it cannot resolve, or no JSON object", () => {
    const dir = "packages/website/scripts/dir";
    const index = { [`${dir}/index.js`]: "module.exports = 1;" };

    for (const [manifest, message] of [
      [
        '{ "exports": "./lib/entry.js", "main": "index.js" }',
        'whose package.json has "exports", which this check does not follow',
      ],
      ['{ "main": "lib/missing.js" }', 'whose package.json has a "main", lib/missing.js, that resolves to no file'],
      ['{ "main": 1 }', 'whose package.json has a "main" this check cannot follow'],
      ['{ "main": "." }', 'whose package.json has a "main" this check cannot follow'],
      ["not json", "whose package.json is not a JSON object this check can read"],
      ["[]", "whose package.json is not a JSON object this check can read"],
    ]) {
      const { visited, problems } = walk({
        [ROOT_FILE]: 'require("./dir");',
        [`${dir}/package.json`]: manifest,
        ...index,
      });

      expect(visited, manifest).toEqual([ROOT_FILE]);
      expect(problems, manifest).toEqual([
        `${ROOT_FILE} imports ./dir, a folder, ${dir}, ${message}: import the file it loads by its own path so it ` +
          "can be followed",
      ]);
    }
  });

  it("fails a #subpath specifier, since it does not follow a package.json imports map", () => {
    for (const source of ['import x from "#internal/x.js";', 'const y = require("#y");', 'await import("#z");']) {
      expect(only(source).problems, source).toEqual([
        expect.stringMatching(
          /imports #\S+, a package.json "imports" subpath: this check does not follow package\.json imports; import by relative path or package name$/,
        ),
      ]);
    }
  });

  it("excuses only the exact UNREAD_LOADS call in its own file, at any depth, and fails a stale entry", () => {
    const unreadLoads = { "packages/a/src/a.ts": { calls: ["require(id)"], reason: "a control's excused load" } };
    const made = (file, call) => `${file} makes ${call}, whose specifier is not a string literal: write it`;

    expect(unexcusedProblems([made("packages/a/src/a.ts", "require(id)")], unreadLoads)).toEqual([]);
    expect(unexcusedProblems([`packages/r/x.ts → ${made("packages/a/src/a.ts", "require(id)")}`], unreadLoads)).toEqual(
      [],
    );
    for (const other of [made("packages/a/src/a.ts", "require(other)"), made("packages/b/src/a.ts", "require(id)")]) {
      expect(unexcusedProblems([other, made("packages/a/src/a.ts", "require(id)")], unreadLoads)).toEqual([other]);
    }
    expect(unexcusedProblems([], unreadLoads)).toEqual([
      "UNREAD_LOADS says packages/a/src/a.ts makes require(id), but the walk no longer finds it: remove it",
    ]);
  });

  // One allowance is one call site: a second spelled the same is another load nobody has vouched for.
  it("excuses a call only as many times as its entry allows, and none of them when the walk finds another number", () => {
    const made = `packages/a/src/a.ts makes require(id), whose specifier is not a string literal: write it`;
    const once = { "packages/a/src/a.ts": { calls: ["require(id)"], reason: "a control's excused load" } };
    const twice = { "packages/a/src/a.ts": { calls: [{ call: "require(id)", count: 2 }], reason: "a control's two" } };
    const mismatch = (allowed, found) =>
      `UNREAD_LOADS says packages/a/src/a.ts makes require(id) ${allowed} time(s), but the walk finds it ${found} ` +
      "times: excuse each call site the entry's reason holds for, and no other";

    expect(unexcusedProblems([made, made], once)).toEqual([made, made, mismatch(1, 2)]);
    expect(unexcusedProblems([made, made], twice)).toEqual([]);
    expect(unexcusedProblems([made], twice)).toEqual([made, mismatch(2, 1)]);
    expect(unexcusedProblems([made, made, made], twice)).toEqual([made, made, made, mismatch(2, 3)]);
  });

  it("walks several roots once each, naming a failure by the first root that reaches it", () => {
    const shared = "packages/website/scripts/shared.ts";
    const { visited, problems } = runtimeClosure({
      roots: [ROOT_FILE, "packages/website/scripts/other.ts", "packages/website/scripts/gone.ts"],
      read: (file) =>
        ({
          [ROOT_FILE]: 'import "./shared.js";',
          "packages/website/scripts/other.ts": 'import "./shared.js";',
          [shared]: 'import "@iracedeck/iracing-sdk";',
        })[file],
      packageDirs,
      neutral,
    });

    expect(visited).toEqual([ROOT_FILE, "packages/website/scripts/other.ts", shared]);
    expect(problems).toEqual([
      "packages/website/scripts/gone.ts does not exist",
      expect.stringMatching(
        new RegExp(`^${ROOT_FILE} → ${shared} imports @iracedeck/iracing-sdk: .*so ${ROOT_FILE} loads it at runtime`),
      ),
    ]);
  });

  it("fails a missing root rather than passing it empty", () => {
    expect(walk({})).toEqual({ visited: [], problems: [`${ROOT_FILE} does not exist`] });
  });

  it("finds the import #1662 cut when it is put back into a real iracing-actions file the gallery loads", () => {
    const closure = (read) => runtimeClosure({ roots: [GALLERY], read, packageDirs: PACKAGE_DIRS, neutral: NEUTRAL });
    // The last iracing-actions file the real walk reaches: the deepest, so the planted chain has hops.
    const file = closure(readRepoFile)
      .visited.filter((at) => at.startsWith("packages/iracing-actions/"))
      .at(-1);
    const real = readRepoFile(file);
    // iracing-native: no file the gallery loads imports it directly, before or after #1662.
    const planted = `import { loadAddon } from "@iracedeck/iracing-native";\n${real}`;
    const run = (source) =>
      closure((at) => (at === file ? source : readRepoFile(at))).problems.filter((problem) =>
        problem.includes(`${file} imports @iracedeck/iracing-native:`),
      );

    expect(file).toBeDefined();
    expect(run(real)).toEqual([]);
    expect(run(planted)).toEqual([
      expect.stringMatching(
        new RegExp(`^${GALLERY} → .*${file} imports @iracedeck/iracing-native: packages/iracing-native/`),
      ),
    ]);
  });
});
