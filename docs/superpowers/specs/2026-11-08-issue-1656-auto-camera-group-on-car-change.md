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

## Decisions

### 1. A key, not a global setting

A streamer turns this on and off during a stream: before the start, off for a battle they want to direct by hand, back on afterwards. That's a key's job. A settings-window toggle would put it behind a window they don't have open while live. The list and the pick order belong to the key too, so two keys can hold two styles (say, a TV set and an onboard set) and a press chooses between them.

### 2. One automation at a time, owned by a plugin-wide module

`camera-controls/auto-group.ts` holds the one running automation: the list and pick order it was started with, the key context that started it, and where it is in the list.
- **A press on a key that isn't the active one** starts the automation with that key's list, replacing any other.
- **A press on the active key** stops it.
- **Every Auto Group key** shows on only while it is the active one. A second key reads off, so the deck never shows two lit keys for one automation.

It is run-scoped: never persisted, off at every plugin start, because a camera automation that starts by itself in the middle of someone's stream is worse than one they have to press. It stays on when its key leaves the screen (a profile switch mid-stream). It ends only with a press, a press on another Auto Group key, or the plugin stopping. On iRacing disconnect it does nothing (there is no camera to move), and it carries on in the next session if it is still on.

Rejected:
- **Stopping it when the key leaves the screen.** A profile switch is routine during a stream, and the automation would stop behind the user's back.
- **Persisting it across restarts,** for the reason above.

### 3. The trigger: the camera's car changes, from any source

The module watches `CamCarIdx` on each telemetry tick while it is on. A change to a different car is a trigger, whatever caused it: a Camera Controls or Replay Control key, iRacing's own UI, the director, or a car change in a replay. The first tick after starting only records the car. Turning the automation on never switches by itself, so the press does exactly what it says.

Car changes come in bursts: a dial spun through the field, or a key held to repeat. So a trigger arms a single settle timer of **250 ms**, and each further change restarts it. When the timer fires, one group switch is sent for the car the camera is on **then**. A spin through ten cars ends in one group change on the car it lands on. The cost is a quarter-second of the old group on the new car, which reads as a deliberate cut rather than a glitch, and it's the price of not sending ten switches.

The switch keeps the car (`switchNum` with the current car's `CarNumberRaw` and the chosen group), so it cannot change `CamCarIdx` and cannot trigger itself.

### 4. The send goes through `requestCameraSwitch`

The switch is sent through `@iracedeck/replay-engine`'s `requestCameraSwitch`, like every camera switch (`iracing-actions/CLAUDE.md`), with `interruptsWalks: false`, because it changes only the camera's angle and never the car. Its target is built inside `send`, from the car the camera is on when the switch goes out. Its `stillValid` drops it if the automation was stopped or replaced meanwhile. During a replay jump the waiter holds it like any other switch.

### 5. Picking the next group

The candidates are the ticked names the current session has, matched with #1653's lookup and in the sim's group order. Names the track lacks are skipped silently, logged at debug.
- **In order** steps through the candidates from where it left off, wrapping at the end. If the camera is already in the next group, it steps once more, so a car change is always visibly a new shot when there are two or more candidates.
- **Random** picks uniformly from the candidates other than the group the camera is in now.

With exactly one candidate, both switch to it if the camera is elsewhere and send nothing if it is already there. With none, nothing is sent, and the key is drawn with the shared unavailable look while a session is loaded, as #1653 does for a missing group.

Rejected: weights per group. Nothing asked for them, and a name ticked twice cannot express one.

### 6. The list: the #1653 grid, three TV groups ticked by default

`autoGroupSubset` uses the same stored shape and the same grid as Cycle Camera after #1653: the standard sections plus the remembered groups. A fresh key has **TV1, TV2 and TV3** ticked, the three groups every track has, so the key works out of the box. Every other name, standard or custom, is unticked until the user ticks it. **Pick** is an `sdpi-select` defaulting to **In order**. Both fields end in `.catch` to their defaults, like every Camera Controls field.

### 7. The key icon

The mode gets an on/off icon pair in the Camera Controls style. Niklas approves both on a review page before they are committed. The default title is `AUTO\nGROUP`. On is drawn with the toggle actions' green state border (`borderStateColor`), off with the grey one, so the state reads the same way as every other toggle key.

### 8. Communication method

The mode sends SDK camera broadcasts only, so it is an `api` entry in the comms catalog and needs no binding.

## Out of scope

- **A dial surface for the mode.**
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
- **Settings:** the default list is TV1, TV2 and TV3, the default pick is In order, and junk values in either field leave the key's mode intact.
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
