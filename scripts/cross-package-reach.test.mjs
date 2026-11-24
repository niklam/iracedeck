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
// website's `.astro` components and `.mdx` pages included, every path the
// file names relative to itself is resolved and must not land inside
// `packages/<other>/`. An `.astro` component or `.mdx` page is read by its raw
// text as well as as code (`componentLoads`, #1662): every `./` or `../`
// literal in it, quoted or bare, in markup, prose or a fence as much as in its
// frontmatter or a script, is such a path. In a code source a path is:
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
// not sim-neutral. An `.astro` component or `.mdx` page is not parsed but read
// by its raw text (`componentLoads`): every literal specifier in it, anywhere,
// counts as a load — a relative or root-absolute one is followed where it
// resolves and ignored where it does not, since it then loads nothing, and an
// `@iracedeck/` one is checked as an import is — and a computed load (an
// `import(` or `require` of anything but one string literal, any
// `createRequire`, a glob of module code) fails as unread. A structural reader
// leaked three times where it disagreed with Astro and MDX; this one
// over-approximates instead, and NAMED_NOT_LOADED names each literal that
// loads nothing, with the reason. The ESLint block stays as the editor's early
// word on a static or type import.
//
// The threat model: the walk catches an accidental load of the sim stack — an
// import, a path or a mention written as it would be by someone not trying to
// hide it. Deliberate computed loads — `eval`, `new Function`, strings
// assembled at run time — are outside its model.
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { SIM_NEUTRAL_PACKAGES } from "../eslint.config.js";
import {
  COMPONENT,
  componentLoads,
  isModuleSource,
  isTestSource,
  moduleReferences,
  packageOf,
  trackedFiles,
  trackedPackageSources,
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
    calls: ["require(id)", "process.getBuiltinModule(id)"],
    reason:
      "the watchdog worker's body loads Node builtins by name (node:worker_threads, node:fs), through require " +
      "or process.getBuiltinModule, since an eval worker cannot import; both calls only ever receive builtin ids",
  },
  "packages/pi-components/src/build/callout-pi-groups.mjs": {
    calls: ["import(entryUrl)"],
    reason:
      'imports what import.meta.resolve("@iracedeck/callout-settings") names, a sim-neutral package, in a child ' +
      "process so Rollup's watch mode reads the registry fresh each build",
  },
};

/**
 * Literal specifiers in a sim-neutral package's `.astro` components and `.mdx`
 * pages that load nothing (#1662): each file with the exact literals, as the
 * walk reads them (`componentLoads`), and the reason. A component is read by
 * its raw text, so a package named in its prose counts as a load; an entry
 * says why one does not. A literal is excused as many times as the file
 * spells it: once, or `count` times when it is written `{ literal, count }`.
 * Exact, so another literal in that file still fails, and so does an entry
 * the walk finds another number of times, none included.
 */
const NAMED_NOT_LOADED = {
  "packages/website/src/content/docs/changelog.mdx": {
    literals: ["@iracedeck/actions", "@iracedeck/iracing-actions"],
    reason:
      "the released 1.14.0 section's prose records the package rename @iracedeck/actions → @iracedeck/iracing-actions; " +
      "the page is Markdown text the release fold writes one bullet at a time, and holds no import or expression. " +
      "Each count spans changelog.mdx and the changelog.d fragments read with it, so the fold, which moves a " +
      "bullet from one to the other, keeps it",
  },
};

/**
 * The problems of a walk that UNREAD_LOADS and NAMED_NOT_LOADED do not
 * excuse, and a line for each entry the walk finds another number of times
 * than it allows: none at all, which is stale, or more or fewer, when none of
 * them is excused. An UNREAD_LOADS call matches a problem `<file> makes
 * <call>,`; a NAMED_NOT_LOADED literal one `<file> names <literal>:` or `,`,
 * whether the file is a root or further down a chain.
 */
export function unexcusedProblems(problems, unreadLoads, namedNotLoaded = {}) {
  const excused = new Set();
  const lines = [];
  const entries = [
    ...Object.entries(unreadLoads).flatMap(([file, { calls }]) =>
      calls.map((entry) => ({ list: "UNREAD_LOADS", file, verb: "makes", ...countOf(entry, "call") })),
    ),
    ...Object.entries(namedNotLoaded).flatMap(([file, { literals }]) =>
      literals.map((entry) => ({ list: "NAMED_NOT_LOADED", file, verb: "names", ...countOf(entry, "literal") })),
    ),
  ];

  for (const { list, file, verb, what, count } of entries) {
    const made = `${file} ${verb} ${what}`;
    const found = problems.flatMap((problem, at) => {
      const arrow = problem.indexOf(` → ${made}`);
      const start = problem.startsWith(made) ? 0 : arrow === -1 ? -1 : arrow + " → ".length;
      const next = problem[start + made.length];

      return start !== -1 && (next === "," || next === ":") ? [at] : [];
    });

    if (found.length === count) {
      for (const at of found) excused.add(at);
    } else if (found.length === 0) {
      lines.push(`${list} says ${made}, but the walk no longer finds it: remove it`);
    } else {
      lines.push(
        `${list} says ${made} ${count} time(s), but the walk finds it ${found.length} times: ` +
          "excuse each call site the entry's reason holds for, and no other",
      );
    }
  }

  return [...problems.filter((_problem, at) => !excused.has(at)), ...lines];
}

/** An allow-list entry, `"x"` or `{ [key]: "x", count }`, as `{ what, count }`. */
function countOf(entry, key) {
  return typeof entry === "string" ? { what: entry, count: 1 } : { what: entry[key], count: entry.count ?? 1 };
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
  // An .astro or .mdx file's whole text is read as code too, for the paths its code builds: as TSX, for its markup.
  if (/\.[cm]?tsx$|\.(astro|mdx)$/.test(file)) return ts.ScriptKind.TSX;
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
 * file builds from its own location by constants (the header says which). An
 * `.astro` component or `.mdx` page is read by its raw text too
 * (`componentLoads`): every `./` or `../` literal in it, quoted or bare, in
 * markup, prose or a fence as much as in its code, besides what the code
 * reading finds over the whole text. Pure: `source` is the file's text, so the
 * positive controls can plant one.
 *
 * @param {object} input
 * @param {string} input.file repo-relative, `/`-separated (`packages/<pkg>/…`)
 * @param {string} input.source
 * @returns {string[]}
 */
export function pathsNamed({ file, source }) {
  const named = codePathsNamed(file, source);

  if (COMPONENT.test(file)) {
    for (const candidate of componentLoads(source).candidates) named.push(...unanchoredPaths(file, candidate));
  }

  return [...new Set(named)].sort();
}

/** The directory `file` runs from: the repository root for a test, its package root for anything else. */
const runDirOf = (file) => (isTestSource(file) ? REPO : `${REPO}/packages/${file.split("/")[1]}`);

/** `abs`, a path in the virtual tree, repo-relative; none when it lies outside the repository. */
const inRepo = (abs) => (abs === REPO || abs.startsWith(`${REPO}/`) ? [P.relative(REPO, abs)] : []);

/**
 * The repo-relative paths `seg`, a path `file` spells without anchoring it,
 * names: `./` or `../` against the file's directory and the run directory,
 * `packages/…` against the run directory, as `fs` and `path.resolve` read it.
 */
function unanchoredPaths(file, seg) {
  const dir = P.dirname(`${REPO}/${file}`);
  const runDir = runDirOf(file);

  if (RELATIVE_LITERAL.test(seg)) return [...inRepo(P.resolve(dir, seg)), ...inRepo(P.resolve(runDir, seg))];
  if (RUN_DIR_LITERAL.test(seg)) return inRepo(P.resolve(runDir, seg));

  return [];
}

/** The paths `file`, read as code from `source`, names: its module specifiers, path literals and built paths. */
function codePathsNamed(file, source) {
  const fileAbs = `${REPO}/${file}`;
  const dir = P.dirname(fileAbs);
  const runDir = runDirOf(file);
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const { pathModules, urlModules, functions } = moduleBindings(sf);
  const consts = constInitializers(sf);
  const named = new Set();
  const note = (abs) => {
    for (const at of inRepo(abs)) named.add(at);
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

  /** A path the file spells without anchoring it (`unanchoredPaths`). */
  const noteUnanchored = (seg) => {
    for (const at of unanchoredPaths(file, seg)) named.add(at);
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

/** A browser's worker constructors, and Node's `worker_threads` `Worker`: each runs the file its first argument names. */
const WORKER_CONSTRUCTORS = new Set(["Worker", "SharedWorker"]);

/** The modules Node's `Worker` comes from, whose `eval: true` option runs its first argument as code, not a file. */
const WORKER_THREADS_MODULES = new Set(["worker_threads", "node:worker_threads"]);

/**
 * The worker constructors of `sf` (#1662): `Worker` and `SharedWorker`, every
 * name the file binds one of them to (an import's or a destructuring's alias,
 * from any module) and any `.Worker` or `.SharedWorker` property. Names are
 * file-wide, as the require functions' are, so a shadowing name reads as one
 * too, which can only fail a file, never pass one.
 *
 * `isNodeEval` is true for a `new` of a name imported as `Worker` from
 * `node:worker_threads` whose options are an object literal with `eval: true`:
 * Node runs that first argument as source code rather than loading a file, a
 * load assembled at run time like `eval`, which the threat model leaves out
 * (the header). A browser's `Worker` has no such option and loads its first
 * argument as a URL whatever the options say, so it gets no such reading, nor
 * does any spelling of the option but the literal `true`.
 */
function workerConstructors(sf) {
  const names = new Set(WORKER_CONSTRUCTORS);
  const nodeWorkers = new Set();
  const find = (node) => {
    if (ts.isImportSpecifier(node) && WORKER_CONSTRUCTORS.has((node.propertyName ?? node.name).text)) {
      const declaration = node.parent.parent.parent;

      names.add(node.name.text);
      if (
        (node.propertyName ?? node.name).text === "Worker" &&
        ts.isStringLiteral(declaration.moduleSpecifier) &&
        WORKER_THREADS_MODULES.has(declaration.moduleSpecifier.text)
      ) {
        nodeWorkers.add(node.name.text);
      }
    }
    if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      WORKER_CONSTRUCTORS.has((node.propertyName ?? node.name).getText(sf))
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, find);
  };

  find(sf);
  const isWorker = (node) => {
    const callee = unwrap(node);

    return (
      (ts.isIdentifier(callee) && names.has(callee.text)) ||
      (ts.isPropertyAccessExpression(callee) && WORKER_CONSTRUCTORS.has(callee.name.text))
    );
  };
  const isNodeEval = (construction) => {
    const callee = unwrap(construction.expression);
    const options = construction.arguments?.[1] && unwrap(construction.arguments[1]);

    return (
      ts.isIdentifier(callee) &&
      nodeWorkers.has(callee.text) &&
      options !== undefined &&
      ts.isObjectLiteralExpression(options) &&
      options.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText(sf) === "eval" &&
          unwrap(property.initializer).kind === ts.SyntaxKind.TrueKeyword,
      )
    );
  };

  return { isWorker, isNodeEval };
}

/**
 * The specifier a worker's `new URL(<string literal>, import.meta.url)` names,
 * as the walk reads a specifier: relative from the file as written, a bare
 * name (`"w.mjs"`, which a URL resolves beside the file) made `./`-relative,
 * and an absolute path or URL kept for the walk to refuse. Undefined for any
 * other form: a computed path, another base, no `URL` at all.
 */
function workerSpecifier(argument) {
  if (argument === undefined) return undefined;
  const url = unwrap(argument);

  if (!ts.isNewExpression(url) || !ts.isIdentifier(unwrap(url.expression)) || unwrap(url.expression).text !== "URL") {
    return undefined;
  }
  if (url.arguments?.length !== 2) return undefined;
  const [where, base] = url.arguments.map(unwrap);

  if (!ts.isStringLiteralLike(where) || base.getText().replace(/\s+/g, "") !== "import.meta.url") return undefined;

  return UNFOLLOWABLE.test(where.text) || RELATIVE_SPECIFIER.test(where.text) ? where.text : `./${where.text}`;
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
 * which copy of it resolves, not which package it is. A worker
 * (`workerConstructors`) loads the file its first argument names when that is
 * `new URL(<string literal>, import.meta.url)` (`workerSpecifier`), resolved
 * from the file; started from anything else it is reported, except Node's
 * `eval: true` worker, which runs source code, not a file. What does not:
 * `import type`, `export type`, `import type x = require()` and the type
 * `import("x").T`, which TypeScript and esbuild drop whatever the config.
 *
 * `scripts` holds the specifiers of the loads that run their file as
 * JavaScript whatever its suffix — a require function's, `import x =
 * require()`'s and a worker's — as Node runs `require("./build.config")`;
 * an `import` or `import()` reads a file by its extension instead.
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
 * under a name this does not know, and a Vite `import.meta.glob(…)` of module
 * code, which this does not expand (one of data files is a leaf,
 * `isDataGlob`).
 *
 * An `.astro` component or `.mdx` page is not parsed: it is read by its raw
 * text (`componentLoads`), so `loads` is empty and `candidates` holds every
 * literal specifier the text spells, wherever it is — frontmatter, a script,
 * markup, prose, a fence, a comment — for the walk to follow where it resolves
 * (`runtimeClosure`); a load a literal cannot say (a computed `import(`, any
 * `require` not called with one literal, any `createRequire`, a glob of module
 * code) is `unread`.
 *
 * @param {object} input
 * @param {string} input.file repo-relative, `/`-separated
 * @param {string} input.source
 * @returns {{ loads: string[], scripts: string[], candidates: string[], unread: string[] }}
 */
export function runtimeImports({ file, source }) {
  if (COMPONENT.test(file)) return { loads: [], scripts: [], ...componentLoads(source, { isDataGlob }) };

  return { ...moduleImports(file, source), candidates: [] };
}

/** What a code source `file`, whose text is `source`, loads and makes that this cannot follow (`runtimeImports`). */
function moduleImports(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const loads = [];
  const scripts = [];
  const unread = [];
  const classified = new Set();
  /** Records a load of `literal`; `script` when it runs the file as JavaScript whatever its suffix. */
  const load = (literal, script = false) => {
    classified.add(literal.getStart(sf));
    loads.push(literal.text);
    if (script) scripts.push(literal.text);
  };
  const typeOnly = (literal) => classified.add(literal.getStart(sf));
  const { requireNames, isCreateRequire, madeHere, isFactory } = requireFunctions(sf);
  const { isWorker, isNodeEval } = workerConstructors(sf);
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
    // getBuiltinModule loads a module by a name, and through `module` a require function by any name (#1662).
    if (ts.isIdentifier(node) && node.text === "getBuiltinModule") {
      const member = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
      const outer = wrapped(member);
      const used = ts.isCallExpression(outer.parent) && outer.parent.expression === outer ? outer.parent : member;

      unread.push(
        `${spelled(used)}, a load through getBuiltinModule, which this check cannot follow: load the module with ` +
          "import and a string literal",
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
    // A worker runs the file its URL names: a load, read as JavaScript whatever the file's suffix (#1662).
    if (ts.isNewExpression(node) && isWorker(node.expression) && !isNodeEval(node)) {
      const specifier = workerSpecifier(node.arguments?.[0]);

      if (specifier === undefined) {
        unread.push(
          `${spelled(node)}, a worker started from something other than new URL(<string literal>, ` +
            "import.meta.url): start it from one so the file it runs can be followed",
        );
      } else {
        loads.push(specifier);
        scripts.push(specifier);
      }
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
      // `import x = require("x")` is a require: it runs what it names as JavaScript.
      if (node.isTypeOnly) typeOnly(node.moduleReference.expression);
      else load(node.moduleReference.expression, true);
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
        load(specifier, node.expression.kind !== ts.SyntaxKind.ImportKeyword);
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

  return { loads, scripts, unread };
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
 * holding an `index`. Every specifier, one ending in `.js` included, is tried
 * as a folder too (`folderEntry`), since CommonJS loads
 * `require("./helpers.js")` from a folder `helpers.js/` when no such file is
 * there.
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
  // A `.js` name may be a folder too (`require("./helpers.js")` of `helpers.js/index.js`), as any name may.
  const folder = folderEntry(target, read, depth);
  const files = Object.hasOwn(SOURCE_EXTENSIONS, ext)
    ? existing(SOURCE_EXTENSIONS[ext].map((to) => target.slice(0, -ext.length) + to))
    : existing([target, ...EXTENSIONLESS.map((to) => target + to)]);

  return { files: [...files, ...folder.files], unread: folder.unread };
}

/**
 * The files the folder `target` loads as a module (`resolveRuntimeFiles`):
 * its `package.json`'s `main`, resolved from the folder, or without a `main`
 * (or a `package.json`) its `index`; none when there is no such folder.
 * `unread` says why a `package.json` is not followed.
 */
function folderEntry(target, read, depth) {
  const existing = (candidates) => candidates.filter((candidate) => read(candidate) !== undefined);
  const index = () => ({ files: existing(EXTENSIONLESS.map((to) => `${target}/index${to}`)), unread: [] });
  const manifest = read(`${target}/package.json`);

  if (manifest === undefined) return index();
  const folder = `a folder, ${target}, whose package.json`;
  let pkg;

  try {
    pkg = JSON.parse(manifest);
  } catch {
    pkg = null;
  }
  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
    return { files: [], unread: [`${folder} is not a JSON object this check can read`] };
  }
  if (Object.hasOwn(pkg, "exports")) {
    return { files: [], unread: [`${folder} has "exports", which this check does not follow`] };
  }
  if (!Object.hasOwn(pkg, "main")) return index();
  if (typeof pkg.main !== "string" || P.normalize(P.join(target, pkg.main)) === target || depth > 8) {
    return { files: [], unread: [`${folder} has a "main" this check cannot follow`] };
  }
  const entry = resolveRuntimeFiles(`${target}/package.json`, `./${pkg.main}`, read, depth + 1);

  if (entry.files.length === 0 && entry.unread.length === 0) {
    return { files: [], unread: [`${folder} has a "main", ${pkg.main}, that resolves to no file`] };
  }

  return entry;
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

/**
 * The extensions a `require` reads as something other than JavaScript: JSON
 * and a native addon. Node runs a file of any other suffix it requires —
 * `build.config`, `x.svg` — as CommonJS (#1662).
 */
const RUN_AS_DATA = new Set([".json", ".node"]);

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
 *   * Only what loads at runtime is an edge, as `runtimeImports` reads it, so
 *     a walk passes through the website's pages too: an `.astro` component or
 *     an `.mdx` page is read by its raw text, every literal specifier in it
 *     counted as a load (the next rule), and a computed load failing as unread.
 *   * A candidate of a component (`componentLoads`) is followed where it
 *     resolves and ignored where it does not, because a specifier that
 *     resolves to nothing cannot load anything: an import of it fails the
 *     build, so the over-approximation drops no load by ignoring it. A relative
 *     one resolves from the component's directory (`resolveRuntimeFiles`), a
 *     root-absolute one from its package root and from that package's
 *     `public/`, as Vite and the browser read one; a `#fragment` is dropped,
 *     and a query other than `?raw` or `?url` on one that resolves fails. An
 *     `@iracedeck/` one is checked as a package specifier is, so a mention in
 *     prose fails like an import unless NAMED_NOT_LOADED excuses it.
 *   * A component's `companions` are read as part of it: their raw text by
 *     the same rule, their candidates resolved as the component's own, and
 *     each failure naming the companion it is written in. The changelog page
 *     takes in every `changelog.d/` fragment (`changelogFragments`), whose
 *     bullet the stable release folds into it, so a fragment's mention fails
 *     on its own PR and the fold moves a mention without changing a count.
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
 *     read (`resolveRuntimeFiles`). A file a require function, `import x =
 *     require()` or a worker runs (`runtimeImports`' `scripts`) is read as
 *     JavaScript whatever its suffix, as Node runs `require("./build.config")`,
 *     unless it is `.json` or `.node` (`RUN_AS_DATA`); so only those two are a
 *     leaf to it, and one with any other suffix must resolve.
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
 * @param {Map<string, string[]>} [input.companions] component → the files whose text the release writes into it
 * @returns {{ visited: string[], problems: string[] }}
 */
export function runtimeClosure({ roots, read, packageDirs, neutral, companions = new Map() }) {
  const present = roots.filter((root) => read(root) !== undefined);
  const from = new Map(present.map((root) => [root, null]));
  const queue = [...present];
  const problems = roots.filter((root) => read(root) === undefined).map((root) => `${root} does not exist`);
  const chain = (file) => {
    const files = [];

    for (let at = file; at !== null; at = from.get(at)) files.unshift(at);

    return files.join(" → ");
  };

  /** The files a require function, `import =` or a worker runs: JavaScript, whatever their suffix. */
  const runs = new Set();
  const parsed = new Set();

  while (queue.length > 0) {
    const file = queue.shift();

    if (parsed.has(file)) continue;
    // A file with no extension at all is JavaScript to Node, which loads it as CommonJS; so is any a require runs.
    if (!isModuleSource(file) && P.extname(file) !== "" && !runs.has(file)) continue;
    parsed.add(file);
    const { loads, scripts, candidates, unread } = memoizedImports(file, read(file));
    /**
     * Queues each file `targets` names that the walk has not met, as loaded by
     * `file`; with `script`, as run as JavaScript (`runs`), which queues again
     * one met before only as data, now with `file` as the one that loads it.
     */
    const follow = (targets, script = false) => {
      for (const target of targets) {
        const ran = script && !RUN_AS_DATA.has(P.extname(target)) && !runs.has(target);

        if (ran) runs.add(target);
        if (from.has(target)) {
          if (ran && !parsed.has(target) && from.get(target) !== null) {
            from.set(target, file);
            queue.push(target);
          }
          continue;
        }
        from.set(target, file);
        queue.push(target);
      }
    };
    /**
     * The failure, if any, of `file` loading the package `specifier` names, as
     * `verb` says it does: one that names no workspace package, or one that is
     * not sim-neutral.
     */
    const packageProblem = (verb, specifier) => {
      const name = packageOf(specifier);
      const dir = name === null ? undefined : packageDirs.get(name);

      if (dir === undefined) {
        return name?.startsWith("@iracedeck/")
          ? `${chain(file)} ${verb} ${specifier}, which names no workspace package`
          : undefined;
      }
      if (neutral.has(dir)) return undefined;

      return verb === "imports"
        ? `${chain(file)} imports ${specifier}: packages/${dir}/ is not sim-neutral (SIM_NEUTRAL_PACKAGES in ` +
            `eslint.config.js), so ${chain(file).split(" → ")[0]} loads it at runtime. Cut the chain, or import only types from it ` +
            "with `import type` (#1662)"
        : `${chain(file)} names ${specifier}: packages/${dir}/ is not sim-neutral (SIM_NEUTRAL_PACKAGES in ` +
            `eslint.config.js), and an .astro or .mdx file is read by its raw text, every literal specifier in it ` +
            `a load, so ${chain(file).split(" → ")[0]} may load it at runtime. Cut the chain; a mention that loads ` +
            "nothing goes in NAMED_NOT_LOADED with the reason (#1662)";
    };

    /** What the component says, and its companions (`companions`), each with where a failure says it is written. */
    const parts = [{ candidates, unread, where: "" }];

    for (const companion of companions.get(file) ?? []) {
      const text = read(companion);

      if (text === undefined) {
        problems.push(`${chain(file)} takes in ${companion}, which does not exist`);
        continue;
      }
      parts.push({
        ...memoizedImports(file, text),
        where: ` (written in ${companion}, which the release folds into ${file})`,
      });
    }

    const tried = new Set();

    /** Follows, ignores or fails one candidate of the component, as the walk's rules say. */
    const takeCandidate = (candidate, where) => {
      if (candidate.startsWith("@")) {
        const problem = packageProblem("names", candidate);

        if (problem !== undefined) problems.push(problem + where);

        return;
      }
      if (tried.has(candidate)) return;
      tried.add(candidate);
      const unhashed = candidate.replace(/#.*$/, "");
      const query = unhashed.indexOf("?");
      const base = query === -1 ? unhashed : unhashed.slice(0, query);
      const own = `packages/${file.split("/")[1]}`;
      const landsAt = base.startsWith("/") ? P.join(own, `.${base}`) : P.join(P.dirname(file), base);

      // A path out of the repository depends on where it is checked out: what it loads cannot be followed.
      if (landsAt === ".." || landsAt.startsWith("../")) {
        problems.push(
          `${chain(file)} names ${base}, a machine-specific path this check cannot follow; use a relative path ` +
            `inside the repository${where}`,
        );

        return;
      }
      const resolved = base.startsWith("/")
        ? [`${own}/package.json`, `${own}/public/index.html`].map((at) => resolveRuntimeFiles(at, `.${base}`, read))
        : [resolveRuntimeFiles(file, base, read)];
      const targets = resolved.flatMap((each) => each.files);
      const folders = resolved.flatMap((each) => each.unread);

      // A specifier that resolves to nothing loads nothing: the build would fail on an import of it.
      if (targets.length === 0 && folders.length === 0) return;
      if (query !== -1) {
        if (!isDataSpecifier(unhashed)) {
          problems.push(
            `${chain(file)} names ${unhashed}, whose query this check does not follow: only ?raw and ?url, ` +
              `which load no code, pass; import the module itself so it can be followed${where}`,
          );
        }

        return;
      }
      for (const folder of folders) {
        problems.push(
          `${chain(file)} names ${base}, ${folder}: import the file it loads by its own path so it can be ` +
            `followed${where}`,
        );
      }
      follow(targets);
    };

    for (const { candidates: said, unread: unsaid, where } of parts) {
      for (const what of unsaid) problems.push(`${chain(file)} makes ${what}${where}`);
      for (const candidate of said) takeCandidate(candidate, where);
    }

    for (const specifier of loads) {
      const script = scripts.includes(specifier);

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
        // A require runs a missing build.config as readily as a .js: only .json and .node are data to it.
        const data =
          script && !QUERY.test(specifier) ? RUN_AS_DATA.has(P.extname(specifier)) : isDataSpecifier(specifier);

        if (targets.length === 0 && folders.length === 0 && data) continue;
        if (targets.length === 0 && folders.length === 0) {
          problems.push(`${chain(file)} imports ${specifier}, which resolves to no file in the repository`);
        }
        follow(targets, script);
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

      const problem = packageProblem("imports", specifier);

      if (problem !== undefined) problems.push(problem);
    }
  }

  return { visited: [...from.keys()], problems };
}

const PACKAGES = new Set(trackedPackageDirs(ROOT));
// The .astro components and .mdx pages too, read by their raw text (#1662).
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

/** The public changelog page, which a stable release writes every `changelog.d/` fragment into. */
const CHANGELOG = "packages/website/src/content/docs/changelog.mdx";

/**
 * The changelog fragments among repo-relative `files`, sorted: every
 * `changelog.d/<name>.md` but the folder's `README.md`, the one file there that
 * is no fragment (`changelog.md`). Each is read as part of the changelog page
 * (`runtimeClosure`'s `companions`), since the release folds its bullet in.
 */
export function changelogFragments(files) {
  return files.filter((file) => /^changelog\.d\/[^/]+\.md$/.test(file) && file !== "changelog.d/README.md").sort();
}

/** The changelog page and the fragments the release folds into it (#1662). */
const COMPANIONS = new Map([
  [
    CHANGELOG,
    changelogFragments(trackedFiles(ROOT, "changelog.d")),
  ],
]);

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
 * every load such a file makes is read here (a component's by its raw text,
 * `componentLoads`), the dynamic `import()` and
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
    runtimeClosure({
      roots: from,
      read: readRepoFile,
      packageDirs: PACKAGE_DIRS,
      neutral: NEUTRAL,
      companions: COMPANIONS,
    });
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
    expect(unexcusedProblems(all.problems, UNREAD_LOADS, NAMED_NOT_LOADED)).toEqual([]);
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
      }).problems.filter((problem) => new RegExp(`^${file} (imports|names) @iracedeck/`).test(problem));

    expect(roots).toContain(file);
    expect(loadsIn(real)).toEqual([]);
    expect(loadsIn(planted)).toEqual([
      expect.stringMatching(new RegExp(`^${file} (imports|names) @iracedeck/iracing-(actions|sdk): packages/iracing-`)),
    ]);
  });

  // A new fragment naming a sim package fails on its own PR, against the real page and its real fragments.
  it("fails a fragment planted beside the real ones that names a sim package, naming the fragment", () => {
    const planted = "changelog.d/1999-planted.md";
    const fragments = COMPANIONS.get(CHANGELOG);
    const problemsWith = (extra) =>
      unexcusedProblems(
        runtimeClosure({
          roots: [CHANGELOG],
          read: (file) => (file === planted ? extra : readRepoFile(file)),
          packageDirs: PACKAGE_DIRS,
          neutral: NEUTRAL,
          companions: new Map([[CHANGELOG, [...fragments, planted]]]),
        }).problems,
        // The changelog's own entry: a walk from this one root meets no other file's UNREAD_LOADS.
        {},
        { [CHANGELOG]: NAMED_NOT_LOADED[CHANGELOG] },
      );

    expect(fragments.every((file) => file.startsWith("changelog.d/") && file !== "changelog.d/README.md")).toBe(true);
    expect(problemsWith("---\ncategory: Maintenance\nweight: 50\n---\n\nNothing here.\n")).toEqual([]);
    expect(
      problemsWith("---\ncategory: Maintenance\nweight: 50\n---\n\n**X** now uses @iracedeck/iracing-sdk.\n"),
    ).toEqual([
      expect.stringContaining(`${CHANGELOG} names @iracedeck/iracing-sdk: packages/iracing-sdk/ is not sim-neutral`),
    ]);
    expect(
      problemsWith(
        "---\ncategory: Maintenance\nweight: 50\n---\n\n**X** now uses @iracedeck/iracing-sdk.\n",
      )[0].endsWith(` (written in ${planted}, which the release folds into ${CHANGELOG})`),
    ).toBe(true);
  });

  it("gives every UNREAD_LOADS and NAMED_NOT_LOADED entry a reason", () => {
    for (const [file, { calls, reason }] of Object.entries(UNREAD_LOADS)) {
      expect(calls.length, file).toBeGreaterThan(0);
      expect(reason.length, file).toBeGreaterThan(20);
    }
    for (const [file, { literals, reason }] of Object.entries(NAMED_NOT_LOADED)) {
      expect(literals.length, file).toBeGreaterThan(0);
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

  // The website's components and pages, in their code (#1662).
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
      // A path built from constants, which no literal spells: the code reading over the whole text finds it.
      [
        astro,
        '---\nimport { join } from "node:path";\nconst ROWS = join(import.meta.dirname, "..", "..", "..", "iracing-actions", "src", "rows.js");\n---\n\n<p>{ROWS}</p>\n',
      ],
    ]) {
      expect(reach(file, source), source).toEqual(target);
    }
  });

  // Read by their raw text (#1662): a path is a reach wherever it is spelled, so none hides in markup or prose.
  it("counts a relative path in .astro markup, a comment or a JSON script, and in .mdx frontmatter, prose or a fence", () => {
    const astro = "packages/deck-core/src/components/Planted.astro";
    const mdx = "packages/deck-core/src/content/planted.mdx";
    const target = { "iracing-actions": ["packages/iracing-actions/src/rows.js"] };

    for (const [file, source] of [
      [astro, '<p>import { rows } from "../../../iracing-actions/src/rows.js"</p>'],
      [astro, '<a href="../../../iracing-actions/src/rows.js">rows</a>'],
      [astro, "<img src=../../../iracing-actions/src/rows.js>"],
      [astro, '<!-- <script>import "../../../iracing-actions/src/rows.js";</script> -->'],
      [astro, '<script type="application/json">{ "rows": "../../../iracing-actions/src/rows.js" }</script>'],
      [mdx, '---\nhero: "../../../iracing-actions/src/rows.js"\n---\n'],
      [mdx, "Prose: see ../../../iracing-actions/src/rows.js for the rows."],
      [mdx, '```ts\nimport { rows } from "../../../iracing-actions/src/rows.js";\n```'],
      [mdx, "![rows](../../../iracing-actions/src/rows.js)"],
    ]) {
      expect(reach(file, source), source).toEqual(target);
    }
  });

  it("passes a component that names only its own package's files and package names", () => {
    const source = [
      "---",
      'import Card from "./Card.astro";',
      'import { x } from "@iracedeck/deck-core";',
      "---",
      '<a href="/docs/actions/">Actions</a> and ../notes/ in prose.',
    ].join("\n");

    expect(reach("packages/deck-core/src/components/Planted.astro", source)).toEqual({});
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
        // A name bound twice, in two scopes, is own-based only if every binding is, whichever comes first.
        `function a() {\n  const load = createRequire(import.meta.url);\n}\nfunction b() {\n  const load = createRequire(${base});\n  load("./x.js");\n}`,
        `function b() {\n  const load = createRequire(${base});\n  load("./x.js");\n}\nfunction a() {\n  const load = createRequire(import.meta.url);\n}`,
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

  // qa's gb plant, in a code source: getBuiltinModule("module") hands over createRequire under any name (#1662).
  it("fails a code source's getBuiltinModule, called or taken by name", () => {
    const through = (spelled) =>
      `${ROOT_FILE} makes ${spelled}, a load through getBuiltinModule, which this check cannot follow: load the ` +
      "module with import and a string literal";

    expect(only('const { createRequire: make } = process.getBuiltinModule("module");').problems).toEqual([
      through('process.getBuiltinModule("module")'),
    ]);
    expect(only("const { getBuiltinModule } = process;\ngetBuiltinModule(name);").problems).toEqual([
      through("getBuiltinModule"),
      through("getBuiltinModule(name)"),
    ]);
    expect(only("const load = (process).getBuiltinModule;").problems).toEqual([through("(process).getBuiltinModule")]);
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

  // An .astro component or an .mdx page is read by its raw text (#1662): every literal specifier in it is a
  // candidate load, followed where it resolves and ignored where it does not, and a load a literal cannot say
  // fails as unread. Three rounds of a structural reader leaked where it disagreed with Astro and MDX.
  describe("an .astro component or .mdx page, read by its raw text", () => {
    const page = "packages/website/src/content/docs/planted.mdx";
    const card = "packages/website/src/components/Card.astro";
    const sim = "packages/iracing-actions/src/a.ts";
    const SIM = { [sim]: 'import "@iracedeck/iracing-sdk";' };
    /** The failure of `chainText` naming the non-neutral `specifier`. */
    const names = (chainText, specifier) => expect.stringContaining(`${chainText} names ${specifier}: packages/`);
    /** The failure of a walk from `chainText` into SIM's file, which imports a sim package. */
    const intoSim = (chainText) => expect.stringContaining(`${chainText} → ${sim} imports @iracedeck/iracing-sdk: `);

    it("fails a package an .mdx page or .astro component names anywhere, through the chain it follows", () => {
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
            'Prose naming @iracedeck/iracing-sdk and `import("@iracedeck/deck-iracing")` in a code span.',
            "",
            "<Card />",
          ].join("\n"),
          [card]: [
            "---",
            'import { Image } from "astro:assets";',
            'import data from "../data/generated.json";',
            "---",
            "",
            '<p>import x from "@iracedeck/iracing-sdk"</p>',
            '<!-- <script>import "@iracedeck/iracing-sdk/dist/setup.js";</script> -->',
          ].join("\n"),
        },
        page,
      );

      expect(visited).toEqual([page, card]);
      expect(problems).toEqual([
        names(page, "@iracedeck/iracing-actions"),
        names(page, "@iracedeck/iracing-sdk"),
        `${page} names @iracedeck/deck-iracing, which names no workspace package`,
        names(`${page} → ${card}`, "@iracedeck/iracing-sdk"),
        names(`${page} → ${card}`, "@iracedeck/iracing-sdk/dist/setup.js"),
      ]);
    });

    // A processed <script src> is the import Astro bundles; an is:inline one, a comment's or a fence's loads
    // nothing, but the raw rule does not model them: following them is the over-approximation, accepted.
    it.each([
      ["a processed <script src>", card, '<script src="../../../iracing-actions/src/a.ts"></script>'],
      ["an is:inline <script src>", card, '<script is:inline src="../../../iracing-actions/src/a.ts"></script>'],
      ["an unquoted <script src>", card, "<script src=../../../iracing-actions/src/a.ts></script>"],
      ["a <script src> in an HTML comment", card, '<!-- <script src="../../../iracing-actions/src/a.ts"></script> -->'],
      ["a Markdown image", page, "![diagram](../../../../iracing-actions/src/a.ts)"],
      ["a Markdown reference definition", page, "[diagram]: ../../../../iracing-actions/src/a.ts"],
      ["an import in a fence alone", page, '```ts\nimport "../../../../iracing-actions/src/a.ts";\n```'],
    ])("follows a relative literal wherever it is: %s", (_name, file, source) => {
      expect(walk({ [file]: source, ...SIM }, file)).toEqual({ visited: [file, sim], problems: [intoSim(file)] });
    });

    // Soundness: a specifier that resolves to no file loads nothing, since an import of it fails the build.
    it("ignores a relative literal that resolves to nothing", () => {
      const source = [
        '<script src="./missing.ts"></script>',
        '<script src="../../../iracing-actions/src/gone.ts"></script>',
        "See ../elsewhere/ and ./notes.",
      ].join("\n");

      expect(walk({ [card]: source, ...SIM }, card)).toEqual({ visited: [card], problems: [] });
    });

    it("follows a root-absolute literal from the package root and its public/, and ignores a URL", () => {
      const zoom = "packages/website/public/diagram-zoom.js";
      const shared = "packages/website/src/shared.ts";
      const source = [
        '<script src="/diagram-zoom.js"></script>',
        '<script src="/src/shared.ts"></script>',
        '<a href="/docs/actions/">Actions</a>',
        '<script src="https://cdn.example.com/x.js"></script>',
        '<script src="//cdn.example.com/y.js"></script>',
      ].join("\n");
      const { visited, problems } = walk(
        { [card]: source, [zoom]: 'import "@iracedeck/iracing-sdk";', [shared]: 'import "./a.js";' },
        card,
      );

      expect(visited).toEqual([card, zoom, shared]);
      expect(problems).toEqual([
        expect.stringContaining(`${card} → ${zoom} imports @iracedeck/iracing-sdk: `),
        `${card} → ${shared} imports ./a.js, which resolves to no file in the repository`,
      ]);
    });

    // qa's 319d61a0b a7 plant: Astro decodes a character reference in a src, and a build loads what it spells.
    it.each([
      [
        "numeric character references",
        '<script src="&#46;&#46;/&#46;&#46;/&#x2e;&#x2E;/iracing-actions/src/a.ts"></script>',
      ],
      ["named character references", '<script src="&period;&period;&sol;../../iracing-actions/src/a.ts"></script>'],
      ["JavaScript escapes", '---\nconst m = await import("\\x2e\\u002e/../../iracing-actions/src/a.ts");\n---\n'],
      ["percent-encoding", '<script src="%2E%2E/../../iracing-actions/src/a.ts"></script>'],
      ["Windows separators", '<script src="..\\..\\..\\iracing-actions\\src\\a.ts"></script>'],
    ])("reads a specifier spelled with %s", (_name, source) => {
      expect(walk({ [card]: source, ...SIM }, card)).toEqual({ visited: [card, sim], problems: [intoSim(card)] });
    });

    it("reads a package name in any case, through a character reference, and without a sentence's full stop", () => {
      for (const source of [
        "Mention @IRACEDECK/Iracing-SDK here.",
        "Mention &commat;iracedeck/iracing-sdk here.",
        "This needs @iracedeck/iracing-sdk.",
      ]) {
        expect(walk({ [page]: source }, page).problems, source).toEqual([names(page, "@iracedeck/iracing-sdk")]);
      }
    });

    it.each([
      ["a template literal with ${…}", "<p>{import(`../x/${name}`)}</p>", "import"],
      ["a name", "<p>{import(name)}</p>", "import"],
      ["a comment before a name", "<p>{import(/* x */ name)}</p>", "import"],
      ["nothing", "<p>{import()}</p>", "import"],
      ["a concatenation", '<p>{require("../x/" + name)}</p>', "require"],
      ["a require handed on", "<p>{[name].map(require)}</p>", "require"],
      ["a require whose name is escaped", "<p>{requ\\u0069re(name)}</p>", "require"],
      ["a property of require", "<p>{require.call(null, name)}</p>", "require"],
    ])("fails a load a literal cannot say: %s", (_name, source, word) => {
      const message =
        word === "import"
          ? "an import( on line 1 whose specifier is not a single string literal, a load this check cannot read: " +
            "write the specifier as a literal"
          : "a require on line 1 that is not called with a single string literal, a load this check cannot read: " +
            "write the specifier as a literal";

      expect(walk({ [card]: source }, card).problems).toEqual([`${card} makes ${message}`]);
    });

    // MDX compiles its ESM into one module, so a require function a block makes loads in the next: under a name the
    // raw text cannot follow, so any createRequire is refused.
    it("fails any createRequire, whose require functions load under names this does not know", () => {
      const source = [
        'import { createRequire as cr } from "node:module";',
        "",
        "export const req = cr(import.meta.url);",
        "",
        "export const sdk = req(name);",
      ].join("\n");

      expect(walk({ [page]: source }, page).problems).toEqual([
        `${page} makes a createRequire on line 1, whose require functions this check cannot follow under the names ` +
          "they get: load the module with import and a string literal",
      ]);
    });

    it("passes a glob of data files or by ?raw or ?url, and fails one of module code or one it cannot read", () => {
      for (const source of [
        '---\nconst logos = import.meta.glob<string>("../assets/brands/*.{svg,png}", { eager: true });\n---\n',
        '---\nconst raw = import.meta.glob("../x/*.ts", { query: "?raw" });\n---\n',
      ]) {
        expect(walk({ [card]: source }, card).problems, source).toEqual([]);
      }
      for (const source of [
        '---\nconst modules = import.meta.glob("../x/*.ts");\n---\n',
        "---\nconst modules = import.meta.glob(patterns);\n---\n",
        "---\nconst glob = import.meta.glob;\n---\n",
      ]) {
        expect(walk({ [card]: source }, card).problems, source).toEqual([
          `${card} makes an import.meta.glob on line 2 that is not a glob of data files, which this check does not ` +
            "expand: import each module by a string literal",
        ]);
      }
    });

    it("takes ?raw and ?url as a leaf, fails another query on a file that exists, and follows past a fragment", () => {
      const local = "packages/website/src/components/a.ts";
      const tree = { [local]: 'import "@iracedeck/iracing-sdk";' };

      expect(walk({ ...tree, [card]: '<script src="./a.ts?raw"></script> "./a.ts?url"' }, card)).toEqual({
        visited: [card],
        problems: [],
      });
      expect(walk({ ...tree, [card]: '<script src="./a.ts?worker"></script> "./missing.ts?worker"' }, card)).toEqual({
        visited: [card],
        problems: [
          `${card} names ./a.ts?worker, whose query this check does not follow: only ?raw and ?url, which load no ` +
            "code, pass; import the module itself so it can be followed",
        ],
      });
      expect(walk({ ...tree, [card]: '<a href="./a.ts#top">x</a>' }, card).problems).toEqual([
        expect.stringContaining(`${card} → ${local} imports @iracedeck/iracing-sdk: `),
      ]);
    });

    // qa's earlier reproducers, each a place a structural reader read the wrong thing as code or as text.
    it.each([
      [
        "a comment opener in an expression before a <script src>",
        card,
        '<p>{"<!--"}</p>\n<script src="../../../iracing-actions/src/a.ts"></script>\n<!-- note -->\n',
      ],
      [
        "a script ending in a line comment before a <script src> on its line",
        card,
        '<script>// Setup</script><script src="../../../iracing-actions/src/a.ts"></script>\n',
      ],
      [
        "a load in a template literal inside an .mdx expression",
        page,
        'Prose {`${String(import("../../../../iracing-actions/src/a.ts"))}`}.\n',
      ],
      [
        "a regular expression after a ) whose backtick opens no template",
        card,
        '{(() => { if (1) /`/.test(""); return null })()}\n<script src="../../../iracing-actions/src/a.ts"></script>\n{"`" + "})()}"}\n',
      ],
      [
        "a regular expression after a block's }",
        card,
        '{(() => { { } /`/.test(""); return null })()}\n<script src="../../../iracing-actions/src/a.ts"></script>\n{"`" + "})()}"}\n',
      ],
    ])("follows past %s", (_name, file, source) => {
      expect(walk({ [file]: source, ...SIM }, file).problems).toEqual([intoSim(file)]);
    });
  });

  // A walk from a real page with qa's plants in it, each a false negative a structural reader gave (#1662): F1 and F2
  // at 319d61a0b, the rest from the two rounds before. Every one fails now, by the literal it spells.
  describe("qa's reproducers, planted into the real pages they were found on", () => {
    const downloads = "packages/website/src/content/docs/downloads.mdx";
    const notFound = "packages/website/src/pages/404.astro";
    const cameraGroups = "../../../iracing-actions/src/actions/camera-controls/camera-groups.ts";
    const hidden = (opener) =>
      `\n\`\`\`md\nimport { ECOSYSTEMS } from "../../data/brands"; ${opener}\n\`\`\`\n\nimport X from "@iracedeck/iracing-actions";\n`;
    const indented = (indent) =>
      `\n${indent}\`\`\`md\n\nimport { ECOSYSTEMS } from "../../data/brands"; /*\n${indent}\`\`\`\n\nimport X from "@iracedeck/iracing-actions";\n\n*/\n`;
    const realWalk = (file, source) =>
      runtimeClosure({
        roots: [file],
        read: (at) => (at === file ? source : readRepoFile(at)),
        packageDirs: PACKAGE_DIRS,
        neutral: NEUTRAL,
      }).problems;
    const namesActions = (file) => new RegExp(`^${file} names @iracedeck/iracing-actions: packages/iracing-actions/`);
    const loadsSdk = (file) =>
      new RegExp(
        `^${file} → packages/iracing-actions/src/actions/camera-controls/camera-groups\\.ts imports @iracedeck/iracing-sdk: `,
      );

    it.each([
      ["F1, a code fence indented four spaces", downloads, indented("    "), namesActions],
      ["F1, a code fence indented by a tab", downloads, indented("\t"), namesActions],
      [
        "F2, a regular expression after a )",
        notFound,
        `\n{(() => { if (1) /\`/.test(""); return null })()}\n<script src="${cameraGroups}"></script>\n{"\`" + "})()}"}\n`,
        loadsSdk,
      ],
      [
        "F2, a regular expression after a block's }",
        notFound,
        `\n{(() => { { } /\`/.test(""); return null })()}\n<script src="${cameraGroups}"></script>\n{"\`" + "})()}"}\n`,
        loadsSdk,
      ],
      ["a fenced comment opener hiding an import after it", downloads, hidden("/*"), namesActions],
      ["a fenced double quote hiding an import after it", downloads, hidden('const s = "'), namesActions],
      ["a fenced single quote hiding an import after it", downloads, hidden("const s = '"), namesActions],
      ["a fenced backtick hiding an import after it", downloads, hidden("const s = `"), namesActions],
      [
        "a fence an indented fence of another kind does not close",
        downloads,
        '\n```md\n  ```bash\nnot a fence close\n```\n\nimport X from "@iracedeck/iracing-actions";\n',
        namesActions,
      ],
      [
        "a fence that never closes",
        downloads,
        '\n```md\n  ```bash\nnot a fence close\n\nimport X from "@iracedeck/iracing-actions";\n```\n',
        namesActions,
      ],
      // Over-approximation, accepted: an import in a fence loads nothing, and fails as one that does.
      [
        "an import in a fence alone",
        downloads,
        '\n```md\nimport X from "@iracedeck/iracing-actions";\n```\n',
        namesActions,
      ],
      [
        "an .mdx relative import of camera-groups",
        downloads,
        `\nimport Cam from "../${cameraGroups}";\n`,
        (file) =>
          new RegExp(
            `^${file} → packages/iracing-actions/src/actions/camera-controls/camera-groups\\.ts imports @iracedeck/iracing-sdk: `,
          ),
      ],
      ["a processed <script src>", notFound, `\n<script src="${cameraGroups}"></script>\n`, loadsSdk],
      [
        "an is:inline <script src>, the over-approximation",
        notFound,
        `\n<script is:inline src="${cameraGroups}"></script>\n`,
        loadsSdk,
      ],
      [
        "a <script src> spelled with character references",
        notFound,
        `\n<script src="${cameraGroups.replaceAll(".", "&#46;")}"></script>\n`,
        loadsSdk,
      ],
      [
        "an import( in a template expression",
        notFound,
        '\n<div>{import("@iracedeck/iracing-actions")}</div>\n',
        namesActions,
      ],
    ])("fails %s", (_name, file, plant, expected) => {
      const real = readRepoFile(file);

      expect(realWalk(file, real)).toEqual([]);
      expect(realWalk(file, real + plant)).toEqual([expect.stringMatching(expected(file))]);
    });

    // qa's final round at 15c9d91dd, each plant as qa wrote it into the page's frontmatter or after it: a line
    // continuation inside a specifier, a machine-specific path, and getBuiltinModule (#1662).
    const intoFrontmatter = (file, line) => (real) => {
      const at = real.indexOf("\n", real.indexOf("---")) + 1;

      return `${real.slice(0, at)}${line}\n${real.slice(at)}`;
    };
    const afterFrontmatter = (file, line) => (real) => {
      const close = real.indexOf("\n---", real.indexOf("---") + 3);
      const at = real.indexOf("\n", close + 1) + 1;

      return `${real.slice(0, at)}\n${line}\n${real.slice(at)}`;
    };
    const machinePath = (line) => (file) =>
      new RegExp(
        `^${file} makes a machine-specific path on line ${line} this check cannot follow; use a relative path ` +
          "inside the repository$",
      );
    const outOfRepo = "../../../../../ir-1662/packages/iracing-actions/src/actions/camera-controls/camera-groups.ts";

    it.each([
      [
        "sp, a line continuation in an .astro import",
        notFound,
        intoFrontmatter(notFound, 'import QaX from "@\\\niracedeck/iracing-actions";'),
        namesActions,
      ],
      [
        "spx, a line continuation in an .mdx import",
        downloads,
        afterFrontmatter(downloads, 'import QaX from "@\\\niracedeck/iracing-actions";'),
        namesActions,
      ],
      [
        "st, a line continuation in a template literal",
        notFound,
        intoFrontmatter(notFound, "const qaM = await import(`@\\\niracedeck/iracing-actions`);"),
        namesActions,
      ],
      [
        "sr, a line continuation in a relative path",
        notFound,
        intoFrontmatter(
          notFound,
          `import QaX from "../../../iracing-act\\\nions/src/actions/camera-controls/camera-groups.ts";`,
        ),
        loadsSdk,
      ],
      [
        "ab, a drive-letter path",
        notFound,
        intoFrontmatter(
          notFound,
          'import QaX from "C:/repo/ir-1662/packages/iracing-actions/src/actions/camera-controls/camera-groups.ts";',
        ),
        machinePath(2),
      ],
      [
        "fs, a Vite /@fs/ path",
        notFound,
        intoFrontmatter(
          notFound,
          'import QaX from "/@fs/C:/repo/ir-1662/packages/iracing-actions/src/actions/camera-controls/camera-groups.ts";',
        ),
        machinePath(2),
      ],
      [
        "a file: URL",
        notFound,
        intoFrontmatter(notFound, 'import QaX from "file:///C:/repo/ir-1662/packages/iracing-actions/src/a.ts";'),
        machinePath(2),
      ],
      [
        "out, a relative path that climbs out of the repository",
        notFound,
        intoFrontmatter(notFound, `import QaX from "${outOfRepo}";`),
        (file) =>
          new RegExp(
            `^${file} names ${outOfRepo}, a machine-specific path this check cannot follow; use a relative path inside the repository$`,
          ),
      ],
      [
        "gb, getBuiltinModule",
        notFound,
        intoFrontmatter(
          notFound,
          'process.getBuiltinModule("module")["create" + "Require"](import.meta.url)(["@iracedeck", "iracing-actions"].join("/"));',
        ),
        (file) =>
          new RegExp(`^${file} makes a getBuiltinModule on line 2, which loads a module this check cannot follow`),
      ],
    ])("fails qa's final-round %s", (_name, file, plant, expected) => {
      const real = readRepoFile(file);
      const planted = plant(real);

      expect(planted).not.toBe(real);
      expect(realWalk(file, real)).toEqual([]);
      expect(realWalk(file, planted)).toEqual([expect.stringMatching(expected(file))]);
    });
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

  // Node runs any file a require names as CommonJS, whatever its suffix, but .json and .node (#1662).
  it("reads a file a require function, import = or a worker runs as JavaScript whatever its suffix", () => {
    const config = "packages/website/scripts/build.config";
    const sim = { [config]: 'module.exports = require("@iracedeck/iracing-sdk");' };
    const red = [expect.stringContaining(`${ROOT_FILE} → ${config} imports @iracedeck/iracing-sdk: `)];

    for (const source of [
      'const config = require("./build.config");',
      'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nload("./build.config");',
      'import { createRequire } from "node:module";\ncreateRequire(import.meta.url)("./build.config");',
      'import config = require("./build.config");',
      'new Worker(new URL("./build.config", import.meta.url));',
    ]) {
      expect(walk({ ...sim, [ROOT_FILE]: source }), source).toEqual({ visited: [ROOT_FILE, config], problems: red });
    }
    // An import reads a file by its extension: one that is no code is data, there or not.
    for (const source of ['import config from "./build.config";', 'const c = await import("./build.config");']) {
      expect(walk({ ...sim, [ROOT_FILE]: source }), source).toEqual({ visited: [ROOT_FILE, config], problems: [] });
    }
    // A file imported as data first and required later is read, once, through the file that requires it.
    const b = "packages/website/scripts/b.ts";

    expect(
      walk({ ...sim, [ROOT_FILE]: 'import "./build.config";\nimport "./b.ts";', [b]: 'require("./build.config");' }),
    ).toEqual({
      visited: [ROOT_FILE, config, b],
      problems: [expect.stringContaining(`${ROOT_FILE} → ${b} → ${config} imports @iracedeck/iracing-sdk: `)],
    });
  });

  it("takes a required .json or .node as a leaf, there or not, and fails a required file of another suffix that is not", () => {
    const tree = {
      "packages/website/scripts/x.json": '{ "a": "@iracedeck/iracing-sdk" }',
      "packages/website/scripts/addon.node": 'require("@iracedeck/iracing-sdk");',
    };

    for (const specifier of ["./x.json", "./addon.node", "./missing.json", "./missing.node"]) {
      expect(walk({ ...tree, [ROOT_FILE]: `require("${specifier}");` }).problems, specifier).toEqual([]);
    }
    for (const specifier of ["./missing.config", "./missing.svg"]) {
      expect(walk({ [ROOT_FILE]: `require("${specifier}");` }).problems, specifier).toEqual([
        `${ROOT_FILE} imports ${specifier}, which resolves to no file in the repository`,
      ]);
      // An import of the same missing file is data, as a gitignored generated file is.
      expect(walk({ [ROOT_FILE]: `import x from "${specifier}";` }).problems, specifier).toEqual([]);
    }
  });

  // A worker runs the file its URL names, resolved beside the file (#1662).
  it("follows a worker started from new URL(<literal>, import.meta.url), and fails one started otherwise", () => {
    const worker = "packages/website/scripts/w.mjs";
    const tree = (source) => ({
      [ROOT_FILE]: `import { Worker as NodeWorker } from "node:worker_threads";\n${source}`,
      [worker]: 'import "@iracedeck/iracing-sdk";',
    });

    for (const source of [
      'new Worker(new URL("./w.mjs", import.meta.url));',
      'new Worker(new URL("w.mjs", import.meta.url), { type: "module" });',
      'new SharedWorker(new URL("./w.mjs", import.meta.url));',
      'new NodeWorker(new URL("./w.mjs", import.meta.url));',
      'new globalThis.Worker((new URL("./w.mjs", import.meta.url)) as URL);',
      'new NodeWorker(new URL("./w.mjs", import.meta.url), { eval: false });',
    ]) {
      expect(walk(tree(source)), source).toEqual({
        visited: [ROOT_FILE, worker],
        problems: [expect.stringContaining(`${ROOT_FILE} → ${worker} imports @iracedeck/iracing-sdk: `)],
      });
    }
    for (const source of [
      'new Worker("./w.mjs");',
      "new SharedWorker(`./w.mjs`);",
      "new Worker(url);",
      "new Worker();",
      "new Worker(new URL(name, import.meta.url));",
      'new Worker(new URL("./w.mjs", base));',
      'new Worker(new URL("./w.mjs"));',
      'new Worker(new URL("./w.mjs", import.meta.url).href);',
      'new NodeWorker("./w.mjs", { eval: flag });',
      // A browser's Worker has no eval option: it loads its first argument as a URL whatever the options say.
      "new Worker(code, { eval: true });",
    ]) {
      expect(walk(tree(source)).problems, source).toEqual([
        `${ROOT_FILE} makes ${source.slice(0, -1)}, a worker started from something other than new ` +
          "URL(<string literal>, import.meta.url): start it from one so the file it runs can be followed",
      ]);
    }
    expect(walk(tree('new Worker(new URL("./missing.mjs", import.meta.url));')).problems).toEqual([
      `${ROOT_FILE} imports ./missing.mjs, which resolves to no file in the repository`,
    ]);
    for (const where of ["/abs/w.mjs", "https://example.com/w.mjs"]) {
      expect(walk(tree(`new Worker(new URL("${where}", import.meta.url));`)).problems, where).toEqual([
        `${ROOT_FILE} imports ${where}, an absolute path or URL this check cannot follow`,
      ]);
    }
  });

  // Node's eval worker runs source code, assembled at run time like eval: outside the threat model (the header).
  it("passes Node's eval: true worker, which runs code rather than a file, and only Node's", () => {
    for (const source of [
      'import { Worker } from "node:worker_threads";\nnew Worker(source, { eval: true, workerData });',
      'import { Worker as W } from "worker_threads";\nnew W(`require("@iracedeck/iracing-sdk")`, { eval: true });',
    ]) {
      expect(only(source), source).toEqual({ visited: [ROOT_FILE], problems: [] });
    }
    expect(only('import { Worker } from "some-worker-lib";\nnew Worker(source, { eval: true });').problems).toEqual([
      expect.stringContaining("a worker started from something other than new URL(<string literal>, import.meta.url)"),
    ]);
  });

  // CommonJS loads require("./helpers.js") from a folder helpers.js/ when no such file is there (#1662).
  it("follows a specifier with a code extension that names a folder to its index or main, beside its files", () => {
    const dir = "packages/website/scripts";
    const sim = 'module.exports = require("@iracedeck/iracing-sdk");';

    for (const [specifier, extra, entry] of [
      ["./helpers.js", {}, `${dir}/helpers.js/index.js`],
      ["./helpers.js", {}, `${dir}/helpers.js/index.ts`],
      ["./helpers.cjs", {}, `${dir}/helpers.cjs/index.js`],
      [
        "./helpers.js",
        { [`${dir}/helpers.js/package.json`]: '{ "main": "lib/entry.js" }' },
        `${dir}/helpers.js/lib/entry.js`,
      ],
    ]) {
      const { visited, problems } = walk({ [ROOT_FILE]: `require("${specifier}");`, ...extra, [entry]: sim });

      expect(visited, entry).toEqual([ROOT_FILE, entry]);
      expect(problems, entry).toEqual([
        expect.stringContaining(`${ROOT_FILE} → ${entry} imports @iracedeck/iracing-sdk`),
      ]);
    }
    // The files a .js name may be are still followed beside the folder, so neither can hide a load.
    for (const [dirty, clean] of [
      ["helpers.ts", "helpers.js/index.js"],
      ["helpers.js/index.js", "helpers.ts"],
    ]) {
      const { visited, problems } = walk({
        [ROOT_FILE]: 'require("./helpers.js");',
        [`${dir}/${dirty}`]: sim,
        [`${dir}/${clean}`]: "module.exports = 1;",
      });

      expect(visited, dirty).toEqual(expect.arrayContaining([`${dir}/${dirty}`, `${dir}/${clean}`]));
      expect(problems, dirty).toEqual([expect.stringContaining(`${ROOT_FILE} → ${dir}/${dirty} imports @iracedeck/`)]);
    }
    expect(
      walk({
        [ROOT_FILE]: 'require("./helpers.js");',
        [`${dir}/helpers.js/package.json`]: '{ "exports": "./x.js" }',
        [`${dir}/helpers.js/index.js`]: sim,
      }).problems,
    ).toEqual([
      `${ROOT_FILE} imports ./helpers.js, a folder, ${dir}/helpers.js, whose package.json has "exports", which this ` +
        "check does not follow: import the file it loads by its own path so it can be followed",
    ]);
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

  it("excuses only the exact NAMED_NOT_LOADED literal in its own file, as many times as allowed, and fails a stale entry", () => {
    const page = "packages/a/src/page.mdx";
    const namedNotLoaded = { [page]: { literals: ["@iracedeck/x"], reason: "a control's excused mention" } };
    const names = (file, literal) => `${file} names ${literal}: packages/x/ is not sim-neutral`;
    const unknown = (file, literal) => `${file} names ${literal}, which names no workspace package`;

    expect(unexcusedProblems([names(page, "@iracedeck/x")], {}, namedNotLoaded)).toEqual([]);
    expect(unexcusedProblems([unknown(page, "@iracedeck/x")], {}, namedNotLoaded)).toEqual([]);
    expect(unexcusedProblems([`packages/r/x.mdx → ${names(page, "@iracedeck/x")}`], {}, namedNotLoaded)).toEqual([]);
    for (const other of [
      names(page, "@iracedeck/y"),
      names("packages/b/src/page.mdx", "@iracedeck/x"),
      names(page, "@iracedeck/x-other"),
    ]) {
      expect(unexcusedProblems([other, names(page, "@iracedeck/x")], {}, namedNotLoaded)).toEqual([other]);
    }
    expect(unexcusedProblems([names(page, "@iracedeck/x"), names(page, "@iracedeck/x")], {}, namedNotLoaded)).toEqual([
      names(page, "@iracedeck/x"),
      names(page, "@iracedeck/x"),
      `NAMED_NOT_LOADED says ${page} names @iracedeck/x 1 time(s), but the walk finds it 2 times: excuse each call ` +
        "site the entry's reason holds for, and no other",
    ]);
    expect(unexcusedProblems([], {}, namedNotLoaded)).toEqual([
      `NAMED_NOT_LOADED says ${page} names @iracedeck/x, but the walk no longer finds it: remove it`,
    ]);
  });

  // The stable release folds each changelog.d fragment into changelog.mdx (#1386). Read as part of the page, a
  // fragment's mention fails on its own PR, and the fold moves a mention without changing a count (#1662).
  describe("the changelog page, read with the fragments the release folds into it", () => {
    const page = "packages/website/src/content/docs/changelog.mdx";
    const fragment = "changelog.d/1999-planted.md";
    const bullet = "**Planted** now loads nothing from @iracedeck/iracing-sdk.";
    const fragmentText = `---\ncategory: Maintenance\nweight: 50\n---\n\n${bullet}\n`;
    const released = "## 1.0.0\n\n**Maintenance**\n\n- Moved off @iracedeck/iracing-sdk.\n";
    /** The page after a stable release folds the fragment in and deletes it. */
    const folded = `## 1.1.0\n\n**Maintenance**\n\n- ${bullet}\n\n${released}`;
    const written = ` (written in ${fragment}, which the release folds into ${page})`;
    const walkPage = (tree, fragments) =>
      runtimeClosure({
        roots: [page],
        read: (file) => tree[file],
        packageDirs,
        neutral,
        companions: new Map([[page, fragments]]),
      }).problems;
    const allowing = (count) => ({
      [page]: { literals: [{ literal: "@iracedeck/iracing-sdk", count }], reason: "a control's mentions" },
    });

    it("fails a fragment's mention as the page's, naming the fragment, so its own PR goes red", () => {
      const problems = walkPage({ [page]: released, [fragment]: fragmentText }, [fragment]);

      expect(problems).toHaveLength(2);
      expect(problems[0]).toMatch(`${page} names @iracedeck/iracing-sdk: packages/iracing-sdk/`);
      expect(problems[0]).not.toContain("written in");
      expect(problems[1]).toMatch(`${page} names @iracedeck/iracing-sdk: packages/iracing-sdk/`);
      expect(problems[1].endsWith(written)).toBe(true);
      // The entry that held before the fragment counts one: the fragment's mention is a second.
      expect(unexcusedProblems(problems, {}, allowing(1))).toEqual([
        ...problems,
        `NAMED_NOT_LOADED says ${page} names @iracedeck/iracing-sdk 1 time(s), but the walk finds it 2 times: ` +
          "excuse each call site the entry's reason holds for, and no other",
      ]);
    });

    it("keeps a count across the fold: the entry that passes the fragment passes the page it is folded into", () => {
      const before = walkPage({ [page]: released, [fragment]: fragmentText }, [fragment]);
      const after = walkPage({ [page]: folded }, []);

      expect(after).toHaveLength(2);
      expect(after.some((problem) => problem.includes("written in"))).toBe(false);
      expect(unexcusedProblems(before, {}, allowing(2))).toEqual([]);
      expect(unexcusedProblems(after, {}, allowing(2))).toEqual([]);
    });

    it("reads a fragment's computed load as unread, naming the fragment, and fails a fragment that is gone", () => {
      expect(
        walkPage({ [page]: "", [fragment]: "---\ncategory: Maintenance\n---\n\n{import(name)}\n" }, [fragment]),
      ).toEqual([
        `${page} makes an import( on line 5 whose specifier is not a single string literal, a load this check ` +
          `cannot read: write the specifier as a literal${written}`,
      ]);
      expect(walkPage({ [page]: "" }, [fragment])).toEqual([`${page} takes in ${fragment}, which does not exist`]);
    });

    it("takes every changelog.d fragment and nothing else: no README.md, other file, subfolder or other changelog.d", () => {
      expect(
        changelogFragments([
          "changelog.d/README.md",
          "changelog.d/1999-planted.md",
          "changelog.d/12-earlier.md",
          "changelog.d/notes.txt",
          "changelog.d/sub/1-nested.md",
          "packages/x/changelog.d/1-elsewhere.md",
        ]),
      ).toEqual(["changelog.d/12-earlier.md", "changelog.d/1999-planted.md"]);
    });
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
