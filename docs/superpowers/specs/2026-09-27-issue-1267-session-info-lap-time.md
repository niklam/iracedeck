> **Issue:** [#1267](https://github.com/niklam/iracedeck/issues/1267) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Session Info: a Lap Time mode that speaks on press

> **Amended 2026-11-22.** #466 has shipped, so its event, setting and contract file exist and the blocker is gone; #1264 is still open and still blocks. #1688 moved every spoken lap time to the thousandth in the compact form ("one thirty-two point four five six") and said this spec should follow, so the voice now reads the same figure the key shows, from #1163's compact helpers and clips, and the intros end their own sentence. Decisions 1 and 3 and the scheduling are unchanged.

## The problem

#1264 puts other drivers' lap times into templates, for drivers who write one. #466 makes a Session Info key speak the figure it shows. Nothing shows a lap time on a key without a template, and nothing speaks one on request. Everything this needs already exists or is being built:
- #466's `telemetryReadout.requested` event, its **Speak value on press** setting (`speakOnPress`) and its scheduling (shipped)
- #1264's lap-time reader (open)
- the canonical order and its class-neighbour resolver (#933)
- the compact lap-time clips every first-party voice ships, `lap-time-clock` (600) and `lap-time-thousandths` (1,000) plus `lap-time-second` under a minute, which the best-lap, fastest-lap and every-lap calls use to speak any time up to 10:59.999 (#1163, #1688)

This spec builds on the #466 spec (`2026-09-26-issue-466-telemetry-readout.md`, as amended to Session Info) and changes none of its decisions.

## What ships

A fifteenth Session Info mode (there are fourteen today), **Lap Time**, with two settings:

| Setting | Values |
| --- | --- |
| **Lap** (`lapTimeKind`) | Last (default), Best |
| **Driver** (`lapTimeTarget`) | You (default), Car ahead, Car behind, Class leader |

The key shows the time as `1:32.456` (`58.123` under a minute) under a title naming what it is: `LAST LAP` / `BEST LAP` for you, `AHEAD` / `BEHIND` / `LEADER` over `LAST` / `BEST` for the others. With no such car, or no time yet, it shows `--`.

Pressing it speaks the figure, as #466's **Speak value on press** does for every Session Info mode:

> "Your last lap. One thirty-two point four five six."
>
> "Car behind, best lap. One thirty-one point eight."
>
> "Leader, last lap. Fifty-eight point one two three."
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

The display keeps thousandths, like iRacing's timing screens and the template variables, and since #1688 the voice reads the same thousandths. It sizes through the mode's existing text sizing and font-size setting. Legibility at the default size is judged in the manual test; if it fails, the fallback for the key is hundredths, not a new layout; the voice stays at the thousandth.

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

The shipped payload is the named `TelemetryReadoutRequest` in `packages/event-bus/src/event-catalog.ts`; this adds `last-lap` / `best-lap` to `TelemetryReadoutKind`, `seconds` to `TelemetryReadoutUnit`, and `target` / `targetFound` to the type.

- For #466's four kinds, `target` is `null` and `targetFound` is `true`.
- For a lap kind, `targetFound: false` is the "no car" case of decision 1, and `value` is then `null`.
- A role, not a car index, crosses the bus. That keeps the payload sim-agnostic and lets the contracts pick the intro from `kind` × `target`.
- The value is captured at press time, and with no telemetry nothing is published (#466 decisions 1 and 2).

This is an additive change to #466's catalog entry, which has shipped. The event-bus catalog is a published contract, so it is reviewed at that level.

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
| `readout.lapClock` | `compactClockRef(t, "thousandths")` from `lap-time-readout.ts`: `lap-time-clock/<m>m<ss>`, or `lap-time-second/<s>` under a minute |
| `readout.lapThousandths` | `compactThousandthsRef(t)`: `lap-time-thousandths/<ddd>` |
| `readout.noCarLine` | `telemetry-readout/no-car-ahead` or `no-car-behind` |

A script reads `["{{readout.lapIntro}}", "{{readout.lapClock}}", "{{readout.lapThousandths}}"]`, the shape of #1688's best-lap entry. The two vars share one rounding with the other lap calls, so 1:23.4566 is "one twenty-three point four five seven" on a key press as after a lap. (Amended 2026-11-22; the first draft used #555's full sentence at the tenth — `readout.hasLapMinute`, `readout.lapMinute` / `lapSecond` / `lapDecimal` over `splitLapTime` — and rounded the voice to tenths while the key showed thousandths. #1688 retired that form from every first-party lap call and asked this spec to follow.)

A time with no clock clip (11 minutes or more) aborts the callout, per #836. No range is checked in code.

**Scheduling and gating are #466's, unchanged:**
- weight `READOUT_WEIGHT` (`WEIGHT.NORMAL - 10`) and `queueable: true`
- no family
- gated by the Race Engineer master switch and the key's own **Speak value on press**

### 5. Clips: eleven lines per voice, no numbers

In every first-party voice — `configs/default.voice.json` (Shawn) and `configs/shawn.voice.json` (Shawn (Short callouts), #999) — group `telemetry-readout`, each voice in its own wording (Shawn's below; the texts are approved by Niklas before generating and the clips on a review page):

| Clip | Text |
| --- | --- |
| `last-lap-self`, `best-lap-self` | "Your last lap.", "Your best lap." |
| `last-lap-car-ahead`, `best-lap-car-ahead` | "Car ahead, last lap.", "Car ahead, best lap." |
| `last-lap-car-behind`, `best-lap-car-behind` | "Car behind, last lap.", "Car behind, best lap." |
| `last-lap-class-leader`, `best-lap-class-leader` | "Leader, last lap.", "Leader, best lap." |
| `lap-no-time`, `no-car-ahead`, `no-car-behind` | "No lap time yet.", "No car ahead.", "No car behind." |

Each intro ends its own sentence and carries no `next_text`. The compact clock clips were cut to follow an intro that ends its sentence (#1163 revision 6; #1688 decision 2 re-cut "That lap was." for the same reason), so these join them the way "Last lap was." does in the every-lap call; the intros are conditioned like that one (`previous_request_ids` on a sibling intro, seed omitted). The seam is still judged by ear in the manual test, and a bad join is fixed by re-cutting the intro, never by adding a second clock pool. (Amended 2026-11-22: the first draft's comma-ended intros with `next_text`, and its plan to condition the `lap-time-minute` clips on them, belonged to the full sentence #1688 retired.)

"Leader" rather than "Class leader" is deliberate: it is shorter, and in a single-class session the two are the same car.

`bundled-scripts.test.ts` fails unless both first-party voices script the three new contracts. Both packs take a version bump; their catalog entries and pack records, and `pack-reference.json`, are regenerated (per the voice-pack release rules).

## Artifacts beyond the code

- PI: the mode and its two dropdowns in `session-info.ejs`, with conditional visibility.
- Scenario harness shortcuts:
  - a self last lap under a minute
  - car ahead, best lap, over a minute
  - class leader when you lead
  - no car behind
  - no lap time yet
  - the 10:59.999 edge, plus 11:00.000 aborting
- Website:
  - the Session Info page (`docs/actions/display-session/session-info.md`): the mode, its settings, the class-neighbour meaning of "ahead", its row in the Speak value on press section, and the mode-count badge (14 → 15)
  - a `Features` changelog fragment in `changelog.d/`
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
  - each resolves to intro, then the compact clock and the thousandths, in both first-party scripts
  - the sub-minute case reads `lap-time-second` as its clock; 59.9996 carries to `1m00` / `000`
  - the no-time and no-car contracts fire on their own conditions and never on a fuel or temperature kind
  - 11:00.000 aborts
- The bundled script-coverage and pack-reference freshness tests pick up the new contracts, vars and clips.

**Manual (the PR gate).** In iRacing:
- In a race:
  - each target and kind shows and speaks the right car's time
  - `--` and "No car ahead." while leading your class
  - "No lap time yet." before a car's first lap and before the green
- In a multiclass session, "ahead" is the class neighbour, not the overall one.
- In practice, "car ahead, best lap" is the next faster car in class.
- Thousandths are legible at the default font size.
- Judge the intro → clock seam by ear across several intros, in both voices.
