# Installed Voices — a Two-Line Card per Pack

> **Issue:** [#1145](https://github.com/niklam/iracedeck/issues/1145) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

The Installed Voices list in the settings window renders one line per pack: label, provenance badge, version, and then either the *Kept up to date by iRaceDeck* note (the managed pack, since #1034 stage 3) or the Remove button. Columns start where the previous one ends, so the badges of two rows do not align, the version reads as a stray number, and the note or the two-step Remove crowds the name line. Niklas asked for a different shape during the #1034 stage 3 manual test (2026-09-08).

## Goals

- Every row's badge starts at the same x, right-aligned in its column.
- The version reads as a label, in the badge family, immediately left of the provenance badge.
- The managed-pack note and the Remove control each get their own second line.
- The list lives in its own card on the right-hand side, above Setup Warning Patterns.

## Non-goals

- Designing for many packs. A handful is the expectation; a longer list is a separate design if it ever happens.
- Any change to what the list shows: the run-scoped `_voicePacks` payload, the provenance values and the managed flag stay as they are.

## Decisions

**A two-line card per pack.** Line one: the pack label at the left, then a right-aligned group of two pills — the version and the provenance badge, version first. Line two: the managed-pack note for the managed pack, or the Remove button (with its existing two-step *Remove — are you sure?* state) for every other pack. Problems (the ignored packs with their reason) keep their own rows under the list, unchanged.

**Pills are one visual family.** The version pill reuses the badge styling with a neutral colour, so the eye reads "1.0.0 · Downloaded" as two facts about the same thing rather than a number floating beside a badge.

**Its own card.** `settings-window.ejs` renders Installed Voices (list plus Rescan) as a card of its own in the right-hand column, above Setup Warning Patterns; the Race Engineer card keeps the voice dropdown and the catalog list. The partial split follows the existing rule that the settings window composes the `race-engineer-*` partials and the accordion renders a flat card there.

**Tests assert structure, not pixels.** The component tests pin the two-line structure (which elements sit in which line, the pill order, the note versus the button) and the existing behaviours (armed Remove keyed to pack identity, managed row without Remove). The screenshot is regenerated with `pnpm capture:settings`.

## Affected artifacts

- `@iracedeck/pi-components` — `voice-pack-list.ts` markup and CSS, tests
- `@iracedeck/iracing-actions` — `settings-window.ejs`, the `race-engineer-*` partials the card moves out of
- `.claude/rules/settings-window.md` — the card list
- Website — `docs/getting-started/settings.md` if it locates the section; the Race Engineer tab screenshot; changelog under Improvements
