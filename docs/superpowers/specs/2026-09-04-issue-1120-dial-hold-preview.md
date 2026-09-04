> **Issue:** [#1120](https://github.com/niklam/iracedeck/issues/1120) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Dial long-press: preview the outcome on the touch strip when the hold passes the threshold

## The problem

arbishop11 asked on Discord, about the Fuel Service dial: press-and-hold toggles fuel fill, but the touch strip only changes at release, so there is no way to know mid-hold whether the hold has been long enough. His rule from every other gadget is "hold until you see it change, then release". The dial rebuild (#681) classifies press versus long-press **at release** by design — a duration comparison, no timer, so long-press never races push+turn and a host that reports release instantly degrades to a short press instead of breaking. That design is right and stays; it just gives the strip nothing to show during the hold.

## What ships

On Stream Deck+, while the dial button is held and the hold passes the long-press threshold, the strip previews what releasing now will do — Fuel Service shows the fill toggle's new state highlighted, Audio Controls shows *MUTE* or the mode's press outcome, a Setup dial shows its gesture's outcome. Release executes exactly as today. A rotation while held (push+turn) cancels the press and the preview reverts at once. A short release before the threshold shows nothing new. Stream Deck only; the Mirabox and Ulanzi builds compile the preview out with the rest of the touch-strip code.

## Decisions

### 1. Display-only timer; execution unchanged

The one timer this adds is armed at `dialDown` and does exactly one thing when it fires: ask the surface for its preview and push it to the strip. It never dispatches a gesture. `classifyDialRelease` at `dialUp` remains the only place a press becomes an action, so every property the rebuild bought — push+turn pre-empting both press kinds, an instant `dialUp` degrading to a short press, no per-platform branch — survives untouched. The rule in `encoders-and-touchscreen.md` ("no timer") is amended to say "no timer decides execution"; a timer that only draws is the thing it was never forbidding.

### 2. One helper, every surface

`deck-core/src/dial-gesture.ts` gains `createHoldPreview({ thresholdMs, onThreshold, onCancel })` returning `{ down(), up(), rotated(), dispose() }`: `down` arms the timer with the same `getDualPressThresholdMs()` the classifier uses (so the preview appears at exactly the instant a release would count as long), `up` and `rotated` clear it and call `onCancel` if it had fired, `dispose` clears it on `willDisappear`. Each dial surface owns one per context and implements two small things: what its preview looks like, and reverting to its normal strip. The helper is gated by `__FEATURE_DIAL_FEEDBACK__` at the call sites, like all strip work, so the non-Elgato bundles carry none of it.

Ten surfaces adopt it: Fuel Service (the requester's case: the fill toggle, and the press gesture when it is not fill), Audio Controls (mute / PTT), the seven Setup dials that have a press gesture (Brakes, Traction, Hybrid, Fuel, Engine, Aero, Chassis — Hybrid and Engine only where a gesture is configured), Force Feedback (Auto FFB), Camera Controls, Camera Editor Adjustments, Cockpit Misc, View Adjustment, Splits & Reference, Black Box Selector. A surface whose long-press gesture is `none` arms nothing.

### 3. What a preview shows

The strip's normal layout with the outcome applied and marked as pending: the value or label the gesture will set, in the accent colour, with a thin bar under it — the same visual in every surface, drawn by `renderDialBox` for the box-style dials and by each pixmap surface for its own strip. Not a modal "release now" text: the driver asked to see the change, not an instruction. The preview obeys the ≤10 `setFeedback`/s cap through the surfaces' existing throttles; one extra frame at threshold and one at release is well inside it.

### 4. Cancel paths

Push+turn: `rotated()` fires from `onDialRotate` when `pressed` is set, clears the timer and reverts the preview, and the existing `rotatedWhilePressed` guard still turns the release into a no-op. Settings change or `willDisappear` mid-hold: `dispose()`. A threshold change while held is ignored; the timer was armed with the value at press time, which is also what the classifier will use.

### 5. Keypad long-press keys

The same idea applies to keypad keys with a dual-press action (the key image could show the long-press outcome at threshold), and the requester hinted at it. Deliberately out of scope: the key image path is a different renderer, the dual-press keys are many, and the dial version proves the helper first. Recorded as a follow-up in the issue, not built here.

## Alternatives rejected

- **Executing at the threshold instead of at release.** The rebuild rejected it for push+turn races and instant-release hosts; nothing has changed.
- **Fuel Service only.** The helper is small and the surfaces already share the gesture vocabulary; leaving nine dials without it would make the tenth feel like a different product.
- **A "release now" banner.** Tells the driver what to do instead of showing what will happen; the requester asked for the latter.

## Testing

`dial-gesture.test.ts`: the helper fires once at the threshold, not before; `up` before the threshold fires nothing; `rotated` after the threshold calls `onCancel`; `dispose` clears a pending timer. Per surface: a fake-timer test that the preview frame is pushed at the threshold and the normal frame at release, and that the push+turn path reverts. The flag-off path (`vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false)`) pushes nothing. Manual on hardware: Fuel Service fill toggle, Audio Controls mute, one Setup dial; a hold with a rotation in the middle.

## Affected artifacts

- `packages/deck-core/src/dial-gesture.ts` (+ test); the ten dial-surface modules under `packages/iracing-actions/src/actions/*/…-dial-surface.ts` and `shared/dial-box.ts`.
- Website: the "On a dial" sections of the affected action pages gain one sentence; changelog entry.
- Rules: `encoders-and-touchscreen.md` — the "no timer" wording and the preview convention.
