> **Issue:** [#1352](https://github.com/niklam/iracedeck/issues/1352) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Camera Controls: Switch keys show the car they switch to

## Where the placeholder comes from

Both keys render through `generateCameraControlsSvg` in `packages/iracing-actions/src/actions/camera-controls/camera-controls.ts`, which looks the mode up in `FOCUS_ICONS` / `FOCUS_TITLES` and hands the standalone SVG to `assembleIcon()`. The `00` and the `#` are literal text in `packages/icons/camera-focus/switch-by-car-number.svg` and `switch-by-position.svg`, and the generator's settings parameter does not even carry `carNumber` or `position`. The icon is already redrawn on every settings change: `updateDisplay` runs on `willAppear` and `didReceiveSettings` and registers a regenerate callback with the same settings. So nothing about the refresh path changes; only what the generator is given and what the artwork draws.

## Decisions

### 1. The number goes in the artwork, through value placeholders

The two SVGs replace their static glyph with placeholders, named after the Data Display template's (`session-info.svg`): `{{value}}`, `{{valueFontSize}}` and `{{valueY}}`. Replay Control's `speed-display.svg` already carries a non-colour placeholder in a standalone icon (`{{speedText}}`), so this is an existing shape, not a new kind of icon.

The values reach the template through a new optional `templateValues?: Record<string, string>` on `assembleIcon()` in `@iracedeck/icon-composer`, merged under the colours (`{ ...templateValues, ...colors }`) so a value can never recolour a slot. Everything `assembleIcon` already does — the title-aware scaling, overrides, the #612 warning, dimming, the border — then applies unchanged. A caller that passes nothing gets byte-identical output.

**Rejected: put extra keys in `colors`.** Chat already does this (`colors: { ...colors, color: iconColor }`), and it would need no icon-composer change. But `colors` is the resolved colour-slot map; filling it with text and coordinates makes the parameter lie about its contents, and the next reader of `assembleIcon` cannot tell which keys are colours. A named option costs four lines.

**Rejected: assemble by hand, as `speed-display` and `set-speed` do.** Those two branches of `generateReplayControlSvg` re-implement `assembleIcon` (extract, render, transform, title, border, base template) to get one extra placeholder in. A third and fourth copy is what `templateValues` exists to avoid. Moving those two onto the new option is a follow-up, not part of this change.

**Rejected: the number in the default title** (Race Admin's `#070` sub-label). `resolveTitleSettings` replaces the default text with any user Title Text, and a hidden title hides it, so the number would vanish for exactly the users who customise their keys. The request is about the `00` in the artwork. The trade-off taken instead: with **Show graphics** off the number is gone; such a user can still type it into the title.

### 2. What each key draws

- **Switch by Car Number:** the stored `carNumber` as it is stored today — an integer, drawn as its decimal digits (`7`, `42`, `199`) — in the existing box, with the `CAR` label beneath. The schema (`z.coerce.number().int().min(0).default(0)`) and the press (`camera.switchNum(settings.carNumber, …)`) are untouched, so the key shows exactly the number the press sends. A number typed with leading zeros is stored without them, and the key shows that; fixing it is the separate bug (Out of scope).
- **Switch by Position:** `P<n>` (`P3`, `P12`), the dial's race-position notation, with the `POS` label beneath. The `POS` label stays although `P` already says "position", so the two keys keep the same silhouette of value over label, and the change stays a value substitution rather than a redesign.

Both values are built from integers plus the literal `P`, so they cannot carry markup; they still go through `escapeXml`, since `renderIconTemplate` does not escape and the icon file does not know what it will be given.

### 3. Width: a fixed frame, a fitted font size

The viewBox stays a fixed frame sized for three digits, not trimmed per value: a viewBox that followed the text would make `assembleIcon` scale `7` larger than `199`, and a row of keys would jump in size from one to the next. The box in the car-number icon is the frame there; the position icon keeps its current width.

The font size comes from the existing `fitValueFontSize(text, maxWidth, cap)` in `packages/iracing-actions/src/shared/dial-fit.ts` (bold Arial digits at about 0.6 em), capped at today's sizes (28 for the car number, 40 for the position). One to three digits and `P1`–`P100` draw at the cap. The schema puts no upper bound on either setting, so a longer value shrinks to fit instead of overflowing the box. The module is a pure primitive with no dial dependency, so a keypad caller can use it as is.

The baseline is computed, not left to `dominant-baseline="central"`: `.claude/rules/svg-platform-compatibility.md` records that resvg and the Qt renderers ignore that attribute and anchor text at the baseline, so `{{valueY}}` is the intended centre plus 0.36 em of the fitted size. The `CAR` / `POS` labels get the same treatment while the files are open, and the viewBoxes are re-trimmed to the artwork per `icons.md`.

### 4. Switch by Position keeps `switchPos`

The key draws the configured position and the press is unchanged: `camera.switchPos(position, …)`, which iRacing resolves against its official order. The dial's race-position mode moved off `switchPos` because its carousel previews the canonical order and the two must agree; this key previews nothing but its own setting, so it shows exactly what it asks iRacing for either way.

### 5. The dial needs no change

`camera-dial-surface.ts` has no fixed-target switch. Its car-number and race-position modes rotate through the live field, and its strip and knob already draw the focused car's number, or `P<pos>` with the number beneath. Its gesture slots (`GESTURE_ACTIONS`) offer Focus My Car, Change Camera and the three parameterless focus one-shots, none of which takes a configured car or position. There is no placeholder on the dial to replace.

### 6. The website gallery must not show raw placeholders

`generate-icon-gallery.mts` renders every standalone (template-class) icon through `assembleIcon` with colours only, so a non-colour placeholder reaches the public gallery as literal text — `{{speedText}}` and `{{needleAngle}}` do today. The template class gets the treatment the dynamic class already has (`renderDynamicTemplate` in `src/gallery-gen/lib.ts`, which also blanks any token left without a sample): sample values per icon, passed as `templateValues` (`42` for the car number, `P3` for the position, with their fitted size and baseline; a sample for Speed Display and Set Speed too), and a test that no `{{` survives in any generated gallery asset. The previews in `packages/icons/preview/` keep non-colour placeholders as they are by design (`generate-icon-previews.mjs`), like `speed-display` does.

## Out of scope

- The leading-zero bug, filed separately (#1353): `carNumber` is a coerced integer, so `007` is stored and dispatched as `7`. This change draws the stored value and leaves the schema, the PI field and the dispatch alone.
- The dial surface (decision 5).
- Moving Replay Control's hand-assembled `speed-display` / `set-speed` onto `templateValues`.
- Changing Switch by Position's dispatch to the canonical order of `race-positions.md` (decision 4).
- A cap on the number of digits.
- New default titles, new artwork, or the Black Box and Inverted key types (these are Default-type icons and stay so).
- Showing whether the configured car is in the session (a dimmed key for a car that is not there would make the icon telemetry-driven, which this change deliberately is not).

## Testing

**Suite:**

- `camera-controls.test.ts` — the icon mocks gain the value placeholders; `generateCameraControlsSvg` draws `42` for `carNumber: 42`, `0` for the default, and `P3` for `position: 3`; a value longer than three characters gets a smaller font size than a three-character one; the press dispatch tests pass unchanged.
- `icon-composer` — `assembleIcon` with `templateValues` fills a placeholder; a `templateValues` key named like a colour slot does not override the colour; without `templateValues` the output is unchanged.
- Website — the gallery guard finds no `{{` in any asset; the preview freshness test passes after regeneration.

**Manual (the PR gate):**

- On each linked deck host (Stream Deck, Mirabox, Ulanzi): keys set to `7`, `42`, `199` and `P1`, `P12`, `P100` render centred in their frame at the same scale; changing the setting in the PI redraws the key at once; the number shows out of a session.
- An existing Switch by Car Number key from before the change still switches to the same car and now shows its number.
- The icon gallery page on a local website build shows `42` and `P3` on the two keys, and Speed Display / Set Speed show no raw `{{…}}`.
