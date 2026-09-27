# Terse, the Second iRaceDeck Voice Pack

> **Issue:** [#999](https://github.com/niklam/iracedeck/issues/999) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

The Race Engineer speaks in full sentences: "Blue flag. Faster car approaching." A driver who already knows what a blue flag means pays for the explanation mid-corner, and a long line can still be talking when the next event happens. #999 asks for a voice that says the same things in radio shorthand.

A contributor authored one in PR #1166 as a second voice folder, `voice/terse/`, beside `default`. It was cut before #1034 stage 3 and #1144, so it predates voice packs as the way a voice ships: it has no pack entry, no catalog entry and no composite id, and it lacks six groups master has added since (`car-number`, `caution`, `numbers-degrees`, `numbers-percent`, `openers`, `tire-wear`). The PR was copied as-is to `feature/999-terse-spotter-pack` and rebased onto master on 2026-09-26; the work continues there.

It is also the first time a second first-party pack exists, which raises a question the single-pack world never had to answer: how a user tells our voices from anyone else's in the voice dropdown.

## Goals

- Ship the terse voice as its own catalog pack that a user installs on demand and that then updates itself like any catalog-installed pack.
- Give it parity with Default: every scenario Default speaks, Terse speaks.
- Race-time calls are as short as possible.
- Every iRaceDeck voice reads "iRaceDeck: <pack label>" in the dropdown and sorts above every other pack, whatever the others are called.

## Out of scope

- Renaming the `default` pack to `iracedeck-default`. It is a published contract (every user's stored `default::default`, the installed `…\Voices\default` folders and their records, the live catalog every older plugin reads, the `voices-default-*` releases), and renaming it buys an id no user sees. It gets its own issue and its own decision.
- The third-party naming rule — #1147 keeps it (see *Labels and order*).
- Installing Terse automatically. `default` stays the only pack the launch step installs unasked.
- Other languages, and the voice-config authoring tool designed in #1035.
- Reordering or re-badging the settings window's Installed Voices list.
- Changing the generated pack reference on the website: it stays Default's, because Default is the reference voice pack authors write against.

## Decisions

### The pack

**Its own pack, installed on demand.** A second voice inside `default` would reach every user unasked, but every user would download ~1,500 more clips, and any wording change to Terse would bump Default's version. A separate pack auto-installed at launch would need `ENSURED_VOICE_PACK_ID` to become a list and would ship the bytes to everyone anyway, reversing #1034's reasoning. As its own catalog pack it reaches only the users who ask for it, and nothing in deck-core's install path changes: the launch step already updates every catalog pack whose install record is behind the catalog (`voice-pack-launch.ts`, the `update` verdict), so a user who installed Terse gets each published version at their next start. Only the first install is theirs to make, from the Voice Packs card's "Available to Download" list.

**Ids: pack `iracedeck-terse`, voice `shawn`, so `iracedeck-terse::shawn`.** A pack id and a voice id are permanent — a user's selection stores the composite — so they are chosen once. The pack names the style and each voice in it names the engineer speaking, so a later terse voice for another engineer joins the same pack under its own id with no rename. The two packs cannot share one pack id: a pack is one archive at one version, which is exactly the coupling rejected above. The voice id is also the authored directory `voice/<id>/` — the authored tree is flat by voice id, only the runtime is namespaced by pack (#1144) — so it cannot be `default`, which Default's own directory holds; `iracedeck-terse::default` would need the authored tree made pack-scoped first, a refactor of the generator, the manifests, the packer and the cache that this issue does not take on.

**New first-party packs are named `iracedeck-<name>`; `default` is the one legacy exception.** The catalog lists only our packs, but a third-party pack reaches a user by sideload and can choose any id; a prefix keeps ours recognisable by id as well as by provenance. The prefix is a naming rule, not a trust decision — trust is the install record (below).

**The registry entry.** `VOICE_PACKS` gains `{ id: "iracedeck-terse", label: "Default (Terse)", author: "iRaceDeck", voices: ["shawn"], bundled: false }` at version `1.0.0`. Everything downstream is already generic over the registry: `pack:voice` writes `catalog/iracedeck-terse.json`, `scripts/publish-voice-packs.mjs` and both workflows publish it as `voices-iracedeck-terse-1.0.0`, the website's `voice-catalog.json` lists it, and the harness can audition it.

**The branch's `terse` becomes `shawn` without re-cutting a clip.** `voice/terse/` → `voice/shawn/`, `configs/terse.voice.json` → `configs/shawn.voice.json` with the label "Default (Terse)", and every `generate.manifest.json` key `voice/terse/…` rekeyed to `voice/shawn/…`. The cache is keyed by clip path, so the rekey is what keeps the rename free; `generate:dry-run` proving zero would-generate for the voice is the check.

### Content

**Parity.** Terse covers every scenario Default speaks. The six missing groups get Terse wording, and the branch's `session-start-temp-numbers` folds into master's `numbers-degrees` (its two orphaned `session-start/degrees-*` clips are what fails `script-coverage.test.ts` today).

**The race-time rule.** A call made while a session is running carries the fact and nothing else: no greeting, no driver name, no encouragement, no explanation of what a flag or a state means. "Blue flag.", "Pits open.", "Meatball." Where a fact needs a number, the number and its unit, no framing.

**Outside race time the PR's wording stands.** The welcome, the per-name `session-start-greeting` / `race-start-greeting` / `race-end-greeting` lines and the session-start briefing keep what the PR authored (mostly Default's text), decided 2026-09-26. The one change there is the typo in `welcome/greeting-01` ("enginneer").

**Authoring.** Claude drafts the wording in batches by family — the six missing groups first, then a rewrite list of existing race-time lines that break the rule — and the maintainer approves each batch before any clip is generated. Generation is scoped to the approved group, dry-run first, since ElevenLabs is a paid API. The contributor auditions on the branch.

### Completeness

**Every voice in `VOICE_PACKS` is held to completeness, not only `default`.** `bundled-scripts.test.ts` checks today that the reference voice has a script entry behind every scenario contract (`VOICE = "default"`). It is generalised to every first-party voice, so Terse cannot fall behind Default as new callouts land without the suite going red. Third-party packs stay unchecked, as now. `scripts/lib/catalog-engine.mjs` keeps `BUNDLED_VOICE = "default"`: it feeds the generated pack reference, which stays the reference voice's.

### Labels and order

**First-party is decided by the install record.** A pack is iRaceDeck's when its `.install.json` says `catalog` or `bundled-seed`, or it was found under the development voice root (provenance `development`). The record is written by our installer only, and the extractor drops any copy shipped inside an archive, so a pack cannot claim it about itself; it works offline, unlike reading the live catalog, and it does not refuse a hand-installed copy of our own pack the way a reserved id prefix would. The id prefix above plays no part in the decision.

**Every voice of a first-party pack is labelled "iRaceDeck: <pack label>".** "iRaceDeck: Default" and "iRaceDeck: Default (Terse)". The plugin adds the prefix; the packs' own labels stay "Default" and "Default (Terse)". The rule is one deck-core function beside `voiceDisplayLabels`, which all three plugins already call, and it keeps that function's property: an entry's name depends on its own pack's manifest and record, never on what else is installed.

**The plugin publishes `_raceEngineerVoices` sorted:** the managed pack first, then the other first-party packs by label, then every other voice by label. `ird-voice-select` renders options in the order it receives them, so the order is decided once, in deck-core, and not in the PI. Only labels and order change; no stored selection is read or written differently.

**#1147 keeps the third-party half.** Its rule — the managed pack keeps a bare label, every other voice becomes `<pack label>: <voice label>` — collides with Default now carrying a prefix. #999 owns the first-party label; #1147 is narrowed to third-party voices, and its issue gets a comment saying so.

**Accepted limits.** A folder with a hand-written `.install.json` is treated as ours; the provenance badge has the same limit, and forging it takes a deliberate edit on the user's own machine. A sideload may still put "iRaceDeck: X" in its own manifest label; it sorts with the third-party packs, so it can look like ours but never sit among them.

## Failure modes

| Situation | Behaviour |
| --- | --- |
| User selects Terse, then removes the pack | The stored `iracedeck-terse::shawn` is kept; `resolveActiveRaceEngineerVoice` falls back to `default::default` read-only, exactly as for any absent voice. Reinstalling restores the choice. |
| Catalog unreachable on a start | Installed packs keep their labels and order (the record is on disk); Terse is simply not offered for install until the catalog answers. |
| A new callout lands in Default without Terse wording | The generalised completeness test fails on the branch that adds it. |
| A sideload labels itself "iRaceDeck: Pro" | Shown with that label, sorted below every first-party voice. |
| A copy of Terse placed by hand, no record | Treated as third-party: its own label, sorted with the others, never updated by the launch step. |

## Testing

Automated:

- The first-party check: `catalog`, `bundled-seed` and `development` qualify; `sideload`, and a record whose `id` does not match the manifest, do not.
- Labels: both voices of a first-party pack read "iRaceDeck: <pack label>"; a third-party pack's labels are unchanged by this issue.
- Order: a third-party pack labelled "Aaa" sorts below both iRaceDeck packs, and the managed pack precedes the other first-party packs.
- The generalised completeness test covers `shawn`, with a positive control: deleting one of Terse's script entries makes it fail.
- `generate:dry-run` after the rename: zero would-generate for `shawn`, and the count for `default` unchanged from master's.
- `pack:voice iracedeck-terse` is byte-deterministic and its catalog entry verifies in the publish script's dry run; `pnpm lint:pack` over the staged pack.
- The existing `callout-scripts.test.ts` and `script-coverage.test.ts` pass for `shawn` (they already iterate every authored voice).

Manual (maintainer, on hardware):

- Install Terse from the Voice Packs card; the dropdown shows "iRaceDeck: Default" then "iRaceDeck: Default (Terse)" above any sideloaded pack.
- Select Terse and drive a session: race-time calls are terse and carry no greeting; the greetings and the briefing are the PR's.
- Run the *Publish voice packs* workflow as a dry run for `1.0.0`; after publishing, bump to `1.0.1` in a dry run and confirm an installed copy would update.

## Affected artifacts

- `@iracedeck/audio-assets`: `VOICE_PACKS`, `configs/shawn.voice.json`, `voice/shawn/`, `generate.manifest.json`, both manifests, `catalog/iracedeck-terse.json`, `packages/audio-assets/CLAUDE.md`.
- `@iracedeck/audio-scenarios`: the generalised `bundled-scripts.test.ts`.
- `@iracedeck/deck-core`: the first-party label and order rule beside `voice-labels.ts`; its `CLAUDE.md`.
- The three plugins' `plugin.ts`, which publish the sorted list.
- Website: a page for the Terse pack, the voice list in the Pit Crew action doc, `changelog.mdx` (a Features line for the pack, an Improvements line for the labels and order).
- Rules: `.claude/rules/race-engineer-callouts.md` and `.claude/rules/stream-deck-actions.md` (`ird-voice-select` labels), where they name `default` as the only voice held to completeness or the only unprefixed label.
- A follow-up issue for renaming `default` to `iracedeck-default`; a comment on #1147.
