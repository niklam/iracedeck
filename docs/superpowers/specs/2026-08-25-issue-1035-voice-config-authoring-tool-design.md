# Issue #1035 — Local voice-config authoring tool

Design, 2026-08-25. Target branch `master`. No milestone: this is developer tooling and ships in no plugin.

## Problem

Authoring a Race Engineer voice means hand-editing `packages/audio-assets/configs/<voice-id>.voice.json`. For the canonical voice that file is **8,379 lines — 1,532 entries across 46 groups**. Two separate things make that worse than its size suggests.

**Most of it is not writing.** A survey of `default.voice.json` (numbers below are exact, taken from the committed file) says **1,192 of the 1,532 entries — 78% — are mechanically shaped**, leaving roughly 340 entries of actual prose:

| Shape | Entries |
|---|---|
| 84 first names × 5 groups (`names`, `session-start-greeting`, `race-start-greeting`, `race-end-greeting`, `position-overtake-come-on`) | 420 |
| `corner-names`, already machine-authored from `@iracedeck/track-data` by `scripts/generate-corner-names-group.mjs` | 439 |
| `session-start-temp-numbers` (0–150) | 151 |
| `position-number` (1–64) | 64 |
| `lap-time-second` (0–59) | 60 |
| `session-start-speed-numbers` (a sparse set of 38 values) | 38 |
| `lap-time-minute` (1–10) + `lap-time-decimal` (0–9) | 20 |

The five name groups share one identical, identically-ordered set of 84 names. Adding a driver's first name means typing it into five places in five different shapes — which is also why #941 (collect driver first names to a local CSV) has nowhere good to deliver its output today.

**And nothing says what any line is for.** There is no machine-readable description of when `pit-window/box-this-lap-01` fires. That knowledge exists as prose comments in `packages/audio-scenarios/src/catalog/pit-crew/pools.ts` and as the scenario implementations themselves. A newcomer opening a voice config sees 8,379 lines of strings with no signal about which ones matter or when they play.

Raised by **@projektdotnet42** on Discord, who hit both halves while editing the default pack.

## Goal

Make authoring a voice a matter of editing the ~340 lines that are actually writing, with each line explaining itself, and let the other 1,192 fall out of a compact declaration.

The tool writes the config. It does not spend money.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Audience | In-repo, for anyone who clones the monorepo | The repo is open source, so a third-party pack author (#1034) clones it like anyone else. No standalone distribution problem to solve. |
| Core model | Derive the mechanical 78%, form the prose | A field-per-entry form would render ~1,200 fields holding numbers and corner names that nobody should ever retype. |
| Interface | Local web form on loopback, `@iracedeck/scenario-harness` pattern | Already the proven shape in this repo for a dev-only local UI, and it is what makes a per-call tooltip possible at all. |
| Descriptions | An enforced catalog keyed by `<group>/<base>` | A half-populated tooltip layer is worthless to the newcomer the tool exists for. The cost is a permanent extra step in the callout checklist, accepted deliberately. |
| Boundary | Writes JSON, plus a free `generate:dry-run` preview | ElevenLabs is paid. Cost scoping is currently enforced by having to type `--group` on purpose; a Generate button in a browser page would undo that. |

## The shape of the data

The expander's whole job is to reproduce the committed entries **exactly**, so the design follows what is actually in the file rather than what would be tidy. Three findings drive it.

**The name groups are perfectly regular — with two exceptions in the name list itself.** All five groups carry the same 84 entry names in the same order, each entry only `name` + `text`, no seeds and no request ids. The entry name is the display name lowercased, except `André` → `andre` (diacritic stripped) and `Öivin` → `oivindl` (which is not a mechanical slug of its text at all). Clips are committed under those names and a base rename is a breaking change for anything referencing it, so the declaration must be able to pin a slug explicitly rather than always deriving one.

**One number group is a sparse set, not a range.** `session-start-speed-numbers` holds 24, 25, 26, 29, 30, 31, 32, 34, … 81 — 38 values with eight gaps, because those are the pit-lane limits that actually occur. `position-number`, `lap-time-second`, `lap-time-decimal` and `session-start-temp-numbers` are contiguous; `lap-time-minute` is 1–10. So the declaration needs both `range` and an explicit `values` list.

**Seventeen number entries deviate from their group's template.** `session-start-temp-numbers` has 12 (bumped seeds on ten of them, `next_text` on nine, a `voice_settings` override on two — overlapping), `lap-time-second` has three seed outliers (`3`→2, `4`→6, `8`→15), `lap-time-minute` one (`2`→4), `lap-time-decimal` one (`9`→1). These are an author bumping a seed because a take sounded wrong, and they must survive byte-identically or those clips re-cut. A template alone cannot express them, so the declaration carries a per-entry override map.

**Number-to-words is already consistent**: space-separated, no hyphens, no "and" — `twenty one`, `forty five`, `one hundred one`, `one hundred fifty`. That is the same convention `generate-corner-names-group.mjs` implements today.

## Architecture

### 1. `derived` — a new top-level key in the voice config

`derived` sits beside `groups`, never inside it. Everything that reads voice configs today — the generator, `src/generate/voice-parity.test.ts`, `scripts/generate-audio-manifest.mjs`, the build's `buildVoiceTreeTasks` — keeps reading `groups` and needs no change at all. `ConfigSchema` in `src/generate/config.ts` gains an optional `derived` object; `EntrySchema` is untouched.

Abridged — the real block declares all 84 names and all six number groups:

```jsonc
"derived": {
  "names": {
    "values": ["Adam", "Al", "Alex", "…", { "name": "andre", "text": "André" }, { "name": "oivindl", "text": "Öivin" }],
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
        "seed": 1,
        "previous_request_ids": ["position-intro-better/that-puts-us-to-01", "position-intro-worse/currently-01"]
      }
    },
    "session-start-speed-numbers": {
      "values": [24, 25, 26, 29, 30, "…", 81],
      "entry": { "text": "{word}", "previous_request_ids": ["session-start/pit-speed-intro"] }
    },
    "lap-time-second": {
      "range": [0, 59],
      "entry": { "text": "{word}", "seed": 3, "next_text": " point.", "previous_request_ids": ["lap-time-minute/1"] },
      "overrides": { "3": { "seed": 2 }, "4": { "seed": 6 }, "8": { "seed": 15 } }
    }
  }
}
```

A name is either a plain string (entry name derived: Unicode-normalise, strip diacritics, lowercase) or an explicit `{ name, text }` pair for the cases where the derived slug is wrong. A derived slug that does not match `^[a-z0-9-]+$` is a **hard failure**, never a silent coercion — the same rule `generate-corner-names-group.mjs` already applies to corner names with unhandled digits.

For numbers, the entry name is the decimal string and `{word}` is the spelled form. `overrides` is keyed by entry name and shallow-merges over the template result, so an entry can add `next_text`, change `seed`, or pin `voice_settings` without leaving the declaration.

### 2. The expander

A pure function plus a thin writer, in `@iracedeck/audio-assets`: given a parsed config, return the config with every declared group's array replaced wholesale. Deterministic and idempotent — running it twice produces byte-identical output, and running it on an unchanged declaration produces no diff.

It replaces **only** groups named in `derived`. A group absent from the declaration is left exactly as it is, so a voice can adopt the mechanism for the name groups and hand-author its numbers, or vice versa. Key order within an entry is fixed (`name`, `text`, `seed`, `next_text`, `previous_request_ids`, `next_request_ids`, then anything else) so diffs stay readable.

The number-to-words helper is lifted out of `generate-corner-names-group.mjs` into a shared module rather than duplicated; that script keeps its own track-data-driven behaviour (see Open questions).

### 3. The descriptions catalog

A new module beside `pools.ts` in `@iracedeck/audio-scenarios`, keyed by `<group>/<base>` — the same stable identifier `POOL_REGISTRY` already uses. It is seeded by turning the prose already written in `pools.ts`'s comments into data. `POOL_REGISTRY` registers **129 pools across 16 groups**, which sizes the initial authoring job.

It is imported by the authoring tool and by tests only, never by the runtime or any scenario, so it adds nothing to any plugin bundle. Nothing about it is user-facing.

A test asserts both directions over a precise set: every `<group>/<base>` appearing in a **non-derived** group of `default.voice.json` has a description, and every description names a base that exists there. Derived groups are excluded — a description per number from 0 to 150 is noise, and their group-level entry in the catalog covers them. That is what stops the catalog rotting, and it is why `.claude/rules/race-engineer-callouts.md` gains a "write the description" step: a new callout without one fails the suite.

### 4. `@iracedeck/voice-authoring`

A new dev-only package structured like `@iracedeck/scenario-harness`: `pnpm --filter @iracedeck/voice-authoring dev` serves a form on `127.0.0.1`, reading and writing `packages/audio-assets/configs/*.voice.json` directly. It is a dependency of no plugin and is excluded from every plugin build.

What the form offers:

- **Pick or create a voice.** Creating one starts as a copy of `default.voice.json`'s text with a fresh header, so the author edits rather than types — the "defaults pre-filled" half of the original proposal.
- **A voice header**: `id`, `label`, `model_id`, `voice_settings`.
- **Per prose entry**: `text`, `seed`, delete, a `+` that adds the next `-NN` variant with the name assigned automatically, and a `skip` checkbox once #1033 lands.
- **A tooltip per call**, from the descriptions catalog.
- **The name list as one textarea**, one name per line, plus the five templates as editable fields — a voice's personality lives largely in those templates. Saving re-runs the expander.

**Round-trips must be lossless.** Entries carry fields the form deliberately does not surface: `next_text`, `previous_request_ids` / `next_request_ids`, and the per-entry overrides (`model_id`, `voice_settings`, `output_format`, `apply_text_normalization`, …). Unknown and unsurfaced fields are preserved verbatim and key order is stable, so opening a config and saving it with no edits produces an empty diff. This is the property that makes the tool safe to point at `default.voice.json`, so it is tested directly rather than assumed.

New variant names are validated against the kebab-case rule before they can be saved, because an invalid name reaches the runtime as a clip nothing will ever play.

### 5. The dry-run bridge

The form can run the existing `generate:dry-run` for the current voice and render its result: which entries would be cut, which are cache hits. That call spends nothing. Alongside it the form shows the exact scoped `generate --group <name>` command to paste into a terminal.

No ElevenLabs call is made from the tool, on any path.

## Hash invariance — the one constraint that can cost money

`generate.manifest.json` is a per-entry hash cache. If the first expansion changes any existing entry's hash, that entry re-cuts at ElevenLabs cost — across the derived groups that is up to 1,192 clips.

Two things protect it. `entryHash` hashes `buildEntryOptions(entry, voice)`, an explicit allow-list of synthesize options rather than a spread of the entry, so a new top-level `derived` key is invisible to it by construction. And the expander is required to reproduce today's `text`, `seed`, `next_text` and request-id arrays exactly — which is what the sparse-set, per-entry-override and explicit-slug affordances above exist for.

The acceptance test is the one the corner-names script already set: run the expander over the committed `default.voice.json`, then assert `generate:dry-run` reports **zero** would-generate entries. That is the gate for the change landing at all.

Because the expansion is materialised into the config and committed, a name-list edit shows up in review as the entries it actually produced — the reviewer sees the 420 lines, the author typed one.

**A second cost trap has nothing to do with the expander, and it is why the dry-run bridge exists.** `entryHash` recurses into `previous_request_ids` / `next_request_ids` dependencies, so an entry's hash includes the hashes of the entries it references. All 64 `position-number` entries reference `position-intro-better/that-puts-us-to-01` and `position-intro-worse/currently-01` — two ordinary prose lines the form invites you to edit. Retouching one of them re-cuts 64 clips; the equivalent edit to a `lap-time-intro` or `session-start` intro line cascades similarly. Nothing about that is wrong, and nothing should block it — but the author must be able to see it before spending, which a free dry-run in the form gives them and a bare text field does not.

## What this deliberately does not do

- **No ElevenLabs call, on any path.** The paid step stays a deliberate terminal command.
- **No manifest rebuild and no clip playback.** `generate:manifest` stays a separate step; auditioning stays the scenario harness's job.
- **No runtime change.** No plugin, action, setting, icon or website page changes. Nothing user-facing, so no changelog entry.
- **No new group can be invented from the form.** Adding a group needs a pool registration and usually a scenario, which is code — outside a config editor.
- **It does not replace hand-editing.** The config stays plain JSON and stays the source of truth; the tool is one way to edit it, never the only one.

## Testing

- **Expander determinism**: expanding twice yields byte-identical output; expanding an unchanged declaration yields no diff.
- **Expander fidelity**: expanding the committed `default.voice.json` reproduces all six declared number groups and all five name groups byte-identically, including the 17 override entries, the sparse speed set, and the two explicit name slugs.
- **Hash invariance**: `generate:dry-run` after expansion reports zero would-generate entries. The gate for the whole change.
- **Slug validation**: a name whose derived slug is not `^[a-z0-9-]+$` fails loudly rather than being coerced.
- **Lossless round-trip**: load and save every committed config with no edits; assert an empty diff, including unsurfaced fields and key order.
- **Variant naming**: `+` on a base with `-01`/`-02` produces `-03`; an invalid hand-typed name is rejected before save.
- **Descriptions drift**: every base in a non-derived group of `default.voice.json` has a description, and every description names a base that exists there.
- **Reference cascade is visible**: editing a prose entry that derived entries reference (e.g. `position-intro-worse/currently-01`) makes the dry-run report the dependent entries as would-generate, not as cache hits.
- **Untouched contracts**: `voice-parity.test.ts` and the manifest builder still pass unchanged, proving `derived` is invisible to them.

## Manual verification

1. `pnpm --filter @iracedeck/voice-authoring dev`, open the printed loopback URL, load `default`.
2. Confirm every prose field is pre-filled and each shows a tooltip on hover.
3. Add one name to the textarea, save, and confirm `git diff` shows exactly five new entries in the five name groups and nothing else.
4. Run `generate:dry-run` from the form and confirm it reports exactly those five as would-generate and everything else as cache hits.
5. Create a new voice from default, change a handful of lines, save, and confirm the file parses and the untouched entries are byte-identical to default's.
6. Open a config, save it without editing anything, and confirm `git diff` is empty.

## Artifacts to update in the same change

- **`@iracedeck/voice-authoring`** (new) — server, form, config reader/writer.
- **`@iracedeck/audio-assets`** — `ConfigSchema` gains optional `derived`; the expander and the shared number-to-words helper; `configs/default.voice.json` gains its `derived` block; `CLAUDE.md` documents authoring through the tool.
- **`@iracedeck/audio-scenarios`** — the descriptions catalog and its drift test.
- **`.claude/rules/race-engineer-callouts.md`** — the description step in the checklist.
- **Docs** — "How to author a Race Engineer voice", the walkthrough that has never existed.
- **Root `README.md`** — the new package in the workspace list, if it enumerates packages.
- **Not touched**: changelog, website action pages, plugin manifests, settings window.

## Open questions

1. Should `generate-corner-names-group.mjs` fold into the expander? It derives from `@iracedeck/track-data` rather than from an author declaration, so it may be a different kind of thing that merely shares the write-back mechanism. Sharing the number-to-words helper is uncontroversial either way.
2. Can an author declare a **new** name-templated group, or only edit the five that exist? The general case needs the scenario side to know about the group, which puts it outside a config-only tool.
3. Should the descriptions catalog also render a public "what your Race Engineer says" page on the website? That would turn internal tooltips into user-facing content held to a higher editorial bar.

## Relationship to other issues

- **#1033 (per-entry `skip`)** — the form is the natural home for it: a checkbox per line. This design does not depend on #1033; the checkbox appears when the field exists.
- **#1034 (downloadable voice packs)** — makes third-party voices real. Since the repo is public, a pack author clones it and uses this tool; no separate distribution is needed.
- **#999 (a Short Calls voice)** — the first concrete customer: a condensed voice is `skip` plus edited prose, which is exactly what this tool edits.
- **#941 (collect driver first names to a local CSV)** — its output becomes a paste into the name textarea, and the five name groups fall out. Without this, it has nowhere good to land.
- **#664 (relaxed voice parity)** — already allows voices to diverge, so a voice authored here may legitimately carry fewer entries than default. The typo guard still applies.
