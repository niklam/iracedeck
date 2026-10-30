# Press sounds

> **Issue:** [#269](https://github.com/niklam/iracedeck/issues/269) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

One global setting, **Press sound**, plays a dry click when a press acts as a tap and a two-note bleep when a hold passes the long-press threshold. Both are deck feedback, not Race Engineer callouts.

- **The setting.** `pressSound`, one of `none` (default), `taps`, `long-press`, `both`, in `GlobalSettingsSchema`. It lives on the settings window's General tab in a new **Press Sounds** card beside Dual-Press. No per-action override in this issue (below).
- **Where it is decided.** One wrapper around every registered action handler, applied once in `plugin-runtime`'s `registerActions`, owns the timing and plays the sounds. An action says only what shape its press has (`keyPressShape`, `dialPressShape`, `touchPressShape`), synchronously, at the down event; an action that says nothing gets a click on key down. No action plays a sound itself.
- **When the click plays.** At the moment the tap's outcome is decided: on key down for a key that acts on down, and on release, once the release is known to be short, for a key or dial whose long press does something else. A long press never clicks.
- **When the bleep plays.** Once, at the long-press threshold, on a press whose long outcome does something: dual-press keys, the Car Control hold controls, and Stream Deck+ dials whose long-press gesture is not `none`. It is armed with the same threshold the action classifies with, so on a dial with a hold preview (#1120) it lands on the same tick the preview draws.
- **The sounds.** Two new clips, `packages/audio-assets/sfx/IRD-press-tap.wav` (a 12 ms unpitched click) and `IRD-press-long.wav` (two equal 2.8 kHz notes, 110 ms), specified below so candidates can be rendered and picked by ear.
- **Channel and level.** `AudioChannel.Feedback`, the bus-less channel #1455 added for the volume step tick, played at the Radar Volume level with the tick's floor. A volume step plays #1455's tick in place of the click, as that spec anticipated.
- **Only while the sim is connected**, and a non-`none` setting becomes a third gate of the #1347 session hold, so a press in a session never waits for a device start.

## The setting

`pressSound: z.enum(PRESS_SOUND_MODES).default(DEFAULT_PRESS_SOUND_MODE).catch(DEFAULT_PRESS_SOUND_MODE)`, placed with the dual-press fields (`packages/settings/src/global-settings.ts:490-500`) and following the `changelogNotification` shape exactly (`global-settings.ts:572-575`): an enum whose values and default live in `@iracedeck/app-constants`, here a new `press-sound.ts` exporting `PRESS_SOUND_KEY = "pressSound"`, `PRESS_SOUND_MODES = ["none", "taps", "long-press", "both"] as const`, the `PressSoundMode` type and `DEFAULT_PRESS_SOUND_MODE = "none"`. The `.catch` is the #896 rule: a hand-edited or future value must fall back to `none` rather than abort the whole parse. All four literals and the key go into `app-constants`' `persisted-values.test.ts`, which pins every persisted value by literal, because a stored setting is a contract.

- **One enum, not two booleans.** The issue names four values, and one select says exactly what the driver gets. Two checkboxes would be equally additive under `passthrough()`, but the select reads as one decision in the window and needs no "neither" wording for the default.
- **The stored value for the default is `none`, labelled "No sound".** Labels are the partial's; values never change once shipped.
- **A user choice, so never run-scoped**, and changing the default later reaches new installs only (`global-settings.md`).
- **A downgrade to a version without the key keeps it** (passthrough), and a downgrade to a future version's unknown value lands on `none` through the `.catch`, the same accepted cost as `changelogNotification`.

**Where it appears.** Settings window only, per rule 1 of `settings-window.md`: a new items-only partial `pi-components/partials/global-common-press-sounds.ejs`, included as an accordion card titled **Press Sounds** on the General tab directly after the Dual-Press card (`iracing-actions/src/actions/settings-window/settings-window.ejs:368`). The card holds the `sdpi-select` bound to `pressSound` with the `global` attribute, a supporting line saying the bleep fires at the long-press threshold set in Dual-Press and that sounds play only while iRacing is connected, and two `ird-audio-test` buttons, `preview="press-tap"` and `preview="press-long"`, so the driver can hear both before choosing. `runAudioPreview` (`iracing-actions/src/audio/audio-previews.ts:32`) gains the two kinds and its allow-list with them; a preview plays the sound at the level a press would use, whatever the setting and the connection, like the other Test buttons, so the driver can hear both before choosing. The Dual-Press card's supporting text (`global-common-dual-press.ejs:7-10`) still says the threshold applies to setup View sub-modes only; it is reworded to say it is the long-press threshold for every long press, including the dials and the bleep. No action PI changes.

## Where a press is classified today

There is no single place. Four mechanisms decide a long press, each owned by the code that acts on it:

- **Keypad dual-press (#540).** `DualPressTracker` stamps the key down and resolves tap or long at key up by duration against `getDualPressThresholdMs()` (`packages/deck-core/src/dual-press.ts:29-42`, `:90-99`). No timer: nothing is known mid-hold. Users: the seven setup actions in their View sub-modes with dual-press on (for example `setup-aero.ts:297-306`), and Car Control's Wipers and Visor on a wiper car (`car-control.ts:1425-1429`, resolved at `:1450`).
- **Car Control hold controls.** `HOLD_CONTROLS` (`car-control.ts:157-163`: Starter, Headlight Flash, Enter/Exit/Tow, Handbrake, Second Clutch) press the binding on down and release on up (`:1168-1176`); there is no threshold at all, the hold is the action.
- **Dials (#681, #696).** Every dial surface classifies at `dialUp` through `classifyDialReleaseForHost` (`iracing-actions/src/shared/dial-release.ts:21-30`) over deck-core's `classifyDialRelease` (`dial-gesture.ts:70-81`): push+turn first, then long versus short against the threshold, which every surface passes as `getDualPressThresholdMs()` (`setup-aero-dial-surface.ts:234-244` is typical). Where `__FEATURE_DIAL_EXTENDED_GESTURES__` is off (Mirabox, Ulanzi) a release is never long. Touch is separate: `touchTap(hold)` picks `tapAction` or `longTouchAction` (`setup-aero-dial-surface.ts:251-262`), Elgato only. Car Control's dial acts on `dialDown` like its key (`car-control.ts:1062-1066` and its dial twin), and Audio Controls' dial mutes at `dialDown` by a documented choice (#1120 spec, decision 2).
- **The hold preview (#1120).** `createHoldPreview` (`dial-gesture.ts:124-190`) is the one mid-hold timer, and it only draws. It is on five surfaces, the ones with a knowable outcome; the other dials with a long gesture deliberately show nothing.

## The seam: one wrapper, declared press shapes

**Decision: a deck-core module, `press-sounds.ts`, exporting `withPressSounds(handler)`, `initPressSounds(deps)` and the `PressShape` type. `plugin-runtime`'s `registerActions` wraps every handler it registers, the shared list and the host's extras alike (`phases/register-actions.ts:46-48`), so all three plugins get it from one line.** deck-core stays sim-neutral and audio-free: it reads the mode from `@iracedeck/settings` and the connection from `getSimConnection()`, and plays through an injected `play(sound)` delegate, the same injection shape as the window focuser and the keyboard.

`IDeckActionHandler` (`deck-core/src/types.ts:136-146`) gains three optional, synchronous members, one per surface: `keyPressShape?(ev: IDeckKeyDownEvent)`, `dialPressShape?(ev: IDeckDialDownEvent)` and `touchPressShape?(ev: IDeckTouchTapEvent)`. The wrapper calls the one for the path the event arrived on. One member taking any event would lose the surface, since `IDeckKeyDownEvent` and `IDeckDialDownEvent` are the same type alias, and an action re-deriving it with `ev.action.isDial()` is wrong on Ulanzi, whose adapter reports every context as a key (#1530); the wrapper already knows the path (amended 2026-10-30 from the architect review). Each returns one of:

| Shape | Meaning | Click | Bleep |
| --- | --- | --- | --- |
| `{ kind: "tap" }` | acts now, no long press | now | never |
| `{ kind: "hold", thresholdMs }` | acts now and keeps acting while held | now | at `thresholdMs` |
| `{ kind: "release", thresholdMs, short, long }` | decided at release | at a short release, if `short` | at `thresholdMs`, if `long` |
| `{ kind: "long" }` | this event is a completed long press (a long touch) | never | now |
| `{ kind: "none" }` | this press makes no sound | never | never |

`short` and `long` say whether that outcome does anything: a gesture set to `none` makes no sound, because a click for a press that did nothing is a false confirmation. A handler without the member for the path gets that path's default: `tap` on a key, `release` with a 500 ms threshold, `short` true and `long` false on a dial, and `tap` on a touch; every dial-capable action declares `dialPressShape` anyway (Testing). A shape member that throws is `none`, logged at debug: a missing sound is better than a wrong one.

**What the wrapper does, per context id.** At down it reads the mode and the connection once; with the mode `none` or the sim disconnected it records nothing and costs nothing. Otherwise it asks for the shape, calls the handler's own `onKeyDown` / `onDialDown`, and plays the down sound right after the handler's synchronous part returns, before awaiting its promise, so the sound never delays the press and the press's awaits never delay the sound. A `hold` or a `release` with a long outcome arms one timer at `thresholdMs`. A pressed `onDialRotate` disarms it and marks the press push+turn, which plays nothing at release. At up it classifies a `release` press with the same duration comparison `classifyDialRelease` makes and clicks if it was short and `short` is set, then forgets the press. `onWillDisappear` and `onDidReceiveSettings` forget the press and disarm, as the hold preview's `dispose` does; a second down on the same context replaces a press whose up was lost. The timer callback catches everything, for the reason `createHoldPreview` gives at `dial-gesture.ts:165-170`: a throw there ends the plugin. Every other handler member is forwarded unchanged, and the wrapper object is typed against the whole interface so a member added later cannot be dropped silently.

**The threshold comes from the action.** The shape carries the exact expression the action classifies with: `getDualPressThresholdMs()` for every dual-press key and every dial today, read once at down as the hold preview already does. If an action's threshold ever diverges, its bleep follows its own classification and not a global guess.

**Why the click waits for release on a long-press key.** The issue defines Taps as a click "when a press acts as a tap". On a dual-press key or a dial the tap's action fires at release (`dual-press.ts:90-99`, `dial-release.ts`), so the click lands with the action, and a long press, which is not a tap, never clicks. The cost is that the click on those keys comes at release, a few hundred milliseconds after the finger went down, which is exactly when the key acts. Clicking on every key down was rejected: in Taps mode a long press would click like a tap and tell the driver nothing, and on a dial the click would precede a push+turn that fires nothing.

**The bleep is a promise about release.** It means "letting go now does the long-press action", so it plays only where that is true: once, at the threshold, never repeated during a longer hold. Keys whose hold changes nothing get none, which includes every hold-to-repeat key (`RepeatController`: setup +/− keys, the volume keys): releasing a repeating key just stops it, and its steps are their own feedback.

**The one accepted disagreement.** The wrapper and the action each take their own `Date.now()` at down and at up, in the same synchronous run. A release landing within the same millisecond as the threshold boundary can in principle be classified differently by the two, giving a click on a long press or silence on a tap. The window is a fraction of a millisecond per press and the worst outcome is one wrong click; making the action report its verdict instead would put sound plumbing into every classifier, which is what this design avoids. Likewise a release after the threshold but before a busy event loop ran the timer gets neither sound, never a late bleep after the finger is up.

### Who declares what

| Action | Surface | Shape |
| --- | --- | --- |
| Every action not listed | key | `tap` (no code) |
| The seven setup actions | key, View sub-mode, dual-press on | `release`, `short` and `long` true |
| The seven setup actions | key, View sub-mode, dual-press off | `none` (the key is read-only and ignores the press, `setup-aero.ts:300-306`) |
| Car Control | key and dial, Starter, Headlight Flash, Handbrake, Second Clutch, Enter/Exit/Tow and Escape without auto-hold | `hold` at the dual-press threshold |
| Car Control | Enter/Exit/Tow and Escape with auto-hold | `tap` (the timer, not the finger, ends the hold) |
| Setup Hybrid (Boost, Regen); Splits & Reference (Active Reset Run) | key | `hold` at the dual-press threshold (press on down, release on up, like Car Control's hold controls) |
| Look Direction | key and dial | `tap`: a look is held on most glances and releasing only ends it, so a bleep would sound on nearly every press |
| Car Control | Wipers and Visor | `release` on a wiper car, `tap` on a visor car, `none` on a car with neither |
| Audio Controls | Push to Talk, key and dial | `none`: a click as the microphone opens is the sound most likely to be transmitted (#1455) |
| Audio Controls, AI Spotter Controls, the Pit Crew key's Radar Volume mode | every volume step | `none`: #1455's tick is the press sound |
| Every dial surface that classifies at release | dial | `release` from the surface's resolved press and long-press gestures |
| Every dial surface | touch | `tap` for a tap, `long` for a long touch, `none` for a gesture set to `none` |
| Car Control, Audio Controls | dial press | as the key: they act on `dialDown` |

Dial surfaces build their shape through one helper beside `classifyDialReleaseForHost` in `shared/dial-release.ts`, `dialGestureShape({ pressGesture, longPressGesture, thresholdMs })` (with `touchGestureShape` beside it for touches; named apart from the interface members), which sets `long` false and the threshold to `Infinity` where `__FEATURE_DIAL_EXTENDED_GESTURES__` is off, so the host's release rule stays decided in one place and the wrapper can never classify a Mirabox release as long.

## The sounds

Both are mono, 48 kHz, 16-bit PCM WAV with no metadata chunks, at the `sfx/` root beside the speeding and volume ticks. WAV, not MP3, for #1455's reason: an MP3 frame's encoder delay is as long as the click. `sfx/` is copied into the plugins unchanged (`audio-assets` `CLAUDE.md`) and the manifest generator walks `.mp3` only, so nothing else ships them.

**`IRD-press-tap.wav`, the click.** 12 ms (576 samples). White noise from a fixed-seed PRNG (mulberry32, seed 269, so a candidate can be re-rendered), through one RBJ band-pass biquad centred at 3.5 kHz with Q 1.0. Envelope: 0.3 ms linear attack, exponential decay with τ = 2 ms, multiplied by a 2 ms raised-cosine fade reaching exactly zero at the last sample. Peak normalised to −10 dBFS. Unpitched on purpose: every other cue the plugin plays is a tone, so the click is told apart by timbre rather than by a pitch the driver has to remember.

**`IRD-press-long.wav`, the bleep.** 110 ms (5280 samples): note, gap, note. Each note is 40 ms of a 2794 Hz sine (F7) plus its third harmonic at −20 dB, with a 4 ms raised-cosine attack and a 6 ms raised-cosine release; the gap is 30 ms of digital silence. Peak normalised to −14 dBFS, lower than the click because a sustained tone in the 2–4 kHz band reads louder than a transient at the same peak. "Higher two-note" is read as two notes at one pitch, higher than every existing cue: a rising pair is #1161's "limit off, go" and a falling pair #1272's "limiter on", and #1455 kept its tick to one note for the same reason. 2.8 kHz sits where hearing is most sensitive, so it cuts through engine noise at a low level, and 110 ms is short enough to land inside a Race Engineer or spotter sentence without taking a syllable.

**Distinct from what already plays.**

| Cue | What it is | How the press sounds differ |
| --- | --- | --- |
| `IRD-tick-open` / `-close` | radio framing, about 290 ms, near full scale | the click is 12 ms and 10 dB down; the bleep is tonal |
| `IRD-pit-speed-warning.wav` (#912) | one 160 ms tone near 2.1 kHz, repeating every 300 ms | the bleep is higher, shorter, and a double that never repeats |
| `IRD-volume-up` / `-down.wav` (#1455) | 34 ms tones near 1.56 and 1.03 kHz | the click is unpitched and a third of the length |
| `sfx/radar/` | directional proximity tones | neither is panned |
| #1161 exit chirp, #1272 limiter beep (specified, not built) | rising and falling two-note | the bleep's two notes are equal |

**How they are produced.** As #912 and #1455 did: the plan renders a small candidate set with a throwaway script (the click's centre at 2.5, 3.5 and 5 kHz × τ 1.5 and 2.5 ms; the bleep at 2.35, 2.79 and 3.14 kHz), Niklas picks by ear, and the two picked files are committed with their gain baked in. `scripts/compare-loudness.mjs` checks the pick against the volume tick so all deck feedback sits at one loudness. The clip constants (`PRESS_SOUND_CLIPS` in `iracing-actions/src/audio/press-sounds.ts`) carry the provenance note #912 put on its constant: generated for this feature, so no third-party licence and no `THIRD-PARTY-LICENSES.md` entry. Rejected: committing the generator. Nothing regenerates a picked tone, and a script that has to stay green to reproduce a choice made by ear is upkeep with no reader.

## Channel and volume

**Decision: `AudioChannel.Feedback` (index 4, `audio-service/src/audio-service.ts:53-60`), through `playOnChannelAtLevel` (`:311`), at `volumeTickLevel(readRadarVolume())` (`iracing-actions/src/audio/volume-tick.ts:70`, floor `VOLUME_TICK_FLOOR` = 20 at `:47`).** The player lives in `iracing-actions/src/audio/press-sounds.ts`, beside the tick it shares a channel and a level rule with, and is the `play` delegate `registerActions` hands `initPressSounds`.

- **Feedback, not a bus channel.** The reasons #1455 gave for the tick hold unchanged: Radar is cut by a radar tick every 180–250 ms with a car alongside, Voice would cut the engineer mid-word, SFX and Ambient sit on the Background slider people turn down for the pit bed. The planned `Cue` channel is the pit-lane tones', and a press near the pit exit line must not cut the exit chirp.
- **Sharing Feedback with the tick.** `playOnChannel` replaces what a channel plays, so a click and a tick would cut each other. They cannot meet on one press, because every volume step declares `none`; they meet only when one key is pressed while another surface's tick train runs, where losing one 12 ms click is acceptable. Rejected: routing the press sounds through the tick's spacing queue, which would delay a click by up to 70 ms behind a spin on another dial.
- **Radar Volume with the floor, no new slider.** #1455 made Radar Volume the one slider for every code-owned tone, and a driver who wants iRaceDeck's tones quieter has one place for it. The floor keeps the click audible at a low radar level; a driver who wants no click turns the setting off, which the tick could not offer. A slider of its own is a Niklas decision below.
- **No native or service change.** The channel, its end callback and the per-play level all exist since #1455.

## The device and the sim connection

**Sounds play only while `getSimConnection().isConnected()`, read at down.** The driver's question is "did that reach the car", and with iRacing closed nothing did; #1455 ticks an iRacing step only while connected for the same reason. It also means a deck left on the desk never opens the audio device from a stray press.

**A non-`none` setting is a third gate of the #1347 session hold.** `AudioSessionHoldDeps` (`iracing-actions/src/audio/audio-session-hold.ts:63-66`) gains `isPressSoundEnabled`, read live like the other two, and the hold is taken while iRacing runs and the Race Engineer, the Radar or press sounds are on. Without it a driver with both master gates off would pay a device start on the first press after every five idle seconds (`IDLE_STOP_DELAY_MS`, `audio-service.ts:149`), so the click would arrive late on exactly the sporadic presses of a race. The hold costs nothing new for anyone who already runs the Race Engineer or Radar, and with press sounds `none` nothing changes.

## Hosts

- **Stream Deck.** Everything above: keys, Stream Deck+ dial presses with the bleep, and touch. A long touch bleeps when the host delivers the `touchTap` with `hold` set, which is also when its action fires; whether Elgato delivers it at the host's hold threshold or at lift is not established, and the manual test records which.
- **Mirabox.** Keys behave exactly as on Stream Deck: the adapter delivers both `keyDown` and `keyUp` (`deck-adapter-mirabox/src/adapter.ts:387`), so dual-press keys click at a short release and bleep at the threshold. A knob press completes at its `dialDown` with an immediate `onDialUp` (the adapter drops the host's), so it clicks at once and never bleeps; `dialGestureShape` makes that a property of the shape, not of luck in timing. No touch.
- **Ulanzi.** Keys only (the manifest declares no dials yet); `keyUp` arrives (`ulanzi-client.ts:208`), so keys match Stream Deck. When Ulanzi dials are verified they inherit the shape through the same helper, because the wrapper picks `dialPressShape` by the event path, not by `isDial()`, which reports every Ulanzi context as a key (#1530).
- **The focus listener runs first.** The Always-mode focus listeners are registered on the adapter before the actions (`register-actions.ts:35-37`) and fire before the handler, so a press that waits on the focuser waits the click with it. That is the existing cost of focus on every press, capped by `FOCUS_TIMEOUT_COOLDOWN_MS`, and not worth reordering for.

## Per-action override

**Not in this issue.** The original proposal's inherit / on / off override was there to silence keys that should not click; the two that clearly should not, Push to Talk and the volume steps, are handled by their shapes, so the remaining case is taste. Added later it is one `CommonSettings` field read by the wrapper, additive under every existing action schema, so deferring it closes nothing off. Niklas's call (below).

## Alternatives rejected

- **The adapter-level hooks** (`IDeckPlatformAdapter.onKeyDown` / `onDialDown`, `types.ts:180-185`, implemented as bare `() => void` at `deck-adapter-elgato/src/adapter.ts:567-569`). They carry no context and no event, have no key-up or dial-up twin, and changing that touches three adapters for a feature that needs none of them.
- **Instrumenting the shared primitives** (`DualPressTracker`, `createHoldPreview`). Only five dial surfaces have a hold preview, by #1120's knowability rule; the hold controls use no primitive; and a "claim" from inside the handler would only work if every caller made it before its first `await`, a rule nothing enforces at the call site.
- **The action reporting its verdict at release.** Exact at the boundary, but it puts a sound call into the seven setup actions, Car Control and every dial surface's release path, which is the per-action sound code the wrapper exists to avoid.
- **A click on every key down.** Rejected above: Taps mode could not tell a tap from a long press, and dials act at release.
- **A bleep on hold-to-repeat keys at the repeat onset.** Releasing a repeating key does nothing different, so the bleep would promise nothing.
- **A rising or falling two-note bleep.** Those shapes are spoken for by #1161 and #1272.
- **The `Cue` or `Radar` channel, or a sixth channel.** Covered under Channel and volume; a sixth channel would only separate the click from the tick, which never share a press.
- **Sounds whether or not iRacing runs.** A false confirmation for any press that sends to the sim, and a device opened from the desk.

## Out of scope

- A per-action override, user-selected sound files, and different sounds for toggling on and off (the original proposal's use cases beyond the four values).
- A sound for dial rotation, or for anything in the settings window or a Property Inspector.
- A volume slider of its own for press sounds.
- Any change to #1455's tick, its queue or its level rule.
- Aligning the hold controls' bleep with iRacing's own hold times (Enter/Exit/Tow's tow hold): the bleep marks iRaceDeck's long-press threshold, not the sim's.
- A key-image preview of a dual-press key's long outcome (#1120 decision 5's follow-up).

## Testing

Suite:

- `press-sounds.test.ts` (deck-core, fake timers, a recording `play`): `tap` clicks at down and never bleeps; `hold` clicks at down and bleeps once at the threshold, not before and not again; `release` clicks at a short release with `short` set, not with it unset, and never at a long release; it bleeps at the threshold only with `long` set; a pressed rotate disarms the bleep and silences the release; `long` bleeps at once; `none` plays nothing. Each mode: `taps` plays clicks only, `long-press` bleeps only, `both` both, `none` arms nothing and never calls a shape member. Each path calls its own member and falls back to its own default. Disconnected at down plays nothing; a connection or mode change mid-press does not change that press. `onWillDisappear` and `onDidReceiveSettings` mid-hold arm nothing further; a second down replaces a press whose up was lost; an up with no down plays nothing. A throwing shape member plays nothing; a throwing `play` inside the timer does not escape. The down sound plays after the handler's synchronous part and before its promise settles. Every `IDeckActionHandler` member is forwarded (a type-level check plus a call per member).
- A positive control for the boundary: a release exactly at the threshold is long for both the wrapper and `classifyDialRelease`.
- `dialGestureShape`: `long` false and the threshold `Infinity` with the extended gestures off; gestures set to `none` give `short` / `long` false.
- Per action: the shape for each row of the table above, including Wipers and Visor per car kind, Enter/Exit/Tow with and without auto-hold, setup View with dual-press off, and Push to Talk on key and dial.
- A structural test: every action whose Elgato manifest entry declares `Encoder` implements `dialPressShape`, and every action source that constructs a `DualPressTracker` implements `keyPressShape`. The first fails today for every dial action, which is its positive control.
- Settings: the `pressSound` default is `none`; an unknown or malformed value parses to `none` without dropping any other key; the literals are pinned in `persisted-values.test.ts`; the settings-window partial test pins the select's key, its four values and the two preview kinds, and `runAudioPreview` refuses any other kind.
- Player: plays the right clip on `AudioChannel.Feedback` at `volumeTickLevel(readRadarVolume())`, the floor included at Radar Volume 0.
- Session hold: with both master gates off, a non-`none` press sound takes the hold while iRacing runs and releases it when set to `none`.
- `start-plugin.test.ts`: `initPressSounds` appears once in `registerActions`, before the first `registerAction`.

By hand, on Stream Deck with a Stream Deck+, in iRacing:

- Each mode on a plain key, a setup View key with dual-press, the Starter, and a Fuel Service dial: Taps clicks on taps only, Long-press bleeps at the threshold only, Both does both, No sound is silent.
- On a dual-press key and a dial, a short press clicks at release and a long press bleeps at the moment the threshold passes and does not click; on Fuel Service the bleep and the preview land together; on a dial with no preview (Setup Aero) the bleep still plays.
- Push+turn on a dial: silent, also when the rotation comes after the bleep would have been due.
- A Mirabox key and knob: the key matches Stream Deck; the knob clicks on press and never bleeps.
- With iRacing closed: no sound. With the Race Engineer and Radar both off and press sounds on: the first press after a long idle in a session clicks on time.
- Push to Talk and every volume step: no click, the #1455 tick only.
- A long touch on the strip: note whether the bleep comes at the host's hold or at lift.
- Over a Race Engineer call, a spotter call and the pit-road speeding tick, both sounds are heard whole and the call stays intelligible; the picked clips read as distinct from every cue in the table.

Review row for the branch: `xhigh`, since it changes `GlobalSettingsSchema`; the wrapper is a per-press state machine, so the second read applies.

## Affected artifacts

- `@iracedeck/app-constants`: `press-sound.ts`, the barrel, `persisted-values.test.ts`.
- `@iracedeck/settings`: the `pressSound` field and its test.
- `@iracedeck/deck-core`: `press-sounds.ts` and test, `keyPressShape?` / `dialPressShape?` / `touchPressShape?` on `IDeckActionHandler` (`types.ts`), the barrel, `CLAUDE.md`.
- `@iracedeck/plugin-runtime`: `registerActions` (wrap and `initPressSounds`), the hold controller's third gate where it is wired, `start-plugin.test.ts`.
- `@iracedeck/iracing-actions`: `audio/press-sounds.ts` (player and clip constants), `audio/audio-previews.ts`, `audio/audio-session-hold.ts`, `shared/dial-release.ts` (`dialGestureShape`, `touchGestureShape`), the shape members on the setup actions, Car Control, Audio Controls, AI Spotter Controls, the Pit Crew key and every dial surface's action, `CLAUDE.md`.
- `@iracedeck/audio-assets`: the two WAVs.
- `@iracedeck/pi-components`: `global-common-press-sounds.ejs`, the Dual-Press wording, the preview kinds of `ird-audio-test`, the partial tests; `settings-window.ejs` includes the card.
- The three plugins: no manifest or shell change; they pick it up through `plugin-runtime`. The settings-window screenshot is stale (`pnpm capture:settings`).
- Website: a new `docs/features/press-sounds.md` and its sidebar entry, the Press Sounds card in `docs/getting-started/settings.md`, one sentence in `docs/features/dials.md`; changelog fragment `changelog.d/269-press-sounds.md` (`Features`).
- Rules: `stream-deck-actions.md` and `encoders-and-touchscreen.md` gain the rule that an action with a long press or a dial declares the shape member for each surface it has and plays no press sound itself; `audio-service`'s `CLAUDE.md` notes that Feedback carries the press sounds too.
