# Window focus: take the foreground with a mouse move, not an Alt tap

> **Issue:** [#1738](https://github.com/niklam/iracedeck/issues/1738) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

A bug, but the fix changes the input iRaceDeck sends on its own initiative every time it brings iRacing forward, so it gets a spec. The issue carries the report.

## The model

Measured by the maintainer in iRacing on 2026-11-21, Stream Deck, with a probe build (`6c679010`) that switched the focuser's input from a file without a rebuild:

- **The shipped focuser leaves the window it takes focus from in menu mode.** To be allowed to call `SetForegroundWindow`, the focuser attaches to the front window's input thread (`AttachThreadInput`) and taps Alt through `keybd_event`. A lone Alt press and release is the Windows menu key, and it lands in the window that was in front: with Notepad in front, Notepad showed its menu access keys (F, E, V, …) after iRacing had come forward, every time, windowed and borderless. With OBS in front the effect could not be observed, because OBS drops its menu cue as soon as it loses focus; where that Alt goes with OBS in front is not established.
- **The reported hotkey symptom did not reproduce.** Out of the car in a replay, windowed and borderless, with Notepad or OBS in front, a multi-action of an iRaceDeck Camera Controls step, a 500 ms delay and a Stream Deck Hotkey (V, next car) changed the camera and the followed car, and V on the keyboard worked afterwards, with the shipped focuser. In the car the camera step does nothing, which is a sim fact, not this bug.
- **No input at all also worked here.** With nothing sent before `SetForegroundWindow` (the probe's `unlock: none`), Notepad in front, out of the car in a replay, every press brought iRacing forward: the plugin log shows `iRacing window focused successfully` each time and no focus timeout. That rests on `AttachThreadInput` alone, which Windows does not promise: its foreground lock may still refuse a process that did not send the last input event, depending on what the user last typed into and on the `ForegroundLockTimeout` setting, so one machine's clean run does not establish it for every user.
- **An F24 tap or a zero-distance mouse move takes the foreground without the side effect.** Both brought iRacing forward from Notepad every time, left Notepad out of menu mode, and kept the camera and the hotkey working.
- **With the mouse move, every focus path works and the #1508 regression set passes with its follow-up off:** a Black Box key under Always and under When required, a chat message, Mouse to Sim, and Toggle Driving Line or Trigger Windshield Wipers followed by Tire Service (tires selected, not only cleared) and a chat message, with the Alt+F24 after Ctrl+Alt chords switched off.

## Decision

- **The focuser sends a zero-distance relative mouse move** (`SendInput`, `MOUSEEVENTF_MOVE`, `dx = dy = 0`) in place of the Alt tap, before `SetForegroundWindow`. Everything else in `focusIRacingWindow` stays: the window lookup, the already-focused early return, `AttachThreadInput`, the 1000 ms confirmation poll and the result codes.
- **Every focus path gets it, because they all share the one native focuser:** the press-time focus (`focusIRacingIfEnabled`), the keystroke-time focus in the keyboard service and the chat send (`focusIRacingBeforeInput`), and Mouse to Sim (`focusIRacingNow`). No path chooses its own input.
- **No parameter.** The probe's `unlock` and `release` arguments, the probe file and the deck-core gate on the #1508 follow-up are removed: the input is a property of the focuser, not something a caller picks.
- **#1508's Alt+F24 after every Ctrl+Alt chord stays.** Step 5 passed with it off, but #1508 recorded the lock as intermittent even without the Alt tap (it found the mouse move made it intermittent rather than certain), and a handful of passing presses cannot rule an intermittent lock out. The follow-up is verified, costs one tap after a Ctrl+Alt binding only, and does nothing when there is no lock; dropping it on this evidence would trade a verified fix for an unverified one.

## Alternatives rejected

- **An F24 tap.** It passed every check, but broadcasters bind F13–F24 to OBS hotkeys through macro pads and Stream Deck Hotkeys, and OBS hotkeys are global by default, so a tap on every focus could fire one, a scene switch for instance, in exactly the setup the report came from. A zero-distance mouse move reaches no hotkey and no menu. (#1508's Alt+F24 is a chord and does not match a bare F24 binding.)
- **The Alt tap with its scan code, through `SendInput`,** and **the Alt tap followed by an Alt+F24 release:** both still send the lone Alt into the front window, so both keep the side effect. Not run, by that reasoning.
- **No input at all.** It worked on every press on the maintainer's machine (above), but it leaves the focus to a Windows rule that can refuse it on another machine or after other typing, and the mouse move costs nothing a user can see: it moves no pointer, reaches no hotkey and opens no menu. The mouse move is also the input every focus path and the #1508 regression set were measured with. If a future report shows the mouse move itself doing harm, no input is the next candidate, already measured once.
- **Dropping #1508's follow-up:** above.

## Out of scope

- **The reported symptom, other programs' hotkeys ignored after a focus.** It did not reproduce here; the fix removes the one input of ours suspected in it. The reporter is asked to try the release and, if it persists, to send the plugin log with debug logging on and say what was in front and which key failed.
- Where the Alt went with OBS in front: not observable, and moot once no Alt is sent.
- The focus modes, the elevation-mismatch gate, the timeout cooldown and the focus timing (#977, #976).
- Why iRacing's text input locks after a Ctrl+Alt chord (#1508).

## Testing

- **Unit:** the `IRacingNative` wrapper and the mock keep `focusIRacingWindow()` without arguments; `keyboard-service.test.ts` keeps its #1508 cases unchanged, and the probe's gate test goes with the gate; `start-plugin.test.ts`'s focus routing test still sees one native focus call. The native input itself is not reachable from Vitest (the suite runs on the mocks), so the sim test below is its test.
- **Manual, in iRacing, on Stream Deck** (all three plugins share the focuser; Mirabox if the maintainer has it to hand):
  - Notepad in front, out of the car in a replay: the multi-action (Camera Controls, delay, Stream Deck Hotkey V) changes the camera and the car, V on the keyboard works, and Notepad is **not** left in menu mode. Windowed and borderless.
  - In the car, Notepad in front: a Black Box key under Always and under When required, a chat message, Mouse to Sim, then Toggle Driving Line and Trigger Windshield Wipers each followed by Tire Service (tires selected) and a chat message.
  - Nothing visible in iRacing from the mouse move (the pointer does not move).
