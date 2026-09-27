> **Issue:** [#1264](https://github.com/niklam/iracedeck/issues/1264) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Driver lap times and car details as template variables

## The problem

The driver-info prefixes carry position, lap count, iRating and licence, but no lap time, and there is no prefix for the leader. Foddy wants "fastest lap of the car ahead, or of the leader" in a chat message to himself. The per-car data is already in every tick (`CarIdxBestLapTime`, `CarIdxLastLapTime`, `CarIdxBestLapNum`, `CarIdxOnPitRoad`, `CarIdxFastRepairsUsed`) and in the roster (`CarScreenName`, `CarScreenNameShort`, `CarClassShortName`, `TeamName`); it just isn't mapped.

## What ships

On every driver prefix (`self`, `track_ahead`, `track_behind`, `race_ahead`, `race_behind`, `focused`, and the three new ones):

| Field | Display | Raw (expressions) |
| --- | --- | --- |
| `best_lap` | `1:32.456`, or `58.123` under a minute | seconds |
| `last_lap` | same | seconds |
| `best_lap_num` | lap number | number |
| `best_lap_delta` | `+0.412` / `-1.203` / `0.000` — this car's best minus yours | signed seconds |
| `last_lap_delta` | same, for last laps | signed seconds |
| `on_pit_road` | `Yes` / `No` | boolean |
| `fast_repairs_used` | count | number |
| `car` | `CarScreenName` | string |
| `car_short` | `CarScreenNameShort` | string |
| `car_class` | `CarClassShortName` | string |
| `team` | `TeamName` | string |

New prefixes:

| Prefix | Resolves to |
| --- | --- |
| `leader` | the car at rank 1 of the canonical order (overall) |
| `class_leader` | the car at class rank 1 in the player's class, by `classPositionFromOrder` over the same order |
| `fastest` | the competitor in the player's class with the lowest positive `CarIdxBestLapTime`; a tie goes to the lower `CarIdxBestLapNum` (set first) |

## Decisions

### 1. One lap-time reader, shared with the spoken readout

A new pure helper in `@iracedeck/iracing-sdk` (beside `template-context.ts`) returns `{ best, last, bestLapNum }` for a car, in seconds or `null`. The spoken-readout issue calls the same function, so a chat message and the Race Engineer can never disagree about a lap time.

- **The player's car reads the player fields** — `LapBestLapTime`, `LapLastLapTime`, `LapBestLap` — as `lap` and `laps_completed` already do (#700), so `self` and `focused`-on-you agree.
- **A non-positive time is `null`.** iRacing writes `-1` (or `0`) for "no time yet".
- **Before the green of a race, every lap time is `null`.** `race-positions.md` names the trap: on a rolling start `CarIdxLastLapTime` is the parade lap, minutes long. The gate is the existing `isPreGreen(telemetry)` in a race session. Whether `CarIdxBestLapTime` can carry the parade lap into lap 1 is unknown; the first task captures a rolling start (the `telemetry-snapshot` CLI) and, if it does, `best` is also `null` until the car's first timed lap after the green. The gate applies to both until the capture says otherwise.

### 2. Deltas are "theirs minus yours"

Positive means that car was slower. `self.best_lap_delta` is `0.000` rather than blank, so an expression does not need a special case for `focused` landing on you. Blank whenever either side is `null`. Display rounds to 3 decimals with an explicit sign; raw is unrounded.

### 3. The new prefixes consume the canonical order

`leader` and `class_leader` read the injected live order, per `race-positions.md` — no second ranking. With no order (non-race sessions) they fall back to the official `CarIdxPosition` / `CarIdxClassPosition` rank 1, exactly like `position` does per car today. In practice and qualifying that official order is by best lap, so `leader` is the fastest car; that is iRacing's own standings and correct.

`fastest` is not a position and does not touch the order. It is class-scoped because a multiclass session's overall fastest lap is a different car class, which answers no question a driver asks. Pace car and spectators are excluded as in the other finders.

Pre-green in a race, `leader` / `class_leader` resolve to the pole sitter (the grid order), and their lap times are blank by decision 1 — the rank is trustworthy there; a lap time read off it is not.

### 4. Everything else follows the existing field rules

- Text fields (`car`, `car_short`, `car_class`, `team`) are normalised through `yamlString` (#869): always present in expressions, empty string when absent. In a solo session iRacing sets `TeamName` to the driver's name; the website says so.
- `on_pit_road` and `fast_repairs_used` are blank for the pace car and spectators, like `position`.
- An unresolved prefix (no car ahead, no one has a best lap) renders every field blank, as today.

## Artifacts beyond the code

- Website `docs/features/template-variables.md`: the rows, the three prefixes, the blanking rules and delta sign, and a message-yourself Chat example (exact iRacing private-message syntax confirmed in the manual test). `changelog.mdx` Features line.
- `.claude/rules/race-positions.md`: `leader` / `class_leader` join the template-prefix consumer line.
- No manifest, PI or registration change.

## Out of scope

- A `gap` field; tyre compound names; opponents' incident counts; pit-stop counts (see the issue's alternatives).
- Class-relative neighbour prefixes (`class_ahead` / `class_behind`).
- Any change to what `race_ahead` / `race_behind` resolve to.

## Testing

**Suite.**

- The lap-time reader: player vs non-player sources, `-1` / `0` → `null`, pre-green `null` in a race and not in practice, `bestLapNum`.
- Formatting: sub-minute, over-minute, 10+ minutes, rounding at `.9995`; delta sign and `0.000` on self; blank when either side is missing.
- Prefixes: `leader` from the order and from the official fallback, `class_leader` in a two-class field, `fastest` with a tie and with no times yet, pace car never chosen.
- Text fields empty-string on a roster entry that lacks them.

**Manual (the PR gate).** In iRacing: a Chat key sending yourself `{{leader.best_lap}}`, `{{race_ahead.last_lap}}` and a delta mid-race; a Telemetry Display on `fastest.name` / `fastest.best_lap` in practice; a rolling start showing blank lap times until the green and correct ones after lap 1; a multiclass session for `class_leader` and `car_class`.
