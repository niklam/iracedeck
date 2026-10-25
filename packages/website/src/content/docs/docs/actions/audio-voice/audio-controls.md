---
title: Audio Controls
description: Adjust iRacing voice chat, master, and (on a dial) spotter volume, hold push-to-talk, and adjust iRaceDeck's own Race Engineer and Radar volume.
sidebar:
  badge:
    text: "5 modes"
    variant: tip
---

Quick access to audio levels: hold push-to-talk, raise / lower / mute iRacing voice chat volume, raise / lower the iRacing master volume, and adjust iRaceDeck's own **Race Engineer** voice and **Radar** tick levels — all without navigating menus. Placed on a Stream Deck+ dial, it becomes a volume dial: rotate to adjust the selected audio — voice chat, master, iRacing's AI spotter, or iRaceDeck's own levels — and press to talk or mute — see [On a dial](#on-a-dial).

The Mode dropdown is split into two groups:

- **iRacing audio** — Push to Talk, Voice Chat, Master (and, on a dial, Spotter). These send key presses to iRacing, so they follow your configured key bindings.
- **iRaceDeck audio** — Race Engineer Volume, Radar Volume. These adjust iRaceDeck's own audio buses directly, so they need no iRacing key binding. (These mirror the volume sliders in the Pit Crew settings.)

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector. Voice Chat and Master modes also expose an **Action** setting for Volume Up / Volume Down (and, for Voice Chat, Mute and Mute a Driver). Race Engineer Volume and Radar Volume expose an **Action** setting for Volume Up / Volume Down.

Every Volume Up and Volume Down key also has a **Key Style**, so an up and a down key placed side by side read as one volume control — see [Key Styles](#key-styles--paired--buttons).

Every volume step, from a key or the dial, plays a short tick, so you can count steps by ear — see [A tick on every step](#a-tick-on-every-step).

A key whose Mode and Action don't go together, such as Master with Mute, shows the warning triangle and does nothing when pressed. The Property Inspector never offers such a pair, but an imported or hand-edited profile can carry one. Open the key's settings and the Action switches to Volume Up.

### Push to Talk

Hold voice chat push-to-talk for as long as the button is pressed. Release the button to stop transmitting.

#### Details

- **Method:** Key binding
- **Dial:** See [On a dial](#on-a-dial)
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Voice Chat

Control voice chat volume, mute the whole channel, or mute just the driver who is talking.

#### Details

- **Method:** Key binding
- **Dial:** See [On a dial](#on-a-dial)
- **Default binding:** Depends on the selected action — see the **Action** setting below
- **Telemetry-aware icon:** No

#### Setting: Action

- **Volume Up** (default, default key `Shift+Ctrl+Alt+numpad_add`) — Pressing the button raises voice chat volume
- **Volume Down** (default key `Shift+Ctrl+Alt+numpad_subtract`) — Pressing the button lowers voice chat volume
- **Mute** (default key `Shift+Ctrl+Alt+M`) — Pressing the button toggles voice chat mute
- **Mute a Driver** (default key `Shift+Ctrl+Alt+D`) — Pressing the button taps iRacing's *Mute a Driver* control, which silences whoever is transmitting on voice chat at that moment and leaves the rest of the channel audible, so one loud or distracting driver doesn't cost you everybody else

---

### Master

Control the iRacing master volume. The Master mode has no mute option — the Action dropdown only exposes Volume Up and Volume Down.

#### Details

- **Method:** Key binding
- **Dial:** See [On a dial](#on-a-dial)
- **Default binding:** Depends on the selected action — see the **Action** setting below
- **Telemetry-aware icon:** No

#### Setting: Action

- **Volume Up** (default, default key `Shift+Alt+numpad_add`) — Pressing the button raises master volume
- **Volume Down** (default key `Shift+Alt+numpad_subtract`) — Pressing the button lowers master volume

---

### Race Engineer Volume

Adjust iRaceDeck's own **Race Engineer voice** level — the same level as the Race Engineer Volume slider in the Pit Crew settings. This controls iRaceDeck audio, not iRacing, so it needs no iRacing key binding. While the Race Engineer is disabled the level still updates, but you won't hear it until the Race Engineer is enabled.

#### Details

- **Method:** iRaceDeck audio (no iRacing command)
- **Dial:** See [On a dial](#on-a-dial)
- **Default binding:** None — controls iRaceDeck audio directly (no iRacing key binding)
- **Telemetry-aware icon:** No — in a paired [Key Style](#key-styles--paired--buttons) the key shows the current Race Engineer volume (iRaceDeck's own setting), or **OFF** while the Race Engineer is switched off

#### Setting: Action

- **Volume Up** (default) — Pressing the button raises the Race Engineer voice volume by 5% (max 100%)
- **Volume Down** — Pressing the button lowers the Race Engineer voice volume by 5% (min 0%)

---

### Radar Volume

Adjust iRaceDeck's own proximity **Radar** tick level — the same level as the Radar Volume slider in the Pit Crew settings. This controls iRaceDeck audio, not iRacing, so it needs no iRacing key binding.

#### Details

- **Method:** iRaceDeck audio (no iRacing command)
- **Dial:** See [On a dial](#on-a-dial)
- **Default binding:** None — controls iRaceDeck audio directly (no iRacing key binding)
- **Telemetry-aware icon:** No — in a paired [Key Style](#key-styles--paired--buttons) the key shows the current Radar volume (iRaceDeck's own setting), or **OFF** while the Radar is switched off

#### Setting: Action

- **Volume Up** (default) — Pressing the button raises the Radar volume by 5% (max 100%)
- **Volume Down** — Pressing the button lowers the Radar volume by 5% (min 0%)

---

## Key Styles — paired +/− buttons

Every volume key (Voice Chat, Master, Race Engineer Volume and Radar Volume, each with Volume Up or Volume Down) can render as one half of a **paired control**: place the up and the down key next to each other and the two read as one volume control with a + half and a − half. Choose the look under **Key Style**:

- **Legacy (arrows)** — the classic speaker icon with its two lines of text (default for existing keys).
- **Split** — label on top, the level in the middle, a big + or − below (default for newly placed keys).
- **Edge chevrons**, **Joined pill** — alternative pair looks that show the level. With **Joined pill** the two keys share one frame.
- **Big +/−**, **Big chevrons**, **Pill end** — the + or − alone, with a one-word label underneath.

**Race Engineer and Radar keys show their live level**, from 0 to 100 and without a unit, as the dial does. It updates wherever the level changes: the key, its partner, the dial, the Settings window sliders. While the Race Engineer or the Radar is switched off the key reads **OFF**; pressing still steps the level, and the number comes back when the feature is switched on.

**Voice Chat and Master keys have no level to show.** iRacing doesn't report its volume, so the [tick](#a-tick-on-every-step) each press plays is the only way to count steps, and on these keys the level styles are drawn without it: **Split** as **Big +/−**, **Edge chevrons** as **Big chevrons**, **Joined pill** as **Pill end**. The key keeps your choice, so moving it to Race Engineer or Radar shows the level again. Each key keeps a one-word label (**VOICE**, **MASTER**, **ENGINEER**, **RADAR**) so pairs side by side can be told apart; the label follows the normal title settings, so you can change or hide it under the title overrides.

**Hold to repeat.** In any style except Legacy, holding a key keeps stepping until you let go. On Voice Chat and Master every step is another press of the key binding. On Race Engineer and Radar every step is 5%. A Legacy key steps once per press.

**Edge chevrons**, **Joined pill**, **Pill end** and **Big chevrons** take a **Position in Pair** setting (*Auto* follows the direction: up on the right, down on the left; pick *Top* or *Bottom* for a vertical stack). Colors follow the normal color overrides (the +/− accent is the *Graphic 1* slot); pill styles turn the normal border off, because the pill is the frame. Push to Talk and the two mutes are single presses with no opposite key, so they keep their icons and offer no Key Style.

---

## A tick on every step

Every volume step plays one short tick, so you can count steps without looking at the deck: three presses of Volume Down, three ticks. Going up ticks at a higher pitch than going down, so a press on the wrong key is heard at once. Holding a key in a paired style ticks once for every step it repeats, and turning the dial ticks once per detent, spaced so a fast turn is heard as separate ticks rather than one smear.

- **Race Engineer and Radar** tick at the level you just set, so each step up sounds a little louder than the last. A press down at 0 or up at 100 changes nothing and makes no tick: twenty presses down from 100 tick twenty times and reach 0, and the next press down is silent. They tick while the Race Engineer or the Radar is switched off, too.
- **Voice Chat, Master and Spotter** tick at your **Radar** volume, the level every iRaceDeck sound follows, because iRacing does not report its own volumes. A tick means the key press was sent to iRacing: a key with no binding, or a press while iRacing isn't running, makes no tick. iRacing also does not report when its volume is already at the top or the bottom, so at its limit a press still ticks even though nothing changed.
- **Quiet levels stay audible.** Below 20 the tick plays at 20, so it can still be heard at the low end, and a Radar volume of 0 does not silence it.

There is no setting for the tick: it always plays, whatever the Race Engineer, Radar and callout switches say. Push to Talk, Mute / Unmute, Mute a Driver and Skip Spotter Call are not volume steps and make no tick, and neither do the volume sliders in the Settings window, which have their own **Test** buttons.

---

## On a dial

Placed on a Stream Deck+ dial or a Mirabox knob, Audio Controls becomes a volume dial: rotating adjusts the selected audio category, and the press is configurable as **Push to Talk** (Stream Deck+ only), **Mute / Unmute**, **Mute a Driver** (while the dial's Mode is Voice Chat), or **Skip Spotter Call** (while the dial's Mode is Spotter). The Property Inspector automatically shows the dial settings below (instead of the keypad Mode settings) when the instance sits on a dial.

Rotate the dial to adjust the volume of the category selected in the dial's **Mode** setting. For **Voice Chat**, **Master**, and **Spotter**, each detent taps the matching iRacing volume key binding — iRacing steps its volume a fixed amount per press, and it exposes no current volume state, so the touch strip shows the category name only (there is no level to display; this is an iRacing limitation, not a missing feature). Each detent that sends a key press plays a [tick](#a-tick-on-every-step) at your Radar volume, which is how you count steps on these modes; at iRacing's own limit a detent still ticks. The **Spotter** mode drives iRacing's AI spotter through the same *Spotter Louder* / *Spotter Quieter* / *Spotter Silence* key bindings as the [AI Spotter Controls](/docs/actions/audio-voice/ai-spotter-controls/) action — they are shared plugin-wide, so configure them once (in either action's Related Key Bindings section) and both actions use them; the spotter volume dial lives here, on the audio dial, rather than on a separate AI Spotter dial. For **Race Engineer** and **Radar**, each detent steps iRaceDeck's own level by 5% and ticks at the new level, with no tick once the level reaches 0 or 100 — and because these levels are iRaceDeck's, the touch strip shows a **live level bar** with the current value, updating immediately when the level changes anywhere (the dial itself, the keypad buttons, the Pit Crew sliders). When the Race Engineer or Radar feature is disabled, the bar dims and reads **OFF**.

While **Push to Talk** is held, the strip's top band turns red and reads **ON AIR** — transmit state is plugin-owned, so it can always be shown. If a key binding the dial needs is not configured, the strip dims and shows the standard warning triangle. It shows the same triangle when the dial's **Press Action** is one its **Mode** does not offer, such as Master with Mute a Driver, which an imported or hand-edited profile can carry; the dial's description in the Stream Deck app then lists no press, and opening the dial's settings switches the press to **None**.

#### Details

- **Method:** Key binding for Voice Chat / Master / Spotter rotation (both volume keys required), Push to Talk, Voice Chat Mute / Unmute, Voice Chat Mute a Driver, and Spotter Skip Spotter Call; iRaceDeck audio (no iRacing command) for Race Engineer / Radar rotation and their Mute / Unmute
- **Dial:** Rotation adjusts the selected category's volume, scaled by detents; press runs the configured Press Action
- **Default binding:** The shared Audio Controls bindings (`audioVoiceChatVolumeUp` / `Down`, `audioMasterVolumeUp` / `Down`, `audioControlsPushToTalk`, `audioVoiceChatMute`, `audioVoiceChatMuteDriver`) and the AI Spotter Controls bindings (`spotterLouder` / `spotterQuieter` / `spotterSilence` — no default keys, so assign them in iRacing's controls and here); none for Race Engineer / Radar
- **Telemetry-aware icon:** The touch strip shows the live Race Engineer / Radar level (iRaceDeck state, not telemetry); no level display is possible for the iRacing categories

#### Controls

- **Elgato Stream Deck+** — dial rotation, press, and the touchscreen level display.
- **Mirabox knob** — turn and push, with the same live readout drawn on the screen above the knob; the Push slot only (see [Dials](/docs/features/dials/#mirabox-knobs)). **Push to Talk** is not offered on a knob, because the knob never reports the release that would stop transmitting. The other press actions fire once, the moment you push the knob or tap its screen.

#### Setting: Mode

Which audio the rotation adjusts. Defaults to **Voice Chat**.

- **Voice Chat** (default) — Each detent taps the iRacing voice chat volume up / down binding
- **Master** — Each detent taps the iRacing master volume up / down binding
- **Spotter** — Each detent taps the iRacing spotter louder / quieter binding (clockwise = louder), shared with the AI Spotter Controls action's Spotter Louder / Spotter Quieter modes; iRacing exposes no spotter volume, so the touch strip shows the mode name only
- **Race Engineer** — Each detent steps iRaceDeck's Race Engineer voice level by 5% (live bar on the touch strip)
- **Radar** — Each detent steps iRaceDeck's Radar tick level by 5% (live bar on the touch strip)

#### Setting: Press Action

What a dial press does. Defaults to **None**.

- **Push to Talk** — Stream Deck+ only. Holds the push-to-talk binding while the dial is pressed; release to stop transmitting. The strip shows **ON AIR** while held. A Mirabox knob never reports the release, so it is not offered there, and a knob set up with it elsewhere does nothing when pushed and shows the warning triangle until you open its settings, which switch the press to **None**.
- **Mute / Unmute** — For **Voice Chat**, taps the voice chat mute binding. For **Race Engineer** / **Radar**, toggles the feature on or off — exactly like the Pit Crew toggle keys (the Race Engineer speaks its going-silent / resuming acknowledgment, and Pit Crew toggle buttons reflect the new state). Not available for **Master** — iRacing has no master-mute key binding — or for **Spotter**, which has no mute either (see Skip Spotter Call).
- **Mute a Driver** — Only offered while the dial's **Mode** is **Voice Chat**; iRacing has a per-driver mute for voice chat and for nothing else. Taps iRacing's *Mute a Driver* control, which silences whoever is transmitting at that moment and leaves the rest of the channel audible. iRacing reports no per-driver mute state, so — like voice chat mute — the strip can't show who is silenced. Switching the Mode away from Voice Chat with this selected switches the press back to **None**, rather than leaving a press with nothing to tap.
- **Skip Spotter Call** — Only offered while the dial's **Mode** is **Spotter**. Stops the spotter call that is playing right now; the spotter speaks again on its next call. It taps iRacing's *Spotter Silence* key binding — the same key as the [AI Spotter Controls](/docs/actions/audio-voice/ai-spotter-controls/#skip-spotter-call) action's Skip Spotter Call mode. iRacing has no control that mutes the spotter permanently, so there is no mute to offer here. A skipped call leaves no state behind, so the touch strip keeps showing the Spotter mode name.
- **None** (default) — The press does nothing.
