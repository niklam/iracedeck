import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { allPluginManifestRelPaths } from "./lib/version-discovery.mjs";

// A plugin's plugin.ts is a shell since #1349: build the adapter, build the
// host extension if the host has one, call startPlugin. Anything more is the
// duplicated composition root coming back.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_LINES = 80;
const FORBIDDEN_NAMES = ["registerPitCrew", "initializeSimEventsIracing", "initializeAudioScenarios"];
const STREAM_DECK = "iracing-plugin-stream-deck";

/** Every way `source` breaks the shell contract, worded for a failure message; empty when it holds. A mention counts: a shell has no reason to name these. */
function shellViolations(source) {
  const violations = [];
  const lines = source.split(/\r?\n/);
  const lineCount = lines.at(-1) === "" ? lines.length - 1 : lines.length;

  if (lineCount > MAX_LINES) violations.push(`${lineCount} lines (the cap is ${MAX_LINES})`);
  for (const name of FORBIDDEN_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(source)) violations.push(`names ${name}`);
  }
  if (/\b[A-Z][A-Z0-9_]*_(CALLOUT_SETTING_KEYS|CALLOUTS)\b/.test(source)) {
    violations.push("names a callout key map or registry family");
  }
  // Any import of the registry, whatever it imports: a shell has no use for callout settings.
  if (/["'`]@iracedeck\/callout-settings(?:\/[^"'`]*)?["'`]/.test(source)) {
    violations.push("imports @iracedeck/callout-settings");
  }
  if (/\bregisterAction\s*\(/.test(source)) violations.push("calls registerAction");
  if (startPluginCall(source) === undefined) violations.push("never calls startPlugin");

  return violations;
}

/**
 * `source` with its `//` and block comments removed and string and template
 * literals kept whole, so a comment can neither satisfy nor trip a check that
 * reads code.
 */
function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      out += " ";
      i = end === -1 ? source.length : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }

  return out;
}

/** The text of the first `startPlugin(…)` call in `source`'s code (comments stripped), through its closing parenthesis; undefined when there is none. */
function startPluginCall(source) {
  const code = stripComments(source);
  const start = code.search(/\bstartPlugin\s*\(/);
  if (start === -1) return undefined;

  let depth = 0;
  for (let i = code.indexOf("(", start); i < code.length; i += 1) {
    if (code[i] === "(") depth += 1;
    if (code[i] === ")" && --depth === 0) return code.slice(start, i + 1);
  }

  return code.slice(start);
}

/**
 * How `source` breaks its host's extension rule; empty when it holds. Read from
 * the `startPlugin(…)` call itself, comments stripped. Stream Deck must hand
 * startPlugin its extension — without it the Switch Profile keys are never
 * registered and every other test stays green — and no other host's call may
 * carry an `extension` property, written out or shorthand.
 */
function extensionViolations(pkg, source) {
  const call = startPluginCall(source) ?? "";
  if (pkg === STREAM_DECK) {
    return /[{,]\s*extension\s*:\s*createElgatoExtension\s*\(/.test(call)
      ? []
      : ["the Stream Deck shell does not pass extension: createElgatoExtension(…) to startPlugin"];
  }

  return /[{,]\s*extension\s*[:,}]/.test(call) ? ["only the Stream Deck host has an extension"] : [];
}

const PLUGIN_PACKAGES = [...new Set(allPluginManifestRelPaths(repoRoot).map((relPath) => relPath.split("/")[1]))];

describe("the shell check itself (positive controls)", () => {
  const ok = 'import { startPlugin } from "@iracedeck/plugin-runtime";\nstartPlugin({ adapter, binDir });\n';

  it("passes a minimal shell", () => {
    expect(shellViolations(ok)).toEqual([]);
  });

  it.each([
    ["an import of registerPitCrew", `import { registerPitCrew } from "x";\n${ok}`, "names registerPitCrew"],
    ["the translator constructed here", `initializeSimEventsIracing(bus);\n${ok}`, "names initializeSimEventsIracing"],
    ["the scenario engine constructed here", `initializeAudioScenarios(bus);\n${ok}`, "names initializeAudioScenarios"],
    ["a callout key map", `const k = FLAG_CALLOUT_SETTING_KEYS;\n${ok}`, "names a callout key map or registry family"],
    ["a registry family", `const f = FLAG_CALLOUTS;\n${ok}`, "names a callout key map or registry family"],
    [
      "an import of the callout registry",
      `import { CALLOUT_SETTING_KEYS } from "@iracedeck/callout-settings";\n${ok}`,
      "imports @iracedeck/callout-settings",
    ],
    [
      "a type-only registry import",
      `import type { CalloutSettingKey } from '@iracedeck/callout-settings';\n${ok}`,
      "imports @iracedeck/callout-settings",
    ],
    [
      "a dynamic registry import",
      `await import("@iracedeck/callout-settings");\n${ok}`,
      "imports @iracedeck/callout-settings",
    ],
    ["a registration", `adapter.registerAction("x", h);\n${ok}`, "calls registerAction"],
    ["no startPlugin", "const adapter = new X();\n", "never calls startPlugin"],
    ["82 lines", `${"//\n".repeat(80)}${ok}`, "82 lines (the cap is 80)"],
  ])("fails %s", (_label, source, violation) => {
    expect(shellViolations(source)).toContain(violation);
  });

  it("does not count a startPlugin call that only a comment makes", () => {
    expect(shellViolations("// startPlugin({ adapter, binDir });\n/* startPlugin(x) */\n")).toContain(
      "never calls startPlugin",
    );
  });

  it("passes exactly 80 lines", () => {
    expect(shellViolations(`${"//\n".repeat(78)}${ok}`)).toEqual([]);
  });

  it("passes a Stream Deck shell that hands over its extension, and another host's that hands over none", () => {
    expect(
      extensionViolations(
        STREAM_DECK,
        "startPlugin({ adapter, binDir, extension: createElgatoExtension(sd, adapter) });",
      ),
    ).toEqual([]);
    expect(extensionViolations("iracing-plugin-mirabox", ok)).toEqual([]);
  });

  it("ignores the word extension in another host's comments, strings and other code", () => {
    const mentions = [
      "// Mirabox has no extension: createElgatoExtension(sd, adapter) is Stream Deck's.",
      "/* extension: none */",
      'const note = "extension: none";',
      "const extension = undefined;",
      ok,
    ].join("\n");

    expect(extensionViolations("iracing-plugin-mirabox", mentions)).toEqual([]);
  });

  it.each([
    [STREAM_DECK, "no extension", ok],
    [STREAM_DECK, "the extension built but not passed", `createElgatoExtension(sd, adapter);\n${ok}`],
    [STREAM_DECK, "the property only in a comment", `// extension: createElgatoExtension(sd, adapter)\n${ok}`],
    [
      STREAM_DECK,
      "the property outside the startPlugin call",
      `const o = { extension: createElgatoExtension(sd, adapter) };\n${ok}`,
    ],
    ["iracing-plugin-mirabox", "an extension", "startPlugin({ adapter, binDir, extension: makeOne() });"],
    ["iracing-plugin-ulanzi", "an empty extension", "startPlugin({ adapter, binDir, extension: undefined });"],
    ["iracing-plugin-ulanzi", "a shorthand extension", "startPlugin({ adapter, extension, binDir });"],
  ])("fails %s with %s", (pkg, _label, source) => {
    expect(extensionViolations(pkg, source)).toHaveLength(1);
  });
});

describe("every plugin.ts is a shell (#1349)", () => {
  it("finds the three plugins", () => {
    expect(PLUGIN_PACKAGES).toEqual(
      expect.arrayContaining([STREAM_DECK, "iracing-plugin-mirabox", "iracing-plugin-ulanzi"]),
    );
  });

  it.each(PLUGIN_PACKAGES)("%s", (pkg) => {
    const source = readFileSync(join(repoRoot, "packages", pkg, "src", "plugin.ts"), "utf-8");

    expect(shellViolations(source)).toEqual([]);
    expect(extensionViolations(pkg, source)).toEqual([]);
  });
});
