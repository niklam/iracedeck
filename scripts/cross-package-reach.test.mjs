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
// which leaves out `dist/`, plugin bundle folders and vendored files), every
// path the file names relative to itself is resolved and must not land inside
// `packages/<other>/`:
//   * a relative module specifier — import, export, dynamic import, `require`,
//     `import("…")` type, triple-slash `path` — read with `ts.preProcessFile`,
//     resolved against the file's directory;
//   * any other string literal starting `./` or `../` (a fixture path, a glob),
//     resolved against the file's directory and against the directory it runs
//     from (the repository root for a test, since the root suite runs every
//     test from there; the package root for anything else, where pnpm runs a
//     package's scripts and Rollup its config);
//   * a path built from the file's own location by constants — `join` /
//     `resolve` / `dirname` from `node:path`, `fileURLToPath` and `new URL(…,
//     import.meta.url)`, `import.meta.dirname`, `__dirname`, `process.cwd()`,
//     template literals and `+`, through any `const` the file declares once —
//     so `join(import.meta.dirname, "..", "..", "app-constants", "src")` is the
//     same reach as the one-string spelling, and so is a path joined onto a
//     repo-root constant derived the same way.
// A path that lands outside `packages/` — the root `scripts/lib/`, the root
// `changelog.d/`, the repository root itself, `packages/` as a whole — is not
// a reach. Neither is a path that cannot be worked out from constants (a
// function's parameter, a loop variable): this reads what the file says, not
// what it computes.
//
// ALLOWED names each file that reaches on purpose, the packages it reaches and
// why. A listed file that reaches a package its entry does not name fails; so
// does an entry whose file is gone or no longer reaches one of its packages.
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { isTestSource, moduleReferences, trackedPackageSources } from "./lib/source-imports.mjs";
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
      "ordering only, held by scripts/website-workspace-deps.test.mjs (#1458)",
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

/** A relative module specifier: `./x`, `../x`, `.` or `..`. */
const RELATIVE_SPECIFIER = /^\.\.?(\/|$)/;

/** A string literal read as a relative path. */
const RELATIVE_LITERAL = /^\.\.?\//;

const PATH_MODULES = new Set(["path", "node:path", "path/posix", "node:path/posix"]);
const URL_MODULES = new Set(["url", "node:url"]);

function scriptKind(file) {
  if (/\.[cm]?tsx$/.test(file)) return ts.ScriptKind.TSX;
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
 * file builds from its own location by constants (the header says which).
 * Pure: `source` is the file's text, so the positive controls can plant one.
 *
 * @param {object} input
 * @param {string} input.file repo-relative, `/`-separated (`packages/<pkg>/…`)
 * @param {string} input.source
 * @returns {string[]}
 */
export function pathsNamed({ file, source }) {
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

    if (ts.isStringLiteralLike(node)) return { seg: node.text };

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
            { seg: node.head.text },
            ...node.templateSpans.flatMap((span) => [evaluate(span.expression, depth + 1), { seg: span.literal.text }]),
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
        case "normalize":
          return args[0]?.abs === undefined ? undefined : { abs: P.normalize(args[0].abs), dir: args[0].dir };
        case "dirname":
          return args[0]?.abs === undefined ? undefined : { abs: P.dirname(args[0].abs), dir: true };
        case "join":
          return args[0]?.abs === undefined ? undefined : { abs: P.join(...values), dir: false };
        case "resolve":
          // A relative first segment resolves against the directory the code runs from, as Node's does.
          return { abs: P.resolve(runDir, ...values), dir: false };
        default:
          return undefined;
      }
    }

    return undefined;
  };

  const visit = (node, insideAnchoredPath) => {
    let inside = insideAnchoredPath;

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
      }
    } else if (
      ts.isStringLiteralLike(node) &&
      !inside &&
      !specifierAt.has(node.getStart(sf)) &&
      RELATIVE_LITERAL.test(node.text)
    ) {
      note(P.resolve(dir, node.text));
      note(P.resolve(runDir, node.text));
    }

    ts.forEachChild(node, (child) => visit(child, inside));
  };

  visit(sf, false);

  return [...named].sort();
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
 * @returns {string[]}
 */
export function reachProblems(found, allowed, files) {
  const problems = [];

  for (const [file, reaches] of found) {
    for (const [pkg, paths] of reaches) {
      if (allowed[file]?.reaches.includes(pkg)) continue;
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

  return problems;
}

const PACKAGES = new Set(trackedPackageDirs(ROOT));
const FILES = trackedPackageSources(ROOT);

function scan(files = FILES) {
  const found = new Map();

  for (const file of files) {
    const reaches = reachesOf({ file, source: readFileSync(path.join(ROOT, file), "utf-8"), packages: PACKAGES });

    if (reaches.size > 0) found.set(file, reaches);
  }

  return found;
}

describe("no package reaches into another by a relative path (#1375)", () => {
  const found = scan();

  it("scans every package's sources and finds the deliberate reaches, so the check is not vacuous", () => {
    expect(FILES.length).toBeGreaterThan(1000);
    expect(new Set(FILES.map((file) => file.split("/")[1])).size).toBe(PACKAGES.size - 0);
    expect([...found.keys()].sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it("finds a reach only in a file ALLOWED names, to a package its entry names, and no stale entry", () => {
    expect(reachProblems(found, ALLOWED, new Set(FILES))).toEqual([]);
  });

  it("gives every ALLOWED entry a reason", () => {
    for (const [file, { reaches, reason }] of Object.entries(ALLOWED)) {
      expect(reaches.length, file).toBeGreaterThan(0);
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
