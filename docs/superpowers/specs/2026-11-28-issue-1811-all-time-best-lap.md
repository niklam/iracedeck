# The player's all-time best lap per car, track and conditions

> **Issue:** [#1811](https://github.com/iracedeck/iracedeck/issues/1811) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Measured at `4a0683682`.

## The problem

The issue's Goal settles the product: keep the player's best lap per driver, car, track configuration and conditions, and when a lap beats it, say "That was your all-time fastest lap here." (or "… fastest wet lap here."), the time, and by how much, in place of the session best-lap line (Niklas, 2026-11-28). Wet is `TrackWetness` 4–7, as in #1810.

What exists: `lap.completed` (`packages/event-bus/src/event-catalog.ts`) carries a counted lap's time, `isBest` (iRacing's own session best moved to this lap, #1582) and `lapIsValid`. One rule, `playerLapOwner` (`packages/audio-scenarios/src/catalog/pit-crew/lap-announcement.ts:61-71`), decides on the payload which of three contracts reads the lap: the fastest lap of the race (marked `isClassFastestLapOfRace`, paired with `fastestLap.set`, #1571), the best lap (#555), the every-lap call (#1163). Nothing keeps a lap past the session. #1810 adds the sim-neutral model (`@iracedeck/personal-bests`), the store, the combination identity and the seeding (`docs/superpowers/specs/2026-11-28-issue-1810-sector-bests.md`, decisions 3–6); this issue adds laps to them, which is why it ships after #1810.

The design was reviewed by the `architect` agent with #1810's; its findings on this spec (the precedence follows #1571 exactly, the lap window closes at the lap diff's own crossing, the model is sim-neutral) are folded in.

## Decisions

### 1. Which laps count: iRacing's verdict, not under caution, driven by the player, in one kind of conditions

A player's lap is a **candidate** when it is a counted lap (`lapIsValid` not `false`, #1582: iRacing's verdict, the one the session best already follows), it does not carry `wasCaution`, and the player was in the car (`liveOnTrack`) on every tick of it, so a lap a team-mate drove is never the user's record. Every session kind counts, qualifying included.

Its **conditions** are `personal-bests`' `classifyConditions` over every tick's `TrackWetness`: `"wet"` (all 4–7), `"dry"` (all 1–3) or `"mixed"`, which never sets or is compared with a record. Rounding and the 0.001 s rule are the model's, as for sectors.

### 2. The lap's window closes where the lap diff closes the lap

`diff/lap-bests.ts` keeps, in its own slice, the lap's wetness readings and whether the player drove every tick. It does not detect the line itself: the lap diff already latches per-lap facts on the tick the counter moves, "so the emission's wait cannot leak the next lap's" (`laps.ts` header: `wasCaution`, `isOutLap`, `isInLap`), and `lap.completed` is emitted up to three seconds later. So `diffLaps` hands its counter crossing (`lapCrossing`) to the lap-bests step as a value; the step closes the window there and opens the next, and the verdict, made when `diffLaps` builds the counted lap, reads the closed window. One reader of "the player crossed the line", as the 2026-11-21 review's item 3 asks.

### 3. The verdict rides on `lap.completed`, paired with `lapBest.set`

The verdict is the model's: `personal-bests`' tracker gains the lap records, per `dry` / `wet`, seeded by the one `loadPersonalBests` call #1810 adds, with no verdict until the loader has answered. `diffLaps` asks it, through `diff/lap-bests.ts`, as it builds the player's counted lap, so the marker and the event come from one decision. When the candidate beats the record for its conditions, or is the combination's first, the translator publishes:

```typescript
/** Payload of `lapBest.set` (issue #1811). */
export type LapBestSet = {
  lap: number;
  /** Seconds, rounded to the thousandth. */
  time: number;
  conditions: "dry" | "wet";
  /** The all-time best it beat; null = the combination's first counted lap in these conditions. */
  previous: number | null;
  combo: PersonalBestCombo;
};
```

and the same lap's `lap.completed` carries `isAllTimeBest?: true` exactly when `previous` is set (a first time is recorded, not announced). The pairing rule is #1571's, written on the field: a `lap.completed` carrying it is paired with exactly one `lapBest.set` of the same `lap` with `previous` set, none is published without it, and the order of the two on the bus is not guaranteed.

### 4. The store: a laps section beside the sectors

`@iracedeck/personal-best-store` gains `laps: { dry: Rec | null, wet: Rec | null }` in the same file and envelope (#1810 decision 5), merged on write by the minimum, and `recordLap(event)`, which `plugin-runtime`'s phase subscribes to `lapBest.set`. `load(combo)` answers both sections, so #1810's seeding is the one seeding. A lap record does not depend on the sector layout: a layout change moves only the sectors section.

### 5. The call: #1571's shape, the all-time best above the session best

A new contract, `pit-crew.all-time-best-lap`, triggers on `lapBest.set` with `previous !== null`, as #1571's contract triggers on `fastestLap.set`, and reads its time, conditions and improvement from that payload. `LapOwnerFlags` gains `allTimeBest` (its opt-in and whether the active voice scripts it), and `playerLapOwner` ranks, first that applies:

1. the fastest lap of the race (`isClassFastestLapOfRace`), unchanged: the race's news is time-critical and about the field;
2. **the all-time best lap**, from `isAllTimeBest` on the payload;
3. the best lap, from `isBest` / `isFirstValid`;
4. the every-lap call.

The rank is decided on the payload, never by which event reaches the bus first, as the lap-time family's header requires (`lap-time.ts:5-12`); the pairing is a translator guarantee the rule names, so no resolver reads the paired event and no lap is left without an owner. A lap still says one lap time.

### 6. Setting: one, in the lap-time family, on by default

`calloutEnabledLapTimeAllTimeBest`, labelled "All-time best lap", in `families/lap-time.ts`, default on (new Race Engineer functionality defaults on). Off, `playerLapOwner` skips the rank and the lap falls to the best-lap line. It is independent of the best-lap setting, so a driver can keep records and silence session bests. It decides speaking only; records are kept regardless.

### 7. The wording, both voices: draft, for Niklas's approval before any clip is generated

The lap time is read in the compact form to the thousandth (#1688, `lap-time-readout.ts`), the improvement as #1810 reads a sector's (decision 9 there). Default voice:

- "That was your all-time fastest lap here." + "One twenty three point four five six." + "It was point three one two faster than your previous best."
- "That was your all-time fastest wet lap here." + the time + the same.

Short Calls voice:

- "All-time best lap." + the time + "Up point three one two."
- "All-time wet best lap." + the time + the same.

"It was", "faster than your previous best." and "Up" are #1810's clips; only the two lead lines per voice are new.

### 8. Artifacts beyond the code

- `event-bus`: `lapBest.set`, `LapBestSet`, `isAllTimeBest` on `CountedLapCompleted` with its pairing rule.
- `personal-bests`: the lap records in the tracker.
- `sim-events-iracing`: `diff/lap-bests.ts` and its slice, `diffLaps` handing `lapCrossing` and asking for the verdict; `CLAUDE.md`.
- The store and its `CLAUDE.md`; `plugin-runtime`'s phase subscription.
- `audio-scenarios` (`LapOwnerFlags`, `playerLapOwner`, the contract), `callout-settings`, both voice packs (clips, scripts, catalog, a `version` bump), the scenario harness (a shortcut per line, one with the setting off, one on a fastest-lap-of-the-race lap).
- Website: the Race Engineer page's lap-time section, the pack reference, a `Features` changelog fragment; `race-engineer-callout-examples.md`.

## Approaches weighed and rejected

- **A resolver from the catalog to the paired event.** The rank would depend on which event was dispatched first, and every lap-time contract would have to ask it alike; #1571's marker-plus-trigger shape needs neither.
- **Deciding the all-time verdict in the catalog.** It has no file and no combination; the store would become a catalog dependency.
- **A lap window reset at a line crossing of its own.** A second rule for "the player crossed the line", mixing two laps' ticks across `lap.completed`'s wait.
- **Speaking the all-time line after the session best-lap line.** Two lap lines, the time read twice.
- **Ranking the all-time best above the fastest lap of the race.** In a race the field's fastest lap is the news that changes what the driver does; the record is still kept.
- **Requiring the lap to be iRacing's session best too.** A wet record set after a dry session best is a real record that is not a session best.

## Out of scope

- Session-best wording: #555's line, unchanged, with no improvement delta.
- Viewing or resetting records; tyre compounds, setups, fuel and track updates (#1810's out of scope).
- Other cars' records, and the fastest lap of the race (#1571).

## Testing

- `lap-bests.test.ts`: the window closed at the handed-in crossing, a tick after it belonging to the next lap even while `lap.completed` waits; a candidate refused on `lapIsValid: false`, `wasCaution` and a tick out of the car, each with its twin; nothing on a replay.
- `personal-bests` tests: lap records per conditions, the 0.001 s rule, a first time with `previous: null`, no verdict before the loader answers.
- `laps.test.ts`: the marker and the event agree on every fixture, and the existing lap tests pass unchanged without a loader.
- The store's tests: the laps section merged by the minimum between two processes, untouched by a sector layout change.
- `lap-time-precedence.test.ts` extended: the owner for every combination of the four marks, the four settings and whether the voice scripts each contract; the lap time read alike by each; the all-time contract speaking whichever of `lap.completed` and `lapBest.set` arrives first.
- Harness shortcuts (Harness → Lap times): all-time dry, all-time wet, all-time with its setting off (the best-lap line), all-time on a fastest-lap-of-the-race lap (the race line).
- **Manual check in iRacing:** offline practice at a track and car with a record from #1810's check: beat the lap and hear the all-time line in place of the best-lap line; a slower session best gives the ordinary best-lap line; the file gains its laps section; a wet session writes the wet slot only.
