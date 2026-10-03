> **Issue:** [#1274](https://github.com/niklam/iracedeck/issues/1274) · **Supersedes:** [the #936 opponent-flag qualification window and wording](2026-08-09-opponent-flags-design.md), [#1270](2026-09-27-issue-1270-opponent-flags-my-class-only.md) · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Opponent flags: nearby cars in your class, named by car number

## Why the calls were wrong

Three #support reports on 2026-09-27 describe "The car ahead on track has a black flag." firing for cars nobody owns up to — on ovals, where there are no slowdowns, and in a single-class GT sprint. Every one of them is the `track-ahead` relation from #936: any car within about ten seconds ahead on the road, of any class or lap, announced on the first tick its `Black` bit is up.

A follow-up on 2026-09-28 points at the likelier cause: one reporter's overlay showed a slowdown on the car at the moment of the call. A slowdown is the `Furled` bit, spoken today as "The car ahead on track has a furled black flag." — easy to hear as "black flag" — and slowdowns do exist on short ovals (Irwindale inner, per another user). So the data was probably right and the calls were about cars that did not matter to the driver, worded so they sounded like something else.

Two things in the #936 design do not hold either way. A black- or furled-flagged car is not a hazard — it runs at full speed until it pits or gives the time back — so the safety argument behind a class-blind window never applied to them. And the line names nothing, so a driver has no way to check it. The fix narrows who qualifies, lets the driver set how close is close, says "slowdown penalty" for a slowdown, holds Black before speaking, and names the car.

The furled/black distinction itself is right and is kept: the `Furled` bit is the slowdown (a track-limits penalty given back on track — road courses and short ovals), `Black` is a penalty served on pit road (drive-through, stop-and-hold). The maintainer's model, 2026-09-27.

## Decisions

### Who qualifies

A flagged car qualifies only when all of these hold:

- **Same class.** In a multi-class session `CarIdxClass` must match the player's; a car whose class cannot be read does not qualify. Single-class sessions are unaffected.
- **Same lap.** The lap-progress score gap below 1.0, exactly as #936's `classify()` has it.
- **Ahead:** one to three class positions ahead **and** a race gap of at most the **range** setting. **Behind:** exactly one class position behind **and** a race gap of at most the same range. The range is 1–10 s, default 3 s (below).

The race gap is the crossing-time gap from #933 (`getLiveGapBetween(ahead, behind)` in `translator.ts`), passed into `diffOpponentFlags` as an injected resolver `(aheadCarIdx, behindCarIdx) => number | null` beside `getCalloutEnabled`, so the diff stays a pure function of its inputs. A `null` gap — traces not yet covering the lookup, either car without live progress — never qualifies. Silence is the right failure here; a guessed gap is how the old window said false things.

The gap carries #1285's ETA regime (amended 2026-10-03, after the branch review). A raw crossing-time gap overstates the distance to a car ahead that has slowed right down: a meatballed car limping at 20 m/s 70 m ahead reads about 3.5 s, outside the default range, though the player reaches it in about 1.5 s — so "Expect them to be slow" would miss exactly the cars it describes. `diffGaps` already switches to the chaser's ETA when the pair's leading car is crawling; that switch is extracted into one helper that both `diffGaps` and `getLiveGapBetween` use, so the gap displays, the gap callouts and this qualifier read the same gap for the same pair.

There is no hysteresis on the range bound. The per-(car, flag) episode latch already means a car is announced once per flag episode, so a car hovering at the bound cannot repeat; the bound only decides whether the first announce happens — including a flag already up on a car that closes into range later (`entered-range`).

### The range is a setting: 1–10 s, default 3 s

The maintainer's call on 2026-09-28, after a reporter asked for 2–3 s and said he would otherwise switch the callouts off: the #936 window was about 10 s, which is too far to matter, and how close is close is the driver's choice.

- **Key:** `opponentFlagRangeSeconds` in `GlobalSettingsSchema`, `z.coerce.number().min(1).max(10).default(3).catch(3)` — the `spotterStillThereSeconds` precedent, so a bad stored value falls back to the default rather than failing the whole settings parse. No migration: an absent key reads as 3.
- **Read live per announce**, through a resolver option on `initializeSimEventsIracing` beside the opt-in resolver, defaulting to 3 s; wired from global settings in all three plugins. A change applies to the next announce, and a flag already up on a car now inside the new range announces then (`entered-range`), as a re-enabled opt-in does.
- **Settings window:** Race Engineer tab → Callouts, directly under the **Opponent Flags** checkboxes, an `ird-range-input` labelled **Opponent flag range (s)**, `min="1" max="10" step="1" default="3"`, with supporting text: "Only cars in your class this close ahead or behind in the race are announced."
- The **Furled black flag (warning)** checkbox is relabelled **Slowdown (furled black flag)** to match what the engineer now says. The key, `calloutEnabledOpponentFlagFurled`, does not change.

The range applies to both directions. One number rather than separate ahead and behind values: nothing asks for two, and a driver reasons about "cars near me", not about each side.

`track-ahead` is deleted outright, with its pit-surface check and its 10 s / 12 s bounds. Considered and rejected: keeping a class-blind hazard warning for meatball and DQ only. The maintainer chose one rule for all four flags — a call about a car you are not racing is noise, whatever the flag.

### Black waits 3 s

`Black` must be continuously up for 3 s before it is effectively active, on the same mechanism as Furled's 1 s debounce (#669), generalised from one `furledSinceAt` array to a per-flag since-time for the two held flags. Repair and Disqualify stay immediate.

A genuine black flag lasts laps, so the hold costs nothing when the flag is real and filters any blip when it is not. No blip has been shown — the reports turned out to be slowdowns — so this is cheap insurance, not a fix for an observed fault. 3 s is a chosen value, not a measured one. The capture that sets it properly is one opponent `Black` episode recorded from its first tick, to see whether the bit ever rises briefly without a penalty behind it; the #1273 debug lines are how that capture gets found.

The Furled → Black escalation is unchanged in shape: iRacing swaps the bits in one transition, the Furled episode's latch drops with its bit, and Black then waits its own 3 s. Escalation classification (`announced & ~bit`) still reads the Furled latch of the same episode only while it is set, so an escalation that lands after the Furled bit dropped is announced as a plain Black — which is what it is to the driver.

### Event contract

`OpponentFlagRelation` becomes `"ahead" | "behind" | "others"`. The individual payload gains `carNumber` — a string from the session info's `DriverInfo.Drivers[].CarNumber`, so `09` and `9` stay different clips (#1127) — omitted when the session info has no row for the car. `gapSeconds` is now the race gap, present on every individual event since qualification requires it. `position` (class position in multi-class) stays.

This is a published contract (`code-review.md`, xhigh). Nothing outside this repo consumes the bus.

### What the engineer says

The four `…-ahead` and four `…-behind` contracts keep their ids; the four `…-track-ahead` contracts are removed. An older pack that still scripts them compiles cleanly — the script compiler skips an entry with no contract as `no contract` rather than failing.

A new var, `opponentFlag.carNumber`, resolves to `car-number/<n>` from the pending event, or to nothing when there is no number or no clip for it; a line that uses it and cannot resolve it is skipped whole, the #1127 caution pattern. The existing position var `opponentFlag.number` stays defined so a third-party pack scripted against 3.3.0 keeps its "The car in P5 …" lines — a script using a var the build no longer defines fails to compile. The default pack stops using it.

Default-pack lines, "Car" + number + tail:

| Flag | Ahead | Behind |
| --- | --- | --- |
| Furled | "Car 42 ahead has a slowdown penalty." | "Car 42 behind has a slowdown penalty." |
| Black | "Car 42 ahead has a black flag. They'll be serving a penalty." | "Car 42 behind has a black flag." |
| Meatball | "Car 42 ahead has the meatball flag. Expect them to be slow." | "Car 42 behind has the meatball flag." |
| DQ | "Car 42 ahead has been disqualified." | "Car 42 behind has been disqualified." |

The behind-black tail "That pressure should ease." is dropped: nothing eases until the car pits. The "Car" lead-in reuses a clip with the same words where the pack already has one, otherwise it is generated. The aggregate line "Several cars around us have penalty flags." is unchanged. Every line is normal weight — the safety weight existed only for `track-ahead` — and still queues behind a busier line rather than cutting it.

### #1270 is superseded

Every relation is now class-only, so the **My class only** option #1270 specified has nothing left to filter. #1270 is closed as superseded by this issue, its spec's `Superseded by:` points here, and its Discord post is moved along.

## Out of scope

- Telling a drive-through from a stop-and-hold. The per-car flags carry no such distinction.
- Announcing that an opponent's penalty was served or cleared.
- The player's own flag lines (`flags.ts`, from `SessionFlags`). Nothing reports a problem with them.
- The leader's final-lap call from #936, which follows the overall leader by design.
- Settings for the class rule or the number of positions (1–3 ahead, 1 behind). Only the range is configurable; the per-flag opt-ins stay as they are.

## Testing

Suite:

- `opponent-flags.test.ts`: a different-class car never qualifies, and one with unreadable class data does not either; positions 1–3 ahead qualify and 4 does not; one behind qualifies and two does not; a gap equal to the range qualifies and just over does not, in both directions, at the default and at a non-default range; a range change is read on the next announce and lets an already-flagged car now in range announce as `entered-range`; a `null` gap never qualifies; a lapped or lapping same-class car never qualifies; Black announces only after 3 s continuously up and a drop inside the hold announces nothing; Furled keeps its 1 s; an escalation Furled → Black announces the Black after its hold; the payload carries `carNumber` and the race `gapSeconds`, and omits `carNumber` when the session info has no row.
- `audio-scenarios`: the track-ahead contracts are gone; `opponentFlag.carNumber` resolves to the car-number clip and skips the line when it cannot; `opponentFlag.number` still resolves.
- `pnpm lint:pack` and the coverage rules pass for the default pack; `pnpm generate:pack-reference` is fresh.
- `global-settings`: `opponentFlagRangeSeconds` defaults to 3, clamps out-of-range and non-numeric stored values to 3 without failing the parse; the translator option defaults to 3 s when no resolver is passed.

By hand:

- Scenario harness: audition all eight lines plus the aggregate, including a car number the pack has no clip for.
- Settings window: the range slider saves, survives a restart, and a change takes effect in the same session; the Furled checkbox shows its new label.
- In-sim, road course: a same-class car just ahead cutting until it gets a slowdown — "Car N ahead has a slowdown penalty."; a car of another class doing the same close ahead — silence; a same-class car further ahead than the range — silence until it comes within range.
- In-sim, oval: with debug logging on, every flag call matches a car the log names, in class and within the range; on a short oval with slowdowns (Irwindale inner), a same-class slowdown in range is spoken as a slowdown penalty.
