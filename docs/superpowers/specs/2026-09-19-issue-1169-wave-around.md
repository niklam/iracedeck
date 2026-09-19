# The wave-around, announced

> **Issue:** [#1169](https://github.com/niklam/iracedeck/issues/1169) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

When the player carries iRacing's `WavedAround` pace flag under a full-course caution, the engineer says so **once per caution** and tells him to go: "We've got the wave-around. Go on, pass them. Go round to the back, behind car thirteen." The trigger is **level-armed**: the first tick of a caution on which the bit is set, whenever that is. The design therefore holds whether the bit rises at the throw, mid-caution, at one to go, or only once the car is already in place. That property is required, because the rising edge has never been captured.

The call replaces two of #1127's calls for a driver who is driving round, since theirs would contradict it. #1168's catch-up call stays quiet until he has taken his slot. `FreePass` (the lucky dog) and `EndOfLine` are decoded now and suppress #1168's catch-up now, but their **calls are deferred** to a follow-up issue gated on a capture (see *Scope*).

This builds on #1127 (the caution phase, the lineup, the follow and lineup-change contracts) and on #1168 (the per-caution procedure latch `cautionProcedureJoined`, the gap measurement, `getCautionGap()` and its place in `CautionContractDeps`). Names from #1127 are as they stand on the `ir-1127` branch at `7a1c6e53c`, after its second review's fix round (2026-09-19).

## Confirmed by Niklas, 2026-09-19

The product decisions below were put to him through the coordinator and confirmed as written here:

- The follow and lineup-changed calls **stand down while the player is waving around**, and the wave-around call names the car instead.
- The **in-place wording exists**, for a bit first seen once the car is already in its slot.
- The **`FreePass` and `EndOfLine` calls are deferred** until capture C4 has observed them. Only their catch-up suppression ships now.

This technical default was kept as proposed:

- the wave-around call's weight of `WEIGHT.SAFETY − 1`.

## What was measured

From the 2026-09-19 Homestead snapshots, recomputed from the raw JSON:

| Snapshot | Caution | Player's pace flags | Player's slot | Forward gap to the car ahead in line | Race progress vs the leader |
| --- | --- | --- | --- | --- | --- |
| `094029` | **waving** | **`WavedAround`** | line 0 row 20, the tail | 1,819.7 m (0.76 lap), and 0.24 lap *behind* him physically | 1.10 laps down |
| `094304` | static + one to go | **`WavedAround`** | line 0 row 11, the tail of line 0 | 13.1 m, normal | **on the lead lap** |
| `131947` | static + one to go | **none, on any car** | line 1 row 9 | 11.9 m, normal | 1 lap down |

What this settles:

1. **The bit means "you may pass", and it is up while the caution still waves.** In `094029` the player is at 244.8 km/h, 0.5 m behind a car he is passing (#16), with the caution still waving. He has been released and is driving round.
2. **The wave-around gives the lap back.** Between `094029` and `094304` the player went from 1.10 laps down to the lead lap. That is one observation, but it is the procedure's point, and the call's "go get the lap back" rests on it.
3. **The bit stays set after the car has taken its slot.** `094304` has him at the tail at normal spacing, one to go, still carrying `WavedAround`. So the bit alone cannot say whether he is still driving round. #1168's procedure latch can: set the first time, with the bit up, that his gap closes below the clear multiple.
4. **A wave-around is not "a lapped car".** `131947`, newer than this issue, has **no pace flag on any car** while two cars are lapped: #6, two laps down, and the player, one lap down. The player there is the first car a lap down, the lucky-dog candidate, and he carries no `FreePass` either. In `094029`/`094304` car #7, two laps down, carries no bit while the player does. In between, it went from sixth in the waving lineup to the back of line 0 without one. iRacing decides who is waved around. So **nothing here infers a wave-around from lap count**, and a test pins that.
5. **The lineup puts the waved car at the tail while the race puts it ahead of lapped cars.** In `094304` the lineup's combined order counts the player 20th while the race and the display say 19th, because #7 (lapped) is lined up ahead of him. `131947` shows the same one-place disagreement with no wave-around at all. Anything that reads the pace rows as a *position* is wrong for a waved car. That was #1127's "P21" and it is the trap this call must stay out of.
6. **The rising edge is not captured.** Both snapshots show the bit already set, and both earlier watches recorded `CarIdxPaceFlags` at 0 for every car throughout. If this caution ran the 2026-09-17 shape (175 s from the throw to one to go), `094029` is about 20 s after the throw. That would put the bit up with, or soon after, the pace-row assignment. It is an inference from another caution's timing, not a measurement, and the design does not rest on it.

## The trigger

**The translator emits `caution.wavedAround` on the first tick of a caution episode on which the player's `WavedAround` bit is set.** A caution episode means #1127's phase is not `none`. A per-caution latch, `cautionWaveAroundAnnounced`, is set by the emission and cleared when the phase returns to `none`. That is the once-per-caution semantics: a bit that falls and rises again inside one caution is not announced twice, and the next caution is announced afresh. The latch is **preserved** across the replay wipe with `cautionPhase`, for #1127's reason: a glance must neither lose the call nor repeat it. The pace-flag baseline itself re-seeds.

It is level-armed rather than edge-armed. An edge detector would also catch every rise the diff watches, whenever it happens. What it loses is a rise the diff did not watch: one inside a replay glance, where #1127's baselines re-seed, or before a plugin restart. Glancing at the replay under a yellow is ordinary driver behaviour, #1127's own argument.

How each possible timing of the rise plays out, all of them decided:

| When the bit is first seen set | What happens |
| --- | --- |
| With the pace rows at the throw, while waving | The call speaks 2.5 s after the caution announcement, in the slot the follow call would have used (the follow call stands down, see below). "Go on, pass them" plus the tail car. Since #1127's fix round the follow call speaks only while the phase is `waving`, so this is the one case where the two could ever meet. |
| Mid-caution or at one to go, with the car still away from its slot | The call speaks 2.5 s after the rise (the same delay; nothing competes for the bus then). The same wording. |
| Only once the car is already in its slot (#1168's procedure latch sets on that same tick, because his gap is already closed) | The call speaks the in-place wording: no "pass them", nothing to instruct. |
| On the first live ticks after a plugin restart mid-caution (after the diff's silent seed) | One call, worded by where he is: driving round, or already in place. |
| It falls and rises again within one caution | Nothing more. |
| Under green, or on the green's own tick | Nothing. There is no caution phase to announce it in. |

**Checking for the bit at a fixed point in the sequence was rejected.** One to go, for instance, would have announced `094029`'s drive-round about two and a half minutes after it began.

## What the driver hears

`pit-crew.caution-wave-around`, in two branches on `caution.isWavingAround` (below):

| Case | Call |
| --- | --- |
| Still driving round | "We've got the wave-around. Go on, pass them." / "Wave-around for us. You're clear to pass — go get the lap back." Then, only with a nameable car ahead that is not the pace car, the optional clause "Go round to the back, behind car thirteen." |
| Already in his slot | "We got the wave-around — you're in place at the back." / "That's the wave-around done. We're at the back of the line." |

The optional clause is safe for the reason #1127 wrote down: the sentence outside it always speaks. The in-place wording makes no claim about the lap count, so it is true whenever iRacing scores the regained lap (C3 reads when that is, for the position call's sake, not this one's).

**No position is spoken, and none may be.** Mid-drive-round the race position is changing as the lap comes back, and the lineup's position is wrong by the lapped cars ahead of him (finding 5). The position a waved driver hears is #1127's last-lap call, which reads the canonical race order. That stays as it is.

## How it meets #1127's calls and #1168

What changes for a player who is **waving around**, meaning he carries `WavedAround` and has not yet taken his slot:

| Call | Change | Layer |
| --- | --- | --- |
| Caution announcement | none | — |
| Who to follow | **Stands down** at its delayed decision and at speak time. The wave-around call names the same car, and "line up behind car thirteen" to a driver in mid-pack who must first pass the whole field reads as the opposite instruction. | contract `where:` + `speakGate` |
| Car ahead changed | **Stands down.** The re-slot to the tail is the wave-around itself, not a reorder. After he takes his slot, changes are reported as usual. | contract `where:` (after its 1.5 s hold) + `speakGate` |
| Two to green | The reference script drops its "Make sure to follow" clause. | script only |
| One lap to green | The reference script takes the plain "One lap to green." (the existing `pool:caution/one-to-go`), because a lane-and-car instruction contradicts "pass them". The frozen `one-to-go-*` clips are not touched. | script only |
| Position on the last lap | none. It must stay on the canonical race position (finding 5). | — |
| Pace car out / off, extra lap, restart | none | — |
| #1168 catch-up | Suppressed until he has taken his slot; defined in #1168. | translator |

**The two stand-downs compose with what those contracts already check. They replace nothing.** At `7a1c6e53c` both contracts already carry the shared `stillLinedUp` speak gate: the caution is still out, and the player still holds a pace row (#1127's towed-player fix). The stand-down adds one more condition to it: "and not waving around". The new gate reads "the caution is out, you hold a pace row, and you are not waving around", with its `description` saying so. On the `where:` side the condition is likewise appended:
- to the follow call's `liveRaceCar && phase === "waving"`;
- to the lineup change's check that the caution is out and the one-to-go call has not already claimed this change (#1127's timestamp stash).

The condition comes through `CautionContractDeps.getCautionGap`, the member #1168 adds, read as `getCautionGap()?.wavingAround === true`. The builder already destructures its deps object, so nothing else in the family changes. With no reader wired, the default `() => null` reads as "not waving around" and the stand-downs never engage, which is the safe direction: the calls speak as they did before #1169.

A call **stands down only where another call replaces it**. So the two stand-downs key on `WavedAround` alone, not on `FreePass` or `EndOfLine`: those have no call yet, and silencing the follow call for them would leave a driver with nothing. The two stand-downs are contract-level because they decide *whether* to speak (#1138). The two script edits choose *words*, so they are the reference voice's business, and another pack may word it differently.

## Scope: FreePass and EndOfLine

**In now:**

- The lineup reader decodes all three bits for the player (#1168).
- All three suppress #1168's catch-up until the player has taken his slot.

**Deferred to a follow-up issue, gated on capture C4:** the `FreePass` and `EndOfLine` events, calls, vocabulary, settings and clips.

The reasons:

- **Neither bit has ever been observed.** `131947`'s first lapped car carried no `FreePass`.
- **A call's words assert a procedure.** For the lucky dog that is "pass the pace car"; for the end of the line it is "drop to the back". Asserting a procedure the sim has not been seen to run is how #1127's "a restart fires the green" claim went wrong. A suppression asserts nothing, which is why it can cover all three today.
- **Deferring costs no contract change later.** Each pace flag gets its own event rather than a `kind` on a shared one, so adding the other two later is purely additive.
- **The vocabulary waits with the calls.** Names are public API on the Vocabulary page, and a condition on a bit nobody has seen invites a pack to build on it.

## Where it lives

- **Translator:** `diffWaveAround` in `diff/caution.ts`, beside #1168's `diffCatchUp`. Like it, `diffWaveAround` runs right after `diffLineup` and consumes the lineup `diffLineup` resolved after its early returns: one resolution per tick, none under green. It therefore reads the phase this tick settled on. A tick with no lineup (no caution phase, a `Green` bit, or a player holding no row) announces nothing, and the level-armed latch picks the bit up on the next tick that has one. The decode comes from that lineup, and the "has he taken his slot" answer from #1168's latch. `caution.wavedAround` joins the catalog with `EmptySimEventPayload` and joins `event-names.ts`.
- **Contract** `pit-crew.caution-wave-around`, built in `buildCautionContracts(deps)` from the same `CautionContractDeps` as its siblings (`getCautionPhase`, `getCautionLineup`, and #1168's `getCautionGap`), with `where: liveRaceCar`. Its scheduling mirrors the follow call it replaces at the throw:
  - **No family.** The call can land right beside the caution announcement, and a shared `family: "flag"` would have it cut that announcement mid-word.
  - **`WEIGHT.SAFETY − 1` and `triggerDelay: CAUTION_FOLLOW_DELAY_MS`.** These let the announcement take the bus first and keep it from being evicted from the single pending slot.
  - **Queueable.**
  - **`speakGate`:** the family's shared check (`getCautionPhase() !== "none"`), and the player still carrying `WavedAround` in the live lineup (`getCautionLineup()?.paceFlags.wavedAround`). A withdrawn bit is not announced.

  It **inherits exactly the follow call's residual**: if the bus is held past 2.5 s at the throw, the announcement waits in the pending slot and this call, at lower weight, is dropped. #1127 accepted that for the follow call. It is accepted here for the same reason, because for this driver this call *is* the follow call. The alternative is `WEIGHT.SAFETY`, where a tie evicts the pending announcement and the wave-around wins. It is recorded as a ruling to revisit if C3 shows the bit rising at the throw and a loss is ever heard.

  **Where it sits on the ladder.** Since #1127's fix round the position call is also `WEIGHT.SAFETY − 1` with no family, so the wave-around ties with it, and with the follow call it replaces. The ordering is:
  - it waits behind every `family: "flag"` call at `WEIGHT.SAFETY` (one lap to green, Green Held, the lineup change);
  - it is never evicted by #1168's catch-up (68) or its reminder (50);
  - a tie in the pending slot goes to the newer fire.

  The tie with the position call is accepted. Even when the bit rises at one to go, the wave-around decides 2.5 s after the one-to-go event, and the position call fires at 35 % of the player's one-to-green lap, about half a minute later at pace speed. A tie in the slot needs the bus held for that whole time.
- **Vocabulary**, registered in `registerCautionVocabulary`. Its signature at `7a1c6e53c` takes the lineup and live-position readers; it gains the same `getCautionGap` resolver, passed by `registerPitCrew` from the one `PitCrewDeps` entry, so the conditions and the contracts' gates read one answer:
  - `caution.isWavedAround`: the player carries the `WavedAround` pace flag this caution.
  - `caution.isWavingAround`: he carries it and has not yet taken his lineup slot, so he is still driving round to the back. The grammar's only operator is `!`, and every script branch above needs exactly this conjunction, so it is registered rather than composed.

  The call names the tail car through #1127's `caution.followCarNumber` / `caution.hasFollowCarNumber` / `caution.followsPaceCar` unchanged.
- **Setting:** `calloutEnabledCautionWaveAround`, label **Wave-around**, callout id `wave-around`, default on, one row in the Caution item. It goes through `CAUTION_CALLOUT_SETTING_KEYS` like its siblings.

## Clips

Five new clips in the `caution` group:

- `wave-around-01..02` are whole sentences.
- `wave-around-join-01` is the lead-in "Go round to the back, behind", stopping before "car" and carrying `next_text: "car ninety five"`.
- `wave-around-done-01..02` are whole sentences.

Dry-run first, expecting exactly five. The wording is settled from the dry run. The script changes also touch the two-to-green and one-to-go entries, but not their clips. `pack:voice default` and a version bump come with it.

**`minPluginVersion`, and why it matters more here than in #1168.** This edits the `default` voice's script in two ways: a new entry for a new contract, and new conditions inside two **existing** entries. If it ships in 3.3.0 itself, nothing is needed. If it ships in a later release, the `default` catalog entry carries `minPluginVersion` set to that release (the optional field in `deck-core/src/voice-pack-catalog.ts`, checked by `isVoicePackOfferable`).
- Without it, an older plugin handed this script cannot compile the edited two-to-green and one-to-go entries, because they name `caution.isWavingAround`, which it never registered.
- An unknown condition skips the whole callout for that voice. So the older plugin would lose "Two to green" and "One lap to green" altogether: two calls it used to speak, not merely the new one.

**A known limitation, inherited from #1127.** `caution.hasFollowCarNumber` asks the *session* whether it can spell the car's number. It does not ask the *voice* whether it has that clip, because a vocabulary resolver receives only the fire's `ScenarioContext`. In a voice whose `car-number` group lacks the tail car's clip, the wave-around's numbered join clause is taken and expands to nothing. Here that costs only "Go round to the back, behind car N": the sentence before it always speaks, so the call is never silent. It affects only a third-party pack with a partial `car-number` group; the reference voice ships all 1,110 clips.

## Testing

- **Snapshots**, reusing #1168's committed `caution-gap-20260919.json`:
  - `094029`: the bit set, and waving around;
  - `094304`: the bit set, and in his slot (13.1 m is under the clear multiple);
  - `131947`: no bit, with two lapped cars. This test fails if anyone infers a wave-around from lap count.
- **The trigger, on synthetic ticks:** each row of the timing table; the latch surviving a replay wipe (no repeat) while the baseline re-seeds; a second caution announcing again; a bit under green emitting nothing; a seed emitting nothing.
- **Contracts, against the real reference script:**
  - both wordings, and the optional clause both present and absent;
  - the gate dropping a queued call once the bit is withdrawn or the caution is over;
  - the follow and lineup-change calls standing down while waving around and speaking again once he is in place;
  - the composed gate: a player waving around AND holding no row, and a player not waving around AND holding no row, both silent, so the existing `stillLinedUp` condition is proven still in force;
  - no `getCautionGap` wired (`() => null`): no stand-down, the calls speak as before;
  - `FreePass` and `EndOfLine` **not** standing them down;
  - the two script branches in two-to-green and one-to-go;
  - no position var anywhere in the entry.
- **The harness:** a "Caution → wave-around" button (`requires: ["player-car-index"]`). After the throw it sets the player's `WavedAround` bit, moves him to the tail row about three-quarters of a lap short of it, then closes that gap over the drive-round. The in-place wording is auditioned by injecting `caution.wavedAround` raw once the button's run has placed him.

## Captures, and what each one sets

**C3 — the wave-around's rise (checks the timing table; one rule depends on it).** Offline AI race at Homestead in the ARCA car. Get yourself a lap down, by pitting under green or driving a slow lap, then `!yellow`. In the first caution use `!waveby <your car number>`. In a second caution use no admin command: stay a lap down and stay out, to see whether iRacing waves anyone round by itself. Record:

```bash
pnpm telemetry-watch --vars=SessionFlags,SessionState,PaceMode,PlayerCarIdx,Speed,OnPitRoad,LapDistPct,CarIdxPaceFlags,CarIdxPaceLine,CarIdxPaceRow,CarIdxLapDistPct,CarIdxLapCompleted,CarIdxTrackSurface --mode=changes
```

Readings:

1. **The tick the player's `WavedAround` bit rises**, against the caution flag, the player's own row change, the pickup and one to go.
   - If the row change **leads** the bit by more than the lineup-change hold (1.5 s), the stand-down cannot see the bit in time and "Change — you're behind car thirteen" slips out first. The translator then withholds a `caution.lineup.changed` whose new car ahead is more than half a lap up the road (the drive-round geometry). That loses nothing, because the wave-around call, or #1168's pit-exit call, names that car.
   - If the bit **coincides with or leads** the row change, no rule is added.
2. **When the bit clears:** at the green, as `094304` suggests, or on taking the slot.
   - At the green, the procedure latch is load-bearing, as designed.
   - On taking the slot, the latch becomes redundant but stays, since it costs nothing and the other two flags may not behave the same way.
3. **When the regained lap is scored** (`CarIdxLapCompleted` against the leader's). This checks that #1127's last-lap position call, which reads the canonical order built on lap progress, has the lap back by then. If it does not, that is a #1127 follow-up, not a change here.
4. **Whether the second, unforced caution waves anyone round at all**, and whom. That is the evidence for, or against, any future attempt to anticipate the call. None is designed.

**C4 — `FreePass` and `EndOfLine` (unblocks the deferred calls).** The same recording.

- For `EndOfLine`: `!eol <your car number>` under a caution.
- For `FreePass`: be the first car a lap down when a caution falls. Note the session's caution options, since `131947`'s first lapped car received none.

Read whether and when each bit sets, what the lineup does with the car (the tail of which lane), which way the car must go (past the pace car, or back through the field), and when the bit clears. A bit that sets gets its own event and call in the follow-up issue, designed as this one is. A bit that never sets stays suppression-only.

## Rejected alternatives

- **Inferring a wave-around from being lapped.** Measured false twice (finding 4).
- **An edge-only trigger.** It loses a rise inside a replay glance or across a plugin restart.
- **Checking the bit at one fixed point in the sequence.** Late by minutes in `094029`.
- **One `caution.paceFlag` event with a kind.** #1127's argument against a phase field: the kind list becomes published contract, the per-call opt-ins get clumsy, and it would publish kinds nothing speaks.
- **Folding the wave-around into the follow call's script.** It misses any rise after the throw and ties two opt-ins together.
- **Letting the follow and lineup-change calls speak through a drive-round.** Two calls naming the tail car, one of them as "line up behind" to a driver told to pass.
- **Speaking a position.** Neither the lineup's position nor a mid-drive-round race position is the right number (finding 5).
- **A reminder if he does not go.** He is released at racing speed. A driver who ends up lagging after taking his slot is #1168's case.
- **Building the `FreePass` and `EndOfLine` calls now** (see *Scope*).

## Order of work, and review

This lands after #1168's translator half: the decode, the procedure latch and `getCautionGap()`, which it consumes. It can share #1168's worktree as a second issue or follow it on its own. Order: `diffWaveAround` and the event with the harness button, then the contract, vocabulary, setting, stand-downs, script edits and clips. Last, the documentation:

- the Pit Crew page's caution section and switch list;
- the changelog, folded into the caution line if #1127's is still unreleased;
- an entry in `race-engineer-callout-examples.md`;
- the waved car added to the pace-row warning in `race-positions.md` as its second example;
- the harness `CLAUDE.md`.

It adds to the published event catalog and to `GlobalSettingsSchema`, so the branch takes an `xhigh` review at the end.
