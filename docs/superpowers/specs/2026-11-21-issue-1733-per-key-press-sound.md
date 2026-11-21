# Per-key press sound

> **Issue:** [#1733](https://github.com/niklam/iracedeck/issues/1733) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

- **The setting.** One per-key action setting, `pressSoundOverride`, with the stored values `default` and `off`, shown as a **Press sound** dropdown (**Default** / **Off**) on every action Property Inspector in all three plugins. It is a `CommonSettings` field, so every action schema carries it.
- **Three states, two stored values.** Absent means "this key's own default"; `default` means "follow the global Press sound"; `off` means silent. The key's own default is **Off** for Splits & Reference's **Set Active Reset Point** and **Reset to Start Point** and Car Control's **Starter**, and **Default** for every other key, every dial and every touch.
- **The default follows the mode; a choice does not.** While the key has no stored value, its default is re-read from its current mode at every press, so a key switched to Starter goes quiet and one switched away bleeps again. Once the driver picks either option, that value is stored and survives every later mode change, like every other per-key override.
- **Where it is read.** In deck-core's `withPressSounds`, once at down (and at a touch), right after the existing gate: `off` makes the press silent exactly as a `{ kind: "none" }` shape does, without calling the action's shape member; absent asks a new optional handler member, `keyPressSoundDefault(ev)`, on the key path only. The shape still decides what plays; the override only ever removes sound.
- **Dials and touches.** The setting covers dial presses and touch-strip taps of that instance too. A dial or touch has no mode default: absent is Default there, Splits & Reference's dial gestures included.
- **The dial turn tick is independent.** Off silences presses only. A dial's #1731 turn tick stays governed by the global **Dial turn tick** checkbox alone, as #1731 decided ("the two settings never gate each other").
- **The PI field.** A new partial, `press-sound-override.ejs`, rendered by `action-settings-footer.ejs` just above the **iRaceDeck Settings** button, so it reaches every action PI with no template edit and inherits the footer's tested placement outside every surface wrapper. The mode-dependent default is displayed, never stored, through the select's render-only `default` attribute.
- **No migration.** Existing Active Reset and Starter keys go quiet on upgrade with nothing written; every other existing key is unchanged.

## The setting and its schema

**Key `pressSoundOverride`, values `default` and `off`, no stored default.** The key name and values are persisted, so they go in `@iracedeck/app-constants`' `press-sound.ts` beside the global ones and are pinned in `persisted-values.test.ts`:

```typescript
/** The per-key action-setting key that overrides the global press sound (#1733). */
export const PRESS_SOUND_OVERRIDE_KEY = "pressSoundOverride";

/** The stored values, in the order the Property Inspector lists them. */
export const PRESS_SOUND_OVERRIDES = ["default", "off"] as const;

export type PressSoundOverride = (typeof PRESS_SOUND_OVERRIDES)[number];
```

**Not `pressSound`.** The global key is `pressSound`, and the wrapper reads both in the same function. Two stores holding the same key name with different value sets (`none`/`taps`/`long-press`/`both` against `default`/`off`) would make every log line, grep and test fixture ambiguous, and a PI element missing its `global` attribute would silently bind the other one. The `Override` suffix matches the per-key overrides already in `CommonSettings` (`colorOverrides`, `titleOverrides`, `borderOverrides`, `graphicOverrides`).

**Schema: optional, caught to absent.** In `deck-core/src/common-settings.ts`:

```typescript
export const PressSoundOverrideSchema = z.enum(PRESS_SOUND_OVERRIDES).optional().catch(undefined);

export const CommonSettings = z.object({
  // ...existing fields
  pressSoundOverride: PressSoundOverrideSchema,
});
```

- A missing key, `""`, `null`, a hand-edited value or a value a later build adds all read as **absent**, the key's own default. The `.catch` is load-bearing: an action schema that fails to parse resets the key's settings (the reason Splits & Reference catches its `dial` root), so nothing about this field may fail the action's parse.
- A future value an older build does not know reads as absent there, which is the key's default. That is the right degradation for a value such as a hypothetical `on`: the older build cannot honour it and falls back to what it would have done before the driver chose.
- It is in `CommonSettings`, not only read by the wrapper, so the parsed type of every action carries it and the persisted contract is written down where every other per-key override is. The wrapper does not depend on the action having parsed anything (below).

**Backward and forward compatibility.** Every existing key has no `pressSoundOverride`, so it reads as absent: the three named keys go silent, everything else follows the global setting as today. No migration writes anything, which is the point: the fix for the reported clash reaches every existing Active Reset and Starter key without a write, and a key's stored settings stay exactly as the driver left them. A downgrade keeps the stored key: the only plugin-side write of action settings that is not a targeted migration, `BaseAction.onWillAppear`'s `addedWithVersion` seed, spreads the raw settings (`{ ...settings, addedWithVersion }`), and the deck host stores whatever the PI saved. An older build simply ignores the key.

**This is a persisted contract.** An action settings schema is reviewed at `xhigh` (`code-review.md`), and this field changes every action's schema at once. The review checks the `.catch`, the absent-means-key-default reading and that no action writes a parsed object that would strip the key.

## The key's own default

**A new optional handler member, key path only:**

```typescript
// deck-core types.ts, on IDeckActionHandler<T>
/**
 * This key's press sound when the driver has chosen none (#1733): `off` where
 * the sim already confirms the press audibly. Called by `withPressSounds` at
 * key down, only when the per-key setting is absent, after the gate passes.
 * Synchronous and side-effect free. Optional — a handler without it is
 * `default`. A throw reads as `off`.
 */
keyPressSoundDefault?(ev: IDeckKeyDownEvent<T>): PressSoundOverride;
```

- **Car Control** returns `off` when `control` is `starter`. Starter bleeps once as the binding engages and twice at the threshold while iRacing plays the engine cranking, which is the clash the issue reports.
- **Splits & Reference** returns `off` when `mode` is `active-reset-set` or `active-reset-run`. iRacing plays its own confirmation for both.
- Each of the two exports its set (`PRESS_SOUND_OFF_CONTROLS`, `PRESS_SOUND_OFF_MODES`, `@internal`) so the PI pin below has one source to compare against.

**Why a member and not a flag on `PressShape`.** `PressShape` describes what a press does (a tap, a hold, a release with two outcomes); whether the sim confirms it is a different question, and a flag on the shape would need one per outcome of a `release`. A member also keeps the whole resolution in one place: the wrapper decides explicit choice, then the key's default, then Default, and the actions only answer "is this mode one the sim confirms". It is added to `IDeckActionHandler`, so the wrapper's `EveryHandlerMember` typing forces it to be forwarded.

**Why not resolve it inside the shape members.** An action could return `{ kind: "none" }` from `keyPressShape` when the setting is absent and its mode is one of the three. That splits the meaning of "absent" between the wrapper (which would have to know about `off`) and each action (which would have to know about absent versus `default`), and a third clash added later would have to rediscover the rule. The member makes the action's part a single yes/no.

**Why key only.** A dial instance carries up to four gestures (press, long press, tap, long touch), and one Default/Off choice covers all of them. An instance default of Off because one gesture is an Active Reset would silence the others the driver did not ask to lose, and per-gesture silence would need a per-gesture setting the issue does not ask for and the PI could not display truthfully with one dropdown. So a dial press and a touch default to Default, Splits & Reference's dial gestures included; a driver who puts Reset to Start Point on a dial picks Off for that dial. Car Control is keypad-only in every manifest; its `dialPressShape` is untouched and its dial path, if a host ever declares one, defaults to Default like every dial.

## Where the wrapper reads it

`withPressSounds` gains one step between the gate and the shape, on all three paths:

1. `readGate()` as today. No player, the global mode `none` or iRacing disconnected: silent, and the per-key setting is not read.
2. `readPressSoundOverride(ev.payload.settings)`, a deck-core function that reads `pressSoundOverride` from the raw event settings through `PressSoundOverrideSchema` (a non-object reads as absent; it never throws, and is guarded anyway). The wrapper reads the raw settings itself rather than trusting a handler to have parsed them, as it already reads nothing of the action's schema.
3. `off`: the press is silent. Nothing is recorded, no timer is armed, the shape member is not called, no sound plays at down, at the threshold or at up — the same outcome as a `none` shape, reached without asking the action.
4. Absent, key path: `handler.keyPressSoundDefault?.(ev)`, guarded like `resolveShape` (a throw is logged at debug and reads as `off`, the "any failure is no sound" rule of #269); a missing member is `default`. `off`: step 3.
5. `default`, or absent on the dial and touch paths: the shape is resolved and played exactly as today, at the global mode read in step 1.

**Read once, at down.** Like the global mode, the choice is read when the press starts. A PI change during a press already reaches the wrapper as `onDidReceiveSettings`, which forgets the press and disarms its timer, so picking Off while holding a key never lets its double bleep play.

**The override only removes sound.** `default` never adds a sound the shape does not give: Push to Talk and the volume steps stay `none`, and a key still plays nothing with the global setting on **No sound**. Nor does either value change what the key does: `onKeyDown`, `onDialDown` and `onTouchTap` run exactly as before.

## The Property Inspector field

**A new partial, `packages/pi-components/partials/press-sound-override.ejs`:**

```html
<sdpi-item label="Press sound">
  <sdpi-select id="press-sound-override" setting="pressSoundOverride" default="default">
    <option value="default">Default</option>
    <option value="off">Off</option>
  </sdpi-select>
</sdpi-item>
<div class="ird-supporting-text">
  Default follows the Press sound setting in the iRaceDeck Settings window. Off keeps this key silent.
</div>
<script>window.irdPressSoundDefault?.();</script>
```

No `global` attribute: it is this key's setting. The supporting text's final wording is the documenter's, approved with the website text; the key, the values, the `default="default"` attribute and the placement are the decision.

**Placement: rendered by `action-settings-footer.ejs`, above the button.** The footer is included exactly once by every action template, after the action's own settings and outside every surface wrapper, and `action-settings-footer.test.ts` already holds all of them to that. Rendering the field from it reaches every action PI in all three plugins (one template source per action, compiled by each plugin's `piTemplatePlugin`) with no template edit, shows it on the dial surface too (a dial user can silence a dial), and puts it on the footer's own boundary: the last of this key's settings, just above the way through to every key's. The footer keeps taking no parameters, so its include and its test do not change. Hiding the field while the global setting is **No sound** is not done: the choice is stored for when the sounds are turned on, and a PI reading global settings to hide a per-key field is a coupling nothing else here has.

**The mode default is shown, never stored.** `sdpi-select`'s `default` is render-only (`sdpi-components.md`): the component draws `value ?? default` and writes only when the driver picks an option, and changing the attribute from script changes only what is shown — the mechanism Black Box Selector's dial uses for its rotation-resolved defaults (#1585). So the two action templates mark their mode select with the modes that start silent, beside the options themselves:

```html
<sdpi-select id="mode-select" setting="mode" default="cycle" data-press-sound-off="active-reset-set active-reset-run">
<sdpi-select id="control-select" setting="control" default="pit-speed-limiter" data-press-sound-off="starter">
```

`irdPressSoundDefault`, a small function in the pi-components bundle (`src/components/press-sound-default.ts`, exposed on `window` like `irdKeepOneChecked`), waits for `sdpi-select`, finds the page's one `[data-press-sound-off]` select, and sets `#press-sound-override`'s `default` attribute to `off` when that select's `value ?? default` is in the list and to `default` otherwise, again on its `change` / `input` and on the `irdPoll` tick the templates already use for mode visibility. On the dial surface (`irdResolveController()` is `Encoder`) and on a page with no marked select it leaves `default`. A stored value is never written by it, so an untouched key keeps following its mode and a chosen one keeps its choice.

**One list, pinned.** The modes appear twice, in the action's exported set and in its template's `data-press-sound-off`. A test in `iracing-actions/src/pi-templates/` holds every template carrying the attribute to the set its action exports, and every action that declares `keyPressSoundDefault` to carrying the attribute (and none other to carrying it). A generated data file was weighed and rejected: two actions and two short lists do not pay for a generator, and the pin fails as loudly.

## The dial turn tick (#1731)

**Off does not silence a dial's turn tick.** #1731 put the tick behind its own global key, `dialTurnTick`, gated in deck-core's `playDialTurnTicks` by that key and the connection only, called from `DialSurfaceBase` where a surface knows a step went out. It decided that the press sound and the tick never gate each other, and left a per-dial tick switch out of scope. This spec keeps both: the per-key setting is the per-key refinement of `pressSound`, so it governs exactly what `pressSound` governs — presses, holds, releases and touches. The PI label says **Press sound**, and the website's per-key section says that turns keep ticking per the **Dial turn tick** setting. The #1455 volume tick on Audio Controls is untouched for the same reason. A practical reason agrees: the tick is played from the dial surface, which holds the `dial` settings root and not the instance's top-level settings, so honouring the override there would need the surfaces to carry it, for a choice no driver has asked for.

## Website and rules

- **`docs/features/press-sounds.md`** gains a section on turning sounds off for one key: the **Press sound** field on every key's and dial's Property Inspector, Default and Off, that the choice covers that key's taps, long presses, dial presses and touches; that Set Active Reset Point, Reset to Start Point and Starter start on Off because iRacing confirms them itself, and choosing Default brings their bleeps back; that a key with no choice follows its mode while a choice survives a mode change; and that a dial's turn tick is not affected. The hold-controls list ("Car Control's Starter … Splits & Reference's Active Reset Run") and **What Stays Quiet** are updated to match.
- **`docs/actions/driving/car-control.md`** (Starter) and **`docs/actions/cockpit/splits-delta-cycle.md`** (the two Active Reset modes) each say the mode is silent by default and how to change that.
- **A `Features` changelog fragment**, `changelog.d/1733-per-key-press-sound.md`, ordinary weight (50), naming that the three keys are now quiet by default.
- **Rules.** `stream-deck-actions.md`: `CommonSettings` gains `pressSoundOverride`, and the Press sounds section gains the override and `keyPressSoundDefault` with the `data-press-sound-off` pin. `pi-templates.md`: the new partial, and the footer entry noting it renders the field (still no parameters).

## Alternatives rejected

- **Silencing the three keys with no setting** (the issue's first alternative). Fixes the report but leaves the next clash with no way out.
- **A list of per-key overrides in the Settings window** (the issue's second). The key's own PI is where a per-key choice is looked for.
- **Reusing the key name `pressSound`.** Above: two stores, two value sets, one name.
- **A visible third option ("Key default" or "Auto").** The issue asks for Default and Off; the absent state is shown as whichever of the two it resolves to, which is what the driver needs to see. The cost is that once a choice is stored there is no way back to "follow the mode" short of picking the matching value, which only matters across a later mode change.
- **Writing `off` into the settings when the PI switches to one of the three modes, or migrating existing keys.** Writes a choice the driver did not make, misses keys whose mode was set before the upgrade or by a profile, and would overwrite a stored `default` unless it tracked who wrote it.
- **The default follows the mode even after a choice.** Would throw away a choice the driver made on the next mode change (`never delete user choices`), and no other per-key override behaves that way.
- **A `simConfirms` flag on `PressShape`, or the default resolved inside the shape members.** Above, under The key's own default.
- **Per-gesture defaults on Splits & Reference's dial.** Above: one dropdown cannot show them truthfully.
- **Off also silencing the dial turn tick.** Above, under The dial turn tick.
- **Including a new partial from each of the ~36 templates.** Reaches the same place with 36 edits and a second placement test; the footer already is that place.

## Out of scope

- An `on` value that plays sounds on one key while the global setting is **No sound**, or a per-key choice among Taps / Long-press / Both.
- Per-gesture press sounds on a dial, and a mode-dependent default on any dial or touch.
- Silencing the #1731 dial turn tick or the #1455 volume tick per key.
- Hiding or disabling the field from the global setting.
- Further keys that start silent; a later clash adds its mode to its own action's set and template attribute.
- A migration or any write to existing keys' settings.
- The fallback `settings.ejs` page and the Settings window, which are not action PIs.
- Any change to what a key, dial or touch does.

## Testing

Suite:

- **Constants.** `PRESS_SOUND_OVERRIDE_KEY` and `PRESS_SOUND_OVERRIDES` pinned in `persisted-values.test.ts`.
- **Schema.** `pressSoundOverride` reads `default` and `off`; missing, `""`, `null`, a number, `"on"` and an unknown string read as absent without failing the parse, inside `CommonSettings` and inside a real action schema (an action's other settings survive a garbage value); a parsed action object keeps the field.
- **Wrapper.** With the global mode `taps`, `long-press` and `both`: `default` and absent-with-no-member follow the global mode exactly as today; `off` silences a tap, a `hold` (no down bleep, no threshold bleep), a `release` key (no short-release bleep, no threshold bleep), a dial press and a touch, and the shape member is not called; absent with `keyPressSoundDefault` returning `off` is silent, returning `default` plays; a throwing `keyPressSoundDefault` is silent and the press still reaches `onKeyDown`; `keyPressSoundDefault` is never called when the value is stored, on the dial or touch path, or when the gate fails; with the global mode `none` nothing plays and the setting is not read; non-object settings read as absent; picking Off during a held press (an `onDidReceiveSettings`) disarms the threshold bleep; the handler's own result and throws reach the adapter unchanged; the wrapper forwards `keyPressSoundDefault`.
- **The three keys.** Car Control's `keyPressSoundDefault` is `off` for `starter` and `default` for every other control; Splits & Reference's is `off` for `active-reset-set` and `active-reset-run` and `default` for the other modes; through the wrapper, each of the three is silent with no stored value and plays its existing shape (Starter and Reset to Start Point once at down and twice at the threshold) with `default` stored.
- **Partial.** `press-sound-override.ejs` renders an `sdpi-select` bound to `pressSoundOverride` with no `global` attribute, `default="default"` and exactly the options `PRESS_SOUND_OVERRIDES`; `action-settings-footer.ejs` renders it above the button.
- **Templates.** Every action PI renders the field once (through the footer); the `data-press-sound-off` lists equal the actions' exported sets, and only actions declaring `keyPressSoundDefault` carry the attribute.
- **PI function.** `irdPressSoundDefault` sets the displayed default to `off` for a marked select whose value or default is listed and to `default` otherwise, follows a mode change, leaves `default` on the Encoder surface and on an unmarked page, and never saves a value.

By hand, with Press sound on **Both** and iRacing connected:

- **Stream Deck.** A new Set Active Reset Point key, a Reset to Start Point key and a Starter key make no press sound, while iRacing's own sounds play; their PI shows **Off**. Choosing **Default** on each brings back its bleeps (Starter and Reset to Start Point once, then twice on a hold). A Cycle key bleeps; setting it to **Off** silences its taps, and a setup View key on Off loses both its release bleep and its double bleep.
- **Mode changes.** An untouched Splits & Reference key switched from Cycle to Set Active Reset Point shows Off and goes quiet, and switched back shows Default and bleeps. A key whose Default was chosen on Set Active Reset Point keeps Default after switching modes; one set to Off on Cycle stays Off after switching to Set Active Reset Point and back.
- **Existing keys.** Keys configured before the upgrade: the three kinds are silent, every other key bleeps as before, and their stored settings are unchanged.
- **Stream Deck+.** A dial set to Off makes no press or touch sound; with **Dial turn tick** on it still ticks on every step. A Splits & Reference dial with no choice bleeps on its gestures, Active Reset ones included.
- **Mirabox.** A key and a knob set to Off are silent; the field shows and saves on Mirabox's PI.
- **Ulanzi.** A key set to Off is silent; the field shows and saves through the Ulanzi PI bridge.
- **Global No sound.** Every key is silent whatever its per-key choice.
