# Replay markers

> **Issue:** [#1162](https://github.com/niklam/iracedeck/issues/1162) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

A new **Replay Markers** action with four modes — **Add Marker**, **Delete Marker**, **Next Marker**, **Previous Marker** — over a per-session replay store in deck-core that saves each session's markers to disk.

- **A marker is a replay frame.** Positions are replay ticks (`ReplayFrameNum`, 60 per second), and a jump is `replay.setPlayPosition(ReplayPosMode.Begin, frame)`: one SDK broadcast, no key binding. That is the command the fastest-lap jump (#607) already drives in production. The SDK's `ReplaySearchSessionTime` also exists and is wrapped in `ReplayCommand`, but no shipping action uses it, so markers do not depend on it. Each marker also records its `SessionNum` and session time, which are descriptive only: shown to a person, never used to jump.
- **The current position** is `ReplayFrameNum`, while driving and in a replay alike. Every mode measures against it.
- **Add:** the current frame minus the key's **Seconds back** (a per-key action setting, default 5, range 0–60, whole seconds × 60 frames, the result clamped at 0). It applies identically live and in a replay; there is deliberately no mode-dependent special case, because the setting being per key is what covers both uses: a deck can carry a 15 s key for marking a moment just survived in a race and a 0 s key for marking exactly the frame on screen in a replay. A marker within 60 frames (1 s) of an existing one is not added twice.
- **Delete:** removes the marker nearest the current frame if it is within 600 frames (10 s), otherwise nothing. Live, that reaches a marker added moments ago (added at t − 5 s, pressed at t). In a replay, it reaches the marker just jumped to while its moment is playing. One press, no confirmation step: the window already bounds what a press can reach.
- **Next / Previous:** markers ordered by frame. Next is the first marker more than 60 frames ahead, so a second press moves on instead of landing on the marker just reached. Previous is the last marker more than 120 frames (2 s) behind, so pressing it while a marker's moment is still playing goes to the one before, as a media player's previous-track does. No marker in that direction: nothing is sent.
- **Feedback:** Add and Delete flash a confirmation on the key; a press that does nothing shows nothing.

## Storage: one replay file per session, markers its first section

`%LOCALAPPDATA%\iRaceDeck\Replay\session_<SubSessionID>.json`. The file is not a markers file. It is where iRaceDeck keeps anything it learns about one session's replay, and markers are only the first thing in it:

```json
{
  "version": 1,
  "subSessionId": 12345678,
  "track": "Watkins Glen International — Boot",
  "series": "…",
  "sessionStart": "2026-09-13T18:00:00Z",
  "sections": {
    "markers": [{ "frame": 110070, "sessionNum": 2, "sessionTimeMs": 1834500 }]
  }
}
```

The header (track display name, series name, session start date) lets a driver browsing the folder tell the files apart.

**Extensibility is the reason for the shape:**

- **Sections are owned by features.** Each feature reads and writes only its own key under `sections`, through the store's API.
- **The store preserves what it does not know.** On every write it carries through any section it has no reader for, so an older build never drops a section a newer build wrote. A build that could delete another feature's data by merely saving its own would make the second section a data-loss bug.
- **`version` covers the envelope only.** A section versions its own contents if it ever needs to.
- **The expected second section** is the frame where each car's fastest lap begins. Today the fastest-lap jump (#607) rediscovers that by walking the replay on every run and keeps it only in memory. It is named here so the envelope is designed for more than one tenant, not because this issue builds it.

A file is a few hundred bytes, so nothing is pruned.

**Write discipline** follows the settings store: atomic replace (temp file and rename), and a file that fails to parse is moved aside, never overwritten. The store is a deck-core singleton and the only owner of these files. It loads a session's file when that `SubSessionID` first appears, live or in a replay, which is what lets a replay opened days later find its markers.

## Why a separate action

Markers are a self-contained feature with a store of their own. Four modes read better as their own action than folded into Replay Control's 26. The cost is a new UUID, manifest entries in three plugins, icons, and a website page and action count, all accepted.

## Why not the existing searches

- **Next/previous incident** finds only what the sim scored as an incident.
- **Mark Event (M)** writes into the telemetry file, which the replay cannot seek to.
- **The fastest-lap walk** (#607) bisects frames because a lap's frame is not known in advance. A marker records its frame at the moment it is set, so its jump is a single command.

## What is out of scope

Adding a marker from a wheel button through SimHub. iRaceDeck's SimHub bindings are outbound only (a key press starts a Control Mapper role), and there is no path for SimHub or any device to trigger an iRaceDeck function. That inbound trigger is its own design.

## Not settled — sim facts to confirm with the maintainer before implementation

- **Frames while driving.** Whether `ReplayFrameNum` advances with the live recording while driving, so an Add made from the car names the frame that moment will have in the replay.
- **Frame stability.** Whether a frame number keeps pointing at the same moment for the rest of the event (in particular when the replay memory limit drops the start of a long event), and whether a saved `.rpy` opened later numbers its frames the same way as the in-sim replay did.
- **Session key.** Whether a saved `.rpy` reports the same `SubSessionID` as the live session, and what `SubSessionID` reads in a test drive or an AI session.
