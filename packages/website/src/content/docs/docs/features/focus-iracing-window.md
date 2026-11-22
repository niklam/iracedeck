---
title: Focus iRacing Window
description: iRaceDeck can bring iRacing to the foreground before sending keystrokes, to keep keyboard-driven actions from being lost to another window — always, only when a keystroke needs it, or never.
---

Focus iRacing Window brings the iRacing window to the foreground before iRaceDeck sends a command. Windows delivers keystrokes only to the window that has focus, so without it a button press can simply do nothing — with no error, and nothing on screen to explain why.

**This is on by default.** New installations of iRaceDeck focus iRacing automatically, so actions work out of the box.

## Why It Matters

It matters for any action that works by pressing keys — anything driven by a key binding, and anything that sends a chat message or pit macro. Those reach iRacing as keystrokes, and Windows hands keystrokes to whichever window is in front. Actions that talk to iRacing directly through its own command interface (most pit service, camera, and replay controls) are unaffected: those arrive whatever has focus. A binding you have set to a **SimHub role** is a third case: iRaceDeck hands the role to SimHub over the network instead of pressing a key itself, so it never focuses iRacing for one — how the role reaches the sim from there is SimHub's business, and depends on how you set it up in Control Mapper.

It matters most if you run iRacing in **windowed mode**, where another application can easily hold focus when you reach for the deck. It also covers the moments you might not think about: you tabbed out to check a message, clicked something on a second monitor, or a notification popped up and took focus.

When iRacing is already the active window — which is most of the time while you're driving — focusing costs nothing and changes nothing. It only does something when focus was somewhere else.

Focusing is best-effort, not a guarantee — it can't help if iRacing isn't running, and it can't take the foreground away from an application Windows won't let it. If your actions still don't reach iRacing with this on, the usual cause is iRaceDeck and iRacing running at different Windows privilege levels; iRaceDeck detects that and shows a warning at the top of the Property Inspector. Once it has, it also stops trying to bring iRacing forward for as long as the two run at different levels, because Windows will not let a lower-privileged program do it — so a press does not hold up iRaceDeck for a second. The one exception is View Adjustment's **Mouse to Sim**, which still tries, because bringing iRacing forward is what that key is for. See [Troubleshooting](/docs/getting-started/troubleshooting/#buttons-do-nothing-in-iracing-but-the-plugin-looks-connected).

## The Three Modes

Focus iRacing Window is a **global setting**: one choice that applies to all of iRaceDeck. You'll find it in the [Settings window](/docs/getting-started/settings/#general), on the **General** tab, as **Focus iRacing**. A single key can override it — see [Per-Key Override](#per-key-override) below.

- **Always** (the default) — iRacing is brought forward before every key press, dial press and dial turn, whatever the key does. Pressing a deck key means "I'm going to the sim".
- **When required** — iRacing is brought forward only before something that actually needs the foreground: a keyboard binding, a chat command (the Chat action, the tire-service `#t` macros), or a touch-strip gesture that taps a binding. Keys that talk to iRacing over its API, bindings routed through a SimHub role, and keys that never touch iRacing at all — Switch Profile, the Race Engineer toggles, the display keys — leave your window alone. What decides it is the individual key's binding rather than the action it belongs to: bound to a keyboard shortcut, it focuses; set to a SimHub role or driven over iRacing's API, it does not. Audio Controls is the mixed case — its push-to-talk, voice chat and master volume keys are keyboard bindings and do focus, while its Race Engineer and radar volumes only turn iRaceDeck's own audio up and down and leave your window where it is. Choose this if you press deck keys while working in another application and only want iRacing pulled over it when a keystroke is about to go there.
- **Never** — iRaceDeck never changes which window has focus. Keyboard-driven actions then need iRacing in front on their own.

Gestures on the Stream Deck+ **touch strip** are covered in both **Always** and **When required**: a tap or long touch that fires a key binding focuses iRacing first.

One key ignores this setting on purpose: the View Adjustment action's **Mouse to Sim** mode focuses iRacing even under **Never**, because pressing that key is an explicit request to go to the sim.

## Per-Key Override

Every key and dial has its own **Focus iRacing window** choice, in the **Common Settings** section of its Property Inspector. It decides, for that key only, whether iRacing is brought forward — both when you press it and before every keystroke the press sends:

- **Use global setting** (the default) — the key follows the global mode above. Every key starts here, so nothing changes until you pick something else.
- **Bring iRacing to the front** — the key brings iRacing forward on every press, dial press and dial turn, and before its keystrokes, whatever the global mode says — even under **Never**. Use it for a key that should always mean "go to the sim", such as one you press before a hotkey from another program that has to reach iRacing.
- **Don't bring iRacing to the front** — the key never brings iRacing forward, whatever the global mode says — even under **Always**. Whatever window is in front stays in front.

| Global mode | Use global setting | Bring iRacing to the front | Don't bring iRacing to the front |
|-------------|--------------------|----------------------------|----------------------------------|
| **Always** | On every press | On every press | Never |
| **When required** | Only before a keystroke or a chat prompt | On every press | Never |
| **Never** | Never | On every press | Never |

The choice covers everything the press does, including the repeats of a key you hold down and the keystrokes a touch-strip tap sends on a dial. It changes from the next press, with no restart. A key set to **Bring iRacing to the front** still stops trying while iRaceDeck and iRacing run at different Windows privilege levels, as described in [Why It Matters](#why-it-matters).

For example, if you stream with OBS in front and keep the global mode on **Always**, set your camera keys to **Don't bring iRacing to the front**. Camera switches talk to iRacing over its API, so the shot changes while OBS keeps focus, and your other keys still bring iRacing forward as before.

:::caution
A key that works by pressing keys — anything driven by a key binding, a chat message or a pit macro — still sends its keystrokes when set to **Don't bring iRacing to the front**. They go to whatever window is in front: iRacing if it already is, otherwise the program you are using, where they may type text or trigger a shortcut. Choose it only for keys that talk to iRacing over its API, or when you know iRacing will already be in front.
:::

On a dial, Common Settings shows only this choice: its other setting, **Flags Overlay**, draws on a key's icon and so has no effect on a dial. **Mouse to Sim** ignores this choice as it ignores the global one.

## Upgrading From an Earlier Version

If you already had iRaceDeck installed, **your existing choice is kept**: the old switch becomes **Always** if it was on and **Never** if it was off. Nothing changes on its own. Since the setting was off by default before 3.0, a long-standing installation that never touched it is most likely on **Never** — open the [Settings window](/docs/getting-started/settings/#general) and check the **General** tab to be sure.

The change takes effect immediately — no restart needed.
