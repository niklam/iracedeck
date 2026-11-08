> **Issue:** [#1653](https://github.com/niklam/iracedeck/issues/1653) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Camera Controls: any camera group the loaded camera file defines

## The problem

Camera Controls (UUID `com.iracedeck.sd.core.camera-focus`, PI `camera-focus/camera-focus.ejs`) offers 25 camera group names, all of them our own list: `CHANGE_CAMERA_GROUPS` / `DEFAULT_CAMERA_GROUPS` in `camera-controls/camera-groups.ts`, copied into the PI's Change Camera `<optgroup>`s and its `ALL_GROUPS` grid. A track camera file can define any groups under any names, and broadcaster packages ship 20–30 of them (`DynamicTV`, `Grid_Pole`, `Start`, `SpeedCam`, …). None can be put on a key.

The press path does not stand in the way. Since #958 Change Camera resolves its group by **name** against the session's `CameraInfo.Groups` and sends the sim's own number for it, and Cycle Camera intersects its enabled names with that same list. What is closed is the set of names a user can store: Change Camera stores an index into our map (`cameraGroup`, 1–25), and the PI grid only lists our 25.

## What ships

- **Change Camera** can target any group name. It stores the name in a new `cameraGroupName` setting; existing keys, which store only `cameraGroup`, keep working unchanged.
- The plugin publishes the session's group names to the Property Inspectors as a run-scoped global, `_cameraGroups`.
- A new `ird-camera-group-select` picker shows the standard groups, the custom groups of the loaded camera file, the key's stored name even when no session lists it, and an **Other…** entry for typing a name.
- The **Cycle Camera** grids (the keypad's per-key subset and the dial's global one) gain a section listing custom group names, live from `_cameraGroups` plus any already ticked.
- A custom group has no artwork of its own, so it is drawn with one new generic camera-group icon, with the group's name as the title.

## Decisions

### 1. Store the name beside the number, and keep reading the number

`cameraGroupName: z.string().trim().default("").catch("")` is added beside `cameraGroup`. A non-empty name wins; an empty one means "read `cameraGroup` through `CHANGE_CAMERA_GROUPS`", which is every key saved before this change. Nothing is migrated or rewritten: opening an old key's PI shows its group from the number and writes nothing until the user changes it.

The picker writes both fields: the name always, and `cameraGroup` as well when the name is one of the 25 standard groups. That keeps a downgrade honest for every standard choice, since an older build ignores the unknown `cameraGroupName` key and reads the number. A custom name leaves `cameraGroup` at its last value, and an older build then presses that group. That is accepted: no number can mean a group the older build has never heard of, and the alternative of writing some sentinel number would make the older build press a camera the user never chose rather than one they once did.

Rejected:
- Replacing `cameraGroup` with a name and migrating stored values. It rewrites every Change Camera key in the field for a change that only needs to add, and a downgrade would then reset every standard key to Cockpit (the field's default) instead of only the custom ones.
- Widening `cameraGroup` to `number | string`. One field with two meanings, and every reader branching on the type.

### 2. Name matching: normalised, exact first, then case-insensitive

A stored name is matched against the session's groups after the existing `normalizeGroupName` (`Pit Lane2` → `Pit Lane 2`), exactly first and then case-insensitively. The case-insensitive pass is for a typed name, where `dynamictv` against `DynamicTV` would otherwise be a dead press that looks like a bug. If two groups in one file differ only in case, the exact match decides; a typed name that matches neither exactly nor uniquely is skipped and logged. A name the session does not list is skipped and logged as since #958, and the raw-number fallback stays only for a key whose `cameraGroupName` is empty and whose session info is unreadable.

The same lookup serves Cycle Camera's subset intersection, so a typed or stale-case name ticked in a grid behaves the same as on a Change Camera key.

### 3. The live list reaches the PI as a run-scoped global, `_cameraGroups`

The list is the session's group names, normalised, deduplicated, in the sim's order (`GroupNum`), published as a JSON array under `_cameraGroups` and enrolled in `RUN_SCOPED_SETTING_KEYS`, since it is an observation about this run and never a user choice (`global-settings.md`).

- **Producer:** a publisher in `@iracedeck/deck-iracing`, wired in `plugin-runtime`'s sim phase, reads `CameraInfo.Groups` on every session-info update and writes `_cameraGroups` only when the list differs from what it last wrote. That is its re-assertion within the run.
- **On disconnect it keeps the last list.** A user who leaves the sim and configures keys still sees the groups they just drove with. A fresh start of the plugin without iRacing has no list, and the picker then shows the standard groups, the stored names and **Other…**.

Rejected:
- The per-context pattern `_deviceProfiles` uses (`ev.action.setSettings` with the list in the key's own settings). Every Camera Controls key would be rewritten on every session change, each write echoing back through `onDidReceiveSettings`, and the list would be persisted into every key.
- Reading the list from the PI over `sendToPlugin`. That's a request/response the PI has to wait on, for data the plugin already has and every PI wants.

### 4. A picker component, not an `sdpi-select`

`ird-camera-group-select` (in `@iracedeck/pi-components`) replaces the Change Camera `sdpi-select`, because the choice now writes two settings, has a list that changes under the open PI, and needs a free-text path. `sdpi-select` binds one setting to static options. Its options, in order:

1. The 25 standard groups in today's `<optgroup>`s (Car, Chase, Track, Aerial).
2. **This track's camera file**, holding the `_cameraGroups` names that are not standard, in the sim's order. It is hidden when there are none.
3. The stored name, when it is in neither list, labelled `<name> (not in this session)`, so a key set up on another track never looks unset.
4. **Other…**, which reveals a text field (`sdpi-textfield`) for typing a name.

The component never writes on load or on a list change, only on the user's choice: never delete a user's choice because a list shrank. It re-renders on every `didReceiveGlobalSettings` push and reads nothing in response to a DOM event (the `ird-enable-feature` lesson in `stream-deck-actions.md`). The standard list stays a hand copy in the PI, held to `CHANGE_CAMERA_GROUPS` by the test #958 added.

### 5. Cycle grids: a custom section, unticked by default

Both grids (the per-key `cameraGroupSubset` and the dial's global `cameraGroupSubset`) gain a **This track's camera file** section after Aerial. It lists the `_cameraGroups` names that are not standard, plus every non-standard name the stored subset ticks, so a ticked custom group stays visible and can be unticked offline. New names enter the stored map only when the user ticks them: the grid's fill-in of missing names with the default (`state[name] = DEFAULT_ENABLED…`) applies to the standard 25 only. A custom group is never enabled by default, for #958's reason: it would change what a press does on a key nobody touched.

The subset's stored shape (a name → boolean map) already holds any name, so its schema does not change. `getNextSelectedGroupEntry` already skips a ticked name the session lacks.

### 6. One generic icon for every custom group

`CAMERA_SELECT_ICONS` has artwork for the 25 standard groups only. A custom group gets one new icon, `packages/icons/camera-select/custom.svg`, a generic camera-group graphic in the TV1–TV3 style. It must not read as any one standard group (`icons.md` distinctiveness), and Niklas approves it on a review page before it is committed. The key's default title is `CAMERA\n<NAME>`, upper-cased like the standard titles. Title Overrides still apply.

The same icon serves everywhere a group is drawn:
- **The Change Camera key.**
- **The Cycle Camera grid preview.**
- **The dial carousel**, which draws group names already.
- **A Cycle Camera key with Icon Shows = Current camera** (#959). There an unmapped current group used to fall back to the key's grid icon. It now shows the generic icon with the group's name, because that's what is on screen, the reason #959 gave for showing a group outside the subset.

Rejected: no artwork, title only (the key looks broken next to its neighbours), and drawing the name inside the artwork (unreadable at key size for names like `DynamicTV2`).

### 7. The session-info refresh is assumed, and checked first

The design assumes iRacing re-emits session info with the new `CameraInfo.Groups` when a camera file is loaded mid-session through the Camera Tool. Overlay tools pick up custom groups, which they can only do from the session info. The capture that confirms it is a Telemetry Control snapshot before and after loading a public custom camera package on one track, and it is the issue's first task, before any code. If the groups do not refresh until the session is re-joined, the design stands and the website page says so: names are still matched at press time, so a key works as soon as the list is current.

## Out of scope

- **A focus-only "bring iRacing to the front" key.** Group switching is an SDK broadcast and needs no focus. Effect hotkeys outside iRaceDeck can use Mouse to Sim (#926) today, and a focus-only mode is its own issue if it's wanted.
- **Cycle Driving Camera**, which hands `group ± 1` to the sim and names no group.
- **Sub-camera selection inside a custom group.** Cycle Sub-Camera already works on whatever group is active.
- **A template variable for the current group name** (for an on-screen category label). It's useful, but it's another surface (`iracing-sdk`'s template context) and another issue.
- **Per-track key layouts** (different groups on the same key by track). Using the same names across files is the user's tool for that.

## Testing

Unit:
- **Settings:** `cameraGroupName` parses empty, trimmed and junk values without resetting the key. A key with only `cameraGroup` resolves exactly as before.
- **Resolution:** the precedence of name over number; exact before case-insensitive matching; an ambiguous or absent name skipped and logged; `Pit Lane2` normalisation through both paths.
- **The publisher:** writes on a changed list only, normalises and deduplicates, keeps the list on disconnect, and `_cameraGroups` is stripped at every run-scoped boundary (`run-scoped-settings.test.ts`).
- **`ird-camera-group-select`:** the four option groups, no write on load or on a list push, both fields written for a standard name and only the name for a custom one, a stored name absent from every list shown and kept, and **Other…** writing the typed name.
- **Grids:** the custom section built from the list and the stored subset, unticked by default, and the standard fill-in not touching custom names.
- **Icons:** the generic icon and the upper-cased name title for a custom group on the key, in the grid preview, in `current` mode and on the dial.
- **Mock session:** the mock session in `iracing-native/src/mock-data/session-info.ts` gains a variant with custom group names, so the tests run against a file shaped like a broadcaster package.

Manual, with a public custom camera package loaded on its track:
- **The refresh capture in decision 7**, taken first.
- **Change Camera:** the picker lists the custom groups, and a key on one switches on the first press. The same key on a track whose file lacks the group does nothing and logs it, and its PI shows the name as not in this session.
- **Other…:** a typed name in another case works.
- **Cycle Camera:** ticked custom groups cycle on the keypad and the dial, and are skipped on a track without them.
- **Old keys:** a Change Camera key saved before the change behaves identically.
- **Downgrade:** on the previous release, standard-group keys set with the new picker still press their group.
- **All three plugins.** The PI is shared and no manifest changes, but each host renders the new component.
