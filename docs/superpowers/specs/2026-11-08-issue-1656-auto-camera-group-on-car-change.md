> **Issue:** [#1656](https://github.com/niklam/iracedeck/issues/1656) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Camera Controls: switch the camera group automatically when the camera moves to another car

## The problem

When the camera moves to another car, it keeps the camera group it was in, whether a key, iRacing's UI or iRacing's director moved it. A streamer who does not operate the cameras by hand gets the same kind of shot on every car until someone presses a camera key. Some overlay tools offered an automation for this: on every car change, they also switch to a group from a predefined list. A broadcaster who builds custom camera files asked for it (Discord DM, 2026-11-08), for the streamers who would rather let the cameras run.

This builds on #1653: groups are stored and matched by name, the picker and grid offer every remembered group, and a group the current track lacks is skipped.

## What ships

- **A new Camera Controls keypad mode, Auto Group on Car Change** (`target: "auto-group"`). A press turns the automation on or off.
- **While it's on,** each time the camera moves to another car, the camera switches that car to the next group from the key's list.
- **The list** is a group grid like Cycle Camera's (`autoGroupSubset`, a name → boolean map), with **Pick** set to **In order** or **Random**.
- **The key** shows on or off, and it is never on after a plugin start.
- **A dial gesture, Auto Group on/off,** does the same from a Camera Controls dial or Mirabox knob, with the dial's own list and pick order (decision 9, added 2026-11-22 on Niklas's word: "Dial must be part of 1656").

## Decisions

### 1. A key, not a global setting

A streamer turns this on and off during a stream: before the start, off for a battle they want to direct by hand, back on afterwards. That's a deck control's job, a key's or a dial's (decision 9). A settings-window toggle would put it behind a window they don't have open while live. The list and the pick order belong to the key too, so two keys can hold two styles (say, a TV set and an onboard set) and a press chooses between them.

### 2. One automation at a time, owned by a plugin-wide module

`camera-controls/auto-group.ts` holds the one running automation: the list and pick order it was started with, the context that started it (a key or a dial), and where it is in the list. Keys and dials are the same kind of owner: everything below about keys holds for a dial too.
- **A press on a key that isn't the active one** starts the automation with that key's list, replacing any other.
- **A press on the active key** stops it.
- **Every Auto Group key** shows on only while it is the active one. A second key reads off, so the deck never shows two lit keys for one automation.

An edit to the running key's or dial's own list or Pick takes effect on the running automation at once, with no need to press it off and on; an edit on any other key or dial changes nothing until that one is pressed (added 2026-11-22).

It is run-scoped: never persisted, off at every plugin start, because a camera automation that starts by itself in the middle of someone's stream is worse than one they have to press. It stays on when its key leaves the screen (a profile switch mid-stream). It ends only with a press, a press on another Auto Group key, the plugin stopping, or (added 2026-11-23) its owner no longer offering it: the owning key's Mode changed away from Auto Group, or the owning dial left with no press slot set to Auto Group on/off, since otherwise it would run with no control left that can stop it. On iRacing disconnect it does nothing (there is no camera to move), and it carries on in the next session if it is still on.

Rejected:
- **Stopping it when the key leaves the screen.** A profile switch is routine during a stream, and the automation would stop behind the user's back.
- **Persisting it across restarts,** for the reason above.

### 3. The trigger: the camera's car changes, from any source

The module watches `CamCarIdx` on each telemetry tick while it is on. A change to a different car is a trigger, whatever caused it: a Camera Controls or Replay Control key, iRacing's own UI, the director, or a car change in a replay. The first tick after starting only records the car. Turning the automation on never switches by itself, so the press does exactly what it says.

Car changes come in bursts: a dial spun through the field, or a key held to repeat. So a trigger arms a single settle timer of **250 ms**, and each further change restarts it. When the timer fires, one group switch is sent for the car the camera is on **then**. A spin through ten cars ends in one group change on the car it lands on. The cost is a quarter-second of the old group on the new car, which reads as a deliberate cut rather than a glitch, and it's the price of not sending ten switches.

The switch keeps the car (`switchNum` with the current car's `CarNumberRaw` and the chosen group), so it cannot change `CamCarIdx` and cannot trigger itself.

### 4. The send goes through `requestCameraSwitch`

The switch is sent through `@iracedeck/replay-engine`'s `requestCameraSwitch`, like every camera switch (`iracing-actions/CLAUDE.md`), with `interruptsWalks: false`, because it changes only the camera's angle and never the car. Its target is built inside `send`, from the car the camera is on when the switch goes out. Its `stillValid` drops it if the automation was stopped or replaced meanwhile. During a replay jump the waiter holds it like any other switch.

**It never displaces the user's switch** (added 2026-11-22). The replay engine keeps one waiting camera switch for the whole plugin, and a newer request replaces it, so an automation switch sent while the user's own switch waits behind a replay jump would silently drop the user's. The rule lives in the replay engine's camera-switch waiter, its one camera policy, not in the automation (revised 2026-11-23 after the architect pass): `requestCameraSwitch` takes `yields: true` for an automated switch. A yielding switch never replaces a waiting switch that does not yield; any ordinary switch replaces a yielding one, as before; and a yielding switch is also held while a lap press is in flight or a paced search runs, with its own wait bound. The automation keeps only its 250 ms settle and sends once with `yields: true` and `interruptsWalks: false`. No new engine state is exported for it, and the never-displaces rule is tested in the waiter's own tests against the real slot. Rejected: the automation polling the engine's waiting, lap-press and search state and re-arming its timer, which split the camera policy across two packages and relied on the waiter's one-slot detail that nothing in the engine records.

### 5. Picking the next group

The candidates are the ticked names the current session has, matched with #1653's lookup and in the sim's group order. Names the track lacks are skipped silently, logged at debug.
- **In order** steps through the candidates from where it left off, wrapping at the end. If the camera is already in the next group, it steps once more, so a car change is always visibly a new shot when there are two or more candidates.
- **Random** picks uniformly from the candidates other than the group the camera is in now.

With exactly one candidate, both switch to it if the camera is elsewhere and send nothing if it is already there. With none (an empty list included), nothing is sent, and the key shows **N/A** while a session is loaded, in place of #1653's unavailable look (decision 7); an owning key shows N/A too, and a press there still toggles the automation.

Rejected: weights per group. Nothing asked for them, and a name ticked twice cannot express one.

### 6. The list: the #1653 grid, three TV groups ticked by default

`autoGroupSubset` uses the same stored shape and the same grid as Cycle Camera after #1653: the standard sections plus the remembered groups. A fresh key has **TV1, TV2 and TV3** ticked, the three groups every track has, so the key works out of the box. Every other name, standard or custom, is unticked until the user ticks it. **Pick** is an `sdpi-select` defaulting to **In order**. Both fields end in `.catch` to their defaults, like every Camera Controls field.

### 7. The key icon

The key uses the tri-state toggle template of the Pit Crew toggles (Corner Names on/off, Race Engineer on/off), as Niklas asked on 2026-11-23: one artwork (a camera between rotation arrows, with the amber "A" auto badge) and the shared status bar. It shows **ON** (green) while this key runs the automation, **OFF** (red) when it is off or another key or dial runs it, and **N/A** (grey) when the session has none of the ticked groups or none is ticked. The border follows `borderColorForState` (green, red, grey) and shows only when key borders are on; the `AUTO\nGROUP` title is hidden by default, as on the Pit Crew keys. Niklas approves the icons on a review page before they are committed.

### 8. Communication method

The mode sends SDK camera broadcasts only, so it is an `api` entry in the comms catalog and needs no binding.

### 9. The dial: an Auto Group on/off gesture

A Camera Controls dial is where a broadcaster spins through the field, which is exactly the car change this automation follows, so the dial gets it too. It is a **gesture choice, Auto Group on/off** (`auto-group`), offered on every press slot the dial has: Press, Long Press, Tap Display and Long Touch on a Stream Deck+, and Push on a Mirabox knob (the same dial view since #1013). Like every gesture slot it defaults to None. Rotation keeps its Mode, so one dial can cycle cars and turn the automation on with a press.

- **The list belongs to the dial:** `dial.autoGroupSubset` and `dial.autoGroupPick`, the same shapes, defaults (TV1, TV2, TV3; In order) and `.catch` as the key's fields, so two dials, or a dial and a key, can hold different styles. Its grid and Pick select show in the dial's Property Inspector while any gesture slot is Auto Group on/off.
- **Ownership is decision 2's:** the dial's context is the owner when its gesture started the automation; a press of the same gesture on the active dial stops it, and a key or another dial takes over as a key would.
- **The dial shows the state** on its strip (the screen above the knob on Mirabox): while it is the active owner, an on marker in the strip's Camera Controls style, drawn the same on both hosts. The marker's look is approved by Niklas on a review page with the key icons.
- **Comms:** the dial's comms map gains the same `api` entry; no binding.
- **Hold preview** (added 2026-11-22, narrowed 2026-11-23): on Long Press the strip previews the outcome mid-hold (on or off), as `encoders-and-touchscreen.md` rule 9 requires whenever the outcome is the plugin's own state. Long Touch cannot preview, since the host reports a touch only once it has ended, and the Mirabox knob has no long press, so the preview is Stream Deck+ Long Press only. Its text is user-facing and goes to Niklas with the rest.

Rejected:
- **A dial Mode, Auto Group,** that the rotation would drive. Turning has nothing to do with on/off, and the Mode is what makes the dial useful for picking the car the automation then follows.
- **The dial using the key's or a global list.** #1769 removes the dial's one shared list for that reason; a dial keeps its own, like a key. #1656 adds its own dial fields and does not wait for #1769.

## Out of scope

- **Switching on other events** (an incident, an overtake, a lap). Car change is what was asked for.
- **Choosing the car** (iRacing's director, or Focus on Most Exciting, does that). This only follows the car the camera is on.
- **Per-car or per-class group lists.**
- **Driving the sub-camera within a group.** #965 hands that to iRacing's director.

## Testing

Unit, with a fake telemetry feed and a fake `requestCameraSwitch`:
- **Triggers:**
  - starting the automation records the car and sends nothing;
  - a car change sends one switch after 250 ms, for the car current at send time, keeping the car;
  - a burst of changes inside the window sends one switch;
  - a switch the automation sent never triggers another;
  - car changes from a key, from the sim alone, and in a replay all trigger.
- **Picking:**
  - In order wraps, skips names the track lacks, and never repeats the current group with two or more candidates;
  - Random never picks the current group with two or more candidates;
  - one candidate and no candidates behave as decision 5 says.
- **Ownership:**
  - a press on another key replaces the active list;
  - a press on the active key stops it;
  - only the active key draws on;
  - leaving the screen does not stop it;
  - a plugin start has it off.
- **Settings:** the default list is TV1, TV2 and TV3, the default pick is In order, and junk values in either field leave the key's mode intact; the same for the dial's two fields, which leave the dial's Mode and gestures intact.
- **Dial:** the Auto Group gesture starts and stops the automation with the dial's own list; a dial and a key replace each other as owners; the strip draws the on marker only while that dial is the active owner; the gesture is offered on every press slot and on a Mirabox Push.
- **Comms catalog:** the new `api` entry, regenerated.

Manual, on a track with a custom camera file loaded:
- **Keys:** cycle cars with a key, and each landing car gets a new group from the list.
- **iRacing's own car changes:** let iRacing's UI change the car, and the automation follows.
- **A dial spin** through the field ends in one group change.
- **Two keys with different lists:** pressing the second takes over and the first goes dark.
- **A profile switch** leaves it running.
- **A track without some ticked groups** uses the rest. With none left, the key is drawn unavailable.
- **A replay:** car changes there switch groups too.
- **A plugin restart** finds it off.
- **A dial (Stream Deck+, and a Mirabox knob):** set Press to Auto Group on/off with its own list, press it, spin through the field, and each landing car gets one group from the dial's list; the strip shows it on. Press a key's Auto Group: the key takes over and the dial's marker goes away.
