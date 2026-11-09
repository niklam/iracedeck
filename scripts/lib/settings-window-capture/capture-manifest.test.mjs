import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CHANGELOG_SOURCE_PATH } from "../changelog-data.mjs";
import { parseChangelog } from "../changelog-parse.mjs";
import {
  BOOTSTRAP_RELEASE,
  buildCaptureManifest,
  CAPTURE_MANIFEST_FILE,
  checkCaptureManifest,
  COMMITTED_CAPTURE_DIR_REL,
  serializeCaptureManifest,
  sha256Hex,
} from "./capture-manifest.mjs";
import { SETTINGS_WINDOW_TABS } from "./tabs.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const assetsDir = join(repoRoot, "packages", "website", "src", "assets", "settings-window");

const DROP_FIX = "git checkout origin/master -- packages/website/src/assets/settings-window/";
const RECAPTURE_FIX = "recaptured by the next stable release, never in a branch";

/** @param {string} text */
const bytes = (text) => new TextEncoder().encode(text);

/** Two listed tabs is enough to exercise every rule; the real list is checked on the real tree. */
const TABS = [
  { pane: "general", label: "General", file: "general.png", elgatoOnly: false },
  { pane: "updates", label: "What's New", file: "whats-new.png", elgatoOnly: false },
];

/** A clean fixture past the bootstrap, so every rule is live. */
function cleanInput() {
  const files = { "general.png": bytes("general pixels"), "whats-new.png": bytes("whats-new pixels") };

  return {
    manifest: buildCaptureManifest("3.9.0", files),
    files,
    tabs: TABS,
    newestReleased: "3.9.0",
    packageVersion: "3.10.0-dev.0",
  };
}

/**
 * @template T
 * @param {Record<string, T>} record
 * @param {string} key
 * @returns {Record<string, T>}
 */
const without = (record, key) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

/** @param {{ file?: string, message: string }[]} findings */
const describeFindings = (findings) => findings.map((f) => `${f.file ?? "(manifest)"}: ${f.message}`).join("\n");

describe("the committed screenshot folder", () => {
  it("matches its capture.json", () => {
    const files = Object.fromEntries(
      readdirSync(assetsDir)
        .filter((name) => name.endsWith(".png"))
        .map((name) => [name, readFileSync(join(assetsDir, name))]),
    );

    let manifest = null;
    let manifestText = null;
    try {
      manifestText = readFileSync(join(assetsDir, CAPTURE_MANIFEST_FILE), "utf8");
      manifest = JSON.parse(manifestText);
    } catch {
      // Absent or unparseable: checkCaptureManifest reports it.
    }

    const { releases } = parseChangelog(readFileSync(join(repoRoot, CHANGELOG_SOURCE_PATH), "utf8"));
    const newestReleased = releases.find((release) => release.date !== null)?.version;
    const packageVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

    expect(newestReleased, "changelog.mdx has no dated section").toBeTypeOf("string");

    const findings = checkCaptureManifest({
      manifest,
      files,
      tabs: SETTINGS_WINDOW_TABS,
      newestReleased: /** @type {string} */ (newestReleased),
      packageVersion,
    });

    expect(findings, `${CAPTURE_MANIFEST_FILE} findings:\n${describeFindings(findings)}`).toEqual([]);

    // Only the release hook writes it, through serializeCaptureManifest; a hand
    // edit that reorders or reformats it shows here.
    expect(manifestText).toBe(serializeCaptureManifest(manifest));
  });

  it("is named once, as the literal folder the fixes and the release hook use", () => {
    // A literal, so a wrong constant cannot agree with itself.
    expect(COMMITTED_CAPTURE_DIR_REL).toBe("packages/website/src/assets/settings-window");
    expect(join(repoRoot, ...COMMITTED_CAPTURE_DIR_REL.split("/"))).toBe(assetsDir);
  });
});

describe("sha256Hex", () => {
  it("is the lowercase hex sha256 of the bytes", () => {
    expect(sha256Hex(bytes("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("buildCaptureManifest / serializeCaptureManifest", () => {
  it("hashes every file, keyed in sorted order whatever order they were read in", () => {
    const manifest = buildCaptureManifest("3.9.0", { "b.png": bytes("b"), "a.png": bytes("a") });

    expect(manifest).toEqual({
      version: "3.9.0",
      files: { "a.png": sha256Hex(bytes("a")), "b.png": sha256Hex(bytes("b")) },
    });
    expect(Object.keys(manifest.files)).toEqual(["a.png", "b.png"]);
  });

  it("serialises as two-space JSON with a trailing newline", () => {
    const manifest = { version: "3.9.0", files: { "a.png": "0".repeat(64) } };

    expect(serializeCaptureManifest(manifest)).toBe(
      `{\n  "version": "3.9.0",\n  "files": {\n    "a.png": "${"0".repeat(64)}"\n  }\n}\n`,
    );
  });
});

describe("checkCaptureManifest", () => {
  it("accepts a clean folder", () => {
    expect(checkCaptureManifest(cleanInput())).toEqual([]);
  });

  it("accepts a listed tab with neither a file nor an entry, as pending the next release capture", () => {
    const input = cleanInput();
    const tabs = [...TABS, { pane: "new", label: "New", file: "new.png", elgatoOnly: false }];

    expect(checkCaptureManifest({ ...input, tabs })).toEqual([]);
  });

  describe("missing or malformed manifest", () => {
    it("reports a missing manifest", () => {
      const findings = checkCaptureManifest({ ...cleanInput(), manifest: null });

      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain("missing");
      expect(findings[0].message).toContain(DROP_FIX);
    });

    it("reports a manifest that is not an object", () => {
      const findings = checkCaptureManifest({ ...cleanInput(), manifest: [] });

      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain("not a JSON object");
    });

    it("reports an extra key", () => {
      const input = cleanInput();
      const findings = checkCaptureManifest({ ...input, manifest: { ...input.manifest, capturedAt: "today" } });

      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain("capturedAt");
    });

    it("reports a version that is not a string, during the bootstrap too", () => {
      const input = cleanInput();
      const findings = checkCaptureManifest({
        ...input,
        manifest: { ...input.manifest, version: 390 },
        newestReleased: BOOTSTRAP_RELEASE,
      });

      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('no string "version"');
    });

    it("reports a missing files object", () => {
      const findings = checkCaptureManifest({ ...cleanInput(), manifest: { version: "3.9.0" } });

      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('no "files" object');
    });

    it("reports an entry that is not a lowercase hex sha256, once", () => {
      const input = cleanInput();
      const upper = input.manifest.files["general.png"].toUpperCase();
      const findings = checkCaptureManifest({
        ...input,
        manifest: { ...input.manifest, files: { ...input.manifest.files, "general.png": upper } },
      });

      expect(findings).toEqual([
        { file: "general.png", message: expect.stringContaining("not a lowercase hex sha256") },
      ]);
    });
  });

  describe("positive controls: each mutation produces its finding", () => {
    it("one flipped byte in a PNG", () => {
      const input = cleanInput();
      const flipped = Uint8Array.from(input.files["general.png"]);
      flipped[3] ^= 0x01;
      const findings = checkCaptureManifest({ ...input, files: { ...input.files, "general.png": flipped } });

      expect(findings).toHaveLength(1);
      expect(findings[0].file).toBe("general.png");
      expect(findings[0].message).toContain("does not match its hash");
      expect(findings[0].message).toContain(DROP_FIX);
    });

    it("a file without an entry", () => {
      const input = cleanInput();
      const files = without(input.manifest.files, "general.png");
      const findings = checkCaptureManifest({ ...input, manifest: { ...input.manifest, files } });

      expect(findings).toHaveLength(1);
      expect(findings[0].file).toBe("general.png");
      expect(findings[0].message).toContain("has no entry");
      expect(findings[0].message).toContain(DROP_FIX);
    });

    it("an entry without a file", () => {
      const input = cleanInput();
      const findings = checkCaptureManifest({ ...input, files: without(input.files, "general.png") });

      expect(findings).toHaveLength(1);
      expect(findings[0].file).toBe("general.png");
      expect(findings[0].message).toContain("the PNG is missing");
      expect(findings[0].message).toContain("delete the remainder");
      expect(findings[0].message).toContain(DROP_FIX);
    });

    it("a PNG for an unlisted tab", () => {
      const input = cleanInput();
      const findings = checkCaptureManifest({ ...input, files: { ...input.files, "old.png": bytes("old") } });

      expect(findings).toHaveLength(1);
      expect(findings[0].file).toBe("old.png");
      expect(findings[0].message).toContain("names no tab");
      expect(findings[0].message).toContain("PNG and its manifest entry go together");
    });

    it("an entry for an unlisted tab", () => {
      const input = cleanInput();
      const files = { ...input.manifest.files, "old.png": sha256Hex(bytes("old")) };
      const findings = checkCaptureManifest({ ...input, manifest: { ...input.manifest, files } });

      expect(findings).toHaveLength(1);
      expect(findings[0].file).toBe("old.png");
      expect(findings[0].message).toContain("a manifest entry but names no tab");
    });

    it("a PNG and an entry for an unlisted tab, as one finding", () => {
      const input = cleanInput();
      const old = bytes("old");
      const findings = checkCaptureManifest({
        ...input,
        files: { ...input.files, "old.png": old },
        manifest: { ...input.manifest, files: { ...input.manifest.files, "old.png": sha256Hex(old) } },
      });

      expect(findings).toEqual([
        { file: "old.png", message: expect.stringContaining("delete its PNG and its manifest entry together") },
      ]);
    });

    it("a -dev version", () => {
      const input = cleanInput();
      const findings = checkCaptureManifest({ ...input, manifest: { ...input.manifest, version: "3.10.0-dev.0" } });

      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain("prerelease");
      expect(findings[0].message).toContain(RECAPTURE_FIX);
    });

    it("a version that is not bare semver", () => {
      const input = cleanInput();

      for (const version of ["v3.9.0", "3.9", "3.9.0+build.1", ""]) {
        const findings = checkCaptureManifest({ ...input, manifest: { ...input.manifest, version } });

        expect(findings, version).toHaveLength(1);
        expect(findings[0].message, version).toContain("is not a semver version");
      }
    });

    it("a version below the newest dated section", () => {
      const input = cleanInput();
      const findings = checkCaptureManifest({ ...input, manifest: { ...input.manifest, version: "3.8.1" } });

      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain("older than the newest release");
      expect(findings[0].message).toContain(RECAPTURE_FIX);
    });

    it("a version above the package version", () => {
      const input = cleanInput();
      const findings = checkCaptureManifest({ ...input, manifest: { ...input.manifest, version: "3.10.1" } });

      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain("newer than the version in development (3.10.0)");
      expect(findings[0].message).toContain(DROP_FIX);
    });
  });

  it("accepts the version in development itself, its prerelease stripped", () => {
    const input = cleanInput();

    expect(checkCaptureManifest({ ...input, manifest: { ...input.manifest, version: "3.10.0" } })).toEqual([]);
  });

  describe("bootstrap", () => {
    it("skips the version rules while the newest release is the bootstrap release", () => {
      const input = cleanInput();

      for (const version of ["3.8.1-dev.0", "3.0.0", "9.9.9", "not a version"]) {
        const findings = checkCaptureManifest({
          ...input,
          manifest: { ...input.manifest, version },
          newestReleased: BOOTSTRAP_RELEASE,
        });

        expect(findings, version).toEqual([]);
      }
    });

    it("keeps the listing and hash rules", () => {
      const input = cleanInput();
      const flipped = Uint8Array.from(input.files["general.png"]);
      flipped[0] ^= 0x80;
      const findings = checkCaptureManifest({
        ...input,
        newestReleased: BOOTSTRAP_RELEASE,
        files: { ...input.files, "general.png": flipped, "old.png": bytes("old") },
      });

      expect(findings.map((finding) => finding.file)).toEqual(["general.png", "old.png"]);
    });

    it("ends with the next release", () => {
      const input = cleanInput();
      const findings = checkCaptureManifest({ ...input, manifest: { ...input.manifest, version: "3.8.1" } });

      expect(findings).toHaveLength(1);
    });
  });

  it("refuses a caller's malformed version inputs", () => {
    expect(() => checkCaptureManifest({ ...cleanInput(), newestReleased: "next" })).toThrow(TypeError);
    expect(() => checkCaptureManifest({ ...cleanInput(), packageVersion: "" })).toThrow(TypeError);
  });
});
