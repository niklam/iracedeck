> **Issue:** [#1653](https://github.com/niklam/iracedeck/issues/1653) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Camera Controls: any camera group the loaded camera file defines, remembered across tracks

## The problem

Camera Controls (UUID `com.iracedeck.sd.core.camera-focus`, PI `camera-focus/camera-focus.ejs`) offers 25 camera group names, all of them our own list: `CHANGE_CAMERA_GROUPS` / `DEFAULT_CAMERA_GROUPS` in `camera-controls/camera-groups.ts`, copied into the PI's Change Camera `<optgroup>`s and its `ALL_GROUPS` grid. A track camera file can define any groups under any names, and broadcaster packages ship 20–30 of them (`DynamicTV`, `Grid_Pole`, `Start`, `SpeedCam`, …). Names also vary between files: one track has `Drone` where another has `Dynamic TV`. None of them can be put on a key.

The press path does not stand in the way. Since #958 Change Camera resolves its group by **name** against the session's `CameraInfo.Groups` and sends the sim's own number for it, and Cycle Camera intersects its enabled names with that same list. What is closed is the set of names a user can store. Change Camera stores an index into our map (`cameraGroup`, 1–25), and the PI grid lists only our 25.

The session alone is also not enough to choose from. A broadcaster sets up a deck between events, without the track loaded, so the picker has to know about cameras seen on earlier sessions too.

## What ships

- **A camera catalog file,** `cameras.json`, beside the settings file. It records every camera group name the plugin has seen, and for each track its latest group list.
- **Change Camera** can target any group name. It stores the name in a new `cameraGroupName` setting; existing keys, which store only `cameraGroup`, keep working unchanged.
- **The catalog reaches the Property Inspectors** together with which groups the current session has, as one run-scoped global, `_cameraCatalog`.
- **A new `ird-camera-group-select` picker** shows the groups of this track first, then every other remembered group marked as not on this track, the key's stored name even when the catalog lacks it, and an **Other…** entry for typing a name.
- **The Cycle Camera grids** (the keypad's per-key subset and the dial's global one) gain a section of remembered custom groups.
- **A key whose group the current session lacks** keeps its name and icon, drawn with the shared "can't act right now" look. A press does nothing and logs it.
- **Custom groups share one new generic icon,** with the group's name as the title.
- **The settings window** gets a card listing the catalog, where a remembered group can be removed.

## Decisions

### 1. Every name is its own entry: remembered, never merged

A name is a group. `Drone` and `Dynamic TV` stay two entries even when a user means them as the same shot on different tracks, and a key on `Drone` does nothing at a track whose file has only `Dynamic TV`. The user puts the two on two keys, or uses the same name in both files.

Rejected: aliases that merge names into one entry a key points at. A key would then hang on catalog state rather than on what it says, removing an entry would break keys, and a merge shows its effect only at press time on another track. The maintainer chose separate entries (2026-11-08).

### 2. The catalog is its own file, `cameras.json`

**Where:** `cameras.json` sits in the folder `resolveSettingsStorePath()` picks, `%LOCALAPPDATA%\iRaceDeck\Settings\<ecosystem>\`, overridden along with it when `IRACEDECK_SETTINGS_PATH` points elsewhere (same directory, fixed name). Like the settings, it is per ecosystem and outside every host's plugin folder, so it survives reinstalls.

**Shape** (versioned, so a later change can migrate it):

```json
{
  "version": 1,
  "tracks": {
    "<TrackID>": { "name": "<TrackDisplayName>", "config": "<TrackConfigName>", "groups": ["Nose", "TV1", "DynamicTV"], "lastSeen": "<iso>" }
  },
  "groups": {
    "DynamicTV": { "firstSeen": "<iso>", "lastSeen": "<iso>" }
  }
}
```

- **`tracks`** is keyed by `WeekendInfo.TrackID`, which is per layout. Each entry holds the **latest** list seen for that track, replaced on every observation, so a group dropped from a camera file stops being reported as on that track.
- **`groups`** is the union of every name ever seen, standard ones included. It only grows, and an entry leaves only when the user removes it (decision 7). A name in `groups` that no track's latest list holds is still offered, as "seen before".
- **Names** are normalised with `normalizeGroupName` before they are recorded, so `Pit Lane2` and `Pit Lane 2` are one entry.

**Why a file of its own, not a key in `global-settings.json`:**
- **It's an observation, not a choice.** It can reach hundreds of entries, and it would ride in every host mirror and settings push.
- **It has its own lifecycle.** It is never migrated from the deck host, and the user can delete it alone to start over.

**Writes** reuse `createFileSettingsStore` from `@iracedeck/settings` unchanged:
- **Write discipline:** atomic temp-and-rename, a debounced save, retried failed writes, the synchronous exit flush, and a byte-order mark tolerated on read.
- **An unparseable file** is moved aside as `cameras.corrupt-<iso>.json` (the store derives the name from the path). It raises a `camera-catalog-rejected` warning banner through `onRejected`, and the catalog starts empty.
- **An unreadable file** (any error but a missing file, after the store's retries) leaves the catalog **in memory only** for the run and never saves: writing over a file we failed to read would destroy it. That's the settings store's fail-closed rule.

The catalog has no host migration, so none of `global-settings.ts`'s load machinery applies. A missing file means an empty catalog.

Rejected:
- **A key in the global settings,** for the reasons above.
- **Run-scoped only** (the first draft of this spec): it forgot every custom group at each plugin restart, which defeats setting up a deck away from the track.

### 3. Who records, and where the code lives

The catalog is iRacing-shaped (`TrackID`, `CameraInfo`), so it lives in `@iracedeck/deck-iracing`:
- **The model:** a pure function `recordCameraGroups(catalog, observation, now)`, plus the reader the press path and the publisher share.
- **The recorder:** it observes on every session-info update that carries `CameraInfo.Groups` and a `TrackID`, and saves only when the catalog changed.
- **Wiring:** `plugin-runtime`'s sim phase creates the store and the recorder.

`deck-core` stays sim-neutral, and no new dependency edge appears: `deck-iracing` already depends on `@iracedeck/settings`. Replays record too, under the replay's track: a replay of a session at another track is a real observation of that track's file.

### 4. The PI sees the catalog through one run-scoped global, `_cameraCatalog`

The plugin publishes `_cameraCatalog` and enrols it in `RUN_SCOPED_SETTING_KEYS`. The value lives in `cameras.json`; this global is only how a Property Inspector sees it, and it never reaches `global-settings.json` or the host mirror's file copy. It's compact: `tracks` as `[{ id, name, config }]`, `groups` as `[{ name, tracks: [<index into tracks>] }]` (the tracks whose latest list holds it), and `current`, the current session's `TrackID` and its group list, or `null` with no session.

It's re-published:
- **once the catalog loads,**
- **whenever the catalog changes,**
- **whenever the current session's track or group list changes,**
- **with `current: null` on disconnect.**

That is its re-assertion within the run (`global-settings.md`).

Rejected:
- **The per-context `_deviceProfiles` pattern** (the list written into each key's own settings): every Camera Controls key rewritten and echoed on every session change, and the catalog persisted into every key.
- **A `sendToPlugin` request and response:** an extra round trip, a Ulanzi normaliser marker, and per-action routing for data every Camera Controls PI wants.

### 5. Store the name beside the number, and keep reading the number

`cameraGroupName: z.string().trim().default("").catch("")` is added beside `cameraGroup`. A non-empty name wins. An empty one means "read `cameraGroup` through `CHANGE_CAMERA_GROUPS`", which is every key saved before this change. Nothing is migrated or rewritten: opening an old key's PI shows its group from the number and writes nothing until the user changes it.

The picker writes both fields: the name always, and `cameraGroup` as well when the name is one of the 25 standard groups. An older build ignores the unknown `cameraGroupName` key and reads the number, so a downgrade keeps every standard choice. A custom name leaves `cameraGroup` at its last value, and an older build then presses that group. That is accepted: no number can mean a group the older build has never heard of, and a sentinel number would make it press a camera the user never chose rather than one they once did.

Rejected:
- **Replacing `cameraGroup` with a name and migrating stored values.** That rewrites every Change Camera key for a change that only needs to add, and a downgrade would then reset every standard key to Cockpit instead of only the custom ones.
- **Widening `cameraGroup` to `number | string`.**

### 6. Name matching: normalised, exact first, then case-insensitive

A stored name is matched against the session's groups after `normalizeGroupName`: exactly first, then case-insensitively. The case-insensitive pass is for a typed name, where `dynamictv` against `DynamicTV` would otherwise be a dead press that looks like a bug. If two groups in one file differ only in case, the exact match decides. A name that matches neither exactly nor uniquely is skipped and logged.

A name the session does not list is skipped and logged, as since #958. The raw-number fallback stays only for a key whose `cameraGroupName` is empty and whose session info is unreadable. Cycle Camera's subset intersection uses the same lookup.

### 7. The picker, the grids and the catalog card

**`ird-camera-group-select`** (in `@iracedeck/pi-components`) replaces the Change Camera `sdpi-select`, which binds one setting to static options. The choice now writes two settings, its list changes under an open PI, and it needs a free-text path. Its options, in order:

1. **On this track:** the current session's groups in the sim's order, standard and custom alike. It is hidden with no session.
2. **Standard groups** not in the first section, in today's Car / Chase / Track / Aerial `<optgroup>`s, marked `(not on this track)` while a session is loaded.
3. **Other remembered groups:** every catalog name not shown above, labelled with up to three tracks whose latest list holds it, `Drone (not on this track: Spa, Monza +2)`, or `(seen before)` when none does.
4. **The stored name,** when it is in none of the above, as `<name> (not on this track)`, so a key never looks unset.
5. **Other…,** which reveals an `sdpi-textfield` for typing a name.

The component writes only on the user's choice, never on load or on a catalog push. It re-renders on every `didReceiveGlobalSettings` push and reads nothing in response to a DOM event (the `ird-enable-feature` lesson in `stream-deck-actions.md`). The standard list stays a hand copy in the PI, held to `CHANGE_CAMERA_GROUPS` by the test #958 added.

**The Cycle Camera grids** (the per-key `cameraGroupSubset` and the dial's global one) gain a **Remembered groups** section after Aerial. It lists every non-standard catalog name, plus every non-standard name the stored subset ticks. Names not in the current session are dimmed. A new name enters the stored map only when ticked: the grid's fill-in with defaults applies to the standard 25 only, and a custom group is never enabled by default (#958's reason). The subset's stored shape, a name → boolean map, already holds any name, so its schema does not change.

**The settings window** gets a **Camera groups** card listing the catalog: each name with the tracks that currently have it and when it was last seen, and a Remove button per name. Remove sends `sendToPlugin {event: "cameraCatalogRemove", name}`. The command handler checks the name against the catalog and never takes a path. Removing a name drops it from `groups` only. A track's latest list still holds it until that track is seen again, so it reappears if the file still has it. That is the honest result: it is still in that file. Removing never touches a key's stored settings.

### 8. Keys on missing groups stay buttons

A Change Camera key, or a Cycle Camera key with Icon Shows = Current camera, is drawn with `shared/unavailable-look.ts`' `unavailableLook` when:
- a session is loaded,
- the key's group is not in the session's list, and
- the key has a name to check (for Cycle Camera: no enabled group is in the session).

That's the look Replay Markers and Replay Control already use for "this press would do nothing now". The key keeps its icon and title, and redraws when the session's groups change. With no session it draws normally, since no session means no camera to press anyway, and the PI's connection state covers that.

### 9. One generic icon for every custom group

`CAMERA_SELECT_ICONS` has artwork for the 25 standard groups only. A custom group gets one new icon, `packages/icons/camera-select/custom.svg`: a generic camera-group graphic in the TV1–TV3 style that does not read as any one standard group (`icons.md` distinctiveness). Niklas approves it on a review page before it is committed. The key's default title is `CAMERA\n<NAME>`, upper-cased like the standard titles; Title Overrides still apply.

The same icon serves the Change Camera key, the Cycle Camera grid preview, the dial carousel, and a Cycle Camera key showing the current group. In that last case, where an unmapped current group used to fall back to the grid icon (#959), it now shows the generic icon with the group's name, because that's what is on screen.

Rejected: a title with no artwork (the key looks broken next to its neighbours), and the name drawn inside the artwork (unreadable at key size for names like `DynamicTV2`).

### 10. The session-info refresh is assumed, and checked first

The design assumes iRacing re-emits session info with the new `CameraInfo.Groups` when a camera file is loaded mid-session through the Camera Tool. Overlay tools pick up custom groups, which they can only do from the session info. The capture that confirms it is a Telemetry Control snapshot before and after loading a public custom camera package on one track, and it is the issue's first task, before any code. If the groups refresh only when the session is re-joined, the design stands: names are matched at press time and recorded on the next observation, and the website page says so.

## Out of scope

- **Merging or renaming groups** (decision 1). Per-key Title Text changes what a key shows.
- **A focus-only "bring iRacing to the front" key.** Group switching is an SDK broadcast and needs no focus. Effect hotkeys outside iRaceDeck can use Mouse to Sim (#926) today, and a focus-only mode is its own issue if wanted.
- **Cycle Driving Camera,** which hands `group ± 1` to the sim and names no group.
- **Sub-camera selection inside a custom group.** Cycle Sub-Camera already works on whatever group is active.
- **A template variable for the current group name** (an on-screen category label). That's another surface and another issue.
- **Importing a catalog from camera files on disk.** The catalog learns from sessions only, so a file never loaded is not known until it is. Reading `.cam` files would mean parsing a binary format we do not own.
- **Sharing one catalog between ecosystems.** It follows the settings file's per-ecosystem rule.

## Testing

Unit:
- **Settings:** `cameraGroupName` parses empty, trimmed and junk values without resetting the key. A key with only `cameraGroup` resolves exactly as before.
- **Resolution:** a name taking precedence over the number; exact matching before case-insensitive; an ambiguous or absent name skipped and logged; `Pit Lane2` normalisation on every path.
- **`recordCameraGroups`:**
  - a new track, and a track's list replaced by a later one;
  - a dropped group kept in `groups` but gone from that track;
  - a replay recorded under its own track;
  - no change producing no save;
  - normalised names.
- **The catalog file:**
  - load, save and the exit flush, over a temp directory;
  - an unparseable file moved aside with the banner raised;
  - an unreadable file never saved over;
  - a missing file read as an empty catalog;
  - a `version` this build does not know treated as unparseable, and so preserved.
- **`_cameraCatalog`:**
  - published at each trigger in decision 4 and nowhere else;
  - stripped at every run-scoped boundary (`run-scoped-settings.test.ts`);
  - a 300-track, 2,000-name catalog checked for its published size.
- **`ird-camera-group-select`:**
  - the five option groups with and without a session, and the track labels;
  - no write on load or on a push;
  - both fields written for a standard name and only the name for a custom one;
  - a stored name absent from everything shown and kept;
  - **Other…** writing the typed name.
- **Grids:** the remembered section built from the catalog and the stored subset, dimmed names, unticked by default, and the standard fill-in not touching custom names.
- **The catalog card and command:**
  - removal by a known name only;
  - a removed name's return on the next observation of a file that has it;
  - no key settings touched.
- **Key looks:**
  - the unavailable look under each condition in decision 8;
  - the generic icon with the upper-cased name on the key, in the grid preview, in `current` mode and on the dial.
- **Mock session:** the mock session in `iracing-native/src/mock-data/session-info.ts` gains a variant with custom group names, so the tests run against a file shaped like a broadcaster package.

Manual, with a public custom camera package:
1. **The refresh capture** in decision 10, first.
2. **Recording:** load the package's track and see its groups appear in the picker under On this track, and in the settings window's card.
3. **Away from the track:** load another track. The first track's custom groups appear as not on this track, with its name. A key on one is drawn unavailable, and a press does nothing and logs it.
4. **Offline setup:** restart the plugin with iRacing closed. The remembered groups are still offered, and a key set up there works on the first press once the track is loaded.
5. **Other…:** a typed name in another case works.
6. **Cycle Camera:** ticked custom groups cycle on the keypad and the dial, and are skipped on a track without them.
7. **Remove:** removing a group in the settings window drops it from the picker. It comes back when its track is loaded again, and the key that used it keeps its name throughout.
8. **Old keys:** a Change Camera key saved before the change behaves identically.
9. **Downgrade:** on the previous release, standard-group keys set with the new picker still press their group.
10. **A corrupt `cameras.json`** is set aside with the banner, and the catalog rebuilds from the next session.
11. **All three plugins.** The PI is shared and no manifest changes, but each host renders the new component.
