> **Issue:** [#1238](https://github.com/niklam/iracedeck/issues/1238) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Toggle Black Box Size in the Black Box Selector

## Decisions

**It is a mode on the Black Box Selector, not a new action.** The control lives in iRacing's Black Box group and acts on whatever box is showing, which is exactly the Black Box Selector's subject. A separate action would add a manifest entry, a UUID and a registration in every plugin for one key press. The Mode dropdown already switches between a per-box press (`direct`) and box-independent presses (`next`, `previous`); `toggle-size` is a third box-independent value.

**The binding defaults to unassigned.** iRacing ships Toggle Black Box Size with no key, so any default we chose would press a key the sim does not listen to — or worse, one the user bound to something else. `blackBoxToggleSize` is added to the Black Box group of `key-bindings.json` with `"default": ""`, the same shape as `blackBoxCycleNext` / `blackBoxCyclePrevious`. The comms catalog entry is what makes that safe: the PI's binding-status warning and the key's missing-binding state show until the user assigns it, as they do for the cycle modes today.

**The stored contract only grows.** `mode` gains the enum value `toggle-size`; `direct`, `next` and `previous` and their meaning are unchanged, and `blackBox` keeps its value while unused in this mode (as it does for `next`/`previous`), so switching back restores the user's box. No migration.

**The key does not use the #818 prime-then-target sequence.** That sequence exists because a box hotkey toggles visibility; resizing is independent of which box is shown, so a single tap is the whole action. If no box is visible the press does nothing in the sim, which is iRacing's behaviour to own, not ours.

**The dial gets it as a gesture, not a rotation.** Rotation steps through boxes and stays that way. `GESTURE_ACTIONS` gains `toggle-size`, so push and long-press can each be set to it; defaults stay `none`. A dial showing a selected box and resizing it with a push is the combination this enables.

**The icon is new, in the family's flat style.** It shares the `black-box-selector/` frame (`viewBox="0 0 81.3 49.3"`, `{{backgroundColor}}` frame stroked in `{{graphic1Color}}`) and must read as "resize", not as any box — a small and a large frame with a diagonal double arrow is the starting point; the artwork is approved on a before/after gallery at the manual test. Key title `BOX SIZE`.

## Out of scope

- Setting a specific size (small/large). iRacing exposes only a toggle, and telemetry does not report the current size, so a "make it large" key could not be made deterministic.
- Resizing as part of the show-on-value-change behaviour of other actions (#818 family).
- Any change to rotation on the dial, or to the existing modes.

## Testing

- Unit: settings parse accepts `toggle-size` and still parses the three existing values; key resolution maps `toggle-size` to `blackBoxToggleSize`; the dial gesture taps the binding and reports the missing-binding state when unassigned; the icon renders with the new title.
- The existing cross-check test (every `BLACK_BOX_GLOBAL_KEYS`-style key exists in `key-bindings.json`) and the comms-catalog freshness test cover the new key.
- Manual, in the sim: assign a key to Toggle Black Box Size in iRacing and the same key in iRaceDeck; the key flips the visible box's size, on keypad and on a dial push. With the binding unassigned, the key shows the missing-binding state and the PI shows the warning.
