> **Issue:** [#958](https://github.com/niklam/iracedeck/issues/958) · also [#959](https://github.com/niklam/iracedeck/issues/959) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Camera Controls: the two missing TV groups, and a Cycle Camera key that shows the current camera

## The problem

Two Discord requests from Moartl31, filed as #958 and #959, land on the same three files: `camera-controls/camera-groups.ts`, `camera-controls/camera-controls.ts`, and the action's Property Inspector, which is `camera-focus/camera-focus.ejs` (the action's UUID is `com.iracedeck.sd.core.camera-focus`; Camera Controls is its display name).

**#958** — Camera Controls knows exactly twenty camera groups. `DEFAULT_CAMERA_GROUPS`, `CAMERA_SELECT_ICONS`, `CAMERA_GROUP_MAP` and the PI's duplicated `ALL_GROUPS` all stop at the same twenty, so iRacing's newer broadcast groups cannot be picked in Change Camera, cannot be enabled in the Cycle Camera subset on either surface, and have no icon — even though the SDK path would drive them fine.

**#959** — a Cycle Camera key shows the group the *next* press will select (`updateCycleIcon` walks the enabled subset forward from `CamGroupNumber`). Moartl31 wants the other reading: the group the sim is on now, the way a pit-stop adjustment key shows its current value. The website page already claims the icon shows the current group, so it describes neither today's code nor the requested option.

## What ships

The two new groups are appended to every list with their own icons, **off by default** in the cycle subset. Cycle Camera keys gain a per-key **Icon Shows** setting, `Next camera` (default, today's behaviour) or `Current camera`. Nothing changes on the dial.

## Decisions

### 1. One branch, one PR, #958 first

Both issues edit the same icon map, the same `updateCycleIcon` neighbourhood and the same PI script block; split across two branches they conflict on every one. #958 lands first because it grows the icon map `current` mode reads, so `current` is written and tested once against the final list. One PR titled for #958, `Fixes #958` and `Fixes #959`. Rejected: a PR each, which buys nothing but conflicts and a second review of the same diff.

### 2. The exact group names come from a live session, before anything is written

The names in the request and in the issue sketch — "TV Static", "TV Mixed" — are **unverified**. Nothing in the repo lists them: the mock in `packages/iracing-native/src/mock-data/session-info.ts` is truncated to ten groups, and a repo-wide search finds neither string. The whole feature resolves by exact `GroupName` match, so a wrong capitalisation or a missing space is a silently dead menu entry.

So task one is a capture: take a session snapshot with the Telemetry Control **Take Snapshot** key on content that has the groups, read `SessionInfo.CameraInfo.Groups`, and write the strings from that. The capture also answers the second question — whether iRacing exposes further groups we still do not list — which the issue only guesses at. Rejected: coding to the sketch and fixing it after a bug report; a name we cannot test locally is exactly the thing to confirm before, not after.

### 3. Appended at 21 and 22 — the numbers are ours, the names are iRacing's

`CAMERA_GROUP_MAP`'s keys are a plugin-side enumeration (the PI dropdown's stored value), not iRacing's group numbers: our 10 is Blimp, the mock session's 6 is Cockpit. `executeChangeCamera` resolves the map's **name** against the live session's groups, and the numbers only order the dropdown. Appending at 21 and 22 therefore leaves every stored value meaning what it meant. Rejected: renumbering into the sim's order or inserting the new groups next to TV1–TV3, both of which would silently repoint every existing Change Camera key.

The PI's `ALL_GROUPS` order is its own display order, so the two new entries join the **Track** section there and `GROUP_SECTIONS` becomes Car 0–9, Chase 9–12, Track 12–20, Aerial 20–22.

### 4. Off by default in the cycle subset

`DEFAULT_ENABLED_GROUPS` is untouched, so no existing cycle gains two stops, and a key that has never been configured keeps the same six. Rejected: enabling them by default, and a one-shot migration that adds them to saved subsets — both change what a press does on a key the user never touched, for a group most content does not have.

### 5. The schema bound follows the map, and `cameraGroup` gains its own `.catch`

`cameraGroup`'s `.max(20)` is derived from `CAMERA_GROUP_MAP` rather than bumped to a fresh literal, so the next group added cannot be rejected by a bound nobody remembered. It also gains `.catch(9)`: `parseSettings` uses `safeParse` and falls back to **full defaults** on any failure, so a key holding `21` read by an older build would today lose its mode, direction and subset as well — the same downgrade trap the `dial` sub-object already carries a `.catch` for. Rejected: the bare `.max(22)` from the sketch, which leaves that trap armed.

### 6. A group the session does not have: skip, don't send our index

`executeChangeCamera` falls back to the raw stored number when the name is not in the session's groups (`?? cameraGroup`). With session groups known, that number is ours, not iRacing's, so it selects the wrong camera or nothing — harmless-looking until TV Static on old content becomes the common case. When the session's groups are readable and the target name is absent, the press now sends nothing and logs it; the raw-number path stays only for when no session info is readable at all. One rule for every group, no special case for the new two. Rejected: leaving the fallback, which spends a press on a wrong camera.

Cycle Camera needs no equivalent: `getNextSelectedGroupEntry` intersects the enabled subset with the session's groups, so an absent group is already skipped.

### 7. The duplicated PI list gets a test

`ALL_GROUPS` and `GROUP_SECTIONS` are hand-copies of `DEFAULT_CAMERA_GROUPS` (the PI runs in a browser context and cannot import action code), and nothing guards the copy — a stale copy fails as a missing checkbox, not as a red test, and this issue is the first time the section ranges shift. A test reads the `.ejs` and asserts the PI's set equals `DEFAULT_CAMERA_GROUPS` and that the sections cover it exactly. Rejected: generating the list into the template, a larger change to the compile step than the drift is worth.

### 8. `cycleIconMode`, per key, keypad only

`cycleIconMode: z.enum(["next", "current"]).default("next")`, surfaced as **Icon Shows** beside the Camera Groups grid and revealed by the existing visibility script for the `cycle-camera` target only. Per key, because two Cycle Camera keys on one deck legitimately want different readings. An older build ignores an unknown settings key, so the field is downgrade-safe on its own. Rejected: a global setting, and a third "name only" value nobody asked for.

In `current` mode `updateCycleIcon` renders the group from `CamGroupNumber` resolved through the session's groups — **even when it is outside the key's enabled subset**, because that is still what the sim is on. The dedupe map keys on the displayed group name either way, and `onDidReceiveSettings` already clears it, so flipping the setting re-renders at once.

### 9. The fallback, and the dial

An unmapped active group falls back to the generic cycle-camera icon, exactly as `generateCameraSelectSvg` does today — with the key's own direction and appearance overrides passed in rather than the hard-coded `next` and none it uses now, a two-line fix in the shared helper that `current` mode would otherwise hit far more often. No telemetry still means the grid icon, unchanged. Rejected: falling back to the *next* group in `current` mode, which shows a lie rather than a placeholder.

The dial is untouched: `computeCameraCarousel` already centres the current group with the neighbours at the sides, so a mode switch there would only take the neighbours away. Rotation stays clockwise = next — camera is a list rotation, not number-primary (`encoders-and-touchscreen.md`).

## Verification

The group-name capture comes first and its strings are what the map is written from. Unit tests: the two names present in `DEFAULT_CAMERA_GROUPS`, `CAMERA_SELECT_ICONS` and `CAMERA_GROUP_MAP` and absent from `DEFAULT_ENABLED_GROUPS`; the derived schema bound accepts 21/22 while a junk value degrades to 9 without resetting the key; the missing-name skip; the PI-list consistency test; `updateCycleIcon` in both modes, including a current group outside the enabled subset, an unmapped group, and no telemetry.

Manual, on content that has the groups: Change Camera to each new group switches, and the same key on content without them does nothing and says so; both new groups appear unchecked in the keypad and dial grids and cycle once enabled; `Next camera` behaves exactly as before; `Current camera` tracks the sim's group, including when the camera is moved by another key; the dial carousel is unchanged.

## Affected artifacts

- `camera-controls/camera-groups.ts` (`DEFAULT_CAMERA_GROUPS`), `camera-controls/camera-controls.ts` (both icon maps, the schema, `executeChangeCamera`, `updateCycleIcon`, `generateCameraSelectSvg`), and their tests.
- `camera-focus/camera-focus.ejs`: the Track `<optgroup>`, `ALL_GROUPS`, `GROUP_SECTIONS`, the Icon Shows select and its visibility branch; the new PI-list test.
- `packages/icons/camera-select/tv-static.svg` and `tv-mixed.svg` in the TV1–TV3 style, then `node scripts/generate-icon-previews.mjs` and `node scripts/generate-icon-defaults.mjs`.
- Website `docs/actions/view-camera/camera-focus.md`: the group count in Change Camera, the new setting, and the Telemetry-aware line that describes today's behaviour wrongly; `changelog.mdx` (two bullets — two user-visible changes) plus `pnpm generate:changelog-data`.
- `.claude/skills/iracedeck-actions/SKILL.md` and `docs/reference/actions.json` — both describe Camera Controls' settings in prose; neither enumerates the groups, so only the new setting lands there.
