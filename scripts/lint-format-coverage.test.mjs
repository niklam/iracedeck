import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/lint-format-coverage.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
const eslintConfig = (await import(pathToFileURL(join(repoRoot, "eslint.config.js")).href)).default;

// The check and fix variants of a gate, and the pre-commit task, drifted apart
// once already: `lint:fix` dropped `scripts/**/*.mjs`, and nothing formatted
// `.mjs` at all, so 71 files went unformatted with every gate green (#1325).

/** A script's arguments after its command, with `flag` removed. */
function args(script, command, flag) {
  const words = script.match(/"[^"]*"|\S+/g).map((word) => word.replace(/^"|"$/g, ""));

  expect(words[0], script).toBe(command);

  return words.slice(1).filter((word) => word !== flag);
}

/** The extensions a list of `**\/*.ext` globs matches. Any other shape throws, so it is looked at. */
function globExtensions(globs) {
  return globs.map((glob) => {
    const match = /^\*\*\/\*\.(\w+)$/.exec(glob);

    if (!match) throw new Error(`unexpected glob shape: ${glob}`);

    return match[1];
  });
}

/** The extensions a lint-staged key (`*.ts`, `*.{ts,mjs}`) matches. */
function stagedExtensions(key) {
  const match = /^\*\.(?:(\w+)|\{(\w+(?:,\w+)*)\})$/.exec(key);

  if (!match) throw new Error(`unexpected lint-staged key: ${key}`);

  return match[1] ? [match[1]] : match[2].split(",");
}

/** The extensions lint-staged hands to a task starting with `command`. */
function stagedExtensionsFor(command) {
  return Object.entries(pkg["lint-staged"])
    .filter(([, tasks]) => tasks.some((task) => task.startsWith(command)))
    .flatMap(([key]) => stagedExtensions(key));
}

// The extensions eslint.config.js has a `files` block for: `**/*.ts` and `**/*.mjs`.
const lintedExtensions = [
  ...new Set(eslintConfig.flatMap((block) => block.files ?? []).filter((glob) => /^\*\*\/\*\.\w+$/.test(glob))),
].map((glob) => glob.slice("**/*.".length));

const formattedExtensions = globExtensions(args(pkg.scripts.format, "prettier", "--check"));

const sorted = (list) => [...new Set(list)].sort();

describe("lint and format coverage", () => {
  // An empty list would pass every comparison below vacuously.
  it("reads the extensions ESLint lints", () => {
    expect(sorted(lintedExtensions)).toEqual(["mjs", "ts"]);
  });

  it("lint:fix covers exactly the files lint does", () => {
    expect(args(pkg.scripts["lint:fix"], "eslint", "--fix")).toEqual(args(pkg.scripts.lint, "eslint"));
  });

  it("format:fix covers exactly the files format does", () => {
    expect(args(pkg.scripts["format:fix"], "prettier", "--write")).toEqual(
      args(pkg.scripts.format, "prettier", "--check"),
    );
  });

  it("format covers every extension ESLint lints", () => {
    expect(lintedExtensions.filter((ext) => !formattedExtensions.includes(ext))).toEqual([]);
  });

  it("lint-staged formats exactly what format checks", () => {
    expect(sorted(stagedExtensionsFor("prettier --write"))).toEqual(sorted(formattedExtensions));
  });

  it("lint-staged lints every extension ESLint lints", () => {
    expect(sorted(stagedExtensionsFor("eslint --fix"))).toEqual(sorted(lintedExtensions));
  });
});
