# Jump to Fastest Lap from the session record

> **Issue:** [#1203](https://github.com/niklam/iracedeck/issues/1203) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Ships with #1162 from one worktree and one PR closing both. The sim facts this spec leans on (live frames are `ReplayFrameNumEnd`, replay frames are `ReplayFrameNum`, `IsReplayPlaying` is the per-tick replay predicate, a saved `.rpy` keeps the live `SubSessionID` and lands live-recorded frames about a second early, offline sessions read `SubSessionID` 0) are settled in `2026-09-13-issue-1162-replay-markers.md` and not restated here.

## The decision

Three things, in the order the press meets them.

1. **A `laps` section in the per-session replay file.** While the session runs live, iRaceDeck records the frame at which every car starts every lap, and the time of every lap once the sim publishes it. The translator (`@iracedeck/sim-events-iracing`) detects the crossings and publishes them as bus events; the deck-core replay store writes them.
2. **Jump to Fastest Lap is a lookup first.** With the target car's fastest lap in the record, the press is one camera switch, one `setPlayPosition(Begin, frame − 60)`, and `play()`: the replay lands a second before the car takes the line and runs the lap at 1× — the issue's expected behaviour. Play keeps working afterwards because the action's own speed cache is told what was sent.
3. **The walk stays as the fallback and is repaired from the code.** No record (the plugin was not running, someone else's `.rpy`, an offline session's replay opened later, a lap missed while the driver was in the replay view) still walks the replay. The walk gets five changes, each aimed at a defect visible in the code; which of them the reporter hit is a hypothesis, stated as such below, and the manual test is written to tell them apart.

## The laps section

### Shape

```json
"laps": {
  "version": 1,
  "sessions": [
    {
      "sessionNum": 2,
      "sessionUniqueId": 4,
      "cars": {
        "7": {
          "carNumberRaw": 2,
          "userId": 123456,
          "laps": [
            { "lap": 1, "frame": 30821, "timeMs": null },
            { "lap": 2, "frame": 36305, "timeMs": 91433 }
          ]
        }
      }
    }
  ]
}
```

An entry `{ lap: n, frame, timeMs }` says: this car started lap `n` at replay frame `frame`, and lap `n` took `timeMs` (null until the sim publishes it, and forever null for a lap it never timed). The section owns its own `version`; the file's envelope version is #1162's and does not move for it.

**Keyed by `carIdx`, verified by `carNumberRaw`.** The lookup has a `carIdx` in hand — `resolveFastestLapCarIdx` gives one and `ResultsPositions[].CarIdx` is how `findFastestLapForCar` names the car — and a saved replay carries the same `DriverInfo`, so `carIdx` is the natural key. It is not trusted alone: iRacing assigns it at join, and a record written for one driver must not answer for another car that inherited the index. `carNumberRaw` is stored beside it and must match at lookup, because it is what stays put across the event and across driver swaps in team racing, where `UserID` changes per stint (`DriverInfo.Drivers[].UserID` is stored for a person reading the file and for a future consumer, and is not part of the match). A mismatch is a miss, never a wrong jump.

**Per `(sessionNum, sessionUniqueId)`, not per `sessionNum`.** The 2026-09-17 Homestead captures show `SessionNum` 0 under `SessionUniqueID` 1 and, after a restart within the same sim run, `SessionNum` 0 again under `SessionUniqueID` 2 while `ReplayFrameNumEnd` kept growing (18446 → 47005) — one recording, two instances of session 0, each with its own laps. The #607 walk keys its own cache on `SessionUniqueID` for the same reason. The lookup matches the pair; when the replay's telemetry offers no `SessionUniqueID` or none matches and exactly one record has the `sessionNum`, that one is used, so a file whose `SessionUniqueID` numbering does not survive the save is still useful (the one saved `.rpy` captured, 86697546, kept its live value 3).

### Detection, in the translator

A new diff module, `packages/sim-events-iracing/src/diff/replay-laps.ts`, over `CarIdxLapCompleted` with a per-car previous-tick baseline in `TranslatorState` (the `opponent-pit.ts` shape: baselines advance element-wise every tick).

- **A crossing is `CarIdxLapCompleted[c]` rising by exactly 1** from a non-negative baseline, or from −1 to 0 — the first S/F crossing, since the counter is −1 for every car until then (#307). On that tick the car starts lap `CarIdxLapCompleted[c] + 1`, which is also what `CarIdxLap[c]` reads (the 2026-09-23 capture has `CarIdxLap` 0 beside `CarIdxLapCompleted` −1 before the first crossing; `gap-utils.ts` records that the two differ by one at the line). The entry is `{ lap: completed + 1, frame }`.
- **`frame` is `resolveReplayFrame(telemetry)` on the crossing tick**, which under the recorder's gate is `ReplayFrameNumEnd` — the live frame, recorded raw per the #1162 decision (no lag correction).
- **Any other change re-seeds the car silently**: a jump of more than one (a tow, a reset, a late join with laps already scored), a decrease, or a return from −1 to a positive number. Those are not crossings the replay can show, and inventing an entry for them would put a wrong frame in the file.
- **The lap time lags the crossing.** iRacing refreshes `CarIdxLastLapTime` a tick or two after the counter moves — the player-side `diff/laps.ts` triggers on `LapLastLapTime` changing for exactly that reason, and the translator's leader-pace resolver reads `CarIdxLastLapTime` with the same caveat. So the crossing tick opens a per-car wait: when `CarIdxLastLapTime[c]` changes from the value it held on the crossing tick and is positive, it is published as the time of the lap just completed (`completed`, the entry before the one just opened); a `REPLAY_LAP_TIME_WAIT_TICKS` budget of 120 (2 s) closes the wait with no time. Two byte-identical consecutive laps leave the second untimed, the same accepted improbability `diff/laps.ts` documents. A first crossing (−1 → 0) opens no wait: there is no completed lap.
- **Gate: record only what is live and observable.** A tick is eligible when `IsReplayPlaying !== true` (the per-car arrays follow the replay cursor while a replay is on screen, so a crossing seen there is the replay's, not the field's), `!isReplayOnlySession(sessionInfo)` (a `.rpy` has nothing live in it), and `SessionNum >= 0`. Every ineligible tick marks the recorder unseeded, and the first eligible tick after it re-seeds every baseline without emitting, so a driver returning from the garage or the replay view to a field that crossed the line meanwhile produces no fabricated crossings. Laps completed by other cars during that window are simply absent from the record and fall through to the walk. This gate is the reason the diff runs **before** the translator's replay guard, beside `diffFirstOnTrack` and `diffStartCountdown` (#829): the guard's early return would stop it on exactly the ticks it has to notice it cannot see, and its state is deliberately left in `wipeStateForReplay`'s wiped set — a re-seed is what the return from a replay needs.
- **Session change** (`SessionNum` or `SessionUniqueID` moves) re-seeds and starts a new session record. The store closes any open lap-time waits by leaving them null.

### Events

Two additions to the catalog in `@iracedeck/event-bus`, with matching `event-names.ts` entries in the scenario harness (required for every new bus event; they drive no callout, so no shortcut button):

```typescript
"replay.lapStarted": SimEvent<"replay.lapStarted", {
  subSessionId: number; sessionNum: number; sessionUniqueId: number;
  carIdx: number; carNumberRaw: number; userId: number;
  lap: number; frame: number;
}>;
"replay.lapTimed": SimEvent<"replay.lapTimed", {
  subSessionId: number; sessionNum: number; sessionUniqueId: number;
  carIdx: number; lap: number; timeMs: number;
}>;
```

Two events rather than one delayed one, because the frame is the value that must not be lost: it is known at the crossing and goes out at the crossing, while the time arrives when the sim says so or never. The store's debounce merges them into one write regardless. A replay frame is not an iRacing-only idea — any sim with a replay has a position in it — so the events fit the sim-agnostic catalog; a future translator emits the same two.

### Write frequency

A 60-car field crosses the line over a few seconds, twice per lap counting the timed events. The store therefore never writes per event: each `laps` update mutates the in-memory section and schedules one trailing-debounced write (`REPLAY_STORE_WRITE_DEBOUNCE_MS`, 2000 — long enough that a crossing wave lands as one file, short enough that a plugin killed by a deck-host update loses at most a couple of seconds), with an immediate flush on session change, on SDK disconnect and in the `process.on("exit")` `flushSync` every plugin already wires for the settings store. Atomic replace, retries and the corrupt-file aside are #1162's store rules and apply unchanged; the section is written through the store's API so `markers` and any unknown section are carried through.

## Where the recorder lives

**Chosen: the translator detects and publishes; the deck-core store persists; each `plugin.ts` connects the two.** `@iracedeck/sim-events-iracing` is the one package that reads `@iracedeck/iracing-sdk` telemetry for events, and the crossing detection is translator work in every particular — a per-car array diff, the #307 sentinel, the teleport re-seed, the lap-time lag, the replay-view blindness, the session-change reset — with forty sibling modules and capture-cut fixtures to test it against. The store stays what #1162 made it: a section owner that knows files and nothing about telemetry. And the seam is the one the Architecture page already draws: a second sim's translator emits the same two events and the store does not change. The wiring in `plugin.ts` (three copies, byte-identical) is two `eventBus.subscribe` calls forwarding into `getReplaySessionStore().laps`, beside the `registerPitCrew` wiring, so it runs from plugin start whether or not a Replay Control key is on any deck — the translator subscribes to the SDK controller in `initializeSimEventsIracing` at startup, and the controller polls while it has any subscriber. deck-core does not depend on `@iracedeck/event-bus` and does not gain the dependency for this; the plugin is where the bus and the store already meet.

**Rejected: a deck-core service subscribed to `getController()` ticks.** It is the shorter wire (deck-core already holds the SDK singleton and the elevation-check subscriber is that exact shape), but it makes deck-core the second package deriving sim semantics from telemetry, copying the −1 sentinel, the re-seed rules and the replay gate out of the translator into a package whose `CLAUDE.md` calls it platform-agnostic infrastructure; a second sim would then need a second recorder inside deck-core rather than a second translator; and the module would sit outside the translator's `handleTick` order, its state outside `TranslatorState`, its tests outside the fixture replays — every convenience the translator gives a diff, forgone for a dependency edge that already exists on the other side.

The action reads the record synchronously through `getReplaySessionStore()` from deck-core, the same way it reads `getCommands()` and `getGlobalSettings()`.

## Jump to Fastest Lap as a lookup

The press resolves the target exactly as today: `resolveFastestLapCarIdx` for the car, `findFastestLapForCar` for the lap number (`ResultsPositions[].FastestLap` first, `CarIdxBestLapNum` as the live fallback), `SessionNum` and `SessionUniqueID` from the replay's telemetry, `SubSessionID` from `WeekendInfo`. Then:

1. `store.laps.findLapStart({ subSessionId, sessionNum, sessionUniqueId, carIdx, carNumberRaw, lap })` → a frame, or null.
2. On a frame: the camera switch (`camera.switchNum`, as today, so the viewed car is the one whose lap plays), any in-flight walk is cancelled, then `setPlayPosition(Begin, max(0, frame − LAP_START_APPROACH_FRAMES))` with `LAP_START_APPROACH_FRAMES = 60`, then `play()`, `setLocalSpeed(1, false)`, and the telemetry displays refresh. It plays: the issue's expected behaviour is "moves to the start of the lap and plays it", and a jump that parks paused is the behaviour the reporter had. One second of approach in the in-session replay, two in a saved file (the #1162 lag decision), both showing the crossing into the timed lap.
3. On null: the walk, logged as `record MISS` with the reason (no file, no session, no car, car mismatch, lap not recorded), so a support log says which.

The lap number convention — that `FastestLap` and `CarIdxBestLapNum` count laps the way `CarIdxLap` does, so the record's `lap` matches — is the same one the #607 walk relies on (`CarIdxLap === targetLap − 1` as "the lap before"), and the record can check it: when `ResultsPositions[].FastestTime` is present and differs from the matched entry's `timeMs` by more than a tick, the action logs the disagreement at debug and still jumps. The manual test reads that line.

## The walk: what is wrong with it, and what changes

`walkToFastestLap` (`packages/iracing-actions/src/actions/replay-control/replay-control.ts`) has not changed since #607 (`3d609d03f`, one follow-up `4f612bbf7` touching only tests). Read against the maintainer's frame facts and the play-pause path, five defects are visible. **None is proven to be the reporter's** — there is no log or video — and the fix takes all five because each is a defect on its own and cheap to correct. What is hypothesis is marked as such.

1. **The walk ends paused and the Play key may then send pause.** The walk opens with `replay.pause()` and never calls `setLocalSpeed(0)`; the play-pause mode decides from the action's `replaySpeed` cache, which is refreshed only by subscriber ticks — and the controller notifies subscribers only when `SessionTick` advances. If a paused replay stops advancing `SessionTick` (unmeasured; hypothesis), the cache still says 1 from live and a Play press sends `pause()`, which is "Play afterwards does not help" exactly. Whether or not that mechanism holds, the documented end state ("the replay is left paused; press your Play button") is what the issue rejects. **Change:** every speed the walk sends is mirrored into the cache (`setLocalSpeed(0)` after the opening pause, `setLocalSpeed(1)` after the closing play), and the walk ends with `play()` at 1× after the back-step, then refreshes the telemetry displays — the same end state as the lookup.
2. **The buffer's end is learned by `goToEnd`, which in a live session leaves the replay.** The session map reads `ReplayFrameNum` after `goToEnd`; `ReplaySearch ToEnd` during a live session returns the sim to the live view, where `ReplayFrameNum` reads 0 (every live capture). The last session's `endFrame` is then 0, `hiFrame <= loFrame`, and every press in that session aborts with "empty session bounds" — and the map is cached per `SessionUniqueID`, so the abort repeats until a new session. This one follows from the captured facts rather than from a guess, and it would explain "never worked in practice or race" for the in-session case but not for a saved `.rpy`, where `goToEnd` stays in the replay. **Change:** no `goToEnd`. The recording's total length is `ReplayFrameNum + ReplayFrameNumEnd`, constant and readable from any replay frame, so the map's build is `goToStart` → `nextSession` × N and the extent comes from the first stable read. Fewer commands, and the walk never leaves the replay.
3. **A settle is measured by the clock, not by the cursor.** `readStableTelemetry` sleeps the configured delay and accepts the first sample with `SessionNum >= 0`. A jump that has not landed yet when the sleep ends returns the old frame's telemetry with a perfectly valid `SessionNum`, and the bisection halves the wrong bracket; a saved replay seeking on disk is where a jump plausibly takes longer than 400 ms (hypothesis — the transient the code waits out was measured at ~514 ms on one machine in one paused in-session replay). A corrupted bracket converges to the wrong lap, the lap-step phase runs out its ten steps, and the cursor is left a few frames from wherever it got to — "moves a few frames" describes the back-step and the nudges. **Change:** an absolute jump settles when `ReplayFrameNum` equals the frame that was sent (bounded by the same `× 4` timeout, after which the walk aborts and logs the frame it saw); a search (`goToStart`, `nextSession`, `nextLap`, `prevLap`) settles when `ReplayFrameNum` has moved from its pre-command value and then held across two reads 50 ms apart. `fastestLapSearchDelayMs` keeps its meaning as the minimum gap after a search — the asynchronous lap-boundary resolution it was introduced for is still real — and becomes the timeout base for absolute jumps rather than their wait.
4. **The user cannot take the replay back.** A walk runs for up to tens of seconds (a session map, up to 30 bisection probes and 10 lap steps, each at least the configured delay and up to four times it), issuing a search every few hundred milliseconds. A Play press mid-walk is honoured by the sim for a moment and then overridden by the next probe — "sometimes moves a few frames and never starts playing" also describes that (hypothesis). And the in-flight guard is per context, so two Jump to Fastest Lap keys run two walks against one cursor. **Change:** one walk per action instance, held with a cancellation token; every other Replay Control mode dispatched while it runs (play, pause, stop, speeds, searches, the jumps) cancels it at its next await, sends its own command, and the walk leaves the cursor wherever the user's command put it, logging `walk cancelled by <mode>`. A second Jump to Fastest Lap press during a walk is still ignored, as today — the walk in flight is converging on the same target.
5. **Its result is thrown away.** The landed frame goes into a module-level cache keyed by `(carIdx, targetLap, sessionNum)` that dies with the process. **Change:** a walk that converges writes its landed frame into the record as that car's lap start (`store.laps.recordLapStart`, with `timeMs` left null and the frame back-adjusted by the two ticks the walk stepped back), so the next press for that lap — and a press after a restart, and a marker-style jump from another feature — is a lookup. The module cache goes; the record is the cache.

The walk's phases otherwise stand: the `SessionUniqueID`-keyed session map, bisection on `CarIdxLap` within the target session's bounds, lap steps to the lap before, the distance nudge and the two-tick back-step. The nudge and back-step exist because the walk cannot know the crossing frame; the record does, which is why the lookup path needs neither.

## Out of scope

- New actions or modes the data enables — jump to lap N, to a driver's last lap, to another car's lap, a lap browser or lap-time display on the key. The record is written so they can be built; none is.
- Backfilling laps the recorder could not see (driver in the replay view or the garage while the field crossed the line). The walk covers them.
- Recording anything from a replay being watched: a `.rpy` of someone else's session is walked, never learned from beyond the walk's own landed frame.
- A clean-lap filter on "fastest" (the website already says there is none, and telemetry still does not expose per-lap incidents).
- The replay memory-limit renumbering risk (recorded in the #1162 spec as open).
- Dial semantics for the mode: it remains a single-shot key with no rotation or push meaning.
- The `SessionNum` −1 transient model itself: the frame-settle removes the walk's dependence on it, and no capture of it is made here.

## Testing

Unit tests, in the package that owns each piece:

- **`diff/replay-laps.ts`** (sim-events-iracing): first-tick seed emits nothing; −1 → 0 emits lap 1 with the tick's `ReplayFrameNumEnd` and opens no time wait; n → n+1 emits lap n+2 and the later `CarIdxLastLapTime` change emits `replay.lapTimed` for lap n+1; a jump of two, a decrease and a NotInWorld car re-seed silently; the 120-tick budget closes a wait with no event; identical consecutive lap times leave the second untimed; a replay tick (`IsReplayPlaying` true) or a `SimMode: "replay"` session marks the recorder unseeded and the first eligible tick after it emits nothing; a `SessionNum` or `SessionUniqueID` change starts a new session; the module's position in `handleTick` is pinned as pre-guard (the #1127 ordering-test shape). A fixture cut from a capture with two full crossings of a multi-car field (a new `telemetry-watch` recording; the 2026-09-17 and 2026-09-19 `.jsonl` captures in `local/` carry `CarIdxLapCompleted` and `CarIdxLastLapTime` and are the first candidates) replays through the translator and asserts the exact event sequence.
- **The store's `laps` section** (deck-core): entries per `(sessionNum, sessionUniqueId)`, per car with `carNumberRaw`; `findLapStart` hits by the pair, falls back to a unique `sessionNum`, misses on a `carNumberRaw` mismatch and on a missing lap; a time arriving for a lap with no start entry is kept and paired when the start arrives; one write per debounce window for a burst of 120 updates, atomic; `markers` and an unknown section survive a laps write; `flushSync` lands a pending write; the ephemeral offline record takes laps too and never reaches disk.
- **Replay Control** (iracing-actions, under the deck-core mock with a mocked store): a record hit sends exactly `switchNum`, one `setPlayPosition(Begin, frame − 60)` clamped at 0, and `play()`, updates the local speed to 1, and calls no search; a miss walks; the walk's opening pause and closing play both mirror into the cache; the walk never calls `goToEnd` and derives the extent from `ReplayFrameNum + ReplayFrameNumEnd`; an absolute jump waits for `ReplayFrameNum` to equal the sent frame and aborts past the timeout; a search waits for the frame to move and hold; a play-pause dispatch during a walk cancels it and the walk issues no further command; a second fastest-lap press during a walk is ignored; a converged walk records its landed frame; the `FastestTime` disagreement logs at debug and still jumps.
- **Catalog and harness**: the two events compile in `event-names.ts` (the completeness check fails the build otherwise).

Manual, in the sim (the gate before the PR), with the plugin's log open at info:

1. **Record path, in-session.** Run a live race (AI is fine — offline works in memory) for several laps, then open the in-session replay and press Jump to Fastest Lap with the camera on your car. Expect: the log line `record HIT`, one jump, the replay playing at 1× with the car about a second from the line, and the Play/Pause key showing PAUSE and pausing on its next press. Press again: same result (no walk). Switch the camera to a competitor and press: their lap, from the record.
2. **Convention check.** In the same replay, compare the recorded lap's time in the log against the sim's own fastest-lap display for that car; the `FastestTime` disagreement line must not appear.
3. **Saved file.** Save the replay, quit the sim, reopen the `.rpy`. Expect `record HIT`, the car about two seconds from the line, playing. This step also measures the lag: the in-session landing in step 1 was ~1 s early; if this one is ~2 s, only the file carries the lag and the #1162 decision stands; if step 1 was also ~2 s early, the in-sim replay carries it too and `REPLAY_FILE_FRAME_LAG` becomes a record-time correction (one constant, one commit).
4. **`SessionUniqueID` in the file.** The 2026-06-26 capture of the 86697546 `.rpy` already reads `SessionUniqueID` 3, the live value, so the pair should match; the log's `record HIT` line names whether the match was by pair or by the `sessionNum` fallback, and the fallback firing on this step would contradict that capture.
5. **Fallback walk, repaired.** Rename `session_<id>.json` away and restart the deck host (the store holds the record in memory for the session it has open, so a rename alone changes nothing), then press. Expect `record MISS (no file)`, the walk's log lines showing no `goToEnd` and each probe settling on its frame, and the replay **playing** at the end, about the two-tick back-step before the line. Press Play during a later walk: expect `walk cancelled by play-pause` and the replay playing from wherever it was. Then restore the file.
6. **Live-session map.** During a live session (not a saved file), restart the deck host after the fastest lap was set so the record lacks it, then press from the in-session replay: the walk must not jump to the live view, and must not log "empty session bounds" — the defect in point 2.
7. **Offline.** An offline test session: step 1 works from memory; no file appears under `Replay\`; after quitting and reopening its saved replay, the press walks (`record MISS (no file)`), as ruled.
8. **Two keys.** Two Jump to Fastest Lap keys pressed in quick succession on a lap the record lacks (as in step 6): one walk, the second press logged as ignored.

The unit tests cannot prove which of the five walk defects the reporter hit and the manual test can only show that each is gone; that is stated so nobody reads a green run as a diagnosis.
