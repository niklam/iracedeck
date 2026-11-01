/**
 * PostToolUse rules — pure mappings from "what just happened" to "what runs
 * next" or "what the model must be told". The entry points in
 * `post-edit.mjs` / `post-bash.mjs` execute them.
 */

/**
 * Generators whose committed output a freshness test guards. Editing the
 * source without regenerating fails the build later; running the generator
 * right after the edit removes the step.
 *
 * `rel` is the edited file's path relative to the repo root, forward slashes.
 * Every command runs at the repo root.
 */
export const GENERATORS = [
  {
    // Not committed since #1386 (a turbo task builds it), so no freshness test
    // guards it. It still runs on every edit of either source: composing is
    // what validates a fragment, so a bad one fails at authoring time rather
    // than at the next build, and the local copy a watcher serves stays current.
    // Its output is gitignored, so `git status` cannot see whether it changed:
    // `outputIgnored` makes the report say only that it ran and passed.
    label: "changelog data (What's New pane)",
    match: (rel) =>
      rel === "packages/website/src/content/docs/changelog.mdx" ||
      (/^changelog\.d\/[^/]+\.md$/.test(rel) && rel !== "changelog.d/README.md"),
    cmd: "node",
    args: ["scripts/generate-changelog-data.mjs"],
    outputIgnored: true,
  },
  {
    label: "getting-started data (first-run page)",
    match: (rel) => /^packages\/website\/src\/content\/docs\/docs\/getting-started\/first-steps\.md$/.test(rel),
    cmd: "node",
    args: ["scripts/generate-getting-started-data.mjs"],
  },
  {
    label: "icon previews",
    match: (rel) => /^packages\/icons\/(?!preview\/).+\.svg$/.test(rel),
    cmd: "node",
    args: ["scripts/generate-icon-previews.mjs"],
  },
  {
    label: "icon defaults (PI colour/border defaults)",
    match: (rel) =>
      /^packages\/icons\/(?!preview\/).+\.svg$/.test(rel) || /^packages\/iracing-actions\/icons\/.+\.svg$/.test(rel),
    cmd: "node",
    args: ["scripts/generate-icon-defaults.mjs"],
  },
  {
    label: "action comms catalog",
    match: (rel) => rel === "packages/iracing-actions/src/actions/comms-catalog.ts",
    cmd: "pnpm",
    args: ["generate:action-comms"],
  },
  {
    label: "action profiles (from the Elgato manifest)",
    match: (rel) => /^packages\/iracing-plugin-stream-deck\/.*\/manifest\.json$/.test(rel),
    cmd: "pnpm",
    args: ["generate:action-profiles"],
  },
  {
    label: "callout scripts (from the voice configs)",
    match: (rel) => /^packages\/audio-assets\/configs\/.+\.voice\.json$/.test(rel),
    cmd: "pnpm",
    args: ["generate:callout-scripts"],
  },
];

export function generatorsFor(rel) {
  return GENERATORS.filter((g) => g.match(rel));
}

/**
 * The line `post-edit.mjs` reports for one generator run: `result` is
 * `run()`'s `{ ok, out, err }`, `changed` the `git status --porcelain` lines
 * that appeared during it. A generator whose output is gitignored
 * (`outputIgnored`) is reported as run and passed, never as "already fresh":
 * `git status` cannot see its output, so an empty `changed` says nothing.
 */
export function generatorReport(g, result, changed) {
  const command = [g.cmd, ...g.args].join(" ");
  if (!result.ok) return `${g.label} FAILED (${command}):\n${(result.err || result.out).trim().slice(-1500)}`;
  if (g.outputIgnored) return `Ran ${g.label} (${command}); it passed (its output is gitignored, so not listed).`;
  return `Ran ${g.label} (${command})${changed.length ? `; it changed: ${changed.map((l) => l.slice(3)).join(", ")}` : "; output already fresh"}.`;
}

/** Edits that need a human step the tooling cannot take for them. */
export const REMINDERS = [
  {
    match: (rel) => rel === "packages/settings/src/global-settings.ts",
    text: "GlobalSettingsSchema touched: turbo caches settings and the packages built against it, so run `pnpm build:force` (not `pnpm build --force`, which forwards nothing).",
  },
  {
    match: (rel) =>
      /^packages\/audio-scenarios\/src\/catalog\/.+\.ts$/.test(rel) ||
      /^packages\/audio-assets\/voice\/default\/callouts\.json$/.test(rel),
    text: "Catalog or bundled script touched: `pnpm generate:pack-reference` needs the BUILT audio-scenarios dist, so run it after `pnpm build` — the freshness test on pack-reference.json fails otherwise.",
  },
  {
    match: (rel) => /^\.claude\/rules\/.+\.md$/.test(rel) || /(^|\/)CLAUDE\.md$/.test(rel),
    text: "Rules/CLAUDE.md edited: this prose is written for Claude and needs no draft approval, but the always-loaded set has a hard budget — when a file without `paths` frontmatter grew, check the headroom `scripts/claude-rules-frontmatter.test.mjs` logs (`--reporter=verbose`).",
  },
];

export function remindersFor(rel) {
  return REMINDERS.filter((r) => r.match(rel)).map((r) => r.text);
}

/** The four CI workflows every push to master must run. */
export const CI_WORKFLOWS = ["Format", "Lint", "Tests", "Typecheck"];

/** Which of the four workflows are missing from a `gh run list` result. */
export function missingWorkflows(runs) {
  const names = new Set((runs ?? []).map((r) => r.workflowName ?? r.name));
  return CI_WORKFLOWS.filter((w) => !names.has(w));
}

/**
 * The repository the Roadmap board tracks (#1527). A board card is found by
 * issue number alone, so an issue, PR or worktree of any other repository
 * would move the iRaceDeck card that shares its number: the post-hook acts
 * on this one only.
 */
export const HOME_REPO = "niklam/iracedeck";

/** Whether `slug` (`owner/repo`) is {@link HOME_REPO}; GitHub's names are case-insensitive. */
export const isHomeRepo = (slug) => typeof slug === "string" && slug.toLowerCase() === HOME_REPO;

/** `owner/repo` of a github.com issue or pull request URL, or `undefined`. */
export function repoOfUrl(url) {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/\d+/i.exec(String(url ?? ""));
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * The issues a command's output may have created: `{ url, repo, number }` for
 * every line that is an issue URL and nothing else, which is how
 * `gh issue create` prints one, in output order, each once. A URL with a
 * fragment (`gh issue comment` prints `…/issues/5#issuecomment-…`) or inside a
 * sentence (`gh issue view`) is not one: the first URL anywhere in a chain's
 * output once moved the card of the issue a comment went to (#1527).
 */
export function createdIssues(stdout) {
  const seen = new Map();
  for (const m of String(stdout ?? "").matchAll(
    /^[ \t]*https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)\/issues\/(\d+)\/?[ \t]*\r?$/gm,
  )) {
    const url = `https://github.com/${m[1]}/${m[2]}/issues/${m[3]}`;
    if (!seen.has(url)) seen.set(url, { url, repo: `${m[1]}/${m[2]}`, number: Number(m[3]) });
  }
  return [...seen.values()];
}

/** How recent an issue must be to count as just created. */
export const JUST_CREATED_MS = 10 * 60_000;

/**
 * Which of `found` ({@link createdIssues}) the command created: those `ageOf`
 * (ms since GitHub created it, or `undefined` when it cannot tell) puts within
 * {@link JUST_CREATED_MS}. Every one is checked, however many creates the
 * command ran: another command prints a bare issue URL too (`gh issue edit`,
 * `gh issue view --jq .url`) while a create may print none (`--web`, or one that
 * failed), so a count can pair a create with another issue's URL. `unsure`
 * lists those whose age could not be read, so the caller can name them instead
 * of guessing.
 */
export function pickCreated(found, ageOf) {
  const picked = [];
  const unsure = [];
  for (const issue of found) {
    const age = ageOf(issue);
    if (age === undefined) unsure.push(issue);
    else if (age < JUST_CREATED_MS) picked.push(issue);
  }
  return { picked, unsure };
}

/**
 * The `GH_REPO` that reaches a command: the caller passes the text ahead of
 * the command, and its masked twin (`trustedMask`, same length) so an
 * assignment inside a quoted body is not one. Counted are a prefix of the
 * command's own simple command (`GH_REPO=o/r gh pr merge 7`, `env GH_REPO=…`)
 * and an environment write earlier in the chain (`export GH_REPO=…`,
 * `declare -x` / `typeset -x`, PowerShell's `$env:GH_REPO = …` in any case);
 * an assignment ahead of a bare `export GH_REPO` is exported by it. A prefix
 * of another command or an assignment never exported does not reach it. The
 * value of the last one that does, read from the raw text: `null` when it is
 * not a plain value, or when an export names a value the hook cannot place;
 * `undefined` when none reaches the command.
 */
export function assignedGhRepo(command, masked = command) {
  const raw = String(command ?? "");
  const text = String(masked ?? "");
  const ownStart = Math.max(...[";", "&", "|", "\n", "(", ")"].map((c) => text.lastIndexOf(c))) + 1;
  const bareExports = [...text.matchAll(/\b(?:export|(?:declare|typeset)\s+-x)\s+GH_REPO\b(?!\s*=)/g)];
  const exportedUpTo = bareExports.length ? bareExports.at(-1).index : -1;
  // Keyed by where the value starts, so `$env:GH_REPO=` matched by both forms counts once.
  const assignments = new Map();
  for (const m of text.matchAll(/(\bexport\s+|\b(?:declare|typeset)\s+-x\s+)?\bGH_REPO\s*=\s*/g))
    assignments.set(m.index + m[0].length, { at: m.index, exported: !!m[1] });
  for (const m of text.matchAll(/\$env:gh_repo\s*=\s*/gi))
    assignments.set(m.index + m[0].length, { at: m.index, exported: true });
  const reaching = [...assignments]
    .filter(([, a]) => a.exported || a.at >= ownStart || a.at < exportedUpTo)
    .sort(([x], [y]) => x - y);
  if (!reaching.length) return exportedUpTo >= 0 ? null : undefined;
  return plainValueAt(raw, reaching.at(-1)[0]);
}

/**
 * The plain value starting at `at` in `raw` — a bare word or a quote that
 * expands nothing, ending the word — or `null`. A value that runs on into an
 * expansion or another quote (`niklam/iracedeck$SUFFIX`) is not plain: its
 * literal prefix is not what the shell passes.
 */
function plainValueAt(raw, at) {
  const value = /'([^']*)'|"([^"$`\\]*)"|([^\s;&|()'"`$]+)/y;
  value.lastIndex = at;
  const m = value.exec(raw);
  if (!m || !/^(?:[\s;&|()]|$)/.test(raw.slice(value.lastIndex))) return null;
  return m[1] ?? m[2] ?? m[3];
}

/**
 * `owner/repo` for a repository named the way gh takes one:
 * `[HOST/]OWNER/REPO`, a URL or an ssh remote (`git@github.com:o/r.git`). A
 * host other than github.com is kept, so it can never be home.
 */
export function normalizeRepo(named) {
  const parts = named
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .split("/");
  return parts.length === 3 && parts[0].toLowerCase() === "github.com" ? `${parts[1]}/${parts[2]}` : parts.join("/");
}

/**
 * The repository a `gh pr merge` names, in gh's order: a PR URL, then
 * `--repo` / `-R` (`merge.repo` from `parseMerge`), then a `GH_REPO` the
 * command assigns ({@link normalizeRepo}). `null` when one is named but not
 * readable; `undefined` when none is, and gh resolves the checkout's own.
 */
export function mergeRepo(merge, envRepo) {
  const fromUrl = repoOfUrl(merge.ref);
  if (fromUrl) return fromUrl;
  const named = merge.repo !== undefined ? merge.repo : envRepo;
  return named == null ? named : normalizeRepo(named);
}

/**
 * The repository each `gh issue create` in a command targets, in order: its
 * own `--repo` / `-R`, else a `GH_REPO` that reaches it ({@link assignedGhRepo}),
 * normalised ({@link normalizeRepo}). `null` when one is named but not
 * readable; `undefined` when none is, and gh uses the checkout's own. Read in
 * the masked text (`trustedMask`, same length) so a flag inside a quoted body is
 * not the create's; values are read from the raw text. A create that prints no
 * URL (`--web`) is judged by this alone (#1527).
 */
export function issueCreateRepos(command, masked = command) {
  const raw = String(command ?? "");
  const text = String(masked ?? "");
  return [...text.matchAll(/\bgh\s+issue\s+create\b/g)].map((m) => {
    const start = m.index + m[0].length;
    const stop = text.slice(start).search(/[;&|\n)]/);
    const end = stop < 0 ? text.length : start + stop;
    const flags = [...text.slice(start, end).matchAll(/(?:^|\s)(?:-R|--repo)(?:=|\s+)?(?=\S)/g)];
    const named = flags.length
      ? plainValueAt(raw, start + flags.at(-1).index + flags.at(-1)[0].length)
      : assignedGhRepo(raw.slice(0, m.index), text.slice(0, m.index));
    return named == null ? named : normalizeRepo(named);
  });
}

/**
 * Whether a parsed `gh issue edit` (`issueEdits`) may set a milestone (#1574):
 * a `--milestone` whose value is not empty — or is not readable, which the
 * read-back then settles — and no `--remove-milestone`. An edit the hook could
 * not read whole counts when a milestone flag appears anywhere in its text
 * (`namesMilestone`), so its caller says to move the cards by hand rather than
 * nothing. Removing one never moves a card back.
 */
export function setsMilestone(edit) {
  if (edit.removesMilestone) return false;
  if (edit.milestone !== undefined) return edit.milestone !== "";
  return !edit.readable && !!edit.namesMilestone;
}

/**
 * The line for a `gh issue edit --remove-milestone` (#1574): a card stays in
 * its lane when its milestone goes, and moving it back is Niklas's, since the
 * helpers refuse a backwards move and a raw lane edit is denied. Named are the
 * issues that may be iRaceDeck's ({@link editTargets}), with nothing read
 * back; `undefined` when every issue is known to be another repository's —
 * the ones the hook could not read too, when the edit's own `--repo` or
 * `GH_REPO` names another repository.
 */
export function milestoneRemovedLine(edit, envRepo) {
  const targets = editTargets(edit, envRepo);
  const maybeHome = targets.filter(({ repo }) => repo == null || isHomeRepo(repo));
  const named = edit.repo !== undefined ? edit.repo : envRepo;
  const elsewhere = named != null && !isHomeRepo(normalizeRepo(named));
  const unread = !edit.readable || !targets.length;
  if (!maybeHome.length && (!unread || elsewhere)) return undefined;
  const which = maybeHome.length
    ? maybeHome.map(({ ref }) => (repoOfUrl(ref) ? ref : `#${ref}`)).join(", ")
    : "the issues it edited";
  return `gh issue edit removed the milestone of ${which}: a card stays in its lane when its milestone goes, and moving it back to Backlog is Niklas's, in the board UI.`;
}

/**
 * The issues a `gh issue edit` names, each `{ ref, repo }` with the repository
 * gh resolves it in: an issue URL's own, else the edit's `--repo` / `-R`, else
 * a `GH_REPO` that reaches it (`envRepo`, {@link assignedGhRepo}), normalised
 * ({@link normalizeRepo}). `repo` is `null` when one is named but not readable,
 * `undefined` when none is and gh uses the checkout's own.
 */
export function editTargets(edit, envRepo) {
  const named = edit.repo !== undefined ? edit.repo : envRepo;
  const repo = named == null ? named : normalizeRepo(named);
  return edit.issues.map((ref) => ({ ref, repo: repoOfUrl(ref) ?? repo }));
}

/** The number of a github.com issue URL, or `undefined`. */
export function issueNumberOfUrl(url) {
  const m = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/i.exec(String(url ?? ""));
  return m ? Number(m[1]) : undefined;
}

/**
 * The cards a merged PR moves: its closing issues in {@link HOME_REPO}, or
 * when it has none the `(#n)` its title ends with (the PR title rule).
 * `foreign` names the closing issues elsewhere (`Fixes other/repo#5`), whose
 * numbers are not cards here.
 */
export function boardIssues(pr) {
  const issues = [];
  const foreign = [];
  for (const i of pr.closingIssuesReferences ?? []) {
    const repo = repoOfUrl(i.url) ?? (i.repository ? `${i.repository.owner?.login}/${i.repository.name}` : undefined);
    if (isHomeRepo(repo)) issues.push(i.number);
    else foreign.push(`${repo ?? "an unknown repository"}#${i.number}`);
  }
  const fromTitle = (pr.title ?? "").match(/\(#(\d+)\)\s*$/);
  if (issues.length === 0 && fromTitle) issues.push(Number(fromTitle[1]));
  return { issues, foreign };
}
