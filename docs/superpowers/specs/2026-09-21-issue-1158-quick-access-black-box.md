> **Issue:** [#1158](https://github.com/niklam/iracedeck/issues/1158) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# The F9 black box is Quick Access

## What was verified

iRacing 2026 Season 4 turned the F9 black box into a hierarchical Quick Access menu. Niklas checked the five questions #1158 raised in the sim on 2026-09-21:

1. iRacing's Controls screen calls the F9 entry **Quick Access**.
2. F1–F8, F10 and F11 open exactly what they did before.
3. The #818 prime-then-target sequence still lands: a black box beside Quick Access is still a plain toggle.
4. Display Reference Car (`toggleUiDisplayRefCar`) still toggles the reference car.
5. Nothing else we bind changed.

So this is a naming and icon change. No behaviour moves, and `shared/black-box.ts` — the box list, the prime preference, the fallback scan order — is untouched.

An attempt to read the label from the local install first was inconclusive and is recorded so nobody repeats it: `iRacingSim64DX11.exe` still carries a string table saying "Mirror Adjustments Black Box", but the same table still says "Toggle UI Visibility", which Season 4 renamed, so it is the legacy UI's table and says nothing about the new one. The new Sim UI's text is in an encrypted resource pack.

## Decisions

**The user-facing name is "Quick Access", taken verbatim from the Controls screen.** Everywhere a user reads the F9 box's name — the Black Box Selector's Black Box dropdown (keypad and dial), the Related Key Bindings row and the settings window's Key Bindings tab (both from `key-bindings.json`), the documentation tables and the website — says Quick Access. The "iRacing Setting" column in the keyboard-shortcut tables says Quick Access too, since that column exists to match what the user will find in iRacing.

**The key title is `QUICK ACCESS`, on one line.** It replaces `GRAPHICS` in `BLACK_BOX_TITLE_TEXT` and in the icon's `<desc>` title. Twelve characters on one key-title line has precedent: Setup Chassis ships `DIFF PRELOAD` and Setup Hybrid `FIXED DEPLOY`, both at the default size. Both the map and the `<desc>` change together, because the action's title map overrides the `<desc>` title and editing only one is a no-op.

**The stored identity does not change.** The settings value `mirror` (keypad `blackBox`, dial `dial.pressBox`), the global key `blackBoxMirror` and the `BlackBoxId` `"mirror"` all stay. They are persisted user data; renaming them is a settings migration that buys the user nothing they can see. Existing buttons pick up the new icon and title on their next render with no action from the user — except where the user typed their own Title Text, which keeps winning as it always has.

**The icon file is renamed `mirror.svg` → `quick-access.svg`.** Unlike the id, the file name is user-visible: the website's icon gallery lists icons by file name. The action's icon map keeps its `mirror` key and imports the renamed file; the old preview goes with it.

**The artwork is a settings menu, built so it cannot be mistaken for Relative.** Inside the shared flat frame, three menu rows, each a short `{{graphic1Color}}` label bar on the left. Rows one and three end in a right-pointing chevron — "opens a sub-page", which is what distinguishes Quick Access from every other box. Row two ends in an amber (`#f6d34c`, the family's data amber) toggle switch in its on position — the menu's other row type. No row is filled full-width: three full-width rows with one highlighted is Relative's identity, and the chevrons and the switch must carry this icon's. The `<desc>` colour slots stay identical to the siblings'. The artwork is approved on a before/after gallery at the manual test, not in this document.

**`black-box-icons.md` is corrected to describe the icons that ship.** It still documents the gradient language — `viewBox="0 0 96 68"`, an olive `bbG2` fill, a `#6a5138` stroke — that #827 replaced with the flat style every file in `packages/icons/black-box-selector/` now uses (`viewBox="0 0 81.3 49.3"`, a `{{backgroundColor}}` frame stroked in `{{graphic1Color}}`). The new icon has to match its family, and the rule is what its author reads, so the frame section and the `mirror` row are brought to the truth in this change.

## Affected artifacts

- `packages/iracing-actions` — `data/key-bindings.json` (`blackBoxMirror`'s label), `black-box-selector/black-box-selector.ejs` (both `<option value="mirror">`), `black-box-selector/black-box-selector.ts` (title map, icon import) and its test's title expectation.
- `packages/icons` — `black-box-selector/quick-access.svg` replacing `mirror.svg`, plus the regenerated preview and icon defaults.
- Website — `docs/reference/keyboard-shortcuts.md`, `docs/actions/driving/black-box-selector.md`, and one `**Improvements**` line in `changelog.mdx` (with the regenerated `changelog.json`).
- `docs/` — `keyboard-shortcuts.md`, `plugins/core/actions/black-box-selector.md`, `reference/actions.json` (`Select Mirror/Graphics`), `stream-deck-plugin-unified.md`.
- Rules — `.claude/rules/black-box-icons.md`, as above.

`data/action-comms.json` keys on the id, not the label, so it regenerates unchanged; `shared/black-box.test.ts` keeps its count of 11.

## Out of scope

- **New Season 4 surface** — the Toggle Minimal Drive UI keybind, the Pit Summary and Car Damage widgets, Reference Car Offset and Opacity. New features that deserve their own issues, not a rider on a rename.
- **Renaming the `mirror` id or the `blackBoxMirror` key**, for the reason above.
- **`docs/plans/black-box-selector-implementation.md`** — a historical implementation record, which describes what was true when it was written and is left alone.
- **The prime order in `resolvePrimeKey`.** Quick Access sits ninth in the fallback scan and was verified to behave as a plain toggle, so it stays eligible as a prime.
- **iRacing's "Toggle UI Visibility" → "Cycle UI Visibility Mode" rename.** We do not bind it.

## Testing

Automated, in the hand-run green set:

- The Black Box Selector test expects `mirror` → `QUICK ACCESS`.
- The icon preview and icon-defaults freshness tests pass on the regenerated artifacts, with no `mirror.svg` preview left behind.
- The changelog parser and freshness tests pass.
- `pnpm --filter @iracedeck/website build` passes, and its icon gallery lists `quick-access` and no `mirror`.
- A repo-wide search finds "Mirror Adjustments" and `GRAPHICS` (as this box's title) nowhere but the historical plan named above.

By hand, by Niklas:

- The icon, on a before/after gallery, before it is committed as final.
- On a deck: the Black Box dropdown reads Quick Access on both the keypad and the dial surface; an existing button set to the old Mirror Adjustments option now shows the new icon and `QUICK ACCESS` at the default font size, unclipped; pressing it opens Quick Access in the sim.
- The settings window's Key Bindings tab lists Quick Access at F9.
