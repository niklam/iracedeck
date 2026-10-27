# Keyboard: release stray modifiers before every keystroke

> **Issue:** [#1508](https://github.com/niklam/iracedeck/issues/1508) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

A bug, but the fix sets a policy for every keystroke iRaceDeck sends, so it gets a spec. The issue carries the report and the diagnosis.

## The model

- **iRacing sometimes misses a modifier release that Windows saw.** After a binding such as Ctrl+Alt+L, iRacing still treats Ctrl and/or Alt as held. The plugin log shows the combination pressed and released and every later send succeeding. Tapping Ctrl and Alt on the physical keyboard restores it, sometimes only after several taps, and so does leaving the car. Why iRacing misses the release is not established, and nothing below depends on it.
- **Every keystroke after that arrives modified.** The chat send's Ctrl+V and Enter (`ChatSendWorker` in `iracing-native/src/addon.cc`) become Ctrl+Alt+V and Alt+Enter, so every chat macro goes nowhere while the SDK half of the same press still works. That is the report: Tire Service clears the tires and never selects them. A keybind would arrive the same way (F5 as Ctrl+Alt+F5).
- **The only modifiers iRaceDeck ever presses are the left-side three.** `MODIFIER_SCAN` in `deck-core/src/scan-code-map.ts` maps `ctrl`, `shift` and `alt` to 0x1D, 0x2A and 0x38. The chat paste sends `VK_CONTROL` without a scan code.
- **A key-up for a key that is not down changes nothing,** for Windows or for iRacing. A key-up for one iRacing wrongly treats as down repairs it, which is what the user's tap did.
- **Hold bindings keep a combination pressed across other presses.** `pressKeyCombination` / `releaseKeyCombination` are the only way a key stays down past one call, and the binding dispatcher's hold (`holdBinding`) is their caller.
- **Releases go out one `SendInput` call per key.** `SendScanKeys` and `SendScanKeyUp` loop `sendScanKey`, so other input can land between a combination's releases.

## Decision

- **Before every keystroke iRaceDeck emits, release every modifier it could have left down, except those a hold is keeping down.** One key-up each for left Ctrl, left Shift and left Alt, as one batch, sent unconditionally, since iRacing's view of the keys cannot be read. A missed release is then repaired by the next press, with no detection and no user action. A press that is itself dropped is repaired by the press after it, which is also what makes "several taps" harmless.
- **The keyboard service owns it, not the binding dispatcher.** Every keystroke already passes `KeyboardService` (the #977 focus site), so the release goes beside `focusIRacingBeforeInput()` at each emit: the scan-code tap, the press of a hold, the sequence, and the keysender paths (`sendKey`, and `sendKeyCombination` / `pressKeyCombination` without a scan code), which reach the same scan-code releaser. Direct `getKeyboard()` callers (Race Admin's Ctrl+V, Car Control's Escape) are covered without knowing it. A release never triggers one: releasing never presses anything.
- **The held exemption is counted in the keyboard service too.** `pressKeyCombination` counts each modifier scan code it presses, and `releaseKeyCombination` decrements the count. A modifier with a count above zero is left out of the stray release. The dispatcher does not need to be consulted, and a direct `pressKeyCombination` caller is covered too. The keysender press is asynchronous, so it is counted before its await and backed out if it fails; otherwise an emit during the await would release the modifier it had just pressed. A keysender tap awaits between its presses and releases, so its modifiers count as held until it settles, and a keysender release is counted out before its await, so a failed one cannot leak the count. The exemption covers the stray release only: a tap whose own combination includes the held modifier still releases it at the end of the tap, as it always has. (Amended during implementation, from the code review.)
- **The combination's own modifiers are released too.** A key that sends Ctrl+Alt+L gets Ctrl and Alt released just before they are pressed. That is harmless and keeps the rule to one condition, "not held". This narrows the issue's wording, which exempted the combination's own modifiers.
- **Only the left-side three, not the right-side ones or Win.** Those are what iRaceDeck presses, so they are the only stuck keys it can cause. Right Alt is AltGr on many layouts, where Windows synthesizes a left Ctrl around it, and a stray Right Alt key-up is a new shape with no case for it. Win is never pressed.
- **Chat sends release through the existing `beforeKeystrokes` hook, not inside the native pipeline.** `deck-iracing`'s `initializeSDK` already hands `ChatCommand` `focusIRacingBeforeInput` as `beforeKeystrokes`. It becomes a function that focuses and then asks the keyboard service to release stray modifiers. The hook runs on the main thread before the chat worker starts, so the release precedes the worker's Cancel, BeginChat and paste, and the held exemption applies to chat as well. A release inside `ChatSendWorker` was rejected: native code cannot see what a hold is keeping down. `ChatCommand.macro()` and the other chat broadcasts send no keystrokes and stay as they are. The Chat action's Open Chat and Reply modes, which open a prompt the driver types into, call the same hook function (`beforeChatKeystrokes`, exported from `deck-iracing`) instead of focusing alone. (Amended during implementation: the code review found those two modes outside the release.)
- **A combination's releases go out as one `SendInput` batch.** In `SendScanKeys` (after the 100 ms hold), in `SendScanKeyUp` and in the held path of `SendScanKeySequence`, the key-ups are built into one array in reverse order and sent in one call, the way `sendScanKeySequence` already batches. Nothing can then land between them. This narrows the window for a missed release; it does not replace the stray release, which is what repairs one.
- **No new native export.** The stray release is a `ScanKeyReleaser` call with the three scan codes, so the native↔TS↔mock mirror and `initializeKeyboard` are unchanged. The batching changes behaviour inside two existing exports only.
- **Logging.** The stray release writes its own debug line, `Releasing stray modifiers: [...]`, just before the emit's line, so a support log with debug on shows it on every press, the chat send's included. Nothing at info: it happens on every press, and a line per press would bury the press itself. (Amended during implementation: the first draft folded it into the emit's line, which the chat hook does not have.)

## Alternatives rejected

- **Release only at the start of a chat send.** It fixes the reported symptom, but a stuck modifier still breaks every keybind until the next chat send.
- **Detect the stuck state and release only then.** iRacing's key state cannot be read; `GetAsyncKeyState` reports Windows' view, which is already correct.
- **A second, delayed release after every combination.** It adds a sleep on the JS main thread to every tap and still misses a release dropped later than the delay.
- **Release in the binding dispatcher.** It would miss the direct `getKeyboard()` callers and the chat send, and duplicate the emit points the keyboard service already has.

## Out of scope

- Why iRacing misses the release. The fix repairs the state without needing to know.
- Right-side modifiers, AltGr, Win, and a modifier the user holds on a physical keyboard. A physically held modifier is released in Windows' view by the next deck press until its own key repeat presses it again; a modifier held as push-to-talk could drop out for that moment. This is accepted: it is the same as the user's tap.
- SimHub bindings, which send no keystrokes.
- The keysender fallback's removal (#1495).

## Testing

- `keyboard-service.test.ts`: the stray release goes out before the emit on every path that emits (scan-code tap, hold press, sequence, keysender send and hold), and not on a path that is skipped (an empty or unmappable sequence, a missing sender). It never goes out on a release. A modifier pressed by `pressKeyCombination` is left out until `releaseKeyCombination` releases it, counted, so two holds sharing a modifier keep it until both are released. It is all three scan codes, in one releaser call.
- The `beforeKeystrokes` hook in `deck-iracing`: it focuses and then releases, in that order. A throw from the release is caught like a throw from the focus.
- The native batching has no unit test (the suite runs on the mocks). It is checked by reading the diff and by the manual tests.
- **Manual, in iRacing:**
  - Tire Service after Ctrl+Alt bindings, repeatedly. The fault itself does not reproduce on the maintainer's PC, so this proves no regression; the reporter's confirmation proves the fix.
  - A lone Alt key-up does not put windowed iRacing's system menu in focus (windowed iRacing, then a keybind: the keybind still lands).
  - A look-direction hold bound with a modifier survives another key pressed while it is held.
  - A Shift-modified binding and a chat message with a capital letter still arrive correctly.
