/**
 * The runtime `package.json` a plugin's bin folder installs from (#1177). These
 * run against a real temp workspace (like `dev-local.test.mjs`) because the
 * helper's whole job is reading what the workspace's `package.json` files
 * declare — a mocked `fs` would assert the code's own assumptions back at it.
 *
 * The throwing cases are the point of the file: a silent fallback is how the
 * shipped versions drifted from the tested ones in the first place.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readWorkspaceManifests,
  runtimePackageJson,
  runtimePackageJsonPlugin,
  workspaceDeclarations,
} from "./runtime-deps.mjs";

let root;
let binDir;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "iracedeck-runtime-deps-"));
  // Same depth as the real plugins: packages/<plugin>/<plugin folder>/bin.
  binDir = path.join(root, "packages", "plugin-x", "com.example.sdPlugin", "bin");
  writeManifest("package.json", { name: "root", private: true });
  writeManifest("packages/plugin-x/package.json", { name: "@iracedeck/plugin-x" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeManifest(rel, manifest) {
  const file = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(manifest, null, 2));
}

function build(external) {
  return runtimePackageJson({ root, binDir, external });
}

describe("runtimePackageJson — third-party externals", () => {
  it("ships each external at the one version the workspace declares", () => {
    writeManifest("packages/sdk/package.json", { name: "@iracedeck/sdk", dependencies: { yaml: "2.9.1" } });
    writeManifest("packages/raster/package.json", {
      name: "@iracedeck/raster",
      dependencies: { "@resvg/resvg-js": "2.6.2" },
    });

    expect(build(["yaml", "@resvg/resvg-js"])).toEqual({
      type: "module",
      dependencies: { "@resvg/resvg-js": "2.6.2", yaml: "2.9.1" },
    });
  });

  it("sorts the entries, so the emitted file does not depend on the order of `external`", () => {
    writeManifest("packages/a/package.json", { name: "@iracedeck/a", dependencies: { yaml: "2.9.1", ws: "8.21.3" } });

    expect(Object.keys(build(["yaml", "ws"]).dependencies)).toEqual(["ws", "yaml"]);
  });

  it("accepts the same version declared by several packages and in several sections", () => {
    writeManifest("packages/a/package.json", { name: "@iracedeck/a", dependencies: { ws: "8.21.3" } });
    writeManifest("packages/b/package.json", { name: "@iracedeck/b", devDependencies: { ws: "8.21.3" } });
    writeManifest("package.json", { name: "root", devDependencies: { ws: "8.21.3" } });

    expect(build(["ws"]).dependencies).toEqual({ ws: "8.21.3" });
  });

  it("ships an external under optionalDependencies when every declaration is optional", () => {
    writeManifest("packages/core/package.json", {
      name: "@iracedeck/core",
      optionalDependencies: { keysender: "2.4.0" },
    });

    expect(build(["keysender"])).toEqual({
      type: "module",
      dependencies: {},
      optionalDependencies: { keysender: "2.4.0" },
    });
  });

  it("ships it as a plain dependency once any declaration is not optional", () => {
    writeManifest("packages/core/package.json", {
      name: "@iracedeck/core",
      optionalDependencies: { keysender: "2.4.0" },
    });
    writeManifest("packages/other/package.json", { name: "@iracedeck/other", dependencies: { keysender: "2.4.0" } });

    const pkg = build(["keysender"]);
    expect(pkg.dependencies).toEqual({ keysender: "2.4.0" });
    expect(pkg).not.toHaveProperty("optionalDependencies");
  });

  it("throws, naming the package, when no workspace package.json declares an external", () => {
    expect(() => build(["keysender"])).toThrow(
      /"keysender" is a rollup external.*no workspace package\.json declares it/,
    );
  });

  it("does not count peerDependencies as a declaration — they name a range nobody here installs", () => {
    writeManifest("packages/a/package.json", { name: "@iracedeck/a", peerDependencies: { yaml: "2.9.1" } });

    expect(() => build(["yaml"])).toThrow(/no workspace package\.json declares it/);
  });

  it("throws, naming every file and version, when two packages disagree", () => {
    writeManifest("packages/core/package.json", { name: "@iracedeck/core", dependencies: { ws: "8.21.3" } });
    writeManifest("packages/adapter/package.json", { name: "@iracedeck/adapter", devDependencies: { ws: "8.18.2" } });

    expect(() => build(["ws"])).toThrow(
      /"ws" is declared at more than one version.*packages\/adapter\/package\.json \(devDependencies\): 8\.18\.2.*packages\/core\/package\.json \(dependencies\): 8\.21\.3/,
    );
  });

  it("treats the root package.json as a declaring package too", () => {
    writeManifest("package.json", { name: "root", devDependencies: { yaml: "2.8.2" } });
    writeManifest("packages/sdk/package.json", { name: "@iracedeck/sdk", dependencies: { yaml: "2.9.1" } });

    expect(() => build(["yaml"])).toThrow(/package\.json \(devDependencies\): 2\.8\.2/);
  });

  it.each(["^2.9.1", "~2.9.1", "2.x", "latest", "workspace:*"])(
    "throws on a declaration that is not an exact version: %s",
    (version) => {
      writeManifest("packages/sdk/package.json", { name: "@iracedeck/sdk", dependencies: { yaml: version } });

      expect(() => build(["yaml"])).toThrow(/not an exact version.*packages\/sdk\/package\.json/);
    },
  );

  it("accepts an exact pre-release version", () => {
    writeManifest("packages/sdk/package.json", { name: "@iracedeck/sdk", dependencies: { yaml: "3.0.0-2" } });

    expect(build(["yaml"]).dependencies).toEqual({ yaml: "3.0.0-2" });
  });
});

describe("runtimePackageJson — workspace externals", () => {
  it("links an @iracedeck external to its package directory, relative to the bin folder", () => {
    writeManifest("packages/audio-native/package.json", { name: "@iracedeck/audio-native" });
    writeManifest("packages/iracing-native/package.json", { name: "@iracedeck/iracing-native" });

    expect(build(["@iracedeck/iracing-native", "@iracedeck/audio-native"]).dependencies).toEqual({
      "@iracedeck/audio-native": "file:../../../audio-native",
      "@iracedeck/iracing-native": "file:../../../iracing-native",
    });
  });

  it("finds the package by its name, not its directory", () => {
    writeManifest("packages/native-dir/package.json", { name: "@iracedeck/iracing-native" });

    expect(build(["@iracedeck/iracing-native"]).dependencies).toEqual({
      "@iracedeck/iracing-native": "file:../../../native-dir",
    });
  });

  it("throws when no workspace package carries the name", () => {
    expect(() => build(["@iracedeck/missing-native"])).toThrow(
      /no packages\/\*\/package\.json is named "@iracedeck\/missing-native"/,
    );
  });
});

describe("runtimePackageJson — the `external` option", () => {
  it.each([
    ["a function", () => false],
    ["a regex entry", [/^node:/]],
    ["undefined", undefined],
  ])("throws when it is %s, since it cannot be turned into an install list", (_label, external) => {
    expect(() => build(external)).toThrow(/must be an array of package names/);
  });

  it("emits an empty dependency map for no externals", () => {
    expect(build([])).toEqual({ type: "module", dependencies: {} });
  });
});

describe("workspace discovery", () => {
  it("reads the root package.json and every packages/* directory that has one", () => {
    mkdirSync(path.join(root, "packages", "no-manifest"), { recursive: true });
    writeManifest("packages/a/package.json", { name: "@iracedeck/a" });

    expect(readWorkspaceManifests(root).map((m) => m.file)).toEqual([
      "package.json",
      "packages/a/package.json",
      "packages/plugin-x/package.json",
    ]);
  });

  it("names the file when a package.json cannot be parsed", () => {
    writeFileSync(path.join(root, "packages", "plugin-x", "package.json"), "{ not json");

    expect(() => readWorkspaceManifests(root)).toThrow(/cannot read .*plugin-x.*package\.json/);
  });

  it("lists each declaration with its file and section", () => {
    writeManifest("packages/a/package.json", {
      name: "@iracedeck/a",
      dependencies: { ws: "8.21.3" },
      devDependencies: { ws: "8.21.3" },
    });

    expect(workspaceDeclarations(readWorkspaceManifests(root), "ws")).toEqual([
      { file: "packages/a/package.json", section: "dependencies", version: "8.21.3" },
      { file: "packages/a/package.json", section: "devDependencies", version: "8.21.3" },
    ]);
  });
});

describe("runtimePackageJsonPlugin", () => {
  function context() {
    return {
      emitFile: vi.fn(),
      error: (message) => {
        throw new Error(message);
      },
    };
  }

  it("emits package.json for the externals it was configured with, linked from the output file's folder", () => {
    writeManifest("packages/audio-native/package.json", { name: "@iracedeck/audio-native" });
    writeManifest("packages/sdk/package.json", { name: "@iracedeck/sdk", dependencies: { yaml: "2.9.1" } });
    const plugin = runtimePackageJsonPlugin({ root });
    const ctx = context();

    expect(plugin.options({ external: ["@iracedeck/audio-native", "yaml"] })).toBeNull();
    plugin.generateBundle.call(ctx, { file: path.join(binDir, "plugin.js") });

    expect(ctx.emitFile).toHaveBeenCalledTimes(1);
    const [{ fileName, source, type }] = ctx.emitFile.mock.calls[0];
    expect(fileName).toBe("package.json");
    expect(type).toBe("asset");
    expect(JSON.parse(source)).toEqual({
      type: "module",
      dependencies: { "@iracedeck/audio-native": "file:../../../audio-native", yaml: "2.9.1" },
    });
  });

  it("watches every workspace manifest it reads, so rollup -w re-emits on a version change", () => {
    writeManifest("packages/sdk/package.json", { name: "@iracedeck/sdk", dependencies: { yaml: "2.9.1" } });
    mkdirSync(path.join(root, "packages", "no-manifest"), { recursive: true });
    const ctx = { addWatchFile: vi.fn() };

    runtimePackageJsonPlugin({ root }).buildStart.call(ctx);

    expect(
      ctx.addWatchFile.mock.calls.map(([file]) => path.relative(root, file).split(path.sep).join("/")).sort(),
    ).toEqual(["package.json", "packages/plugin-x/package.json", "packages/sdk/package.json"]);
  });

  it("keeps the name of the step it replaced", () => {
    expect(runtimePackageJsonPlugin({ root }).name).toBe("emit-module-package-file");
  });

  it("fails the build when an external is undeclared", () => {
    const plugin = runtimePackageJsonPlugin({ root });
    plugin.options({ external: ["keysender"] });

    expect(() => plugin.generateBundle.call(context(), { file: path.join(binDir, "plugin.js") })).toThrow(
      /"keysender" is a rollup external/,
    );
  });

  it("fails the build for a multi-file output, which has no single folder to place package.json in", () => {
    const plugin = runtimePackageJsonPlugin({ root });
    plugin.options({ external: [] });

    expect(() => plugin.generateBundle.call(context(), { dir: binDir })).toThrow(/single-file output/);
  });
});
