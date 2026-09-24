# Issue #1213 — "The previous lap was invalidated." when the lap-invalidation line misses start/finish

> **Issue:** [#1213](https://github.com/niklam/iracedeck/issues/1213) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Baseline this design assumes

Neither dependency is on `master` yet, so this spec is written against the state their specs describe, not the tree:

- **#1122** (branch `fix/1122-incident-type-bound`, worktree `../ir-1122`): the qualifying contract `pit-crew.qualifying-invalidation-lap-invalidated` fires on `incident.scored`, not `incident.occurred` (`packages/audio-scenarios/src/catalog/pit-crew/qualifying-invalidation.ts` on that branch). Its `where:` runs the pure `qualifyingLatchAllows` and stashes the approved `QualifyingInvalidationSnapshot` in a per-envelope `WeakMap` (`pendingQualifyingSnapshots`); its `speakGate` looks that snapshot up by `ctx.event`, re-checks it and claims the per-lap latch (`claimQualifyingLatch`).
- **#1211** (spec only: `docs/superpowers/specs/2026-09-24-issue-1211-incident-damage-queue-behind-held-bus.md`, §4 and "Confirmed by Niklas"): that contract becomes `queueable`, the incident lines yield to it for the same flush, and its gate additionally refuses once the live snapshot's `sessionNum` or `lapCompleted` differs from the stashed one. A line still parked when the driver crosses start/finish is therefore dropped, because "This lap will be invalidated." would then describe the lap now being driven. Niklas confirmed that drop for THAT wording.

If either lands in a different shape, the parts of this spec that lean on it (§1's trigger relation, §3's anchor) are re-read against what landed before implementation starts.

## Problem

After #1211, a lap-invalidation line parked across start/finish produces **total silence** about the invalidated lap, not merely a missing sentence. When the driver crosses the line, `lap.completed` publishes the position readout (`pit-crew.position-change`, `position.ts`), whose invalid-lap shape would have said "That lap didn't count. We're currently P5." But that readout is `WEIGHT.CHATTER` + `queueable`, and the parked qualifying fire holds the bus's one pending slot at `WEIGHT.NORMAL`, so `setPending` drops the readout on arrival (a newcomer is dropped when `weight < current.weight`, interpreter `setPending`, #1211 spec "How the engine schedules today"). The parked fire then reaches its gate after the floor releases and is refused. The incident line for that burst yielded to the qualifying approval (#1211 §4). Nothing about the lap is ever said — and on a first flying lap there is no position yet, so the readout would have been silent even without the slot.

Niklas (2026-09-24): in that case the engineer should say **"The previous lap was invalidated."**

## Decisions

### 1. Mechanism: a second contract fired by the start/finish crossing, not a script branch on the parked fire

A new contract, `pit-crew.qualifying-invalidation-previous-lap`, in `qualifying-invalidation.ts` beside the existing one. #1211's gate on the existing contract is **unchanged**: the stale parked fire is still refused after S/F. The late line is a different fire with a different trigger.

- **Trigger:** `lap.completed`. Its `where:` is pure: the payload's `sessionType` is `"qualifying"`, and the lap it completes had a qualifying approval that no gate ever spoke. "Approved" comes from a new single-slot stash the existing contract's `where:` writes beside its per-envelope one (`lastQualifyingApproval: { sessionNum, snapshot }`); "the lap it completes" is `data.lap === approval.snapshot.lapCompleted + 1` (the payload's `lap` is the new `LapCompleted`, `sim-events-iracing/src/diff/laps.ts` `diffLaps`; the snapshot's `lapCompleted` is the value DURING the lap) with the live snapshot's `sessionNum` equal to the approval's; "never spoken" is the existing latch (`lastAnnounced`) not covering that lap, and a new late latch (`lastLateAnnounced`) not covering it either. On approval it stashes the approved snapshot in its own per-envelope `WeakMap`, keyed by the `lap.completed` envelope (the #1138 per-fire rule).
- **Scheduling:** `WEIGHT.NORMAL`, `queueable: true`, `family: "qualifying-invalidation"`, Voice channel and bus, no `base` (as the existing contract). At S/F with the stale fire parked, the bus is held (a floor or a playing line — an idle, unfloored bus would already have drained it), so the late fire parks too and **replaces the stale fire in the slot** on the equal-weight tie (ties go to the newest). The shared family means an on-time line for the NEW lap arriving while the late line plays cuts it through same-family preemption, which is the right precedence: news about the lap being driven outranks news about the one behind it.
- **`speakGate`:** looks the stashed snapshot up by `ctx.event` (no event → refuse, as the existing gate), refuses per §3, re-checks both latches, then claims `lastLateAnnounced`. It **does not** claim the on-time latch: writing lap N into `lastAnnounced` while the driver is on N+1 could overwrite a newer N+1 claim and re-open that lap to a second callout. It also **does not delete** its stash, unlike the existing gate: §2's case resolver reads the same snapshot, and an admitted fire that is cut and replayed whole re-expands without asking the gate again, so a consumed stash would leave the resolver reading nothing. The envelope-keyed `WeakMap` needs no cleanup; the late latch is what stops a second admission.
- **Opt-in:** the same subject as the on-time line. `QUALIFYING_INVALIDATION_SCENARIO_IDS` gains the new id and `SCENARIO_ID_TO_QUALIFYING_INVALIDATION_ID` maps it to `"lap-invalidated"`, so `calloutEnabledQualifyingLapInvalidated` governs both. No settings schema change.
- **Stash vs claim (#1137):** the existing `where:` gains one more stash (`lastQualifyingApproval`) and no claim; the new `where:` reads it and stashes; both claims live in gates.

**Why not a script branch on the parked fire (the obvious reading of the words/whether rule).** The rule in `race-engineer-callout-examples.md` (#1138) says a branch that chooses words belongs in the script — and "this lap will be" vs "the previous lap was" is words. It was the first design weighed: the existing gate admits a replay up to a limit after S/F, and the script branches on a registered condition `qualifying.lapBehindUs` (pure, reading the fire's stash against the live snapshot). It fails on degradation, and that failure is decisive: a pack whose script does not name the condition would speak "This lap will be invalidated." about a finished lap — the very line #1211 drops for being wrong — and the gate, which runs after expansion but cannot see what the script expanded to (`SpeakGate.admit` takes only the `ScenarioContext`, `dsl.ts`), has no way to refuse it for that pack alone. That pack is not hypothetical: the managed `default` pack is updated by the launch ensure *after* a plugin upgrade, so every user runs one download behind the new plugin for a while. With a separate contract, a pack that has no entry for it is silent (`race-engineer-callouts.md`: "absent means skipped"), which is exactly #1211's behaviour. The trigger also genuinely differs — the late line is a reaction to crossing the line with news undelivered, not to the incident — so this is a WHETHER/WHEN split as much as a words one.

**Also rejected:** a separate contract fired imperatively from the existing gate at the moment it refuses a stale fire (a gate must not have side effects, and a fire started from inside `prepareOps` is re-entrant); `queueBehind` from the position readout to the qualifying contract, so the readout survives the stale fire and says "That lap didn't count" (a smaller change, but silent on the first flying lap where no position exists yet, dependent on `lapIsValid` telemetry, and it is not the line Niklas asked for); letting the late fire claim the on-time latch (see above).

**Accepted edge — the late line also fires when the on-time line was displaced rather than parked.** The `where:` cannot tell "still parked" from "dropped earlier": after #1211 the only way an approved qualifying fire dies before S/F without a gate is displacement from the slot by a heavier queueable Voice fire (a SAFETY flag or fuel tier, opponent-pit or pit-window at 65; #1211 §2). In that rare case the driver never heard the news, so the late line is welcome; but on an idle bus at S/F the position readout, parked behind it, then says "That lap didn't count" too. Two phrasings of one fact back to back, in a rare case, were preferred over making the position readout yield to the late contract: a yield would silence the readout for any pack without a late entry, trading an occasional redundancy for a silent readout on exactly the packs that cannot say the replacement.

### 2. Wording and the tail

- **Core line:** "The previous lap was invalidated." — Niklas's wording, one new clip `qualifying-invalidation/previous-lap-invalidated-01` (`seed: 1`) in the existing `qualifying-invalidation` group of `configs/default.voice.json`. Required step.
- **Tail:** a new case `qualifying.lateLapsLeft`, resolved from the **fire's own stashed snapshot** (the approved lap's), with three keys:
  - `out-of-laps` — the approved lap's `lapsRemaining === 0`: the invalidated lap was the last counted attempt. Bundled script reuses `pool:qualifying-invalidation/out-of-laps` ("We're out of qualifying laps, so that's it for now."), which is as true after S/F as before it.
  - `one-left` — `lapsRemaining === 1`: the lap now being driven is the last attempt. New clip `qualifying-invalidation/one-lap-left-late-01`, "One qualifying lap left.", `previous_request_ids: ["qualifying-invalidation/previous-lap-invalidated-01"]`.
  - `more` — two or more: the bundled script says nothing (`[]`).
  - `null` (time-limited qualifying, unknown count) takes `default: []`.
  The whole tail sits in `{ optional: [...] }`: it is a self-contained sentence, so a pack missing `one-lap-left-late` still says the core line.
- **Why not the existing per-N clips.** Each carries coaching written for the moment before the next attempt: "Make sure to have a flying start for the last lap.", "Take a breath, reset, and go again." After S/F the driver is already on that lap and its start has happened, so the coaching is wrong even where the count is right. "Plenty of laps" is dropped for the same reason and because it carries no news. The two keys kept are the two facts that change what the driver does: the session is over for him, or this lap is his last.
- **Which count, and #776.** The tail is **about the lap now being driven**, computed **from the lap just finished**. `lapsRemaining` means "attempts remaining AFTER the lap the snapshot was taken on" (`event-bus/src/event-catalog.ts`, `QualifyingInvalidationSnapshot`). The approved snapshot (lap N) therefore answers "how many attempts from N+1 on" directly — 0 means N+1 is beyond the counted laps, 1 means N+1 is the last. Reading the live snapshot (lap N+1) would ask a different question and hit #776's clamp: live `0` covers both "N+1 is the last counted lap" and "N+1 is beyond them", separable only through `lapCounted`. The frozen snapshot is also the one the gate already holds, and it cannot move under a replay — the same reason #1138 keys the stash per fire. The existing case `qualifying.lapsLeft` keeps reading live, unchanged: before S/F live and stashed agree.

### 3. How late is too late: 15 s after crossing the line, and never once the next lap is complete

The gate refuses when any of these holds:

- **Truth bound:** the live snapshot's `sessionNum` differs from the approval's, or its `lapCompleted` is no longer `approval.lapCompleted + 1` — the driver has finished the next lap too, so "previous" would now name the wrong lap.
- **Usefulness bound:** `ctx.now - ctx.event.timestamp > LATE_INVALIDATION_MAX_AGE_MS = 15 000`, measured from the `lap.completed` envelope, i.e. from the moment the late line became the right line.

**Why anchor at S/F rather than at the incident.** #1211's `INCIDENT_SPEAK_MAX_AGE_MS` (10 s from the incident flush) exists so a late incident line is not heard as describing a new incident. "The previous lap" names its lap, so that risk does not exist here and the incident's age says nothing about whether the news is still useful; how far into the next lap it arrives does. **Why 15 s rather than 10.** The information stays true for the whole next lap, and its use — knowing this lap has to count, or that the session is over — lasts through the first part of it; past roughly the first sector the driver is committed to the lap and a sentence about the previous one is a distraction mid-corner. It is deliberately a constant of its own, not an import of the 10 s one, since the two answer different questions. **What would set it properly:** in qualifying sessions with debug logging on, the distribution of the time between `lap.completed` and `Replaying pending scenario "pit-crew.qualifying-invalidation-previous-lap"` (how long the spotter floor and busy lines hold at S/F in practice), plus a listening check of where in a lap the line stops helping.

### 4. Voice-pack impact

- **Clips:** two new entries in `configs/default.voice.json`'s `qualifying-invalidation` group (above), generated through the usual dry-run-then-generate flow in `packages/audio-assets/CLAUDE.md`, committed under `voice/default/qualifying-invalidation/`.
- **Script:** a new `scenarios["pit-crew.qualifying-invalidation-previous-lap"]` entry in the same config, with `comment` and `test`, then `pnpm generate:callout-scripts` for `voice/default/callouts.json`. The sequence is `["pool:qualifying-invalidation/previous-lap-invalidated", { "optional": [{ "case": "qualifying.lateLapsLeft", "of": { "out-of-laps": [...], "one-left": [...], "default": [] } }] }]`.
- **Pack version:** `default` is published at `1.1.0` (release `voices-default-1.1.0`), so its bytes may not change under that number: bump to `1.2.0` in `src/build/voice-packs.mjs` and regenerate `catalog/default.json` with a flagless `pack:voice default`. If another unpublished change has already bumped the pack when this lands, ride that version instead of bumping twice.
- **`QUALIFYING_INVALIDATION_CLIP_SOURCES`** gains the two new bases, so the completeness tests hold the reference voice to them; `bundled-scripts.test.ts` holds the reference voice's script complete over the new contract; `pnpm generate:pack-reference` regenerates `packages/website/src/data/pack-reference.json` (new contract, its gate sentence, the new case and its key descriptions).
- **Other packs degrade to silence**, by the engine's existing rule, not by a fallback: a pack with no entry for the new contract says nothing (its late fire still takes the slot the stale fire held, and replays to nothing — the #1211 outcome). A fallback to "This lap will be invalidated." was rejected for the reason §1 gives: it is wrong after S/F. A pack that has the entry but not the clips aborts the callout whole on the required core step (#835).

### 5. Harness shortcut

A translator-driven `telemetrySequence` shortcut under **Qualifying Invalidation**, the #1127/#1211 §6 shape, because what must be heard is the engine's slot handling across the crossing, which a bus-event shortcut steps over:

- **Parked across start/finish:** qualifying session preset on a lap-limited counted lap with one attempt remaining after it; a car alongside (the spotter raises its floor); an off-track report byte with the incident count +1 late in the lap; hold past the burst quiet window; advance `LapCompleted` (the crossing); clear the car about 3 s later. Expected: the spotter's calls, "clear", then "The previous lap was invalidated. One qualifying lap left." — and no "This lap will be invalidated.", no incident line, no position readout.
- **Variants:** the same with no attempts remaining (out-of-laps tail), and **too late** — the car kept alongside for 20 s after the crossing (silence, with the gate's refusal in the debug log).

The qualifying snapshot's `lapCompleted` must advance with the crossing for the gate to see it. The plan uses whichever route the #1122 branch's harness resolver (`scenario-harness/src/qualifying-invalidation-snapshot.ts`) supports — reading the translator during a sequence, or posting a second snapshot at the crossing step. No new bus event, so `event-names.ts` is untouched. A `scenario-shortcuts.test.ts` entry covers each shortcut.

## Artifacts beyond the code

- `qualifying-invalidation.ts` header: the late contract, the two stashes, the two latches, and why the gate keeps its stash.
- The `registerPitCrew` comment block in `pit-crew/index.ts` where it describes the qualifying/incident ordering.
- `.claude/rules/race-engineer-callout-examples.md`: an entry for the pattern — a separate contract where a script branch would speak the wrong words on a pack that lacks it — and a sentence in `race-engineer-callouts.md` next to the #1138 words/whether test naming that exception.
- Website Pit Crew page, Qualifying Lap Invalidation section; changelog under the in-development version — collapsed into #1211's line if both land in the same release (`.claude/rules/changelog.md`), otherwise an **Improvements** line.

## Out of scope

- Changing the on-time line, its per-N tails, or #1211's refusal of a stale parked fire.
- The position number the parked fire costs at S/F: the readout is dropped by the one pending slot whatever this issue does (#1185 owns the slot); the late line does not read out the position.
- The rare redundancy with the position readout when the on-time line was displaced rather than parked (§1, accepted).
- Speaking the late line for a lap whose on-time fire aborted on expansion (the voice lacks the clips) — the same voice almost certainly lacks the late clip too.
- Time-limited qualifying tails, practice, races, and opponent incidents.
- A voice for the late line in any pack other than `default`.

## Testing

Unit, `packages/audio-scenarios` (`qualifying-invalidation.test.ts`, interpreter-level where the slot matters):

- An approval on lap N under the spotter floor, then `lap.completed` for N: the late fire parks, replaces the stale fire, and on `releaseFocus` speaks the late line; the stale fire never speaks.
- `lap.completed` for N when lap N's on-time line was spoken: the late `where:` refuses.
- `lap.completed` for a lap with no approval, or in a non-qualifying session: refuses.
- Gate: refuses past 15 s from the `lap.completed` timestamp; refuses once the live `lapCompleted` has advanced again or `sessionNum` changed; refuses a second admission for the same lap (late latch); does NOT write the on-time latch (an N+1 incident after the late line still gets its on-time line).
- `qualifying.lateLapsLeft`: `out-of-laps` at 0, `one-left` at 1, `more` at 2+, `null` when not lap-limited or unknown — read from the stash, and still read after an admitted fire is cut and replayed whole.
- An on-time N+1 line arriving while the late line plays cuts it (same family).
- A voice with no script entry for the new contract: the late fire replaces the stale fire in the slot and replays to nothing, with no error.
- Opt-in: `calloutEnabledQualifyingLapInvalidated = false` silences both contracts.

`packages/audio-assets`: the per-voice script coverage test and `bundled-scripts.test.ts` over the new entry and clips; the pack-reference freshness test after regeneration.

Harness: §5's shortcuts, each with a `scenario-shortcuts.test.ts` entry.

Manual, with debug logging on, in a lap-limited qualifying session (an AI session with a car nearby at the line is the practical route): go off track in the last corner of a counted lap while a car is alongside through the line; confirm the log shows the qualifying fire pending, then the late fire pending in its place, then its replay after `Focus released`, and hear "The previous lap was invalidated." with the right tail. Repeat on the last counted lap for the out-of-laps tail. Keep the car alongside for well over 15 s after the line and confirm silence and the gate's refusal in the log.

## Open questions for Niklas

- The `one-left` tail: "One qualifying lap left." — keep the wording, drop the tail, or add a count for two and more?
- 15 s after the line as the late limit.
- The accepted redundancy in §1 (late line plus "That lap didn't count" when the on-time line was displaced rather than parked).
