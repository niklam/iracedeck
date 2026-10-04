/**
 * Clears a native addon out of node-gyp's way before `node-gyp rebuild` /
 * `node-gyp clean`, for both `@iracedeck/iracing-native` and
 * `@iracedeck/audio-native` (#1258, spec
 * `docs/superpowers/specs/2026-10-03-issue-1258-native-build-locked-addon.md`).
 *
 * A running deck host's plugin process has the `.node` loaded, and Windows
 * refuses to delete a loaded image (`EPERM`; opening it for write is `EBUSY`)
 * but does let it be renamed or moved on the same volume — the process keeps
 * running the moved file and loads the new one on its next start. So instead
 * of letting node-gyp's clean step trip over the lock, the build deletes the
 * binary itself and, when that is refused, moves it into `<package>/.locked-native/`.
 * The rebuild then produces a fresh binary, which keeps turbo's cache honest:
 * a build that kept the old binary would exit green and cache it under the
 * new sources' hash.
 *
 * The aside folder lives inside the package rather than in the temp dir
 * because a move across volumes is a copy-and-delete, and the delete is
 * exactly what the lock refuses.
 */
import * as nodeFs from "node:fs";
import { basename, extname, join } from "node:path";

/** The `fs` error codes Windows gives for a file a running process has loaded. */
const LOCK_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Whether an `fs` error means the file is held by another process.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isLockError(error) {
  return LOCK_CODES.has(/** @type {NodeJS.ErrnoException} */ (error)?.code ?? "");
}

/**
 * The name a locked binary is moved aside under: `audio_native.<now>.node`.
 *
 * @param {string} addonPath
 * @param {number} now
 * @returns {string}
 */
export function asideName(addonPath, now) {
  const ext = extname(addonPath);
  return `${basename(addonPath, ext)}.${now}${ext}`;
}

/** The package-relative folder a locked binary is moved into; gitignored and `.sdignore`d. */
export const ASIDE_DIR_NAME = ".locked-native";

/**
 * Deletes every earlier moved-aside copy that is no longer loaded, and the
 * folder itself once it is empty. A copy still held is left for a later run.
 *
 * Housekeeping only, so it never throws: a failure that is not a lock (an
 * unreadable folder, a stray entry that will not delete) is returned as
 * `problem` for the caller to report, and the build goes on.
 *
 * @param {string} asideDir
 * @param {typeof nodeFs} fs
 * @returns {{ removed: number, kept: number, problem?: string }}
 */
export function sweepAside(asideDir, fs = nodeFs) {
  let entries;

  try {
    entries = fs.readdirSync(asideDir);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return { removed: 0, kept: 0 };
    return { removed: 0, kept: 0, problem: String(/** @type {Error} */ (error)?.message ?? error) };
  }

  let removed = 0;
  let kept = 0;
  let problem;

  for (const entry of entries) {
    try {
      fs.rmSync(join(asideDir, entry), { recursive: true, force: true });
      removed++;
    } catch (error) {
      kept++;
      if (!isLockError(error)) problem ??= String(/** @type {Error} */ (error)?.message ?? error);
    }
  }

  if (kept === 0) {
    try {
      fs.rmdirSync(asideDir);
    } catch {
      // An empty folder someone has open (Explorer, the indexer) is harmless;
      // the next sweep removes it.
    }
  }

  return problem === undefined ? { removed, kept } : { removed, kept, problem };
}

/**
 * Removes the addon binary so node-gyp can replace it, moving it aside when a
 * running process has it loaded. Any other failure is rethrown, and so is a
 * failed move, with the lock named.
 *
 * @param {{ addonPath: string, asideDir: string, fs?: typeof nodeFs, now?: () => number }} options
 * @returns {{ result: "absent" | "removed" } | { result: "moved", asidePath: string }}
 */
export function clearAddon({ addonPath, asideDir, fs = nodeFs, now = Date.now }) {
  try {
    fs.rmSync(addonPath);
    return { result: "removed" };
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return { result: "absent" };
    if (!isLockError(error)) throw error;
  }

  const asidePath = join(asideDir, asideName(addonPath, now()));

  try {
    fs.mkdirSync(asideDir, { recursive: true });
    fs.renameSync(addonPath, asidePath);
  } catch (error) {
    // A loaded image moves; one opened without delete sharing (a debugger, an
    // AV scan in progress) does not, and node-gyp cannot replace it either.
    throw new Error(
      `${basename(addonPath)} is held by another process and could not be moved aside to ${asidePath} ` +
        `(${/** @type {NodeJS.ErrnoException} */ (error)?.code ?? "unknown error"}). ` +
        `Stop the deck host using this tree (or whatever else has the file open) and build again.`,
      { cause: error },
    );
  }

  return { result: "moved", asidePath };
}

/**
 * The step both packages' `build.mjs` and `clean.mjs` run before node-gyp:
 * sweep the copies earlier runs moved aside, then clear the current binary,
 * saying what happened in terms of the lock.
 *
 * @param {{ addonPath: string, asideDir: string, log?: Pick<Console, "log" | "warn">, fs?: typeof nodeFs, now?: () => number }} options
 */
export function releaseNativeAddon({ addonPath, asideDir, log = console, fs = nodeFs, now = Date.now }) {
  const swept = sweepAside(asideDir, fs);

  if (swept.removed > 0) {
    log.log(`Removed ${swept.removed} released addon cop${swept.removed === 1 ? "y" : "ies"} from ${asideDir}.`);
  }

  if (swept.kept > 0) {
    log.log(
      `${swept.kept} addon cop${swept.kept === 1 ? "y" : "ies"} in ${asideDir} still loaded by a running process; a later build removes ${swept.kept === 1 ? "it" : "them"}.`,
    );
  }

  if (swept.problem !== undefined) {
    log.warn(`Could not clean up ${asideDir} (${swept.problem}); carrying on with the build.`);
  }

  const cleared = clearAddon({ addonPath, asideDir, fs, now });

  if (cleared.result === "moved") {
    log.warn(
      `${basename(addonPath)} is loaded by a running process (usually a deck host's plugin). ` +
        `Moved it to ${cleared.asidePath} out of node-gyp's way; ` +
        `the running process keeps the old code until it restarts.`,
    );
  }

  return { swept, cleared };
}

/**
 * {@link releaseNativeAddon} for a native package laid out the way both of
 * ours are: the binary at `build/Release/<addonFile>`, the aside folder at
 * `<package>/.locked-native/`.
 *
 * @param {string} packageDir
 * @param {string} addonFile e.g. `"iracing_native.node"`
 */
export function releasePackageAddon(packageDir, addonFile) {
  return releaseNativeAddon({
    addonPath: join(packageDir, "build", "Release", addonFile),
    asideDir: join(packageDir, ASIDE_DIR_NAME),
  });
}
