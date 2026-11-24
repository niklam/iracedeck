import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  COMPONENT,
  componentLoads,
  importedPackages,
  isTestSource,
  moduleReferences,
  nulSeparatedPaths,
  packageOf,
  trackedFiles,
  trackedPackageSources,
  VENDORED_SOURCES,
} from "./source-imports.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

describe("importedPackages", () => {
  it("reads every import form, and no mention in a comment or a string", () => {
    const source = [
      'import a from "pkg-a";',
      'import type { B } from "@scope/b/sub/path";',
      'import "pkg-c";',
      'export { d } from "pkg-d";',
      'const e = await import("pkg-e");',
      'const f = require("pkg-f");',
      'import g from "node:path";',
      'import h from "fs";',
      'import i from "./local.js";',
      '// import j from "pkg-j";',
      '/* import("pkg-k") */',
      'const l = "import m from \\"pkg-m\\"";',
      "/** see `@iracedeck/pkg-n` */",
      'type O = typeof import("pkg-o");',
    ].join("\n");

    expect([...importedPackages(source)].sort()).toEqual([
      "@scope/b",
      "pkg-a",
      "pkg-c",
      "pkg-d",
      "pkg-e",
      "pkg-f",
      "pkg-o",
    ]);
  });

  it("names a scoped package without its subpath, and nothing for a relative path or a builtin", () => {
    expect(packageOf("@iracedeck/deck-core/testing")).toBe("@iracedeck/deck-core");
    expect(packageOf("zod/v4")).toBe("zod");
    expect(packageOf("../deck-core/src/index.js")).toBeNull();
    expect(packageOf("node:fs")).toBeNull();
    expect(packageOf("path")).toBeNull();
  });
});

describe("moduleReferences", () => {
  it("gives each import the offset of its opening quote, and keeps a triple-slash path apart", () => {
    const source = '/// <reference path="../types.d.ts" />\nimport a from "./a.js";\nconst b = require("../b");';
    const references = moduleReferences(source);

    expect(references).toEqual([
      { specifier: "./a.js", kind: "import", pos: source.indexOf('"./a.js"') },
      { specifier: "../b", kind: "import", pos: source.indexOf('"../b"') },
      { specifier: "../types.d.ts", kind: "reference" },
    ]);
    // A path reference is not a package.
    expect([...importedPackages(source)]).toEqual([]);
  });
});

describe("isTestSource", () => {
  it.each([
    "packages/x/src/a.test.ts",
    "packages/x/src/a.test.mjs",
    "packages/x/src/a.test-support.ts",
    "packages/x/src/a.test-util.ts",
    "packages/x/src/shared/dial-box-baseline.fixture-cases.ts",
    "packages/x/src/test-support/fake-host.ts",
  ])("counts %s as a test", (file) => {
    expect(isTestSource(file)).toBe(true);
  });

  it.each(["packages/x/src/a.ts", "packages/x/src/testing.ts", "packages/x/src/latest-support/a.ts"])(
    "counts %s as production",
    (file) => {
      expect(isTestSource(file)).toBe(false);
    },
  );
});

describe("componentLoads (#1662)", () => {
  /** The candidates `text` gives. */
  const candidates = (text) => componentLoads(text).candidates;
  const IMPORT = (line) =>
    `an import( on line ${line} whose specifier is not a single string literal, a load this check cannot read: ` +
    "write the specifier as a literal";
  const REQUIRE = (line) =>
    `a require on line ${line} that is not called with a single string literal, a load this check cannot read: ` +
    "write the specifier as a literal";

  it("reads every quoted string and bare path that may be a specifier, wherever it is, once per place", () => {
    const text = [
      "---",
      'import Card from "./Card.astro";',
      "const pkg = '@iracedeck/deck-core';",
      "---",
      '<p class="note">See ../notes/ and `../code.ts`.</p>',
      "<!-- <script src=../hidden.ts></script> -->",
      "![diagram](./diagram.svg) [ref]: /docs/ref/",
      'astro:assets zod "plain text" https://example.com/x //cdn.example.com/y',
    ].join("\n");

    expect(candidates(text)).toEqual([
      "./Card.astro",
      "@iracedeck/deck-core",
      "../notes/",
      "../code.ts",
      "/p",
      "../hidden.ts",
      "/script",
      "./diagram.svg",
      "/docs/ref/",
    ]);
  });

  // A structural reader pairs quotes, so one quote that opens nothing shifts every pair after it.
  it("reads a string past a quote before it on its line that opens none", () => {
    for (const text of [
      '<p>A 5" screen</p> <script src="../a b.ts"></script>',
      "<p>It's here</p> <script src='../a b.ts'></script>",
      "<p>`tick</p> <code>`../a b.ts`</code>",
    ]) {
      expect(candidates(text), text).toContain("../a b.ts");
    }
  });

  it("reads a specifier through character references and JavaScript escapes", () => {
    for (const text of [
      '<script src="&#46;&#46;/b.ts"></script>',
      '<script src="&#x2E;&#x2e;/b.ts"></script>',
      '<script src="&period;&period;&sol;b.ts"></script>',
      'import("\\x2e\\x2e/b.ts")',
      'import("\\u002e\\u{2e}/b.ts")',
    ]) {
      expect(candidates(text), text).toContain("../b.ts");
    }
    expect(candidates("&commat;iracedeck/iracing-sdk")).toEqual(["@iracedeck/iracing-sdk"]);
  });

  it("reads a path with \\ for /, percent-decoded, and with and without a sentence's punctuation", () => {
    expect(candidates('"..\\\\b.ts"')).toContain("../b.ts");
    expect(candidates("<script src=%2E%2E/b.ts>")).toContain("../b.ts");
    expect(candidates("See ./b.ts.")).toEqual(["./b.ts.", "./b.ts"]);
  });

  it("reads a package name in lower case and only without a sentence's punctuation", () => {
    expect(candidates("Use @IRACEDECK/Deck-Core. Or @iracedeck/iracing-sdk/dist/x.js, then.")).toEqual([
      "@iracedeck/deck-core",
      "@iracedeck/iracing-sdk/dist/x.js",
    ]);
    // A scope with no name after it names no package.
    expect(candidates("every @iracedeck/* package")).toEqual([]);
  });

  it("keeps two of a specifier as two, and one read in several views as one", () => {
    expect(candidates('"@iracedeck/x" and "@iracedeck/x"')).toEqual(["@iracedeck/x", "@iracedeck/x"]);
    expect(candidates('<script src="&#46;&#46;/b.ts"></script> "../b.ts"')).toEqual([
      "/b.ts",
      "/script",
      "../b.ts",
      "../b.ts",
    ]);
  });

  it("reports each load a literal cannot say, by line, and none it reads", () => {
    const text = [
      'import(`./x/${name}`); import(name); import("./ok.ts"); import ( /* c */ "./ok2.ts", { with: {} });',
      'require(a + b); require("./ok3.ts"); const r = require;',
      'requ\\u0069re(name); import { createRequire } from "node:module";',
      'import.meta.glob("./x/*.ts"); import.meta.env.X; import x from "./y.ts"; obj.import(name); required(x);',
    ].join("\n");

    expect(componentLoads(text).unread).toEqual([
      IMPORT(1),
      IMPORT(1),
      REQUIRE(2),
      REQUIRE(2),
      "a createRequire on line 3, whose require functions this check cannot follow under the names they get: load " +
        "the module with import and a string literal",
      REQUIRE(3),
      "an import.meta.glob on line 4 that is not a glob of data files, which this check does not expand: import " +
        "each module by a string literal",
    ]);
  });

  it("keeps the file's lines in a decoded view, so a reference or escape that is a line break moves no line", () => {
    expect(componentLoads('<p title="a&#10;b&NewLine;c">x\\ny</p>\nimport(name)').unread).toEqual([IMPORT(2)]);
  });

  // qa's sp, spx and st plants: a string reads `\` and a line break as nothing.
  it("joins a line continuation, and keeps the line of everything after it", () => {
    const text = 'import a from "@\\\niracedeck/x";\nconst b = `.\\\r\n./b.ts`;\nimport(name);';

    expect(candidates(text)).toEqual(expect.arrayContaining(["@iracedeck/x", "../b.ts"]));
    expect(componentLoads(text).unread).toEqual([IMPORT(5)]);
  });

  it("reads a template literal across lines, and a package in one only up to whitespace", () => {
    expect(candidates("const a = `../a.ts\nb`;")).toContain("../a.ts\nb");
    expect(candidates("const a = `@iracedeck/x\nmore`;")).toEqual(["@iracedeck/x"]);
  });

  // qa's ab and fs plants: a path that names one machine's disk loads whatever is there.
  it("reports a machine-specific path by line, and no URL, time or word with a colon", () => {
    const text = [
      'import a from "C:/repo/a.ts";',
      "<script src=C:\\repo\\b.ts></script>",
      'import c from "/@fs/C:/repo/c.ts";',
      'import d from "file:///C:/repo/d.ts";',
      'import e from "file:/repo/e.ts";',
      "https://example.com/x at 16:9, the file: name, ABC:/x and a: b",
    ].join("\n");
    const machine = (line) =>
      `a machine-specific path on line ${line} this check cannot follow; use a relative path inside the repository`;

    expect(componentLoads(text).unread).toEqual([machine(1), machine(2), machine(3), machine(4), machine(5)]);
  });

  // qa's gb plant: getBuiltinModule("module") hands over createRequire under any name.
  it("reports any getBuiltinModule, called or not", () => {
    const gb = (line) =>
      `a getBuiltinModule on line ${line}, which loads a module this check cannot follow: load it with import and a ` +
      "string literal";

    expect(componentLoads('process.getBuiltinModule("module");\nconst { getBuiltinModule } = process;').unread).toEqual(
      [
        gb(1),
        gb(2),
      ],
    );
  });

  it("hands each import.meta.glob call to isDataGlob, parsed from where it starts", () => {
    const seen = [];
    const isDataGlob = (call) => {
      seen.push(call.arguments.map((argument) => argument.getText()));

      return call.arguments[0].text.endsWith(".svg");
    };
    const text = [
      'const a = import.meta.glob<string>("../a/*.svg", { eager: true });',
      'const b = import . meta . glob("../b/*.ts");',
      "const c = import.meta.glob;",
    ].join("\n");
    const { unread } = componentLoads(text, { isDataGlob });

    expect(seen).toEqual([['"../a/*.svg"', "{ eager: true }"], ['"../b/*.ts"']]);
    expect(unread).toEqual([
      expect.stringMatching(/^an import\.meta\.glob on line 2 /),
      expect.stringMatching(/^an import\.meta\.glob on line 3 /),
    ]);
  });
});

describe("trackedPackageSources", () => {
  const files = trackedPackageSources(ROOT);

  it("lists the .astro components and .mdx pages only when asked, and never a plain .md", () => {
    const withComponents = trackedPackageSources(ROOT, { components: true });
    const components = withComponents.filter((file) => COMPONENT.test(file));

    expect(files.some((file) => COMPONENT.test(file))).toBe(false);
    expect(components).toContain("packages/website/src/components/IconGallery.astro");
    expect(components).toContain("packages/website/src/content/docs/docs/development/icon-gallery.mdx");
    expect(withComponents.filter((file) => !COMPONENT.test(file))).toEqual(files);
    expect(withComponents.some((file) => file.endsWith(".md"))).toBe(false);
  });

  it("lists the packages' sources and leaves out build output, plugin bundles and vendored files", () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain("packages/deck-core/src/index.ts");
    expect(files).toContain("packages/plugin-build/src/plugin-rollup.mjs");
    expect(files.some((file) => /(^|\/)(dist|node_modules)\/|\.sdPlugin\/|\.ulanziPlugin\//.test(file))).toBe(false);
    for (const vendored of Object.keys(VENDORED_SOURCES)) expect(files).not.toContain(vendored);
  });

  it("names only vendored files git still tracks", () => {
    for (const vendored of Object.keys(VENDORED_SOURCES)) {
      expect(trackedFiles(ROOT, vendored), vendored).toEqual([vendored]);
    }
  });
});

/** Every variable that makes git act on a repository, work tree or index other than the one its cwd holds. */
const GIT_SELECTORS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
]);

/** `parent` without the variables a git hook sets, so a fixture repository is the one git finds from its cwd. */
function isolatedGitEnv(parent) {
  return Object.fromEntries(Object.entries(parent).filter(([name]) => !GIT_SELECTORS.has(name.toUpperCase())));
}

/**
 * Runs `use(repo, env, page)` against a fresh git repository holding `page`
 * and a sibling, created with `env`, the isolated copy of `parent`.
 */
function withFixtureRepo(parent, use) {
  const repo = mkdtempSync(path.join(tmpdir(), "source-imports-"));
  const env = isolatedGitEnv(parent);

  try {
    const page = "packages/website/src/pages/café.astro";

    mkdirSync(path.join(repo, path.dirname(page)), { recursive: true });
    writeFileSync(path.join(repo, page), "---\n---\n");
    writeFileSync(path.join(repo, "packages/website/src/pages/naïve.ts"), "export {};\n");
    execFileSync("git", ["init", "-q"], { cwd: repo, env });
    // git's default, set here so a machine that turns it off still runs the control.
    execFileSync("git", ["config", "core.quotepath", "true"], { cwd: repo, env });
    execFileSync("git", ["add", "packages"], { cwd: repo, env });

    return use(repo, env, page);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe("nulSeparatedPaths (#1662)", () => {
  it("keeps a non-ASCII name, a space, a quote and a line break in a path as themselves", () => {
    const paths = [
      "packages/website/src/pages/café.astro",
      "packages/a b/x.ts",
      'packages/q"uote/x.mts',
      "packages/line\nbreak/x.js",
    ];

    expect(nulSeparatedPaths(`${paths.join("\0")}\0`)).toEqual(paths);
    expect(nulSeparatedPaths("")).toEqual([]);
  });

  // A plain `git ls-files` quotes this name, octal-escaped, and the extension filter dropped it.
  it("lists a tracked source whose name is not ASCII, in a repository of its own", () => {
    withFixtureRepo(process.env, (repo, env, page) => {
      expect(trackedPackageSources(repo, { components: true, env })).toEqual([
        page,
        "packages/website/src/pages/naïve.ts",
      ]);
    });
  });

  // Under a git hook GIT_DIR, GIT_INDEX_FILE and the like name the real checkout: the fixture must not act on it.
  it("builds its fixture repository apart from a GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE the process carries", () => {
    const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf-8" });
    const state = () => [git("config", "--list", "--local"), git("diff", "--cached", "--stat")];
    const before = state();
    const bogus = path.join(tmpdir(), `source-imports-bogus-${process.pid}`);

    try {
      withFixtureRepo(
        { ...process.env, GIT_DIR: bogus, GIT_WORK_TREE: bogus, GIT_INDEX_FILE: path.join(bogus, "index") },
        (repo, env, page) => {
          expect(env.GIT_DIR).toBeUndefined();
          expect(trackedPackageSources(repo, { components: true, env })).toContain(page);
        },
      );

      // git init under the inherited GIT_DIR would have made this folder, and the real index would have changed.
      expect(existsSync(bogus)).toBe(false);
      expect(state()).toEqual(before);
    } finally {
      rmSync(bogus, { recursive: true, force: true });
    }
  });

  it("lists a tracked file as git stores it, the same set a plain listing gives for ASCII names", () => {
    const files = trackedFiles(ROOT, "changelog.d");

    expect(files).toContain("changelog.d/README.md");
    expect(files.every((file) => file.startsWith("changelog.d/") && !file.startsWith('"'))).toBe(true);
  });
});
