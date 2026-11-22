# Third-Party Voices Are Named by Their Pack in the Dropdown

> **Issue:** [#1147](https://github.com/niklam/iracedeck/issues/1147) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

`voiceDisplayLabels` (`packages/voice-packs/src/voice-labels.ts`, #1034; it moved there from deck-core) decides per pack whether its voices carry the pack's name in front: they do when the pack ships more than one voice, or a voice whose label differs from the pack's. A pack whose manifest labels both itself and its single voice the same as another pack lands in the bare branch beside it, and the dropdown shows two entries reading the same string. The rule accepted that on 2026-09-01 as rarer than the alternative it rejected — prefixing on collision, which renames an entry the user had learned the moment a second pack arrives.

The #1143 manual test met the accepted case on its first day: a hand-made copy of the shipped pack, with the ids changed and the labels left as they were, produced two identical entries. A copied manifest is how a first sideload is made, so the case is the common one, not the rare one.

## Decision

**Amended 2026-11-22: since #999 this decides third-party voices only.** The first draft prefixed every pack except the managed one and kept the managed pack bare. #999 then gave iRaceDeck's own packs a prefix of their own — `iRaceDeck: <pack label>`, or `iRaceDeck: <pack label>: <voice label>` for a pack with several voices — decided by install provenance (`isFirstPartyVoicePack`: `catalog`, `bundled-seed` or `development`), not by which pack is managed; the #999 spec ("Labels and order") narrowed this issue to the rest. The shipped pack has been labelled "Shawn" since #1716, so a fresh install shows `iRaceDeck: Shawn`.

**Every voice of a third-party pack is named `<pack label>: <voice label>`.** A pack is third-party when `isFirstPartyVoicePack` says no, which includes a hand-placed copy of one of our packs with no install record. The first-party branch is unchanged.

What this keeps from the 2026-09-01 rule: an entry's name never depends on what else is installed. It depends on that pack's own manifest and install record, both fixed the moment the pack is installed, so no later install renames anything. What it drops: the per-pack heuristic for third-party packs, and with it the accepted collision with a copied manifest.

Rejected: prefixing on collision only (the renaming the original rule was written to avoid).

No new parameter. The first draft passed the managed-pack test into the composer so it would not import the launch step; the first-party test #999 added lives in the same module, so the signature stays `voiceDisplayLabels(packs)` and no call site changes.

## Interaction with #1144 and #1642

#1144 (shipped) namespaces voice ids as `<pack id>::<voice id>`; it changed the values behind the dropdown, this issue changes the text in front of it, and its tests key on the composite ids. #1642 (separate Spotter and Race Engineer voice roles) adds a second picker; the label rule applies to both unchanged.

## Failure modes

| Situation | Behaviour |
|---|---|
| Two third-party packs with the same pack label and voice label | Still two identical entries. Pack labels are not unique (ids are). Accepted: it now needs two packs to be named identically by their authors, not one copied manifest. |
| A third-party pack whose voice label already starts with the pack label (`Vixen` / `Vixen Short`) | `Vixen: Vixen Short`. Accepted for consistency over brevity — the rule is per pack, and a single pack's voices are named the same way or not at all. |
| A hand-placed copy of the shipped pack under another id, labels untouched | `Shawn: Shawn`, sorted with the third-party voices; never confused with `iRaceDeck: Shawn`. |
| A sideload whose own pack label is "iRaceDeck" | `iRaceDeck: <voice label>`, sorted below every first-party voice — the #999 spec's accepted limit, unchanged. |

## Out of scope

- The first-party label and the dropdown order (#999, shipped).
- The voice ids behind the labels (#1144, shipped).

## Testing

- Third-party pack with one voice whose label equals the pack's → prefixed; with several voices → each prefixed.
- First-party packs → unchanged from #999 (one voice: `iRaceDeck: <pack label>`; several: `iRaceDeck: <pack label>: <voice label>`).
- A pack with first-party provenance is never given the third-party prefix, and a `sideload` copy of a first-party pack always is.
- Two third-party packs labelled identically → two identical strings (documented, pinned so the acceptance is deliberate).
- By hand: sideload a copy of a pack with its labels untouched and confirm the dropdown shows it prefixed beside `iRaceDeck: Shawn`.

## Affected artifacts

- `@iracedeck/voice-packs` — `voiceDisplayLabels`' third-party branch, module comment rewritten around this rule, `voice-labels.test.ts`
- Call sites (`plugin-runtime`'s voice-packs phase, the scenario harness) — unchanged
- Website — `docs/features/race-engineer-voices.md`, `docs/voice-packs/first-pack.md`, changelog (user-facing)
- Rules — `.claude/rules/settings-window.md` item 6
