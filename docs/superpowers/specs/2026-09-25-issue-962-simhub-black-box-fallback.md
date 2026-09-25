# Show black box with SimHub-bound boxes — keyboard-first prime and a serialized fallback

> **Issue:** [#962](https://github.com/niklam/iracedeck/issues/962) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

Showing a specific black box presses a *different* box first (the prime) and then the target, because a black-box hotkey toggles and telemetry never reports which box is open (#818). Both presses leave as one atomic `SendInput` batch through `tapSequence`, so the prime never renders. A SimHub Control Mapper role goes over HTTP and cannot join that batch, so `tapSequence` returns `false` for it and the black box never opens.

Two problems follow from that, and the issue has both:

1. **A bug.** `resolvePrimeKey` in `packages/iracing-actions/src/shared/black-box.ts` picks the prime with `isConfigured`, which counts a SimHub role as configured. With Lap Timing bound to a SimHub role and Standings bound to a key, the runtime picks Lap Timing, `tapSequence` refuses it, and nothing opens, even though an atomic path existed. The PI caveat stays hidden in that case because it correctly sees a keyboard-bound candidate, so the PI and the runtime disagree.
2. **A missing path.** A user whose Fuel box (or every other box) is bound only to SimHub gets no black box at all. The requester would accept a brief flash of the priming box in exchange for the box opening. The maintainer chose that trade-off on 2026-09-25.

`showBlackBox` is shared: Fuel Service (keypad) and Setup Chassis (keypad and dial surface) all call it, and both PIs render `ird-black-box-caveat`. Everything below applies to all three callers.

## Decision

### 1. Prime selection is keyboard-first

`resolvePrimeKey(targetId, isConfigured, isKeyboardBound)` scans in two tiers and keeps the existing order within each tier (Lap Timing preferred, then `BLACK_BOX_GLOBAL_KEYS` declaration order, never the target):

1. the first **keyboard-bound** box;
2. otherwise the first **configured** box (so a SimHub role).

It returns `null` only when no other box has any binding, as today.

The keyboard tier comes first even when the target is itself a SimHub role. The path is serialized anyway then, but a keyboard prime is a local `SendInput` with no network in it, so the gap before the target press is shorter and has no HTTP failure mode.

### 2. `showBlackBox` chooses the path up front

```text
target unbound                        -> skip (false), as today
no prime                              -> skip (false), as today
target AND prime keyboard-bound       -> tapSequence([prime, target]) — atomic, no flash
otherwise (a SimHub role is involved) -> serialized: tap(prime); only if it went out, tap(target)
```

- The path is decided from the bindings, **not** by calling `tapSequence` and reading its `false`. When both keys are keyboard-bound and `tapSequence` still returns `false` (a key with no scan-code mapping), the result stays **skip**. A keyboard-only setup never falls back to two separate taps, so the no-flash guarantee #818 made for keyboard users does not change.
- **The target is pressed only when the prime tap actually went out.** If SimHub is unreachable and the prime press is lost, pressing the target alone would toggle the box OFF whenever it was already shown, which is worse than doing nothing (the reason `resolvePrimeKey` returns `null` instead of pressing the target alone). If the *target* press fails after a successful prime, the prime box is left showing. That is harmless and needs no rollback.
- A failed serialized attempt is logged at `debug` like today's skip, and `showBlackBox` returns `false`. Callers already ignore that result for the value change, so the fuel or setup value still changes.

`ShowBlackBoxDeps` gains `isKeyboardBound(settingKey)` and `tap(settingKey): Promise<boolean>`. The three callers wire them to the base-class helpers.

### 3. Deck-core reports whether a tap went out

- `IBindingDispatcher.tap(settingKey)` returns `Promise<boolean>`: `true` when the press was dispatched (keyboard: `sendKeyCombination` succeeded; SimHub: `startRole` succeeded), `false` when unbound, SimHub is not initialized, or the send failed. A SimHub `stopRole` failure after a successful start still returns `true`: the press went out, and the existing warning about the role staying active remains. `ConnectionStateAwareAction.tapBinding` passes the boolean through. Every current caller ignores the old `void` result, so the widening needs no call-site changes.
- `IBindingDispatcher.isKeyboardBound(settingKey)` is added beside `isConfigured`: `true` only for a parsed keyboard binding. It is exposed to actions as `isBindingKeyboardBound(key)` next to `isBindingMissing`.
- `tapSequence` does not change: it still returns `false` for a SimHub role and never degrades on its own. The serialized path is iRacing policy and lives in `shared/black-box.ts`, beside the prime choice and `BLACK_BOX_SEQUENCE_HOLD_MS`, not in deck-core.

### 4. The PI caveat has two severities

`ird-black-box-caveat` mirrors the runtime's decision instead of treating SimHub as unusable:

| Bindings (checkbox ticked) | Line shown |
| --- | --- |
| Target unbound, or no other box bound at all | `message`: the existing warning, rewritten to say "black-box bindings" rather than "keyboard bindings" (SimHub roles now count) |
| Target is a SimHub role, or no other box is keyboard-bound but one is a SimHub role | new `simhub-message`: info styling, "…is bound to a SimHub role, so the priming box may flash briefly before the X box opens." |
| Target and at least one other box keyboard-bound | nothing |

The component gains an `isSimHubBinding(raw)` helper beside `isKeyboardBinding`. Both PIs pass the new attribute, and Setup Chassis's inline script, which already rewrites `message` when a mode switches between the In-Car and Pit Stop boxes, rewrites `simhub-message` too. The info line uses the neutral supporting-text style. The warning keeps its current look.

## Alternatives rejected

- **Keyboard-first prime only, SimHub still excluded.** No flash ever, but a SimHub-only user still gets nothing. The maintainer chose the fallback.
- **Grey out the checkbox when a SimHub binding is set.** The bindings are global and the toggle is per key, so the checkbox would change state because of a setting on another page. The caveat already explains the state in place.
- **Serialize inside `tapSequence`.** It would put the black-box trade-off into the generic atomic API, and every future caller of `tapSequence` would inherit a silent non-atomic degrade. Keeping the API's refuse-rather-than-degrade contract and choosing the path in the policy module keeps each layer honest.
- **Fall back to two taps whenever `tapSequence` returns `false`.** This would also serialize keyboard setups with an unmapped key, bringing back the #818 flash for users who never had SimHub in the picture.

## Out of scope

- Making a SimHub role join the atomic batch, or measuring and tuning the gap between the two serialized presses. The flash is the documented trade-off.
- Black-box consumers that do not go through `showBlackBox`, such as the Black Box Selector's direct toggles.
- The comms catalog's status-line declaration for `show-pit-stop-black-box`: it already counts a SimHub role as configured, which is now correct.

## Affected artifacts

- `deck-core`: `binding-dispatcher.ts` (`tap` → boolean, `tapSimHub` success, `isKeyboardBound`) and `connection-state-aware-action.ts` (`tapBinding` return, `isBindingKeyboardBound`), with tests.
- `iracing-actions`: `shared/black-box.ts` and tests. `fuel-service.ts`, `setup-chassis.ts` and `setup-chassis-dial-surface.ts` wire the new deps. The caveat attributes go in `fuel-service.ejs` and `setup-chassis.ejs`.
- `pi-components`: `black-box-caveat.ts` and its test.
- Website: the Show black box paragraphs on the Fuel Service and Setup Chassis pages, and `changelog.mdx`. The prime fix is a **Bug Fixes** line (it shipped in 2.3.0) and SimHub support is an **Improvements** line.
- Rules: the *Atomic key sequences* section of `.claude/rules/keyboard-shortcuts.md` (the serialized fallback, and where it lives).

## Testing

**Suite**

- `resolvePrimeKey`: keyboard Lap Timing wins; SimHub Lap Timing loses to a keyboard Standings (the bug); no keyboard box, so the first SimHub box is chosen; the target is never its own prime; `null` when nothing else is bound.
- `showBlackBox`: both keyboard → `tapSequence` called, `tap` never called; keyboard `tapSequence` `false` → skip with no `tap`; SimHub target or SimHub prime → `tap(prime)` then `tap(target)` in order; prime `tap` `false` → target never tapped, returns `false`.
- Dispatcher: `tap` returns `true`/`false` for keyboard success, keyboard failure, SimHub start success (including a stop failure), SimHub start failure, SimHub uninitialized, and unbound; `isKeyboardBound` for keyboard, SimHub, empty and corrupt values.
- Caveat: the three rows of the table, including the bug's configuration (SimHub Lap Timing plus keyboard Standings shows nothing).

**Manual (iRacing with SimHub Control Mapper)**

1. Fuel box keyboard, Lap Timing a SimHub role, Standings keyboard: the Fuel box opens with no flash and the PI shows no caveat. This is the bug.
2. Fuel box a SimHub role, Lap Timing keyboard: the Fuel box opens, possibly after a brief Lap Timing flash, and the PI shows the info line.
3. Every box a SimHub role: the Fuel box opens through two SimHub taps.
4. Case 2 with SimHub closed: the fuel value changes, no black box is toggled, and the log shows the skipped prime.
5. Repeat case 2 on Setup Chassis, keypad and dial, for both the In-Car and Pit Stop boxes.
6. Keyboard-only bindings: unchanged, with no flash.
