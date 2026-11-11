> **Issue:** [#1113](https://github.com/niklam/iracedeck/issues/1113) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: approaching-traffic warnings when rejoining after a stop and when leaving the pits

## The problem

MarcoP's Discord request: iRacing's spotter now handles rejoins — after a spin it gives the gaps to the cars behind and says whether to wait or go — and the Race Engineer should too. The maintainer added a second moment with the same shape: leaving the pits, where the question is whether a car on track will be at the merge when you are.

Nothing in the repo answers either. The gap engine (#933) is class-neighbour only and **suppresses itself whenever the player is off track or on pit road** — the exact states these two moments live in. The AI Spotter (#651) mirrors `CarLeftRight`, a sim-computed side-by-side signal that says nothing about a car ten seconds away. There is no stopped-car detector, and no code computes when another car will arrive at a point.

The pit-exit half depends on the learned pit-lane landmarks of #1112; the rejoin half needs no landmark.

Why build it when the sim now does the rejoin half: Race Engineer users who run the AI Spotter often mute the sim's spotter, and iRaceDeck can say the number.

## What ships

One engine, two triggers, two opt-ins:

- **Rejoin.** While stopped or crawling on track, the engineer says one of: _"Nothing behind you for the next twenty seconds"_, _"Car approaching in about fifteen seconds, get moving"_, _"Car approaching, three seconds, hold"_, and after a hold, _"Clear, go."_
- **Pit exit.** From the pit box to the exit: _"Watch out for traffic at pit exit"_ or _"Pit exit seems to be clear"_ (Terse: _"Pit exit clear"_).

Two user-set rejoin windows, and a user-set pit-exit window either side of the player's arrival. Default on, under the Race Engineer master.

## Decisions

### 1. The arrival model

For a reference point P on the track with reference time T(P), a car's time to reach P is `T(P) − CarIdxEstTime[car]`, wrapped across the start/finish line. `CarIdxEstTime` is the sim's own estimate of the time to reach the car's current position on a reference lap, so the subtraction is a time-of-arrival that already carries the track's speed profile; a distance-over-speed model would have to invent that profile. Cars ahead of P, in the pits, or not in world are ignored; the pace car is not (it does arrive).

For rejoin, P is the player's own position and T(P) the player's own `CarIdxEstTime`, so no landmark is needed. For pit exit, P is the learned `blendEnd` from #1112. (Amended 2026-11-09, after #1112's amendments: a landmark's reference time is kept per car class, so T(P) for an arriving car is its own class's `estTime` at the landmark. The landmarks are read through a new `SimRuntime.getPitLaneLandmarks` member if the detector lives outside the translator, or from the translator's learner if it is a translator diff; this issue's plan decides which.)

### 2. The rejoin trigger: stopped on track, no incident precondition

The episode starts when the player is live in the car, on a track surface (on track or off track), not on pit road, not in the garage, not pre-green, and **below a crawl speed for about 1.5 s**. It ends when the car is moving again for a couple of seconds.

An incident precondition — only after `offTrack.started` or an out-of-control incident — was considered and rejected: a stalled car, a car stopped to avoid a crash, or a driver who simply spun without the sim scoring it all need the same answer. The gates above already exclude the stationary cases that are not rejoins: the grid before the green, the pit stall, the garage.

### 3. Three verdicts, and silence is not one of them

The maintainer's addition: when nobody is coming, **say so**. A driver who has just spun and hears nothing cannot tell "clear" from "the engine did not notice". So the engine always speaks on episode entry:

| Nearest arrival               | Verdict | Line                                                 |
| ----------------------------- | ------- | ---------------------------------------------------- |
| none within the notice window | clear   | "Nothing behind you for the next `<notice>` seconds" |
| inside notice, outside hold   | notice  | "Car approaching in about `<n>` seconds, get moving" |
| inside hold                   | hold    | "Car approaching, `<n>` seconds, hold"               |

While stopped the engine re-evaluates about once a second and speaks again on a **verdict change** or when the nearest gap has moved by a few seconds — never on every tick, which at three lines a second would be noise. After a hold, once the car has passed and nothing else is inside the hold window, it says _"Clear, go."_

### 4. The windows, user-set

`trafficNoticeSeconds` (default 20) and `trafficHoldSeconds` (default 6), plain numbers in the settings window's Race Engineer card, `.catch` on both. Shared by both triggers for the moment the engineer first speaks (the notice window), and by rejoin for its verdicts. Fixed constants were the cheaper option and were set aside by the maintainer: track length and car speed change what "close" means, and a driver knows their own margin.

Pit exit judges traffic with a window of its own, `trafficPitExitBeforeSeconds` (default 2) and `trafficPitExitAfterSeconds` (default 4), the same kind of field (amended 2026-11-01, decision 5).

### 5. Pit exit runs against the learned landmarks

From `pitStall.departed`, the player's ETA to the merge is the distance to `pitRoadEnd` at the pit speed limit (`resolvePitSpeedLimit`) plus the reference time from `pitRoadEnd` to `blendEnd` (the `estTime` difference between the two landmarks — an approximation for an accelerating car, and good enough for a window measured in seconds). The verdict is **traffic** when a car's arrival at the blend lands from `trafficPitExitBeforeSeconds` before the player's own arrival to `trafficPitExitAfterSeconds` after it; otherwise clear.

The window is lopsided (amended 2026-11-01; the original counted only cars inside the hold window after the player). After: the car is at full speed while the player is still accelerating, so it closes about a second on them, and the ETA above runs early because the reference time from `pitRoadEnd` to `blendEnd` is at racing speed — a car predicted two seconds behind may be alongside. Before: a car that gets there first is ahead, and only one practically alongside matters. A symmetric ±3 s was the starting point and spent too much on the before side. The defaults are confirmed on a pit-exit capture with a car passing at the blend: its predicted arrival against its actual crossing, and the player's predicted ETA against their actual one.

It is spoken once when the ETA drops under the notice window — early enough to act, late enough that the traffic picture is settled — and again only if the verdict flips before the line. No published landmark for the track means no pit-exit callout at all (logged at debug), per #1112's no-guess rule.

The lines carry no number, unlike rejoin's: at the pit exit the window is the information, and the player cannot hold a line the way a stopped car can. Traffic: _"Watch out for traffic at pit exit."_ Clear: _"Pit exit seems to be clear"_ in Default, _"Pit exit clear"_ in Terse — "seems" because the verdict is a prediction. "Clear" over "open": it is the spotter's word for nothing there, and "open" is not standard racing radio.

Cross-class arrivals are not yet sound (the #1199 finding on the issue): `CarIdxEstTime` is per class, and the 4–5 s class offset measured at Monza is wider than this whole window, so the class-consistent measurement must be settled before implementation.

**Settled (amended 2026-11-10, from the #1113 lead's plan): each class's reference curve is built live.** `CarIdxEstTime` depends only on lap position within a class, so every car of a class passing a point is a sample of that class's reference time there. The translator keeps a small per-class table of reference time by lap position, fed every tick from the cars on track. A car's arrival at P is its own class's reference time at P minus its own `CarIdxEstTime`, wrapped. This is exact for every class once that class has driven past P, which is usually within the first lap. Before that it falls back to scaling the player's class reference by the ratio of the two classes' `CarClassEstLapTime`. For rejoin, P is the player's position and the arriving car's class curve gives T(P). For pit exit, T(P) is read from the landmark's per-class `estTime` first, then the class curve, then the scaling. An arriving car with no reference time at all on any path is counted as traffic at pit exit, never as clear, so the call can't be a false clear. On rejoin, where every verdict carries a number, such a car only stops the clear line: timed cars still give their notice and hold lines, and if the untimed car is the only one, the engine stays silent and logs at debug rather than inventing a number. That is the one exception to "silence is never a verdict", and it is practically unreachable, because iRacing always fills `CarClassEstLapTime`. The per-class curve learns only from cars on the racing surface (`OnTrack` or `OffTrack`), never from pit-lane `estTime`. Rejected: scaling alone, which assumes every class shares one speed profile (an unmeasured error of about a second between GTP and GTD); and ignoring other-class cars, a false clear in a multiclass race. The detector is a translator diff that reads #1112's learner on the translator instance, so no `SimRuntime.getPitLaneLandmarks` member and no new package edge; its four windows are injected the way the gap and corner settings already are.

### 6. Weight and family

Hold and pit-exit traffic fire at `WEIGHT.SAFETY` with `interrupt: true`: a car arriving in three seconds cuts whatever the engineer was saying. Notices and clears are `SAFETY` without interrupt. `PROXIMITY` is not used — it is reserved for the spotter's side-by-side transition calls, and a rejoin hold is a warning about a car that is _not yet_ alongside. One new family, `traffic`, so a fresh verdict replaces a stale one in flight.

### 7. Settings

`calloutEnabledTrafficRejoin`, `calloutEnabledTrafficPitExit`, both default on, plus the four window fields of decision 4. No incident precondition to configure.

### 8. Events

`traffic.rejoin { verdict: "clear" | "notice" | "hold" | "go", seconds?: number }` and `traffic.pitExit { verdict: "clear" | "traffic", seconds?: number }`, with harness entries. The pit-exit lines speak no number; `seconds` (the nearest car's arrival relative to the player's, negative before) stays on the event for logs and the harness. The harness needs a multi-car telemetry preset for both, since the existing shortcuts drive single events, not a field.

## Amendment, 2026-11-11: alert, never instruct; a number only for a close car; pit exit at the stall

Decided by Niklas directly with the #1113 lead, after three drafts he turned down (a hold/go instruction, coarse buckets, and "about ten" for nineteen seconds). This section supersedes decision 3, decision 4's rejoin windows and the parts of decisions 5–8 it names, and the earlier 2026-11-10 amendments where they differ.

The engineer alerts, never instructs; he gives a number only for a close car; the pit-exit call is made at the stall.

**Rejoin (replaces decision 3).** A stopped driver is never told to hold or go. The lines name fixed bands of the nearest predicted arrival:

| Nearest arrival | Line |
|---|---|
| under 2 s | "Car right behind you. Watch out." |
| 2 s to under 10 s, first call | "Car coming, about N seconds. Watch out." (N in whole seconds, rounded down) |
| 2 s to under 10 s, later | "Now N seconds." |
| 10 s to under 15 s | "Next car is more than ten seconds away. Be careful." |
| 15 s or more, or no car | "Clear to rejoin." |

**When the engineer speaks:**
- **On entry:** always, so silence never means clear.
- **On a closer band:** whenever the nearest car moves into one.
- **"Now N":** while a car is under 10 s, each time N has dropped by 3 or more.
- **After a close car:** once a car under 10 s has passed, he says the band of the next car once ("Clear to rejoin." or "more than ten").
- **A car falling away** is otherwise not re-announced.

The lines under 10 s, and "right behind", cut in.

**An untimed car** (decision 5) withholds the two reassuring lines, "more than ten" and "Clear to rejoin." If it is the only car, the engine is silent and logs at debug.

The number lines are recorded whole. The lap-time number clips were rejected: they are cut to run into "point", Terse has no "seconds" clip, and "N point M seconds" claims a precision the prediction does not have.

The bands are fixed because the wording names them. This supersedes decision 4's user-set rejoin windows.

**Pit exit (decision 5).**
- **When:** the call is made the moment the player leaves the pit box, and again only if the verdict flips before the merge.
- **Wording:** the lines are worded as the estimate they are:
  - Default: "We're estimating traffic at the pit exit. Watch out." / "Looks like the pit exit will be clear."
  - Terse: "Traffic likely at pit exit. Watch out." / "Pit exit looks clear."
- **Priority:** both lines cut in, so they trump the exit readback and the tire-wear report. Those are queueable and play afterwards.
- **Window:** the traffic window keeps `trafficPitExitBeforeSeconds` / `trafficPitExitAfterSeconds` (2 / 4).

**Settings (decisions 4 and 7).** The two pit-exit window sliders and the two opt-ins. No rejoin windows and no look-ahead.

**Weights (decision 6).** The rejoin lines under 10 s, "right behind", and both pit-exit lines fire at `WEIGHT.SAFETY` with `interrupt: true`. "More than ten" and "Clear to rejoin." use `WEIGHT.SAFETY` without interrupt.

**Events (decision 8).**
`traffic.rejoin` is one of:
- `{ verdict: "rightBehind" }`
- `{ verdict: "near"; seconds: number; first: boolean }` (`seconds` 2–9)
- `{ verdict: "overTen" }`
- `{ verdict: "clear" }`

`traffic.pitExit` is unchanged.

**Lines are composed from pools (maintainer, 2026-11-11).** A first call under 10 s is an intro, a middle naming the seconds, and an outro, each a whole sentence picked at random from its pool: eight intros, two middle wordings per number, eight outros. A "now" update is an update intro and a middle. The fixed lines (right behind, more than ten, clear to rejoin, and the two pit-exit lines) have four variants each. The joins fall at sentence ends, where a pause is natural, so variety costs no seam inside a sentence. The exact texts are in the voice configs.

## Alternatives rejected

**Extending the gap engine.** It is built to suppress exactly these states and keyed to class standings; adding a stopped mode to it would fight its own gates.

**Hold / clear without numbers.** Rejected by the maintainer: the time is the information.

**Yaw-based spin detection.** The danger comes along the track direction whichever way the car faces, so facing is irrelevant to the verdict; speed and surface are enough.

**Fixed windows.** Decision 4.

## Open questions

- Under a yellow flag: warn as normal (the traffic still arrives). Proposed yes.
- Whether a car facing backwards changes the wording. Proposed no, per the rejection above.

## Verification

Arrival-primitive tests: wrap-around, cars ahead, in pits, not in world. Detector tests for the entry gates and the verdict table. Harness: a stopped player with cars at 25 s, 12 s and 4 s, watching the verdicts change as they pass; a pit exit with the landmarks seeded and cars at 3 s before, 1 s before, 3 s after and 5 s after the player's arrival (clear, traffic, traffic, clear at the defaults of 2 s before and 4 s after; amended 2026-11-10 to match decision 5's lopsided window). Manual: a deliberate spin in practice on a busy server, and a pit stop with traffic.
