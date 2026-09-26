# Installed Voices — a Card per Pack, in a Voice Packs Card of Its Own

> **Issue:** [#1145](https://github.com/niklam/iracedeck/issues/1145) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

The Installed Voices list in the settings window renders one line per pack: label, provenance badge, version, and then either the *Kept up to date by iRaceDeck* note (the managed pack, since #1034 stage 3) or the Remove button. Columns start where the previous one ends, so the badges of two rows do not align, the version reads as a stray number, and the note or the two-step Remove crowds the name line. Niklas asked for a different shape during the #1034 stage 3 manual test (2026-09-08).

Two more failures surfaced once third-party packs were installed (Niklas, 2026-09-26, with four sideloaded packs all labelled *Tixer87's Voice Packs*):

- **Long names do not fit.** The list sits inside an `sdpi-item`, whose label column takes most of the card's width, so a 21-character pack name wraps onto three lines.
- **Packs sharing a label cannot be told apart.** Each of the four packs provides a different voice, and the voice dropdown names them apart (`Tixer87's Voice Packs: Ryan`) — but the list shows only the pack label, so four identical rows differ by version number alone and nothing says which row to remove to get rid of a given voice. Since #1144 a pack is addressed as `<pack>::<voice>`, and the list is the one place that has to connect the two halves.

## Goals

- Every row's badge starts at the same x, right-aligned in its column.
- The version reads as a label, in the badge family, immediately left of the provenance badge.
- Each row names the voices its pack provides, in the same words the dropdown uses after the pack prefix.
- The managed-pack note and the Remove control each get a line of their own.
- A long pack name wraps without breaking the alignment of the pills.
- Everything about voice packs — installed, Rescan / Open folder, Available to Download — lives in one card on the right-hand side, above Setup Warning Patterns.

## Non-goals

- Designing for many packs. A handful is the expectation; a longer list is a separate design if it ever happens.
- Any change to the data: the run-scoped `_voicePacks` payload already carries each pack's `voices[]`, and the provenance values and the managed flag stay as they are. No plugin change.
- The voice dropdown and its naming rule. `voice-labels.ts` prefixes per pack and #1147 owns changing that; two packs that label both themselves and their only voice identically still render identically there, and would here too, apart from their version and provenance.

## Decisions

**A three-line card per pack.**

```text
Tixer87's Voice Packs                 [1.0.1] [Installed by hand]
Voice: Peter Griffin
[Remove]
```

- **Line one** — the pack label at the left, then a right-aligned group of two pills: the version and the provenance badge, version first. The line is a wrapping flex row: when label and pills do not fit side by side, the pill group drops beneath the label and stays right-aligned, so the badges still share one right edge. The label itself breaks anywhere rather than overflowing.
- **Line two** — the voices: `Voice: <label>` for one, `Voices: <label>, <label>` for several, the voices' own labels as the manifest gives them. Always shown, even when the voice's label equals the pack's (`Voice: Default`): a line that appears only sometimes makes the reader wonder what its absence means. A pack with no voices renders no voices line — the scanner lists no such pack since #1144, and the bundled-seed branch that could is a relic kept for robustness.
- **Line three** — what the user can do or needs to know, left-aligned: the Remove button with its existing two-step *Remove — are you sure?* state; *Kept up to date by iRaceDeck* for the managed pack; the directory for a development-root pack (#1143), with the full path as its title; *Included with the plugin* for the legacy bundled seed. Its own line because the armed Remove is wide, and on the voices line it would push the voices into a wrap.

Problems (the ignored packs with their reason) keep their own rows under the list, unchanged.

**Pills are one visual family.** The version pill reuses the badge styling with a neutral colour, so the eye reads "1.0.0 · Downloaded" as two facts about the same thing rather than a number floating beside a badge.

**One Voice Packs card.** A new `voice-packs` partial holds everything the Race Engineer partial rendered under `locals.settingsWindow` — Installed Voices, its folder text, Rescan and Open folder, Available to Download — and `settings-window.ejs` renders it as its own accordion card titled *Voice Packs*, stacked with Setup Warning Patterns in the right-hand column. The Race Engineer card keeps the voice dropdown, name and volumes. Splitting the installed list from the catalog would put two halves of one job in two cards. The installed list drops its `sdpi-item` wrapper for a plain sub-heading, which is what gives it the card's full width: the label column was what squeezed the pack names.

The partial is settings-window only, as the block it replaces was — every command it sends is handled by the settings-window command handler, and a Property Inspector's `sendToPlugin` would go to its own action.

**The two right-hand cards stack.** The `.sw-grid` is `auto-fit` columns with `align-items: start`, so two cards in one column need a wrapper: a column element holding Voice Packs then Setup Warning Patterns, which collapses naturally into the single-column layout on a narrow window.

## Out of scope

- The dropdown's labels (see Non-goals) and a voice's own identity on the row beyond its label — no pack id, no voice id.
- Property Inspectors: the voice-pack block never rendered there.
- Sorting or grouping packs that share a label.

## Testing

- **Component tests assert structure, not pixels.** `voice-pack-list.test.ts` pins the three lines (which elements sit in which line, pill order, the voices text for one and for several voices, no voices line for a pack with none), the note versus the button per branch, and the existing behaviours — armed Remove keyed to pack identity, managed and development rows without Remove.
- **Partial tests** move with the block: `race-engineer-voices-partial.test.ts` asserts the voice-pack block is gone from `race-engineer-settings` and present in the new partial, still gated on `settingsWindow`.
- **Screenshot** regenerated with `pnpm capture:settings`.
- **Manual**: Niklas opens the settings window with the managed pack plus several sideloaded packs sharing a label, including one with a long label and one providing two voices; checks the badges align, each row names its voices, the two-step Remove works, and the narrow-window layout stacks the cards.

## Affected artifacts

- `@iracedeck/pi-components` — `voice-pack-list.ts` markup and CSS, its tests; the new `voice-packs` partial and `race-engineer-settings.ejs`, and the partial test
- `@iracedeck/iracing-actions` — `settings-window.ejs` (the new card, the right-hand stack)
- `.claude/rules/settings-window.md` — the card list
- Website — `docs/getting-started/settings.md` and any voice-pack page that locates the section; the Race Engineer tab screenshot; changelog under Improvements
