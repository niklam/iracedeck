/**
 * `capture.json`: the record of what the stable release captured into the
 * Settings window screenshot folder (issue #1536).
 *
 * The screenshots are captured once per stable release, by the release-it
 * `after:bump` hook, and never in a branch: a binary file git cannot merge,
 * rewritten by every user-facing PR, conflicted between any two in flight. The
 * PNGs themselves cannot be compared across machines, so this manifest is what
 * makes "captured by a release" checkable in text. The hook writes it through
 * {@link buildCaptureManifest} and {@link serializeCaptureManifest};
 * `capture-manifest.test.mjs` holds the committed folder to it through
 * {@link checkCaptureManifest}, which is what turns a branch's recapture red.
 *
 * Pure: no file system, no process state. The callers read the folder.
 * Decided in `docs/superpowers/specs/2026-11-09-issue-1536-whats-new-screenshot-conflicts.md`.
 */
import { createHash } from "node:crypto";
import semver from "semver";

/** The manifest's file name, beside the PNGs it lists. */
export const CAPTURE_MANIFEST_FILE = "capture.json";

/**
 * The newest released version before release-time capture existed. While it is
 * still the newest dated section of `changelog.mdx`, {@link checkCaptureManifest}
 * skips its three version rules and keeps the shape, listing and hash rules:
 * `master`'s PNGs were captured by branches at assorted `-dev` versions, and the
 * bootstrap manifest records them as they are.
 *
 * The 3.9.0 release ends the exemption: it folds a `3.9.0` section and, in the
 * same commit, recaptures the whole folder at `3.9.0`. A follow-up deletes this
 * constant and the branch that reads it.
 */
export const BOOTSTRAP_RELEASE = "3.8.1";

/** The folder the manifest guards, relative to the repository root. */
const FOLDER = "packages/website/src/assets/settings-window/";

const DROP_BRANCH_FILES =
  "screenshots are recaptured by the next stable release, never in a branch: drop the branch's files with " +
  `\`git checkout origin/master -- ${FOLDER}\``;

const REMOVE_TAB_REMAINDER =
  "a removed tab's PNG and its manifest entry go together: delete the remainder " +
  "(or, if the tab was not meant to go, drop the branch's files with " +
  `\`git checkout origin/master -- ${FOLDER}\`)`;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * @typedef {{ version: string, files: Record<string, string> }} CaptureManifest
 * @typedef {{ file?: string, message: string }} CaptureManifestFinding
 * @typedef {import("./tabs.mjs").SettingsWindowTab} SettingsWindowTab
 */

/**
 * The lowercase hex sha256 of a file's bytes, as the manifest records it.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build the manifest for a capture: the version the window header printed and
 * the hash of every file, keyed in sorted order so the serialised text depends
 * only on the content, never on the order the folder was read in.
 *
 * @param {string} version - The version the capture's header printed.
 * @param {Record<string, Uint8Array>} filesByName - File name → bytes.
 * @returns {CaptureManifest}
 */
export function buildCaptureManifest(version, filesByName) {
  const names = Object.keys(filesByName).sort();

  return {
    version,
    files: Object.fromEntries(names.map((name) => [name, sha256Hex(filesByName[name])])),
  };
}

/**
 * Serialise the manifest exactly as it is committed: two-space JSON and a
 * trailing newline, which Prettier accepts unchanged.
 *
 * @param {CaptureManifest} manifest
 * @returns {string}
 */
export function serializeCaptureManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The shape rules. Returns the findings and, when the manifest is usable for
 * the listing and hash rules, its `files` record.
 *
 * @param {unknown} manifest
 * @returns {{ findings: CaptureManifestFinding[], entries: Record<string, unknown> | null }}
 */
function checkShape(manifest) {
  /** @type {CaptureManifestFinding[]} */
  const findings = [];

  if (!isPlainObject(manifest)) {
    return {
      findings: [{ message: `${CAPTURE_MANIFEST_FILE} is not a JSON object; ${DROP_BRANCH_FILES}` }],
      entries: null,
    };
  }

  const extra = Object.keys(manifest).filter((key) => key !== "version" && key !== "files");
  if (extra.length > 0) {
    findings.push({
      message: `${CAPTURE_MANIFEST_FILE} has keys other than "version" and "files" (${extra.join(", ")}); ${DROP_BRANCH_FILES}`,
    });
  }

  if (typeof manifest.version !== "string") {
    findings.push({ message: `${CAPTURE_MANIFEST_FILE} has no string "version"; ${DROP_BRANCH_FILES}` });
  }

  if (!isPlainObject(manifest.files)) {
    findings.push({ message: `${CAPTURE_MANIFEST_FILE} has no "files" object; ${DROP_BRANCH_FILES}` });
    return { findings, entries: null };
  }

  for (const [name, hash] of Object.entries(manifest.files)) {
    if (typeof hash !== "string" || !SHA256_HEX.test(hash)) {
      findings.push({
        file: name,
        message: `${CAPTURE_MANIFEST_FILE} records ${name} with a value that is not a lowercase hex sha256; ${DROP_BRANCH_FILES}`,
      });
    }
  }

  return { findings, entries: manifest.files };
}

/**
 * The listing and hash rules: every listed tab has a file and an entry whose
 * hash matches, or neither (pending until the next release capture); nothing
 * is there for a tab that is not listed.
 *
 * @param {Record<string, unknown>} entries
 * @param {Record<string, Uint8Array>} files
 * @param {readonly SettingsWindowTab[]} tabs
 * @returns {CaptureManifestFinding[]}
 */
function checkListing(entries, files, tabs) {
  /** @type {CaptureManifestFinding[]} */
  const findings = [];
  const listed = new Set(tabs.map((tab) => tab.file));
  const names = [...new Set([...Object.keys(files), ...Object.keys(entries)])].sort();

  for (const name of names) {
    const hasFile = Object.hasOwn(files, name);
    const hasEntry = Object.hasOwn(entries, name);

    if (!listed.has(name)) {
      const what = hasFile && hasEntry ? "a PNG and a manifest entry" : hasFile ? "a PNG" : "a manifest entry";
      const fix = hasFile && hasEntry ? "delete its PNG and its manifest entry together" : REMOVE_TAB_REMAINDER;
      findings.push({
        file: name,
        message: `${name} has ${what} but names no tab in SETTINGS_WINDOW_TABS; ${fix}`,
      });
      continue;
    }

    if (hasFile && !hasEntry) {
      findings.push({ file: name, message: `${name} has no entry in ${CAPTURE_MANIFEST_FILE}; ${DROP_BRANCH_FILES}` });
      continue;
    }

    if (hasEntry && !hasFile) {
      findings.push({
        file: name,
        message:
          `${CAPTURE_MANIFEST_FILE} lists ${name}, but the PNG is missing; if its tab is being removed, its ` +
          "SETTINGS_WINDOW_TABS line, PNG and manifest entry go together: delete the remainder; otherwise restore " +
          `the PNG with \`git checkout origin/master -- ${FOLDER}\``,
      });
      continue;
    }

    // Both present (a listed tab with neither is pending: no finding). A
    // malformed hash was already reported by the shape rules.
    const recorded = entries[name];
    if (typeof recorded === "string" && SHA256_HEX.test(recorded) && recorded !== sha256Hex(files[name])) {
      findings.push({
        file: name,
        message: `${name} does not match its hash in ${CAPTURE_MANIFEST_FILE}; ${DROP_BRANCH_FILES}`,
      });
    }
  }

  return findings;
}

/**
 * The version window: a stable version, no older than the newest released
 * section (else that release's capture never landed), no newer than the
 * version in development.
 *
 * @param {string} version
 * @param {string} newestReleased
 * @param {string} packageVersion
 * @returns {CaptureManifestFinding[]}
 */
function checkVersion(version, newestReleased, packageVersion) {
  const parsed = semver.parse(version);

  // `semver.parse` accepts a leading "v" and build metadata; the header prints
  // neither, so the recorded string must be the bare version itself.
  if (parsed === null || parsed.version !== version || parsed.build.length > 0) {
    return [
      {
        message: `${CAPTURE_MANIFEST_FILE} version "${version}" is not a semver version; ${DROP_BRANCH_FILES}`,
      },
    ];
  }

  if (parsed.prerelease.length > 0) {
    return [
      {
        message:
          `${CAPTURE_MANIFEST_FILE} version ${version} is a prerelease, so it was not captured by a stable release; ` +
          DROP_BRANCH_FILES,
      },
    ];
  }

  /** @type {CaptureManifestFinding[]} */
  const findings = [];

  if (semver.lt(version, newestReleased)) {
    findings.push({
      message:
        `${CAPTURE_MANIFEST_FILE} version ${version} is older than the newest release in changelog.mdx (${newestReleased}), ` +
        "so that release's capture never landed: the screenshots are recaptured by the next stable release, never in a branch",
    });
  }

  const ceiling = /** @type {semver.SemVer} */ (semver.parse(packageVersion));
  const developing = `${ceiling.major}.${ceiling.minor}.${ceiling.patch}`;

  if (semver.gt(version, developing)) {
    findings.push({
      message:
        `${CAPTURE_MANIFEST_FILE} version ${version} is newer than the version in development (${developing}); ` +
        DROP_BRANCH_FILES,
    });
  }

  return findings;
}

/**
 * Hold the committed screenshot folder to its manifest. Returns one finding per
 * problem, each naming its fix; an empty array means the folder is clean.
 *
 * @param {object} input
 * @param {unknown} input.manifest - The parsed `capture.json`, or `null` when it
 *   is absent or unparseable.
 * @param {Record<string, Uint8Array>} input.files - Every `.png` in the folder,
 *   file name → bytes.
 * @param {readonly SettingsWindowTab[]} input.tabs - `SETTINGS_WINDOW_TABS`.
 * @param {string} input.newestReleased - The newest dated section of
 *   `changelog.mdx`.
 * @param {string} input.packageVersion - The root `package.json` version.
 * @returns {CaptureManifestFinding[]}
 */
export function checkCaptureManifest({ manifest, files, tabs, newestReleased, packageVersion }) {
  // Both come from files the repository's own tooling validates (the changelog
  // parser, the version bump), so a bad one is a caller bug, not a finding.
  for (const [name, value] of [
    ["newestReleased", newestReleased],
    ["packageVersion", packageVersion],
  ]) {
    if (semver.valid(value) === null) {
      throw new TypeError(`checkCaptureManifest: ${name} "${value}" is not a semver version`);
    }
  }

  if (manifest === null || manifest === undefined) {
    return [{ message: `${CAPTURE_MANIFEST_FILE} is missing or not valid JSON; ${DROP_BRANCH_FILES}` }];
  }

  const shape = checkShape(manifest);
  const findings = [...shape.findings];

  if (shape.entries !== null) findings.push(...checkListing(shape.entries, files, tabs));

  const version = /** @type {{ version?: unknown }} */ (manifest).version;
  if (newestReleased !== BOOTSTRAP_RELEASE && typeof version === "string") {
    findings.push(...checkVersion(version, newestReleased, packageVersion));
  }

  return findings;
}
