---
paths:
  - ".github/workflows/**"
  - ".release-it.json"
  - "scripts/release*"
  - "scripts/publish-voice-packs*"
  - "scripts/seal-voice-packs*"
  - "scripts/voice-pack-*"
  - "scripts/website-voice-catalog-json*"
  - "packages/audio-assets/catalog/**"
  - "packages/audio-assets/pack-records/**"
---

# Voice-pack releases and the website deploy

How voice-pack archives are published and how every website deploy checks the voice catalog, for whoever edits the release or publish workflows and scripts, or the catalog. The release procedure is *Releasing* in `@.claude/rules/build-and-commit.md`; this file was moved out of it in #1658 to keep the always-loaded set inside its budget.

## Publishing the archives (#1116)

**Voice-pack archives are published by the tag workflow, never by hand** (#1116). `scripts/publish-voice-packs.mjs` packs every published voice, verifies it against its committed `catalog/<id>.json`, and attaches it to its `voices-<id>-<version>` release with `--latest=false`. A mismatch fails the job before anything ships. Its `pack-records/<id>.json` (#1667, `audio-assets/CLAUDE.md`) makes a stale entry fail `pnpm test` first; the `before:bump` hook refuses a stale record with a clean tree, and on a version with no `dev` prerelease identifier seals every pack's version as released in the `chore(release)` commit, after the fold. A between-releases publish needs `pnpm seal:voice-packs <id>` committed to `master`; `--publish` refuses an unsealed pack. Run the *Publish voice packs* workflow with `publish` off as a dry run before tagging a release that changes a pack.

## A pack shipped between releases

**A voice pack shipped between releases never deploys `master`.** The same workflow with `publish` on builds the website from the latest stable plugin tag with only the catalog entries taken from `master`, at the commit the run packed and verified (`github.sha`, never the branch tip), and refuses the deploy if `master`'s catalog has moved since. A publish dispatched from any other ref fails before it packs; the dry run is open to any ref (#1392). The site ships from release tags only; documentation for unreleased work must not reach it early. Every website deploy, manual ones included, also refuses to build while any catalog entry names an archive that is not published yet — so after bumping a pack, publish it before deploying the site by hand.

## Every deploy checks the live catalog (#1613)

**A tagged `release/*` branch carries every live voice pack at or above its live version** (#1613) — in practice the pack commits published from `master` between releases. Every website deploy, as its last step before the Firebase deploy, compares its catalog with the live `https://iracedeck.com/voice-catalog.json` (semver) and refuses a live pack it names lower (always: a published version is bumped, never rolled back) or lacks while `master`'s catalog still has it, naming each with both versions; a live pack it lacks passes, with a warning, only as a withdrawal (`master`'s catalog lacks it and `master`'s history shows the entry was deleted there); one `master` never carried, shipped from an un-back-merged release branch, refuses; `master` is fetched (whole history, no file contents) only for that, refusing when unreadable. A pack not live never blocks, so an unpublished bump on `master` does not hold up a patch. A 404 passes with a warning; a network error, timeout, other status or non-catalog body refuses. Remedy: bring the pack from `master`, clips and catalog entry together (the tag's pack job repacks from the branch's clips), or withdraw it on `master` first (a pack `master` never had is back-merged onto `master` before either), then re-tag or re-run; on a between-releases publish (`master`'s catalog) back-merge the release's pack onto `master`, then dispatch again. The tag runs its own copy of `firebase-hosting-release.yml`, so a release branch cut before #1613 has no such check until it carries this change, and until then the rule is the releaser's alone.
