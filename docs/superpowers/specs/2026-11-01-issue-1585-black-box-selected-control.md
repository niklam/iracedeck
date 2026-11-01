> **Issue:** [#1585](https://github.com/niklam/iracedeck/issues/1585) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Operating the selected control of the open black box

## Decisions

**It belongs to Black Box Selector, not a new action.** The five controls (Select Next / Previous Control, Increment / Decrement Selected Control, Toggle Selected Control) are in iRacing's Black Box group and act on whatever box is open. That box is the Black Box Selector's subject, and a key that opens the In-Car box and a key that changes its selected control belong on one PI. #1238 settled the same question for Toggle Black Box Size the same way.

**On the keypad it is one mode with a sub-dropdown, not five modes.** `mode` gains `selected-control`, and a new `control` setting (`next`, `previous`, `increment`, `decrement`, `toggle`; default `next`) picks the press. This is the shape Direct mode already has, with `blackBox` as its sub-dropdown. It keeps the Mode dropdown short: with #1238 it reads Direct, Next, Previous, Toggle Size and Selected Control. `blackBox` and `control` each keep their value while unused, so switching modes back and forth restores the user's choice. The stored contract only grows: no existing value changes meaning, and there is no migration.

**Increment and Decrement repeat while held.** Adjusting brake bias or a pit request one step per press is a lot of presses, and every directional adjust key in the plugin already repeats. They use the shared `RepeatController` with the setup actions' repeat constants, a first tap on press and repeats until release, so the feel matches. The action declares `keyPressShape`, so press sounds play the hold rather than a tap (`press-shape-coverage.test.ts` enforces it). Select Next / Previous and Toggle are single taps: repeating a selection or a toggle on a long press would overshoot.

**No #818 prime sequence.** That sequence guarantees a specific box is shown, because box hotkeys toggle. These controls act on the box already open, and a press with no box open does nothing in the sim. That is iRacing's behaviour to own. A "show the In-Car box, then adjust" combination is out of scope.

**The bindings default to unassigned.** iRacing's Controls screen in the request shows wheel buttons for all five, which are Niklas's own assignments, not the defaults. `docs/keyboard-shortcuts.md` lists *Adjust Selected Control* as `LEFT / RIGHT` without saying which arrow is which, and the others with no key. A wrong guess would press a key the user has bound to something else, so all five are added to the Black Box group of `key-bindings.json` with `"default": ""`. The comms catalog entries show the #612 warning until each is assigned. If the implementer reads real defaults off a reset Controls screen (Niklas's), they set the two arrows to match and record it in the PR. The model does not change either way.

**On the dial, rotation becomes a choice.** `dial.rotation` is `boxes` (the default, which is today's behaviour exactly), `select-control` (clockwise taps Select Next Control, counter-clockwise Select Previous) or `adjust-control` (clockwise Increment, counter-clockwise Decrement). All three are scaled by ticks and capped at 5 taps per event, as box cycling is. One rotation setting rather than a push+turn variant: push+turn and the touch slots are Elgato-only, and a Mirabox knob would lose the adjust. A user who wants both selecting and adjusting on dials puts the action on two dials. An existing dial instance has no `dial.rotation` and parses to `boxes`, so it is unchanged.

**Gestures gain the one-shots.** `GESTURE_ACTIONS` gains `toggle-control`, `next-control` and `previous-control` beside `open-selected-box` and `none` (and #1238's `toggle-size`). Every slot still defaults to `none`. With rotation on `adjust-control` and Press on Next Control, one dial walks the box's controls and adjusts each, which is the combination this enables.

**The strip stays identity-only, naming the rotation.** iRacing reports neither the open box nor the selected control, so there is nothing live to show. The strip keeps its `BB` badge, and its wordmark names what a turn does: `BLACK BOX` for `boxes`, `SELECT` for `select-control` and `ADJUST` for `adjust-control`. The #612 dim follows the chosen rotation's two bindings rather than always the cycle pair, so the warning is about what the turn actually presses.

**Icons.** There are five new icons in `packages/icons/black-box-selector/`, on the family's flat frame (`black-box-icons.md`), and each must read as "inside a box" without looking like a specific box. In the sim the five work as a d-pad on the open box (Niklas, 2026-11-01): Select Previous / Next Control are up and down, Decrement / Increment are left and right, and Toggle is the centre press. Season 4's Quick Access box is driven the same way, with increment or toggle entering a sub-menu. So the icons are a d-pad with one direction lit, or the centre lit for Toggle, which makes the five read as one set. Niklas approves them on a review page. The key titles are `NEXT CTRL`, `PREV CTRL`, `CTRL +`, `CTRL -` and `CTRL TOGGLE`, single-line as the family requires, and set in `BLACK_BOX_TITLE_TEXT` alongside the `<desc>`.

**Sequencing with #1238.** Both issues add to `mode`, `GESTURE_ACTIONS`, the PI, the comms catalog and the website page. They are worked one after the other, or in one worktree, so neither rebases over the other's half-finished enum.

## Out of scope

- Showing the selected control's name or value. No telemetry reports it.
- Opening a specific box before adjusting (the #818 prime). The other actions' "Show Black Box" options already cover opening a box.
- Selecting a specific control by name or index. iRacing exposes only next and previous.
- Toggle Black Box Size, which is #1238's.
- A Ulanzi dial. Ulanzi stays Keypad-only.

## Testing

- Unit: the settings parse accepts `selected-control` and every `control` value and still parses the existing modes. Key resolution maps each control to its binding. Increment and Decrement repeat on hold and stop on release, while the other three tap once. `keyPressShape` returns the hold shape for the two repeating controls and a tap for the rest. On the dial, each rotation choice taps the right pair, scaled and capped, a missing `dial.rotation` parses to `boxes`, the three new gestures tap their bindings, and the #612 dim follows the chosen rotation's bindings. Every icon renders with its title.
- The comms-catalog freshness test, the key-binding cross-check and `press-shape-coverage.test.ts` cover the new keys.
- Manual, in the sim: open the In-Car box with a Direct key, then walk its controls with Select Next / Previous and change brake bias with Increment / Decrement. Holding Increment repeats and stops on release. Toggle flips a toggle control. On a Stream Deck+ dial set to Adjust Control, with Press on Next Control, one dial walks and adjusts the box. A Mirabox knob does the same with Press. With the bindings unassigned, each key shows the missing-binding warning and the strip dims for the chosen rotation.
