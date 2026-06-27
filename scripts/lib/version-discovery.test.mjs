import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  allPluginManifestRelPaths,
  discoverVersionedFiles,
  PLUGIN_FOLDER_SUFFIXES,
  pluginManifestRelPaths,
} from "./version-discovery.mjs";

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ird-version-discovery-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write `obj` as canonical JSON (the exact form release-hooks writes). */
function writeJson(rel, obj) {
  const filePath = join(root, rel);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n");
}

/** Write raw text (used for malformed-JSON fixtures). */
function writeRaw(rel, text) {
  const filePath = join(root, rel);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, text);
}

const packageCandidates = (pkgName) => [`packages/${pkgName}/package.json`];
const manifestCandidates = (pkgName) => pluginManifestRelPaths(root, pkgName);

/** A small but representative fixture tree. */
function buildStandardTree() {
  // Two real plugin packages, one .sdPlugin and one .ulanziPlugin.
  writeJson("packages/plugin-a/package.json", { name: "@x/plugin-a", version: "1.0.0" });
  writeJson("packages/plugin-a/com.x.a.sdPlugin/manifest.json", { Name: "A", Version: "1.0.0.0" });
  writeJson("packages/plugin-b/package.json", { name: "@x/plugin-b", version: "1.0.0" });
  writeJson("packages/plugin-b/com.x.b.ulanziPlugin/manifest.json", { Name: "B", Version: "1.0.0.0" });

  // A library package with a version but no plugin folder.
  writeJson("packages/lib-c/package.json", { name: "@x/lib-c", version: "1.0.0" });

  // A package without a version (e.g. a private tooling package): skipped leniently.
  writeJson("packages/no-version/package.json", { name: "@x/no-version", private: true });

  // A decoy: a NON-plugin manifest.json at depth 2 that declares a string
  // Version. The plugin-folder anchor must exclude it (issue #701 defect 3).
  writeJson("packages/decoy/package.json", { name: "@x/decoy", version: "1.0.0" });
  writeJson("packages/decoy/assets/manifest.json", { Version: "9.9.9", clips: [] });

  // A stray file at the packages/* level — must be ignored (not a directory).
  writeRaw("packages/not-a-dir.txt", "ignore me\n");
}

describe("PLUGIN_FOLDER_SUFFIXES", () => {
  it("covers the Elgato/Mirabox and Ulanzi plugin folders", () => {
    expect(PLUGIN_FOLDER_SUFFIXES).toEqual([".sdPlugin", ".ulanziPlugin"]);
  });
});

describe("pluginManifestRelPaths", () => {
  it("returns only plugin-folder manifests, forward-slashed", () => {
    buildStandardTree();
    expect(pluginManifestRelPaths(root, "plugin-a")).toEqual(["packages/plugin-a/com.x.a.sdPlugin/manifest.json"]);
    expect(pluginManifestRelPaths(root, "plugin-b")).toEqual(["packages/plugin-b/com.x.b.ulanziPlugin/manifest.json"]);
  });

  it("excludes non-plugin subfolders (the decoy anchor)", () => {
    buildStandardTree();
    expect(pluginManifestRelPaths(root, "decoy")).toEqual([]);
  });

  it("never emits backslashes (git needs forward slashes on Windows)", () => {
    buildStandardTree();
    for (const rel of pluginManifestRelPaths(root, "plugin-a")) {
      expect(rel).not.toContain("\\");
    }
  });
});

describe("discoverVersionedFiles — package.json", () => {
  it("discovers every package with a string version, sorted, skipping version-less ones", () => {
    buildStandardTree();
    const found = discoverVersionedFiles(root, { candidatesFor: packageCandidates, versionField: "version" });
    expect(found.map((f) => f.rel)).toEqual([
      "packages/decoy/package.json",
      "packages/lib-c/package.json",
      "packages/plugin-a/package.json",
      "packages/plugin-b/package.json",
    ]);
  });

  it("captures the parsed object on each result", () => {
    buildStandardTree();
    const found = discoverVersionedFiles(root, { candidatesFor: packageCandidates, versionField: "version" });
    const a = found.find((f) => f.rel === "packages/plugin-a/package.json");
    expect(a.data).toMatchObject({ name: "@x/plugin-a", version: "1.0.0" });
  });
});

describe("discoverVersionedFiles — manifests (anchored, required)", () => {
  it("discovers only the plugin manifests and excludes the decoy", () => {
    buildStandardTree();
    const found = discoverVersionedFiles(root, {
      candidatesFor: manifestCandidates,
      versionField: "Version",
      required: true,
    });
    expect(found.map((f) => f.rel)).toEqual([
      "packages/plugin-a/com.x.a.sdPlugin/manifest.json",
      "packages/plugin-b/com.x.b.ulanziPlugin/manifest.json",
    ]);
  });

  it("throws when a plugin folder's manifest is missing", () => {
    writeJson("packages/plugin-a/package.json", { name: "@x/plugin-a", version: "1.0.0" });
    mkdirSync(join(root, "packages/plugin-a/com.x.a.sdPlugin"), { recursive: true });
    expect(() =>
      discoverVersionedFiles(root, { candidatesFor: manifestCandidates, versionField: "Version", required: true }),
    ).toThrow(/missing/i);
  });

  it("throws when a plugin manifest lacks a string Version", () => {
    writeJson("packages/plugin-a/package.json", { name: "@x/plugin-a", version: "1.0.0" });
    writeJson("packages/plugin-a/com.x.a.sdPlugin/manifest.json", { Name: "A" });
    expect(() =>
      discoverVersionedFiles(root, { candidatesFor: manifestCandidates, versionField: "Version", required: true }),
    ).toThrow(/Version/);
  });

  it("aborts loudly on a malformed manifest instead of silently dropping it", () => {
    writeJson("packages/plugin-a/package.json", { name: "@x/plugin-a", version: "1.0.0" });
    writeRaw("packages/plugin-a/com.x.a.sdPlugin/manifest.json", "{ this is not json ");
    expect(() =>
      discoverVersionedFiles(root, { candidatesFor: manifestCandidates, versionField: "Version", required: true }),
    ).toThrow();
  });
});

describe("discoverVersionedFiles — SKIPPED_PACKAGES", () => {
  it("opts a package out of BOTH its package.json and its manifest", () => {
    buildStandardTree();
    const skip = new Set(["@x/plugin-a"]);

    const pkgs = discoverVersionedFiles(root, { candidatesFor: packageCandidates, versionField: "version", skip });
    expect(pkgs.map((f) => f.rel)).not.toContain("packages/plugin-a/package.json");

    // required:true would otherwise throw on plugin-a's manifest — skip must win.
    const manifests = discoverVersionedFiles(root, {
      candidatesFor: manifestCandidates,
      versionField: "Version",
      skip,
      required: true,
    });
    expect(manifests.map((f) => f.rel)).toEqual(["packages/plugin-b/com.x.b.ulanziPlugin/manifest.json"]);
  });

  it("returns no manifests when every plugin package is skipped, even though the folders still exist", () => {
    buildStandardTree();
    const skip = new Set(["@x/plugin-a", "@x/plugin-b"]);

    const manifests = discoverVersionedFiles(root, {
      candidatesFor: manifestCandidates,
      versionField: "Version",
      skip,
      required: true,
    });
    // Legitimately empty (all opted out) — the orchestrator's floor must NOT
    // abort here, which is why it cross-checks allPluginManifestRelPaths().
    expect(manifests).toEqual([]);
    expect(allPluginManifestRelPaths(root).length).toBeGreaterThan(0);
  });
});

describe("allPluginManifestRelPaths", () => {
  it("lists every plugin folder's manifest path, ignoring skip and Version presence", () => {
    buildStandardTree();
    expect(allPluginManifestRelPaths(root).sort()).toEqual([
      "packages/plugin-a/com.x.a.sdPlugin/manifest.json",
      "packages/plugin-b/com.x.b.ulanziPlugin/manifest.json",
    ]);
  });

  it("is empty when no plugin folders exist at all (the genuine floor-abort case)", () => {
    writeJson("packages/lib-only/package.json", { name: "@x/lib-only", version: "1.0.0" });
    expect(allPluginManifestRelPaths(root)).toEqual([]);
  });
});

describe("write-path round-trip", () => {
  it("re-serializes captured data byte-identically to the on-disk form", () => {
    // A key order that is NOT alphabetical, to prove insertion order is preserved.
    const original = { Name: "A", UUID: "com.x.a", Version: "1.0.0.0", Nested: { b: 1, a: 2 } };
    writeJson("packages/plugin-a/package.json", { name: "@x/plugin-a", version: "1.0.0" });
    writeJson("packages/plugin-a/com.x.a.sdPlugin/manifest.json", original);

    const [{ data }] = discoverVersionedFiles(root, {
      candidatesFor: manifestCandidates,
      versionField: "Version",
      required: true,
    });
    // The exact serializer release-hooks.mjs uses.
    expect(JSON.stringify(data, null, 2) + "\n").toBe(JSON.stringify(original, null, 2) + "\n");
  });
});
