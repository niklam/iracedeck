# Dials: Title Text and Show Title for the dash box

> **Issue:** [#1406](https://github.com/niklam/iracedeck/issues/1406) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

A dash-box dial gets two settings of its own, **Title Text** and **Show Title**, in its Dash Box Appearance section. They are iRaceDeck's fields, named and worded like the key's, and not Stream Deck's built-in Title. The text replaces the label the dial draws above its value ("BB", "TC1", "MISC"); empty keeps the built-in label for the dial's Mode.

## Why not Stream Deck's built-in Title

It was the first idea, and for a dial it works: our dial layouts are one full-canvas image with no `title` item, so Stream Deck draws nothing and the plugin could render the text it receives through `titleParametersDidChange`. Three things decided against it.

1. **It cannot be the same answer for keys.** On a key Stream Deck draws the user's title itself, verbatim, over the icon, and the SDK gives the plugin no way to take that over ("The title can only be set by the plugin when the user has not specified a custom title"). So keys stay on iRaceDeck's Title Text, and a dial on the built-in field would leave one action with two different places to type a title depending on which surface it sits on. Consistent UX was the stated goal.
2. **It depends on the host.** The Ulanzi adapter records that its host has no native title API, and whether Stream Dock shows a Title field for a knob or sends the event is unmeasured.
3. **It depends on event timing nobody has measured.** The title is not in `willAppear`, and the docs say the event fires "when the user updates an action's title settings". If it is not re-sent when the dial appears, the plugin would have to copy the title into its own settings anyway.

Our own fields have none of these: the text is action settings, so it is there at `willAppear` on every host, and the Mirabox knob gets it through the same renderer as the strip.

## Settings

Two fields under a new `title` object in the shared `dialAppearanceFields` (`iracing-actions/src/shared/dial-box.ts`), beside `colors`:

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dial.title.showTitle` | boolean | `true` | `false` draws no label |
| `dial.title.titleText` | string | `""` | Replaces the built-in label; `""` means the built-in label |

The key names match the key side's `titleOverrides.showTitle` / `titleText` on purpose. They follow the `colors` precedent in that file: the object is `.prefault({})` so a keypad instance or an existing dial parses to the defaults, every field is `.catch`-guarded, and a persisted non-object `title` degrades to the defaults without resetting the rest of `dial`. `showTitle` arrives from a select as the strings `"true"` / `"false"`, so it takes the union-and-transform boolean shape, never `z.coerce.boolean()`.

**Show Title is the dial's own Yes/No and does not inherit the global Show Title** (Niklas, 2026-10-10). The key field is Inherit / Yes / No over a global default that exists so a user can run graphics-only keys. On a dial the label is what says which value the number is, so hiding every key title must not strip it.

## Resolving and drawing

One place decides what is drawn, so a surface cannot forget a step: `renderDialBox`, the dispatcher all 13 dash-box surfaces already call. A surface keeps passing its built-in label as `abbr` and additionally passes the dial's `title` settings. The dispatcher resolves them before choosing the strip or knob renderer:

- `showTitle` false: no label.
- `titleText` empty: the built-in label.
- otherwise: `titleText`, with templates resolved through deck-core's `resolveTitleTemplate` (the key title's resolver) and any line break replaced by a space. A template that resolves to nothing draws nothing, as on a key; it does not fall back to the built-in label.

`renderStripBox` and `renderKnobBox` stay pure and receive the final text plus whether to draw it.

**The label must be XML-escaped where it is interpolated.** Both renderers write `abbr` into the SVG raw today, which is safe only because every built-in label is plain capitals. Escaping belongs in the two renderers, at the interpolation, so no caller can bypass it. The strip renderer is byte-pinned by `__fixtures__/dial-strip-box.json`: the existing fixtures passing unchanged is the proof that the default look did not move.

**Show Title off changes nothing else.** The value keeps its position and size, and side markers, the caption, the pending bar and the binding warning are drawn as before. On a label-only dial (Replay Markers, Splits & Reference, Camera Editor Adjustments, the identity-only Setup modes) that leaves the bordered box empty. That is accepted: it is what the user asked for.

**Length: draw it all.** The label is already `text-anchor="middle"` on both canvases, so a long text is centred and clipped evenly at both edges of the box. There is no text measurement in the repo; `fitValueFontSize` is a 0.6-em-per-character estimate. Niklas's call is to ship without fitting and judge from real labels. The one existing length step, Camera Editor Adjustments' `identityLabelScaleFor`, keeps reading the built-in label.

## Live template refresh

A key's templated title refreshes through `BaseAction`'s tracker (#899): contexts whose `titleOverrides.titleText` contains `{{` share one sim subscription, each tick schedules a 10 Hz throttled refresh, and a refresh that resolves to a different string re-runs the key's regenerate callback and pushes a key image. A dial cannot use it as it stands, because it reads a key setting and pushes a key image.

**Extract the tracker, don't copy it.** The tracking (which contexts, one shared subscription, the throttle, the last resolved string, cleanup when the last context leaves) moves out of `BaseAction` into a deck-core class that takes the text and a callback per context. `BaseAction` uses it for keys with its behaviour unchanged, and each dash-box surface owns one for its dials: it tracks a context on `willAppear` and `didReceiveSettings` when Show Title is on and the text contains `{{`, and untracks it on `willDisappear` before any await. A second copy of this logic in `iracing-actions` was rejected: the tick-cost fix from #1339 and the teardown reasoning already recorded in `base-action.ts` would have to be kept right in two places.

Two constraints on the dial side:

- **A title refresh shares the dial's push budget.** Dial-canvas pushes are capped at 10 per second per dial. The refresh goes through the surface's existing render path and its coalescing; it never adds a second stream beside value changes.
- **A refresh is a forced render.** The surfaces dedupe on a signature of what they display. The resolved title is not in it, so the tracker's callback must render unconditionally, as a settings change does, or a changed title would look like "no change".

A surface with no telemetry subscription of its own (Splits & Reference is one) is the reason the refresh cannot ride on a surface's value updates.

## Property Inspector

The two fields go at the top of the Dash Box Appearance accordion in `pi-components/partials/dial-appearance.ejs`, above the colours:

- **Show Title**: a select with Yes and No, default Yes. A select, not a checkbox, so it looks like the key's field without its Inherit option.
- **Title Text**: a single-line text field, with the key field's supporting text about template variables and its link to the variable reference.

Fifteen templates include that partial, and two of them (Black Box Selector, and Camera Controls' `camera-focus.ejs`) belong to surfaces that draw their own screen and do not go through `renderDialBox`. The partial therefore takes a parameter and those two pass it off. A test holds the two sets together: a template renders the title fields exactly when its surface calls `renderDialBox`.

## Out of scope

- **The four self-drawn dials.** Fuel Service, Audio Controls, Camera Controls and Black Box Selector draw their own strip and knob images. Fuel Service's header is a status ("REFUEL: OFF"), Audio Controls' band is the category or "ON AIR", and Camera Controls shows carousels; none is a label slot. Black Box Selector does draw a fixed "BLACK BOX" label and is the natural follow-up, as its own change to its own two renderers.
- **Show Graphics, Bold, Font Size and Position.** The dash box has one label position and no graphics to hide.
- **Fitting or shrinking long text.** See *Length* above; decided after seeing real labels.
- **Multi-line labels.** The dash box has one label line.
- **Renaming "Label Color".** The colour picker keeps its name although the text field beside it says Title.
- **Any change to key titles**, the global title defaults, or Stream Deck's built-in Title field, which stays visible in the Property Inspector and unused.
- **Ulanzi.** It has no dial display.

## Testing

Suite:

- **Schema:** a missing `title`, a non-object `title` and junk field values each parse to the defaults and leave `dial.setting`, the gestures and `colors` intact.
- **Resolution:** Show Title off; empty text; plain text; text with a line break; a template that resolves; a template that resolves to nothing.
- **Renderers, both canvases:** the existing strip fixtures unchanged; a custom text drawn in place of the label; `<`, `>` and `&` escaped; Show Title off emits no label element and leaves the value element byte-identical.
- **Tracker:** the existing `BaseAction` title-template tests pass unchanged over the extracted class. For a dial: only text containing `{{` is tracked; a tick that resolves to the same string renders nothing; a changed string renders once; untracking the last context drops the sim subscription; a tick after `willDisappear` pushes nothing.
- **One surface end to end (Setup Brakes):** a stored Title Text is drawn; changing the Mode with empty Title Text draws the new built-in label; a late refresh after `willDisappear` re-creates no context (rule 11 of `encoders-and-touchscreen.md`).
- **Property Inspector:** the title fields appear exactly on the templates whose surface calls `renderDialBox`.

By hand, on a Stream Deck +:

1. An existing profile's dials look the same after the upgrade.
2. Type a Title Text on a Setup Brakes dial: the label changes. Clear it: the built-in label returns and follows the Mode.
3. Show Title No: the label goes, the value stays put.
4. A template (for example `{{self.position}}`) in a session: the label follows the value live.
5. A long text: centred, clipped at both edges, nothing else displaced.
6. Restart Stream Deck: the title is still there.
7. The same action on a key is unaffected, and its Title Overrides section is unchanged.

And on the Mirabox knob: steps 2 to 5.
