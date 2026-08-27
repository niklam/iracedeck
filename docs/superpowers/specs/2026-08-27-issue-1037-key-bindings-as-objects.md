# Key bindings as real objects, not escaped JSON strings

> **Issue:** [#1037](https://github.com/niklam/iracedeck/issues/1037) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

A binding is stored as a string containing JSON:

```json
"blackBoxLapTiming": "{\"type\":\"keyboard\",\"key\":\"f1\",\"modifiers\":[],\"code\":\"F1\"}"
```

175 of 334 keys in a real file are that shape, and they are 61% of its bytes. The file is a supported hand-editing surface — `load()` strips a UTF-8 BOM precisely so an editor's save does not break it — and escaped JSON is the shape most likely to be got wrong by hand.

The interesting question is not whether objects are nicer. It is **why the strings exist**, since that decides whether this is a small change or a storage migration. It turns out to be neither the model's fault nor a migration at all.

## Evidence

**Nothing on the read side requires strings.** `parseBinding` (`packages/deck-core/src/key-binding-utils.ts:55`) branches on the raw value: a non-empty string is `JSON.parse`d, an object is passed straight to `parseBindingObject`. The Zod `keyBindingField` union transform does the same. Both shapes are already first-class.

**That tolerance is old enough to be unconditional.** The object branch arrived in `3751baa2` (2026-03-23), first released in **v1.7.0**. Every plugin version a user could plausibly downgrade to already reads objects, so writing them is not a one-way door.

**The strings come from the writer, and the constraint is sdpi's.** `ird-key-binding` exposes `get value(): string` returning `JSON.stringify(this.currentValue)`, `set value(val: string)`, and holds `saveToStreamDeck: ((value: string) => void) | null`, obtained from sdpi's `useGlobalSettings(settingName, onChange, null)` hook. The component serialises because the hook it binds through is string-typed on our side.

**Plugin-side writers already store real objects in the same file** — `_settingsWindowBounds`, `_selectedCar` and `_raceAdminSelectedCar` are all JSON objects on disk today. So the storage layer, the schema and the deck-host mirror all carry objects fine. Only values that travel through an sdpi component binding are strings.

## Decisions

### 1. Dual-shape tolerance is permanent, not a migration window

`parseBinding` keeps accepting both forms forever, and this is stated rather than left implicit. It costs four lines, it is already there, and it is what makes every other decision cheap — a half-converted file is always valid, so nothing has to happen atomically and no step can strand a user.

Its tests must pin both shapes explicitly, so a future tidy-up cannot delete the string branch as dead code. It is not dead; it is the compatibility contract.

### 2. Normalise the whole file once, on the load-time re-save that already happens

Not "leave old strings alone and write objects going forward". That would leave a file mixed for as long as a user never re-touches a binding, which defeats the readability goal that motivates the change.

The store **already re-saves the file after a successful load** (it heals a file whose salvage dropped keys). Converting every binding string to its parsed object during that pass makes normalisation free: no new write, no new failure mode, and it lands through the same atomic temp-file-and-rename. Decision 1's downgrade evidence is what makes it safe to do in bulk.

A value that fails to parse is left exactly as it is. Normalisation must never discard a string it does not understand — the user's malformed value is theirs, and #1036 governs telling them about it.

### 3. Settle the sdpi question empirically before designing around it

Whether sdpi's `useGlobalSettings` save accepts a non-string is not answerable from the vendored bundle by inspection, and guessing it would set the shape of the whole change. It is a five-minute experiment in a live Property Inspector: call `save({...})` and read back what lands in the file.

Two outcomes, both acceptable, in preference order:

1. **The hook passes the value through.** Then `ird-key-binding` widens its own types and stops calling `JSON.stringify` — a handful of lines, and the sdpi binding keeps owning the value.
2. **The hook coerces to a string.** Then the component bypasses the value plumbing for its save and writes through the Stream Deck client directly, keeping the hook for change notification only. More code, and it puts one component on a private path, so it is the fallback rather than the plan.

Do not begin implementation before this is answered; it decides which of the two the work is.

### 4. Find the raw string readers before changing the writer

Anything comparing or matching a raw binding value instead of going through `parseBinding` breaks silently the moment shapes change, and a silent break here reads to a user as "my binding disappeared". `ird-binding-status` is the known risk: it reads bindings out of the PI DOM rather than from settings. Auditing for these is part of the work, not a follow-up.

## Alternatives rejected

- **A dedicated one-shot migration pass.** Unnecessary ceremony given decision 2 rides an existing write, and a bespoke migration is a new thing that can fail part-way.
- **Leave stored strings untouched and only write objects for newly-edited keys.** Decision 2 — the goal is a readable file, and this delivers a mixed one indefinitely.
- **Change the storage format without touching the component.** There is nothing else to change; the component is the only producer.
- **Leave the format alone.** Defensible on pure engineering grounds — it works — but it keeps a 61%-of-the-file hazard on a surface we already accept people edit by hand.

## Consequences

The `.claude/rules/keyboard-shortcuts.md` line "The `ird-key-binding` component stores values as JSON strings" becomes false and must change in the same PR, along with the binding examples in `global-settings.md`.

User-visible effect is nil — this is a **Maintenance** changelog line at most. The file gets more readable, which is the entire point, and #996's exported artefact gets more readable with it.
