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

`deck-core/src/dial-gesture.ts` gains `createHoldPreview({ thresholdMs, onThreshold, onCancel })` returning `{ down(), up(), rotated(), dispose() }`: `down` arms the timer with the same `getDualPressThresholdMs()` the classifier uses (so the preview appears at exactly the instant a release would count as long), `up` and `rotated` clear it and call `onCancel` if it had fired, `dispose` clears it on `willDisappear`. Each dial surface owns one per context and implements two small things: what its preview looks like, and reverting to its normal strip.

`onThreshold` **returns a boolean** — whether it actually drew anything. That is what lets the helper own "did we show something", so a surface whose gesture has no knowable outcome arms, shows nothing, and pushes no pointless revert frame at release; without it every surface would carry the same guard. The flag gating is a constant-folded ternary at construction (`__FEATURE_DIAL_FEEDBACK__ ? createHoldPreview(…) : NOOP`) rather than a condition at each of the four call sites: the call sites stay unconditional, terser drops the closures, and the non-Elgato bundles carry none of it either way.

This section originally said ten surfaces adopt it, every dial with a press gesture. Implementation proved that wrong twice over, and the amendment below is what shipped (Niklas, 2026-09-20).

**Only a KNOWABLE outcome is previewed.** A preview is drawn only where the plugin can compute the state the gesture will produce *before* it fires; a gesture that merely performs an action iRacing never reports back shows nothing and arms nothing. The strip simply stays still for those. This replaces the original "the value **or label** the gesture will set": naming the verb ("TOGGLE FCY") was considered and rejected — it answers "what does this button do", which the trigger description already answers, not "what will the strip look like after I let go", which is what was asked for. Showing a state the plugin only assumed would be worse than showing nothing, because the driver's whole rule is to trust the change they see.

An audit of every long-press gesture on every dial surface, evidence-based against the code rather than against what iRacing might expose, leaves **five surfaces**:

| Surface | Gesture | How the outcome is known |
|---|---|---|
| Fuel Service | `toggle-fueling`, `fill-to-max`, `toggle-autofuel-mode`, `switch-mode` | `isFuelFillOn` / the at-max test / `isAutofuelActive` / the plugin's own `dial.mode` |
| Setup Brakes | `toggle-abs` | `dcABS` via the keypad half's `absToggleState` |
| Setup Traction | `toggle-tc` | `dcTractionControl` via the keypad half's `tcToggleState` |
| Setup Chassis | `toggle-spring-side` | the plugin owns the setting the gesture flips |
| Camera Controls | `focus-my-car` | `PlayerCarIdx` → the car's number in the session info, the same lookup the keypad's Focus My Car dispatches |

Camera Controls' `focus-on-leader` looked knowable and is not, which is the sharpest case in the set and the one most likely to be re-proposed. It does not dispatch a car number: it calls `switchPos(FocusAtLeader)`, and **iRacing** resolves the leader from its own official scoring. The plugin's canonical order is lap-progress-based and moves at the overtake, while official position moves at the next start/finish crossing — so a preview built from our order would name the wrong car for up to a lap after every mid-lap pass for the lead, and before the green would show the grid instead of whatever iRacing picks. This surface's own header already records that divergence as the reason its race-position rotation stopped dispatching a bare position. If a leader preview is ever wanted, the honest route is to make the gesture dispatch the car number our order names, so preview and execution agree by construction — but that changes what the gesture does and diverges from the keypad's Focus on Leader, so it is a separate decision.

Everything else arms nothing, and the reasons are worth recording because they will be re-asked. Setup Fuel's FCY toggle, Setup Aero's rear-flap toggle, Cockpit Misc's four, View Adjustment's two, Splits & Reference's five, Camera Editor Adjustments' thirty-one and Black Box Selector's `open-selected-box` are all a single `tapBinding` into iRacing with no readback — several are even named `*-toggle` while their state is unreadable, and most of those surfaces already render `""` in the value slot for exactly this reason. Force Feedback's Auto FFB asks iRacing to compute a new max force, so the result exists only in the next telemetry tick *after* the release. Setup Chassis's black-box gesture is the documented "telemetry never reports which black box is open". Setup Engine and Setup Hybrid have `GESTURE_ACTIONS = ["none"]`, so no gesture exists to preview.

**Audio Controls is out entirely**, and not because of knowability: that dial has no long press at all. Its `rotate()` takes no `pressed` flag, it has no `pressStart` / `rotatedWhilePressed` / `classifyDialRelease`, and mute fires at `dialDown` by a deliberate documented choice. There is no hold to preview, and adding one would move mute from press-down to release — a user-visible change to an existing gesture, which this issue is not. Recorded as a possible follow-up, not built here.

### 3. What a preview shows

The strip's normal layout with the knowable outcome in the value slot, in the outcome's own colour where the surface has one (Fuel Service's green/red fill states) and the dash box's accent otherwise, underlined by a thin pending bar. One mark, drawn from one place — `iracing-actions/src/shared/dial-preview.ts` — so `renderDialBox` and the surfaces that draw their own pixmap cannot drift into slightly different marks, the way the double chevron is one marker across two actions in `icons.md`. Not a modal "release now" text: the driver asked to see the change, not an instruction.

The preview is **not a one-off frame**. Every one of these surfaces has a heartbeat, a telemetry change-detector, or a `refreshAll` that would wipe a pushed frame mid-hold, and each keys its dedupe on a signature that a preview frame would poison. So the pending state lives on the context, every render path draws it while it is pending, and the revert is an ordinary render — which also keeps the ≤10 `setFeedback`/s cap intact, since the preview adds one frame at the threshold and one at release.

### 4. Cancel paths

Push+turn: `rotated()` fires from `onDialRotate` when `pressed` is set, clears the timer and reverts the preview, and the existing `rotatedWhilePressed` guard still turns the release into a no-op. Settings change or `willDisappear` mid-hold: `dispose()`. A threshold change while held is ignored; the timer was armed with the value at press time, which is also what the classifier will use.

### 5. Keypad long-press keys

The same idea applies to keypad keys with a dual-press action (the key image could show the long-press outcome at threshold), and the requester hinted at it. Deliberately out of scope: the key image path is a different renderer, the dual-press keys are many, and the dial version proves the helper first. Recorded as a follow-up in the issue, not built here.

## Alternatives rejected

- **Executing at the threshold instead of at release.** The rebuild rejected it for push+turn races and instant-release hosts; nothing has changed.
- **Fuel Service only.** The helper is small and the surfaces already share the gesture vocabulary; leaving nine dials without it would make the tenth feel like a different product. What actually decided the set was knowability, not surface count — see decision 2 — but the principle held: the helper is shared, and every surface that *can* preview does.
- **A "release now" banner.** Tells the driver what to do instead of showing what will happen; the requester asked for the latter.
- **Naming the action where the outcome is unknowable** ("TOGGLE FCY", "RECENTER"). Rejected at implementation (Niklas, 2026-09-20). It would have given nine more dials *a* mid-hold change, which is the literal ask, but the thing changing would have been a restatement of the trigger description rather than the outcome — and it would have taught drivers to trust a mark that, on those very dials, can never mean what it means on Fuel Service. A strip that stays still is honest about the plugin not knowing.

## Testing

`dial-gesture.test.ts`: the helper fires once at the threshold, not before; `up` before the threshold fires nothing; `rotated` after the threshold calls `onCancel`; `dispose` clears a pending timer. Per surface: a fake-timer test that the preview frame is pushed at the threshold and the normal frame at release, and that the push+turn path reverts. The flag-off path (`vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false)`) pushes nothing.

Two more that the amendment above makes load-bearing. **A heartbeat or telemetry tick mid-hold must leave the preview up** — the render paths are preview-aware precisely so a pushed frame cannot be wiped, and that is the regression nobody would notice by hand, because it needs a hold longer than the surface's refresh interval. **An unknowable outcome must push nothing**: where the state comes from telemetry (`dcABS`, `dcTractionControl`, the leader's car number), absent telemetry previews NOTHING rather than a default — the honesty case, and the one a careless fallback would quietly break.

Manual on hardware: Fuel Service fill toggle, one Setup dial; a hold with a rotation in the middle; and a hold on a dial whose gesture is unknowable, confirming the strip stays still.

## Affected artifacts

- `packages/deck-core/src/dial-gesture.ts` (+ test); `iracing-actions/src/shared/dial-preview.ts` (new) and `shared/dial-box.ts`; the five dial-surface modules named in decision 2 — Fuel Service, Setup Brakes, Setup Traction, Setup Chassis, Camera Controls.
- Website: the "On a dial" sections of those five action pages gain one sentence; changelog entry.
- Rules: `encoders-and-touchscreen.md` — the "no timer" wording, the preview convention, and the knowable-outcome rule a future dial surface has to apply to its own gestures.
