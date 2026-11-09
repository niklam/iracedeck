/**
 * The stable release's Settings-window screenshot capture: the logic behind
 * release-it's `after:bump` hook, `scripts/release-capture.mjs` (#1536).
 *
 * The committed screenshots in `packages/website/src/assets/settings-window/`
 * are captured once per stable release, into its version-bump commit, and
 * never in a branch: a binary file every user-facing PR rewrote conflicted
 * between any two in flight. This hook runs after `before:bump` has folded the
 * fragments and bumped the version files and before release-it stages and
 * commits (release-it 21.1.1 `lib/index.js`, the `beforeBump` → `bump` →
 * `beforeRelease` loop), so what it captures is the page as the release ships
 * it: the new header version and the folded notes. For a version with any
 * prerelease identifier it does nothing but say so, the same condition as the
 * fold, because `release.yml` deploys the website for stable tags only.
 *
 * On a stable version the steps run in this order, each one's failure stopping
 * the release before anything is staged:
 *
 * 1. Refuse a developer tree before anything is built: `feature-flags.local.json`
 *    or `dev.local.json` at the root, or `IRACEDECK_DEV_VOICES` in the
 *    environment, would build flags or a voice root no user has into the shots.
 * 2. Snapshot the tracked changes already in the tree — `before:bump`'s version
 *    files, the folded `changelog.mdx`, the fragments' removal, any sealed
 *    voice-pack record — each with the hash of its content, so step 7 can tell
 *    the build's changes from theirs, a file both changed included.
 * 3. Build the Stream Deck plugin and its dependencies through turbo's JS entry.
 * 4. `assertReleaseBuild` on the built plugin's `bin/config.json`: the artifact
 *    itself carries no development voice root.
 * 5. Capture every tab into the committed folder, expecting the header to read
 *    `v<version>`; a tab the capture skipped (the Support tab's image did not
 *    load) is a failure here, since a partial set would put the previous
 *    version's header on the site.
 * 6. Write `capture.json` and hold the folder as written to it, which refuses a
 *    stray PNG of a tab the list does not name.
 * 7. Refuse any tracked change outside the folder that step 2 did not record,
 *    because release-it's `git add . --update` would sweep it into the release
 *    commit unseen. Then stage the folder, which release-it's own `--update`
 *    staging would not do for a pending tab's first, untracked PNG.
 *
 * Every failure names the commands that return the tree to HEAD. release-it's
 * `requireCleanWorkingDir` held when the release started, so `git restore
 * --staged --worktree -- :/` is safe, and it brings back the staged deletions
 * and modifications too; it does not remove an untracked file, so a pending
 * tab's first PNG needs the `git clean` of the folder beside it.
 *
 * `RELEASE_IT_DRY_RUN=1` makes the developer-tree checks, prints the build and
 * the capture it would do, and writes nothing. release-it skips hooks in its
 * own dry run, so `scripts/release.mjs` runs this branch itself on
 * `pnpm release:dry`.
 *
 * Every collaborator is injected and an exit code is returned, the shape
 * `capture.mjs` and `release.mjs` use, so the sequence is tested without a
 * build, a browser or a git repository.
 * Decided in `docs/superpowers/specs/2026-11-09-issue-1536-whats-new-screenshot-conflicts.md`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import semver from "semver";

import { assertReleaseBuild as realAssertReleaseBuild } from "./assert-release-build.mjs";
import { CHANGELOG_SOURCE_PATH } from "./changelog-data.mjs";
import { parseChangelog } from "./changelog-parse.mjs";
import { DEV_LOCAL_FILE, DEV_VOICES_ENV } from "./dev-local.mjs";
import {
  buildCaptureManifest,
  CAPTURE_MANIFEST_FILE,
  checkCaptureManifest,
  serializeCaptureManifest,
} from "./settings-window-capture/capture-manifest.mjs";
import {
  CapturePreconditionError,
  committedCaptureDir,
  runCapture as realRunCapture,
  REPO_ROOT,
} from "./settings-window-capture/run-capture.mjs";
import { SETTINGS_WINDOW_TABS } from "./settings-window-capture/tabs.mjs";

/** The per-worktree platform-flag override `@iracedeck/plugin-build` reads. */
export const FEATURE_FLAGS_LOCAL_FILE = "feature-flags.local.json";

/** The turbo filter: the Stream Deck plugin and everything it depends on. */
export const BUILD_FILTER = "@iracedeck/iracing-plugin-stream-deck...";

/** turbo's arguments for the build, after its JS entry. */
export const BUILD_ARGS = Object.freeze(["run", "build", `--filter=${BUILD_FILTER}`]);

/** The built plugin's config, which `assertReleaseBuild` reads. */
export const PLUGIN_CONFIG_REL = "packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/bin/config.json";

/** Returns every tracked change to HEAD: safe because the release started on a clean tree. */
export const RESTORE_COMMAND = "git restore --staged --worktree -- :/";

/**
 * Removes a pending tab's first PNG, which `git restore` leaves because it is
 * untracked; harmless when the folder holds nothing untracked.
 *
 * @param {string} folderRel - The screenshot folder, relative to the root.
 */
export function cleanCommand(folderRel) {
  return `git clean -fd -- ${folderRel}/`;
}

/**
 * turbo's own JS entry, run with this Node rather than through the
 * `node_modules/.bin/turbo.cmd` shim, as `scripts/build-with-restart.mjs` does:
 * the shim is a batch file, and on Ctrl+C `cmd.exe` stops at "Terminate batch
 * job (Y/N)?", holding the release until someone answers.
 */
export function turboEntry() {
  return createRequire(import.meta.url).resolve("turbo/bin/turbo");
}

/** The build command as the dry run and the log print it. */
export function describeBuildCommand() {
  return [process.execPath, turboEntry(), ...BUILD_ARGS].join(" ");
}

/**
 * The real build: turbo under `process.execPath`, output streamed, in `root`.
 *
 * @param {string} root
 * @returns {number} The exit code; 1 when the process could not be started.
 */
function realBuild(root) {
  const result = spawnSync(process.execPath, [turboEntry(), ...BUILD_ARGS], { cwd: root, stdio: "inherit" });

  if (result.error) throw result.error;

  return result.status ?? 1;
}

/**
 * The real git: argv form (no shell), run in `root`, stdout returned, stderr
 * shown. A non-zero exit throws, with git's own message already on stderr.
 *
 * @param {string} root
 * @param {readonly string[]} args
 * @param {string} [input] - Fed to git's stdin.
 * @returns {string}
 */
function realGit(root, args, input) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    input,
    stdio: ["pipe", "pipe", "inherit"],
  });
}

/** A path under `root` as git names it: relative, forward slashes. */
function relativeToRoot(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

/**
 * @typedef {{ existsSync: (p: string) => boolean, readdirSync: (p: string) => string[],
 *   readFileSync: (p: string, enc?: string) => any, writeFileSync: (p: string, data: string) => void }} ReleaseCaptureFs
 * @typedef {Map<string, string>} TrackedChanges - Repo-relative path → the blob hash of its
 *   working-tree content, or `"deleted"` for a path removed from the tree.
 */

/**
 * Every tracked path whose working tree or index differs from HEAD, with the
 * hash of what the working tree holds. `git diff HEAD --name-only` sees staged
 * and unstaged changes alike, additions and deletions included, which is what
 * release-it's `git add . --update` will later stage; `git hash-object
 * --stdin-paths` hashes the present ones in one call, through the same
 * filters git would apply on `add`, so two snapshots of an unchanged file agree.
 *
 * @param {string} root
 * @param {{ git: typeof realGit, fs: ReleaseCaptureFs }} deps
 * @returns {TrackedChanges}
 */
function snapshotTrackedChanges(root, { git, fs }) {
  const paths = git(root, ["diff", "HEAD", "--name-only", "-z", "--no-renames"])
    .split("\0")
    .filter((p) => p !== "");
  const present = paths.filter((p) => fs.existsSync(path.join(root, p)));
  const hashes =
    present.length === 0
      ? []
      : git(root, ["hash-object", "--stdin-paths"], `${present.join("\n")}\n`)
          .split(/\r?\n/)
          .filter((line) => line !== "");

  if (hashes.length !== present.length) {
    throw new Error(
      `git hash-object returned ${hashes.length} hashes for ${present.length} paths; the tracked-change snapshot cannot be trusted.`,
    );
  }

  /** @type {TrackedChanges} */
  const snapshot = new Map(paths.map((p) => [p, "deleted"]));
  present.forEach((p, i) => snapshot.set(p, hashes[i]));

  return snapshot;
}

/**
 * The tracked changes in `after` that `before` does not account for, outside
 * the screenshot folder: a path `before` lacks, one whose content moved on, or
 * one `before` had that `after` no longer has (the build put it back to HEAD,
 * undoing `before:bump`'s edit). Each with the reason.
 *
 * @param {TrackedChanges} before
 * @param {TrackedChanges} after
 * @param {string} folderRel
 * @returns {string[]}
 */
export function unexpectedTrackedChanges(before, after, folderRel) {
  const underFolder = (p) => p.startsWith(`${folderRel}/`);
  const unexpected = [];

  for (const [p, hash] of after) {
    if (underFolder(p)) continue;
    const was = before.get(p);
    if (was === undefined) unexpected.push(`${p} (changed by the build; it matched HEAD when the hook started)`);
    else if (was !== hash) unexpected.push(`${p} (changed again by the build after before:bump changed it)`);
  }
  for (const p of before.keys()) {
    if (!underFolder(p) && !after.has(p)) unexpected.push(`${p} (before:bump's change to it was undone by the build)`);
  }

  return unexpected;
}

/**
 * The developer-tree markers present, each as a sentence saying what it is and
 * what to do about it. Empty for a tree a release may build from.
 *
 * `IRACEDECK_DEV_VOICES` refuses on any non-empty value, `"0"` included: the
 * variable only exists to make a developer's build differ from a user's, and
 * a release runs the build every user gets, in an environment that says nothing.
 *
 * @param {string} root
 * @param {{ fs: ReleaseCaptureFs, env: NodeJS.ProcessEnv }} deps
 * @returns {string[]}
 */
export function developerTreeMarkers(root, { fs, env }) {
  const markers = [];

  if (fs.existsSync(path.join(root, FEATURE_FLAGS_LOCAL_FILE))) {
    markers.push(
      `${FEATURE_FLAGS_LOCAL_FILE} exists at the repository root: it would build platform flags no user has into the screenshots. Remove it for the release.`,
    );
  }
  if (fs.existsSync(path.join(root, DEV_LOCAL_FILE))) {
    markers.push(
      `${DEV_LOCAL_FILE} exists at the repository root: it points the plugin at a development voice root. Remove it for the release (\`pnpm dev:voices\` writes it).`,
    );
  }
  const devVoices = env[DEV_VOICES_ENV];
  if (devVoices !== undefined && devVoices !== "") {
    markers.push(
      `${DEV_VOICES_ENV} is set to ${JSON.stringify(devVoices)} in the environment: it switches development voice packs on for every build. Unset it for the release ("0" too; a release runs the build every user gets).`,
    );
  }

  return markers;
}

/**
 * Capture the Settings-window screenshots for a release of `version`, in the
 * tree at `root`. Returns the exit code; every failure is written through
 * `error` as sentences for the person releasing, ending with the commands that
 * return the tree to HEAD.
 *
 * @param {string} version - The version release-it is releasing, as `3.9.0`.
 * @param {object} [deps]
 * @param {string} [deps.root] - The repository root; this checkout's by default.
 * @param {NodeJS.ProcessEnv} [deps.env] - Read for `RELEASE_IT_DRY_RUN` and `IRACEDECK_DEV_VOICES`.
 * @param {ReleaseCaptureFs} [deps.fs]
 * @param {(root: string) => number} [deps.build] - Runs the build, returning its exit code.
 * @param {(configPath: string) => number} [deps.assertReleaseBuild]
 * @param {typeof realRunCapture} [deps.runCapture]
 * @param {typeof realGit} [deps.git]
 * @param {(line: string) => void} [deps.log]
 * @param {(line: string) => void} [deps.warn]
 * @param {(line: string) => void} [deps.error]
 * @returns {Promise<number>}
 */
export async function releaseCapture(
  version,
  {
    root = REPO_ROOT,
    env = process.env,
    fs = { existsSync, readdirSync, readFileSync, writeFileSync },
    build = realBuild,
    assertReleaseBuild = (configPath) => realAssertReleaseBuild(configPath),
    runCapture = realRunCapture,
    git = realGit,
    log = console.log,
    warn = console.warn,
    error = console.error,
  } = {},
) {
  // release-it hands over a valid version; anything else is refused, not guessed about.
  const parsed = semver.parse(version);
  if (parsed === null) {
    error(`Refusing to release: "${version}" is not a semver version.`);

    return 1;
  }

  if (parsed.prerelease.length > 0) {
    log(
      `  Screenshots: ${version} is a pre-release, so the Settings window screenshots are not captured (a stable release captures them).`,
    );

    return 0;
  }

  const folder = committedCaptureDir(root);
  const folderRel = relativeToRoot(root, folder);
  const dryRun = env.RELEASE_IT_DRY_RUN === "1";

  /**
   * Write the failure and what to do about it; the exit code to return. In a
   * dry run nothing has been written, by this hook or by `before:bump`'s dry
   * branch, so there is nothing to restore.
   *
   * @param {string[]} lines
   */
  const fail = (...lines) => {
    for (const line of lines) error(line);
    error(
      dryRun
        ? "Nothing was written; the release would stop here."
        : `Nothing is staged. Return the tree to HEAD with \`${RESTORE_COMMAND}\`, then \`${cleanCommand(folderRel)}\` for a screenshot ` +
            "the capture may have written for a tab that had none, and release again once the cause is fixed.",
    );

    return 1;
  };

  // 1. A developer tree, before anything is built.
  const markers = developerTreeMarkers(root, { fs, env });
  if (markers.length > 0) {
    return fail(
      "Refusing to release from a developer tree: the screenshots would show a build no user gets. Nothing was built or captured.",
      ...markers.map((marker) => `  - ${marker}`),
    );
  }

  if (dryRun) {
    log(`  [dry-run] Would build the Stream Deck plugin and its dependencies: ${describeBuildCommand()}`);
    log(`  [dry-run] Would check that ${PLUGIN_CONFIG_REL} carries no development voice root`);
    log(
      `  [dry-run] Would capture every Settings window tab into ${folderRel}/, expecting its header to read v${version}, ` +
        `write ${CAPTURE_MANIFEST_FILE} there and stage the folder`,
    );

    return 0;
  }

  // Anything below that throws instead of returning — git refusing, a file the
  // fake-free collaborators could not read — is still a failure that must name
  // the restore, so it is caught here rather than left as a raw stack.
  try {
    return await captureAndStage();
  } catch (thrown) {
    return fail("The release stopped on an unexpected error:", String(thrown?.stack ?? thrown));
  }

  async function captureAndStage() {
    // 2. What before:bump left in the tree, so step 7 can tell the build's changes from it.
    const before = snapshotTrackedChanges(root, { git, fs });

    // 3. The build, so the page carries the bumped version and the folded notes.
    log(`  Building the Stream Deck plugin and its dependencies: ${describeBuildCommand()}`);
    const buildStatus = build(root);
    if (buildStatus !== 0) {
      return fail(
        `The release stopped: the plugin build exited ${buildStatus} (see its output above), so there is nothing to capture. ` +
          "An MSVC LNK1318 abort while linking a native addon is a toolchain hiccup, not a defect in the tree: restore and run the release again.",
      );
    }

    // 4. The built artifact carries no development voice root.
    if (assertReleaseBuild(path.join(root, PLUGIN_CONFIG_REL)) !== 0) {
      return fail(
        `The release stopped: ${PLUGIN_CONFIG_REL} is not a release build (see above), so its screenshots would show a build no user gets.`,
      );
    }

    // 5. The capture, into the committed folder, against the header version.
    let written;
    let skipped;
    try {
      ({ written, skipped } = await runCapture({ outDir: folder, expectVersion: version, log, warn, repoRoot: root }));
    } catch (thrown) {
      return fail(
        "The release stopped: the Settings window screenshots could not be captured.",
        thrown instanceof CapturePreconditionError ? thrown.message : String(thrown?.stack ?? thrown),
      );
    }

    if (skipped.length > 0) {
      return fail(
        `The release stopped: ${skipped.length} Settings window tab${skipped.length === 1 ? " was" : "s were"} not captured, ` +
          "and a partial set would put the previous release's header on the site:",
        ...skipped.map(({ file, label, reason }) => `  - ${path.basename(file)} (the ${label} tab): ${reason}`),
        "The Support tab draws its image from another site; run the release again once the network is back.",
      );
    }

    // 6. The manifest, then the folder as written held to it.
    const entries = fs.readdirSync(folder);
    const stray = entries.filter((name) => !name.endsWith(".png") && name !== CAPTURE_MANIFEST_FILE);
    if (stray.length > 0) {
      return fail(
        `The release stopped: ${folderRel}/ holds ${stray.join(", ")}, which is neither a screenshot nor ${CAPTURE_MANIFEST_FILE}; ` +
          "staging the folder would commit it. Remove it, then release again.",
      );
    }

    const listed = new Set(SETTINGS_WINDOW_TABS.map((tab) => tab.file));
    /** @type {Record<string, Uint8Array>} */
    const pngs = Object.fromEntries(
      entries.filter((name) => name.endsWith(".png")).map((name) => [name, fs.readFileSync(path.join(folder, name))]),
    );
    // The manifest lists the tabs' own PNGs; a stray one is left for the check
    // below to name rather than recorded as if a release had captured it.
    const manifest = buildCaptureManifest(
      version,
      Object.fromEntries(Object.entries(pngs).filter(([name]) => listed.has(name))),
    );
    fs.writeFileSync(path.join(folder, CAPTURE_MANIFEST_FILE), serializeCaptureManifest(manifest));

    const { releases } = parseChangelog(fs.readFileSync(path.join(root, CHANGELOG_SOURCE_PATH), "utf-8"));
    const newestReleased = releases.find((release) => release.date !== null)?.version;
    if (newestReleased === undefined) {
      return fail(
        `The release stopped: ${CHANGELOG_SOURCE_PATH} has no dated section to hold ${CAPTURE_MANIFEST_FILE} to.`,
      );
    }
    const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")).version;
    const findings = checkCaptureManifest({
      manifest,
      files: pngs,
      tabs: SETTINGS_WINDOW_TABS,
      newestReleased,
      packageVersion,
    });
    if (findings.length > 0) {
      return fail(
        `The release stopped: ${folderRel}/ does not pass its ${CAPTURE_MANIFEST_FILE} check:`,
        ...findings.map(({ file, message }) => `  - ${file === undefined ? "" : `${file}: `}${message}`),
      );
    }

    // 7. Nothing else changed, then stage the folder.
    const unexpected = unexpectedTrackedChanges(before, snapshotTrackedChanges(root, { git, fs }), folderRel);
    if (unexpected.length > 0) {
      return fail(
        `The release stopped: the build changed tracked files outside ${folderRel}/, which release-it's commit would sweep in unseen:`,
        ...unexpected.map((line) => `  - ${line}`),
        "Commit or fix whatever generates them, then release again.",
      );
    }

    git(root, ["add", "--", folderRel]);
    log(`  Staged ${folderRel}/: ${written.length} screenshots at v${version} and ${CAPTURE_MANIFEST_FILE}`);

    return 0;
  }
}
