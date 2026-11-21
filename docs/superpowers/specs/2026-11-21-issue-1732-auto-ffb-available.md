# Force Feedback shows whether Auto FFB has a value to apply

> **Issue:** [#1732](https://github.com/niklam/iracedeck/issues/1732) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Related: #802 (the Force Feedback dial), #1268 (View FFB Force, open), #1451 (FFB Strength on the dial), #1162 and #1463 (the unavailable look), #1599 and #1671 (the disconnected look).

## Context

The issue says iRacing greys out its auto FFB option until it has a value to apply, and that the Auto Compute FFB Force key and the dial's Auto FFB gesture look the same either way. Telemetry has no "auto available" flag. What it does have, from `docs/reference/telemetry-vars.json`:

| Variable | SDK description | Typed on `TelemetryData` |
| --- | --- | --- |
| `SteeringWheelTorque` | Output torque on steering shaft (Nm) | yes |
| `SteeringWheelTorque_ST` | Output torque on steering shaft at 360 Hz, 6 samples a tick (Nm) | no |
| `SteeringWheelPctTorque` | Force feedback % max torque on steering shaft, unsigned | yes |
| `SteeringWheelMaxForceNm` | Value of strength or max force slider in Nm for FFB | yes |
| `SteeringWheelPeakForceNm` | Peak torque mapping to direct input units for FFB | yes |
| `SteeringWheelUseLinear` | True if steering wheel force is using linear mode | no |

The one live reading on record (#1451's spec, 2026-10-18) had `SteeringWheelPeakForceNm = -1`, read as "apparently unset". Nobody recorded whether the car had been driven at that moment, so it does not tell us whether that variable is the wheelbase's peak torque setting, as its description suggests, or a measured peak that is `-1` until there is one.

Today the keypad Force Feedback key subscribes to no telemetry; only the dial does (`force-feedback-dial-surface.ts`). Keys that cannot do anything right now already have one look for it, `unavailableLook` in `shared/unavailable-look.ts` (Replay Markers #1162, Replay Control #1354, Wipers and Visor #1463): the key's own icon with every colour slot but the background turned grey, the border grey, and the artwork and title faded by `assembleIcon`'s `dimmed`.

## The availability model

Every statement in this section about how iRacing behaves is **to confirm with Niklas** and is settled by the capture below. The model is decided anyway, so implementation does not wait for the capture; at most the capture changes a constant or switches to one of the two named variants.

**Model (to confirm with Niklas):** iRacing keeps a running peak of the steering-shaft torque the player's car produces while it is driven. The peak starts from nothing when the car is loaded. Auto FFB sets the max force from that peak. The auto option is greyed while there is no peak, and becomes available once the car has been driven and produced steering torque. It stays available until the car is loaded again: another car, or iRacing restarted. Applying auto does not grey it again.

### The derivation

A pure tracker, `AutoFfbAvailability` in `force-feedback/auto-ffb-availability.ts`, holds the plugin's own estimate of that peak and answers one of three states:

- **`available`**: the estimated peak since the last reset it saw is at least `AUTO_FFB_MIN_PEAK_NM`.
- **`unavailable`**: the tracker saw the reset itself, and no qualifying torque since.
- **`unknown`**: anything else. This covers the plugin or the tracker starting while iRacing already had the car loaded, since the car may have been driven before we were watching. It also covers no telemetry and the sim being absent.

The rule behind the three states: **the plugin greys auto only when it knows auto has nothing to apply.** An unknown state never greys, because a greyed key the driver cannot trust is worse than today's key.

The tracker's inputs, each tick:

- **The peak.** `max(|SteeringWheelTorque_ST[i]|)` over the tick's six samples, falling back to `|SteeringWheelTorque|` when the array is absent. The 360 Hz samples catch kerb and impact spikes a 60 Hz read misses, and iRacing's own peak is presumably taken from the fast signal (to confirm with Niklas). `SteeringWheelTorque_ST?: number[]` is added to `TelemetryData` in `iracing-native/src/defines.ts`.
- **Which samples count.** Only while the player is driving: `IsOnTrack` true and `IsReplayPlaying` false. Whether iRacing counts torque at a standstill in the pit stall (turning the wheel while parked loads the shaft too) is to confirm with Niklas. Until the capture says otherwise, stall samples count like any other on-track sample.
- **Resets the tracker can see.** Two events reset the peak and make the state known:
  - The sim connects while the tracker is running. A fresh iRacing start loads the car fresh.
  - The player's car changes while connected: `DriverInfo.DriverCarIdx`'s `CarID` in session info differs from the last one seen.

  The first car seen after the tracker starts is not a reset: the state stays `unknown` until torque arrives.
- **What does not reset (to confirm with Niklas):** a session change in the same car (practice to qualifying), a tow or reset to the pits, exiting to the garage and clicking Drive again. If the capture shows any of these greys auto, it joins the reset list, which is a one-line change.

`AUTO_FFB_MIN_PEAK_NM` starts at **1.0 Nm** so a twitch of the wheel in the stall does not light the key. The capture sets it from the smallest running peak seen at the moment auto lit, across the cars.

**Where the tracker runs.** The `ForceFeedback` action owns one tracker. It subscribes to `sdkController` under its own id (`${FORCE_FEEDBACK_UUID}:auto-ffb`) when the action's first context appears, and **stays subscribed for the plugin's life**. Unsubscribing after the last key disappeared would lose the peak on every Stream Deck page switch, and the cost is one `max` over six numbers a tick. Keys and dials read `tracker.state()`. On a change of state the tracker calls one listener, which redraws the affected keys (below).

### Two named variants, decided now for both capture outcomes

- **Variant B: auto greys again after it is applied, and re-lights only when the car produces a higher peak.** Then "available" means "auto would change the value". The derivation becomes stateless on top of the same peak: `available` iff `|f(peak) - SteeringWheelMaxForceNm| >= AUTO_FFB_CHANGE_TOLERANCE_NM`, where `f` is the mapping from peak to the max force auto sets, read off the capture (step 6). Before any reset is seen, the state is `unknown` as above. The tolerance starts at 0.05 Nm, half the display's resolution, and is widened if the 360 Hz estimate trails iRacing's own peak.
- **Variant P: `SteeringWheelPeakForceNm` is the measured peak.** If the capture shows it flip from `-1` to a positive value at the moment auto lights, and follow the driven peak after that, the tracker goes. Availability is then `SteeringWheelPeakForceNm > 0`, a stateless read with no `unknown` state from a mid-session start. Variant P wins over the tracker whenever it holds, because iRacing's own number beats our estimate of it.

**Fallback.** If the moment auto lights matches nothing the capture logs (no torque threshold, no lap or time-driven count, no change in `SteeringWheelPeakForceNm`), telemetry cannot show it. The issue then closes as not planned (won't-do), and this spec gets one amendment recording the finding, so nobody re-derives it.

## The key: Auto Compute FFB Force

Only the `auto-compute-ffb-force` keypad mode changes. FFB Force, Wheel LFE and Bass Shaker LFE keys look exactly as today.

| State | Look |
| --- | --- |
| `available` | Today's icon, unchanged: the "lit" look the issue asks for is the look the key already has. |
| `unknown` | Today's icon, unchanged, for the rule above. |
| `unavailable` | `unavailableLook(colors, border)`: every slot but the background grey, the border grey, artwork and title faded to `DIMMED_OPACITY`. The same helper and the same call shape as Wipers and Visor. |

- **The press is never gated.** A press taps `forceFeedbackAutoCompute` in every state. The look is information derived from a model, and if the model is wrong, a blocked press would be a bug the driver cannot work around. Whether iRacing ignores the binding while its option is greyed is to confirm with Niklas, and the capture records it (step 2).
- **The binding warning** (#612) is passed alongside, as Wipers and Visor does: a missing binding still shows its ⚠, over the grey look when both apply.
- **The disconnected look** (#1599) is unchanged and needs no special case. With the sim absent the state is `unknown`, so the key draws its normal icon under the dim layer.
- **The icon's literal colours.** The auto icon's amber "A" badge (the `ambG` gradient and its `#3a2a10` letter), the hub `#3f5561`, the handle `#b7c5cd` and the white highlight are literals, not colour slots. In the unavailable look they fade with the artwork rather than turning grey. All four slots (`backgroundColor`, `textColor`, `graphic1Color`, `graphic2Color`) are already used, so a slot cannot be added for the badge. The decision is to ship the shared look unchanged. Niklas sees it on the review page, and if the faded amber badge still reads as "ready" to him, the unavailable state gets a second graphic, `auto-compute-ffb-force-unavailable.svg`, identical except for a grey badge, chosen in `generateForceFeedbackSvg` by the state. Either way the look is approved on the review page before it is committed.
- **Redraw.** The tracker's change listener calls `refreshAllImages` filtered to keypad contexts whose mode is `auto-compute-ffb-force`, and the regenerate callback `updateDisplay` already registers reads the current state. No key is redrawn per tick, and a key in another mode never is.
- `generateForceFeedbackSvg(settings, bindingMissing, autoState)` gains the state as a parameter, defaulting to `unknown`, so every existing call and test keeps today's output.

### In each key icon type

The key icon types are design conventions per icon family (`key-icon-types.md`), not a user choice. The Auto Compute FFB Force icon is a **Default** type icon with a two-line `AUTO` / `FFB FORCE` title, and has no Black Box or Inverted variant. The unavailable look is applied the same way whatever the type, since it works on resolved colour slots, the border and `dimmed` rather than on the layout:

| Icon type | Available / unknown | Unavailable |
| --- | --- | --- |
| Default (this key) | Today's icon: wheel and arrows in `graphic1Color` / `graphic2Color`, amber "A" badge, two-line title | The same layout, slots grey, border grey, artwork and title at 35 % opacity, badge faded (or grey, per the review page) |
| Black Box (not used by this key) | Would be the type's look unchanged | The box frame's `graphic1Color` outline turns grey with the rest and fades, so the frame still reads as a box |
| Inverted (not used by this key) | Would be the type's look unchanged | The title keeps its two lines and weights, faded; only colour and opacity change |

The review page shows the Default type in both states with default colours, with a user colour override (to prove an override turns grey rather than only fading), with the title hidden, and with the binding ⚠.

## The dial: the Auto FFB marker

A dial shows the marker when **any gesture this host can fire** is `auto-ffb`:

- where `__FEATURE_DIAL_EXTENDED_GESTURES__` is on (Stream Deck+): Press, Long Press, Tap Display or Long Touch;
- where it is off (Mirabox knob): Press only, since no release classifies as long and there is no touch input (`encoders-and-touchscreen.md`, rules 2 and 5).

The marker is the dash box's existing **caption** line (#1230), so both renderers already draw it and no new drawing enters `renderDialBox`:

| State | Caption |
| --- | --- |
| `available` or `unknown` | `AUTO`, in the label colour |
| `unavailable` | no text, with `reserveCaptionLine: true` |

- `reserveCaptionLine` is set whenever an `auto-ffb` gesture is configured, so the value keeps one size and place in all three states and the marker coming and going moves nothing.
- A dial with no `auto-ffb` gesture draws exactly as today, byte for byte, and so do the dial's value, label, colours and rotation.
- On an LFE dial (identity-only box) the caption sits under the label in the same way.
- The marker follows the same rule as the key: absent only when the plugin knows auto has nothing to apply.
- **Redraw.** The state goes into `displayedSignature` and into `signature`, so the existing per-tick change detector and its 100 ms throttle pick it up, and `didReceiveSettings` (a gesture changed) already busts the memo. The tracker's change listener also calls `dialSurface.refreshAll()`, so a dial redraws on a state change even if no other value moved.
- The #1120 hold preview stays as it is: Auto FFB has no read-back, so a long press previews nothing.
- The trigger description does not change.
- The disconnected look (#1671) draws over the dial as it does today.

## Settings

**None.** The look is always on. The grey key and the missing caption only ever appear when the plugin knows auto has nothing to apply, and a user who dislikes the grey has no use for a key that looks pressable when it is not. No action schema changes, so no persisted contract moves and no migration is needed.

## Sim claims to confirm with Niklas

Every one of these is an assumption the model rests on. The capture settles each:

1. iRacing greys its auto option until it has a value to apply, and the screen that shows it can be watched while driving (the issue calls it the black box).
2. The auto value comes from a running peak of steering-shaft torque since the car was loaded.
3. Auto becomes available once the car has been driven, with no lap count or minimum distance.
4. Torque in the pit stall at a standstill does, or does not, count.
5. Applying auto does not grey the option again (Variant B if it does).
6. Only a car change or an iRacing restart resets it, not a session change, a tow, a reset or a garage exit.
7. `SteeringWheelPeakForceNm` is the wheelbase setting rather than a measured peak (Variant P if it is the measured peak).
8. iRacing's peak follows the 360 Hz torque, so `SteeringWheelTorque_ST` tracks it more closely than `SteeringWheelTorque`.
9. Pressing the auto binding while the option is greyed does nothing.
10. The value auto sets is a function `f` of the peak, possibly depending on `SteeringWheelUseLinear` (only needed for Variant B).

## The capture

Niklas runs it in the sim before the PR opens. A throwaway probe logs every tick to a file: the hands-free sim probe pattern (an untracked vitest file in the worktree run with `IRACEDECK_REAL_NATIVE=1`, deleted afterwards), started before iRacing.

**Logged per tick:**

- `SessionTime`, `SessionNum`, `SessionUniqueID`, `IsOnTrack`, `IsInGarage`, `OnPitRoad`, `PlayerCarInPitStall`, `IsReplayPlaying`, `Speed`, `Lap`, `LapCompleted`;
- `SteeringWheelTorque`, all six `SteeringWheelTorque_ST` samples, `SteeringWheelPctTorque`, `SteeringWheelMaxForceNm`, `SteeringWheelPeakForceNm`, `SteeringWheelUseLinear`;
- the player's `CarID` and `CarPath` from session info;
- the tracker's own state, so the run tests the implementation too.

**Marks.** At each moment below, Niklas presses a Telemetry Control **Snapshot** key, so every observation carries an exact `SessionTime`. Each mark is noted with what he saw: auto greyed or available, and the max force shown before and after.

**Cars:** three with very different steering loads, all on one road course:

- the Global Mazda MX-5 Cup, light;
- the Acura NSX GT3 EVO 22, mid;
- the Dallara IR18, a high-downforce formula car with heavy steering.

**Steps, per car:**

1. Start iRacing fresh, join a test session, and before clicking Drive open the screen with the auto option. Mark: greyed or not.
2. Click Drive. Sit in the stall and press the Auto Compute FFB Force binding once. Mark whether the max force changed (claim 9).
3. Still in the stall, turn the wheel lock to lock a few times. Mark: greyed or not (claim 4).
4. Drive out at pit-lane speed, then at race pace. **Mark the moment the option turns available** (claims 2 and 3).
5. Watch `SteeringWheelPeakForceNm` against step 4's moment (claim 7).
6. Press auto. Mark the max force before and after. Mark whether the option greys again (claim 5). After-value against the logged running peak gives `f` (claim 10).
7. Drive over a hard kerb or take a heavier corner. Mark whether a greyed option re-lights.
8. Tow or reset to the pits; exit to the garage and click Drive again. Mark each (claim 6).

**Once, in one car:**

9. Move from practice to qualifying in an AI session. Mark.
10. Change car in the same sim run. Mark: greyed again?
11. Toggle linear mode or the wheelbase peak torque setting, and repeat steps 4 and 6 (claim 10).
12. Restart the plugin mid-session with the car driven. The key must show the normal look (`unknown`), never grey.

**What it decides:**

- **The model holds.** The option lights when the running peak first crosses some value and stays lit until a car change. Then `AUTO_FFB_MIN_PEAK_NM` is set below the smallest running peak at step 4's mark across the three cars, and the reset list is fixed from steps 8 to 10.
- **Step 6 greys the option.** Variant B ships, with `f` and the tolerance from steps 6, 7 and 11.
- **Step 5 shows the flip.** Variant P ships.
- **Step 4's moment correlates with a lap or time count rather than torque.** The tracker counts that instead; it is the same tracker with a different input.
- **Nothing explains step 4's moment.** Won't-do, as in the fallback above.

Each outcome amends this spec on `master` before the PR, and the findings join the sim fact sheet in memory.

## Affected artifacts

- `@iracedeck/iracing-actions`: `force-feedback/auto-ffb-availability.ts` (new) with tests, `force-feedback.ts`, `force-feedback-dial-surface.ts`.
- `@iracedeck/iracing-native`: `SteeringWheelTorque_ST` (and `SteeringWheelUseLinear`, for the probe) typed on `TelemetryData`.
- `@iracedeck/icons`: only if the review page asks for the grey-badge graphic; then its preview is regenerated.
- No manifest, PI, schema or comms-catalog change, and nothing differs between the three plugins.
- Website `force-feedback.md`:
  - Auto Compute FFB Force: **Telemetry-aware icon: Yes**, with the two looks and the rule that the press always goes through;
  - On a dial: the `AUTO` caption and when it shows.
- A `Features` changelog fragment.
- The `iracedeck-actions` skill, if it lists the telemetry-aware flag.

## Alternatives rejected

- **A sim-event on the bus from the translator.** It would put the tracker in `sim-events-iracing` and add an `@iracedeck/event-bus` catalog entry, a published contract reviewed at `xhigh`, for one key's look. The derivation needs no consumer beyond this action. If a Race Engineer callout ("auto FFB is ready") is ever wanted, the tracker moves there then.
- **Greying on `unknown`.** It would grey a key that works, after every plugin restart in a driven car. That is a lie at exactly the moment the driver trusts it.
- **A distinct "available" look** (a glow or a brighter badge). The issue's lit state is today's icon. A third look would make the key's normal appearance mean "unknown", which is a state the driver cannot act on.
- **Blocking the press while unavailable.** The state is derived from a model; a wrong model would then cost the driver a working button.
- **A dial marker drawn with a new shape** (a dot or a lamp beside the label). The caption line already exists on both renderers, is pinned by fixtures and moves nothing when its text comes and goes. A new mark would be a new drawing for two canvases.
- **A setting to turn the look off.** It adds a persisted field for a look that only appears when it is true.
- **Unsubscribing the tracker with the last key.** A Stream Deck page switch would forget the peak and drop to `unknown` for the rest of the session.

## Out of scope

- The FFB Force, Wheel LFE and Bass Shaker LFE keys and the dial's rotation readout. Nothing about them changes.
- #1268's View FFB Force mode. If it lands first, its keypad telemetry subscription and this tracker's stay separate: the tracker must run for every key and for no key at all, while #1268's re-render is per View key.
- Showing the value auto would set. Only Variant B needs `f`, and even then the key shows availability, not a number.
- A Race Engineer callout when auto becomes available.
- Cockpit Misc's legacy FFB keys.
- Any change to the disconnected look, the binding warning or `unavailableLook` itself.

## Testing

Suite:

- `auto-ffb-availability.test.ts`:
  - starts `unknown`, and stays `unknown` with the first car seen and no torque;
  - a sim connect seen by the tracker gives `unavailable`;
  - a `CarID` change gives `unavailable`, then `available` once a sample reaches `AUTO_FFB_MIN_PEAK_NM`;
  - samples below the floor keep it `unavailable`;
  - a negative torque counts by its magnitude;
  - the six `_ST` samples are used, with a fallback to `SteeringWheelTorque` when the array is absent;
  - samples with `IsOnTrack` false or in a replay are ignored;
  - a session change, `IsOnTrack` going false and true again, and a tow do not reset (until the capture says otherwise);
  - a sim absent gives `unknown`;
  - the listener fires once per state change and never on an unchanged tick;
  - `NaN`, `Infinity` and `undefined` torque are ignored.
- If Variant B or P ships, their own cases: `f` and the tolerance boundary, and the `-1` to positive flip.
- `force-feedback.test.ts`:
  - `generateForceFeedbackSvg` with no state is byte-identical to today;
  - `unavailable` calls the grey look (slots grey, `dimmed`), and an override colour turns grey;
  - `available` and `unknown` draw today's icon;
  - the binding ⚠ is drawn over the grey look;
  - a state change redraws an auto key and not an FFB Force key;
  - a press taps `forceFeedbackAutoCompute` in all three states;
  - the tracker subscribes once however many keys appear, and survives the last key's disappearance.
- `force-feedback-dial-surface.test.ts`:
  - no `auto-ffb` gesture: output unchanged;
  - with one: `AUTO` caption for `available` and `unknown`, none for `unavailable`;
  - the value keeps its place in all three;
  - with extended gestures off, only Press counts (a Long Touch set to `auto-ffb` shows no marker);
  - a state change alone triggers a redraw within the throttle;
  - the signature carries the state.
- The dial-box fixture tests stay green untouched, since the caption is existing vocabulary.

Manual, in iRacing:

- The capture above, before the PR. It decides the model, the constant and the variant.
- On a Stream Deck: an Auto Compute FFB Force key greys on joining a session in a fresh car, lights once the car is driven, and matches iRacing's own auto option at each step of the capture.
- On a Stream Deck+ dial with Long Touch set to Auto FFB, and on a Mirabox knob with Press set to Auto FFB: the `AUTO` caption follows the same states, and the value never moves.
- After a plugin restart mid-session in a driven car, the key shows its normal look, not grey.
- With **Dim keys that need iRacing** on and iRacing closed, the key and the dial show the disconnected look over their normal look.
- The review page: the Default type key available and unavailable, with default colours, a colour override, the title hidden and the binding ⚠. Niklas approves the look, or picks the grey-badge graphic.
