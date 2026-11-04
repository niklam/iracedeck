# A tag deploy refuses a voice-pack catalog behind master's

> **Issue:** [#1613](https://github.com/niklam/iracedeck/issues/1613) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

Two paths put `packages/audio-assets/catalog/` live. The between-releases publish (`publish-voice-packs.yml`) runs from `master` only and, since #1392, deploys the catalog of the exact commit it verified, refusing when `master`'s catalog has moved since. The tag release (`release.yml`) deploys the site and the catalog from the tag, with no comparison to `master`. A patch tagged from a `release/*` branch cut before a pack bump therefore ships the older entry over the newer one already live, and nothing goes red: the older archive is still published and answers 200.

## Decision

The tag deploy refuses a catalog that is behind the one already live (Niklas, 2026-11-04, choosing between refuse, overlay and document-only). The decision first named `master`'s catalog as the base; the amendment below moves it to the live catalog, which is what the refusal protects.

1. **Where.** In the reusable `firebase-hosting-release.yml`, in the job that deploys, directly before the Firebase deploy step. A re-run of that job alone is then checked too, which a check in `release.yml`'s earlier jobs would miss (the same reasoning #1392 used for its overlay check). Running it last, not before install, also closes the window in which a between-releases publish could go live and then be overwritten: release deploys and publish deploys are in separate concurrency groups.
2. **What is compared.** The live catalog, `https://iracedeck.com/voice-catalog.json`. For each pack in it, the catalog about to be deployed must carry that pack at a `version` at or above the live one, compared as semver. A pack the live catalog lacks never blocks. A live pack missing from the deploy is a refusal, because deploying would remove it.
3. **How it fails.** `::error::` naming each pack, the deploy's version and the live one, and the remedy: bring that pack onto the release branch from `master` (its clips and its catalog entry together, since the tag's pack job repacks from the branch's clips and verifies the archive against the entry) and re-tag or re-run. The job exits non-zero before anything deploys. It never falls back to skipping, because a skipped deploy reads green.
4. **Unreadable live catalog.** A network error, a timeout, or a response other than 200 or 404 refuses the deploy, and so does a 200 whose body does not parse as the catalog schema. A 404 is the one pass: no catalog is live, so nothing can regress, and the job logs a warning. That is the same fail-closed stance as #1392's overlay check: accepting a catalog nobody compared is the failure this exists to stop.

### Amendment during implementation (2026-11-04)

The first version compared against `master`'s catalog. #1613's `/code-review` (xhigh) showed that base blocks ordinary patch releases. `master` routinely carries a committed pack bump that is not yet live (the README's "the next release publishes it"; #1579 and #1571 bumped the catalog in feature PRs), so a hotfix tagged from a `release/*` branch would be refused although nothing live regresses. The remedy it named then fails too: cherry-picking the bump alone makes the tag's pack job repack from the branch's clips and fail the archive check. The live catalog is the state the issue protects, so it is the base. A cost is accepted: a live catalog that answers 200 with a malformed body cannot be replaced through a tag deploy without first fixing the site by hand. Comparing against `master` while skipping unpublished entries was rejected, because a tag behind the live version, with `master` ahead and unpublished, would still regress live with nothing red.

## Rejected

- **Overlay `master`'s catalog onto the tag's site.** It ships content the tag never contained, so the release would no longer be reproducible from its tag, and it would need the publish path's verification copied into the tag path. It also makes a tag deploy depend on whatever `master` holds at that minute.
- **Document only.** A written rule is the state today, implicitly, and the failure is silent. A rule nobody is reminded of at tag time does not hold.

## Out of scope

- The between-releases publish path, which #1392 owns.
- Comparing archive hashes or bytes. The catalog already names the archive, and #1116's publish-time verification covers its content.
- Back-merging or syncing release branches automatically.

## Testing

- Workflow YAML tests alongside #1392's `publish-voice-packs-workflow.test.mjs`: the check step sits in the deploying job, directly before the Firebase deploy step, and has no `continue-on-error`. Each assertion is positive-controlled against a mutated copy.
- The step's script, extracted and run by the qa agent against a local stand-in for the live catalog: deploy behind live (refused, naming the pack), equal (allowed), ahead (allowed), a pack only in the deploy (allowed), a live pack missing from the deploy (refused), a network error, a 500 and a malformed body (each refused), and a 404 (allowed, with the warning). Nothing deploys.
- A pending pack bump on `master` that is not yet live does not block: the deploy is compared with live, not with `master`.
- No live tag is cut to test it.
