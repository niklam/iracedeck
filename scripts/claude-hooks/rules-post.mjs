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
    label: "changelog data (What's New pane)",
    match: (rel) => rel === "packages/website/src/content/docs/changelog.mdx",
    cmd: "node",
    args: ["scripts/generate-changelog-data.mjs"],
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

/** Edits that need a human step the tooling cannot take for them. */
export const REMINDERS = [
  {
    match: (rel) => rel === "packages/deck-core/src/global-settings.ts",
    text: "GlobalSettingsSchema touched: turbo caches deck-core, so run `pnpm build:force` (not `pnpm build --force`, which forwards nothing) and update the literals in simhub-service.test.ts.",
  },
  {
    match: (rel) =>
      /^packages\/audio-scenarios\/src\/catalog\/.+\.ts$/.test(rel) ||
      /^packages\/audio-assets\/voice\/default\/callouts\.json$/.test(rel),
    text: "Catalog or bundled script touched: `pnpm generate:pack-reference` needs the BUILT audio-scenarios dist, so run it after `pnpm build` — the freshness test on pack-reference.json fails otherwise.",
  },
  {
    match: (rel) => /^\.claude\/rules\/.+\.md$/.test(rel) || /(^|\/)CLAUDE\.md$/.test(rel),
    text: "Rules/CLAUDE.md edited: this is prose Niklas must see in full before it becomes binding — show the drafted text in the final message.",
  },
];

export function remindersFor(rel) {
  return REMINDERS.filter((r) => r.match(rel)).map((r) => r.text);
}

/** Issue number named by an `ir-<n>` worktree path, or `undefined`. */
export function issueFromWorktreePath(p) {
  const m = String(p).match(/(?:^|[\\/])ir-(\d+)(?:[\\/]|$)/);
  return m ? Number(m[1]) : undefined;
}

/** The PR reference (`123`, or a URL) named on a `gh pr <verb>` command, or `undefined` for "current branch". */
export function prRefFrom(command, verb) {
  const idx = command.indexOf(`pr ${verb}`);
  if (idx < 0) return undefined;
  const rest = command.slice(idx + verb.length + 3);
  return rest.split(/\s+/).find((w) => w && !w.startsWith("-"));
}

/** The four CI workflows every push to master must run. */
export const CI_WORKFLOWS = ["Format", "Lint", "Tests", "Typecheck"];

/** Which of the four workflows are missing from a `gh run list` result. */
export function missingWorkflows(runs) {
  const names = new Set((runs ?? []).map((r) => r.workflowName ?? r.name));
  return CI_WORKFLOWS.filter((w) => !names.has(w));
}
