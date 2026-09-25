# Replay markers

> **Issue:** [#1162](https://github.com/niklam/iracedeck/issues/1162) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Amended 2026-09-24: the "Not settled" section became "Sim facts", and the position model and the storage rules changed where those facts changed them. The laps section that #1203 adds to the same file is designed in `2026-09-24-issue-1203-fastest-lap-from-session-record.md`; both ship from one worktree.

## The decision

A new **Replay Markers** action with four modes — **Add Marker**, **Delete Marker**, **Next Marker**, **Previous Marker** — over a per-session replay store in deck-core that saves each session's markers to disk.

- **A marker is a replay frame.** Positions are frames of the replay recording (60 per second, absolute over the whole recording — practice, qualifying and race share one numbering, while `SessionTime` restarts per session), and a jump is `replay.setPlayPosition(ReplayPosMode.Begin, frame)`: one SDK broadcast, no key binding. That is the command the fastest-lap jump (#607) already drives in production. The SDK's `ReplaySearchSessionTime` also exists and is wrapped in `ReplayCommand`, but no shipping action uses it, so markers do not depend on it. Each marker also records its `SessionNum` and session time, which are descriptive only: shown to a person, never used to jump.
- **The current position** is read through one helper, `resolveReplayFrame(telemetry)` in `@iracedeck/iracing-sdk` `telemetry-features.ts` (beside `isLiveOnTrack`): `ReplayFrameNum` while `IsReplayPlaying === true`, `ReplayFrameNumEnd` otherwise, `null` when the field it needs is missing. The reason is a sim fact, not a preference — see *Sim facts* below: while driving `ReplayFrameNum` reads a constant 0 and the frame the recording is at is `ReplayFrameNumEnd`. Every mode measures against that helper, and so does the #1203 recorder, so a marker set from the car and a lap start recorded from the car land in the same numbering.
- **Add:** the current frame minus the key's **Seconds back** (a per-key action setting, default 5, range 0–60, whole seconds × 60 frames, the result clamped at 0). It applies identically live and in a replay; there is deliberately no mode-dependent special case, because the setting being per key is what covers both uses: a deck can carry a 15 s key for marking a moment just survived in a race and a 0 s key for marking exactly the frame on screen in a replay. A marker within 60 frames (1 s) of an existing one is not added twice.
- **Delete:** removes the marker nearest the current frame if it is within 600 frames (10 s), otherwise nothing. Live, that reaches a marker added moments ago (added at t − 5 s, pressed at t). In a replay, it reaches the marker just jumped to while its moment is playing. One press, no confirmation step: the window already bounds what a press can reach. Amended after the code review: a marker also stores `pressFrame`, the frame at which Add was pressed, and Delete measures to whichever of the two is nearer, because from the car a 15 s key puts the marker 900 frames behind the live edge and the window alone could never reach it.
- **Next / Previous:** markers ordered by frame. Next is the first marker more than 60 frames ahead, so a second press moves on instead of landing on the marker just reached. Previous is the last marker more than 120 frames (2 s) behind, so pressing it while a marker's moment is still playing goes to the one before, as a media player's previous-track does. No marker in that direction: nothing is sent. Pressed while driving, both send nothing: iRacing's SDK header says replay commands work only out of the car (`irsdk_defines.h`), so the driver opens the replay first. (Amended after the code review; the first draft promised Previous from the car.)
- **Feedback:** Add and Delete flash a confirmation on the key; a press that does nothing shows nothing. Next and Previous also show whether a press would do anything (maintainer request, 2026-09-25): the key dims to grey — artwork and title faded with a plain `<g opacity>` through `assembleIcon`'s `dimmed` option, every colour but the background greyed — when there is no marker in its direction, when not in a replay, or with no store or telemetry, and it re-evaluates on each SDK tick, rendering only when that state flips.

## Sim facts (settled 2026-09-24, maintainer captures)

Confirmed from telemetry captures in `master/local/telemetry-snapshot-*.json` (the live Talladega race of 2026-06-24 and its saved `.rpy` opened on 2026-06-26 are both there, under SubSessionID 86697546).

- **Frames while driving.** `ReplayFrameNum` is 0 on every live tick (every snapshot from 2026-09-06 to 2026-09-23 reads `ReplayFrameNum: 0, IsReplayPlaying: false, IsOnTrack: true`). The recording's current length is `ReplayFrameNumEnd`, and it grows at exactly 60 frames per second of `SessionTime` (30821 at 75.53 s and 81649 at 922.67 s in one session: 60.0/s; the intercept is not zero because the recording spans the whole weekend while `SessionTime` restarts each session). So an Add from the car names `ReplayFrameNumEnd − secondsBack × 60`, which is the frame that moment has in the replay. `ReplayFrameNumEnd` is not yet in `TelemetryData` (`packages/iracing-native/src/defines.ts` declares `ReplayFrameNum`, `ReplayPlaySpeed`, `ReplayPlaySlowMotion`, `ReplaySessionNum`, `ReplaySessionTime`); the addon already delivers it, so the type gains the field.
- **Frames in a replay.** `ReplayFrameNum` is the absolute position and `ReplayFrameNumEnd` the frames left to the end: their sum is the recording's total length and is constant while a replay is open. Two consequences the code leans on. A jump is `setPlayPosition(Begin, frame)` with the same absolute number, which is what the #607 walk already does. And the recording's extent can be read from any replay frame without a `goToEnd` (#1203 uses that).
- **The predicate for "in a replay"** is `IsReplayPlaying === true`, read per tick from telemetry. Live snapshots read false with `IsOnTrack` true; replay snapshots read true even while paused at speed 0. It is the same truth the translator's replay guard reads (`translator.ts` `handleTick`, `if (telemetry.IsReplayPlaying === true)`) and the complement of `isLiveOnTrack`. It is deliberately not `WeekendInfo.SimMode`: that field says whether the *session* is a saved replay file (`"replay"`) or a live sim (`"full"`), and it stays `"full"` while a driver watches the in-session replay of a live race — where the position on screen is a replay frame all the same. `SimMode` keeps its existing job (`isReplayOnlySession`, #604) and gates the #1203 recorder, not the markers.
- **A saved `.rpy` reports the same `SubSessionID` as the live session** (86697546 in the comparison, opened two days later), so `session_<SubSessionID>.json` is found from the file; it kept `SessionUniqueID` 3 as well. Its frames matched the live-count prediction to within a constant: every moment appears ~59 frames (~1 s) **later** in the file than the live `ReplayFrameNumEnd` said (live-predicted 55598 → replay 55657; 44314 → 44373).
- **Offline sessions** (test drive, AI race) read `SubSessionID` 0 and `SessionID` 0 (every Homestead and Suzuka capture in `local/`). Maintainer ruling: markers work in memory for that session and no file is written; a replay opened later cannot find them.

### The saved-file lag: no correction applied

A live-recorded frame lands about one second **early** in the saved file, never late. That is the safe direction for every consumer: a marker is reached a second before its moment, and a lap start recorded at the crossing tick is reached with the car approaching the line, which is what the fastest-lap jump wants anyway. So live frames are recorded raw, exactly as `ReplayFrameNumEnd` reports them, and no consumer subtracts or adds a constant. Two facts argue against a `+60` at record time: the lag was measured against the `.rpy` only, and the in-session replay of the same recording may not carry it (if the counter lags the buffer, it does; if the file writer prepends a second, it does not) — a correction that is right for one would be a full second wrong for the other; and every window in this spec already tolerates it (Seconds back defaults to 5 s, Delete reaches 10 s, Next skips markers within 1 s ahead, Previous within 2 s behind). The measured value, 59 frames, is recorded here as `REPLAY_FILE_FRAME_LAG` so that if the in-sim replay is found to carry the same lag it becomes a one-constant change at record time; the manual test in the #1203 spec measures it. #1203's lap jump lands `LAP_START_APPROACH_FRAMES` (60) before the recorded start on top, so the approach is one second in the in-sim replay and two in a file, and both show the crossing.

### Open risk, not blocking: which recording a file's frames belong to

The file is keyed by `SubSessionID` alone. Two recordings of one subsession may not share a frame numbering: rejoining after a sim crash starts a new recording (does `ReplayFrameNumEnd` restart from 0?), and another participant's `.rpy` of the same subsession began when that driver joined. If either renumbers, markers and recorded laps from the first recording are served against the second. Raised by the code review and not settled by any capture; the capture that settles it is `ReplayFrameNumEnd` read before and after a rejoin of the same subsession. If it renumbers, the fix is a recording identity in the envelope that the store checks before serving frames.

### Open risk, not blocking: renumbering when the replay memory limit drops the start

Unknown: whether a recording that exceeds the replay memory limit renumbers its surviving frames from 0 when the start is dropped. If it does, every frame recorded before the drop is off by the dropped length: a marker set early in a long event would land that many frames too late (or past the end), and `ReplayFrameNum + ReplayFrameNumEnd` would shrink while a replay is open, or `ReplayFrameNumEnd` would step down on a live tick. That is what to look for. The capture that settles it is a live session longer than the configured replay memory, reading `ReplayFrameNumEnd` before and after the limit is hit. Nothing here depends on the answer for a session that fits the buffer, which is every session a saved replay is written from, so the work does not wait for it; if renumbering is real, the fix is a per-file `frameBase` the store learns from the first drop it observes, and the file's envelope has room for it.

## Storage: one replay file per session, markers its first section

`%LOCALAPPDATA%\iRaceDeck\Replay\<ecosystem>\session_<SubSessionID>.json`, one folder per deck ecosystem like the settings store's `Settings\<ecosystem>\` (amended 2026-09-24: two deck hosts running at once would otherwise each hold a copy of the same file and overwrite each other's writes every debounce; a merge-on-write was rejected because it resurrects a deleted marker). The file is not a markers file. It is where iRaceDeck keeps anything it learns about one session's replay, and markers are only the first thing in it:

```json
{
  "version": 1,
  "subSessionId": 12345678,
  "track": "Watkins Glen International — Boot",
  "series": "538",
  "sessionStart": "2026-09-13T18:00:00Z",
  "sections": {
    "markers": [{ "frame": 110070, "sessionNum": 2, "sessionTimeMs": 1834500 }]
  }
}
```

The header (track display name, the `SeriesID` as text — the session YAML carries no series name — and the instant the store first saw the session) lets a driver browsing the folder tell the files apart.

**Extensibility is the reason for the shape:**

- **Sections are owned by features.** Each feature reads and writes only its own key under `sections`, through the store's API.
- **The store preserves what it does not know.** On every write it carries through any section it has no reader for, so an older build never drops a section a newer build wrote. A build that could delete another feature's data by merely saving its own would make the second section a data-loss bug.
- **`version` covers the envelope only.** A section versions its own contents if it ever needs to.
- **The second section is `laps`**, every driver's lap start frames and lap times, recorded live — designed in the #1203 spec and shipped with this one. Until 2026-09-24 this line named the frame where each car's fastest lap begins as a future tenant; #1203 widened it to every lap, which is what makes the fastest-lap jump a lookup.

A markers file is a few hundred bytes; with the laps section a 60-car endurance race reaches a few megabytes, which is why the file is written as compact JSON rather than indented. Nothing is pruned.

**Write discipline** follows the settings store: atomic replace (temp file and rename), a trailing debounce so a burst of writes lands once, a `flushSync` on process exit, and a file that fails to parse is moved aside as `session_<id>.corrupt-<iso>.json`, never overwritten. The store is a deck-core singleton and the only owner of these files. It loads a session's file when that `SubSessionID` first appears, live or in a replay, which is what lets a replay opened days later find its markers.

Amended after the code review, where each of these was reproduced as a lost write: a failed write goes back into the pending slot, where a newer save supersedes it, so a retry can never land an older snapshot over a newer file; the debounce has a ceiling, `REPLAY_STORE_WRITE_MAX_WAIT_MS` (10 s), because a busy field's events arrive faster than the 2 s debounce and would otherwise postpone the write until the race ends; and a read that fails for a reason other than a missing file (a scanner or backup agent holding it) is retried with the settings store's back-off before the record falls back to memory-only, re-read on the next retry, the next same-session open and the exit flush, with what was gathered in memory merged into the file once it reads. A newer build's reshaped `laps` section (a higher section `version`) is carried through verbatim and never written to, and a marker entry this build cannot read is re-emitted untouched.

**Offline sessions are held in memory only.** When `SubSessionID` is 0 the store keeps one ephemeral record instead of a file. Its lifetime is one SDK connection: it is dropped when the SDK disconnects or when a different session key appears, and it is never written, so `session_0.json` does not exist. A saved replay of an offline session also reads 0 and therefore finds nothing, by the maintainer's ruling — and since opening a `.rpy` means leaving the live session first, the ephemeral record is already gone and can never be mistaken for the file's. The in-session replay of an offline session, opened without leaving, reads the same record and works.

## Why a separate action

Markers are a self-contained feature with a store of their own. Four modes read better as their own action than folded into Replay Control's 26. The cost is a new UUID, manifest entries in three plugins, icons, and a website page and action count, all accepted.

## Why not the existing searches

- **Next/previous incident** finds only what the sim scored as an incident.
- **Mark Event (M)** writes into the telemetry file, which the replay cannot seek to.
- **The fastest-lap walk** (#607) bisects frames because a lap's frame is not known in advance. A marker records its frame at the moment it is set, so its jump is a single command.

## Out of scope

- Adding a marker from a wheel button through SimHub. iRaceDeck's SimHub bindings are outbound only (a key press starts a Control Mapper role), and there is no path for SimHub or any device to trigger an iRaceDeck function. That inbound trigger is its own design.
- A markers browser, names or notes on a marker, and a file for offline sessions.
- The renumbering risk above: observed, not handled.

## Testing

Unit tests, in the packages that own each piece:

- `resolveReplayFrame`: live tick → `ReplayFrameNumEnd`; replay tick → `ReplayFrameNum`; missing field → `null`; a paused replay (speed 0, `IsReplayPlaying` true) still reads `ReplayFrameNum`.
- The store: load, atomic write through a temp file, debounce coalescing, `flushSync`, a corrupt file moved aside and reported as no file, an unknown section carried through a write, the ephemeral record for `SubSessionID` 0 never touching disk and dropped on disconnect.
- The markers section: Add with seconds back and the clamp at 0, the 60-frame dedupe, Delete within 600 frames and nothing beyond, Next past 60 frames and Previous past 120, ordering by frame, and no command sent when there is no target.
- The action: each mode's command and key feedback under the deck-core mock, including the live-versus-replay frame source.

Manual, in the sim (the gate before the PR):

1. In a live session, press Add twice a few seconds apart from the car, then open the in-session replay and press Previous: it lands ~5 s before the second press, Previous again lands at the first, Next returns to the second, Delete removes the one on screen.
2. Set a marker from the replay with a 0 s key; Next/Previous reach it exactly; the confirmation flashes.
3. Save the replay, close the sim, reopen the `.rpy`: `session_<SubSessionID>.json` is found and every marker lands about a second early (the recorded lag), never late.
4. An offline test session: markers work live and in its replay; no file appears under `Replay\`.
5. Check the folder after step 3: exactly one file per session, valid JSON, the header naming the track.
