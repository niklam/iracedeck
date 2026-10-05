> **Issue:** [#254](https://github.com/niklam/iracedeck/issues/254) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Session Info: tire temperatures from the last pit stop

## The sim model, stated first because everything rests on it

The issue was filed reading `LFtempCL/CM/CR` … `RRtempCL/CM/CR` as live 60 Hz readings of tire condition. They are not. Like the wear values, iRacing refreshes the twelve carcass temperatures **only while the car is in the pit stall**, and holds them unchanged through the whole next stint (maintainer ruling, 2026-10-05). The local telemetry snapshots agree (gitignored, `master/local/`). The ten taken on 2026-10-02 cover two sessions, and within each the three `LFtempC*` values are identical to the fifth decimal in the stall and on track, up to 3½ minutes of session time apart. Those values sit at ~39.9 °C, which is what iRacing placed the car with, since no stop had been made.

Everything else follows from #1108, which settled the same model for wear and proved it with a capture (`2026-09-04-issue-1108-tyre-wear-report.md`, amendment of 2026-09-19):

- The values refresh once per stop, as the car arrives in its box, and never on track.
- **After a tire change they still describe the set that came off.** The reading is therefore a summary of the stint just driven, which is the useful number: whether the tires were in their window, and how evenly they worked across the tread. It is never "the temperature of the fresh rubber".
- iRacing's L/M/R are the car's left, middle and right. On a left-side tire L is the **outside** shoulder and R the **inside**, mirrored on the right side.
- A car placed in its stall (garage "Drive", a tow, a reset) is not a stop.

So this feature is a **pit-stop readout**, not a live gauge, and the design below is shaped by what a stop value needs that a live one would not: a state for "no stop yet", a statement on the key that the figure is a pit reading, and a lifetime for the reading. The other thing that drops out is the issue's "live tire condition" framing of the colour bands (decision 5).

Discord asked for exactly this ("Tire temp to display on stream box", the values from after a pit stop, explicitly not live). Telemetry Display templates already show the raw twelve values (`{{telemetry.LFtempCM}}`); what is missing is a key that knows which of those values is a real stop reading, summarizes them, and colours them.

## What ships

A new **Session Info** item, **Tire Temperatures**. By default it shows all four tires on one key, one figure per tire, laid out as the car seen from above, under the title `PIT TEMPS`. The figures come from the last pit stop the driver drove into, and the key shows them in iRacing's display units. They hold until the next stop. Before the first stop it shows `--` in every slot.

## Decisions

### 1. It is a Session Info item, not a new action and not Telemetry Display

Session Info already shows display-only sim readings (Track and Air Temperature, Wind, Track Wetness), has per-item PI sub-settings shown by mode, and renders custom graphics for the items that need them (`generateGapsGraphic`, `generateWindGraphic` behind `GRAPHIC_ONLY_MODES`). One more item adds one value to the `mode` enum and a handful of sub-settings. It needs no new UUID, no manifest entry in any of the three plugins, no `plugin.ts` registration, no comms-catalog entry and no action-count change. On the website and in the store descriptions it is one more mode (13 → 14 on the Session Info page, 278 → 279 site-wide), with the action count unchanged.

- **A dedicated Tire Temperature action** was rejected. It would rebuild Session Info's plumbing (telemetry subscription, state-key cache, title/border/colour resolution, the PI scaffold) for one display, and it would cost an action UUID in three manifests plus an action count that the website and store listings carry by hand. Nothing about the display needs a surface Session Info lacks.
- **Telemetry Display** was rejected as the home. Its key is a user template. Colour bands, a 2×2 layout, a corner selector and the "no stop yet" state are all logic that a template expression cannot express, and Telemetry Display does not know which values are a stop reading. It remains the escape hatch for anyone who wants the raw twelve values.
- **Tire Service** was rejected. It is a command action (what the crew will change at the next stop), and its key already shows that selection. A display of the last stop's temperatures on the same key would conflate "what came off" with "what goes on".

### 2. The translator owns which values are a stop reading

A key that read the twelve telemetry fields directly would show the wrong thing before the first stop. When the car is placed in the world, the fields hold whatever iRacing gave the car (the snapshots show ~40 °C, or near-ambient values, with full tread), and nothing in those values says they are not a stop reading. Telling the two apart needs the drive-in latch from #1108, and that latch lives in `sim-events-iracing`.

So the translator keeps a **last-stop tire temperature reading** and exposes it through an accessor beside `getFuelStats` and `getLiveGaps`:

```typescript
type TireCornerTemps = { inside: number; middle: number; outside: number }; // °C, unrounded
type LastStopTireTemps = { corners: Record<TireCorner, TireCornerTemps> };

export function getLastStopTireTemps(): LastStopTireTemps | null;
```

- **When it is taken.** On every tick of a stall visit the car drove into, the reading is the current twelve values, so the key updates while the driver sits in the box. That is the one moment of the race when they can look at the deck. At `pitStall.departed` the reading freezes. Reading on every tick of the visit rather than at one edge makes the arrival-time refresh (which the wear capture timed at ~0.2 s _before_ `PlayerCarInPitStall`) safe whatever its exact tick is for temperatures.
- **The drive-in rule is #1108's, reused, not re-derived.** Today it lives inside `diff/tire-wear.ts` as `tireWearDroveOnCircuit` / `tireWearStallDriveIn`. It is hoisted into one shared stall-visit predicate that both the wear report and this reading consume, so the two families cannot drift on what counts as a stop. A garage "Drive" placement, a tow and a reset leave the previous reading in place.
- **Zones are named by the #1108 mapping** (`inside` / `middle` / `outside` from the car's centreline), in the same shape as `TireCornerWear` minus the summary fields, so a future consumer can show wear and temperature from one model.
- **Unavailable is `null`, never zero.** A reading with any field missing or non-finite, or all twelve at zero (a car with no temperature model), is not taken, which is `buildTireWearReport`'s rule.
- **Lifetime.** The reading survives garage visits and session changes: a practice stop's temperatures are exactly what a driver tuning pressures and camber in the garage wants to see. A disconnect clears it, and so does a replay-only session, which never takes one. The next drive-in stop replaces it. Connecting mid-session after a stop shows `--` until the next stop, because nothing proves the held values were a drive-in reading.
- **No bus event.** Nothing needs to react to the reading; the key polls it on its render pass the way it polls fuel stats. The sim-event catalog, a published contract, is untouched.

**Returning to the garage after a run is open** (see _Open questions_). Nobody knows yet whether iRacing refreshes the twelve values when the driver escapes to the garage with the run's tires (it shows tire temperatures on its own garage screen). The proposal: if the capture shows that it does, that refresh is accepted as a reading too, taken on the tick it happens, provided the car was driven on the circuit since the last reading, because it describes the run just driven and it is the setup-tuning case; if the capture shows no refresh, the rule stays drive-in stops only. Either way a "Drive" placement afterwards never replaces the reading.

### 3. All four tires by default, one corner as the alternative

A new **Tire** sub-setting (`tireTempCorner`): **All four** (default), **Left Front**, **Right Front**, **Left Rear**, **Right Rear**.

- **All four** is a 2×2 grid of four figures, positioned as the car seen from above (LF top-left), which is the Tire Service icon's convention. Each figure is one summarized value per tire (decision 4), as a whole number with a degree sign (`85°`). The unit letter is dropped for width, and the unit comes from the display units. This is what the Discord request and the issue's option 2 describe, and it answers "were the tires in their window" at a glance.
- **A single corner** shows that tire's **three zones** side by side, in the car's left-to-right order, each with a small `O` / `M` / `I` zone letter beneath it. On the left tires the outside zone is therefore the left column; on the right tires it is the right column. Four single-corner keys arranged like the car read physically. This is a deliberate change from the issue's option 1, which was one summarized figure per key. A whole key spent on one number throws away the spread across the tread, which is what a stop reading is best at showing: an inside-hot spread is camber, a middle-hot one is pressure. A driver who wants one figure per tire has the all-four view.

### 4. The calculation method applies to the all-four view only

A **Calculation** sub-setting (`tireTempMethod`), shown only for All four:

| Value                     | Formula           |
| ------------------------- | ----------------- |
| Weighted center (default) | (L + 2×M + R) / 4 |
| Average                   | (L + M + R) / 3   |
| Hottest zone              | max(L, M, R)      |
| Middle only               | M                 |

The issue's four methods all stay, because each is a pure function and costs a dropdown entry. Weighted center stays the default for the reason the issue gives. The method is computed in °C on unrounded values, then converted and rounded once.

### 5. Colour bands stay, configurable from the start, and are framed as a stop reading (unit and defaults open)

The bands are the core of the original request, and they stay. They move in two ways.

**What they mean.** Each band describes the carcass as the car arrived in the box, after an in-lap and a run down pit lane. It no longer means live grip. The labels change to match: the PI and website say **below / in / above / well above the window**, not "cold, no grip" and "critical". The reading still separates a stint run cold from one that overheated, which is the question a stop answers.

**Configurable now, not "in a future iteration".** One fixed set of thresholds is wrong for most cars and compounds, and the issue already said so. A stop value also reads below in-stint temperatures by an amount that depends on the car and the in-lap. The local snapshots' post-run stop readings range from 57 to 83 °C, with one 115 °C outlier, so a fixed 70 °C floor would paint a good share of ordinary stops blue. Three per-key thresholds therefore ship with defaults from the issue:

| Setting                 | Default | Band            |
| ----------------------- | ------- | --------------- |
| `tireTempColdBelow`     | 70      | blue below it   |
| _(between)_             | —       | green           |
| `tireTempHotAbove`      | 100     | yellow above it |
| `tireTempCriticalAbove` | 115     | red above it    |

- **The thresholds are in °C**, the sim's own unit and what the stored value means whatever the driver's display units are. The PI labels say °C, and the help text gives the °F equivalents of the defaults. Storing them in the display unit was rejected: iRacing's `DisplayUnits` can change between sessions, so a stored "100" would silently change meaning.
- **The bands are evaluated hottest first** (red, then yellow, then blue, else green), so a hand-typed set that is out of order still colours predictably. The user's values are never rewritten or reset to the defaults.
- **The colours are discrete and fixed**, like Session Info's gain/loss colours: blue `#3498db`, green `#2ecc71`, yellow `#f1c40f`, red `#e74c3c`. A **Color by temperature** checkbox (`tireTempColors`, default on) turns them off, and the figures then take the theme text colour.
- In the all-four view the band colours the summarized figure. In the single-corner view each zone is coloured on its own raw value.

### 6. Units follow Session Info's temperature items

Figures are shown in the driver's display units, the rule Track and Air Temperature use since #466: `DisplayUnits` English → °F via `celsiusToFahrenheit` from `deck-core`, and unset counts as metric. Whole degrees, rounded once after conversion.

### 7. The key says it is a pit reading

The default title is `PIT TEMPS` for all four and `<CORNER> PIT TEMPS` (`LF PIT TEMPS`) for one corner, wrapped to two lines if the title width needs it. The words "pit" and "stop" are in the title and the PI help text so nobody reads the figure as live. No age stamp (lap of the stop, time since) ships: it costs a third line on a key already carrying four figures. The figure stops changing the moment the car leaves the box, which already says it is not live.

Before the first stop, or with no reading, every slot shows `--`, Session Info's existing "no reading" glyph, never a zero.

### 8. No dial surface

Session Info is keypad-only (`"Controllers": ["Keypad"]` in the Elgato manifest), and so is this item. A dial on Session Info would be a decision for all fourteen items, not one. It needs the Encoder controller on the Elgato manifest and the matching Knob on Mirabox (the manifest parity test keeps the two sets equal), plus a committed touch layout and a strip renderer for every item. Within this item a rotation would also have nothing to adjust. At most it could cycle corners, and the all-four view already shows every corner at once. The website's per-item "Dial: No rotation support" line applies.

The renderer is still written for one later: the graphic is a pure function of the reading, the settings and a canvas size. A future Session Info dial surface, if one is ever filed, can therefore draw this item on a 200×100 strip or a knob screen without rework.

### 9. Speaking it on press is out of this issue

Session Info's action-wide **Speak value on press** (#466) shows on this item with the same "this item doesn't speak yet" line as the other silent items, and a press does nothing. Speech needs a new `telemetryReadout.requested` kind, which is a change to a published contract reviewed at xhigh. It also needs new clips: corner intros without the percent form #1108 recorded, though `numbers-degrees` covers −20…176. And it needs a decision about what to say, whether four figures or the hottest corner and its zone. That is its own issue. It might also be better answered by extending the #1108 post-stop report than by a key press.

## Settings added

All are Session Info settings, shown only when Mode is **Tire Temperatures**. Every key is new, so no migration is needed.

| Key                                                                | PI label                                                | Type, default                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------- |
| `mode: "tire-temps"`                                               | Mode → Tire Temperatures                                | enum value                                               |
| `tireTempCorner`                                                   | Tire                                                    | `all` \| `lf` \| `rf` \| `lr` \| `rr`, `all`             |
| `tireTempMethod`                                                   | Calculation (All four only)                             | `weighted` \| `average` \| `max` \| `middle`, `weighted` |
| `tireTempColors`                                                   | Color by temperature                                    | boolean, `true`                                          |
| `tireTempColdBelow` / `tireTempHotAbove` / `tireTempCriticalAbove` | Below window (°C) / Above window (°C) / Well above (°C) | number, `70` / `100` / `115`, shown when colours are on  |

Identifiers spell "tire", per the #1108 ruling. The numbers follow the `fuelLapWindow` rule: they coerce, and on a bad value they `.catch` back to the default, so one malformed field never fails the whole settings parse.

## Artifacts beyond the code

- `sim-events-iracing`: the shared stall-visit predicate hoisted out of `diff/tire-wear.ts`, the reading in translator state, `getLastStopTireTemps()` exported, and its types.
- `iracing-actions/src/actions/session-info/`: the settings (`session-info-settings.ts`), the PI (`session-info.ejs` Mode option, sub-settings, help text, visibility), the graphic and title in `session-info.ts`, and the pure method / band / layout functions in their own module with tests.
- No change to manifests, `plugin.ts`, `comms-catalog.ts`, `icon-defaults.json` or the event-bus catalog.
- `docs/reference/actions.json`: the new Session Info mode.
- `iracedeck-actions` skill: the Session Info row (13 → 14, the item described as a pit-stop reading).
- Website: a **Tire Temperatures** section on `display-session/session-info.md`, plus its `13 modes` badge and description frontmatter; `actions/overview.md` (Display & Session modes and the 278 total); the `index.mdx` Modes stat; and a correction to `features/template-variables.md`'s _Tires — Temperature & Wear_ section saying those variables are pit-stall values, which is the same misreading this spec corrects. Then a `changelog.mdx` Features line and `pnpm generate:changelog-data`.
- Store descriptions (outside the repo), if they enumerate Session Info items.
- The Discord thread gets its reply when this ships.

## Open questions

The maintainer left these to be settled before implementation starts (2026-10-05). The decisions above carry a proposal for each; this section, not the proposal, is the state of the decision until it is amended.

1. **The garage escape.** Whether a refresh of the twelve values on returning to the garage after a run counts as a reading (decision 2). The capture shows whether the refresh exists; whether to use it is the open part.
2. **The threshold unit.** Thresholds stored and typed in °C whatever the display units, with °F equivalents in the help text, or a unit selector (decision 5).
3. **The colour defaults and tows.** Whether colouring is on by default at 70 / 100 / 115 °C, given that stop readings run below in-stint temperatures (decision 5), and whether a tow keeps the previous reading as #1108 treats tows, or counts as a reading of the tires that came in on it (decision 2).

## Out of scope

- Live tire temperatures. iRacing does not expose them, and nothing here pretends otherwise.
- Speaking the reading, whether on press or after a stop (decision 9).
- A dial surface (decision 8).
- Tire wear on a key. The same accessor shape makes it a natural sibling item, but it is a separate decision.
- Colouring by the spread across the tread (inside-vs-outside for camber, middle-vs-edges for pressure). It is a different signal from the absolute bands, and it needs its own thresholds.
- Per-car or per-compound default thresholds.
- Cold tire pressures (`LFcoldPressure` …) and any other pit-stall-only field.

## Testing

**Capture first (implementation task 1).** Run a `telemetry-watch` recording of the twelve `*tempC*` fields alongside the twelve wear fields and the pit fields the #1108 capture used. Drive it through a garage drive-out, a four-tire stop, a stop with nothing queued, a tow, and an escape to the garage after a run. It confirms three things:

- the temperatures refresh on the same arrival tick as wear and hold on track;
- after a tire change they hold the set that came off;
- whether the garage escape refreshes them, which picks the branch in decision 2.

A trimmed copy goes into `sim-events-iracing/src/diff/__fixtures__/` with a fixture test, as #1108's did.

**Suite.**

- **Translator.** A drive-in visit takes the reading and keeps updating it until departure, then freezes. A garage placement, a tow and a reset leave the previous reading in place. A replay-only session never takes one. A disconnect clears it, and a session change does not. Missing, non-finite or all-zero fields give no reading. The zone mapping holds on both sides. Run the stall-visit predicate's existing #1108 tests unchanged against the hoisted version.
- **Session Info.** Cover each method on known triples. Cover the band edges (exactly 70, 100, 115), an out-of-order threshold set, and colours off. Check °C and °F conversion with rounding after conversion. Check the single-corner column order and zone letters per side, `--` with no reading in both views, the titles, the setting defaults, and that a malformed threshold falls back without resetting the rest of the settings. A press publishes nothing on this item.
- `pnpm test` also covers the changelog parser and the freshness test.

**Manual (the PR gate).** In iRacing, check the following:

1. Out of the garage, the key reads `--`.
2. Drive into the box. The figures appear while the car is in the stall.
3. Leave on a four-tire change. The figures stay as they were, showing the set that came off.
4. Do a stop without tires. The figures update.
5. Tow to the pits. The figures do not change.
6. Repeat with imperial display units.
7. Arrange four single-corner keys as the car and check the outside zone sits on the outside for every corner.
8. Judge the default thresholds against a real stint's stop reading.
