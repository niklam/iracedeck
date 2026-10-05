# Jump to Green Flag from the session record

> **Issue:** [#1354](https://github.com/niklam/iracedeck/issues/1354) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

This builds on the per-session replay store (#1162) and the lap record (#1203, landing fix #1275). The sim facts settled there are not restated here: live frames are `ReplayFrameNumEnd`, a saved `.rpy` keeps the live `SubSessionID` and lands live-recorded frames about a second early, offline sessions are held in memory only, and nothing may follow a seek until `ReplayFrameNum` reads the target.

## The decision

1. **The race goes green at one frame, and iRaceDeck records it live.** A new translator diff publishes `replay.greenFlag` when a race session leaves a real pre-green state for `Racing`, and on every caution restart. The deck-core store keeps those moments in a new `greens` section of the per-session file.
2. **Jump to Green Flag is a lookup first.** The press resolves the target race session, finds its recorded start, and makes one waited jump to five seconds before the green, then plays. It switches no camera: the green belongs to the whole field, and the user has already chosen which car to watch.
3. **The fallback is the pole car's lap 1.** With no green record, the press jumps to five seconds before the pole car starts lap 1. That frame comes from the lap record when there is one, and from the #1203 walk otherwise. The result is close to the green, and before it except in the edge cases listed below.
4. **Restarts are recorded but not yet jumped to.** The one key ships for the race start, which is what the request says. Restarts go into the file from day one, because a replay's restarts cannot be recorded after the fact. A Next Green / Previous Green pair is the designed extension, for a later issue if it is ever asked for (see _Restarts_ below).

## What "the green" is

### Race start: `SessionState` entering `Racing` from a real pre-green state

The translator already treats `SessionState` as the authority on whether a race has started. `isPreGreen` in `iracing-sdk` is `GetInCar | Warmup | ParadeLaps` (plus `Invalid`). The fresh-connect briefing treats `Racing` in a race session as "too late" for the same reason. The pace-laps diff records that on a 1-lap rolling formation "the green flies at the line / `SessionState` flips to `Racing`". So the race start is **the first eligible tick of a race session on which `SessionState` reads `Racing`, when the previous eligible tick read `GetInCar`, `Warmup` or `ParadeLaps`.**

- **`Invalid` is not a pre-green state for this edge**, although `isPreGreen` counts it. An `Invalid → Racing` step is what a reconnect or a session-YAML reload mid-race looks like. Recording it would put a mid-race frame in the file as the start. So the diff uses its own three-state set and does not call `isPreGreen`.
- **One start per session instance; the latest one wins.** A re-grid re-enters `ParadeLaps`, and the rolling-start diff already treats that as a fresh edge. Its green is the real start, so a second start entry for the same `(sessionNum, sessionUniqueId)` replaces the first.
- **Race sessions only**, judged by the translator's existing session-type classification of the session YAML's `SessionType`. Practice and qualifying also show `Racing` and a green bit, but a green there is not a start anyone reviews.

**Rejected: a flag-bit edge (`StartGo` for standing starts, `Green` for rolling ones).** The flag diff's comments show how much the bits need to be told apart. `StartGo` also rises on every caution restart, `Green` rises under a yellow-checkered finish, and a green can lead `StartGo` by a tick. The start-light and flag diffs handle all of that with the caution phase, which is post-guard state. `SessionState` has a single meaning here and needs none of it. Timing is not the issue either way: a few ticks between the state flip and the bit are small against a five-second lead-in. **The capture that confirms the model:** on one standing and one rolling start, the diff's debug line on the edge tick logs `SessionFlags`. The offset to the `StartGo` (standing) or `Green` (rolling) rising edge must be a few ticks at most. If `Racing` trails the green by more than a second on either start type, the start edge moves to the first of the state flip and the start bit within the race session, and this spec is amended.

### Restart: the green that ends a full-course caution

A restart is **a `Green` rising edge on an eligible tick of a race session in `Racing`, with neither `Caution` nor `CautionWaving` set on that tick, after an eligible tick in the same session on which one of them was set.** This is the definition `caution.restarted` documents, and a green rising with `Caution` still set (a yellow-checkered tick) is not one. The predicate is shared with `diff/caution.ts`, not copied. The "a caution was seen" latch is the recorder's own, because the caution phase it would otherwise read is wiped on every replay tick. A latch cleared by an ineligible window simply misses that restart: an absent entry, never a wrong one.

A restart after a red flag is recorded only if iRacing raises a caution bit between the red and the green. That is not designed for; see _Out of scope_.

## Detection, in the translator

`packages/sim-events-iracing/src/diff/replay-greens.ts`, with its state in `TranslatorState`. It runs **before** the replay guard, next to `diffReplayLaps`, for the reason `replay-laps.ts` gives: the guard's early return would stop it on exactly the ticks where it has to notice it cannot see. Its state is left in `wipeStateForReplay`'s wiped set, because a re-seed is what returning from a replay needs.

- **The same gate as the lap record.** A tick is eligible when `IsReplayPlaying !== true`, `!isReplayOnlySession(sessionInfo)`, `SessionNum >= 0` and a frame is readable. Every ineligible tick marks the recorder unseeded, and the first eligible tick after that re-seeds without emitting. A driver who sat in the garage through the green (where iRacing reports `IsReplayPlaying: true`) therefore gets no start entry and the press falls back. The eligibility check is extracted from `replay-laps.ts` into one function both diffs call, so the two records can never disagree about which ticks are live.
- **`frame` is `resolveReplayFrame(telemetry)` on the edge tick**: `ReplayFrameNumEnd` under that gate, recorded raw like a lap start (#1162: no lag correction).
- **`sessionTimeMs` is `SessionTime` on the same tick**, in whole milliseconds. Nothing reads it in this design. It is stored because it is the one frame-free coordinate of the moment: a reader of the file can check a frame against it, and a later `ReplaySearchSessionTime` path would need no format change. It costs eight bytes per green.
- **A session change** (`SessionNum` or `SessionUniqueID` moves) re-seeds and clears the caution latch.
- **#1324 exposure.** `IsReplayPlaying` reads false for about 300 ms after every replay seek, so the gate opens briefly during replay review. The first such tick only re-seeds. An edge would need a second blip tick on which `SessionState` changed. That can happen only if session-level telemetry follows the replay cursor during an in-session replay, and that is not established: the per-car arrays were measured to read the live field (2026-09-29, #1281), but `SessionState` and `SessionFlags` were not. The capture below settles it. If they do follow the cursor, this diff adopts whatever guard #1324 decides, as `replay-laps` will.

### The event

```typescript
"replay.greenFlag": SimEvent<
  "replay.greenFlag",
  {
    /** `WeekendInfo.SubSessionID`; 0 for an offline session. */
    subSessionId: number;
    sessionNum: number;
    sessionUniqueId: number;
    /** The race start, or the green that ends a full-course caution. */
    kind: "start" | "restart";
    /** The live replay frame on the green tick, recorded raw. */
    frame: number;
    /** `SessionTime` on the same tick, whole milliseconds. */
    sessionTimeMs: number;
  }
>;
```

The green flag is a racing idea, not an iRacing one, so the event fits the sim-agnostic catalog the same way the lap events do. Whether it should be one event with a `kind` or two events: one, because the store treats both the same way and a consumer that only wants starts filters on one field. The scenario harness gets an `event-names.ts` entry. No callout uses it, so there is no shortcut button.

**Rejected: subscribe the store to the existing `caution.restarted` / `startLight.start-go.raised` / `flag.green.raised`.** Those events are shaped for the Race Engineer: suppressed while another family owns the moment, standing-only or in-car-only, and post-guard. Recording from them would tie the replay record to audio decisions. For example, `flag.green.raised` is deliberately silent on a rolling start's green when `StartGo` is up. They also carry no frame.

## The `greens` section

```json
"greens": {
  "version": 1,
  "sessions": [
    {
      "sessionNum": 2,
      "sessionUniqueId": 4,
      "greens": [
        { "kind": "start", "frame": 30215, "sessionTimeMs": 512433 },
        { "kind": "restart", "frame": 71904, "sessionTimeMs": 1199870 }
      ]
    }
  ]
}
```

Entries are kept in frame order, with at most one `start` per session (latest wins, as above). Restarts are de-duplicated by frame within the store's existing 60-frame marker window, so a tick-level double emit cannot create two entries.

**Lookup** (`greens.findGreen({ subSessionId, sessionNum, sessionUniqueId?, kind: "start" })`) follows the laps rule. It matches the `(sessionNum, sessionUniqueId)` pair first. When no `sessionUniqueId` is given or none matches, it uses the unique session with that `sessionNum` that has a start, and when several do, the one with the highest frame (the latest instance in the recording). A miss carries the reason the action logs: `no file`, `no session`, `no green`, `newer format`.

**The write path is the store's**: the debounce, the atomic replace, the flush on session change and exit. It also follows the unreadable-file merge. When a file that could not be read becomes readable, the in-memory greens merge into it: the file's start entry stays where both have one, and restarts are a union under the de-dupe rule.

### Compatibility of the persisted file

The replay file is persisted user data, so this is a contract change, and it is additive only.

- **The envelope does not move.** `REPLAY_FILE_VERSION` stays as it is, and `greens` is a new section with its own `version: 1`, like `laps`.
- **Older builds (3.4, 3.5) carry `greens` through untouched.** The store preserves every section it does not read on every write. A file opened alternately by 3.5 and 3.6 loses nothing.
- **This build reads older files.** A file with no `greens` section is a miss with reason `no green`, and the press falls back to the lap record, which those files have.
- **Newer builds' sections are carried through, not written.** A `greens` section whose `version` is above this build's is treated like a newer `laps` section: carried through verbatim, `record` returns false with one warning, and `findGreen` misses with `newer format`. An entry with an unknown `kind` and any unknown field on an entry or a session are kept on write (index signatures) and ignored by the lookup.

## Which session the press targets

1. **The cursor's session, if it is a race.** That is `SessionNum` and `SessionUniqueID` from the replay's telemetry, classified by `SessionInfo.Sessions[SessionNum].SessionType`. In a heat-race event, pressing inside a heat goes to that heat's green.
2. **Otherwise the last race session in `SessionInfo.Sessions`.** In a single-race event, this is the race whether the cursor is in practice, qualifying or a warmup. In a heat-race event it is the feature, which is the one a reviewer is most likely after. No `sessionUniqueId` is known for it, so the lookup goes by `sessionNum`.
3. **No race session at all**: the press does nothing, and the key shows Replay Markers' unavailable look (grey colour slots, faded artwork). This is the only case that greys the key. A missing record does not, because the fallback can still land. From the car the key does not grey either: it does nothing, as every other Replay Control jump does there, and a key that is grey all race would read as broken.

The other press guards are the ones Jump to Fastest Lap uses, in the same order. `SessionNum < 0` (the post-seek transient) ignores the press. A press while a fastest-lap walk, a record jump or another green jump is in flight is ignored before any command is sent, through the same in-flight slot. `IsReplayPlaying !== true` sends nothing, because iRacing ignores replay commands from the car.

## The jump

**On a record hit:** the waited jump from `shared/replay-seek.ts` (#1275) to `max(0, frame − GREEN_APPROACH_FRAMES)`, holding the replay-cursor claim, then the playback step. `GREEN_APPROACH_FRAMES` is 300 (five seconds at 60 frames per second):

- **Standing start:** about the moment the gantry reaches Set, so the lights going out is in view.
- **Rolling start or restart:** the field bunched and approaching the line or restart zone.
- **Saved file:** the frame lag makes it about six seconds, which is still before the green.

Fastest Lap's 60 frames show a car crossing a line. Here the run-up is the point, which a single second does not show. It is a constant, not a setting. If the manual test shows the run-up is too short or too long, it is changed in one commit.

**Playback** is whatever the shared jump sequence applies. Today that is play at 1×, as Jump to Fastest Lap's record path does. If #1276 lands, its `replayJumpPlayback` setting applies, and #1276's list of covered jumps gains this one. The two issues touch one line of each other's code, whichever merges second.

**On a miss:** the log line `Jump to green: record MISS (<reason>); falling back to lap 1 of the pole car`, and then the fallback.

## The fallback: the pole car's lap 1

- **The car:** the pole sitter from `QualifyResultsInfo.Results` (`Position` 0), read through `grid-utils`. iRacing publishes that grid for standing and rolling starts alike, including race-only events (#974). With no grid, the fallback uses the car the camera is on.
- **The frame:** `laps.findLapStart` for that car's lap 1 in the target session. Replays recorded by 3.4 and 3.5 have a lap record and no green record, so this is a single jump for them. With no lap record, it runs the #1203 walk to lap 1 of that car in the target session. That requires the walk to take a target session other than the cursor's, with its `SessionUniqueID` read from the session map. A converged walk records its landing in the lap record, as it already does, so the next press is a lookup.
- **The landing:** `lapStart − GREEN_APPROACH_FRAMES`, through the same waited jump. A walk lands two ticks before the line, so it gets one further waited jump back by the rest of the lead-in.
- **The camera:** the walk's lap search is camera-relative, so it switches the camera to the pole car (#1203). After the landing, and before playback, the camera goes back to the car the user was watching at the press. A record-path fallback switches no camera.

Why this lands close: the pole car takes the line first. In a standing start its grid slot sits just behind the line, and in a rolling start the green flies at the line. So its lap-1 start trails the green by a second or two at most, and the five-second lead-in absorbs that. It is approximate in two named cases, both accepted. A pole sitter who started from the pit lane crosses late, so the fallback lands after the green. A track whose standing-start grid sits well behind the timing line lands correspondingly early.

**The capture that confirms the model:** on a rolling start, the record holds both the green frame and the pole car's lap-1 start. Their difference must be small and positive. That also shows whether pace-lap crossings move `CarIdxLapCompleted` off −1 (#307 says it stays −1 until the first S/F crossing, but no capture of a pace lap is cited for it). If a parade crossing does open lap 1, the fallback is wrong on rolling starts. It then targets the first lap start after the race session's last `ParadeLaps` tick, and this spec is amended.

**Rejected: land at the race session's start (Next / Previous Session).** It is cheap and always works, but for a rolling start it lands minutes before the green, behind gridding and every pace lap. That does not do what the mode's name says.

**Rejected: grey the key out with no record.** Every replay that exists today has no green record, so the key would be dead on all of them, including the requester's. Replay Markers greys out because a marker is the user's own and there is nothing to approximate.

**Rejected: search the replay for the `SessionState` change.** A bisection on `SessionState` across the race session would find the green itself. But whether session-level telemetry follows the replay cursor is not established (see #1324 above), and the lap walk is already built, repaired and tested.

## Restarts

The extension, not part of this issue: a **Next Green / Previous Green** pair over every green of the cursor's race session instance, start included. It walks relative to the cursor with Replay Markers' next/previous windows, and the key greys at the ends like a marker key, since restarts have no approximation. It joins `DIRECTIONAL_PAIRS`, which also makes it a natural rotation mode for #801's dial. Because the record already holds restarts, adding the pair is action code only. It is not offered to the requester now (maintainer, 2026-10-05); it stays here as the design the stored data was shaped for, and a later issue builds it.

## The dial

Replay Control has no dial surface on `master`: both the Elgato and the Mirabox manifest declare it `["Keypad"]`, and the `onDialDown` / `onDialRotate` handlers are unreachable (#640). #1316 builds the surface (Speed Control, with Frame Jog in #1317), and #801 adds stepping modes to it.

- **No rotation mode.** A single moment has no direction to turn in. If the restart pair is adopted, "greens" becomes one more stepping target in #801's list, not part of this issue.
- **A gesture-slot option: yes.** #1316's slots (Press, Long Press, Tap Display, Long Touch) offer Play/Pause, Set 1x and play, Reverse direction, Jump to Live and None. Jump to Live already makes a jump a slot option, and Jump to Green Flag is its counterpart at the other end of a race review. A Mirabox knob reaches only Press, so without the option a knob user needs a separate key for the one jump a review starts from. The cost is one enum value under `.catch`, one PI option, one comms entry and a hold-preview caption (`GREEN`). The preview's `false` cases are the press guards above. This lands after #1316. If #1316 is not merged when this is implemented, the option goes into #1316's slot list instead.

## Out of scope

- The Next Green / Previous Green pair (see _Restarts_).
- A green record for practice, qualifying or any non-race session.
- Restarts after a red flag that raise no caution bit, local yellows, and the checkered flag ("jump to finish"). Each would be another `kind` or section, and the store carries unknown kinds through.
- A per-key or global setting for the lead-in.
- Recording a green seen during a replay tick, live-field or otherwise. The gate is the lap record's, and it changes with it if #1324 or a later issue changes it.
- Renaming the _Fastest Lap Search Delay_ setting, although the fallback walk now uses it too. The website paragraph says so.
- The legacy Replay Navigation action (#1334). It gains nothing.
- Ulanzi dials: none are declared until verified (`encoders-and-touchscreen.md` rule 7).

## Testing

Unit tests, in the package that owns each piece:

- **`diff/replay-greens.ts`** (sim-events-iracing):
  - The first tick seeds and emits nothing.
  - `Warmup → Racing` on a standing race session and `ParadeLaps → Racing` on a rolling one each emit one `start` with the tick's `ReplayFrameNumEnd` and `SessionTime`.
  - `Invalid → Racing` emits nothing, and neither does a practice or qualifying session going `Racing`.
  - A re-entry into `ParadeLaps` followed by `Racing` emits a second `start`.
  - A caution episode (Caution set, then `Green` rising with both caution bits clear) emits one `restart`. A green rising with `Caution` still set (yellow-checkered) emits nothing.
  - An ineligible window (`IsReplayPlaying` true, a replay-only session, `SessionNum` −1) unseeds the recorder. The first eligible tick after it emits nothing even across a `Racing` flip, and it also clears the caution latch.
  - A session change re-seeds.
  - The diff's position in `handleTick` is pinned as pre-guard (the #1127 ordering-test shape), and the shared eligibility function has its own tests, used by both diffs.
  - A fixture cut from a capture of a race start, one standing and one rolling, replays through the translator and asserts the exact event. The `local/` captures from 2026-09-17 and 2026-09-18 are the first candidates for the rolling and caution cases.
- **The store's `greens` section** (deck-core):
  - A record and lookup by pair.
  - The `sessionNum` fallback picks the unique session, and of several the latest.
  - The latest start replaces an earlier one for the same instance.
  - Restarts are de-duplicated within the window and stay in frame order.
  - A newer `version` is carried through: `record` returns false and the lookup reports `newer format`.
  - An unknown `kind` and unknown fields survive a write, and `markers`, `laps` and an unknown section survive a `greens` write.
  - The unreadable-file merge keeps the file's start and unions the restarts.
  - The offline record takes greens and never reaches disk.
- **Replay Control** (iracing-actions, under the deck-core mock with a mocked store):
  - Target resolution: the cursor's race session, and the last race session from practice. The last race session wins in a multi-race session list.
  - With no race session, nothing is sent and the key renders unavailable.
  - A hit sends one waited `setPlayPosition(Begin, frame − 300)` (clamped at 0), then the playback step, and no camera switch.
  - A miss with a lap record jumps to the pole car's lap-1 start minus 300 with no camera switch. With no grid, it uses the viewed car.
  - A miss with no lap record walks lap 1 in the target session, takes the extra waited jump back, and switches the camera back to the press-time car before playback.
  - From the car, nothing is sent. A press during an in-flight walk or jump is ignored. `SessionNum` −1 ignores the press.
  - The comms catalog entry exists, `docs/reference/actions.json` lists the mode, and the icon preview's freshness test passes.
- **Dial** (with #1316's surface): the slot option dispatches the same path, and the hold preview returns `false` with no race session or outside a replay.
- **Catalog and harness**: the event compiles in `event-names.ts`.

Manual, in the sim (the gate before the PR), with the plugin's log open at debug:

1. **Standing start, record path.** Run an AI race with a standing start (offline, held in memory). Afterwards, in the in-session replay, press from well after the start (more than 20000 frames away, the #1275 lesson). Expect `green record HIT (matchedBy pair)`, a landing five seconds before lights out with the gantry in view, and playback. Read the edge tick's debug line: the `StartGo` rising edge must be within a few ticks of the `Racing` flip.
2. **Rolling start.** The same on a rolling start: the field approaching the line, and the `Green` bit within a few ticks of the flip. In the same session, compare the recorded green frame with the pole car's lap-1 start in the lap record. The difference must be small and positive. **This is the capture for the fallback model.**
3. **Restart.** An oval AI race with a caution. Check the file or the debug log for a `restart` entry on the tick `caution.restarted` fires.
4. **Saved file.** In a hosted or official session (offline sessions write no file), save the replay, reopen the `.rpy` and press. Expect a record hit landing about six seconds before the green.
5. **Fallback, lap record.** Remove the `greens` section from a session file (or open a replay recorded by 3.5) and restart the deck host. Expect `record MISS (no green)`, a landing before the green from the pole car's lap 1, and the camera unchanged.
6. **Fallback, walk.** Move the session file away and restart the deck host. Expect `record MISS (no file)`, the walk to lap 1 of the pole car, a landing before the green, and the camera back on the car that was viewed at the press.
7. **Multi-session replay.** Press from practice and from qualifying in a replay that holds both before the race: it lands at the race's green. Press inside the race: same.
8. **No race.** A practice-only or test-drive replay: the key is grey and a press does nothing.
9. **Session-level telemetry in replay.** In an in-session replay, scrub from before the green to after it with a Telemetry Display key showing `{{telemetry.SessionState}}`. If it changes with the cursor, record that in this spec: the #1324 blip can then forge an edge, and the diff needs #1324's guard before it ships.
10. **Dial** (once #1316 is in), on a Stream Deck+ and the Mirabox knob: a slot set to Jump to Green Flag behaves like the key.
