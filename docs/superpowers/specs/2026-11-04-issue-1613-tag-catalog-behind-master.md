# A tag deploy refuses a voice-pack catalog behind master's

> **Issue:** [#1613](https://github.com/niklam/iracedeck/issues/1613) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

Two paths put `packages/audio-assets/catalog/` live. The between-releases publish (`publish-voice-packs.yml`) runs from `master` only and, since #1392, deploys the catalog of the exact commit it verified, refusing when `master`'s catalog has moved since. The tag release (`release.yml`) deploys the site and the catalog from the tag, with no comparison to `master`. A patch tagged from a `release/*` branch cut before a pack bump therefore ships the older entry over the newer one already live, and nothing goes red: the older archive is still published and answers 200.

## Decision

The tag deploy refuses a catalog that is behind `master`'s (Niklas, 2026-11-04, choosing between refuse, overlay and document-only).

1. **Where.** In the reusable `firebase-hosting-release.yml`, in the job that deploys, before the deploy step. A re-run of that job alone is then checked too, which a check in `release.yml`'s earlier jobs would miss (the same reasoning #1392 used for its overlay check).
2. **What is compared.** For each pack id in `master`'s catalog (`git fetch` of `refs/heads/master`, then the catalog tree at that commit), the tag's entry must exist and its `version` must be at or above `master`'s, compared as semver. A pack `master` lacks never blocks: a release branch may ship a pack before `master` publishes it. A pack the tag lacks but `master` has is a refusal, because deploying would remove a live pack.
3. **How it fails.** `::error::` naming each pack, the tag's version and `master`'s, and the remedy: bring `master`'s catalog onto the release branch (a cherry-pick of the bump commits) and re-tag or re-run. The job exits non-zero before anything deploys. It never falls back to skipping, because a skipped deploy reads green.
4. **Unreadable master.** If `refs/heads/master` cannot be fetched or its catalog cannot be read, the job refuses. That is the same fail-closed stance as #1392's overlay check: accepting a catalog nobody compared is the failure this exists to stop.

## Rejected

- **Overlay `master`'s catalog onto the tag's site.** It ships content the tag never contained, so the release would no longer be reproducible from its tag, and it would need the publish path's verification copied into the tag path. It also makes a tag deploy depend on whatever `master` holds at that minute.
- **Document only.** A written rule is the state today, implicitly, and the failure is silent. A rule nobody is reminded of at tag time does not hold.

## Out of scope

- The between-releases publish path, which #1392 owns.
- Comparing archive hashes or bytes. The catalog already names the archive, and #1116's publish-time verification covers its content.
- Back-merging or syncing release branches automatically.

## Testing

- Workflow YAML tests alongside #1392's `publish-voice-packs-workflow.test.mjs`: the check step sits in the deploying job, before the deploy step, and has no `continue-on-error`. Each assertion is positive-controlled against a mutated copy.
- The step's script, extracted and run by the qa agent against fixture catalogs: tag behind (refused, naming the pack), equal (allowed), ahead (allowed), a pack only on the tag (allowed), a pack only on `master` (refused), and an unreadable `master` (refused). Nothing deploys.
- No live tag is cut to test it.
