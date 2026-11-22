> **Issue:** [#1769](https://github.com/niklam/iracedeck/issues/1769) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Camera Controls: each dial keeps its own camera-group selection

## Context

A Camera Controls key stores its Cycle Camera selection in its own action settings (`cameraGroupSubset`, since #208). The dial, added in #803, reads and edits the plugin-global `cameraGroupSubset` instead: `CameraControls` builds the dial surface with `getEnabledCameraGroups: () => getEnabledGroupNames(undefined)`, the dial's `cycle` and `changeCamera` delegates call `executeCycle` with no subset, and the dial grid in `camera-focus.ejs` saves through `useGlobalSettings("cameraGroupSubset")`. So every dial cycles the same set, and the dial's settings panel writes a global, which `settings-window.md` rule 1 has forbidden in an action PI since #1003.

Niklas decided on 2026-11-22: per dial, like the keys. A dial with nothing saved starts from the global selection, so no existing dial changes what it cycles.

This builds on #1653 ([spec](2026-11-08-issue-1653-custom-camera-groups.md), PR #1754), which gives both grids a Remembered groups section and the held-value / ready logic the keypad grid uses below. It is implemented after #1653 merges.

**Hosts.** The dial surface runs on the Stream Deck+ dial and, since #1013, on the Mirabox knob: the Mirabox manifest declares Camera Controls `["Keypad", "Knob"]`, and the PI's `irdResolveController()` maps `Knob` to the dial view. So this change reaches both plugins, not the Stream Deck one only as the issue says. Ulanzi declares no dial.

## Decisions

### 1. The setting: `dial.cameraGroupSubset`, the key's shape

The dial stores its selection at `dial.cameraGroupSubset`, a field of `DialSettings` in `camera-dial-surface.ts`. Its schema is declared once, in `camera-groups.ts` beside `CAMERA_GROUPS_SETTING_KEY` and `parseGroupSubset`, and used for both the key's top-level `cameraGroupSubset` field and `DialSettings.cameraGroupSubset`:

```typescript
export const CameraGroupSubsetField = z.union([z.string(), z.record(z.string(), z.unknown())]).optional().catch(undefined);
```

- **Same shape as the key's.** A name → boolean map under `groups`, stored as the JSON string the grid writes (`{"groups":{"Nose":true,…}}`), read by the same `parseGroupSubset`, so legacy spellings, custom names from #1653 and the "only `true` is on" rule all carry over with no new code.
- **Under the `dial` root.** Every dial setting lives there (#803), so the keypad's and the dial's keys cannot collide, and the dial surface keeps taking only the `dial` sub-object (`encoders-and-touchscreen.md`). The surface already has the subset in `ctx.dial`, so it needs no new lookup.
- **`.catch(undefined)` on the field.** `dial` is parsed with `DialSettings.catch(() => DialSettings.parse({}))`, so a value the union rejects would otherwise reset the whole dial, Mode included, to defaults. The key's field has the same gap today: a rejected value fails `CameraControlsSettings`, and `parseSettings` falls back to full defaults, `target` included. With the catch a bad value reads as "no selection" and falls back like a missing one (decision 2) on both surfaces, the same reasoning as `CameraGroupField`.
- **For the key, only the reading of a rejected value changes.** Nothing is written, the stored format is the same, and a downgrade reads exactly what it read before.

Rejected:
- **Reusing the top-level `cameraGroupSubset` on a dial context.** A context is a key or a dial, so the values would not collide in storage, but the PI has both grids on one page, each bound to its own hook. Two grids on one key name means the hidden keypad grid reads and reacts to the dial's value. It also breaks the `dial.` convention and makes the surface read outside its sub-object.
- **A new shape (a list of names).** It would need its own parser, PI code and #1653 handling, and #1753's component would have to bind two shapes.

### 2. The fallback: at read time, and on screen in the PI; never written on load

A dial with no valid `dial.cameraGroupSubset` cycles the global `cameraGroupSubset`, and with no global either, `DEFAULT_ENABLED_GROUPS`. That is exactly `getEnabledGroupNames(raw)` today, so the action passes the dial's stored value to it and nothing else changes in the read path.

The PI shows the same fallback and writes nothing until the user makes a choice. This is what the keypad grid does: on `master` it shows the global map for a key with none and saves only when a box is ticked or a button pressed; the first choice saves the whole shown map with the change, which is when the dial's own copy comes into being. #1653 fixed two pitfalls in the keypad grid that the dial must not lose:

- **Order.** The key's own value and the global arrive in any order, and sdpi replays no push to a late subscription. #1653's `takeKeypad` / `takeLegacy` read both the pushes and each hook's held value, a stored value beats a fallback, and a push beats a held value.
- **Choices on a provisional state.** Until the value that applies is known, the grid is disabled (`ready`), so a click cannot save a guess over the stored map.

The dial grid does not get a second copy of that state machine (`keypadResolved`, `legacyKnown`, `settleKeypad`, `takeLegacy`, `takeKeypad` on the #1653 branch). Instead that logic becomes one binder shared by both grids, `bindSubsetGrid(selector, ownSettingKey)`, which holds the per-grid flags, subscribes `useSettings(ownSettingKey)` together with that hook's held-value getter, and saves through that hook only. It is called once for `cameraGroupSubset` (the keypad grid) and once for `dial.cameraGroupSubset` (the dial grid). Both binders are fed the fallback from a single read-only `useGlobalSettings("cameraGroupSubset")` subscription, whose pushes and held value fan out to both. The page keeps no global setter, so no grid can write the global, by construction.

sdpi handles the dotted key on every path the binder uses, in `packages/pi-components/browser/sdpi-components.js`: the read walks the path (line 916), the subscription delivers the walked value (1500–1501), the getter returns it (1521), and a save creates the missing intermediate objects (1526–1528). `ird-color-picker` shows the subscription and save work for `dial.colors.*`, but it never uses the getter, hence the citation.

Rejected:
- **Writing the seed when the PI opens.** Opening a panel would change stored settings, and the write would race the held and pushed values the bullets above describe; a seed written from a not-yet-known global is the bug #1653's review found. It also gains nothing: the read-time fallback already gives the same set.
- **Copying the global into each dial from the plugin, at `willAppear` or as a one-shot migration.** The plugin can only reach dials that are on screen, so dials on other pages and profiles would be missed and still need the fallback. A plugin-side `setSettings` is not echoed back, so the context would have to be kept authoritative (`encoders-and-touchscreen.md` rule 10). And it rewrites the settings of users who never touched the grid, for no change in what they get.

### 3. The global `cameraGroupSubset`: kept, read only, edited nowhere

After this change no control writes the global. It stays in `global-settings.json` as the seed for every key and dial that has not saved its own selection, read by `getEnabledGroupNames` and by both grids' fallback.

- **Not removed.** `global-settings.md`'s retired-key cleanup (#1599) is for a key nothing reads. This one is still read: deleting it would move every unsaved key and dial to `DEFAULT_ENABLED_GROUPS`, the opposite of Niklas's decision. It is a passthrough key (not in `GlobalSettingsSchema`), so the store never validates or drops it.
- **Not moved to the settings window.** Rule 1 sends a global control to the window, but a window editor would keep a shared camera set alive as a third concept beside per-key and per-dial. The value only has to survive as a seed.
- **Downgrade.** An older build ignores `dial.cameraGroupSubset` and reads the global again, which this build never changed, so a downgraded dial cycles the set it had before the upgrade. The stored per-dial value is kept (sdpi saves the whole settings object, and the plugin writes a dial's settings only as the raw stored object plus `addedWithVersion`, `base-action.ts` lines 370–374), so a re-upgrade finds it.

### 4. The dial reads its own selection: carousel, rotation and redraw

The host interface takes the subset from the surface rather than reading a global:

- `getEnabledCameraGroups(subset)` — the surface passes `ctx.dial.cameraGroupSubset`; the action resolves it with `getEnabledGroupNames(subset)`.
- `cycle(target, direction, contextId, subset)` and `changeCamera(contextId, subset)` — the action passes the subset on to `executeCycle`, which already takes one for keys (and, after #1653, checks it against the session before sending).

The carousel and the rotation read the same value from the same context, so the preview still matches the detent.

**Redraw.** A grid edit is a per-action save, so it arrives as `onDidReceiveSettings` for that dial alone. `CameraDialSurface.didReceiveSettings` already refreshes `ctx.dial`, clears `lastRenderSig` and re-renders, so the carousel follows with no new code, including with iRacing offline. The `onGlobalSettingsChange(() => this.dialSurface.refreshAll())` subscription stays: it is there for the dash-box colours (#811), and it still covers a hand-edited global for dials on the fallback. Its comment and the host's doc comment stop calling it the subset path.

### 5. The Change Camera gesture uses the dial's selection, and the grid shows for it

Press, Long Press, Tap Display and Long Touch can each be set to Change Camera, which steps to the next group of the dial's selection. Today the grid shows only in Cycle Camera mode, so a car-number dial with a Change Camera press steps through a set its panel never shows. Once the set is the dial's own, that is a stored setting the user cannot see. The grid's section therefore shows when Mode is Cycle Camera **or** any gesture slot is Change Camera, and its supporting text says it applies to both. The visibility code watches the gesture selects that the page has (the extended slots are not rendered on Mirabox).

Rejected: keeping the grid to Cycle Camera mode. The gesture would then follow a selection that can only be changed by switching Mode to Cycle Camera and back.

### 6. Remembered groups on the dial grid

#1653's Remembered groups section stays as it is and binds to the dial's own map: the custom groups this track has first, the rest dimmed, a custom name stored only while ticked, Select All ticking this track's custom groups, Clear unticking all. A dial on the fallback shows the global map's custom ticks, and the first choice copies them into the dial with the rest.

### 7. Order with #1753: this goes first

#1753 ([spec](2026-11-22-issue-1753-camera-group-filter.md)) turns both grids into one `ird-*` component that "binds the subset setting as the inline script does". Today that is two bindings: per-action with a global fallback (keypad) and global read-write (dial). After #1769 it is one: a per-action setting with the global as read-only fallback, used twice (`cameraGroupSubset` and `dial.cameraGroupSubset`). Landing #1769 first means the component is built for the one binding and never carries a global-write mode only to delete it. #1769 is also the smaller change, and both edit the same script in `camera-focus.ejs`, so doing them in sequence avoids a conflict. #1753's spec, unshipped, is amended on `master` when #1769 merges: the component moves the binder (`bindSubsetGrid`, decision 2) into itself, and "the dial's global set" goes.

## What changes

- `camera-groups.ts`: `CameraGroupSubsetField` (decision 1).
- `camera-dial-surface.ts`: `DialSettings.cameraGroupSubset`; the host signatures in decision 4; the carousel and gesture dispatch pass `ctx.dial.cameraGroupSubset`.
- `camera-controls.ts`: the key's `cameraGroupSubset` field uses `CameraGroupSubsetField`; the host wiring passes the subset to `getEnabledGroupNames` and `executeCycle`; comments that say the dial uses the global set.
- `camera-focus.ejs`: `bindSubsetGrid` replacing the keypad's state machine and the dial's global binding, with one read-only global subscription (decision 2); the dial grid's visibility (decision 5), its supporting text and the comment above it; the keypad grid's comment that names the dial's set.
- Website: the Camera Controls page, its dial section's **Camera Groups (Cycle Camera)** and Cycle Camera mode entries, and the keypad paragraph that says unsaved keys follow "the one the dial's Cycle Camera mode uses". A changelog fragment (`Improvements`).
- Rules: none name the dial's global grid today (`settings-window.md`, `stream-deck-actions.md` and `encoders-and-touchscreen.md` checked on 2026-11-22), so none change unless the implementation finds one.

## Out of scope

- **A settings-window editor for the global set**, or any "default camera set for new keys and dials" (decision 3).
- **Removing the global `cameraGroupSubset`** or migrating it into keys or dials (decisions 2 and 3).
- **The grid component and filter**, which are #1753.
- **Ulanzi**, which declares no Camera Controls dial.

## Testing

Unit (`iracing-actions`):
- **Schema:** `dial.cameraGroupSubset` parses a JSON string and an object; a number or boolean reads as `undefined`, and an array or a map without `groups` falls back like a missing value, each leaving `dial.mode` and the other dial fields as stored. A key whose `cameraGroupSubset` is a number keeps its `target`.
- **Fallback:** a dial with no subset cycles the global set, and with no global the defaults; a dial with its own subset ignores the global, including after a global change.
- **Two dials:** two contexts with different subsets each rotate to their own next group and draw their own carousel neighbours.
- **Change Camera gesture:** steps within the dial's own subset.
- **Redraw:** a `didReceiveSettings` carrying a new subset re-renders that dial's carousel with iRacing offline, and no other dial's.
- **Preview matches execution:** the carousel's clockwise neighbour is the group the clockwise detent sends, for a dial with its own subset.

Unit (`camera-focus-pi.test.ts`, the #1653 harness):
- The dial grid binds `dial.cameraGroupSubset` and the keypad grid `cameraGroupSubset`, each through `bindSubsetGrid`; the page subscribes the global once, read only, and no save reaches it.
- A global push or held value reaches both grids' fallback.
- With no own value it shows the global map, custom ticks included, and saves nothing until a choice; the first choice saves the shown map with the change into `dial.cameraGroupSubset`.
- The ordering cases #1653 covers for the keypad (held vs pushed, own vs fallback, the grid disabled until known) pass for the dial grid.
- The section shows for Cycle Camera mode and for a Change Camera gesture in any mode, and hides otherwise.

Manual (Stream Deck+ and a Mirabox knob):
1. **Upgrade:** with a global selection saved by the previous release, an untouched dial cycles the same groups and its grid shows them.
2. **Own selection:** change one dial's grid; it cycles the new set, the carousel follows at once (also with iRacing closed), and a second dial keeps the old set.
3. **Two dials, two sets** side by side in a session.
4. **Keys unaffected:** a key that never saved a selection still cycles the global set after a dial's grid is edited.
5. **Change Camera gesture** on a car-number dial: the grid shows, and the press steps within it.
6. **Remembered groups:** tick a custom group on one dial only; it cycles there and not on the other.
7. **Downgrade** to the previous release: the dial cycles the global set again; re-upgrading restores its own.
