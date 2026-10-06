// @ts-check
/**
 * The shape every deck plugin's `rollup.config.mjs` keeps since #1349, read the
 * same way by the five guards that rest on it: `rollup-logs.test.mjs`,
 * `runtime-deps-guard.test.mjs`, `third-party-licenses.test.mjs`,
 * `dev-voice-root-guard.test.mjs` and pi-components' `settings-window-icon.test.ts`.
 *
 * Each guard checks a property the shared factory (`@iracedeck/plugin-build`)
 * owns, so each needs the same three facts about every plugin before its own
 * check means anything: the config imports the factory, its default export is
 * the factory's call, and the package declares `@iracedeck/plugin-build` (which
 * orders its build after the factory's and re-hashes it when the factory
 * changes). Two guards also need the config's literal `extraExternals`, parsed
 * strictly. Both live here once, so the five cannot drift apart.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { allPluginManifestRelPaths } from "./version-discovery.mjs";

/** The build-only package whose factory every plugin config calls. */
export const PLUGIN_BUILD_PACKAGE = "@iracedeck/plugin-build";

/** The import line every plugin config carries, verbatim. */
export const FACTORY_IMPORT = 'import { createPluginRollupConfig } from "@iracedeck/plugin-build";';

/** The opening of the one statement a plugin config's default export is, verbatim. */
export const FACTORY_CALL = "export default createPluginRollupConfig({";

/**
 * Every deck plugin, discovered from the committed plugin manifests (the same
 * source the release bump uses), so a fourth deck ecosystem is covered the day
 * its package appears — and a package that merely has a `rollup.config.mjs` is
 * never mistaken for a plugin.
 *
 * @param {string} root absolute repository root
 * @returns {{ pkg: string, folder: string }[]} the package directory under `packages/` and its plugin folder
 */
export function discoverPlugins(root) {
  return allPluginManifestRelPaths(root).map((relPath) => {
    const [, pkg, folder] = relPath.split("/");
    return { pkg, folder };
  });
}

/**
 * A plugin package's `rollup.config.mjs` source and parsed `package.json`.
 *
 * @param {string} root absolute repository root
 * @param {string} pkg the package directory under `packages/`
 * @returns {{ configSource: string, packageJson: Record<string, any> }}
 */
export function readPluginPackage(root, pkg) {
  const dir = join(root, "packages", pkg);
  return {
    configSource: readFileSync(join(dir, "rollup.config.mjs"), "utf-8"),
    packageJson: JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")),
  };
}

/**
 * What keeps a plugin config from building through the shared factory: one
 * message per missing fact, so `expect(problems).toEqual([])` names each.
 *
 * The module's shape is read, not searched for. Once comments are stripped, the
 * whole file must be zero or more `import … from "…";` statements, one of them
 * the factory's import, followed by exactly one
 * `export default createPluginRollupConfig({ … });` as its last statement. A
 * substring search let a commented-out call stand in for the export, so a
 * wrapper such as `export default { ...config, plugins: [] }` passed while it
 * dropped the factory's steps.
 *
 * @param {string} configSource the plugin's `rollup.config.mjs`
 * @param {{ devDependencies?: Record<string, string> }} packageJson the plugin's parsed `package.json`
 * @returns {string[]}
 */
export function pluginConfigShapeProblems(configSource, packageJson) {
  const problems = moduleShapeProblems(configSource);
  if (packageJson.devDependencies?.[PLUGIN_BUILD_PACKAGE] !== "workspace:*") {
    problems.push(`package.json does not declare "${PLUGIN_BUILD_PACKAGE}": "workspace:*" in devDependencies`);
  }
  return problems;
}

/** One `import … from "…";` statement, read at a known offset. */
const IMPORT_STATEMENT = /import\b[^;"'`]*?\bfrom\s*"[^"\n]*"\s*;/y;

/** The factory's import, whatever its spacing. */
const FACTORY_IMPORT_STATEMENT =
  /^import\s*\{\s*createPluginRollupConfig\s*\}\s*from\s*"@iracedeck\/plugin-build"\s*;$/;

/** The default export up to the call's `(`, whatever its spacing. */
const FACTORY_EXPORT = /export\s+default\s+createPluginRollupConfig\s*\(/y;

/**
 * The import and default-export problems of a plugin config's module shape.
 *
 * @param {string} configSource
 * @returns {string[]}
 */
function moduleShapeProblems(configSource) {
  let text;
  try {
    text = stripComments(configSource);
  } catch (error) {
    return [`rollup.config.mjs cannot be read: ${/** @type {Error} */ (error).message}`];
  }

  const problems = [];
  let importsFactory = false;
  let malformedImport = false;
  let i = skipWhitespace(text, 0);
  while (/^import\b/.test(text.slice(i))) {
    IMPORT_STATEMENT.lastIndex = i;
    const match = IMPORT_STATEMENT.exec(text);
    if (!match) {
      problems.push(`rollup.config.mjs has an import that is not \`import … from "…";\`: ${at(text, i)}`);
      malformedImport = true;
      break;
    }
    if (FACTORY_IMPORT_STATEMENT.test(match[0])) importsFactory = true;
    i = skipWhitespace(text, IMPORT_STATEMENT.lastIndex);
  }
  if (!importsFactory) problems.push(`rollup.config.mjs does not import the factory: ${FACTORY_IMPORT}`);
  if (malformedImport) return problems;

  FACTORY_EXPORT.lastIndex = i;
  if (!FACTORY_EXPORT.exec(text)) {
    problems.push(
      `rollup.config.mjs does not default-export the factory's config (\`${FACTORY_CALL} … });\` right after the imports), found ${at(text, i)}`,
    );
    return problems;
  }

  const objectStart = skipWhitespace(text, FACTORY_EXPORT.lastIndex);
  if (text[objectStart] !== "{") {
    problems.push(
      `rollup.config.mjs passes the factory something other than an object literal: ${at(text, objectStart)}`,
    );
    return problems;
  }
  const objectEnd = matchingBracket(text, objectStart);
  if (objectEnd === -1) {
    problems.push(`rollup.config.mjs never closes the factory's object literal opened at ${at(text, objectStart)}`);
    return problems;
  }

  const callEnd = skipWhitespace(text, objectEnd + 1);
  if (text[callEnd] !== ")") {
    problems.push(`rollup.config.mjs passes the factory more than its one object literal: ${at(text, callEnd)}`);
    return problems;
  }
  const semicolon = skipWhitespace(text, callEnd + 1);
  if (text[semicolon] !== ";") {
    problems.push(`rollup.config.mjs does not end the factory call with \`});\`, found ${at(text, semicolon)}`);
    return problems;
  }
  const rest = skipWhitespace(text, semicolon + 1);
  if (rest < text.length) {
    problems.push(
      `rollup.config.mjs has code after the factory call, which must be its last statement: ${at(text, rest)}`,
    );
  }
  return problems;
}

/**
 * The literal `extraExternals: [...]` a plugin config passes the factory, or `[]`
 * when it passes none. Anything but one list of double-quoted string literals,
 * standing alone as the key's value, throws: an identifier, a spread, a computed
 * entry or an expression built on the literal (`["ws"].concat(...)`,
 * `["ws"] || []`) would hide externals from every guard that reads this list.
 * So do a second `extraExternals` and any spread in the config, either of which
 * could replace the list read here.
 *
 * @param {string} configSource the plugin's `rollup.config.mjs`
 * @returns {string[]}
 */
export function parseExtraExternals(configSource) {
  const text = stripComments(configSource);
  const code = blankStrings(text);
  const mentions = code.match(/\bextraExternals\b/g) ?? [];
  if (mentions.length === 0) return [];
  if (mentions.length > 1) throw new Error(`extraExternals must be given once, found ${mentions.length} mentions`);

  const match = /\bextraExternals\s*:\s*\[([^\]]*)\]/.exec(text);
  if (!match) throw new Error("extraExternals must be a literal array");
  const entries = match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    if (!/^"[^"]+"$/.test(entry)) throw new Error(`extraExternals entries must be string literals, got ${entry}`);
  }

  const next = skipWhitespace(text, match.index + match[0].length);
  if (text[next] !== "," && text[next] !== "}") {
    throw new Error(
      `extraExternals must be the literal array alone, followed by "," or "}", found ${at(text, next)} after its "]"`,
    );
  }
  const spread = code.indexOf("...");
  if (spread !== -1) {
    throw new Error(`rollup.config.mjs spreads a value, which could carry another extraExternals: ${at(text, spread)}`);
  }
  return entries.map((entry) => entry.slice(1, -1));
}

/**
 * The source with every line and block comment blanked to spaces (line breaks
 * kept, so line numbers still match the file) and every string literal left
 * whole: a `//` or `/*` inside a string is text, not a comment.
 *
 * It reads the plain JavaScript a plugin config is written in, and throws rather
 * than guess at what it does not read: an unterminated string or comment, a
 * template literal with an interpolation, and a `/` outside a string or comment
 * (a regular expression or a division), where a quote or `//` inside a regular
 * expression would otherwise be misread.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipString(source, i);
      out += source.slice(i, end);
      i = end;
    } else if (ch === "/" && source[i + 1] === "/") {
      const newline = source.indexOf("\n", i);
      const end = newline === -1 ? source.length : newline;
      out += " ".repeat(end - i);
      i = end;
    } else if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close === -1) throw new Error(`unterminated block comment at ${lineOf(source, i)}`);
      out += source.slice(i, close + 2).replace(/[^\n]/g, " ");
      i = close + 2;
    } else if (ch === "/") {
      throw new Error(
        `a "/" outside a string or comment at ${lineOf(source, i)} (a regular expression or a division), which this reader does not parse`,
      );
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * The offset just past the string literal whose opening quote is at `start`.
 *
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function skipString(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote === "`" && ch === "$" && text[i + 1] === "{") {
      throw new Error(
        `a template literal with an interpolation at ${lineOf(text, start)}, which this reader does not parse`,
      );
    }
    if (quote !== "`" && ch === "\n") break;
    i++;
  }
  throw new Error(`unterminated string at ${lineOf(text, start)}`);
}

/**
 * The text with every string literal's contents blanked to spaces, so a search
 * finds only code. Expects text `stripComments` has already read.
 *
 * @param {string} text
 * @returns {string}
 */
function blankStrings(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipString(text, i);
      out += ch + " ".repeat(end - i - 2) + ch;
      i = end;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * The offset of the bracket closing the one at `open`, skipping string contents;
 * `-1` when it is never closed or a bracket of another kind closes first.
 *
 * @param {string} text comment-free source
 * @param {number} open the offset of a `(`, `[` or `{`
 * @returns {number}
 */
function matchingBracket(text, open) {
  /** @type {Record<string, string>} */
  const closers = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(text, i);
      continue;
    }
    if (closers[ch]) stack.push(closers[ch]);
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * The first offset at or after `i` that is not whitespace.
 *
 * @param {string} text
 * @param {number} i
 * @returns {number}
 */
function skipWhitespace(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/**
 * `line N` for an offset.
 *
 * @param {string} text
 * @param {number} i
 * @returns {string}
 */
function lineOf(text, i) {
  return `line ${text.slice(0, i).split("\n").length}`;
}

/**
 * What stands at an offset and where, for a problem message.
 *
 * @param {string} text
 * @param {number} i
 * @returns {string}
 */
function at(text, i) {
  if (i >= text.length) return "the end of the file";
  const snippet = text
    .slice(i, i + 48)
    .replace(/\s+/g, " ")
    .trim();
  return `\`${snippet}\` (${lineOf(text, i)})`;
}
