---
paths:
  - "package.json"
  - "packages/*/package.json"
  - "pnpm-workspace.yaml"
  - "pnpm-lock.yaml"
  - ".npmrc"
  - ".github/dependabot.yml"
  - ".github/workflows/**"
---

# pnpm and dependencies

The pinned pnpm version, its settings and the dependency build-script decisions, for whoever adds or bumps a dependency or touches a workflow's pnpm setup. The summary is under *Build* in `@.claude/rules/build-and-commit.md`; this file was moved out of it in #1658 to keep the always-loaded set inside its budget.

## Dependency build scripts

pnpm runs no dependency's `preinstall` / `install` / `postinstall` unless the package is named, so every dependency that has one is an explicit decision in `allowBuilds` in `pnpm-workspace.yaml` (#1176, #1245). Since pnpm 11 an undeclared one fails the install with `ERR_PNPM_IGNORED_BUILDS` rather than printing a notice, so a new dependency with a script is decided in the same change that adds it — and a Dependabot bump that pulls one in stays red until the entry is added on its branch. `true` is for a script something here needs: `ffmpeg-static`, whose install downloads the ffmpeg binary the voice-clip radio pipeline runs. `false` declines the rest, and each entry has a reason:

- `esbuild` (via `tsx`, `vite`): the script only re-fetches the platform binary when the optional `@esbuild/<platform>` package is missing, which pnpm installs, and swaps the JS shim for the binary off Windows, a speed-up nothing relies on.
- `protobufjs` (via `firebase-tools`): the script only prints a version-scheme advisory.
- `re2` (via `firebase-tools` → `superstatic`, an optional dependency): a native `node-gyp` build. `superstatic` falls back to `RegExp` without it, it is only used by `firebase serve` / the emulators, and `firebase.json` has no `regex` rules.

## The pnpm version and its settings

pnpm is pinned to one exact version (12.6.0 since #1245): `packageManager` in the root and the five packages that carry one, and `version` in the six workflows that run `pnpm/action-setup` on the commit they were triggered for. Move them together — the action refuses a `version` that differs from the root `packageManager` — and let `pnpm install` rewrite the lockfile, which records the pnpm version too. The seventh, `firebase-hosting-release.yml`, reads the pin from the ref it checked out instead: a voice-pack publish runs it from `master` against the latest stable tag, which may pin an older pnpm. Every workflow passes `version` explicitly rather than letting the action read `packageManager` itself, because that path once corrupted the lockfile (#386). A pnpm 10 or later on PATH switches to the pinned version by itself.

Since pnpm 11 every pnpm setting lives in `pnpm-workspace.yaml`. The `pnpm` field of `package.json` is not read, and `.npmrc` is read for auth and registry keys only — a setting put in either is dropped without a word, which is how `save-exact` would have stopped applying. The reverse holds too: pnpm 12 fails every command on a key it does not recognise in `pnpm-workspace.yaml` (`ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS`), so a misspelling is caught. Two settings there are decisions rather than housekeeping:

- `saveExact: true` — `pnpm add` writes exact versions (`@.claude/rules/code-style.md`).
- `minimumReleaseAge: 1440` — pnpm's own default, written out and kept written out (never drop it as redundant): a version published less than a day ago does not resolve, so a compromised release has a day to be caught before it can land here. The cost is that a fix published today cannot be installed until tomorrow. When one cannot wait, name that package under `minimumReleaseAgeExclude` in the same change and drop the entry once the version is a day old — never lower the age itself. A one-off command-line override is no way round it: the lockfile is checked against the policy on every install, CI's frozen one included. Dependabot's `cooldown` in `.github/dependabot.yml` is set to the same day, so its version bumps pass that check; change the two together. Its security updates skip the cooldown, so one for a version under a day old waits a day or takes an exclusion as above.

Two more pnpm 11 defaults change what an everyday command does, and are left at their defaults:

- `verifyDepsBeforeRun: install` — `pnpm build`, `pnpm test` or `pnpm exec` in a tree whose dependencies are out of date (after a rebase, a manifest edit, or a change to `pnpm-workspace.yaml`) runs `pnpm install` first. The install → build order in the pre-commit checks still stands; this only means a skipped install no longer goes unnoticed.
- `blockExoticSubdeps: true` — a transitive dependency resolved from git or a tarball URL fails the install. The lockfile has none.
