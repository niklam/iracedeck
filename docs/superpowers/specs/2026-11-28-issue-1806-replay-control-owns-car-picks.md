# Replay Control owns every car pick

> **Issue:** [#1806](https://github.com/iracedeck/iracedeck/issues/1806) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

**Prerequisite:** #1656 merges first. It changes `camera-controls.ts`, `replay-control.ts` and `camera-focus.ejs`, which this issue reworks, and it brings the director record (`CameraCommand.focusModeInEffect`) that decision 6 relies on.

## Decision

Replay Control becomes the one action for choosing which car the camera watches, on keys and on its dial, live and in a replay. Camera Controls keeps only camera choices for new keys and dials. Car modes a user already has in Camera Controls keep working unchanged: they are hidden from Camera Controls' Property Inspector, never removed (Niklas, 2026-11-28).

### 1. Hidden, not migrated

A placed key or dial belongs to the action it was dragged from, on every host (Stream Deck, Stream Dock, Ulanzi Studio). The plugin can change its settings but not which action it is, so no Camera Controls key can become a Replay Control key. Removing a mode from Camera Controls' settings schema would reset every key and dial set to it, which the persisted-settings contract forbids. So the moved modes stay in Camera Controls' schemas and keep their behaviour, and only the Property Inspector stops offering them. (Replay Navigation, Speed and Transport were hidden as whole actions, `VisibleInActionsList: false`; hiding single modes is new here, decision 4.)

### 2. What moves, and one implementation per pick

| Camera Controls today | Replay Control after this |
| --- | --- |
| Key: Cycle by Car # | Car # Next / Previous, through one shared car-number step |
| Key: Cycle by Track Order | Car Next / Previous (iRacing's Next / Previous Car, #1277; already the same sim control) |
| Key: Focus Your Car | Jump to My Car, through one shared my-car send |
| Key: Focus on Leader / Incident / Most Exciting | New key modes |
| Key: Switch by Position, Switch by Car Number | New key modes; same stored target, drawn in the artwork (#1352) |
| Key: Focus Select Car (Stream Deck only, gated by the `profiles` flag) | New key mode, gated the same way |
| Dial modes: Car #, Position, Track Order | Already there (#801, #1448), made to work live (decision 3) |
| Dial gestures: Focus on Leader / Incident / Most Exciting | New gesture actions; Jump to My Car already exists |

**Stays in Camera Controls:** Change Camera, Cycle Camera, Cycle Sub-camera, Cycle Driving Cam, Set Camera State, Auto Group on Car Change (#1656), and the dial's Camera, Sub-camera and Driving modes with the Change Camera and Auto Group gestures. The legacy `com.iracedeck.sd.core.camera-cycle` ("Camera Cycle (Legacy)") runs the same class and Property Inspector, so the hiding applies to it too.

**Two picks exist twice today with different send paths, and become one.** Focus Your Car reads `PlayerCarIdx`, sends `switchNum(car, CamGroupNumber, CamCameraNumber)` and refuses without telemetry; Jump to My Car reads `DriverInfo.DriverCarIdx` and sends `switchNum(car, 0, 0)`. Cycle by Car # sends the current angle, falls back to `camera.cycleCar` out of session and walks from a negative `CamCarIdx`; Car # Next / Previous sends `0, 0` and refuses `CamCarIdx < 0`. Each pair becomes one shared function, with one player-car source and one argument form (group and camera `0, 0`, which `CameraCommand` documents as "keep current"), called by both actions' keys and dials. The plan picks the more robust of each pair's guards and fallbacks; the difference is stated in the PR.

**Where the shared code lives** (as #1448 did): one module under `iracing-actions/src/shared/` for every car pick (the focus one-shots, my car, the car-number step, Switch by Position and Car Number, Focus Select Car with its `_deviceProfiles` push). Each function takes the calling action's own switch requester, so each keeps its waiter label and `stillValid`. A shared settings fragment carries `position`, `carNumber`, `focusSelectorProfile` and `_deviceProfiles`, spread into both schemas as `dialAppearanceFields` is, so key names and coercion cannot drift. `switch-target-value.ts` splits into the shared value text plus a frame per icon, since Replay Control's icons have their own geometry.

### 3. The Replay Control dial's car picks work live

Today the Replay Control dial refuses every turn and gesture outside a replay, while Camera Controls' dial steps cars while spectating live. Moving users there must not take that away. So the camera-only rotation modes (Car #, Position, Track Order) and the camera gestures (Jump to My Car and the new Focus gestures) are exempt from the dial's in-replay guard, as Replay Control's keys already are for their camera-only modes; the hold preview is gated the same way. Outside a replay the camera-switch waiter sends at once, as it does for Camera Controls. **Accepted difference:** in an in-session replay scrubbed back from the live edge, Replay Control's Position mode shows `P--` and sends nothing, where Camera Controls' Position switches; the plan aligns them if the shared step makes it free.

### 4. Hiding in the Property Inspector

The vendored `sdpi-select` offers every light-DOM `<option>` (an `<option hidden>` is still offered), shows the default when the stored value has no option (so a Focus on Leader key would read "Change Camera", and picking that saves nothing), and re-reads options only on a `childList` change. So hiding is one shared `pi-components` helper, alongside `irdKeepOneChecked` and `irdDigitsOnly`:

- It removes the `<option>` nodes of a given set unless the select's stored value is that value. For a dial with no stored mode it compares against the resolved default (decision 5).
- It decides only after the settings have arrived, and re-runs on a value change.
- It never saves, so no stored value is ever rewritten.
- The kept option's text, "(moved to Replay Control)", comes from the EJS, not from script.

It is used for the key Mode select, the dial Mode select and all four gesture selects. The feature-count test (#1271) reads the helper's marker, so the counts match what is offered. The legacy `focus-on-exiting` value, rewritten on appear to `focus-on-most-exciting`, is a hidden value like the others.

### 5. A new Camera Controls dial starts on a camera mode

The dial's default is `car-number`, and a dial that never saved a mode resolves to it. Every key and dial is stamped with `addedWithVersion` at first appearance (#315, since 2026-04-11), so an old dial can be told from a new one, as Tire Service already does (`isPreExisting`):

- An unset `dial.mode` resolves at read time: an old dial (a stamp older than this release, or no stamp but other stored keys) keeps `car-number`; a new one (raw `{}` at first appearance, or a stamp at or after this release) gets `camera`.
- The resolved mode is persisted with `persistDialPatch` at first appearance, before `super.onWillAppear`, as Audio Controls does, so the base's stamp write cannot race it.
- The PI mirrors the resolution by setting the select's `default` from script (#1585's pattern).
- **The one remaining miss:** a dial with otherwise empty settings that has not appeared since 2026-04-11 reads as new and becomes a camera dial.

### 6. The director rule (#1656)

Auto Group keeps iRacing's director by reading the plugin's last focus send in `CameraCommand` (`iracing-sdk`), which records every `CamSwitchPos` and `CamSwitchNum` whichever action sends it, and Replay Control's Next / Previous Car taps already clear it. So a Focus key or gesture on Replay Control counts exactly like one on Camera Controls, with no change to Auto Group. Its tests prove it from both actions.

### 7. Profiles, icons and words

- **Default Stream Deck profiles:** across all 32 bundled profiles the only moved Camera Controls mode is one Focus Select Car key in each Replay profile (SD, XL, Plus, Plus XL); it becomes the Replay Control key. The Replay Plus profile's Camera Controls dial stores `mode: camera` and stays.
- **Icons:** the new Replay Control key modes get icons in Replay Control's style, approved by Niklas on a review page before they are committed. The same pick then has an icon per action style.
- **Words:** the Camera Controls page lists the moved modes under one short "moved to Replay Control" note; the Replay Control page gains them, including that its dial's car picks work live; the overview counts follow the feature-count test. User-facing text goes to Niklas for approval.

## Alternatives rejected

- **Migrating keys to Replay Control.** Impossible: the host owns which action a placed key is.
- **Removing the modes from Camera Controls.** Resets users' keys and dials; violates the persisted-settings contract.
- **Keeping `car-number` as every unset dial's default.** Every new Camera Controls dial would start on a moved car mode, against the decision; the version stamp makes the split possible.
- **Leaving both actions offering car picks.** Two places to look, and the split this issue exists to end.
- **A third "Car Focus" action.** Replay Control already owns most car picks and the default replay profiles; a new action would split them again.

## Out of scope

- Removing the hidden modes from Camera Controls at a later date.
- Changing what a car pick does beyond unifying the two duplicated send paths in decision 2 and the live dial in decision 3.
- Switch by Position's order: it keeps iRacing's `switchPos` (the official order), not the canonical live order.
- Ulanzi dials (Ulanzi is keypad-only for these actions).
- Cockpit Misc's `ffb-max-force` option, which is marked hidden but still offered: an older gap, its own issue.
- The shared group-only switch for Cycle Camera under a director focus (proposed separately from #1656's architect pass).

## Testing

- **Unit, shared picks:** each shared function sends the one agreed form; both actions' keys and dials call it (asserted by spying the shared module).
- **Unit, Replay Control:** each new key mode and gesture; Switch by Position / Car Number store and draw their target; Focus Select Car stays behind the `profiles` flag; the dial's camera-only modes and gestures turn and fire outside a replay, while its replay-only modes still refuse there.
- **Unit, Camera Controls:** a key and a dial stored on every moved mode, `focus-on-exiting` included and the legacy Camera Cycle UUID included, parse, render and dispatch as before; an unset dial mode resolves to `car-number` for an old dial and `camera` for a new one, and the resolved mode is persisted once.
- **PI helper:** against the vendored `sdpi-select`, a moved option is removed unless it is the stored value, decided after settings arrive and re-run on change, with no save.
- **Unit, Auto Group:** a focus sent from Replay Control's key and dial gesture keeps the director.
- **Feature counts:** README and website counts pass `scripts/readme-feature-counts.test.mjs` with the hidden options not counted.
- **Manual (Niklas):** an existing profile with Camera Controls car keys and a car-mode dial works unchanged after the update, and the moved modes show the note; a newly placed Camera Controls dial starts on Camera; on Replay Control, each new key mode and gesture does what its Camera Controls counterpart does, and its dial steps cars while spectating live; the default Replay profiles' car keys are Replay Control keys; the icons as approved.
