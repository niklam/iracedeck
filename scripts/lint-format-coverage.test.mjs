import { ESLint } from "eslint";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { describe, expect, it } from "vitest";

// scripts/lint-format-coverage.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));

// What the prettier CLI reads by default; the API reads nothing unless told.
const PRETTIER_IGNORE_FILES = [join(repoRoot, ".gitignore"), join(repoRoot, ".prettierignore")];

// The check and fix variants of a gate, and the pre-commit task, drifted apart
// once already: `lint:fix` dropped `scripts/**/*.mjs`, nothing formatted `.mjs`
// at all, and 71 files went unformatted with every gate green (#1325). So the
// coverage is compared per tracked file, by asking the tools themselves.

/** A script's arguments after its command, with `flag` removed. */
function args(script, command, flag) {
  const words = (script.match(/"[^"]*"|\S+/g) ?? []).map((word) => word.replace(/^"|"$/g, ""));

  expect(words[0], script).toBe(command);

  return words.slice(1).filter((word) => word !== flag);
}

/** The extensions a lint-staged key (`*.ts`, `*.{ts,mjs}`) matches. Any other shape throws, so it is looked at. */
function stagedExtensions(key) {
  const match = /^\*\.(?:(\w+)|\{(\w+(?:,\w+)*)\})$/.exec(key);

  if (!match) throw new Error(`unexpected lint-staged key: ${key}`);

  return match[1] ? [match[1]] : match[2].split(",");
}

/** The extensions lint-staged hands to a task starting with `command`; a value may be one task or a list. */
function stagedExtensionsFor(command) {
  return Object.entries(pkg["lint-staged"])
    .filter(([, tasks]) => [tasks].flat().some((task) => task.startsWith(command)))
    .flatMap(([key]) => stagedExtensions(key));
}

const extension = (file) => file.slice(file.lastIndexOf(".") + 1);
const sorted = (list) => [...new Set(list)].sort();

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf-8" })
  .split("\0")
  .filter(Boolean);

const lintGlobs = args(pkg.scripts.lint, "eslint");
const formatGlobs = args(pkg.scripts.format, "prettier", "--check");
const eslint = new ESLint({ cwd: repoRoot });

// The extensions this repo lints. ESLint would also take .js by default, but
// the tracked .js files are two root configs, a vendored bundle and two
// browser scripts, deliberately in neither gate (.claude/rules/code-style.md).
const LINTED_EXTENSIONS = ["mjs", "ts"];

// isPathIgnored() also answers true for a file no config block applies to, so
// `lintable` is every tracked file of those extensions ESLint would lint.
const lintable = [];

for (const file of tracked.filter((file) => LINTED_EXTENSIONS.includes(extension(file)))) {
  if (!(await eslint.isPathIgnored(join(repoRoot, file)))) lintable.push(file);
}

const linted = lintable.filter((file) => lintGlobs.some((glob) => matchesGlob(file, glob)));
const formatted = [];

for (const file of tracked.filter((file) => formatGlobs.some((glob) => matchesGlob(file, glob)))) {
  const info = await prettier.getFileInfo(join(repoRoot, file), { ignorePath: PRETTIER_IGNORE_FILES });

  if (!info.ignored) formatted.push(file);
}

describe("lint and format coverage", () => {
  // An empty discovery would pass every comparison below vacuously.
  it("finds tracked .ts and .mjs files that lint and format reach", () => {
    expect(sorted(linted.map(extension))).toEqual(LINTED_EXTENSIONS);
    expect(sorted(formatted.map(extension))).toEqual(expect.arrayContaining(["json", "mjs", "ts"]));
  });

  it("lint:fix covers exactly the files lint does", () => {
    expect(args(pkg.scripts["lint:fix"], "eslint", "--fix")).toEqual(lintGlobs);
  });

  it("format:fix covers exactly the files format does", () => {
    expect(args(pkg.scripts["format:fix"], "prettier", "--write")).toEqual(formatGlobs);
  });

  // lint-staged runs `eslint --fix` on every staged file of a linted
  // extension, so a lintable file `lint` skips is one CI never checks but a
  // commit touching it can still be refused for.
  it("lint reaches every tracked file ESLint can lint", () => {
    expect(lintable.filter((file) => !linted.includes(file))).toEqual([]);
  });

  it("format reaches every file lint does", () => {
    expect(linted.filter((file) => !formatted.includes(file))).toEqual([]);
  });

  it("lint-staged formats exactly the extensions format checks", () => {
    expect(sorted(stagedExtensionsFor("prettier --write"))).toEqual(sorted(formatted.map(extension)));
  });

  it("lint-staged lints exactly the extensions lint checks", () => {
    expect(sorted(stagedExtensionsFor("eslint --fix"))).toEqual(sorted(linted.map(extension)));
  });
});
