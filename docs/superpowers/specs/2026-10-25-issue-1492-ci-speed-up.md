# CI: a persisted turbo cache on PR runs, sharded tests, cancelled superseded runs

> **Issue:** [#1492](https://github.com/niklam/iracedeck/issues/1492) · **Depends on:** [#1491](https://github.com/niklam/iracedeck/issues/1491) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

The issue has the timings. In short, `Tests` takes about 4½ minutes: a 110 s build in which every turbo task misses, then 141 s of vitest in one job. `Typecheck` repeats the same build next to it. This spec settles three changes and records a fourth as a later option.

## 1. Persist turbo's cache, read it only on PR runs

### Decision

The `Tests` and `Typecheck` workflows keep turbo's local cache directory (`.turbo/cache`) with `actions/cache`. The trigger decides how turbo may use it:

- **`pull_request`: restore, read only** (`local:r`), save nothing. A PR that touches one package rebuilds that package and its dependents, and everything else is a hit.
- **`push` to `master` / `release/*`: restore nothing, write only** (`local:w`, which is what `--force` means), then save. Every task runs, so the post-merge check (#1070) stays a full build of the merged tree. The outputs are still saved, and that is what warms the next PR. GitHub lets a PR run restore caches saved on its base branch, while a cache saved by a PR run is visible only to re-runs of that PR. The master push therefore has to be the writer.

*Amended during implementation:* PR runs first read and wrote the cache and saved it too. The second read found that GitHub restores a PR's own cache before its base branch's, so a PR that had saved one kept restoring it after a rebase onto a newer `master`, and every task `master` had changed since missed. PR entries also spent the 10 GB on caches only that PR could use and could push `master`'s out. Saving on pushes alone means every PR run starts from the newest `master` cache.

The cache mode reaches turbo either through `TURBO_CACHE`, if turbo 2.11 reads it, or by `scripts/build.mjs` forwarding its arguments to `turbo run build`. The builder picks one, and either way a developer still gets the same command (`pnpm build`, `pnpm typecheck`) locally.

### Keys

- Key `turbo-<workflow>-<run_id>-<run_attempt>`, and restore keys `turbo-<workflow>-` (newest first). The key changes every run because a cache entry cannot be overwritten, so a fixed key would freeze the first one ever saved.
- One prefix per workflow, because `Tests` and `Typecheck` run at the same moment and would race to save the same key. `Typecheck` also lists `turbo-tests-` as a second restore key, since the Tests cache holds the same `build` outputs that `Typecheck` needs before it runs `tsc`.
- In the sharded `Tests` workflow (section 2), only shard 1 of a push run saves. Every shard of a PR run restores.

### The saved cache is pruned to this run

Turbo never evicts anything from its local cache, and a restored directory saved again only grows (the developer cache in the `master` checkout is 97 GB). Before saving, the job deletes every cache entry that this run neither read nor wrote. The hashes come from the run summary (`--summarize`, `.turbo/runs/*.json`). A saved entry is then one build's outputs: about 440 MB uncompressed in the `master` checkout (2026-10-25), most of it the three plugin folders and `audio-assets/.cache`. That leaves room for many entries under the repository's 10 GB cache limit, where GitHub evicts the least recently used.

### Why it waits for #1491

A cache hit is only correct if the task's declared inputs cover everything it reads. Today a missing input costs little: CI never hits the cache, and a stale hit on a developer machine ends in a confusing rebuild. With this change, a missing input becomes a green PR check that tested the old build. #1491 fixes the inputs first. It has already found one gap: 38 packages extend `tsconfig.base.json`, and `turbo.json` declares it nowhere. The uncached master push is the safety net for whatever #1491 misses, so a stale hit shows up red on `master` after the merge, never silently.

## 2. Shard vitest, keep the required check name

### Decision

`ci-test.yml` gets a `test` matrix over three shards. Each shard restores the cache, runs `pnpm build`, then runs `pnpm test --shard=<n>/3` (the root script keeps `--configLoader native`). Three is a starting point: vitest splits by file count, not by duration, so the builder checks the balance and may change it.

The `Protect master` ruleset requires a check named **`Run tests`**, and matrix jobs get suffixed names. So a separate job with that exact name `needs: test`, runs with **`if: always()`**, and fails unless `needs.test.result == 'success'`. The `if: always()` is the load-bearing part. Without it a failed or cancelled shard makes the aggregate job *skipped*, and GitHub treats a skipped required check as satisfied, so a red shard would merge. The shards themselves are named `Test shard <n>/3` so they are easy to tell from the gate.

Each shard builds rather than downloading one build job's output. On a warm PR run that is the shorter path: the restore and a mostly-cached build take about 30 s, against an extra job's setup, upload and download. On a master push each shard builds cold, about 110 s, and the run still beats today's: roughly 20 s setup + 110 s build + about 50 s of tests, against about 4½ minutes.

## 3. Cancel superseded PR runs, never push runs

All four CI workflows get:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

A new push to a PR cancels that PR's run still in progress. A push run gets a group of its own commit, which matters even with `cancel-in-progress` false: a concurrency group admits one running and one pending run, and a newer pending run cancels the older one. If push runs shared a group per branch, two quick merges would cancel one merge's post-merge check, and step 12 of `issue-workflow.md` exists to see every one of those.

A cancelled run only ever belongs to an old head, and the merge gate judges checks at the current head, so the gate needs no change.

## Later option: other runners

Not part of this issue. Worth doing only if, after 1–3, a warm PR run is still well above two minutes or cold runs dominate. Notes for that decision:

- **Self-hosted on the maintainer's PC.** Fastest per run, since vitest and turbo are CPU-bound and the hosted runner has 4 cores. But the repository is public: a self-hosted runner there lets a fork PR run arbitrary code on the machine, and GitHub advises against it. It would need fork PRs pinned to hosted runners (a job-level `runs-on` chosen by `github.event.pull_request.head.repo.full_name == github.repository`), plus a throwaway container or VM per job. The same PC runs iRacing, and a CI build saturating the CPU during a session is the freeze the 64-spinner load test caused. And CI is Linux today: a Windows host would build the native addons for real, so the runner belongs in WSL2 or Docker.
- **A dedicated machine or a cheap Linux VPS** removes the sim-load problem. It keeps the fork-PR problem.
- **Third-party hosted runners** (Blacksmith, Namespace, Depot, Ubicloud) or **GitHub's larger runners**: usually a one-line `runs-on` change with more cores and no machine to secure. They cost money per minute, so compare their prices when this is picked up.

## Alternatives rejected

- **Vercel / turbo remote cache.** It needs a token secret, which fork PRs do not get, and it puts an outside service in the build path. `actions/cache` reaches the same hit rate for this repo's single-runner layout.
- **One build job uploading its outputs as an artifact for the shards.** Slower on the warm PR path (section 2), and it adds a job-to-job contract over hundreds of MB.
- **Caching on master pushes too.** That would make the post-merge run a check of the cache rather than of the tree, which is the gap #1070 closed.

## Out of scope

- Format's 73 s: a Prettier `--cache`, or questioning whether the generated 1.8 MB `generate.manifest.json` and 1.2 MB `pack-reference.json` should be checked. Format is not on the critical path.
- Narrowing the `Tests` build to what the suite needs (the website and the three plugin builds take the last ~40 s), which needs a check of which tests read build outputs.
- `Typecheck` is not a required check in the ruleset today. Noticed, not changed here.
- Merging the four workflows into one. That saves runner minutes but no wall-clock time.
- Runner changes (above).

## Testing

On the implementing PR, recorded in its body:

- **Cold and warm timings.** The first run on the PR (restoring master's cache from before the change) and a second push touching one leaf package. Report `Run tests`' wall time and the turbo `Cached: n of 37` line from each shard.
- **Master stays uncached.** After the merge, the master push run's turbo summary reads `0 cached` in every shard and in `Typecheck`, and a cache entry was saved.
- **A real input change misses.** On a throwaway branch, edit `tsconfig.base.json` (a comment, after #1491 has declared it). Every `tsc` task must miss.
- **Sharding loses no test.** The shards' `Test Files` counts add up to the unsharded count from the same commit, measured alongside, not to the "653" in this spec.
- **The gate cannot pass red (positive control).** On a throwaway PR, a test that fails in one shard turns `Run tests` red. Cancelling one shard by hand leaves `Run tests` red or failed, never skipped.
- **Concurrency.** Two quick pushes to a PR leave the first run cancelled. Two `master` pushes in quick succession both run to completion (the next two merges count).
- **The cache stays bounded.** Over several runs, the saved entry's size stays around one build's outputs instead of growing.
