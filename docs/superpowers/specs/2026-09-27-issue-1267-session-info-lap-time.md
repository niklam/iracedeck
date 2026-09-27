> **Issue:** [#1267](https://github.com/niklam/iracedeck/issues/1267) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Session Info: a Lap Time mode that speaks on press

## The problem

#1264 puts other drivers' lap times into templates, for drivers who write one. #466 makes a Session Info key speak the figure it shows. Nothing shows a lap time on a key without a template, and nothing speaks one on request. Everything this needs already exists or is being built:
- #466's `telemetryReadout.requested` event, its press-to-speak setting and its scheduling
- #1264's lap-time reader
- the canonical order and its class-neighbour resolver (#933)
- the `lap-time-minute` / `lap-time-second` / `lap-time-decimal` clips the best-lap callout (#555) uses to speak any time up to 10:59.9

This spec builds on the #466 spec (`2026-09-26-issue-466-telemetry-readout.md`, as amended to Session Info) and changes none of its decisions.

## What ships

A twelfth Session Info mode, **Lap Time**, with two settings:

| Setting | Values |
| --- | --- |
| **Lap** (`lapTimeKind`) | Last (default), Best |
| **Driver** (`lapTimeTarget`) | You (default), Car ahead, Car behind, Class leader |

The key shows the time as `1:32.456` (`58.123` under a minute) under a title naming what it is: `LAST LAP` / `BEST LAP` for you, `AHEAD` / `BEHIND` / `LEADER` over `LAST` / `BEST` for the others. With no such car, or no time yet, it shows `--`.

Pressing it speaks the figure, as #466's **Speak value on press** does for every Session Info mode:

> "Your last lap, one minute thirty two, point four seconds."
>
> "Car behind, best lap, one minute thirty one, point eight seconds."
>
> "Leader, last lap, fifty eight, point one seconds."
>
> "No car ahead." (you lead your class) / "No car behind." (you are last in it)
>
> "No lap time yet." (the car exists but has no time)

## Decisions

### 1. "Car ahead" is the Race Engineer's car ahead: your class neighbour

Session Info resolves the target the way its Gaps mode and the gap callouts do:
- It calls `resolveClassNeighbors` (`@iracedeck/iracing-sdk` `gap-utils.ts`) over `getLiveRacePositions()`, excluding the pace car, and takes `aheadIdx`, `behindIdx` or `leaderIdx`.
- With no canonical order (practice, qualifying), the official `CarIdxPosition` array is the order, as everywhere else in `race-positions.md`. That array ranks by best lap, so "car ahead, best lap" is the next faster car in your class.

This deliberately differs from the `race_ahead` template prefix, which is overall. On Session Info, "ahead" has always meant your class (the Gaps mode, #933), and a lap time of a car in another class answers nothing. The website says which is which.

Session Info is above the translator, so it calls `getLiveRacePositions()` directly. No new ranking exists.

**What counts as "no car".** Only one case does: you are classified and the slot is empty (you lead your class, or you are last in it).
- If you are not classified yourself (practice before your first timed lap), `resolveClassNeighbors` returns no neighbours at all. That is "no lap time yet", not "no car ahead".
- **Class leader** always resolves to a car, because you are your own class leader when nobody else is. When you lead, the key shows your own time, which is true.

### 2. The figure comes from #1264's reader, on the key and in the voice alike

The time is `last` or `best` from #1264's lap-time reader for the resolved car. So the player's car reads its own authoritative fields, a non-positive time is `null`, and every lap time is `null` before the green of a race. The key, the template variables and the spoken readout therefore never disagree.

The display keeps thousandths, like iRacing's timing screens and the template variables. It sizes through the mode's existing text sizing and font-size setting. Legibility at the default size is judged in the manual test; if it fails, the fallback is hundredths, not a new layout.

### 3. The #466 event gains two kinds and a target

```typescript
"telemetryReadout.requested": SimEvent<
  "telemetryReadout.requested",
  {
    kind: "fuel-last-lap" | "fuel-average" | "track-temp" | "air-temp" | "last-lap" | "best-lap";
    value: number | null;
    unit: "liters" | "gallons" | "celsius" | "fahrenheit" | "seconds";
    laps: number | null;
    target: "self" | "car-ahead" | "car-behind" | "class-leader" | null;
    targetFound: boolean;
  }
>;
```

- For #466's four kinds, `target` is `null` and `targetFound` is `true`.
- For a lap kind, `targetFound: false` is the "no car" case of decision 1, and `value` is then `null`.
- A role, not a car index, crosses the bus. That keeps the payload sim-agnostic and lets the contracts pick the intro from `kind` × `target`.
- The value is captured at press time, and with no telemetry nothing is published (#466 decisions 1 and 2).

This is an additive change to #466's catalog entry. This work is blocked by #466, so the entry exists by then.

### 4. Three contracts, and the lap-time pools reused

In #466's `catalog/pit-crew/telemetry-readout.ts`:

| Contract | Fires for |
| --- | --- |
| `pit-crew.readout-lap-time` | a lap kind with a value |
| `pit-crew.readout-lap-no-time` | a lap kind, `targetFound`, `value` null |
| `pit-crew.readout-no-car` | a lap kind, `!targetFound` |

The vocabulary adds:

| Var | Resolves to |
| --- | --- |
| `readout.lapIntro` | `telemetry-readout/<kind>-<target>` (e.g. `last-lap-car-ahead`) |
| `readout.hasLapMinute` | the conditional the best-lap script uses (skip the minute under 60 s) |
| `readout.lapMinute` / `readout.lapSecond` / `readout.lapDecimal` | `lap-time-minute` / `lap-time-second` / `lap-time-decimal`, split by the exported `splitLapTime` (one rounding to 0.1) |
| `readout.noCarLine` | `telemetry-readout/no-car-ahead` or `no-car-behind` |

The voice rounds to tenths while the key shows thousandths. The spoken figure is what a race engineer says; the key is what a timing screen shows.

A time with no minute clip (11 minutes or more) aborts the callout, per #836. No range is checked in code.

**Scheduling and gating are #466's, unchanged:**
- weight `WEIGHT.NORMAL - 10` and `queueable: true`
- no family
- gated by the Race Engineer master switch and the key's own **Speak value on press**

### 5. Clips: eleven lines, no numbers

In `configs/default.voice.json`, group `telemetry-readout`:

| Clip | Text |
| --- | --- |
| `last-lap-self`, `best-lap-self` | "Your last lap,", "Your best lap," |
| `last-lap-car-ahead`, `best-lap-car-ahead` | "Car ahead, last lap,", "Car ahead, best lap," |
| `last-lap-car-behind`, `best-lap-car-behind` | "Car behind, last lap,", "Car behind, best lap," |
| `last-lap-class-leader`, `best-lap-class-leader` | "Leader, last lap,", "Leader, best lap," |
| `lap-no-time`, `no-car-ahead`, `no-car-behind` | "No lap time yet.", "No car ahead.", "No car behind." |

Each intro carries `next_text: " one minute thirty two,"`, so it is recorded with the delivery of a line that carries on.

The `lap-time-minute` clips were recorded after the best-lap intros, not these. Whether they join cleanly is judged by ear in the manual test. If they don't, regenerate the minute clips with these intros added to their `previous_request_ids`; never add a second minute pool.

"Leader" rather than "Class leader" is deliberate: it is shorter, and in a single-class session the two are the same car.

The pack catalog entry and `pack-reference.json` are regenerated. If #466's pack version is still unpublished, this rides the same bump (per the release rules). Otherwise it takes its own.

## Artifacts beyond the code

- PI: the mode and its two dropdowns in `session-info.ejs`, with conditional visibility.
- Scenario harness shortcuts:
  - a self last lap under a minute
  - car ahead, best lap, over a minute
  - class leader when you lead
  - no car behind
  - no lap time yet
  - the 10:59.9 edge, plus 11:00.0 aborting
- Website:
  - the Session Info page: the mode, its settings, the class-neighbour meaning of "ahead", and the mode-count badge
  - `changelog.mdx`: a Features line, folded into #466's line when both land in one release
- `iracedeck-actions` skill (Session Info gains a mode).
- `.claude/rules/race-positions.md`: Session Info → Lap Time joins the consumers list.
- `race-engineer-callout-examples.md`: an entry for the role-named target.
- No manifest change: Session Info is one UUID in all three plugins.

## Out of scope

- Spoken driver names, deltas and gaps (see the issue).
- Overall (cross-class) targets, and the `fastest` driver as a target.
- Automatic lap-time readouts on a timer or on a lap completion.
- A dial surface: Session Info is keypad-only.

## Testing

**Suite.**

- Session Info:
  - the display and title for each kind × target
  - `--` for no car and for no time
  - the payload for each kind × target
  - `targetFound` false for ahead-of-the-leader and behind-last
  - an unclassified player giving the no-time case
  - class neighbours in a two-class field
  - the official-order fallback outside a race
  - `null` pre-green
  - nothing published with Speak value on press off
  - the schema defaults
- Contracts:
  - each resolves to intro, then the minute (when there is one), second and decimal
  - the sub-minute case skips the minute
  - the no-time and no-car contracts fire on their own conditions and never on a fuel or temperature kind
  - 11:00.0 aborts
- The bundled script-coverage and pack-reference freshness tests pick up the new contracts, vars and clips.

**Manual (the PR gate).** In iRacing:
- In a race:
  - each target and kind shows and speaks the right car's time
  - `--` and "No car ahead." while leading your class
  - "No lap time yet." before a car's first lap and before the green
- In a multiclass session, "ahead" is the class neighbour, not the overall one.
- In practice, "car ahead, best lap" is the next faster car in class.
- Thousandths are legible at the default font size.
- Judge the intro → minute seam by ear across several intros.
