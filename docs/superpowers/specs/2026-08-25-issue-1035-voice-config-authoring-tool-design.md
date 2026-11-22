# Issue #1035 — Local voice-config authoring tool

Design, 2026-08-25. Target branch `master`. No milestone: this is developer tooling and ships in no plugin.

> **Amended 2026-11-22: brought up to the tree it would now be built on.** Since this was written: #1064/#1065 moved every callout's script into the same file (`scenarios`, `frames`, `fragments`, `pools`), with no `pools.ts` left; #1066 generated a pack reference that already says what every line and callout is for; #999 added a second first-party voice (`shawn.voice.json`, Shawn (Short callouts)), authored by hand; #1033's per-entry `skip` was dropped for the script's per-callout `skip: true`; #1336 made `corner-names` hand-authored per language; #1580 added driver-name aliases; #1643 moved the default engineer to `eleven_v4` and taught the generator to order runs and copy identical takes between voices. The figures below are re-measured; the decisions that changed say what changed them.

## Problem

Authoring a Race Engineer voice means hand-editing `packages/audio-assets/configs/<voice-id>.voice.json`. For the canonical voice that file is now **32,415 lines — 4,880 clip entries across 64 groups, plus 181 scripted callouts** (`shawn.voice.json`: 31,973 lines, 4,787 entries, 61 groups, the same 181 callouts). It was 8,379 lines and 1,532 entries when this was filed. Two separate things make that worse than its size suggests.

**Most of it is not writing.** A survey of `default.voice.json` (measured 2026-11-22 from the committed file) says about **4,385 of the 4,880 entries — 90% — are mechanically shaped**, leaving roughly 495 entries of actual prose:

| Shape | Entries |
|---|---|
| 113 first names × 5 groups (`DRIVER_NAME_GROUPS`: `names`, `session-start-greeting`, `race-start-greeting`, `race-end-greeting`, `position-overtake-come-on`) | 565 |
| `car-number` (0–9, 00–99, 000–999), authored by `scripts/generate-car-numbers.mjs` (#1127) | 1,110 |
| `lap-time-thousandths` (000–999) and `lap-time-clock` (`1m00`–`10m59`), the compact lap time (#1163) | 1,600 |
| `numbers-degrees` (`minus20` and up; was `session-start-temp-numbers`, #1187) | 197 |
| `numbers-fuel`, `numbers-fuel-decimal`, `numbers-percent` | 242 |
| `position-number` (1–64) | 64 |
| `lap-time-second` (0–59), `lap-time-minute` (1–10), `lap-time-decimal` / `lap-time-tenths` (0–9) | 90 |
| `session-start-speed-numbers` (a sparse set of 38 values) | 38 |
| `readout-laps`, `sector-number`, `sector-comparison-sector` | 40 |
| `corner-names`, hand-authored per language since #1336 (not derivable; see below) | 439 |

The five name groups share one identical, identically-ordered set of 113 names. Adding a driver's first name means typing it into five places in five different shapes, in every first-party voice — which is also why #941 (collect driver first names to a local CSV) has nowhere good to deliver its output today.

**And, when this was filed, nothing said what any line was for.** That half has since been delivered by #1066: every contract carries a `description`, every script entry a required `comment` and `test` line, and the generated pack reference (`pack-reference.json`, `@iracedeck/audio-scenarios`' `reference/`) gives each `<group>/<base>` its `usedBy`, `viaVar` and `playedBy`, published as the website's Callouts, Vocabulary and Recording Script pages. A test keeps it fresh. What is still missing is that knowledge under the cursor while editing the file.

Raised by **@projektdotnet42** on Discord, who hit both halves while editing the default pack.

## Goal

Make authoring a voice a matter of editing the lines that are actually writing, with each line explaining itself, and let the derivable ~3,950 (81%: everything mechanical except the hand-authored corner names) fall out of a compact declaration.

The tool writes the config. It does not spend money.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Audience | In-repo, for anyone who clones the monorepo | The repo is open source, so a third-party pack author (#1034) clones it like anyone else. No standalone distribution problem to solve. |
| Core model | Derive the mechanical 81%, form the prose | A field-per-entry form would render ~4,400 fields holding numbers and names that nobody should ever retype. |
| Interface | Local web form on loopback, `@iracedeck/scenario-harness` pattern | Already the proven shape in this repo for a dev-only local UI, and it is what makes a per-call tooltip possible at all. |
| Descriptions | Read from the pack reference #1066 generates (amended 2026-11-22) | The first draft planned a new enforced catalog keyed by `<group>/<base>`, seeded from `pools.ts`'s comments. `pools.ts` is gone (#1065), and #1066's reference already holds a tested description per contract and a consumer list per line, so a second catalog would duplicate it and could drift from it. |
| Boundary | Writes JSON, plus a free `generate:dry-run` preview | ElevenLabs is paid. Cost scoping is enforced by having to type `--voice` / `--group` / `--entry` on purpose; a Generate button in a browser page would undo that. |

## The shape of the data

The expander's whole job is to reproduce the committed entries **exactly**, so the design follows what is actually in the file rather than what would be tidy. Re-measured 2026-11-22; the #1643 move to `eleven_v4` re-cut every clip, and the per-entry seed outliers the first draft counted are gone from the number groups.

**The name groups are perfectly regular — with four exceptions in the name list itself.** All five groups carry the same 113 entry names in the same order, each entry only `name` + `text`, no seeds and no request ids. The entry name is the display name, diacritics stripped and lowercased, except four that are not a mechanical slug of their text: `ade` (Aid), `jorgen` (Jørgen — `ø` does not decompose), `matthias` (Mattias) and `oivindl` (Öivin). Clips are committed under those names and a base rename is a breaking change for anything referencing it, so the declaration must be able to pin a slug explicitly rather than always deriving one. A spelling that is a key of `DRIVER_NAME_ALIASES` (#1580, `@iracedeck/callout-script`) must never become a name entry: the generator refuses it and `src/driver-names.test.ts` fails on it, so the expander refuses it too.

**One number group is a sparse set, not a range.** `session-start-speed-numbers` holds 24, 25, 26, 29, 30, 31, 32, 34, … 81 — 38 values with gaps, because those are the pit-lane limits that actually occur. The other number groups are contiguous, `car-number` as three zero-padded ranges and `lap-time-clock` as minutes × seconds. So the declaration needs `range`, an explicit `values` list, and a zero-padded width.

**The number groups are now template-regular.** Every number group but two has one entry shape throughout (`previous_request_ids` included); `numbers-fuel-decimal` has two (liters and gallons, `liters-<d>` / `gallons-<d>`) and `sector-number` one take with its own shape. The per-entry override map stays, because an author bumping a seed on a bad take is how a group stops being regular again.

**Number words follow two conventions.** Most groups are space-separated with no hyphens and no "and" (`pee sixty four.`, `ten fifty nine`, `one hundred percent.`); `car-number` hyphenates the tens (`car nine ninety-nine`), per the reading rules the maintainer ruled on 2026-09-17 and `generate-car-numbers.mjs` records. The helper takes the convention as an option.

**`corner-names` is no longer derivable.** Since #1336 its texts are spelled per language so each corner is spoken in its own language, with seven entry shapes across 439 entries; `src/corner-names.test.ts` holds every voice to one entry per `listCornerNames()` slug. It stays hand-authored and outside `derived`.

## Architecture

### 1. `derived` — a new top-level key in the voice config

`derived` sits beside `groups`, never inside it. Everything that reads voice configs today — the generator, `src/generate/script-coverage.test.ts` (which replaced `voice-parity.test.ts` in #1065), `src/driver-names.test.ts`, `scripts/generate-audio-manifest.mjs`, `generate:callout-scripts` and the packer — keeps reading `groups` (and the script keys) and needs no change at all. `VoiceConfigSchema` in `src/generate/config.ts` gains an optional `derived` object; the entry schema is untouched. `derived` is never extracted into `callouts.json`, so it never reaches a pack.

Abridged — the real block declares all 113 names and every number group:

```jsonc
"derived": {
  "names": {
    "values": ["Adam", "Al", "Alex", "…", { "name": "jorgen", "text": "Jørgen" }, { "name": "oivindl", "text": "Öivin" }],
    "groups": {
      "names":                     { "text": "{Name}" },
      "session-start-greeting":    { "text": "Ok, {Name}," },
      "race-start-greeting":       { "text": "Time to race, {Name}." },
      "race-end-greeting":         { "text": "{Name}," },
      "position-overtake-come-on": { "text": "Come on, {Name}." }
    }
  },
  "numbers": {
    "position-number": {
      "range": [1, 64],
      "entry": {
        "text": "pee {word}.",
        "previous_request_ids": ["position-intro-better/that-puts-us-to-01", "position-intro-worse/currently-01"]
      }
    },
    "session-start-speed-numbers": {
      "values": [24, 25, 26, 29, 30, "…", 81],
      "entry": { "text": "{word}", "previous_request_ids": ["session-start/pit-speed-intro"] }
    },
    "lap-time-thousandths": {
      "range": [0, 999],
      "pad": 3,
      "entry": { "text": "point {digits}", "previous_request_ids": ["lap-time-second/23"] }
    }
  }
}
```

A name is either a plain string (entry name derived: Unicode-normalise, strip diacritics, lowercase) or an explicit `{ name, text }` pair for the cases where the derived slug is wrong. A derived slug that does not match `^[a-z0-9-]+$` is a **hard failure**, never a silent coercion — the rule the old corner-names script applied to corner names with unhandled digits.

For numbers, the entry name is the decimal string (zero-padded where declared) and `{word}` / `{digits}` the spelled form. `overrides` is keyed by entry name and shallow-merges over the template result, so an entry can add `next_text`, change `seed`, or pin `voice_settings` without leaving the declaration.

Each first-party voice carries its own `derived` block: voice files stay self-contained (`audio-assets/CLAUDE.md`), and the two voices' templates may diverge even though today they are identical.

### 2. The expander

A pure function plus a thin writer, in `@iracedeck/audio-assets`: given a parsed config, return the config with every declared group's array replaced wholesale. Deterministic and idempotent — running it twice produces byte-identical output, and running it on an unchanged declaration produces no diff.

It replaces **only** groups named in `derived`. A group absent from the declaration is left exactly as it is, so a voice can adopt the mechanism for the name groups and hand-author its numbers, or vice versa. Key order within an entry is fixed (`name`, `text`, `seed`, `next_text`, `previous_request_ids`, `next_request_ids`, then anything else) so diffs stay readable. The voice configs are written in the repo's own JSON layout, never round-tripped through a reformatter that would re-expand inline arrays.

The number-to-words helper is lifted out of `scripts/generate-car-numbers.mjs` into a shared module rather than duplicated (the corner-names script it was first to come from is gone, #1336); whether that script folds into the expander is open question 1.

### 3. Descriptions: the pack reference

Amended 2026-11-22. The tooltip for a line is its pack-reference entry — the callouts that address it directly, the vars that reach its group, or what in the plugin plays it — and for a scripted callout its contract `description` plus the script's `comment` and `test`. The tool reads the committed `pack-reference.json`; it adds no catalog, no drift test and no new checklist step, since #1066's freshness test and the completeness test already make a callout without a description or `comment` fail the suite.

### 4. `@iracedeck/voice-authoring`

A new dev-only package structured like `@iracedeck/scenario-harness`: `pnpm --filter @iracedeck/voice-authoring dev` serves a form on `127.0.0.1`, reading and writing `packages/audio-assets/configs/*.voice.json` directly. It is a dependency of no plugin and is excluded from every plugin build.

What the form offers:

- **Pick or create a voice.** Creating one starts as a copy of `default.voice.json`'s text with a fresh header, so the author edits rather than types — the "defaults pre-filled" half of the original proposal.
- **A voice header**: `id`, `label`, `model_id`, `voice_settings`.
- **Per prose entry**: `text`, `seed`, delete, and a `+` that adds the next `-NN` variant with the name assigned automatically. (The first draft's per-entry `skip` checkbox waited on #1033, which was closed as not planned: skipping is now per callout, `"skip": true` on a script entry, so it belongs with the script, below.)
- **A tooltip per line**, from the pack reference.
- **The name list as one textarea**, one name per line, plus the five templates as editable fields — a voice's personality lives largely in those templates. Saving re-runs the expander.

**Round-trips must be lossless.** Entries carry fields the form deliberately does not surface: `next_text`, `previous_request_ids` / `next_request_ids`, and the per-entry overrides (`model_id`, `voice_settings`, `output_format`, `apply_text_normalization`, …), and the file carries the script keys the form may not edit at all. Unknown and unsurfaced fields are preserved verbatim and key order is stable, so opening a config and saving it with no edits produces an empty diff. This is the property that makes the tool safe to point at `default.voice.json`, so it is tested directly rather than assumed.

New variant names are validated against the kebab-case rule before they can be saved, because an invalid name reaches the runtime as a clip nothing will ever play. A text with a pause mark the generator would refuse (`pause-marks.approved.json` / `pause-marks.grandfathered.json`) is flagged in the form rather than at generation time.

Editing the script keys (`scenarios`, `frames`, `fragments`, `pools`) is open question 4. Whatever the form does with them, a save re-extracts `voice/<id>/callouts.json` (`generate:callout-scripts`), which the post-edit hook does for a hand edit today.

### 5. The dry-run bridge

The form can run the existing `generate:dry-run` for the current voice and render its result: which entries would be cut, which would be copied from another voice's identical take (`WOULD COPY`, #1643), which are refused (a stale dependency, an alias, an unapproved pause mark) and which are cache hits. That call spends nothing. Alongside it the form shows the exact scoped `generate --voice <id> --group <name> [--entry <name>]` command to paste into a terminal, once Niklas has approved the texts (the audio rules).

No ElevenLabs call is made from the tool, on any path.

## Hash invariance — the one constraint that can cost money

`generate.manifest.json` is a per-entry hash cache. If the first expansion changes any existing entry's hash, that entry re-cuts at ElevenLabs cost — across the derived groups that is up to ~3,950 clips per voice.

Two things protect it. `entryHash` hashes `buildEntryOptions(entry, voice)`, an explicit allow-list of synthesize options rather than a spread of the entry, so a new top-level `derived` key is invisible to it by construction. And the expander is required to reproduce today's `text`, `seed`, `next_text` and request-id arrays exactly — which is what the sparse-set, padding, per-entry-override and explicit-slug affordances above exist for.

The acceptance test: run the expander over every committed first-party config, then assert `generate:dry-run` reports **zero** would-generate and zero would-copy entries. That is the gate for the change landing at all.

Because the expansion is materialised into the config and committed, a name-list edit shows up in review as the entries it actually produced — the reviewer sees the 565 lines per voice, the author typed one.

**A second cost trap has nothing to do with the expander, and it is why the dry-run bridge exists.** `entryHash` recurses into `previous_request_ids` / `next_request_ids` dependencies, so an entry's hash includes the hashes of the entries it references. All 64 `position-number` entries reference `position-intro-better/that-puts-us-to-01` and `position-intro-worse/currently-01` — two ordinary prose lines the form invites you to edit. Retouching one of them re-cuts 64 clips per voice; retouching `lap-time-intro/first-good-lap` would re-cut the whole compact lap-time readout, 1,091 clips per voice (measured in the #1688 spec). Nothing about that is wrong, and nothing should block it — but the author must be able to see it before spending, which a free dry-run in the form gives them and a bare text field does not.

## What this deliberately does not do

- **No ElevenLabs call, on any path.** The paid step stays a deliberate terminal command.
- **No manifest rebuild, no pack, no clip playback.** `generate:manifest` and `pack:voice` stay separate steps; auditioning stays the scenario harness's and the review page's job.
- **No runtime change.** No plugin, action, setting, icon or website page changes. Nothing user-facing, so no changelog fragment.
- **No new group can be invented from the form.** A new group needs a contract, a script step or a var to reach it, which is code or script — outside a config editor.
- **It does not replace hand-editing.** The config stays plain JSON and stays the source of truth; the tool is one way to edit it, never the only one.

## Testing

- **Expander determinism**: expanding twice yields byte-identical output; expanding an unchanged declaration yields no diff.
- **Expander fidelity**: expanding each committed first-party config reproduces every declared number group and all five name groups byte-identically, including the sparse speed set, the zero-padded groups, both `numbers-fuel-decimal` shapes and the four explicit name slugs.
- **Hash invariance**: `generate:dry-run` after expansion reports zero would-generate and zero would-copy entries, for every voice. The gate for the whole change.
- **Slug validation**: a name whose derived slug is not `^[a-z0-9-]+$` fails loudly rather than being coerced; a `DRIVER_NAME_ALIASES` key in the name list is refused.
- **Lossless round-trip**: load and save every committed config with no edits; assert an empty diff, including unsurfaced fields, the script keys and key order.
- **Variant naming**: `+` on a base with `-01`/`-02` produces `-03`; an invalid hand-typed name is rejected before save.
- **Reference cascade is visible**: editing a prose entry that derived entries reference (e.g. `position-intro-worse/currently-01`) makes the dry-run report the dependent entries as would-generate, not as cache hits.
- **Untouched contracts**: `script-coverage.test.ts`, `driver-names.test.ts`, `corner-names.test.ts`, `bundled-scripts.test.ts`, the manifest builder and the pack-reference freshness test still pass unchanged, proving `derived` is invisible to them.

## Manual verification

1. `pnpm --filter @iracedeck/voice-authoring dev`, open the printed loopback URL, load `default`.
2. Confirm every prose field is pre-filled and each shows a tooltip on hover.
3. Add one name to the textarea, save, and confirm `git diff` shows exactly five new entries in the five name groups and nothing else.
4. Run `generate:dry-run` from the form and confirm it reports exactly those five as would-generate and everything else as cache hits.
5. Create a new voice from default, change a handful of lines, save, and confirm the file parses and the untouched entries are byte-identical to default's.
6. Open a config, save it without editing anything, and confirm `git diff` is empty.

## Artifacts to update in the same change

- **`@iracedeck/voice-authoring`** (new) — server, form, config reader/writer.
- **`@iracedeck/audio-assets`** — `VoiceConfigSchema` gains optional `derived`; the expander and the shared number-to-words helper; every first-party config gains its `derived` block; `CLAUDE.md` documents authoring through the tool.
- **`.claude/rules/race-engineer-callouts.md`** — the name and number steps say to edit the declaration, not the groups.
- **Docs** — the website's voice-pack pages (`docs/voice-packs/`, #1066) gain a section on authoring with the tool; the pack-author walkthrough itself exists since #1066.
- **Root `README.md`** — the new package in the workspace list, if it enumerates packages.
- **Not touched**: changelog, website action pages, plugin manifests, settings window, `@iracedeck/audio-scenarios` (amended 2026-11-22: the first draft's descriptions catalog is dropped for the pack reference).

## Open questions

1. Should `generate-car-numbers.mjs` fold into the expander? It declares one group by maintainer-ruled reading rules, which a `numbers` declaration with the hyphenated convention could express. (The first draft asked this of `generate-corner-names-group.mjs`, deleted in #1336 when corner names became hand-authored.)
2. Can an author declare a **new** name-templated group, or only edit the five that exist? The general case needs a contract or var to reach the group, which puts it outside a config-only tool.
3. Should the tool's tooltips link to the published reference pages? The first draft asked whether its catalog should become a public "what your Race Engineer says" page; #1066 built those pages, so only the link is left to decide.
4. Does the form edit the callout scripts too? Since #1064 the same file carries `scenarios` (181 entries, each a `sequence` or `skip: true` with its `comment` and `test`), `frames`, `fragments` and `pools` — authored content, not derivable, and closer to a form than the line text is (the maintainer's 2026-08-30 note on the issue). Editing them means validating against the grammar (`parseCalloutScript`) and the vocabulary, and is where a condensed voice's `skip` now lives. Left open: the first draft scoped the tool to the line text.

## Relationship to other issues

- **#1033 (per-entry `skip`)** — closed as not planned; per-callout `skip: true` in the script (#1064) replaced it (open question 4).
- **#1034 (downloadable voice packs)** — shipped; makes third-party voices real. Since the repo is public, a pack author clones it and uses this tool; no separate distribution is needed.
- **#999 (a Short Calls voice)** — shipped, authored by hand as `shawn.voice.json`. It is the second voice the expander must reproduce, not a customer still waiting.
- **#1064 / #1065 (scripts in the pack)** — put the callout scripts in the file this tool edits (open question 4).
- **#1066 (pack documentation)** — supplies the descriptions (section 3) and the walkthrough the first draft planned to write.
- **#1580 (driver-name aliases)** — the name list must refuse an alias spelling.
- **#1643 (the v4 move and run ordering)** — the dry-run bridge reports its copies and refusals.
- **#941 (collect driver first names to a local CSV)** — its output becomes a paste into the name textarea, and the five name groups fall out in every voice. Without this, it has nowhere good to land.
- **#664 (relaxed voice parity)** — already allows voices to diverge, so a voice authored here may legitimately carry fewer entries than default. The within-voice coverage check (#1065) still applies.
