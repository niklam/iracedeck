# Downloadable Race Engineer Voice Packs

> **Issue:** [#1034](https://github.com/niklam/iracedeck/issues/1034), [#1116](https://github.com/niklam/iracedeck/issues/1116) (publishing) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

Every Race Engineer voice ships inside every plugin. The built Stream Deck plugin is 78 MB, of which **8.1 MB is voice audio for the single `default` voice** (30 MB of source clips, reduced by the build-time radio filter and the 16 kHz mono 32 kbps re-encode). Each additional voice adds roughly another 8 MB to all three plugin downloads, on all three marketplaces, for every user — including the users who will never switch voices.

**These figures are measured, not estimated — 2026-09-02.** The built voice tree is 8,112,969 bytes across 1545 clips, and the packed archive is 7,879,224 bytes; the pack was verified against the shipped plugin per file by sha-256, not by comparing totals. They were wrong until then, by roughly a third: the original 13 MB / 33 MB pre-dated `3c15f571` (11025 Hz / 24 kbps) and `18bece04` (16 kHz / 32 kbps), and the prose beside them was updated to name the new encode while the numbers were never re-measured — which is how a parenthetical came to describe today's settings next to yesterday's output. The saving is smaller than first claimed and the argument is untouched: 8 MB per voice, for every user, on three marketplaces, still gets worse with every voice added.

Two things not to "correct" later. The archive (7.9 MB) and the on-disk audio (8.1 MB) are **nearly equal on purpose** — these clips are already MP3, so zipping buys 6%, not the wide margin the original figures implied; the two being close is a measurement, not a typo. And the 78 MB plugin total above has **not** been re-measured, so treat it as the one figure here still carrying its original estimate.

That makes shipping a second voice a bad trade today, and a third one worse. It also means a voice can only be updated by shipping a whole plugin release, and a third party cannot publish a voice at all.

## Goals

- Voices are distributed as **downloadable packs** installed outside the plugin folder, so they survive plugin updates and reinstalls.
- **Third parties can publish voices** without going through a plugin release.
- Plugin download size drops by ~8 MB, and stays flat as voices are added.
- A voice pack is **not re-downloaded when its content has not changed**, across any number of plugin releases.
- Nothing this feature does can ever put a window in front of a live iRacing session.

## Non-goals

- A user-facing verbosity control. Per-line skipping is [#1033](https://github.com/niklam/iRaceDeck/issues/1033) and stays a build-time, voice-author decision; this design only has to carry its data.
- Delta or per-clip updates. A changed pack is re-downloaded whole.
- Installing packs from arbitrary URLs. See *Distribution model*.
- Signed/verified third-party packs. Provenance is recorded and displayed, not enforced.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Distribution | Curated catalog on iracedeck.com **+ hand sideload** | The **page** never gets to say where the plugin looks — the rule already stated in `changelog-feed-client.ts`. Third-party support comes from the folder being a real extension point, not from a downloader. A file-based dev override is permitted; see below. |

**`_devBaseUrl` — a file-based override of the catalog host, added 2026-09-03.** A passthrough key in the plugin's own settings file, defaulting to `https://iracedeck.com`, so with it unset the fetched URL is byte-identical to the constant. It exists because a catalog could otherwise only be tested by publishing it first, which is the wrong order for a file that tells the plugin what to trust.

**The rule this corrects, and why the original was wrong.** This table previously said the plugin "never takes a URL from a config or the UI". The security reasoning offered for it — that whoever sets the URL controls both the bytes and the `sha256` they are checked against — is true and does not matter: **anyone who can write that settings file can already write the plugin's own JavaScript**, so no privilege boundary is crossed, and the archive validator caps any payload at `.mp3` and `.json`, which hand-sideloading already permits by design. What `changelog-feed-client.ts` actually protects is narrower and still holds: *"the page asks the plugin for a verdict, it does not get to say where the plugin looks."* That is a boundary between untrusted UI and the plugin, not between a user and their own filesystem.

So the line stays where it is: **no URL field in the settings window, ever.** A key a user edits in a file is a different thing from a control the UI invites them to paste into.

Constraints, all enforced at the point of use rather than in `GlobalSettingsSchema`, so a malformed value cannot stall the settings parse and make every binding read as unset:

- `https://` any host; `http://` **only** for `localhost` / `127.0.0.1`, so a local test server works while plaintext to a real host does not.
- Anything else is ignored, the constant is used, and a warning is logged. It never throws.
- Only the known filename is joined onto the base — the override chooses the host, never the resource.
- **It can never be silently active:** a warn-level line every start when set, and a Diagnostics row rendered *only* when set, so an ordinary user's window never grows a field inviting a pasted URL.
| Discovery | Startup scan **+ explicit refresh** | The download button refreshes itself, so a pack appears immediately; a sideloaded folder needs one button press. No filesystem watcher. |
| Transport | `.zip`, extracted with a zero-dependency pure-JS library (`fflate`) | The manifests declare Windows 10 minimum (#994), and Win10 Explorer double-clicks a zip but cannot open a `.tar.gz`. Sideloading is a first-class path, so the archive must be openable by hand. |
| Identity | `version` (semver) for humans, `sha256` for the update test | A content hash cannot be forgotten the way a version bump can. |
| Rollout | Bundle `default` for one release and seed by copy, drop the bundle in the next | An upgrade must not depend on the network at the moment the entire install base is exposed to it. |

## On-disk layout

```text
%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices\
  luca\
    voice-pack.json                 pack identity — ships inside the archive
    .install.json                   provenance — written by the installer, never shipped
    voice\luca\flags\blue-01.mp3
    voice\luca\position-number\4.mp3
  .tmp\                             downloads and staging
  .trash\                           superseded packs awaiting deletion
```

The path has no ecosystem segment, unlike the settings store: a voice pack is **content, not user state**, so a user running both a Stream Deck and a Mirabox should not hold or download two copies. See *Concurrent installs* for what that costs.

The `voice/<id>/…` repetition inside a pack is deliberate and load-bearing — see *Path resolution*.

### `voice-pack.json` — identity, inside the archive

```json
{
  "schema": 1,
  "id": "luca",
  "label": "Luca",
  "version": "1.2.0",
  "author": "iRaceDeck",
  "voices": [{ "id": "luca", "label": "Luca" }]
}
```

`voices` lets one pack carry more than one voice. That costs nothing now and leaves room for a pack shipping two engineers.

**`skipped` was removed before it shipped, decided 2026-09-01.** It was reserved here for [#1033](https://github.com/niklam/iRaceDeck/issues/1033)'s per-entry skip when a pack meant one voice. [#1064](https://github.com/niklam/iRaceDeck/issues/1064)'s design has since moved skipping to a `"skip": true` inside each voice's own script file, so a pack-level flat list reserves a slot a newer design already fills — in a format where per-voice data no longer belongs at pack level at all.

Removing it was free and stays reversible: nothing ever read it (the scanner never put it on `InstalledVoicePack`), and adding a field back to an unshipped format is the same free edit as taking one out. The asymmetry runs one way — keeping it would have meant carrying it forever. A manifest that still carries the key loads normally; unknown fields are ignored rather than refused, so no hand-made pack breaks over it.

**A voice carries an `id` and a `label`, decided 2026-09-01.** The pack already had that pair; the voices inside it did not, and the inconsistency was visible in the UI — the Installed Voices row showed a pack's chosen `label` while the dropdown beside it showed `titleCase(<voice id>)`, a mechanical transform of an identifier. A hyphenated id rendered as `Aaa-testvoice`. A pack author could name their pack and not their voices.

`id` still matches the clip-path segment, `voice/<id>/…`, and the scanner still filters a pack's clips by that prefix — so **a declared `id` with no matching directory keeps failing as "no clips found under `voice/<id>/`"**. That cross-check is not replaced by the declaration; it is what validates it.

**The label is presentation, never identity.** Nothing resolves, compares, or persists a label: `raceEngineerVoice` stores an id, `resolveActiveRaceEngineerVoice` anchors on an id, collisions are decided on ids. The label reaches the dropdown through a separate `_voiceLabels` map published beside the existing `_raceEngineerVoices` in the same `updateGlobalSettings` call, so the two cannot drift and the four `resolveActiveRaceEngineerVoice` call sites are untouched. A voice with no declared label — the bundled one, which has no manifest — falls back to `titleCase(id)`, which is exactly what every voice renders as today. That is why the bundle needs no special case.

**`schema` stays `1`.** A version distinguishes formats that coexist in the wild, and there is no version 1 in the wild: no released plugin reads `voice-pack.json` at all, so nothing can have been authored against the old shape. Publishing the first format as `2` would permanently imply a version 1 nobody can find. Keeping `1` also gives the better error for the only packs that do exist — hand-made test packs on a maintainer's machine — since Zod then fails on `voices.0` and names the field that changed, where a bumped literal would only say "expected 2".

Rejected: accepting both shapes for a window (`z.union([packId, { id, label }])`, treating a bare string as `{ id, label: titleCase(id) }`). That is the honest migration when packs exist in the wild. None do, so it would buy a permanently ambiguous published format to protect a handful of local test packs that can be hand-edited in a minute.

### `.install.json` — provenance, written by the installer

```json
{
  "schema": 1,
  "source": "catalog",
  "sha256": "…",
  "url": "https://…/luca-1.2.0.zip",
  "installedAt": "2026-08-25T09:14:03.221Z"
}
```

Deliberately **not** inside the archive: a pack must not be able to declare its own provenance. A sideloaded pack has no `.install.json` at all, which is exactly how the scanner identifies it as sideloaded.

## Path resolution — two roots, one logical path space

`AudioService` takes a single `basePath` today and throws (`Audio clip path escapes basePath`) when a clip resolves outside it. It gains an **ordered list of roots**:

1. the plugin's `assets/audio` (sfx, plus any bundled pack)
2. `…\Race Engineer\Voices`

A relative path resolves against the first root that contains it, with the existing escape guard applied per root. Plugin-root-first means an installed pack can never shadow the bundled sfx or a bundled voice.

Because a pack contributes `voice/<id>/…` under its own root, **clip paths keep exactly the shape they have today**, and nothing downstream learns a second root exists:

- `buildManifestPool`'s `^voice/([^/]+)/<group>/<base>(?:-\d{2})?\.mp3$` — unchanged
- `substituteVoice` / `{voice}` templating — unchanged
- `validation.ts`, `referenceVoice`, `scanRaceEngineerVoices`, `scanDriverNames` — unchanged
- per-callout skipping — composes with no special case, and since 2026-09-01 it is #1064's per-voice `"skip": true` rather than a pack-level list here

Two alternatives were rejected. **Absolute paths in the manifest** would make the escape guard meaningless and leak machine paths into a structure that is compared and serialized. **Copying the bundled default into AppData purely for uniformity** would cost an 8.1 MB copy per ecosystem on every plugin update and make the one voice that must always exist user-deletable.

### Voice id collisions

Deterministic and logged, never a crash:

- A voice id provided by both the plugin root and a pack → plugin root wins.
- The same voice id provided by two packs → the pack whose id sorts first wins.

The loser is reported in the Settings voices list, so a user who sideloaded a colliding pack can see why it is inert.

## Manifest composition and engine reload

The compiled-in manifest (`import audioAssetsManifest from "@iracedeck/audio-assets/manifest.json"`) becomes the **built-in half**: sfx, plus whatever voice is bundled in that release. A scanner walks the packs root and produces the same `AudioAssetsManifest` shape per pack; the engine consumes the union of their `clips`. (`AudioAssetsManifest` has no `skipped` field, so the union was never implementable as written — and with `skipped` removed from the pack format above there is nothing to union.)

`initializeAudioScenarios` stays once-only. The engine gains `setManifest(manifest)`:

1. rebuild `clipSet`
2. re-derive every manifest-backed pool from its recorded `(group, base)`
3. reset the per-pool no-repeat trackers, exactly as an active-voice change already does

In-flight callouts are unaffected — their ops are already expanded to concrete paths.

**The zero-voice state already works and is not new.** `resolveActiveRaceEngineerVoice` returns `null` for an empty list and callers already suppress voice scenarios; `referenceVoice()` returns `null`, so `definePoolFromManifest`'s reference-voice typo warnings stay quiet. A plugin with no voice installed is quiet, not broken. `resolveActiveRaceEngineerVoice` also already falls back to the first available voice when the persisted id is gone, which covers pack removal.

After every refresh the plugin republishes `_raceEngineerVoices` and `_driverNames`. The picker is already `<ird-voice-select setting="raceEngineerVoice" voices="_raceEngineerVoices">`, fed by that passthrough global, so the dropdown updates live with **no new UI mechanism**.

## Catalog

`https://iracedeck.com/voice-catalog.json`, generated into `packages/website/public/` by a build script, exactly as `changelog.json` is today.

**The catalog lists iRaceDeck's own packs and nothing else — settled 2026-09-02.** It is not a directory of what exists in the world. There is therefore no submission route, no curation policy, no verification tier and no support obligation to design, and the work that would have gone into those is simply not in scope. A third-party pack reaches a user by **sideload only**: they obtain it from its author, drop it in the packs folder, and the settings UI shows it with a provenance badge saying where it came from. We host nothing on anyone's behalf and endorse nothing.

The name is deliberately **not** `voice-packs.json`: that differs from the per-pack `voice-pack.json` manifest by one character, and the two would be confused in code, in documentation and in support threads, where a reader has to notice a plural to know which file is meant. `voice-catalog.json` cannot be mistaken for the file inside a pack.

```json
{
  "schema": 1,
  "packs": [
    {
      "id": "luca",
      "label": "Luca",
      "version": "1.2.0",
      "description": "Calm, understated. Fewer words.",
      "voices": [{ "id": "luca", "label": "Luca" }],
      "bytes": 13107200,
      "sha256": "…",
      "url": "https://github.com/niklam/iRaceDeck/releases/download/voices-luca-1.2.0/luca-1.2.0.zip",
      "minPluginVersion": "3.2.0"
    }
  ]
}
```

The client mirrors `changelog-feed-client.ts`: URL as a module constant, request timeout, never throws, and every failure mode — refused, timed out, HTTP error, not JSON, wrong shape — collapses to the same answer, "we do not know". Cached in memory with an ETag; the routine "anything new?" check is a 304 and a few hundred bytes.

**No setting gates the catalog fetch in stage 2 — settled 2026-09-02, and stage 3 must revisit it.** The service keeps an injected `isEnabled` predicate, mirroring `update-check-service.ts`, but stage 2 wires it to a constant true. The reason is that in Release N *every* catalog fetch is user-initiated: opening the settings window, pressing Refresh, pressing Install. The one path that is not user-initiated — the first-run install — **downloads nothing in this release**, because an empty voices folder plus a bundled pack seeds by copy. So there is no launch-time network call to opt out of, and adding a switch would be a second privacy toggle for one domain that does nothing a user can observe.

Two things follow, and the second is a trap:

- **Do not reuse `updateCheck`.** It is presented on the What's New tab (`global-common-updates.ejs`) as a release-notes control. Silently widening it so that declining update notifications also removes the ability to install a voice is precisely the kind of surprise that produces support threads about a feature the user never connected to the switch they flipped.
- **Stage 3 changes the answer.** Once the bundle is dropped, a fresh install has an empty voices folder and *no* bundled pack, so first-run must download — at launch, unprompted. At that point "no setting" becomes "phones home on every launch with no way to stop it", and stage 3 must either add the setting or make that first fetch something the user acts on. Decide it there; do not let it arrive by default.

`minPluginVersion` is compared with `semver`, already a `deck-core` dependency, so a pack needing a newer runtime is listed but not offered.

**Archive hosting is GitHub Releases**, not `packages/website/public/`. A ~7.9 MB zip per pack version in the website repo would bloat every Firebase deploy and the git history. The catalog itself stays on iracedeck.com, so the fixed-URL rule still holds: one constant URL the plugin trusts, pointing at release assets.

## Install pipeline

1. **Decide.** Compare the catalog entry's `sha256` against the installed `.install.json`. Equal → nothing to do. This is the whole answer to "don't re-download on every plugin version": packs live outside the plugin folder, the catalog is versioned per pack rather than per release, and the test is a content hash.
2. **Download** to `.tmp\<id>-<sha>.zip`, hashing the stream as it arrives, with a request timeout and a maximum-bytes cap.
3. **Verify** the hash. Mismatch → discard, report, do not retry automatically.
4. **Extract** to `.tmp\<id>-<sha>\`, validating every entry ourselves regardless of what the library does: relative only, no `..` segment, no absolute path, no drive letter or UNC prefix, must resolve inside the target directory, and its name must end in `.mp3` or `.json`. Enforce caps on entry count, total uncompressed bytes, and per-entry compression ratio.
5. **Validate content.** `voice-pack.json` present, parses, `schema` understood, `id` matches the requested pack, at least one `voice/<id>/` directory present.
6. **Stop voice playback** so the active voice's files are not held open across the swap.
7. **Swap.** Move any existing `Voices\<id>` to `.trash\<id>-<timestamp>`, then rename the staged directory into place. `fs.rename` cannot overwrite a directory on Windows, and a file the audio engine had open may resist deletion — so deletion is not part of the critical path. `.trash` and `.tmp` are swept at the next plugin start.
8. **Write `.install.json`.**
9. **Refresh** — rescan, `setManifest`, republish `_raceEngineerVoices` / `_driverNames`.

A failure at any step leaves the previously installed pack untouched: nothing is removed until a complete, verified replacement is staged.

### Concurrent installs

Because the packs folder is shared across ecosystems, a user running two plugins can have both attempt the first-run install at once. The atomic swap already makes this safe — both write identical, hash-verified content — but two simultaneous 7.9 MB downloads are waste. A best-effort lock file in `.tmp` (create-exclusive, with a stale timeout) makes the second process wait and then find the work already done. If the lock is unavailable the install proceeds anyway; correctness never depends on it.

## Build-time packaging

A new script in `@iracedeck/audio-assets` runs each voice through the **existing** radio-filter and encode pipeline via `buildVoiceTreeTasks`, so a packaged clip is byte-identical to what the plugin would otherwise have shipped. It then emits `voice-pack.json`, zips, and writes the checksum and catalog entry.

**Packaging must be byte-deterministic** — the same clips in must produce the same archive bytes out. Zip records modification times and entry order, so the packer pins entry order (sorted), normalizes every timestamp to a constant, fixes the compression level, emits no extra fields or platform attributes, and serializes `voice-pack.json` with sorted keys and LF endings.

This is not a nicety: a non-deterministic packer republishes a new hash on every build, and every user re-downloads 7.9 MB for nothing — precisely the problem this design exists to avoid. It gets a test: package twice, compare hashes.

Which voices are bundled versus published is **one list in one place**, and the plugin build's audio copy step filters to the bundled set. That list is the only thing separating "ships with the plugin" from "downloadable".

## Publishing archives — from the release workflow, never by hand (added 2026-09-04, [#1116](https://github.com/niklam/iracedeck/issues/1116))

The packaging section above ends with an archive on disk and a committed catalog entry naming a release that does not exist until someone creates it. Stage 2 shipped that as a by-hand upload, and the 3.2.0 catalog was committed pointing at `voices-default-1.0.0` before any such release existed. Publication is now part of the plugin release, with an escape hatch for a pack that has to ship between releases.

**One release object per pack version, created only from inside a release run.** The archive keeps the `voices-<id>-<version>` release and the immutable URL the packer already writes; what changes is who creates it. A step in the plugin build job, after `Build` and before the dev-dependency prune (the packer's `fflate` and `ffmpeg-static` are devDependencies, and the build has just warmed the encode cache), runs `scripts/publish-voice-packs.mjs` over every entry in `VOICE_PACKS`. The website deploy job already waits for that job, so the catalog cannot go live naming an archive that was not attached. The pack's cadence is therefore the plugin's by construction: nothing is published until iRaceDeck is released.

Rejected: attaching the archive to the plugin release itself (`v3.2.0/default-1.0.0.zip`). It reads as the more literal "tied to the release", but a pack updated between releases then has nothing to hang from, so the design grows a second tag flavour and two URL-resolution rules, one for "ships with the plugin" and one for "published on its own", and every plugin release carries a duplicate copy of every pack. The tie this design wants is in the process, not in the release object.

**The script decides per pack and stops at the first outcome.**

1. Pack through `packVoice` into a scratch directory, catalog entry to scratch too. CI never rewrites the committed entry.
2. The fresh sha256 and byte count must equal the committed `catalog/<id>.json`. A mismatch fails the job before anything is published and names the fix: `pack:voice`, bump `version` if the clips changed, commit. It is a repo-state error that needs a commit anyway, and failing before the plugins attach keeps the tag clean.
3. Not publishing this run: attach the archives as a workflow artifact and upload nothing. This is the dry run.
4. The release `voices-<id>-<version>` lacks the asset: create it with `--latest=false` and upload. The flag is load-bearing. The website's three plugin download links resolve through `/releases/latest/download/`, and GitHub hands a new release the latest slot by default, so a voice-pack release created the ordinary way would 404 every plugin download. A test pins the flag.
5. The asset is present: download and hash it. Same bytes: skip, which covers a re-run and every later plugin release with no pack change. Different bytes: fail. A published version's bytes never change, which is `voice-packs.mjs`'s own rule, and this is where a forgotten version bump is caught.

"Publishing this run" is true on a `v*` tag, release candidates included, matching the plugin attach step rather than the stable-only site deploy, so a candidate gets the reproducibility check and the stable tag finds the archive already there. It is also true on a manual run whose `publish` input is on. The script never infers it.

**Between releases: a manual workflow, and it must not deploy master.** `publish-voice-packs.yml` is dispatch-only with one `publish` input, off by default. Off, it is the dry run, to be run once before the 3.2.0 tag: the whole design rests on the runner reproducing the maintainer's bytes (the committed entry pins `6087bed0…f535`, 7,879,224 bytes), and a red result is a finding to bring back rather than something the step papers over. On, it builds, runs the same script, and then deploys the website so the catalog offers the new pack. That deploy would be the first thing ever to build the site from master, and master carries documentation for unreleased features, so the workflow builds the site from the **latest stable plugin tag** with only `packages/audio-assets/catalog/` taken from master. What goes live is the site exactly as released plus the catalog as it is now.

## Rollout — bundled packs seed, catalog packs download

The rule is permanent: **an empty `Voices\` plus a bundled pack means install it by copying, not downloading.** In a release that bundles nothing it is a no-op, and it means a voice can be bundled again at any time — an offline installer variant, say — with no code change.

Staged over two releases:

- **Release N** still bundles `default` and seeds it by copy. Nobody's engineer disappears, online or offline. The download path ships and is exercised by every additional voice.
- **Release N+1** drops the bundle. Every upgrading user already has `default` in AppData, so there is nothing to fetch; new installs take the download path, which by then has a proven retry story.

**Where this stands, 2026-09-02.** Implementation is staged separately from the release rollout above, and the two must not be run together in the reader's head — the stage numbers below are ours, the release letters are the user-visible rollout:

- **Stage 1 — shipped**, in the 3.2.0 development line (#1097). The sideload half: packs live outside the plugin folder, are scanned and validated, and appear in the settings window with a Rescan button. No catalog, no download, no install pipeline. The no-window structural guard shipped here too, deliberately early — it is cheap to build alongside the first module that could violate it and expensive to retrofit once several can.
- **Stage 2 — the work this amendment authorises.** The catalog, the fetch client, the install pipeline, the deterministic build-time packer, and the Install / Update / Remove UI. This **is Release N**: `default` is published to the catalog *and* stays bundled in the distributable, so a user who updates while offline keeps their engineer.
- **Stage 3 — a later release.** Drop `default` from the distributable. This is Release N+1, and because `default` is a catalog entry like any other rather than a special case, the only thing that changes is the bundled list.

**Stage 3 inherits two obligations that are inert until it lands, and both fail silently if forgotten.** Neither is a defect in stage 2; each is a consequence of removing the bundle, which is why they are recorded here rather than fixed early.

1. **The catalog fetch gains a launch-time, unprompted path** and therefore needs either a setting or a user-initiated first fetch. Reasoning in the *Catalog* section above.
2. **The startup sweep and the seed run inside the plugin's settings-store-ready block**, so on the fail-closed unreadable-settings path neither executes. Today that is harmless — `default` is bundled and plays from root 1 whatever happens in AppData. Once the bundle is gone, the same path leaves a user with **no voice at all**, and the settings failure that caused it says nothing about audio, so the symptom and the cause look unrelated. Stage 3 must either move the seed out of that gate or make the failure explicit.

**Vixen is not published in stage 2 — settled 2026-09-02.** It exists as a generated test voice on the `vixen` branch, has not had the radio-filter pass, and publishing it is a separate decision about what iRaceDeck distributes rather than a consequence of the catalog existing. It is not a catalog entry, not a bundled pack, and not a stage-2 deliverable.

The size win lands one release later. What it buys is a migration with no network dependency at the moment the entire install base is exposed to it. Without it, the release that stops bundling audio silently breaks the Race Engineer for every user who happens to be offline when they update.

## Download while iRacing is running — and the no-window rule

The install **runs while iRacing is running**. Deferring it, the way #870 defers the changelog, would mean a driver who updates and immediately races has a mute engineer for exactly the session they would notice it in — and on the upgrade release, that is most of the install base.

The corollary is a hard constraint: **no code path in this feature may open a window.** Not `openUrl`, not the settings-window launcher, on any outcome including failure. `plugin.ts` today opens nothing on its own except the changelog, which is already sim-gated, and `settingsWindow.open()` is reachable only from a user gesture. A structural test asserts the installer modules import neither — the same technique already used to forbid `simhub-probe` doing a private fetch.

Progress is therefore **passive only**, in surfaces the user has already chosen to look at:

| Surface | Visible when | Content |
|---|---|---|
| `_warnings` banner | a Property Inspector is open | `info`: *"Downloading the Race Engineer voice… 4.2 / 7.9 MB"*; `error` with a retry hint on failure |
| Settings window, Race Engineer card | the user opened it | Full state, per-pack, with Install / Update / Retry |
| Pit Crew key | always, including mid-race | A "downloading" / "no voice installed" state in the status bar `generatePitCrewSvg` already renders from global state |

During a race the download is silent by construction. That is the intended behaviour, not a gap.

The banner is cheaper than it looks: `_warnings` is run-scoped since #1014, and a write touching only run-scoped keys skips the settings-store save entirely, so a 1 Hz progress update costs a listener fan-out and a loopback push and never a disk write. The richer `_voicePackStatus` payload the Settings card reads is enrolled in `RUN_SCOPED_SETTING_KEYS` for the same reason — it is an observation about this run, not user state.

## Settings UI

The Race Engineer card gains a Voices section: installed packs (label, version, size, a provenance badge distinguishing catalog from sideloaded), available packs from the catalog with Install / Update, a Refresh button, and the packs folder path with an Open folder button.

New settings-window commands, validated and routed by `createSettingsWindowCommandHandler`: `voicePackRefresh`, `voicePackInstall { id }`, `voicePackRemove { id }`, `openVoicePacksFolder`. The existing `ird-open-folder` sends `openSettingsFolder` and the handler supplies its own injected path; the new command follows that shape — the page never supplies a path. The Ulanzi `sendToPlugin` marker trap does not apply: these arrive through the loopback fake host, not the host socket.

A sideloaded pack is unsigned and unverified. The UI says where a pack came from rather than presenting the two as equivalent.

## Failure modes

| Situation | Behaviour |
|---|---|
| Offline on first run | No voice; `info` banner explaining, retry button, re-attempted next start. Every non-audio feature unaffected. |
| Offline on the upgrade release | Cannot happen — release N seeds from the bundle. |
| Catalog unreachable | "We do not know": installed packs keep working, nothing is offered. |
| Hash mismatch | Discard, report, no automatic retry. |
| Malformed / hostile archive | Rejected during extraction; the installed pack is untouched. |
| Disk full mid-extract | Staged directory discarded; installed pack untouched. |
| Active voice's pack removed | `resolveActiveRaceEngineerVoice` already falls back to the first available; `null` when none, and voice scenarios suppress. |
| Two plugins install at once | Lock file avoids the duplicate download; the atomic swap makes it safe either way. |

## Testing

- Multi-root resolution, including that a pack cannot escape its root or shadow a bundled voice.
- Manifest union and `setManifest` reload: pools re-derived, no-repeat trackers reset, in-flight fires unaffected.
- Zero-voice startup stays quiet — no typo warnings, no aborted-callout error spam.
- Voice-id collision precedence, both plugin-vs-pack and pack-vs-pack.
- Entry-name validation: `..`, absolute, drive-lettered, UNC, and out-of-tree targets all rejected; caps enforced.
- Install pipeline: hash mismatch, malformed archive, missing `voice-pack.json`, mid-extract failure — installed pack survives every one.
- Skip-when-unchanged: same `sha256` performs no download.
- Packer determinism: two builds, identical hashes.
- Seed-by-copy on an empty folder with a bundled pack; no-op when nothing is bundled.
- Structural test: installer modules import neither `openUrl` nor the settings-window launcher.

## Affected artifacts

- **`@iracedeck/audio-service`** — ordered roots in place of a single `basePath`, per-root escape guard.
- **`@iracedeck/audio-scenarios`** — `setManifest` reload; manifest union helpers.
- **`@iracedeck/deck-core`** — pack scanner, catalog client, installer, zip extraction and validation, packs-root resolution, `_voicePackStatus` as a run-scoped key, new settings-window commands.
- **`@iracedeck/audio-assets`** — the deterministic packaging script and the bundled-vs-published list.
- **`@iracedeck/pi-components`** — the Voices section in `race-engineer-settings.ejs`, plus the components it needs.
- **All three plugins** — packs root wired into `initializeAudio`; scan, seed, first-run install and refresh in the startup sequence; audio copy step filtered to the bundled set.
- **`@iracedeck/website`** — `voice-catalog.json` generation and a voices page. The third-party policy is **already published** in the *Third-Party Voice Packs* section of `docs/features/race-engineer-voices.md` and needs nothing further, since the catalog lists only our own packs.
- **Release process** — the packaging step, the publishing step the release workflow now performs (see *Publishing archives*, #1116), and the two-release rollout above.
- **Docs and rules** — `audio-assets/CLAUDE.md`, `.claude/rules/race-engineer-callouts.md`, `.claude/rules/settings-window.md` (new commands), `THIRD-PARTY-LICENSES.md` (`fflate`), and the plugin rollup `external` entry.
- **Changelog** — user-facing in both releases: the voices feature in N, the size reduction in N+1.

## Open questions

1. **Is `default` also published to the catalog? — settled 2026-09-02: yes.** It is listed like any other pack rather than special-cased. That is what makes stage 3 a one-line change to the bundled list instead of a new code path, and it is why a new install after the bundle is dropped has something to fetch at all.
2. **Licensing policy for third-party packs — settled 2026-09-01.** A third-party pack belongs to its author. It is distributed separately, by them, on their terms, and iRaceDeck has nothing to do with it beyond being able to play it — no hosting, no endorsement, no verification, no support obligation. Published where a user meets the question rather than only here: the *Third-Party Voice Packs* section of `docs/features/race-engineer-voices.md`. This settles the **sideload** half, which is the half that shipped in stage 1. The catalog half needed a position of its own because listing a pack is an act of selection that implies its author's consent — and as of 2026-09-02 that question is **moot rather than answered**: the catalog lists only our own packs, so the situation never arises and there is nothing further to write. Note which way round that is. It is not that we decided third-party listings are acceptable under some policy; it is that we decided not to list them, which is why no policy is needed. Reintroducing third-party catalog entries later would reopen this in full.
3. **Does removing a pack need a confirmation? — settled 2026-09-02: yes, an inline two-step.** Pressing Remove turns the button into "Remove — are you sure?"; a second press removes, anything else cancels. Deliberately not a modal: the asymmetry is real but modest — the pack is reproducible from the catalog, so this warrants a speed bump rather than a ceremony — and a state-driven button reuses the `ird-enable-feature` shape the rules already require these buttons to follow, so it needs no new component. It is the one control in the settings window that does not apply immediately, and that inconsistency is the point: everything else there is a preference a user can flip back, while this one deletes ~8 MB they then wait to re-download.
