# Keyboard: release iRacing's Ctrl+Alt lock with an Alt+F24 tap

> **Issue:** [#1508](https://github.com/niklam/iracedeck/issues/1508) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

A bug, but the fix adds a keystroke iRaceDeck sends on its own initiative, so it gets a spec. The issue carries the report. This replaces a first draft of this spec, `2026-10-27-issue-1508-release-stray-modifiers.md`, which was written for a diagnosis that testing disproved; the work had not shipped, so the draft was removed rather than superseded.

## The model

Established by hand in iRacing on 2026-10-27, on Stream Deck and Mirabox, with the plugin's debug log beside every run:

- **After a Ctrl+Alt chord, iRacing's text input can lock.** Once locked, the chat box still opens (an SDK broadcast) but nothing typed into it is pasted or submitted — not iRaceDeck's Ctrl+V and Enter, and not the driver's own typing and Enter. Every chat-based key fails silently: Tire Service clears the tires (an SDK command) and never selects them. The plugin log shows every keystroke sent and every chat send succeeding.
- **Only an Alt+key chord releases it.** A physical Ctrl+Alt+L, Alt pressed until it lands as Alt+Enter (which also switches borderless to bordered), or any other Alt+key, from the keyboard or injected from the deck. Alt, Ctrl, Enter or Esc alone do not. Leaving the car resets it too.
- **When it locks.** Every time when the press first had to bring iRacing to the front (the focuser's ALT tap, then the injected chord); intermittently after a focus switch without that ALT tap; never in testing when iRacing was already in front. The bindings that triggered it in the field are Toggle Driving Line (Ctrl+Alt+L) and Trigger Windshield Wipers (Ctrl+Alt+W).
- **What it is not.** Not iRacing still activating: a 150 ms and then a 1000 ms wait after the focus switch changed nothing. Not a held modifier: releasing left Ctrl, Shift and Alt before every keystroke changed nothing, and neither did tapping them by hand. Not the keyboard layout: the reporter is most likely not on the maintainer's Finnish (AltGr) layout.
- **Why iRacing locks is not known,** and nothing below depends on it.

## Decision

- **After every Ctrl+Alt chord iRaceDeck sends, send an Alt+F24 tap.** A "Ctrl+Alt chord" is any combination whose modifiers include both `ctrl` and `alt`, whatever else it holds. The tap releases the lock if the chord caused one and does nothing otherwise, so it is sent unconditionally: the lock cannot be detected, since every send reports success.
  - **Verified:** with the focuser's ALT tap in place — the combination that locked iRacing every time — an Alt+F24 tap after the injected Ctrl+Alt+L stopped the lock.
- **F24, because no ordinary keyboard has it.** F13–F24 are standard keys with scan codes (F24 is 0x76), but they were last printed on IBM's 122-key terminal keyboards, so nothing a driver presses produces them and iRacing has no default binding on them. The alternatives each do something: Alt alone does not release the lock; Alt+Shift is Windows' default keyboard-layout switch; Alt+Enter switches iRacing's window mode; an Alt+letter can be a menu accelerator or an iRacing binding; an unmapped scan code was not tested to count as a key.
- **Every path that ends a Ctrl+Alt chord, in the keyboard service.** The service is the one layer every keystroke passes (the #977 focus site), so the follow-up lives there:
  - **A scan-code tap:** a second scan-code tap of Alt+F24 after the chord's. It is held for the same 100 ms as every tap, the shape that was verified; a zero-duration batch was not tested and is not used.
  - **A keysender tap** (a binding without `event.code`, or one the scan-code map cannot build): the same Alt+F24 scan-code tap once the keysender tap settles, or a keysender tap of `alt`+`f24` when no scan-code sender is configured.
  - **The release of a held Ctrl+Alt combination:** after the release, by the same means. A hold's press sends nothing extra; the chord is not complete until it is released.
  - **A sequence:** one Alt+F24 tap after the sequence's batch when any of its chords is a Ctrl+Alt chord. Not a chord appended to the batch: that would be a zero-duration Alt+F24, the shape that was not tested. The sequence's own chords stay one atomic `SendInput` call.
- **The follow-up never costs the keystroke it follows.** It runs after the chord has gone out, in its own `try`, and a failure logs a warning and leaves the chord's own result as it was. It does not focus: the chord before it already did.
- **Logging.** One debug line per follow-up, `Sending Alt+F24 after a Ctrl+Alt chord`, after the chord's own line. Nothing at info: it accompanies a press that is already logged.

## Alternatives rejected

- **Release modifiers before every keystroke** (this spec's first draft): built, reviewed and tested — it did not stop the lock, because nothing is held.
- **Wait after a focus switch before sending keys:** tested at 150 ms and 1000 ms; neither stopped the lock.
- **Replace the focuser's ALT tap with a zero-distance mouse move:** it made the lock intermittent instead of certain, so the ALT tap contributes, but it does not remove the cause. The focuser is left as it is.
- **Send the follow-up only after a focus switch:** the lock was also seen without the ALT tap, its cause is unknown, and the follow-up costs one tap on a Ctrl+Alt binding only.
- **Release the lock before every chat send instead:** it would leave keyboard bindings sent after a Ctrl+Alt chord exposed, and the chord is where the lock starts.

## Out of scope

- Why iRacing locks, and a report to iRacing. The fix works without knowing.
- A lock caused by the driver's own Ctrl+Alt key presses, which iRaceDeck does not see.
- The focuser's ALT tap and the focus timing.
- SimHub bindings, which send no keystrokes.
- A user whose macro software or iRacing setup reacts to F24 or Alt+F24: accepted as the cost of a key no keyboard has.

## Testing

- `keyboard-service.test.ts`:
  - A scan-code tap of a Ctrl+Alt chord is followed by an Alt+F24 tap (`[0x38, 0x76]`); a chord with only Ctrl, only Alt or neither is not, and Ctrl+Alt+Shift is.
  - A keysender tap of a Ctrl+Alt chord is followed by the Alt+F24 scan-code tap after it settles, or by a keysender `alt`+`f24` tap without a scan-code sender.
  - The release of a held Ctrl+Alt combination is followed by the tap, on both paths; the press is not.
  - A sequence with a Ctrl+Alt chord is followed by one Alt+F24 tap after its batch; one without is not; a skipped sequence sends nothing.
  - A failing follow-up does not change the result of the chord's send.
- **Manual, in iRacing** (Stream Deck and Mirabox):
  - With another window in front, Toggle Driving Line from the deck, then tire keys and a Chat message: the chat keeps working, every time.
  - The same with Trigger Windshield Wipers.
  - Alt+F24 has no visible effect in iRacing.
