# Replay Control: Jump to White Flag

> **Issue:** [#1734](https://github.com/niklam/iracedeck/issues/1734) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

This builds on the lap record (#1203, its landing fix #1275 and the crossing search #1432), Jump to Race Start (#1354), the record steps (#1426) and the replay engine package (#1467). The facts settled there are not restated: a recorded lap start is the frame `CarIdxLapCompleted` rose, stored as lap `completed + 1` (what `CarIdxLap` reads); a saved `.rpy` lands a live-recorded frame about a second early; nothing may follow a seek until `ReplayFrameNum` reads the target; and only the replay command gate sends a replay command.

## The decision

1. **The white-flag lap is the viewed car's final lap of the race**: the lap that ends at the car's own checkered crossing. For the leader that is the lap the white flag starts; for a lapped or slower-class car it is the car's own last lap, not the leader's (Niklas: "It's meant for the driver being viewed").
2. **Its number comes from the race's results, and only from there**: the car's `ResultsPositions[].LapsComplete` in the race session, read once the race's results are final. Lap `LapsComplete` of the record's numbering is the final lap; lap `LapsComplete + 1` is the car's checkered crossing and is never a target.
3. **The frame comes from the lap record, else the lap walk**, exactly as Jump to Fastest Lap's does: one waited jump to `LAP_START_APPROACH_FRAMES` before the recorded start with the camera switched onto the car once the cursor has landed, else the walk for that lap, which records what it finds. The press ends as **Replay jump playback** says.
4. **No new recorded section.** The record already holds every car's lap starts; nothing about the white flag needs recording. The replay file does not change.
5. **The press reuses Jump to Race Start's target session and Jump to Fastest Lap's target car**, so a multi-session replay goes to the race and the **Target** setting reads the same: **Viewed Car** (default) or **Always my car**.
6. **The key greys only when the replay holds no race session**, by Jump to Race Start's predicate. A race whose results are not final yet (a live replay mid-race) is a press that sends nothing, and the key keeps its plain look.

## Which lap is the white-flag lap

### The definition

The request names the lap "it starts after the leader has taken the white flag, which is its final lap of the race". The two halves differ in one case: a car slower than the leader that crosses the line just before the leader takes the white, and next crosses after the leader's checkered, never sees a white flag, and its final lap started before the leader's white. The mode follows the second half, the final lap, because that is what a review of a car's finish wants and it is the only half the results can name. In every other case the two are the same lap.

### The numbering, and the off-by-one

Facts from the code, not from a capture:

- The recorder (`sim-events-iracing`'s `diff/replay-laps.ts`) records a crossing where `CarIdxLapCompleted` rises to `c` as the start of lap `c + 1`. The first crossing (−1 → 0) is lap 1.
- So a car that completes `N` laps and takes the checkered has, in the record, a start for lap `N` (the crossing where its count rose to `N − 1`, the start of its final lap) and a start for lap `N + 1` (the checkered crossing itself). `replay-lap-count.ts` documents the same: the finish crossing of a 25-lap race is recorded as a lap-26 start, which is why the dial's lap readout caps the lap at the count.
- A finisher's `LapsComplete` in the final results is `N`. The target lap is therefore `LapsComplete`, with no `+ 1`.

The assumption under this, that `ResultsPositions[].LapsComplete` counts laps the way `CarIdxLapCompleted` does (so a finisher's final count equals its last `CarIdxLapCompleted`), is the one #1203 made for `FastestLap` and is not proven for `LapsComplete`. **To confirm with Niklas** in the manual test (step 1 below); the press checks it on every record hit (next paragraph). Also **to confirm with Niklas**: that `LapsComplete` stops at the checkered and does not count a cool-down crossing after it. The press never depends on the record's highest lap, so a cool-down crossing recorded as lap `N + 2` is harmless either way, but a `LapsComplete` that counted it would aim one lap late.

**The record checks the convention, as #1203's `FastestTime` line does.** On a record hit, when the car's results row carries a positive `LastTime` (seconds) and the record's lap `LapsComplete` carries a `timeMs`, a difference above `FASTEST_TIME_TOLERANCE_MS` is logged at debug (`Jump to white flag: LastTime disagreement — …; jumping anyway`), and the jump still happens. That `LastTime` is the final lap's time in a finished race is **to confirm with Niklas**; if it is not, the line is dropped, and nothing else depends on it.

### Sources rejected

- **The record's highest lap for the car.** It is the checkered crossing for a finisher (lap `N + 1`), may be a cool-down crossing past that, and is short of the final lap whenever the plugin stopped recording before the end. It also cannot exist without the record, so the search fallback would have no lap to search for.
- **Telemetry (`CarIdxLapCompleted`, `CarIdxLap`).** In an in-session replay the per-car arrays read the live field, not the cursor's (#1281): a finished car that left the world reads −1. In a saved replay they follow the cursor and say nothing about the end of the race. Neither names the final lap.
- **The leader's white-flag frame, with the car's first lap start after it.** It needs the leader's final-lap start from the record and the car's lap starts from the record, so it works only with a full record; the results rule works with or without one. It is the right tool for one narrow case (a car that retired on its white-flag lap, below) and is left for a later issue.

## When the race is over

The final lap is known only once the car has taken the checkered, and the press reads that from the race session's `ResultsOfficial`: 1 means every row's `LapsComplete` is final. `replay-lap-count.ts` already reads `ResultsOfficial` 1 as "an earlier session, or a race into its cool-down", from the #801 review. While it reads anything else the press is refused before any command (`Jump to white flag: the race has not finished; press ignored`), which is the request's "a race whose white flag has not been shown yet leaves the replay as it was": a live replay mid-race, before or after the leader's white.

The cost, stated: the #801 spec records a window between a timed race's flag and its results going official, and a press in that window is refused too, although the finishers' final laps are already driven. A live race's `LapsComplete` cannot be trusted as final for a car still on track, and telling which cars have finished needs the leader's checkered frame from the record, so the window is accepted.

**To confirm with Niklas**, in the manual test: that `ResultsOfficial` reads 1 in (a) an offline AI race's in-session replay once the race is over, (b) a hosted or official race's in-session replay during cool-down, and (c) a saved `.rpy` of a finished race. If (c) reads 0, the spec is amended so a saved replay (`WeekendInfo.SimMode` `replay`) counts as over: a file saved mid-race is the rarer case. If (a) or (b) reads 0 for long after every car has finished, the window above is no longer narrow and the leader-frame rule comes into scope.

## Cars that have no white-flag lap

Each is a press refused before any command, logged at info with the reason, the replay left as it was:

- **No row for the car in the race's results**: a car that did not take part in the race (one viewed in practice, a spectator). `no result for the car`.
- **`LapsComplete` below 1**: a car that never completed a lap. `no laps`.
- **A car that did not finish.** iRacing's results rows carry `ReasonOutId` / `ReasonOutStr` (`0` / `Running` for a car still running at the end, as far as this spec knows); no code in the repo reads them yet. A row whose `ReasonOutId` is present and not 0 is refused, `did not finish`. **To confirm with Niklas**: the field names, that a finisher reads 0, and that a retired or disconnected car reads non-zero. A row without the field is treated as a finisher; for a car that did retire that aims at its last completed lap, a harmless wrong answer that the manual test would show.

A car that retired **on** its white-flag lap took the white and is still refused by that rule: telling it from a car that retired earlier needs the leader's white frame from the record (above). Accepted as narrow, and named in _Out of scope_.

A one-lap race has its white flag at the start; its final lap is lap 1, and the press lands a second before the car's first crossing, through the walk's lap-1 handling (#1354) when the record has no frame.

## Which session, and which car

- **The session** is Jump to Race Start's `resolveGreenFlagTarget`: the cursor's session when it is a race (a press inside a heat goes to that heat's final lap), else the last race session the session YAML lists (the race of a single-race event from practice or qualifying, the feature of a heat event). Results are read from the `SessionInfo.Sessions` entry whose `SessionNum` field matches (`findResultsPosition`), never by array position. The record lookup carries the cursor's `SessionUniqueID` when the cursor is in the target, else none, and the walk works in the cursor's instance or the latest one, exactly as Jump to Race Start's fallback does.
- **The car** is Jump to Fastest Lap's `resolveFastestLapCarIdx`: `CamCarIdx` for Viewed Car, `DriverInfo.DriverCarIdx` for Always my car. A `carIdx` stays the same car across the sessions of one event, so a car viewed in qualifying is the same car in the race. `CarIdx` −1 or 255 (the camera in transition or on the pace car) is refused, `no target car`.

**A known gap, accepted:** an offline AI event restarted from the sim's menu holds several passes of the race under one `SessionNum`, and the session YAML's results describe one of them. A press inside another pass aims at a lap number that belongs to a different pass; the record, which the offline record answers by exact instance (#1354), then misses, and the walk searches that pass for a lap it may never have reached, gives up and puts the replay back. No hosted or official session repeats a `SessionNum`.

## The press

`pressJumpToWhiteFlag({ origin, target })` in `@iracedeck/replay-engine`, returning `LapPressResult` like the other two. Its guards run in this order, each before any command is sent:

1. No race session in the replay (`resolveGreenFlagTarget` null): `refused`, `no race session`. The one case the key greys for.
2. No target car: `refused`.
3. `SessionNum` −1, the post-seek transient: `refused`, `replay session not settled`.
4. The race's results not final: `refused`, `race not finished`.
5. No white-flag lap for the car (the three cases above): `refused` with that reason.
6. No car number for the camera (`carNumberRawByIdx`): `refused`.
7. A Jump to Fastest Lap, Jump to Race Start or Jump to White Flag press in flight (the shared slot in `lap-press.ts`): `ignored`, which the key reports to the replay busy indicator.
8. No replay on screen by the controller's debounced replay state (#1324): `refused`, `replay not open`.

Then the lookup, `lookupRecordedLapStart({ subSessionId, sessionNum, sessionUniqueId, carIdx, carNumberRaw, lap: LapsComplete })`, logged as `Jump to white flag: record HIT (matchedBy …)` or `record MISS (<reason>); walking`:

- **A hit** is Jump to Fastest Lap's record jump: the shared jump sequence to `max(0, frame − LAP_START_APPROACH_FRAMES)`, the camera switched onto the car in its `afterLanding` step (a command sent during the seek would cut it short, #1275; the gate runs the step on the read-back, #1430), then the **Replay jump playback** step. For Viewed Car the switch is onto the car already on screen.
- **A miss** is Jump to Fastest Lap's walk for lap `LapsComplete` in the target session: the camera onto the car first (iRacing's lap search follows the camera), the session map, the bisection that ignores probes finding the car gone (a finisher leaves the world after the race, which the #1354 probe order handles), the lap steps and the crossing search (#1432). A converged walk records the lap start, so the next press is a lookup, and leaves the cursor at the same approach a record hit lands on. A walk that gives up, or that a camera key interrupts, puts the replay back and the camera back on the car viewed at the press (#1354, #1428 / #1435); another replay command cancels it and its effect stands.

**The landing is Jump to Fastest Lap's one second (`LAP_START_APPROACH_FRAMES`, 60), not Jump to Race Start's five.** The request asks to land "just before the car takes the line", and the walk already leaves the cursor at that approach, so the record path and the search path land on the same spot. Five seconds would add a jump after every converged walk for a run-up nobody asked for. If the manual test shows the white flag being waved needs more lead-in, the constant for this mode is changed in one commit; it is not a setting.

**The record jump and the walk are Jump to Fastest Lap's, parameterised, not copied.** `jumpToRecordedLapStart` and `walkToFastestLap` take the press identity (the cursor owner, the log label) instead of hardcoding Fastest Lap's, and the two presses call them with their own. New in `lap-press.ts` / `lap-walk-owners.ts`: `WHITE_FLAG_RECORD_JUMP_OWNER` (`jump-to-white-flag record jump`), `WHITE_FLAG_WALK_OWNER` (`jump-to-white-flag walk`, added to `LAP_WALK_OWNERS`, so leaving the replay cancels it and a camera switch interrupts it like the other two walks) and `WHITE_FLAG_LOG_LABEL` (`Jump to white flag`). Existing Fastest Lap log lines keep their wording (the engine's rule that log text survives a move). The white-flag lap rule itself is a pure module, `white-flag-target.ts`, beside `green-flag-target.ts`: `resolveWhiteFlagLap(sessionInfo, sessionNum, carIdx)` → `{ hit: true, lap }` or `{ hit: false, reason }`, with the reasons above. The press keeps no module state of its own (the in-flight slot is `lap-press.ts`'s), so `_resetReplayEngine` gains nothing; the reset coverage test says so if that turns out wrong.

Everything the gate, the cursor and the camera-switch waiter do for the other two presses holds unchanged: a camera key pressed during the search stops it and switches after the way back, a camera key pressed during a jump switches once it lands, and any other replay key cancels the press.

## No new recorded section

The issue proposed, and this spec confirms: the record needs nothing new. The final lap's number comes from the results and its frame from the lap record, which every replay recorded since 3.4 has. **Rejected: recording the white flag as a `greens` kind or a section of its own.** It would be per race, not per car, so a lapped car would still need the lap record for its own final lap; it would help only replays recorded after it shipped; and it would be a persisted-format change (a new `kind` the store carries through, or a section with its own version) for no lap the results do not already name.

## The key

- **Title** `WHITE\nFLAG`, in `REPLAY_CONTROL_TITLES`, the shape of `RACE\nSTART` and `FASTEST\nLAP`.
- **The unavailable look** is Jump to Race Start's, with its rules: drawn when the session YAML lists sessions and none is a race (`isRaceStartUnavailable`), not with no session list at all, not from the car, and not for a race whose results are not final yet, since the key would then be grey for the whole of every live race. The per-context bookkeeping that redraws the key when the session list gains or loses its race (`raceStartShown`, `refreshRaceStartAvailability`) is widened to both modes, not duplicated.
- **The busy indicator**: the mode joins `BUSY_DRAWS_WORKING_MODES` and registers like Jump to Fastest Lap, so the ring of dots turns while the jump or the search is on its way, and a press ignored behind one in flight shows the red cross.
- **The icon** is new: `packages/icons/replay-control/jump-to-white-flag.svg`, in the replay-control family's style with a white flag as its distinct element, its preview regenerated (`node scripts/generate-icon-previews.mjs`) and its distinctiveness against Jump to Race Start and Jump to Fastest Lap checked per `icons.md`. **Niklas approves it on a review page** (`review-page` skill) before it is committed.

## Settings, the persisted contract

Two changes to `ReplayControlSettings`, both additive:

```typescript
mode: z.enum(REPLAY_CONTROL_MODES).default("play-pause"), // REPLAY_CONTROL_MODES gains "jump-to-white-flag", after "jump-to-race-start"
whiteFlagTarget: z.enum(["viewed-car", "always-my-car"]).default("viewed-car").catch("viewed-car"),
```

- **The stored mode value is `jump-to-white-flag`**, matching the label Jump to White Flag. Nothing has shipped, so it is settled now, not renamed later as Jump to Race Start's had to be.
- **The target is a key of its own, `whiteFlagTarget`, not `fastestLapTarget`.** Each mode keeps its own stored choice, so a key switched between the two modes does not carry one mode's target into the other, and the name says which mode it governs. The values are the same two strings, so the engine's `target` parameter type is shared.
- **`.catch("viewed-car")`, deliberately unlike `fastestLapTarget`.** `parseSettings` falls back to all defaults when any field fails, which would turn a key whose stored target a later build widened into a Play / Pause key. A missing or unknown `whiteFlagTarget` reads as Viewed Car and leaves the rest of the key's settings alone. `fastestLapTarget` is left as it is (_Out of scope_).
- **Downgrade, as for every new mode:** a build before this one reads `mode: "jump-to-white-flag"` as invalid and shows the key as Play / Pause until the user picks a mode; the stored settings are not rewritten by the read. Same as when Jump to Race Start was added.

**The PI** (`replay-control.ejs`, which all three plugins build): `<option value="jump-to-white-flag">Jump to White Flag</option>` after Jump to Race Start in the keypad's **Mode** dropdown, and a **Target** item shown only for this mode, built like Fastest Lap's:

```html
<sdpi-item id="white-flag-target-setting" label="Target" class="hidden">
	<sdpi-radio setting="whiteFlagTarget" default="viewed-car" columns="1">
		<option value="viewed-car">Viewed Car</option>
		<option value="always-my-car">Always my car</option>
	</sdpi-radio>
</sdpi-item>
```

The dial's gesture-slot lists do not gain the mode (_Out of scope_). The mode's per-mode comms entry in `action-comms.json` is iRacing API, like Jump to Fastest Lap's.

## What else changes

- **Website**: a `### Jump to White Flag` section on `replay-control.md` in the format of the Jump to Fastest Lap and Jump to Race Start sections (the final lap of the viewed car, a lapped car's own last lap, the Target setting, the record and the search, "not finished yet" and "did not finish" as no-ops, the grey key), the mode named in the busy-indicator and camera-key paragraphs that list the other two jumps, and the **Replay jump playback** list of covered jumps on the settings page.
- **Changelog**: one `Features` fragment, `changelog.d/1734-replay-jump-to-white-flag.md`.
- **`docs/reference/actions.json`** and the `iracedeck-actions` skill's Replay Control modes list.
- **`packages/replay-engine/CLAUDE.md`**: the module map gains `white-flag-target.ts` and `white-flag-press.ts`, and the lap-walk owners and the presses' descriptions name the third press.
- Nothing on the Architecture page: no package, seam or data flow changes. No bus event, so no scenario-harness entry.

## Out of scope

- A car that retired on its white-flag lap (refused today), and the press inside the window between a race's flag and its results going official. Both need the leader's white or checkered frame from the record; a later issue if either is asked for.
- A restarted offline event's earlier race passes (the known gap above).
- The dial: no gesture-slot option and no rotation mode. Jump to Race Start went into the slots because a review starts there and a Mirabox knob reaches only Press; nothing says that of the final lap yet.
- A per-mode or global setting for the lead-in.
- Changing `fastestLapTarget` to `.catch`, or merging the two target keys.
- The legacy Replay Navigation action, which gains nothing.
- Recording the white flag or the checkered flag (see _No new recorded section_).
- Practice, qualifying and warm-up sessions: the mode is about a race's finish.

## Testing

Unit tests, in the package that owns each piece:

- **`white-flag-target.ts`** (replay-engine): a finisher's lap is its `LapsComplete`, never `+ 1`; a lapped car gets its own count, not the leader's; results not official → `race not finished` (0, absent, a string); no row → `no result for the car`; `LapsComplete` 0 or −1 → `no laps`; `ReasonOutId` non-zero → `did not finish`, 0 and absent → the lap; the session matched by `SessionNum` field with the array out of order; a one-lap race → lap 1.
- **`pressJumpToWhiteFlag`** (replay-engine, against the fake controller and clock the other presses' tests use):
  - Each guard, in order, sends nothing: no race session, no target car (−1 and 255), `SessionNum` −1, results not official (the live mid-race case), each no-white-flag-lap reason, no car number, a press of any of the three jumps in flight (`ignored`, and the one in flight is not cancelled), from the car.
  - A record hit sends one waited jump to `frame − 60` (clamped at 0), the camera onto the car only after the read-back, then the playback step; the lookup asks for lap `LapsComplete`, and a record that also holds lap `LapsComplete + 1` (the checkered crossing) and a cool-down lap past it is not jumped to them.
  - Always my car: the lookup and the camera use `DriverCarIdx` while the camera is on another car.
  - A lapped car: two laps down from the leader, the press aims at the car's own last lap.
  - Multi-session: from practice the target is the last race session and the lookup carries no unique id; inside a heat, that heat.
  - A miss walks lap `LapsComplete` of the target session and records what it finds; a second press is then a record hit. A walk that gives up puts the replay and the camera back.
  - The `LastTime` disagreement line appears when the times differ by more than the tolerance, and the jump still happens.
  - The walk owner is in `LAP_WALK_OWNERS`: leaving the replay cancels it and a camera switch interrupts it, as for the other two walks.
  - Jump to Fastest Lap's existing tests pass unchanged after the record jump and the walk take the press identity (the parameterisation is a refactor for them).
- **Replay Control** (iracing-actions): the key calls the engine with `whiteFlagTarget` and reports `ignored` to the busy indicator; the key renders the unavailable look with no race session, plain with no session list and for an unfinished race, and redraws when the session list gains or loses its race; the title; `whiteFlagTarget` missing and unknown both parse to `viewed-car` without resetting the mode (the positive control: an unknown `fastestLapTarget` still resets, so the test is not vacuous); the PI shows the Target item for this mode only and the Mode label is exactly "Mode"; the comms entry, `docs/reference/actions.json` and the icon preview's freshness test.
- The suites as a whole: `install`, `build`, `typecheck`, `format`, `lint`, `test`, with the reset-coverage and single-sender tests green.

Manual, in the sim (the gate before the PR), with the plugin's log at debug:

1. **Record path, finisher, and the convention.** An offline AI race of a few laps, run with the plugin. In the in-session replay after the finish, view the winner and press from mid-race. Expect `record HIT`, a landing one second before the winner takes the white flag, no `LastTime disagreement` line, and the replay left as **Replay jump playback** says. Read the log's lap number against the race's lap count: it must be the last lap. This confirms `LapsComplete` = the final lap and `ResultsOfficial` 1 in an offline in-session replay.
2. **Lapped car.** View a car a lap or more down and press: it lands before that car's own final lap, after the leader's white.
3. **Always my car.** With the camera on another car, press a key set to Always my car: the replay lands on your own final lap and the camera is on your car.
4. **Saved file.** In a hosted or official race, save the replay, reopen the `.rpy` and press. Expect a record hit landing about two seconds before the line (the saved-file lag). This confirms `ResultsOfficial` in a saved replay.
5. **Search fallback.** Move the session file away, restart the deck host, press. Expect `record MISS (no file); walking`, the walk to the final lap, the same landing, and a second press that is a record hit.
6. **Not finished.** During a live race, open the replay and press: nothing moves, and the log says the race has not finished. If possible, press again during cool-down after the checkered and note in this spec whether the results were official yet.
7. **Did not finish.** View a car that retired mid-race and press: nothing moves, the log names `did not finish`. Note the car's `ReasonOutId` / `ReasonOutStr` in the session YAML (a Telemetry Display key or a snapshot), and a finisher's.
8. **Multi-session and no race.** From practice and qualifying in a replay that holds both before the race: it lands on the race's final lap. A practice-only replay: the key is grey and a press does nothing.
9. **A camera key during the search** (step 5's setup): the search stops, the replay goes back, then the camera switches.
