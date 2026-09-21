# Voice Ids Namespaced by Pack

> **Issue:** [#1144](https://github.com/niklam/iracedeck/issues/1144) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

A voice id is global across every installed pack. The scanner lets one pack claim each id and lists every later pack declaring it under problems; since #1034 stage 3 the managed pack claims first and the rest follow alphabetically. The rule exists because clip resolution is by logical path — `voice/<voice id>/<group>/<name>.mp3` against an ordered list of roots, one per pack, first root holding the path wins — so two packs providing one voice id would make the user's choice decide nothing.

The consequence is that two authors who both call a voice `matt` cannot both be installed, and the one that sorts later is muted with a problem row as the only explanation. Manual test 5 of #1034 stage 3 hit exactly this (2026-09-08) and Niklas ruled it the wrong model. There are no third-party packs yet, which is why the fix belongs in 3.3.0: every stored selection in the field is the bare `default`.

## Goals

- Two packs may each provide a voice with the same bare id; both are installed, both selectable.
- Pack authors change nothing: `voice-pack.json` declares bare voice ids, clips live under `voice/<voice id>/…`.
- Existing installs keep their selected voice across the upgrade without noticing.

## Non-goals

- Renaming our pack (settled 2026-09-08: it stays `default`, so its voice is `default::default`).
- Changing the clip path grammar inside a pack, the packer, or the published archives.

## Decisions

**The composite id `<pack id>::<voice id>` is the external identity of a voice.** It is what the scanner reports, what `_raceEngineerVoices` and `_voiceLabels` carry, what `raceEngineerVoice` stores, and what the driver-name lists are keyed by. `DEFAULT_RACE_ENGINEER_VOICE` becomes `default::default`. The dropdown shows the pack's chosen label for the voice, never the raw composite id. How that label is built is not this issue's decision: `_voiceLabels` is keyed by the composite id and the labelling rule is left as it is, because #1147 (filed after this spec) owns it — every third-party voice named `<pack label>: <voice label>`. Until #1147 lands, two packs that label a voice identically show two identical entries, which the current rule already allows for two different voice ids (amended 2026-09-21; this paragraph first proposed appending the pack's label in parentheses on a collision).

**`::` can never appear in a pack id or a voice id.** Both are already lowercase kebab-case (`^[a-z][a-z0-9-]*$`), so the id grammar excludes the separator. The schemas (`VoicePackManifestSchema`, `VoicePackCatalogEntrySchema`) and `lint:pack` report an id containing `::` with the separator named as the reason, before the general kebab-case message. That way an author who tried to qualify an id by hand is told why, not just that the id is malformed. The separator is two characters so that a single colon stays available should the id grammar ever widen.

**The audio service binds each voice to its pack's root.** The logical clip path the engine sees carries the composite id: the voice-pack service rewrites each pack's `voice/<voice id>/…` clips to `voice/<pack id>::<voice id>/…` before handing them to the engine as manifest fragments. So `{voice}` substitution, the manifest's voice list, the driver-name union and the per-voice script map all work unchanged with composite ids, and two packs' `matt` clips can never merge into one pool. Each pack's audio root carries a `voices` binding (composite id → bare voice id). The audio service resolves a `voice/<composite>/…` path only in the root bound to that composite, as `voice/<bare>/…` checked against that root's clip allow-list. A bound root serves nothing through the ordered walk, so a pack can no longer be reached by a path that names another pack's voice. Clips outside `voice/` (sfx) resolve as today. Rejected: qualifying the clip path inside the pack (`voice/<pack>/<voice>/…`), which would move the plugin's problem onto every author and the packer.

**The scanner stops refusing duplicates across packs.** `priorityPacks`, the reserved-voice rule and the "already provided by pack …" problem go. The reserved-voice rule's dependents go with it: `reservedVoices`, the service's bundled-script read, the bundled-seed listing branch (unreachable since #1034 stage 3 reserves nothing), and `lint:pack`'s managed-voice-id check. What remains is that one pack may not declare the same voice id twice, and the development root's shadowing of a same-id pack under the packs root (#1143), which is about pack ids, not voice ids. `isManagedVoicePack` keeps working on the pack id.

**Migration.** A stored `raceEngineerVoice` that contains no `::` is qualified by one rule, `qualifyVoiceId`: unchanged when the bare value is itself an available voice (a voice a plugin bundles, or the scenario harness's source-tree voice, is listed bare and must stay pickable), otherwise `default::<value>` when the managed pack provides that voice, otherwise the first pack in alphabetical order that provides it, otherwise unchanged (to fall through `resolveActiveRaceEngineerVoice`'s existing fallback). Managed first, then alphabetical, is exactly the order that decided who won a voice id before 3.3.0. So the voice a user was hearing, including a sideloaded one, is the voice they keep. The migration in `global-settings-migrations.ts` persists that rewrite once the store is ready and only while the managed pack is present in the scan. Until then "managed first" cannot be judged, and a leftover sideload that declares the same bare id would otherwise be written in for good. It needs no marker: it is idempotent, since a composite value is never touched. It re-runs after every voice-pack scan and settings arrival, so a stored value whose pack arrives later (a fresh launch still downloading `default`) is still qualified when it does. `resolveActiveRaceEngineerVoice` applies the same rule at read time, so a hand-edited settings file resolves before the write lands. The driver name is a single global `driverName`, not a per-voice key, so nothing else migrates (amended 2026-09-21: the managed-only mapping and the passthrough marker were replaced).

## Failure modes

| Situation                                                     | Behaviour                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Two packs both provide `matt`                                 | Both listed and selectable; each plays its own clips. Labels follow the current rule until #1147. |
| A pack id or voice id contains `::`                           | Refused by the scanner with the reason; `lint:pack` says the same.                                |
| Stored `raceEngineerVoice` is a bare id the managed pack has  | Migrated to `default::<id>`.                                                                      |
| Stored `raceEngineerVoice` is a bare id only another pack has | Migrated to `<first such pack>::<id>`, alphabetically.                                            |
| Stored `raceEngineerVoice` is a bare id no pack has           | Falls back as today (managed voice, then the first available).                                    |
| Settings window from an older build sends a bare id           | Accepted at runtime through the same mapping.                                                     |

## Testing

- Scanner: two packs with the same voice id both load; a `::` in either id is refused.
- Audio service: the same bare voice id in two packs resolves to each pack's own root through its composite path; a bound root is never reached by the ordered walk.
- Migration: bare → composite for a voice the managed pack provides; bare → the alphabetically first providing pack otherwise; untouched when no pack provides it; a composite value is never rewritten.
- `lint:pack`: the `::` rule.
- Website: the name-clash bullet is gone from "When a Pack Does Not Appear"; the format page states the `::` rule.

## Affected artifacts

As listed on the issue: deck-core (scanner, service, settings, migration, launch step), audio-service, audio-scenarios, callout-script / audio-assets schemas and `lint:pack`, pi-components selects and list, the three plugins, the harness, website docs and changelog, the rules that describe voice ids.
