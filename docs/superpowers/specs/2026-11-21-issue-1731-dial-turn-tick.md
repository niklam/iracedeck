# Dial turn tick

> **Issue:** [#1731](https://github.com/niklam/iracedeck/issues/1731) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

- **The setting.** A new global boolean, `dialTurnTick`, default `false`, shown as a **Dial turn tick** checkbox on the Press Sounds card of the Settings window (General tab). It is its own key, not a new value of the `pressSound` dropdown.
- **The sound.** The #1455 volume tick, unchanged: `sfx/IRD-volume-up.wav` for a clockwise step and `sfx/IRD-volume-down.wav` for a counter-clockwise one, on `AudioChannel.Feedback`, at the Radar Volume level floored at `VOLUME_TICK_FLOOR` — the level the press sounds and the iRacing volume ticks already use.
- **What ticks.** One tick per step a dial surface actually sent or applied for a rotation, never one per detent the host reported. A rotation that sent nothing ticks nothing.
- **Where it hooks in.** One protected method on `DialSurfaceBase` (#1589), which every dial surface calls where its rotation dispatches a step. The method hands the step to a gate in deck-core's press-sound module, which checks the setting and the sim connection and plays through a delegate `plugin-runtime` injects beside the press-sound player. The gate, the level and the queue live once; the surfaces only report what they sent.
- **A fast turn.** Every tick goes through the volume tick's existing queue: the first at once, the rest 70 ms apart, at most five waiting, the oldest dropped. A spin is heard as a train that never trails the dial by more than five ticks.
- **The volume dials.** Audio Controls' dial never calls the method. Its rotation already ticks every volume step (#1455), whatever the setting says, so it ticks exactly once per step with the option on or off.
- **The connection.** Like a press sound, a turn ticks only while iRacing is connected, read at each step.
- **Hosts.** Stream Deck+ dials and Mirabox knobs, through the same shared surface code. Ulanzi declares no dials, so nothing changes there.

## The setting

**Key `dialTurnTick`, boolean, default `false`.** The issue asks for default off, and #269 set the same rule for press sounds: nothing new plays until the driver asks for it. The key name and its default are persisted values, so they go in `@iracedeck/app-constants`' `press-sound.ts` beside `PRESS_SOUND_KEY` (`DIAL_TURN_TICK_KEY = "dialTurnTick"`, `DEFAULT_DIAL_TURN_TICK = false`), pinned in `persisted-values.test.ts` like the press-sound key, and named once by the schema, the deck-core gate and the partial test.

**Schema shape: the standard string/boolean coercion with a catch**, as `showDisconnectedState` has it:

```typescript
dialTurnTick: z
  .union([z.boolean(), z.string()])
  .transform((val) => val === true || val === "true")
  .default(DEFAULT_DIAL_TURN_TICK)
  .catch(DEFAULT_DIAL_TURN_TICK),
```

A stored `"true"` reads as on, as for every boolean global; a missing key, a hand-edited value or anything else reads as off, and nothing about this field can abort the whole `GlobalSettingsSchema` parse (#896).

**What the contract costs.** It is a new key, so there is no migration and no marker: an install without it gets `false` from the schema. A user choice, so never run-scoped. Forward and backward: an older build reads the key as a passthrough key and keeps it through its writes (every write persists the whole cache, passthrough keys included), so a downgrade and an upgrade back keep the driver's choice. The snapshot writes it whole, like every ordinary key, which is fine: it is a plain boolean.

## A checkbox beside the dropdown, not a fifth mode

The Press sound dropdown is not extended (`none`, `taps`, `long-press`, `both` plus tick variants). Three reasons:

- **The two are independent.** A driver may want a tick per dial step and no bleeps on presses (the VR brake-bias case the issue describes), or the bleeps without the ticks. Folding them in means four new values, every combination of two choices spelled out as a list of eight, where two controls say it plainly.
- **The values are persisted.** `PRESS_SOUND_MODES` never changes once shipped, and a value an older build does not know is caught to `none`. A combined value such as `both-and-tick` would therefore turn the bleeps off entirely after a downgrade, losing a choice the driver made about something else. A separate key degrades to "the older build has no tick", which is exactly what that build can do.
- **A turn is not a press.** The dropdown's values describe press outcomes (a tap, a long press). A dial step has no press shape; it belongs on the same card because it is the same kind of feedback, played the same way, not because it is a press.

## The Press Sounds card

`packages/pi-components/partials/global-common-press-sounds.ejs` gains one item after the Preview row:

```html
<sdpi-item label="Dial turn tick">
  <sdpi-checkbox setting="dialTurnTick" label="Tick on every dial step" global></sdpi-checkbox>
</sdpi-item>
<div class="ird-supporting-text">
  Each step a Stream Deck+ dial or Mirabox knob sends to iRacing plays a short tick, so you can count steps
  without looking. Audio Controls' volume dial already ticks every step. Ticks play only while iRacing is connected.
</div>
```

The checkbox carries no `default` attribute, because `default="false"` renders checked (the truthy-attribute trap #1599's partial names). The final wording of the label and the supporting text is the documenter's, approved with the website text; the key, the missing `default` and the place on the card are the decision. `press-sounds-partial.test.ts` pins the key and the absent attribute. It is shown on all three plugins' settings windows; on Ulanzi, which has no dials today, it does nothing, and the supporting text names the devices it applies to. A per-plugin flag to hide it is not worth a new build-time flag for one checkbox.

No Test button: the dropdown has two because a press sound plays only while iRacing is connected and the driver must choose between them blind. The tick is one sound, the one every Audio Controls volume step already plays, and turning any dial with iRacing running is its preview.

## What counts as a step

**A step is one unit the rotation actually moved in iRacing, counted by the surface that moved it.** The host's `ticks` say how far the hand turned; what reaches iRacing differs per surface, and the tick must report what reached it, as #1455's did ("a tick for a key that reached no simulator would be a false confirmation"). So:

| How the surface acts | One tick per | Silent when |
| --- | --- | --- |
| Key-binding taps (Force Feedback, View Adjustment, Cockpit Misc, Splits & Reference, Camera Editor Adjustments, Black Box Selector, the setup surfaces) | tap for which `tapBinding` returned true, inside the existing loop capped at `MAX_TAPS_PER_EVENT` | the binding is unset, the send failed, the rotation maps to no key |
| One command per rotate event (Camera Controls, which re-targets from telemetry and so steps once per event, #884) | command issued, so one per event whatever `ticks` says | nothing was issued |
| A value the dial applies (Fuel Service's fuel amount and autofuel margin) | step the value actually moved after the clamp (the change divided by the step size) | the value is at its limit, the readout is frozen (`autofuel-off`) |
| Replay commands (Replay Control, Replay Markers) | step the mode issued through the replay command gate (a marker walked, a speed rung, a frame or car stepped) | no replay on screen, no marker that way, a refused command |

The table describes today's surfaces; the rule is the first sentence, and a surface added later applies it to whatever it dispatches. Each surface's own test file proves its count.

**A push+turn that fires a paired gesture is not a step.** Fuel Service's push+turn fills to full or to empty: a one-shot gesture, the press sound's domain, whose release #269 already keeps silent. A pressed rotation that still adjusts the same value as a bare turn (Force Feedback, the setup surfaces) is a step and ticks. On Mirabox `pressed` is never `true`, so the distinction never arises there.

**Direction is the hand's, not the value's.** Clockwise plays the up tick and counter-clockwise the down tick on every surface, so the mapping the driver hears on the volume dial (clockwise is louder, up) carries to every dial. A number-primary dial (rule 4 of `encoders-and-touchscreen.md`, where clockwise lowers a position or car number) still ticks up clockwise: the tick confirms the turn, and the value is on the display and in the sim. Tying the pitch to the value would make every list dial, which has no up, choose one arbitrarily, and would make the same clockwise turn sound different on two dials side by side.

## Where it hooks in

```typescript
// shared/dial-surface-base.ts, on DialSurfaceBase
protected tickTurnSteps(clockwise: boolean, steps = 1): void;

// deck-core press-sounds.ts
export type DialTurnTickPlayer = (clockwise: boolean, steps: number) => void;
export function playDialTurnTicks(clockwise: boolean, steps: number): void;
// PressSoundsDeps gains `tick: DialTurnTickPlayer`

// iracing-actions audio/volume-tick.ts, installed as `tick` by plugin-runtime's registerActions
export function playDialTurnTicks(clockwise: boolean, steps: number): void; // playVolumeTicks(clockwise ? "up" : "down", steps, readRadarVolume())
```

**The base method is the one place a surface reaches.** A surface calls `this.tickTurnSteps(...)` where it knows a step went out: after each `tapBinding` that returned true, or once with the count after a value step is applied. The method is synchronous, returns at once and never throws, so it can sit inside a loop of awaited taps without delaying the next one; the tick for the first tap plays before the second tap is sent, as on the volume dial.

**The gate lives in deck-core, beside the press-sound gate.** `shared/dial-*` modules may import deck-core and each other only (`dial-sim-agnostic.test.ts`), so the base cannot import the audio code in `iracing-actions/src/audio/`. deck-core's press-sound module already holds the same shape: it reads a setting from `@iracedeck/settings` and the connection from `getSimConnection()`, and plays through a delegate `plugin-runtime` installs at startup, staying audio-free and sim-neutral. `playDialTurnTicks` there plays nothing when no delegate is installed, when `getGlobalSettings().dialTurnTick` is off, when the sim is not connected, or when `steps` is not a positive finite number (it is floored); every read and the delegate call are guarded and degrade to silence, as `readGate` and `safePlay` do for a press. `initPressSounds` keeps its single call: `registerActions` passes `{ play: playPressSound, tick: playDialTurnTicks, logger }`, so all three plugins get it from the line that already wires the press sounds.

**The audio side adds one function and no policy.** `iracing-actions`' `playDialTurnTicks` maps the direction to the clip pair and enqueues on the volume tick's queue at the Radar Volume level, the same call `tickIRacingVolumeStep` makes minus its connection check, which deck-core's gate has already made.

**Every surface but Audio Controls calls it, and a guard says so.** `actions/dial-surface-base-coverage.test.ts` already counts the surfaces against the manifest's `Encoder` actions and reads their source. It gains one check: each surface's source calls `this.tickTurnSteps(`, except those named in a `NO_TURN_TICK` map with their reason, whose one entry is `audio-controls/audio-dial-surface.ts` ("its rotation is volume and ticks every step itself, #1455"), and that entry must NOT call it. A 19th dial that forgets the call, or an Audio Controls change that adds one, fails the suite. Whether each call counts the right steps is the surface's own test, as its count is its own.

**Why not the deck-core wrapper's `onDialRotate`.** `withPressSounds` already wraps every handler's rotate, so ticking `|ticks|` there would cover every dial with no surface edit. It is rejected because the wrapper runs before the handler and cannot know what was sent: it would tick three times for Camera Controls' one step, tick for an unset binding, for a fuel value pinned at its limit, for a marker list that has no next marker, and on Mirabox would tick a push+turn that dispatched nothing. Each of those is a false confirmation, which is the one thing a confirmation sound must not give. It would also need Audio Controls to declare an exemption to the wrapper, a member added to `IDeckActionHandler` for one action.

**Why not a template `rotate` on the base** (the base's `rotate` gates, calls an abstract `turn` returning the steps taken, then ticks). The compiler would then force every surface to report a count, but the ticks would play only after the last awaited tap of the event, up to five sends late, and every surface's `rotate` signature, its late-input gate and the coverage guard's prelude rules would move in the same change. The protected method plus the source guard gets the same coverage without the latency or the churn.

## The sound, the level and a fast turn

**The same tick, the same level.** The issue asks for "the same tick the volume dials use" at "the Press Sounds level". Both already exist: the #1455 clip pair, and `volumeTickLevel(readRadarVolume())`, the Radar Volume floored at 20, which `playPressSound` and `tickIRacingVolumeStep` both use. So a driver has one slider (Radar) for every iRaceDeck tone, and a Radar Volume of 0 does not silence the tick; turning the checkbox off does.

**One queue, shared.** Every tick, volume or turn, goes through the one queue in `volume-tick.ts`: the first plays at once unless another started under `VOLUME_TICK_SPACING_MS` (70 ms) ago, the rest wait in order, and a backlog beyond `VOLUME_TICK_MAX_QUEUED` (5) drops its oldest. Sharing is required, not just convenient: both play on `AudioChannel.Feedback`, where a play replaces what is playing, so two independent queues would cut each other's ticks mid-sound.

**What "does not pile up" means here.** A rotate event carrying N steps plays N ticks, one per step, because one tick per event would undercount exactly the fast turn (a Mirabox knob measured ±2 and +3 per event 110–200 ms apart; a Stream Deck+ dial coalesces the same way). Above about 14 steps a second the queue is full and the oldest waiting ticks are dropped, so the train always ends within six ticks' spacing (about 0.4 s) of the last step, carrying the latest direction. Nobody counts steps at that speed; at any speed a driver can count, every step is heard. A press sound still replaces a tick it meets on the channel without queuing, as #269 decided.

## When it stays silent

- The checkbox is off (the default).
- iRacing is not connected, read at each step. A dial step with iRacing closed reaches nothing, the reason #269 and #1455 both gave.
- The rotation sent or applied nothing (the table above), including a zero-tick event and a late event after `willDisappear`, which the base's input gate drops before the surface acts.
- A push+turn that fires a paired gesture.
- Every press, touch and release: those are the press sounds' (`pressSound`), unchanged. The two settings never gate each other.

## The volume dials

Audio Controls' dial is the only one exempted, and it is exempted by never calling the method rather than by a check at play time. Its rotation in every mode is a volume step (Race Engineer and Radar through the step helpers in `audio-volume.ts`, Voice Chat, Master and Spotter through `tickIRacingVolumeStep` after each sent tap), and #1455 made those ticks unconditional: no setting turns them on or off. So with `dialTurnTick` off or on it plays one tick per step, never two, and the website keeps calling its tick the volume tick. AI Spotter Controls, the other #1455 caller, is a keypad action with no dial and is untouched.

## Hosts

- **Stream Deck+.** Every dial surface, bare turns and pressed turns that adjust.
- **Mirabox.** The same surface code: a knob sends `dialRotate` with `ticks` ±1 per detent and several detents in one event on a fast spin, which is exactly the case the per-step count and the queue cover. `pressed` is never true, so no push+turn question arises.
- **Ulanzi.** No dial actions are declared (`["Keypad"]`), so nothing ticks. When Ulanzi dials are enabled they inherit the method with their surfaces.

## Alternatives rejected

- **Folding it into the Press sound dropdown.** Above: two independent choices, and a combined persisted value an older build would catch to `none`.
- **A per-dial setting.** The issue rejects it: a setting on every dial for something drivers want everywhere or nowhere.
- **One tick per rotate event.** Undercounts every fast turn, the #1455 rejection.
- **A pitch or length scaled to the detent count.** A sound to decode rather than a count, the #1455 rejection.
- **A third, direction-neutral clip.** The issue asks for the volume dials' tick, and the direction cue catches a dial turned the wrong way on its first step.
- **Pitch from the value's direction rather than the hand's.** Above: list dials have no up, and two dials side by side would answer the same turn differently.
- **A separate queue for turn ticks.** Two queues on one channel replace each other's ticks.
- **Ticking in deck-core's `withPressSounds` wrapper, or through a template `rotate` on the base.** Above, under Where it hooks in.

## Out of scope

- Changing the #1455 volume tick: its clips, floor, spacing, queue length or its always-on rule.
- Ticks for key presses, holds, the touch strip or dial presses; those are the press sounds.
- A tick for a push+turn paired gesture.
- A separate volume, a separate clip set or a per-action or per-dial switch for the tick.
- A "limit reached" sound when a value stops at its end (the silence already says it).
- A Test button on the card.
- A per-plugin flag to hide the checkbox on Ulanzi, and enabling Ulanzi dials.
- Dial actions that are not dial surfaces today (`onDialRotate` on actions the manifests declare keypad-only).

## Testing

Suite:

- **Schema and constants.** `dialTurnTick` defaults to `false`; `true` and `"true"` read as on; `false`, `"false"`, `null`, a number and an unknown string read as off without failing the parse; `DIAL_TURN_TICK_KEY` and `DEFAULT_DIAL_TURN_TICK` are pinned in `persisted-values.test.ts`.
- **Partial.** The Press Sounds partial renders a global `sdpi-checkbox` bound to `dialTurnTick` with no `default` attribute, beside the existing select and Test buttons.
- **deck-core gate.** `playDialTurnTicks` calls the installed delegate with the direction and the step count when the setting is on and the sim connected; plays nothing with the setting off, while disconnected, with no delegate installed, or with zero, negative or non-finite steps; a throwing settings read, connection read or delegate never escapes.
- **Base method.** `tickTurnSteps` forwards to the gate with the direction and count, synchronously.
- **Coverage guard.** Every dial surface calls `this.tickTurnSteps(` except the `NO_TURN_TICK` entries; Audio Controls' surface does not call it; a planted surface without the call fails the check (a positive control, so the guard is seen to fail).
- **Each surface.** A rotation that sends N steps ticks N times in the turn's direction (clockwise up, counter-clockwise down); an unset binding, a `tapBinding` that returned false, a value at its limit, Fuel Service's `autofuel-off`, a replay command that was not issued, and a zero-tick event tick nothing; Camera Controls ticks once for a three-detent event; Fuel Service's push+turn gesture ticks nothing; a pressed rotation that adjusts ticks like a bare one.
- **Volume dials.** Audio Controls' dial, with the setting on, ticks exactly once per volume step in each mode (the #1455 tests, run again with `dialTurnTick: true`), and with it off still ticks once per step.
- **A fast turn.** A burst of rotate events whose steps arrive faster than the spacing never leaves more than `VOLUME_TICK_MAX_QUEUED` ticks waiting, keeps their order across a reversal, and has played or dropped every tick within six spacings of the last step (fake timers).
- **Wiring.** `registerActions` installs both delegates in its one `initPressSounds` call.

By hand, on the Stream Deck+ and the Mirabox knob, with iRacing connected:

- With the checkbox off, no dial but Audio Controls ticks; with it on, Force Feedback, Brake Bias (Setup Brakes), Traction Control, Fuel Service and Camera Controls tick once per step, higher clockwise and lower counter-clockwise, at the Radar level, staying audible with Radar at 0.
- Five slow detents on Force Feedback move iRacing's FFB strength by five steps and play five ticks; a fast spin plays a clean train of separate ticks that stops promptly when the dial stops, with no long tail.
- Turning Fuel Service past its limit stops the ticks at the limit; an action whose rotation binding is unset makes no tick.
- Audio Controls' dial ticks once per step with the checkbox on and off.
- With iRacing closed, no dial ticks with the checkbox on.
- With Press sound on Both and the checkbox on, presses bleep and turns tick, and neither setting changes the other.
