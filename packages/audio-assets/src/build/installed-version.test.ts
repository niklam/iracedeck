import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import url from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { installedPackageVersion } from "./installed-version.mjs";

const require = createRequire(import.meta.url);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A throwaway project with one installed package, `name`, whose `package.json`
 * is `manifest` and whose entry sits at `entry` (relative to the package).
 * Returns the `import.meta.url` a module in that project would have.
 */
function fakeProject(name: string, manifest: Record<string, unknown>, entry = "index.js"): string {
  const root = mkdtempSync(path.join(tmpdir(), "ird-installed-version-"));
  tempDirs.push(root);

  const pkgDir = path.join(root, "node_modules", name);
  mkdirSync(path.dirname(path.join(pkgDir, entry)), { recursive: true });
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(manifest));
  writeFileSync(path.join(pkgDir, entry), "module.exports = {};\n");
  writeFileSync(path.join(root, "consumer.mjs"), "");

  return url.pathToFileURL(path.join(root, "consumer.mjs")).href;
}

describe("installedPackageVersion", () => {
  // The two packages the identities read, through the same resolution the
  // code that runs them uses: a disagreement here would be a record naming a
  // version other than the one that produced the archive.
  it.each(["ffmpeg-static", "fflate"])("reads the installed %s version, the one require() would load", (name) => {
    const expected = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf-8")).version;

    expect(installedPackageVersion(name, import.meta.url)).toBe(expected);
    expect(installedPackageVersion(name, import.meta.url)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("reads the version through the package.json subpath when the exports map allows it", () => {
    const from = fakeProject("plain-pkg", { name: "plain-pkg", version: "1.2.3" });

    expect(installedPackageVersion("plain-pkg", from)).toBe("1.2.3");
  });

  it("falls back to the package's own manifest when its exports map withholds package.json", () => {
    // An entry under a subdirectory with a module-type marker beside it: the
    // walk must pass that nameless package.json and stop at the package's own.
    const root = mkdtempSync(path.join(tmpdir(), "ird-installed-version-strict-"));
    tempDirs.push(root);

    const pkgDir = path.join(root, "node_modules", "strict-pkg");
    mkdirSync(path.join(pkgDir, "esm"), { recursive: true });
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "strict-pkg", version: "4.5.6", exports: { ".": "./esm/index.js" } }),
    );
    writeFileSync(path.join(pkgDir, "esm", "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(pkgDir, "esm", "index.js"), "export {};\n");
    writeFileSync(path.join(root, "consumer.mjs"), "");

    const from = url.pathToFileURL(path.join(root, "consumer.mjs")).href;
    const strictRequire = createRequire(from);

    // The precondition: the subpath really is refused, so the fallback is what ran.
    expect(() => strictRequire.resolve("strict-pkg/package.json")).toThrow(
      expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }),
    );
    expect(installedPackageVersion("strict-pkg", from)).toBe("4.5.6");
  });

  it("refuses a package that is not installed, naming it", () => {
    const from = fakeProject("present-pkg", { name: "present-pkg", version: "1.0.0" });

    expect(() => installedPackageVersion("absent-pkg", from)).toThrow(/cannot resolve "absent-pkg"/);
  });

  it("refuses a manifest with no version rather than recording an empty one", () => {
    const from = fakeProject("versionless-pkg", { name: "versionless-pkg" });

    expect(() => installedPackageVersion("versionless-pkg", from)).toThrow(/has no "version"/);
  });
});
