> **Issue:** [#1119](https://github.com/niklam/iracedeck/issues/1119) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: faster-class car closing from behind

## The problem

schumi77 asked on Discord for alerts when faster classes come up behind. The maintainer's first instinct — "isn't this the blue flag?" — was answered in the thread: the blue flag shows at roughly a second, and Racelab's overlay starts counting from several seconds out, which is when a driver can still choose where to be passed. Nothing in the engineer's vocabulary covers that window. The gap engine (#933) tracks the class-standings neighbours only, so a faster-class car lapping through is invisible to it by design, and the blue-flag callouts (#467, #463) fire when the sim raises the flag, not before.

## What ships

In a multiclass session, for each faster-class car behind on track that is closing:

> "Faster car closing, ten seconds."

at the notice window (`fasterClassNoticeSeconds`, default **10**, set by the maintainer above the 5 s first proposed), and once more at about three seconds if it is still closing:

> "Faster car, three seconds."

Then nothing: the blue flag and its own callout take over. One opt-in, `calloutEnabledFasterClassApproaching`, default on, under the Race Engineer master.

## Decisions

### 1. Track-relative, per car, on the #1113 arrival model

A faster-class car is traffic wherever it stands in the results, so the measurement is on the road, not in the standings. Time-to-catch is the #1113 arrival model applied to a moving reference point: the player's own `CarIdxEstTime` is the point, the faster car's `CarIdxEstTime` behind it (wrapped at the line) is the gap in reference time, and the closing rate is that gap's smoothed derivative over roughly the last third of a lap — the same smoothing the gap engine uses, reused rather than copied. A car counts only when the gap is shrinking; a faster car holding station or dropping back is not coming.

This depends on #1113 landing first and lifting the arrival model into a shared module the two can both call. Building a third gap calculation was rejected: the repo already has two and does not want a third.

### 2. Faster class means a shorter reference lap

`CarClassEstLapTime` per class from `DriverInfo`: a class whose reference lap is shorter than the player's is faster. Class id order is not used — it is not guaranteed to be pace-ordered. In a single-class session nothing is ever faster, so the feature is silent without a setting.

### 3. Two steps, then silence

The notice line at the window, one follow-up at about three seconds, and then the blue flag. Two steps because one is a heads-up and the second is "now": more would turn into the spotter. The three-second follow-up is fixed rather than a setting — it is the hand-off point to the sim's flag, not a preference. If the blue-flag callout fires first (a car closing very fast), the follow-up is skipped: a shared per-car "last spoken" stamp prevents both within a few seconds.

### 4. Armed per car, per approach

Each faster car has its own state: armed → noticed → followed-up → done. It returns to armed only after the car has passed, or after its time-to-catch has been above the window for a full lap — so a faster car pitting behind you, or one you re-pass under yellow, does not repeat the warning every time the number twitches around the threshold.

### 5. What is spoken

"Faster car closing", then the seconds from the existing cardinal clips (`session-start-temp-numbers` via `poolRef`, #836), rounded to the nearest second. No class name: voices are recorded clips and class names are open-ended (#1117 decision 4 states the same limit for driver names). Same family as the traffic engine, `queueable: true` at `WEIGHT.HIGH` — a ten-second notice that waits behind a thirty-second gap monologue arrives at four seconds, so it may preempt the gap engine's lines but never the pit-speeding cue or a flag.

### 6. Settings

`calloutEnabledFasterClassApproaching` (boolean, default true, the `callout<Polarity><Family><Subject>` shape) and `fasterClassNoticeSeconds` (`z.coerce.number().min(3).max(30).default(10).catch(10)`), both on the Race Engineer card. The minimum is above the follow-up point so the two steps cannot collapse into one.

## Alternatives rejected

- **A generic "car behind" warning.** In a single-class race the car behind is a rival, and the gap engine already speaks about it with far better judgement.
- **Extending the blue-flag reminder (#463).** That loop starts at the flag; this ends there.
- **Counting down every second from the window.** The spotter's job, and noise on the radio.

## Testing

Translator tests: faster-class classification from `CarClassEstLapTime`, time-to-catch for a car behind across the line, closing versus holding. Scenario tests: the two steps, per-car arming and re-arming after a pass and after a lap above the window, the blue-flag hand-off, the opt-in and window. Harness: a shortcut that drives one faster-class car from 15 s to 0 s behind. Manual: a multiclass race on hardware, being lapped twice.

## Affected artifacts

- `@iracedeck/sim-events-iracing` (faster-class detection, the arrival call — after #1113), `@iracedeck/event-bus` (a `traffic.fasterClassClosing` payload), `@iracedeck/audio-scenarios` (the scenario), `@iracedeck/audio-assets` (two lines, scoped dry-run first), `@iracedeck/deck-core` (two schema fields), the settings-window Race Engineer partial, the scenario harness.
- Website: Race Engineer page section; changelog entry.
- Rules: `race-engineer-callout-examples.md` gains the entry.
