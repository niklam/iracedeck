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

**The composite id `<pack id>::<voice id>` is the external identity of a voice.** It is what the scanner reports, what `_raceEngineerVoices` and `_voiceLabels` carry, what `raceEngineerVoice` stores, and what the driver-name lists are keyed by. `DEFAULT_RACE_ENGINEER_VOICE` becomes `default::default`. The dropdown shows the pack's chosen label for the voice, never the raw composite id; where two packs use the same label the pack's label is appended in parentheses, which is a UI rule and not part of the id.

**`::` is forbidden in a pack id and in a voice id.** Both schemas (`VoicePackManifestSchema`, `VoicePackCatalogEntrySchema`) refuse it; `lint:pack` reports it with the reason. The separator is two characters so that a single colon, which some authors may want, stays available.

**The audio service binds each voice to its pack's root.** Resolution of a logical clip path for the active voice consults the root of the pack that owns that voice — the scanner already hands the service one `{ dir, clips }` root per pack, so the binding is a map from composite id to root, and `{voice}` substitution in the scenario engine resolves to the bare voice id inside that root. Clips outside `voice/` (sfx) resolve as today. Rejected: qualifying the clip path inside the pack (`voice/<pack>/<voice>/…`), which would move the plugin's problem onto every author and the packer.

**The scanner stops refusing duplicates across packs.** `priorityPacks`, the reserved-voice rule and the "already provided by pack …" problem go. What remains is that one pack may not declare the same voice id twice. `isManagedVoicePack` keeps working on the pack id.

**Migration.** A one-shot migration in `global-settings-migrations.ts`, guarded by a passthrough marker as the renames case is: a stored `raceEngineerVoice` that contains no `::` is rewritten to `default::<value>` when the managed pack provides that voice, and left alone (to fall through `resolveActiveRaceEngineerVoice`'s existing fallback) otherwise. Any per-voice driver-name key follows the same rule. `resolveActiveRaceEngineerVoice` also accepts a bare id at runtime by mapping it through the same rule, so a settings file edited by hand or an older Property Inspector payload still resolves.

## Failure modes

| Situation | Behaviour |
|---|---|
| Two packs both provide `matt` | Both listed and selectable; labels disambiguated in the dropdown. |
| A pack id or voice id contains `::` | Refused by the scanner with the reason; `lint:pack` says the same. |
| Stored `raceEngineerVoice` is a bare id the managed pack has | Migrated once to `default::<id>`. |
| Stored `raceEngineerVoice` is a bare id no pack has | Falls back as today (managed voice, then the first available). |
| Settings window from an older build sends a bare id | Accepted at runtime through the same mapping. |

## Testing

- Scanner: two packs with the same voice id both load; a `::` in either id is refused.
- Audio service: the same logical path resolves to a different root per active voice.
- Migration: bare → composite for a voice the managed pack provides; untouched otherwise; runs once.
- `lint:pack`: the `::` rule.
- Website: the name-clash bullet is gone from "When a Pack Does Not Appear"; the format page states the `::` rule.

## Affected artifacts

As listed on the issue: deck-core (scanner, service, settings, migration, launch step), audio-service, audio-scenarios, callout-script / audio-assets schemas and `lint:pack`, pi-components selects and list, the three plugins, the harness, website docs and changelog, the rules that describe voice ids.
