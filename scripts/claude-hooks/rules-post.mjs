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

/** The issue `gh issue create` printed: `{ url, repo, number }`, or `undefined` when it printed none. */
export function createdIssue(stdout) {
  const m = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/.exec(String(stdout ?? ""));
  return m ? { url: m[0], repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : undefined;
}

/**
 * The `GH_REPO` a command assigns (`GH_REPO=o/r gh pr merge 7`, an `export`,
 * PowerShell's `$env:GH_REPO = 'o/r'`): the value of the last assignment,
 * `null` when it is not a plain value, `undefined` when the command sets none.
 * The caller passes the text ahead of the command it is for, and its masked
 * twin (`trustedMask`, same length) so an assignment inside a quoted body is
 * not one; the value itself is read from the raw text.
 */
export function assignedGhRepo(command, masked = command) {
  const raw = String(command ?? "");
  const assignments = [...String(masked ?? "").matchAll(/\bGH_REPO\s*=\s*/g)];
  if (!assignments.length) return undefined;
  const last = assignments.at(-1);
  const value = /'([^']*)'|"([^"$`\\]*)"|([^\s;&|()'"`$]+)/y;
  value.lastIndex = last.index + last[0].length;
  const m = value.exec(raw);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

/**
 * The repository a `gh pr merge` names, in gh's order: a PR URL, then
 * `--repo` / `-R` (`merge.repo` from `parseMerge`), then a `GH_REPO` the
 * command assigns. `[HOST/]OWNER/REPO` is read as gh reads it, so a host other
 * than github.com is kept and can never be home. `null` when one is named but
 * not readable; `undefined` when none is, and gh resolves the checkout's own.
 */
export function mergeRepo(merge, envRepo) {
  const fromUrl = repoOfUrl(merge.ref);
  if (fromUrl) return fromUrl;
  const named = merge.repo !== undefined ? merge.repo : envRepo;
  if (named == null) return named;
  const parts = named
    .replace(/^https?:\/\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .split("/");
  return parts.length === 3 && parts[0].toLowerCase() === "github.com" ? `${parts[1]}/${parts[2]}` : parts.join("/");
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
