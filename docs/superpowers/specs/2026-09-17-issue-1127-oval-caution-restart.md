# The caution restart, narrated

> **Issue:** [#1127](https://github.com/niklam/iracedeck/issues/1127) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

A full-course caution gets a narrated sequence of its own: the caution out, the pace car, who to follow, the laps behind the pace car, one to go with the restart lineup, and the green. It is built on seven new bus events emitted by a new translator module, and it runs on every discipline rather than only on ovals.

#1127 was filed as one wrong line — "Yellow cleared." landing three seconds into a restart. That half is fixed and is not this spec's subject (`state.yellowEpisodeFullCourse` in `diff/flags.ts`: the validated clear is announced only for an episode that stayed LOCAL, and a green rising edge cancels a pending clear). The issue's second half — what an oval caution *should* say — is what follows, and a 2026-09-17 measurement session settled the signals it rests on.

The framing ruling is that the Race Engineer is a **standalone** replacement for iRacing's own spotter, not a supplement (Niklas, 2026-09-17). "iRacing already calls that out" is a reason to cover a moment, never a reason to skip it: drivers increasingly turn the sim's spotter off because iRaceDeck does the job better, so anything deferred to the sim becomes silence for exactly those users. This reverses the reasoning in the issue's own comment thread, which had deferred the lap countdown to iRacing's spotter.

## What was measured

Two sessions on 2026-09-17, both offline AI races at Homestead-Miami in the ARCA car — a paved oval, `WeekendInfo.Category = "Oval"`, `TrackType = "medium oval"`, `TrackDirection = "left"`. Cautions were thrown with the Race Admin `!yellow` command and manipulated with `!pacelaps +1`, `!restart double`, `!pitopen` / `!pitclose`, so the sequence is reproducible without waiting on an AI wreck and without oval skill.

The load-bearing capture is `local/telemetry-watch-20260917-191825-092.jsonl` (`pnpm telemetry-watch`, `--mode=changes`): a rolling double-file start, two cautions and two double-file restarts. Its `SessionFlags` transitions, with `SessionState` 4 = Racing and `PaceMode` 1 = DoubleFileStart, 2 = SingleFileRestart, 3 = DoubleFileRestart:

| `SessionTime` | `SessionFlags` | Meaning |
| --- | --- | --- |
| 186.28 | `0x20040600` OneLapToGreen\|GreenHeld\|Servicible\|StartReady | formation, 15 s before the start |
| 201.18 | `0x80040604` Green\|OneLapToGreen\|GreenHeld\|Servicible\|StartGo | the race start, one tick |
| 218.88 | `0x10040000` Servicible\|StartHidden | green flag withdrawn, 17.7 s after |
| 239.88 | `0x10048000` CautionWaving\|Servicible\|StartHidden | `!yellow`; `PaceMode`→2 and every pace row assigned 50 ms later |
| 333.57 | `0x10044000` Caution\|Servicible\|StartHidden | waving→static: the pace car has picked up the field |
| 415.12 | `0x10044200` +OneLapToGreen | one to go; `PaceMode`→3 and the field re-forms double file on the same tick |
| 477.77 | `0x10044600` +GreenHeld | 15 s before the green |
| 492.82 | `0x80040004` Green\|Servicible\|StartGo | **the restart** — every caution bit drops on this one tick |
| 542.75 | … | the second caution repeats the shape, restarting at 872.45 |

Findings, and the three that corrected earlier beliefs:

1. **A restart carries `StartGo`.** `diff/flags.ts` suppresses `flag.green.raised` while that bit is set, so the green-flag callout has never spoken at a restart; `pit-crew.start-light-go` ("Go, go, go!") did. The code comment asserting "restarts have neither bit set, so green still fires" (#480) was wrong, as were the website Green bullet, the `flag-green` contract description, the voice-pack authoring table and the #480 entry in the callout-examples catalog. All corrected on the branch.
2. **`PaceMode` is sticky.** It never read `NotPacing` in the whole capture — it holds the last pacing mode straight through green-flag running. The signal for *actively pacing* is `CarIdxPaceLine` / `CarIdxPaceRow`, which go to −1 car by car over about 5 s after the green.
3. **The pickup is a flag de-escalation, not a new yellow.** `Caution` rising while `CautionWaving` falls, landing on the leader's start/finish crossing about 90 s in. Today that fires `flag.yellow.raised{full}` → "Full course yellow, pace car will be deployed." — a lap late, promising a pace car that is already leading the field.
4. **One to go is a real signal**: `OneLapToGreen` rising while `SessionState` is Racing, with `PaceMode` → DoubleFileRestart and `PitsOpen` → true on the same tick, at the leader's crossing (about 3 s before a mid-pack car's).
5. **`GreenHeld` means the green is imminent** — 15 s before the green at the start and at both restarts. It does not mean a delayed green, and an added pace lap never set it. The existing "green held" line is therefore correct as written.
6. **The pace car's own `CarIdxTrackSurface`** is on-track about 20 s after the throw and `ApproachPits` about 5 s before every green — at the rolling start as well as both restarts.
7. **The lineup is known immediately**: all 21 rows are assigned within 50 ms of the caution flag. Nothing changed at the pickup; the whole field re-formed double file at one to go. No car changed row mid-caution, because nobody pitted — so a mid-caution reorder is designed for but unobserved.
8. **Line 0 holds the pole sitter and the leader**, and in both restarts the player (an odd position) was on line 0. Line 0 is taken to be the inside line. Unconfirmed physically; accepted because no right-handed oval is known.
9. **Two to go and "caution extended" have no signal.** `!pacelaps +1` changed no flag and no pace mode, and no session-info field carries a caution-lap count (`ResultsNumCautionFlags` / `ResultsNumCautionLaps` stayed 0 mid-caution). iRacing accepts an extension only after a full lap behind the pace car, so the pre-pickup press in the second caution was ignored and the post-pickup one counted; the default at the pickup is two laps.
10. **`CarIdxPaceFlags` stayed 0 for every car** in both sessions — `FreePass` (the lucky dog) and `WavedAround` are still unobserved, and no car was ever lapped.

The first session additionally explained the reported symptom "no audio when the caution is thrown": `pit-crew.flag-caution-waving` fired 0.8 s after `!yellow` and was **dropped (bus busy)** because the spotter held the bus with "car outside". It is not queueable, so it was discarded rather than deferred; the queueable "Pits are closed" played instead. In the second session, with the bus free, the same call played normally.

## What the driver hears

| Moment | Call |
| --- | --- |
| Caution out | "Caution! Caution! Yellow flag is out." — the existing call, retexted, no longer promising the pace car |
| Caution out | "Single file. Line up behind car number oh nine." — or, leading, "You're leading them — you'll be behind the pace car." |
| Pace car reaches the track | "Pace car's out." |
| Two to green (ovals) | "Two to green. Make sure to follow car oh nine." |
| A lap that is not one to go | "Another lap under caution." / "We're going around again." |
| One to green | "One to green. Take the inside line behind car oh nine." |
| ~35% into the one-to-green lap | "We're currently P fourteen." |
| The car ahead changes | "Change — you're on the inside behind car number twelve now." |
| Pace car leaves, once one to green is up | "Pace car's off." |
| Restart | "Green, green, green! Go, go, go!" |

Several wordings each, as everywhere else in the catalog. The final text is settled at clip-generation time, from a dry run reviewed before anything is recorded.

The inside/outside wording appears **only on ovals** and only while double file — on any other discipline, and before one to go, the line names the car without claiming a side. Every call that names a car number does so at the END of the sentence, matching how race positions are already spoken.

No lap count is spoken beyond "two to green" and "one to green", and each is spoken only where a flag says it. "Two to green" rides the waving-to-static transition, which on an oval is the pace car finishing its pickup lap — one leader crossing before one to green. An extension is still undetectable in advance and possible from any admin in the session, so the engineer never promises a count past that: at each leader crossing after the pickup the one-to-green flag either comes or it does not, and its absence *is* the extension, reported as it happens.

**Amended 2026-09-18, after the maintainer heard it and after the first road-course caution was captured** (`local/telemetry-watch-20260918-185032-545.jsonl`). What changed and why:

- **The pickup call no longer announces a position, and no longer says we caught the pace car.** Announcing the position there sounded bad and added little. And the moment it rides is not "we caught up": `Caution` rising as `CautionWaving` falls marks the pace car finishing its pickup lap, however far from it any given car is. On an oval that is exactly one leader crossing before one to green, so the call is **"Two to green."**, followed by the car to follow.
- **The position moved to its own call, at about 35% into the one-to-green lap** — the normal position wording ("We're currently P fourteen"), read from the pace-row restart order for the reason the carve-out below gives. A new event, `caution.lastLapCheckpoint`, marks the moment: the player's lap distance rises through 35% for the first time after `caution.oneLapToGreen`, while still under caution. The whole call sits in one `optional` clause, and here that is correct rather than the empty-sequence defect: a position call with no position has nothing true to say.
- **"One to go" becomes "One to green"**, pairing with "Two to green".
- **On a road course "Two to green" has no moment, so it is not spoken there.** The road capture never shows a waving caution going static on its own: at 309.33 s it drops straight from `CautionWaving` to `Caution | OneLapToGreen` on one tick, which as first built would have said "Two to green" and "One to green" back to back. The pickup call therefore stays silent whenever one to green rises on the same tick. On an oval the two are a lap apart and nothing changes. Timing-wise the road course's two-to-go moment is the leader's first crossing during waving (160.05 s there), but no flag marks it, and one capture is not enough to infer from.
- **"Pace car's off" speaks only once one to green is up.** On the road course the pace car's `AproachingPits` means two opposite things. That start was a standing start, so the pace car never ran on the road; it waited parked, and **iRacing reports a waiting pace car as `OnTrack`** (its surface reads `OnTrack` from the first record, and its `CarIdxLapCompleted` stays −1 for the whole capture). Mid-caution it shows `AproachingPits` for about three seconds and then `OnTrack` again (152.23→155.37 s, and 562.07→565.22 s in the second caution): that is the pace car **rolling out through pit exit onto the circuit — the deployment, not a departure** (corrected by the maintainer, 2026-09-18). Read literally, the first half said "Pace car's off" at the very moment the pace car arrived. The real exit, on both tracks, comes after one to green (461.22 s there, 5.7 s before the green), so gating "off" on one to green tells the two apart and delays nothing. "Pace car's out" at 155.37 s is therefore right, and is the road course's deployment moment — later than the oval's ~20 s because the pace car starts from a standstill. A debounce was rejected: waiting five seconds for a return would push the real exit call to half a second before the green.
- **`paceCar.deployed` also fires when the pace car parks again.** At 494.18 s, under green, the pace car returns to its waiting spot and reads `OnTrack` again, so the generic event reports a "deployment" that is really the pace car parking. No callout speaks it (the caution calls speak only under a caution), but it means `OnTrack` for the pace car is not "on the circuit", and anything that reads that event outside a caution has to know it.
- **The road capture also confirms things the design assumed from the oval alone**: the restart carries `StartGo` there too, so standing the start-lights "go" down for a restart holds off ovals; the pace car is car index 64 there as well; every car gets a pace row at the throw; and a leader crossing during waving raised no false extra lap.
- `caution.fieldCaught` keeps its name, since the signal (the pace car has picked the field up) is unchanged and only what the engineer says about it moved. Its `restartPosition` payload goes, because nothing reads it any more; the fallback value now rides `caution.lastLapCheckpoint`.

## The events

A new module, `packages/sim-events-iracing/src/diff/caution.ts`, owns one state machine per caution — thrown → pace car out → field caught → extra laps → one to go → restart — reading the caution bits, the pace car's track surface, the pace arrays and the leader's crossings. `diff/flags.ts` keeps its present job; `diff/pace-laps.ts` cannot collide, being gated to `SessionState === ParadeLaps`, which a mid-race caution never re-enters.

| Event | Fires when |
| --- | --- |
| `paceCar.deployed` | the pace car's track surface becomes on-track — caution, rolling start, or any other reason |
| `paceCar.off` | it becomes `ApproachPits` / pit road |
| `caution.fieldCaught` | `Caution` rises as `CautionWaving` falls: the pace car has finished its pickup lap |
| `caution.extraLap` | a leader crossing after the pickup that is not one to go |
| `caution.oneLapToGreen` | `OneLapToGreen` rises while racing under caution |
| `caution.lineup.changed` | the car to follow changes |
| `caution.lastLapCheckpoint` | the player's lap distance rises through 35% for the first time after `caution.oneLapToGreen`, while still under caution |
| `caution.restarted` | the green that ends a full-course caution |

The two pace-car events are **deliberately generic**: nothing about "the pace car reached the track" is caution-specific, and the capture shows the identical pair of transitions at a rolling start. Whether the engineer speaks at a given occurrence is the callout's business — under a caution it says "Pace car's out"; at a rolling start the existing "green held" call already owns that moment, so the new calls stay quiet there.

There is deliberately **no `caution.thrown`**: the caution coming out is already `flag.caution-waving.raised`.

**The lineup is read at speak time, never frozen into a payload.** A new translator reader answers, for the current tick: the car number ahead of you in the lineup, its side (inside / outside / none), whether you are leading, whether the field is double file, the position you would restart in, and whether a full-course caution is out at all.

**The lineup comes from `CarIdxPaceRow` / `CarIdxPaceLine`, and the restart position with it — not from the canonical live running order.** This is a deliberate, documented exception to `@.claude/rules/race-positions.md`, which otherwise requires every position to come from `getLiveRacePositions`. The pace row *is* the restart order, it is what iRacing lines the field up by, and the capture shows the two disagreeing: early in the first session's caution the player's pace row was 14 while the official position still read 11, converging a lap later. A follow-car call built on the running order would name the wrong car for that whole lap. The rule file gains a sentence carving this out, so the next reader does not "fix" it back.

The car to follow is the car in your line one row lower; if there is none, it is the pace car. That formula holds for both shapes — single file, where the pace car is row 0 and cars run 1..N, and the double-file re-form, where each row holds two cars. The event payloads carry the same values only as a fallback, following the `opponentFlag.number` precedent. This matters because the captures show a call waiting seconds behind the spotter while the field re-forms in under one.

## Vocabulary

Registered with descriptions, as every vocabulary entry must be:

- `caution.followCarNumber` — the car number to follow, drawn from a new `car-number` clip group. Part of the sentence, so a number a pack cannot resolve drops to a numberless wording rather than leaving a gap.
- `caution.restartPosition` — from the existing `position-number` group.
- `caution.isLeader`, `caution.isDoubleFile`, `caution.followsPaceCar`, `caution.hasFollowCarNumber` — conditions.
- `caution.line` — a case: `inside` / `outside` / absent.

**Amended during implementation (2026-09-18), as the policy allows while the work is unshipped.** Two changes the code review forced, recorded here so the spec does not describe something that was built differently:

- The `caution.oneLapToGreen` payload **carries no single-/double-file field**. One was specified and built, and nothing ever read it: the one-to-go script branches on the live lineup (`caution.isDoubleFile`, `caution.line`) rather than on the event, because the lineup is read at speak time and the payload would be a second, staler answer to the same question. A published catalog field with no consumer has to be maintained forever and a pack author cannot reach it, so it and its `PaceFile` type were removed rather than left as a trap.
- `caution.hasFollowCarNumber` is a **new condition**, and it exists because of a defect this spec's design made easy to write. Every line that names the car ahead sat inside an `optional` clause, so when the number could not be resolved the whole callout expanded to nothing — and "One to go", the most time-critical call in the sequence, played silence. A condition lets the script take a numberless branch instead of losing the sentence. The lesson generalises past this issue: an `optional` clause is safe only when something outside it still speaks.

## Changes to behaviour that already ships

In the translator:

- The waving→static de-escalation no longer emits `flag.yellow.raised{full}`. It is the pickup, and `caution.fieldCaught` owns it. A full-course caution that begins static, with no waving before it in the same episode, still reports as a raised full-course yellow — which is what keeps the rule honest on a discipline whose cautions may not wave first.
- A restart emits `caution.restarted` rather than `startLight.start-go.raised`, so the restart has its own call and its own opt-in instead of borrowing the race start's. This is the only published event whose behaviour changes.

In the callouts, decided at speak time from the new "is a full-course caution out" reader:

- Lap-time calls fall silent. The second caution announced a "best lap yet" of 44 s on a pace lap.
- The ordinary position-change call falls silent. It announced "Currently 14" at the pickup as a position *lost*, when the running order had merely frozen and the official positions were catching up to it. The pickup call states the restart position instead.
- **Pit open / closed calls are untouched: every flip is announced.** Explicitly ruled, after an earlier decision to collapse them to the first of each was reversed.
- The caution call becomes queueable, so it waits for the spotter instead of being dropped, and loses "pace car will be deployed".
- Each new call gets one `calloutEnabled…` boolean under Race Engineer Callouts, defaulting on.

## Testing

The new module is driven by a **committed fixture cut from the capture** — the flag values, pace rows and lap counters through both cautions — asserting the exact event sequence and its timing, with the fixture citing the capture file it came from. The capture itself lives in the ignored `local/`, so the fixture is the evidence that survives. This form of test is what exposed the false restart claims: replaying the capture through `origin/master`'s translator emits `flag.yellow.cleared` three seconds after each restart, and through the branch's emits nothing.

The harness "Caution → restart" button grows into the whole sequence, with pace rows and car numbers in the patched telemetry so the follow-car lines resolve, plus buttons for the two cases the capture could not produce: a mid-caution reorder and an extra lap. All seven events join `event-names.ts`.

## Clips

A new `car-number` group covering every number iRacing can give, each clip named exactly as the sim spells it so `09` and `9` stay distinct: 0–9, 00–09, 10–99, 000–099, 100–999 — 1,110 clips. Readings:

| Shape | Examples |
| --- | --- |
| One digit | 5 "five", 0 "zero" |
| Two digits | 49 "forty-nine", 10 "ten" |
| Leading zero | 09 "oh nine", 00 "double oh" |
| Three digits | 119 "one nineteen", 275 "two seventy-five", 105 "one oh five", 100 "one hundred", 110 "one ten" |
| Zero + two digits | 099 "oh ninety-nine", 050 "oh fifty" |
| Double zero + digit | 009 "double oh nine", 000 "triple oh" |

Generation is dry-run first, both to approve wording and to confirm ElevenLabs reads "oh" as a digit rather than an exclamation. Voices are downloaded rather than bundled since 3.3.0, so clip count is not bounded by the Mirabox distributable limit.

## Rejected alternatives

- **Deciding any of this in the scenario layer instead of the translator.** Rejected on the issue's own terms: every voice pack and the harness must see the same event stream, and a scenario-layer decision is unreachable from the harness.
- **One `caution` event with a phase field.** Fewer catalog entries, but every callout then needs a phase condition, the per-call opt-ins get clumsy, and the phase list itself becomes published contract — so adding a phase later would be a contract change rather than a new event.
- **Freezing the lineup into event payloads.** Simplest to test and wrong: a car number captured at emit time can be stale by the time the sentence is spoken.
- **Listening to our own Race Admin pace-lap presses** to count the caution down exactly. Unnecessary once an extension is detected from the missing one-to-go flag, it would not cover another admin's presses anyway, and it would couple the actions package to the translator.
- **Gating the whole sequence to ovals.** Every signal is discipline-agnostic and road courses have full-course cautions; only the inside/outside wording is oval-specific, and that is gated on its own.
- **A "two to go" call.** No signal exists, and no session-info field carries the count.
- **Lucky dog and wave-around calls.** `CarIdxPaceFlags` carries `FreePass` and `WavedAround`, but neither has been observed, so nothing is designed on them.

## Unverified, and what would settle it

- **Which physical side line 0 is.** One look out of the window on a double-file restart.
- **A road-course caution**: whether iRacing deploys a pace car at all, and whether the flag waves before going static. The pickup rule handles either answer; the capture would confirm it.
- **A mid-caution reorder**, from pitting under caution, to exercise `caution.lineup.changed`.
- **Lucky dog / wave-around**: `!waveby` and `!eol` under a caution, and a lapped car, to see whether `CarIdxPaceFlags` lights up.

None of these block implementation.

## Order of work, and review

Translator, events and harness first, since everything else consumes them. Then the vocabulary, callouts and clips. Then the silencing and the documentation — the Pit Crew page's caution section, the callout switch list, the changelog line, `race-engineer-callouts.md` and its examples catalog, the pace-row carve-out in `race-positions.md`, and the harness `CLAUDE.md`.

The change adds to the published `@iracedeck/event-bus` catalog, so the branch takes an `xhigh` code review at the end, per `@.claude/rules/code-review.md`.
