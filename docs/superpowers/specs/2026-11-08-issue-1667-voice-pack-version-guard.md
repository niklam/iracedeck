# A voice-pack change without a version bump fails on its PR

> **Issue:** [#1667](https://github.com/niklam/iracedeck/issues/1667) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

A first-party pack's archive is a function of a short list of inputs. The packer (`packages/audio-assets/scripts/pack-voice.mjs`) is byte-deterministic by contract (sorted entries, pinned zip options, DOS-epoch timestamps, sorted-key `voice-pack.json`). Its output depends only on:

- each voice's source clips, their bytes and relative paths, each run through the radio filter and encode;
- each voice's `callouts.json`, copied as-is;
- the `voice-pack.json` it writes, built from the pack definition (`id`, `label`, `version`, `author`) and each voice's config `label`;
- the encode pipeline: `RADIO_ENGINEER_FILTER`, `ENCODE_ARGS` and the ffmpeg binary that `ffmpeg-static` installs;
- the archive writer: `fflate` and `ZIP_ENTRY_OPTIONS`.

The committed `catalog/<id>.json` records the archive's `bytes` and `sha256`. Only `scripts/publish-voice-packs.mjs` re-derives them, and only in the tag workflow and the manual *Publish voice packs* workflow, because it encodes every clip (4,810 + 4,717 today). Every other check accepts a stale entry:

- `committed catalog entries` in `src/pack-voice.test.ts` checks presence, the schema and the registry-owned fields, and says it does not re-derive `bytes` or `sha256`;
- `callout-scripts.test.ts` checks the script artifact against its config, not the pack built from it;
- `src/build/voice-packs.test.ts` pins the `iracedeck-terse` version, which only adds an edit to every bump.

#1582 changed both packs' `callouts.json` and passed all of them. The `v3.8.1` tag run was the first thing to fail (#1665).

Two different mistakes need catching, and the tree can tell them apart only if it knows what has been released:

1. **Stale entry**: an input changed and nobody re-ran `pack:voice`. This was #1582.
2. **Re-pack under a released version**: someone re-ran `pack:voice` but kept a version whose archive is already published. Today pass 1 of the publish script accepts it, because the entry is fresh. Pass 2 then finds the published asset's bytes differ and fails the tag. The documented corollary (`audio-assets/CLAUDE.md`, *Voice packs*) allows the second only for a version that has never been published.

## Decision

### The pack record

Each pack in `VOICE_PACKS` gets a committed record, `packages/audio-assets/pack-records/<id>.json`, written by the flagless `pack:voice` run that writes `catalog/<id>.json`, and only by that run. `--no-catalog` and `--stage-only` leave it byte-untouched, as they leave the entry. The record is two-space LF JSON with a trailing newline, Prettier-clean like the entries:

```json
{
  "id": "<pack-id>",
  "version": "1.4.1",
  "sha256": "<the archive's sha256, equal to catalog/<pack-id>.json>",
  "inputs": {
    "pipeline": "<sha256 of the pipeline identity>",
    "archiveFormat": "<sha256 of the archive-format identity>",
    "manifest": "<sha256 of the voice-pack.json bytes the packer writes>",
    "voices": {
      "<voice-id>": { "clips": 4810, "clipsSha256": "<sha256>", "script": "<sha256 of callouts.json, or null>" }
    }
  },
  "released": { "version": "1.4.1", "sha256": "<sha256>" }
}
```

- `clipsSha256` is the sha256 of one line per source `.mp3` under `voice/<voice-id>/`, sorted by POSIX relative path by code unit: `<path>\0<sha256 of the bytes>\n`. It uses the same walk and the same case rules as `countSourceClips`. It hashes content, never mtime: a copy or a touch with identical bytes changes nothing, the rule #1143 settled for the encode cache.
- `script` is the sha256 of the `callouts.json` bytes the packer would stage, found by the exact-name rule `assertCalloutScript` uses. It is kept apart from the clips so that a script-only change, the #1582 case, is named as one.
- `manifest` hashes `serializeSortedJson(buildVoicePackManifest(pack, voices))`, the exact bytes that go into the archive. That covers the version, the pack label and author, and every voice's config `label`. A version bump therefore makes the record stale until the pack is re-packed, which is right, since the archive changes with it.
- `pipeline` hashes one identity, exported from `src/build/index.mjs`: the filter chain, the encode args and the installed `ffmpeg-static` version, read from its `package.json`. #1657 adds its normalization descriptor to the same identity.
- `archiveFormat` hashes the installed `fflate` version plus a JSON-safe description of `ZIP_ENTRY_OPTIONS`. The mtime goes in as its field tuple, never as a `Date`, whose JSON form depends on the machine's time zone.
- Aggregate digests per voice, not per clip. A per-clip list would be about 9,500 lines per pack, conflict on every parallel clip PR, and add nothing the failure message needs beyond "the clips of this voice changed".

One module owns the computation and the rules below. The packer, the test, the release hook and the publish script import it; none of them restates it, and it has no import cycle with `pack-voice.mjs`.

### The pipeline identity is also the cache key

Today `pipelineHash` covers the filter chain and the encode args but not the ffmpeg binary. After an `ffmpeg-static` bump, the shared `.cache/<pipeline-hash>/` keeps serving output from the old binary. With the record in place, that would make a re-pack lie: the record would say the pipeline changed, the re-pack would reproduce the old sha256 from the warm cache, and a cold release runner would encode new bytes. So the cache key becomes a hash of the same identity the record uses. The cost is one full re-encode on every machine the first time it builds after this lands, and again after each `ffmpeg-static` bump. No archive bytes change from this alone: the same binary gives the same output.

### The rules

The rules are pure functions of the tree. The test holds every pack in `VOICE_PACKS` to them, and so do the release hook and the publish script.

1. **Coverage.** Every published pack has a record, and no record exists for a pack the registry does not publish (the same two checks the entries already have).
2. **Consistency.** The record's `id` and `version` equal the definition's, and its `sha256` equals the catalog entry's. One run writes both files, so a disagreement means one of them was edited by hand or left out of the commit.
3. **Freshness.** The recomputed `inputs` deep-equal the record's. On a mismatch the failure names every part that differs, for example: `iracedeck-terse: voice/<voice-id>/callouts.json changed since catalog/iracedeck-terse.json was packed`, or `default: the clips under voice/default changed (4,811 now, 4,810 recorded)`. It then gives the fix, worded by rule 4. If the version is released: bump `version` in `src/build/voice-packs.mjs`, run `pnpm --filter @iracedeck/audio-assets pack:voice <id>`, and commit `catalog/<id>.json` and `pack-records/<id>.json`. If it is not: the same without the bump, saying the version is not released yet.
4. **A released version is frozen.** When the record has `released`, the definition's version must be at or above `released.version` (semver precedence, the rule #1613 enforces at deploy: a published version is bumped, never rolled back). When the two are equal, the record's `sha256`, and so the entry's, must equal `released.sha256`.

The test also asserts that it did work: each voice's recomputed clip count equals `countSourceClips` and is above zero. A guard that hashed an empty tree would agree with any record.

Hashing the real tree reads about 175 MB. Measured at 0.6 s on a warm Windows checkout; it runs inside the existing `pnpm test` shards with no ffmpeg, no network and no git history. Line endings cannot split the digest between platforms: `.gitattributes` checks every `.json` out with `eol=lf`, and clips are binary.

### Where it runs: the normal test suite, not a workflow of its own

The test is `packages/audio-assets/src/pack-record.test.ts`, run by `pnpm test` and so by the existing `ci-test` shards. It does not get a CI workflow of its own:

- A test in the suite fails on the author's machine before the push. A separate workflow only fails after it.
- A dedicated workflow pays a runner start-up and a `pnpm install` on every PR to run under a second of work.
- The four CI workflows are split by tool (format, lint, typecheck, test), not by feature, and the repo's other guards (`turbo-inputs`, `lint-format-coverage`, `vitest-alias-coverage`) live in the suite the same way.
- A path-filtered workflow made a required check blocks every PR that skips it, unless that is worked around.

The failure still names itself: the shard reports `pack-record.test.ts` and the message names the pack and the input that changed.

### Sealing: how the tree learns a version is released

`released` is written in exactly two places, and `pack:voice` preserves it untouched.

- **The release hook.** `scripts/release-hooks.mjs` (`before:bump`) runs on every `pnpm release`. It first holds every pack to rules 1 to 4. A stale record aborts the release with a clean tree and names `pack:voice`, before any version file is written, following the fold's validate-before-write order. This alone would have stopped #1582 before the tag. Then, when the new version has no `-dev` prerelease identifier (a stable or `-rc` release, the ones that are tagged and publish packs), it sets `released` to `{ version, sha256 }` for every pack whose `released.version` differs, and stages `pack-records/*.json` in the `chore(release)` commit (the `git add --dry-run` preflight includes them). A `-dev` bump is committed untagged and publishes nothing, so it checks and does not seal. `release:dry` prints what it would seal and writes nothing.
- **A seal command for between-releases publishes.** `pnpm seal:voice-packs [<id> …]` runs the same checks and seals, and nothing else. It is committed to `master` before the *Publish voice packs* workflow is dispatched with `publish` on.

`scripts/publish-voice-packs.mjs` holds both ends:

- Pass 1 checks rules 1 to 4 for every pack before it packs any, so a stale record fails in seconds with the actionable message instead of after a full encode.
- With `--publish`, it refuses a pack whose `released.version` is not its current version: `<id> <version> is about to be published but is not sealed in pack-records/<id>.json — seal it on master first`. A tag run's release commit has sealed it, so this only bites a between-releases publish that skipped the seal, or a tagged `-dev` bump. A version is published only once the tree says so.

### The packer refuses a changed archive under a sealed version

When the definition's version equals `released.version`, a flagless `pack:voice` still packs, so the author gets the archive to inspect. If the new sha256 differs from `released.sha256`, it then refuses to write the entry or the record and names the bump. If the sha256 is equal (for example, an `ffmpeg-static` bump that left the output unchanged), it writes the record with the new inputs, and no bump is needed. Inputs decide when a re-pack is due; only bytes decide when a bump is due.

### Where the record lives, and why not in the catalog entry

The inputs and the seal could have gone into `catalog/<id>.json` as extra fields without breaking a released plugin. `VoicePackCatalogEntrySchema` is a plain `z.object` on zod 4.6.7 back to v3.7.0, which strips unknown keys rather than refusing them; `parseVoicePackCatalog` documents that unknown fields are ignored; and the website's generator republishes the parsed, stripped entry, so the fields would never reach `voice-catalog.json`. They stay out anyway, for three reasons:

- The entry is the published contract, documented as exactly one `VoicePackCatalogEntrySchema` object. The plugin compiles `catalog/default.json` in (`plugin-runtime`'s `voice-packs/seed.ts`), and the website validates every file in `catalog/`. Provenance and the seal are repository state, and they have no business in a file that ships.
- `catalog/` is read as "every `.json` here is a pack" by the website generator, by the publish script's `listCatalogEntryIds` and by the existing entry test, so the record cannot be a sibling `.json` there either.
- A record per pack keeps two PRs that touch different packs from conflicting.

## Rejected

- **The input hash inside the catalog entry.** Safe for released plugins, as shown above, but it puts repository state in the published contract and in the plugin bundle.
- **Diff the PR's pack inputs against `origin/master` and require a bump.** CI's checkout is shallow, so this needs a base ref the test cannot assume. It is vacuous on a push to `master` and on a local run on `master`. And it either forces a bump for a second change under a still-unpublished version or needs a publication oracle anyway, which is the seal.
- **Run the real pack in PR CI.** The encode is not the blocker: a PR touching `voice/**` already misses the turbo cache for `@iracedeck/audio-assets#build` and warms every clip in each shard. But PR CI runs on Linux and the release jobs on Windows, and byte-equal ffmpeg output across the two binaries is unproven (#1657 names the same risk). A real pack also cannot tell a released version from an unreleased one. The publish dry run stays the end-to-end check, before tagging.
- **A networked check of the live catalog or the GitHub release in CI.** It puts the network in the merge gate, so an outage turns a PR red. The live catalog also lags a between-releases publish until the site deploys.
- **A CI workflow of its own for the check.** See *Where it runs*: it would only fail after the push, cost a runner per PR, and break the by-tool split of the CI workflows.
- **The packer refusing on its own, with no test.** #1582 never ran the packer. A guard that only fires when you run the tool you forgot is no guard.
- **Git blob hashes (`git ls-files -s`) instead of reading the files.** Faster, but it misses an uncommitted edit in a local run and makes the test depend on git. Reading the files takes under a second.
- **Sealing on every `pnpm release`, `-dev` included.** That would freeze a version bumped on `master` but not yet published, and force a needless second bump on its next change.

## Out of scope

- Third-party packs. They are not in `VOICE_PACKS`, are never packed here, and their versions are their authors' business.
- Proving that ffmpeg output is identical across platforms. The publish dry run on the release platform stays the check (#1657's Testing section).
- Packer code changes beyond the archive format identity above. A change to how `pack-voice.mjs` builds an archive that the identity does not capture is covered by its own determinism test and by the publish step, as today.
- A post-edit hook reminder that a config edit made a record stale. The test catches it on the next run; a hook would only be earlier.
- The window between a tag on a `release/*` branch and its back-merge. The seal lands on the branch first. A `master` PR that re-packs the same version in that window passes on `master`, and the back-merge then conflicts on `pack-records/<id>.json`, which is where it surfaces. Accepted, as the #1613 rules accept their own back-merge windows.
- Fixing 3.8.1 itself. That is #1665, and this lands after it.

## Testing

Unit tests over a temporary voice tree, through the injectable roots the packer already takes:

- The inputs change when one clip's bytes change, when a clip is added, removed or renamed, when `callouts.json` changes alone, when a config `label`, the pack `version`, `label` or `author` changes, and when the pipeline or archive identity changes. They do not change when a file is copied or touched with identical bytes, or when a non-`.mp3`, non-script file appears. Each failure message names the part that changed.
- Rules 1 to 4, each failing alone, with the wording of rule 3's fix differing between a released and an unreleased version. A version below `released.version` fails.
- The packer writes the record with the entry. `--no-catalog` and `--stage-only` leave both byte-untouched. `released` survives a re-pack. A changed archive under a sealed version is refused with entry and record byte-untouched and the archive left in `dist/` for inspection. An unchanged archive under a sealed version with changed inputs writes the record.
- The cache key changes with the `ffmpeg-static` version.
- `release-hooks.test.mjs`: a stale record aborts the release with a clean tree before any version file is written. A stable and an `-rc` version seal and stage the records. A `-dev` version checks and seals nothing. `release:dry` writes nothing.
- `publish-voice-packs.test.mjs`: a stale record fails pass 1 before the injected `pack` is called. `--publish` refuses an unsealed pack. A dry run does not require a seal.
- The real-tree test passes on the branch, and its clip-count floor matches `countSourceClips` for every voice.

Positive controls, each run for real on a scratch branch and recorded in the PR body. A guard proves nothing until it has been seen to fail:

1. **Replay #1582.** Seed records from `89045e245^`'s tree, sealed at the then-published versions, and apply `89045e245`'s `callouts.json` changes. The test fails for both packs, names each `callouts.json`, and asks for a bump.
2. Change one clip's bytes. The test fails naming that voice's clips.
3. Re-run `pack:voice` without a bump. The packer refuses. Then hand-edit the entry's `sha256` to the new value and run the test: rule 4 fails.
4. Bump and re-pack. The test passes, and `node scripts/publish-voice-packs.mjs` (dry run) passes on the branch.
5. `pnpm release:dry` on the branch reports the seal it would write.

This is dev tooling, so the issue's `qa` agent runs these controls end to end with real commands and real commits, per `issue-workflow.md` (#1532). The review is `xhigh`: the change touches `release-hooks.mjs` and the files the catalog contract is published from. A second read applies, because the change adds a gate and touches a release and publish path.
