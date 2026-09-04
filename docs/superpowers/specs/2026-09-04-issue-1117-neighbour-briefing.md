> **Issue:** [#1117](https://github.com/niklam/iracedeck/issues/1117) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: periodic briefing on the cars ahead and behind

## The problem

deanvrs asked on Discord for the engineer to talk about the cars around you, periodically: who the car in front is, the gap, their rating, whether they are a safe driver; and for the car behind whether they are catching or dropping back. Half of that shipped in 2.4.0 as the gap engine (#933): the engineer already says when a gap is closing, opening, or crossed. What he never says is *who* — and the first triage reply to the post claimed the request was mostly done, which the maintainer corrected: nothing about iRating or safety rating is spoken anywhere, and that is the part the driver acts on. A 1.5K B-licence car ahead and a 4K A-licence car ahead call for different racing, and today the driver has to read that off a black box while driving.

#944 covers one moment of this — the rating of the new car ahead, once, after a pass. This spec is the standing briefing: both neighbours, on a cadence, and whenever the neighbours change.

## What ships

In race sessions, for the car ahead and the car behind in the player's class standings, the engineer speaks one line each:

> "Car ahead: gap two point four seconds, closing. Rated one point five K, B licence, safety rating three point two."
> "Car behind: gap one point one seconds, pulling away from us. Rated two point eight K, A licence, safety rating four point nine."

Spoken every N laps (`raceEngineerBriefingLaps`, default 3) and once more when a neighbour changes. Two opt-ins, `calloutEnabledBriefingAhead` and `calloutEnabledBriefingBehind`, default on, under the Race Engineer master. A driver name is included only when a clip for it exists.

## Decisions

### 1. Both neighbours, one line each, ahead first

The post asks about both cars, and the two lines are independent: a driver with nobody behind for a lap still wants the car ahead. Each line stands alone — `Car ahead: …` / `Car behind: …` — so one can be omitted (no neighbour, opt-in off, missing clip) without the other reading oddly. Ahead first, because that is the car the driver is looking at.

### 2. Cadence plus change, never on every gap movement

The existing gap callouts are event-driven and relevance-gated; this one is the opposite — a briefing, so it is on a clock. Every N laps on `lap.completed` (the `race-status.ts` modulo shape, its own counter), default 3: often enough that a two-stint race hears it several times, rare enough that it never competes with the gap engine's own calls. A neighbour change (a pass either way, a pit stop, a retirement) re-fires it once for the side that changed, after a settle delay borrowed from #944 so a pass-and-repass does not produce two briefings. The two triggers share one cooldown so a change right after a cadence tick does not double up.

### 3. Rating and licence read from `DriverInfo`, the way #944 reads them

`DriverInfo.Drivers[].IRating` and `LicString` (e.g. `"B 3.21"`) are the sources; the translator already carries the neighbours from `getLiveRacePositions()` per `race-positions.md`, so the new payload is the same neighbour resolution plus those two fields. iRating rounds to one decimal in thousands ("one point five K"); a licence string yields the class letter and the safety rating to one decimal. Rookie is spoken as "rookie licence", Pro/WC as "pro licence". A missing or zero iRating (AI cars, a driver who has none) drops the rating clause; a missing licence drops that clause; both missing → the line is gap-only, which the gap engine already covers, so the line is skipped entirely.

### 4. Names only where a clip exists

Voices are recorded clips, so the engineer cannot say an arbitrary surname. The line takes an optional name clause using the `names` group (first names, the same clips the greetings use): when the neighbour's first name matches an entry, the line opens "Car ahead, Marco: …"; otherwise the clause is omitted and nothing is lost. #941's opt-in name collection is what grows that list; this spec does not wait for it.

### 5. Sequencing with #944 and the gap engine

Same family as the gap callouts (`gaps`), `queueable: true` at `WEIGHT.NORMAL`, so it waits behind an in-flight gap or pass callout instead of talking over it. When #944 lands, its after-a-pass line and this spec's neighbour-change line say overlapping things about the same car; the neighbour-change trigger therefore yields to #944 when both fire within the settle window, and only the cadence line carries the behind side then. Implement the yield as a shared "last briefed at" timestamp per side, not as a dependency on #944's code.

### 6. Clips

- Reuse: the gap readout numbers and "closing" / "pulling away" wording from #933; the cardinal clips 0–150 from `session-start-temp-numbers` via `poolRef` (#836) for the safety-rating integer and decimal.
- New, in a `neighbour-briefing` group: "Car ahead:", "Car behind:", "Rated", "K", "A licence" … "D licence", "rookie licence", "pro licence", "safety rating", and "point" if the decimal clip does not already exist in the temp-numbers pool. #944 plans the same rating clips; whichever lands first creates them and the other reuses.

### 7. Settings

`calloutEnabledBriefingAhead`, `calloutEnabledBriefingBehind` (booleans, default true, the `callout<Polarity><Family><Subject>` shape) and `raceEngineerBriefingLaps` (`z.coerce.number().min(1).max(20).default(3).catch(3)`), all on the Race Engineer card of the settings window. No per-field style options: the line has one shape.

## Alternatives rejected

- **Extending #944 to the car behind and to a cadence.** An event callout with a cadence bolted on; the two triggers are different shapes and would share nothing but the clips. Kept separate, with the yield in decision 5.
- **"Safe / unsafe driver" as the requester phrased it.** A verdict word needs a threshold nobody agrees on; the safety rating number is the fact, and the driver already knows what 2.1 versus 4.9 means.
- **A Session Info key showing the same data.** Useful, and a different issue; this spec is the spoken half only.

## Testing

Translator tests for the payload (rating rounding, licence parsing incl. Rookie/Pro, missing fields). Scenario tests for the cadence counter, the neighbour-change re-fire with settle, the shared cooldown, the yield window, and each omitted clause. Harness shortcuts for both lines with representative ratings. Manual: a multiclass race on hardware across a pit stop and a pass.

## Affected artifacts

- `@iracedeck/event-bus` catalog (a briefing payload, or fields on the gap-neighbour snapshot), `@iracedeck/sim-events-iracing` (the `DriverInfo` read), `@iracedeck/audio-scenarios` (the scenario, family `gaps`), `@iracedeck/audio-assets` (the new group, scoped dry-run first), `@iracedeck/deck-core` (three schema fields), the settings-window Race Engineer partial, the scenario harness (event name + two shortcuts).
- Website: the Race Engineer page gains a section; changelog entry.
- Rules: `race-engineer-callout-examples.md` gains the entry.

## Settled with the maintainer (2026-09-04)

- The cadence counts **laps**, not minutes: pit windows and stints are counted in laps here, and one unit keeps the setting simple.
- The briefing **stays quiet under caution**: the neighbours under yellow are not the ones you race on the restart, and the restart itself has its own callouts. The next cadence tick after the green speaks as normal.
