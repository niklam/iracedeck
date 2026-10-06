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
  if (/\b[A-Z][A-Z0-9_]*_CALLOUT_SETTING_KEYS\b/.test(source)) violations.push("names a *_CALLOUT_SETTING_KEYS map");
  if (/\bregisterAction\s*\(/.test(source)) violations.push("calls registerAction");
  if (!/\bstartPlugin\s*\(/.test(source)) violations.push("never calls startPlugin");

  return violations;
}

/**
 * How `source` breaks its host's extension rule; empty when it holds. Stream Deck
 * must hand startPlugin its extension — without it the Switch Profile keys are
 * never registered and every other test stays green — and no other host may
 * pass one.
 */
function extensionViolations(pkg, source) {
  if (pkg === STREAM_DECK) {
    return /\bextension:\s*createElgatoExtension\s*\(/.test(source)
      ? []
      : ["the Stream Deck shell does not pass extension: createElgatoExtension(…)"];
  }

  return /\bextension\b/.test(source) ? ["only the Stream Deck host has an extension"] : [];
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
    ["a callout key map", `const k = FLAG_CALLOUT_SETTING_KEYS;\n${ok}`, "names a *_CALLOUT_SETTING_KEYS map"],
    ["a registration", `adapter.registerAction("x", h);\n${ok}`, "calls registerAction"],
    ["no startPlugin", "const adapter = new X();\n", "never calls startPlugin"],
    ["82 lines", `${"//\n".repeat(80)}${ok}`, "82 lines (the cap is 80)"],
  ])("fails %s", (_label, source, violation) => {
    expect(shellViolations(source)).toContain(violation);
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

  it.each([
    [STREAM_DECK, "no extension", ok],
    [STREAM_DECK, "the extension built but not passed", `createElgatoExtension(sd, adapter);\n${ok}`],
    ["iracing-plugin-mirabox", "an extension", "startPlugin({ adapter, binDir, extension: makeOne() });"],
    ["iracing-plugin-ulanzi", "an empty extension", "startPlugin({ adapter, binDir, extension: undefined });"],
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
