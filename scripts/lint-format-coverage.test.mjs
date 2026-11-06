import { ESLint } from "eslint";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { describe, expect, it } from "vitest";

import { STAGED_TASKS } from "./format-staged.mjs";

// scripts/lint-format-coverage.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));

// What the prettier CLI reads by default; the API reads nothing unless told.
const PRETTIER_IGNORE_FILES = [join(repoRoot, ".gitignore"), join(repoRoot, ".prettierignore")];

// The check and fix variants of a gate, and the pre-commit step, drifted apart
// once already: `lint:fix` dropped `scripts/**/*.mjs`, nothing formatted `.mjs`
// at all, and 71 files went unformatted with every gate green (#1325). So the
// coverage is compared per tracked file, by asking the tools themselves.

/** A script's arguments after its command, with `flag` removed. */
function args(script, command, flag) {
  const words = (script.match(/"[^"]*"|\S+/g) ?? []).map((word) => word.replace(/^"|"$/g, ""));

  expect(words[0], script).toBe(command);

  return words.slice(1).filter((word) => word !== flag);
}

/**
 * The extensions the pre-commit step (`scripts/format-staged.mjs`) hands to
 * `tool`. Anything but a bare extension throws, so it is looked at.
 */
function stagedExtensionsFor(tool) {
  const extensions = STAGED_TASKS.filter((task) => task.tools.includes(tool)).flatMap((task) => task.extensions);

  for (const extension of extensions) {
    if (!/^\w+$/.test(extension)) throw new Error(`unexpected STAGED_TASKS extension: ${extension}`);
  }

  return extensions;
}

const extension = (file) => file.slice(file.lastIndexOf(".") + 1);
const sorted = (list) => [...new Set(list)].sort();

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf-8" })
  .split("\0")
  .filter(Boolean);

const lintGlobs = args(pkg.scripts.lint, "eslint");
const formatGlobs = args(pkg.scripts.format, "prettier", "--check");
const eslint = new ESLint({ cwd: repoRoot });

// The extensions this repo lints, sorted. ESLint would also take .js by
// default, but the tracked .js files are two root configs, a vendored bundle
// and two browser scripts, deliberately in neither gate
// (.claude/rules/code-style.md). The website's .astro components and its .mts
// generator were linted by nothing until #1616: ESLint skipped the .astro files
// a glob handed it, since no config block named them, and no glob reached the
// .mts.
const LINTED_EXTENSIONS = ["astro", "mjs", "mts", "ts"];

// isPathIgnored() also answers true for a file no config block applies to, so
// `lintable` is every tracked file of those extensions ESLint would lint.
const lintable = [];

for (const file of tracked.filter((file) => LINTED_EXTENSIONS.includes(extension(file)))) {
  if (!(await eslint.isPathIgnored(join(repoRoot, file)))) lintable.push(file);
}

/** The files of `files` that none of `globs` reaches. */
const unreached = (files, globs) => files.filter((file) => !globs.some((glob) => matchesGlob(file, glob)));

const linted = lintable.filter((file) => !unreached([file], lintGlobs).length);
const formatted = [];

for (const file of tracked.filter((file) => formatGlobs.some((glob) => matchesGlob(file, glob)))) {
  const info = await prettier.getFileInfo(join(repoRoot, file), { ignorePath: PRETTIER_IGNORE_FILES });

  if (!info.ignored) formatted.push(file);
}

describe("lint and format coverage", () => {
  // An empty discovery would pass every comparison below vacuously.
  it("finds tracked files of every linted extension that lint and format reach", () => {
    expect(sorted(linted.map(extension))).toEqual(LINTED_EXTENSIONS);
    expect(sorted(formatted.map(extension))).toEqual(expect.arrayContaining(["json", ...LINTED_EXTENSIONS]));
  });

  it("lint:fix covers exactly the files lint does", () => {
    expect(args(pkg.scripts["lint:fix"], "eslint", "--fix")).toEqual(lintGlobs);
  });

  it("format:fix covers exactly the files format does", () => {
    expect(args(pkg.scripts["format:fix"], "prettier", "--write")).toEqual(formatGlobs);
  });

  // The pre-commit step runs ESLint with fixes on every staged file of a
  // linted extension, so a lintable file `lint` skips is one CI never checks
  // but a commit touching it can still be refused for.
  it("lint reaches every tracked file ESLint can lint", () => {
    expect(unreached(lintable, lintGlobs)).toEqual([]);
  });

  // The positive control for the check above: with the globs that reach them
  // taken out, the website's .astro components and its .mts generator are
  // reported unreached, so the check sees them (#1616). With no config block
  // naming their extension they would not be `lintable` at all and could never
  // be reported.
  it("would report the .astro and .mts files a narrower lint missed", () => {
    const astro = lintable.filter((file) => extension(file) === "astro");
    const mts = lintable.filter((file) => extension(file) === "mts");

    expect(astro.length).toBeGreaterThan(0);
    expect(mts).toContain("packages/website/scripts/generate-icon-gallery.mts");
    expect(
      unreached(
        lintable,
        lintGlobs.filter((glob) => glob !== "**/*.mts"),
      ),
    ).toEqual(mts);
    // packages/*/src/** reaches the components as well, so both go.
    expect(
      unreached(
        lintable,
        lintGlobs.filter((glob) => !["**/*.astro", "packages/*/src/**"].includes(glob)),
      ),
    ).toEqual(expect.arrayContaining(astro));
  });

  // ESLint really reads them with the repo's TypeScript rules: a planted
  // unused variable is reported in an .astro frontmatter, an .astro <script>
  // (the virtual .ts the Astro processor extracts) and an .mts file. That
  // `lintable` holds a file says only that some block names it — the
  // sim-neutral block names every .astro file in the website, so without the
  // Astro parser block they would still count, and fail to parse in `pnpm
  // lint` — so this is what proves the files counted above are read with the
  // TypeScript rules.
  it.each([
    [
      "an .astro frontmatter",
      "packages/website/src/components/Planted.astro",
      "---\nconst unused: number = 1;\n---\n\n<p>planted</p>\n",
      2,
    ],
    [
      "an .astro <script>",
      "packages/website/src/components/Planted.astro",
      "<p>planted</p>\n\n<script>\n  const unused: number = 1;\n</script>\n",
      4,
    ],
    ["an .mts file", "packages/website/scripts/planted.mts", "const unused: number = 1;\n\nexport {};\n", 1],
  ])("reports a TypeScript rule in %s", async (_where, filePath, code, line) => {
    const [result] = await eslint.lintText(code, { filePath: join(repoRoot, filePath) });

    expect(result.messages.map((m) => [m.ruleId, m.line])).toEqual([["@typescript-eslint/no-unused-vars", line]]);
  });

  it("format reaches every file lint does", () => {
    expect(linted.filter((file) => !formatted.includes(file))).toEqual([]);
  });

  it("the pre-commit step formats exactly the extensions format checks", () => {
    expect(sorted(stagedExtensionsFor("prettier"))).toEqual(sorted(formatted.map(extension)));
  });

  it("the pre-commit step lints exactly the extensions lint checks", () => {
    expect(sorted(stagedExtensionsFor("eslint"))).toEqual(sorted(linted.map(extension)));
  });
});
