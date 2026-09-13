# Session Info press action

> **Issue:** [#1165](https://github.com/niklam/iracedeck/issues/1165) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

Session Info gains a per-key **On press** setting, and the key keeps rendering its live value whatever the setting says.

- **Settings.** `onPress: z.enum(["none", "binding"]).default("none")` and `pressBinding: z.string().default("")`, the global setting key of the chosen binding (e.g. `telemetryControlMarkEvent`, `blackBoxWeather`). An empty or unknown `pressBinding` behaves as `none`. Both keys are action settings, so existing keys are untouched and default to today's behaviour.
- **The list is iRaceDeck's own global bindings.** The picker is built at compile time from `data/key-bindings.json`, grouped by its categories, which are the same groups the settings window's Key Bindings tab shows. Choosing a binding means *use that binding*, never *copy its key*: a rebind in the settings window reaches every Session Info key that uses it, and a SimHub role works the same as a keyboard key.
- **Hold-only bindings are excluded** (look direction, push-to-talk and similar), since a press would tap something designed to be held. This needs the data to say which bindings are hold-only, either a flag in `key-bindings.json` or a derivation from the comms catalog, chosen at implementation.
- **Dispatch.** A black-box binding (any key in `BLACK_BOX_GLOBAL_KEYS`) goes through `showBlackBox()` from `shared/black-box.ts`, the atomic prime-then-target sequence of #818. A black-box hotkey is a toggle and telemetry never reports the open box, so a plain tap would close the box when it was already open, which is the opposite of what a "show weather" press means. Every other binding is `tapBinding(pressBinding)`. Focusing iRacing first is the keyboard service's job since #977 and needs nothing here.
- **Missing binding.** `isBindingMissing(pressBinding)` per context drives `applyBindingWarning` on the dynamic Session Info icon, recomputed inside the regenerate callback so a binding set later clears it. The Property Inspector names the chosen binding and shows whether it is set.
- **Shared fragment.** The schema fields, the dispatch and the missing-binding check live in one module in `iracing-actions/src/shared/`, and Session Info is its first consumer. Telemetry Display is the obvious second; it is not wired here.

## How #560 fits

#560 wants the Session Info press to cycle display modes. A press can only mean one thing, so both features are options of this single `onPress` enum: #560 adds `"cycle-modes"`, and nothing needs migrating because `none` stays the default.

## Alternatives rejected

- **A per-action `ird-key-binding`.** It stores a raw key on each Session Info key. That bypasses the global binding the owning action uses, cannot hold a SimHub role, and has to be edited on every key after a rebind in iRacing.
- **Mode-specific curated options.** They guess the driver's next step from the displayed value and go stale as bindings are added. The request's own two examples cross categories (telemetry, black boxes).
- **SDK commands.** Neither Mark Event nor any black box has an SDK broadcast (`docs/keyboard-shortcuts.md`), so for the requested presses a key binding is the only route. Nothing stops a later option from adding SDK one-shots to the same enum.
- **A plain tap for black boxes.** It toggles, so a press would sometimes close the box the driver asked to see.

## Left to implementation

How the comms catalog represents a display action whose press is an optional, user-chosen keybind: it excludes Session Info today because the action sends nothing.
