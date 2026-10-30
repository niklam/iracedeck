/**
 * The pre-commit format step (#1402): ESLint `--fix` and Prettier on the files
 * a commit records, written back to exactly those paths. Run by the husky
 * pre-commit hook in place of lint-staged.
 *
 * Why not lint-staged: several agents work in one worktree, and lint-staged
 * looks at the whole tree. After its tasks it diffed every unstaged change
 * against a snapshot taken before them and `git add`ed each path that moved,
 * so a file a sibling saved while the hook ran rode into this commit, even
 * under `git commit --only -- <paths>`. When a task failed it reset the tree
 * to HEAD and re-applied a stash taken before the tasks, which threw that
 * sibling's save away. This step never stashes, resets or diffs the tree.
 *
 * How it stays on its own files:
 * - It formats the INDEX blob in memory, never the working copy, so what is
 *   formatted is what the commit records, and a partially staged file keeps
 *   its unstaged edit.
 * - It writes the result only to the paths it formatted: the index git is
 *   committing (`GIT_INDEX_FILE`, inherited by every git child), plus the
 *   default `index.lock` under `commit --only`, whose temporary
 *   `next-index-<pid>.lock` is thrown away after the commit.
 * - It writes the working copy only when, checked just before the write, that
 *   still holds exactly the staged blob: the file is not partially staged and
 *   nobody saved it during the hook. A save landing between that check and the
 *   write (one git process apart) is overwritten; a file has no atomic
 *   compare-and-swap, and lint-staged overwrote it with no check at all.
 * - It formats every file before writing anything, so a formatter error ends
 *   the commit with the index and the tree as they were.
 *
 * `STAGED_TASKS` is the one statement of which extensions get which tool;
 * `scripts/lint-format-coverage.test.mjs` compares it with the `lint` and
 * `format` gates.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import url from "node:url";

/** What each staged file gets, by extension, in order. */
export const STAGED_TASKS = Object.freeze([
  Object.freeze({ extensions: Object.freeze(["ts", "mjs"]), tools: Object.freeze(["eslint", "prettier"]) }),
  Object.freeze({ extensions: Object.freeze(["json"]), tools: Object.freeze(["prettier"]) }),
]);

// Regular files only: a symlink's blob is its target path, a submodule's entry is a commit.
const REGULAR_MODES = new Set(["100644", "100755"]);

/** The tools `STAGED_TASKS` runs on `file`, or null when it covers none. */
export function toolsFor(file) {
  const extension = path.posix.extname(file).slice(1);

  return STAGED_TASKS.find((task) => task.extensions.includes(extension))?.tools ?? null;
}

/**
 * The entries of `git diff --raw -z --no-renames`, one per path:
 * `:<srcMode> <dstMode> <srcSha> <dstSha> <status>\0<path>\0`.
 */
export function parseRawDiff(output) {
  const tokens = output.split("\0");
  const entries = [];

  for (let i = 0; i < tokens.length - 1;) {
    const header = tokens[i++];

    if (!header.startsWith(":")) throw new Error(`unexpected git diff --raw output: ${JSON.stringify(header)}`);

    const [srcMode, dstMode, srcSha, dstSha, status] = header.slice(1).split(" ");

    // A rename or copy carries two paths; --no-renames keeps them out, but read them right if one arrives.
    if (status.startsWith("R") || status.startsWith("C")) i++;

    entries.push({ srcMode, dstMode, srcSha, dstSha, status: status[0], path: tokens[i++] });
  }

  return entries;
}

/** Whether two paths name the same file: resolved, and case-blind on Windows. */
export function samePath(a, b, platform = process.platform) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const normal = (p) => (platform === "win32" ? api.resolve(p).toLowerCase() : api.resolve(p));

  return normal(a) === normal(b);
}

/**
 * Whether the index git commits is the temporary one of `git commit --only`
 * (`<gitdir>/next-index-<pid>.lock`). Git then commits that index but keeps
 * the default `index.lock` as the index afterwards, so a formatted blob has to
 * go into both, or the index after the commit still records the unformatted
 * one. A plain commit hands the hook `<gitdir>/index` (relative in a main
 * checkout), and `-a` / `-i` the default lock itself.
 */
export function isOnlyCommitIndex(activeIndex, defaultLock, platform = process.platform) {
  const api = platform === "win32" ? path.win32 : path.posix;

  return !samePath(activeIndex, defaultLock, platform) && /^next-index-\d+\.lock$/i.test(api.basename(activeIndex));
}

function git(args, { cwd, env, input }) {
  try {
    return execFileSync("git", args, { cwd, env, input, maxBuffer: 512 * 1024 * 1024, stdio: "pipe" });
  } catch (error) {
    const stderr = error.stderr?.toString().trim();

    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, { cause: error });
  }
}

/** The blobs for `shas`, read in one `git cat-file --batch`. */
function readBlobs(shas, run) {
  const unique = [...new Set(shas)];
  const output = run(["cat-file", "--batch"], { input: unique.map((sha) => `${sha}\n`).join("") });
  const blobs = new Map();
  let offset = 0;

  for (const sha of unique) {
    const newline = output.indexOf(0x0a, offset);
    const [, type, size] = output.subarray(offset, newline).toString("utf8").split(" ");

    if (type !== "blob") throw new Error(`git cat-file: ${sha} is not a blob`);

    const start = newline + 1;
    const end = start + Number(size);

    blobs.set(sha, output.subarray(start, end));
    offset = end + 1;
  }

  return blobs;
}

/**
 * Formats the staged files and writes the result back. Resolves to the exit
 * code: 0 to let the commit go ahead, 1 to refuse it.
 *
 * `createFormatter(repoRoot)` is called once, and only when a staged file
 * needs formatting. The formatter it returns takes `{ path, text, tools }[]`
 * and resolves to `{ outputs: string[], failure: string | null }`: one output
 * per file in the same order, and a printable report when any file cannot be
 * formatted (which refuses the commit with nothing written).
 */
export async function formatStaged({
  cwd = process.cwd(),
  env = process.env,
  createFormatter = createRepoFormatter,
  log = (line) => console.log(line),
  logError = (line) => console.error(line),
} = {}) {
  const top = git(["rev-parse", "--show-toplevel"], { cwd, env }).toString("utf8").trim();
  const run = (args, options = {}) => git(args, { cwd: top, env, ...options });

  // Every change the commit records, so the empty-commit check below sees the files no task covers too.
  const staged = parseRawDiff(
    run(["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-color"]).toString(
      "utf8",
    ),
  );
  const covered = staged
    .filter((entry) => "AMT".includes(entry.status) && REGULAR_MODES.has(entry.dstMode))
    .map((entry) => ({ ...entry, tools: toolsFor(entry.path) }))
    .filter((entry) => entry.tools);

  if (!covered.length) return 0;

  const blobs = readBlobs(
    covered.map((entry) => entry.dstSha),
    run,
  );
  const files = [];
  const undecodable = [];

  for (const entry of covered) {
    const bytes = blobs.get(entry.dstSha);
    const text = bytes.toString("utf8");

    if (!Buffer.from(text, "utf8").equals(bytes)) undecodable.push(entry.path);
    files.push({ path: entry.path, text, tools: entry.tools });
  }

  if (undecodable.length) {
    return refuse(logError, `These staged files are not valid UTF-8:\n${undecodable.map((p) => `  ${p}`).join("\n")}`);
  }

  let result;

  try {
    result = await createFormatter(top)(files);
  } catch (error) {
    return refuse(logError, `The formatter failed: ${error?.stack ?? error}`);
  }

  if (result.failure) return refuse(logError, result.failure);

  if (result.outputs?.length !== files.length) {
    throw new Error(`the formatter returned ${result.outputs?.length} outputs for ${files.length} files`);
  }

  // Store each changed output as `git add` would: the path's attributes (eol) apply to it.
  const changes = [];

  covered.forEach((entry, i) => {
    if (result.outputs[i] === files[i].text) return;

    const sha = run(["hash-object", "-w", "--stdin", `--path=${entry.path}`], { input: result.outputs[i] })
      .toString("utf8")
      .trim();

    if (sha !== entry.dstSha) changes.push({ ...entry, sha });
  });

  if (!changes.length) return 0;

  // Git decides "nothing to commit" before the hook runs, so without this it
  // records an empty commit (measured with git 2.56 in both the plain and the
  // --only form). A merge may legitimately record HEAD's tree.
  if (formattingEmptiesCommit(staged, changes) && !mergeInProgress(run)) {
    return refuse(
      logError,
      [
        "Formatting reverts every staged change to what HEAD has. Nothing was staged or rewritten.",
        "Unstage the change, or, if you meant to amend only the message or to allow an empty commit, commit with --no-verify",
        "(a hook cannot see git's options, so it cannot tell those apart from a commit that would record nothing).",
      ].join("\n"),
    );
  }

  const unsetIndex = { ...env };

  delete unsetIndex.GIT_INDEX_FILE;
  const defaultLock = run(["rev-parse", "--path-format=absolute", "--git-path", "index.lock"], { env: unsetIndex })
    .toString("utf8")
    .trim();
  const activeIndex = env.GIT_INDEX_FILE
    ? path.resolve(top, env.GIT_INDEX_FILE)
    : run(["rev-parse", "--path-format=absolute", "--git-path", "index"]).toString("utf8").trim();
  const indexInfo = changes.map((change) => `${change.dstMode} ${change.sha}\t${change.path}\0`).join("");

  run(["update-index", "-z", "--index-info"], { input: indexInfo });

  // The index the tree is checked out against is the one that outlives the commit.
  let lastingEnv = env;

  if (isOnlyCommitIndex(activeIndex, defaultLock) && isFile(defaultLock)) {
    lastingEnv = { ...env, GIT_INDEX_FILE: defaultLock };
    run(["update-index", "-z", "--index-info"], { input: indexInfo, env: lastingEnv });
  }

  const untouched = workingCopiesStillStaged(changes, top, run);

  if (untouched.length) {
    run(["checkout-index", "-f", "-u", "-z", "--stdin"], {
      input: untouched.map((change) => `${change.path}\0`).join(""),
      env: lastingEnv,
    });
  }

  for (const change of changes) {
    log(
      untouched.includes(change)
        ? `format-staged: formatted ${change.path}`
        : `format-staged: formatted the staged ${change.path}; its working copy differs from what was staged, so it was left as it is`,
    );
  }

  return 0;
}

function refuse(logError, message) {
  logError(`format-staged: commit refused.\n${message}`);

  return 1;
}

/** Whether, once formatted, every staged change is back to what HEAD has. */
function formattingEmptiesCommit(staged, changes) {
  const bySha = new Map(changes.map((change) => [change.path, change.sha]));

  return staged.every(
    (entry) => entry.status === "M" && entry.srcMode === entry.dstMode && bySha.get(entry.path) === entry.srcSha,
  );
}

function mergeInProgress(run) {
  try {
    run(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);

    return true;
  } catch {
    return false;
  }
}

function isFile(file) {
  try {
    const stat = lstatSync(file);

    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * The changes whose working copy still hashes to the blob that was staged:
 * not partially staged, and not saved by anyone since. Only these are
 * rewritten on disk.
 */
function workingCopiesStillStaged(changes, top, run) {
  const candidates = changes.filter((change) => isFile(path.join(top, change.path)));

  if (!candidates.length) return [];

  const shas = run(["hash-object", "--stdin-paths"], {
    input: candidates.map((change) => `${cQuote(change.path)}\n`).join(""),
  })
    .toString("utf8")
    .trim()
    .split("\n");

  return candidates.filter((change, i) => shas[i] === change.dstSha);
}

/**
 * `path` as a C-quoted line for `git hash-object --stdin-paths`, which unquotes
 * any line starting with `"` and dies on a bad one. Quoting every path reads
 * a name that starts with a quote, or holds a newline, as itself.
 */
export function cQuote(file) {
  const escapes = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" };

  return `"${file.replace(/[\\"\n\r\t]/g, (char) => escapes[char])}"`;
}

/**
 * The repository's own formatter: ESLint with fixes, then Prettier, the way
 * `eslint --fix` and `prettier --write` would on the file at that path. One
 * ESLint instance per run, and neither tool is loaded until a file needs it.
 */
export function createRepoFormatter(repoRoot) {
  // What the prettier CLI reads by default; the API reads nothing unless told.
  const ignorePath = [path.join(repoRoot, ".gitignore"), path.join(repoRoot, ".prettierignore")];
  let eslint;
  let prettier;

  return async function format(files) {
    const outputs = [];
    const lintFailures = [];
    const prettierFailures = [];

    for (const file of files) {
      const filePath = path.join(repoRoot, file.path);
      let text = file.text;

      if (file.tools.includes("eslint")) {
        eslint ??= new (await import("eslint")).ESLint({ cwd: repoRoot, fix: true });

        // Also true for a file no config block applies to: the CLI would lint nothing there either.
        if (!(await eslint.isPathIgnored(filePath))) {
          const [lintResult] = await eslint.lintText(text, { filePath });

          if (lintResult.errorCount > 0) lintFailures.push(lintResult);

          text = lintResult.output ?? text;
        }
      }

      if (file.tools.includes("prettier")) {
        prettier ??= (await import("prettier")).default;

        const info = await prettier.getFileInfo(filePath, { ignorePath });

        if (!info.ignored) {
          try {
            if (!info.inferredParser) throw new Error("no parser could be inferred");

            const options = await prettier.resolveConfig(filePath, { editorconfig: true });

            text = await prettier.format(text, { ...options, filepath: filePath });
          } catch (error) {
            prettierFailures.push(`${file.path}\n  ${String(error?.message ?? error).replaceAll("\n", "\n  ")}`);
          }
        }
      }

      outputs.push(text);
    }

    const reports = [];

    if (lintFailures.length) {
      reports.push(`ESLint:${(await eslint.loadFormatter("stylish")).format(lintFailures).trimEnd()}`);
    }

    if (prettierFailures.length) reports.push(`Prettier:\n${prettierFailures.join("\n")}`);

    return { outputs, failure: reports.length ? reports.join("\n\n") : null };
  };
}

// Node runs the main module from its real path (unless --preserve-symlinks-main),
// so compare real paths on both sides: through a junction or symlink a bare href
// comparison is false and the hook would pass having formatted nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(url.fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = await formatStaged();
  } catch (error) {
    console.error(`format-staged: commit refused.
${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
