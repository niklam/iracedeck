---
paths:
  - "turbo.json"
  - "package.json"
  - "scripts/generate-changelog-data.mjs"
  - "scripts/install-runtime-deps.mjs"
  - "tsconfig*.json"
  - "packages/*/tsconfig*.json"
  - "scripts/lib/**"
  - "scripts/turbo-inputs*"
  - "scripts/prune-turbo-cache*"
  - "packages/*/package.json"
  - "packages/plugin-build/src/**"
  - "packages/audio-assets/src/build/**"
  - ".github/workflows/**"
---

# Turbo's cache: task inputs and CI

What turbo hashes and how CI reuses its cache, for whoever edits `turbo.json`, a package's build inputs, the plugin build's copy step, `scripts/turbo-inputs.test.mjs` or the workflows. Moved out of `@.claude/rules/build-and-commit.md` in #1501 to keep the always-loaded set inside its budget.

## Task inputs (#1491)

A turbo task is a cache hit while its declared inputs are unchanged, so a file it reads but does not declare gets a stale output and nothing goes red (#1491). By default turbo hashes only the git-tracked files of the task's own package. Anything else a build reads must be named in `turbo.json`: a file every task reads goes in `globalDependencies` (`tsconfig.base.json`), anything else in that task's `inputs` as `$TURBO_ROOT$/…`, and an environment variable in its `env`. A per-package override (`@iracedeck/x#build`) replaces the generic task rather than merging with it, and an `inputs` list without `$TURBO_DEFAULT$` hashes only what it names, which is how `audio-assets#build` once dropped `sfx/` and its catalog. `scripts/turbo-inputs.test.mjs` checks tsconfig `extends`, the imports reachable from what a task runs or compiles (an `allowJs` test importing a root `scripts/lib/` helper counts), narrowed inputs against the package's `exports`, and the folders and files the plugin build copies. Those checks rest on the test's own model of turbo's hashing, so since #1503 it also checks the model against `turbo run build typecheck --dry=json` (the task graph, each resolved definition and the files each task hashes, both ways) and pins the turbo version it was verified on, `MODELLED_TURBO_VERSION`: a turbo bump fails it until the model is re-verified and the constant moved, together with `turbo.json`'s `$schema` URL. Deliberately not hashed: `.nvmrc` (the native addons are N-API, so their binaries do not depend on the Node version), the transitive versions the plugins' `bin/` npm install resolves at build time, and the three Visual Studio variables in `globalPassThroughEnv` (`VCINSTALLDIR`, `VSCMD_VER`, `WindowsSDKVersion`), which the release build sets so node-gyp skips its 100-second Visual Studio search (#1513): they say which Visual Studio compiles, not what it builds, and the addons are N-API, so a binary from another toolset works the same. They are usually unset in a local build; from a Visual Studio developer prompt they are set, and node-gyp then uses that prompt's Visual Studio and no other, so a prompt for one it cannot use (VS 2017 under Node 22 or later) fails the native builds where a plain shell would have found a newer Visual Studio.

## CI keeps turbo's cache (#1492)

Only a push to `master` or `release/*` saves turbo's cache in CI, and only a PR run reads it. The push run restores nothing and only writes (`TURBO_CACHE=local:w`), so the post-merge run stays a full build of the merged tree, then `ci-test.yml` and `ci-typecheck.yml` save `.turbo/cache` with `actions/cache`, checked first by `scripts/prune-turbo-cache.mjs` against the run's summary. A PR run restores the newest of those and only reads (`local:r`), so only what the PR changed rebuilds. PR runs save nothing: GitHub would restore a PR's own cache before its base branch's, so a PR rebased onto a newer `master` would keep its stale one, and PR entries would crowd `master`'s out of the 10 GB. So a missing input is now a green PR check that tested the old build: `scripts/turbo-inputs.test.mjs` is what stops it, and a stale hit that slips past shows red on `master` after the merge. The tests run in three shards (`Test shard <n>/3`) behind one job named `Run tests`, the check the `Protect master` ruleset requires; its `if: always()` is what keeps a red or cancelled shard from leaving it skipped, which GitHub counts as passing.
