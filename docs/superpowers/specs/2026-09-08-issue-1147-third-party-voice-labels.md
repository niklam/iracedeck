# Third-Party Voices Are Named by Their Pack in the Dropdown

> **Issue:** [#1147](https://github.com/niklam/iracedeck/issues/1147) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

`voiceDisplayLabels` (`packages/deck-core/src/voice-labels.ts`, #1034) decides per pack whether its voices carry the pack's name in front: they do when the pack ships more than one voice, or a voice whose label differs from the pack's. A pack whose manifest labels both itself and its single voice the same as another pack lands in the bare branch beside it, and the dropdown shows two entries reading the same string. The rule accepted that on 2026-09-01 as rarer than the alternative it rejected — prefixing on collision, which renames an entry the user had learned the moment a second pack arrives.

The #1143 manual test met the accepted case on its first day: a hand-made copy of the shipped pack, with the ids changed and the labels left as "Default", produced two `Default` entries. A copied manifest is how a first sideload is made, so the case is the common one, not the rare one.

## Decision

**Prefixed iff the pack is not the managed one.** Every voice from a pack other than the one the launch step keeps current (`isManagedVoicePack`, today `default`) is named `<pack label>: <voice label>`. The managed pack's voices keep the bare voice label, so a fresh install still shows `Default`.

What this keeps from the 2026-09-01 rule: an entry's name never depends on what else is installed. It depends on that pack's own manifest and on which pack is managed, both fixed the moment the pack is installed, so no later install renames anything. What it drops: the per-pack heuristic, and with it the accepted collision.

Rejected: prefixing on collision only (the renaming the original rule was written to avoid). Rejected: prefixing the managed pack too (`iRaceDeck: Default`) — the entry every user starts with should not change name for a rule about other packs, and the managed pack is the one whose origin needs no saying.

`voiceDisplayLabels` takes the managed-pack test as a parameter rather than importing `isManagedVoicePack` from the launch step, so deck-core's label composer stays free of the launch module and the tests can name any pack managed.

## Interaction with #1144

#1144 namespaces voice ids as `<pack id>::<voice id>`; it changes the values behind the dropdown, this issue changes the text in front of it. The two are independent: whichever lands second updates the other's fixtures. Neither replaces the other — a namespaced id is not something a user reads.

## Failure modes

| Situation | Behaviour |
|---|---|
| Two third-party packs with the same pack label and voice label | Still two identical entries. Pack labels are not unique (ids are). Accepted: it now needs two packs to be named identically by their authors, not one copied manifest. |
| A third-party pack whose voice label already starts with the pack label (`Vixen` / `Vixen Short`) | `Vixen: Vixen Short`. Accepted for consistency over brevity — the rule is per pack, and a single pack's voices are named the same way or not at all. |
| The managed pack id changes | The label rule follows `isManagedVoicePack`; nothing in this module names `default`. |

## Testing

- Managed pack with one voice → bare label; with several → still bare (the managed pack is never prefixed).
- Third-party pack with one voice whose label equals the pack's → prefixed.
- Two third-party packs labelled identically → two identical strings (documented, pinned so the acceptance is deliberate).
- The three plugins pass the same managed-pack test the launch step uses (a source-shape test, as for the other byte-identical regions).

## Affected artifacts

- `@iracedeck/deck-core` — `voiceDisplayLabels(packs, isManaged)`, module comment rewritten around this rule, tests
- All three plugins — the `_voiceLabels` call site
- Website — `docs/features/race-engineer-voices.md`, `docs/voice-packs/first-pack.md`, changelog (user-facing)
- Rules — `.claude/rules/settings-window.md` item 6
