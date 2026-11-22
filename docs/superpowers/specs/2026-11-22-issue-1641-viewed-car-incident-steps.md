# Next / Previous Incident for one car, from the replay record

> **Issue:** [#1641](https://github.com/niklam/iracedeck/issues/1641) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Builds on the replay record's `incidents` section and the record walk (#1426, `2026-10-12-issue-1426-replay-record-steps.md`), the shared jump sequence (#1276) and the replay command gate (#1430), and restates none of them. #1426 records incidents and reads none of them; this is the section's first reader. The issue was filed by a user; the decisions below are the maintainer's.

## The decision

1. **Next / Previous Incident get a Target setting**, `incidentTarget`, beside the mode as `fastestLapTarget` sits beside Jump to Fastest Lap (#577): **All cars** (the default, today's behaviour, iRacing's own search), **Viewed car** (the car the camera is on, `CamCarIdx`), and **Always my car** (the driver's own car, `DriverInfo.DriverCarIdx`). A setting rather than four new modes, so the Mode list keeps its two incident entries and a key placed before this ships reads `all-cars` and behaves as it did.
2. **Viewed car and Always my car step through the record only, never iRacing's search.** iRacing's search cannot be held to one car: it steps a pointer of its own, lands on whichever car it finds and moves the camera there (#1426's sim facts). A press the record cannot answer sends nothing, and the key says so before it is pressed (decision 5), which is what the issue asks for over a silent fall back to the search.
3. **A step lands five seconds before the incident**: the recorded frame plus `REPLAY_FILE_FRAME_LAG` (59, the record is in live numbering), minus 300 frames, the lead-in the maintainer chose on 2026-10-12, floored at 0. It is one waited record jump, as Next / Previous Lap and Session make on a hit, carrying the key's origin token and following the Replay jump playback setting (#1276).
4. **The list is the target car's incidents**, every session of the file, filtered by `carIdx` and verified by `carNumberRaw` as every record lookup is (a freed index taken by another car must not hand over its incidents). The walk is the shared one (`replay-record-walk.ts`), anchored where the replay is headed, else the cursor, and compared by landing, so a second press steps on from the first one's landing rather than finding the same incident again. Every pair of entries is adjacent: the section records no coverage (decision 7), so there is no gap the walk could refuse to cross, and past the last entry there is nothing.
5. **The key shows when it cannot act.** A Viewed car or Always my car key draws `unavailableLook` while its press would send nothing: outside a replay, with no record for the session, with no car on the camera (`CamCarIdx` < 0 or 255) for Viewed car, or with no recorded incident of the target car in its direction from the anchor. It is re-read when the camera car changes and when the cursor moves, as Replay Markers' Next / Previous are (#1162). A press while unavailable sends nothing, logs the reason at debug and reports the press ignored (`reportReplayPressIgnored`), so the busy look's "not done" mark shows it too (#1437).
6. **The camera.** Viewed car switches nothing: the jump keeps the camera on the car it was on, which is the issue's step 4. Always my car puts the camera on the driver's car through `requestCameraSwitch` before the jump, as Jump to Fastest Lap's "Always my car" does, so the replay shows the incident it stepped to.
7. **What the record can hold is #1426's, unchanged.** The driver's own incidents always (`PlayerCarMyIncidentCount`); another car's where the sim shows `CurDriverIncidentCount` in the session YAML: hosted and AI sessions, never an official one, whose counts read −1 until the race is over and whose reveal re-seeds silently. Incidents are recorded in the car only. One crash is one entry at its first frame (the 600-frame fold). An incident iRacing scores 0x moves no count and is not recorded. A replay the plugin did not record live (a downloaded `.rpy`, a session it was not running for) has no record, and the key shows unavailable.
8. **The dial's Incident mode gets the same Target** (maintainer, 2026-11-22), as `dial.incidentTarget` with the same three values and the same `all-cars` default, shown in the dial PI while `dial.mode` is `incident`. All cars stays what it is: the paced search (`replay-search-queue.ts`), one of iRacing's searches per detent. Viewed car and Always my car make the mode a record-step mode like Lap and Session (`createRecordStepMode`, #801): a turn of N detents is one waited jump to the Nth incident of the target car that way, and a turn the record cannot answer sends nothing, where Lap and Session would send the search. The box keeps the replay time as its value; its side marks are lit only where a step that way would land, from the same listing as the step (#801's one-listing rule), which is the dial's form of the unavailable look; and the caption names whose incidents they are, the target car's number (`#25`), empty with no car on the camera. Always my car switches the camera on the first detent of a turn, as the key does.

## Why not something cheaper

- **Fall back to iRacing's search on a miss**, as the lap and session steps do. Rejected: the search lands on any car and moves the camera to it, which is the behaviour the issue asks to escape, and a fall back that quietly does the global thing is the outcome the requester named as worse than an explicit "unavailable".
- **Drive iRacing's search until the camera lands on the target car.** Rejected: the search does not repeat from one frame, steps a pointer of its own rather than from the cursor and moves the camera one sample after the frame (#1426's sim facts), so a loop of searches is slow, unbounded and cannot tell whether it skipped one of the car's incidents.
- **Four new modes** (Next / Previous Incident, Viewed car / My car). Rejected for the setting: the mode list grows by a dimension that is a target, not an action, and `fastestLapTarget` is the precedent.

## Out of scope

- **All cars from the record.** Switching the existing behaviour to the record is #1426's deferred follow-up, which waits on the comparison lines being read; this leaves All cars sending iRacing's search, comparison and all.
- **Recording incidents out of the car.** A steward or spectator watching a hosted race live, never in the car, records nothing today; the session-YAML half of the recorder could read at the live edge as the session-start recorder does (`resolveReplayLiveTick`), but whether the YAML counts update while spectating is unmeasured. A later issue, with that capture.
- **Other cars in official sessions**, which the sim does not show while the frame is known.
- **A setting for the lead-in.** Five seconds, as #1426 decided.

## Affected artifacts

- `@iracedeck/replay-engine`: an incident list in `replay-record-step.ts` (or beside it), its landing, and the availability read.
- `@iracedeck/iracing-actions`: Replay Control's `incidentTarget` field, the PI radio shown for the two incident modes, the press paths, the unavailable look and its re-reads, tests; the dial's `dial.incidentTarget`, its PI radio, and the Incident mode (`replay-control-incident-mode.ts`) choosing between the paced search and a record-step mode; the comms catalog entries are unchanged (API).
- `@iracedeck/replay-store`: none expected; `incidents.list(scope?)` already returns what the step needs.
- Website: the Replay Control page's two incident sections and the Target setting; a `changelog.d/` fragment.
- `docs/` action documentation for Replay Control.

## Testing

**Unit.**

- **The step:** a hit for each direction lands at `frame + 59 − 300`, floored at 0; only the target car's entries count, and an entry with the right `carIdx` and another `carNumberRaw` does not; entries across sessions are stepped in frame order; a press during a jump steps from the standing target; a second press from a landing steps to the next incident, not the same one; each miss (no store, no file, newer format, no car on camera, no car number, nothing that way) carries its reason.
- **Replay Control:** All cars sends iRacing's search exactly as before, the comparison observer included; Viewed car on a hit sends one waited jump and no camera switch; Always my car switches the camera to the driver's car, then jumps; a miss sends nothing and reports the press ignored; the unavailable look turns on and off as the camera car changes and as the cursor passes the last incident each way; settings without `incidentTarget` parse to `all-cars`.
- **The dial:** All cars queues the paced search as before; Viewed car turns of 1 and 3 detents make one jump each, to the first and third incident that way; a turn past the last incident sends nothing; the side marks follow the listing as the camera car and the cursor change; the caption shows the target's car number; dial settings without `incidentTarget` parse to `all-cars`.

**By hand.**

1. **AI race** with incidents of several cars, the driver's own among them. In the replay, camera on one car: Next Incident steps only that car's incidents, about five seconds before each, camera unmoved; Previous steps back; past the last one the key greys out.
2. **Camera change:** move the camera to a car with no recorded incident; the key greys at once, and a press does nothing. Back to a car with incidents; it lights again.
3. **Always my car:** from another car on camera, a press puts the camera on the driver's car at their next incident.
4. **Official race** replay: Viewed car on an opponent is greyed throughout; on the driver's own car, and with Always my car, it steps.
5. **A replay with no record** (one recorded before the plugin ran): both targets greyed; All cars still searches.
6. **All cars** unchanged on every replay above.
7. **Dial**, Incident mode on Viewed car: turning steps the viewed car's incidents, a fast turn skips several in one jump, the side marks dim at either end, the caption names the car; switching the camera updates all three. All cars on the dial behaves as before.
