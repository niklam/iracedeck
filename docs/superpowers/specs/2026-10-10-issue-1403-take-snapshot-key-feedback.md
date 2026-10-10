# Take Snapshot shows its outcome on the key

> **Issue:** [#1403](https://github.com/niklam/iracedeck/issues/1403) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

Telemetry Control's Take Snapshot mode reports through the plugin log and nothing else. The press that wrote two files, the press whose write failed and the press that was skipped because iRacing is not running all leave the key unchanged. The #1387 spec left key feedback out of scope and kept the key log-only.

The mode is meant to be pressed the moment something goes wrong, in a car, and the file is what a user then sends to support. A press that silently produced nothing is found out when support asks for the file.

Capture Profile, a mode of the same action, already shows `SAVED` or `FAILED` on its key for 3 seconds (#1338).

## Decision

### 1. The capture returns its outcome

`captureSnapshot` returns one of three outcomes instead of `void`. It still logs exactly what it logs today.

| Outcome | When | Key shows |
| --- | --- | --- |
| `saved` | the `.json` is on disk | `SAVED` |
| `failed` | the `.json` could not be written (the folder could not be made, the write threw, or the snapshot could not be formatted at all) | `FAILED` |
| `no-data` | there is no telemetry to capture, the case the log reports today as "skipped: no telemetry available" | `NO DATA` |

The `.json` decides. A snapshot whose Markdown report failed, or whose `pluginState` holds an error entry in place of the state, is `saved`: the file a user sends exists, and both cases already say so in the log and in the file. A fourth word on the key for "saved, with a caveat" would be read as a failure by someone driving.

`no-data` is its own outcome, not `failed`, because it is the common case (the key pressed with the sim closed) and nothing went wrong in the plugin. `FAILED` stays reserved for a press that should have produced a file.

The outcome carries the `.json` path when saved and the reason when failed, for a second consumer: the settings window's status line in #1404. The key shows neither.

### 2. The pressed key shows it for 3 seconds

The title of the key that was pressed is replaced by the outcome word for 3 seconds, then its normal icon returns. The hold is the one Capture Profile uses. `CAPTURE_PROFILE_RESULT_HOLD_MS` is renamed to one constant both modes read, so the two cannot drift apart.

- **Only the pressed key.** A snapshot is one press's act. A second Take Snapshot key on another page did not take it and does not show it. This differs from Capture Profile on purpose: there, every key reflects one shared capture that any of them could have started and that runs for seconds; here there is nothing in progress to reflect.
- **A dial press behaves the same.** The outcome is drawn through the per-context image update (`updateKeyImage`) that Capture Profile's status already uses, which does not distinguish a key from a dial.
- **A key showing the flags overlay does not show the outcome.** That update stores the image and skips drawing while a flag is displayed on the key, so the flag wins, as it does for Capture Profile. The log still has the outcome.
- **A second press during the hold** takes another snapshot and restarts the hold with the new outcome.
- **The hold ends early** when the key disappears, or when its Mode changes away from Take Snapshot. The timer is cleared in both cases, so no image is sent to a key that is gone and a key never shows `SAVED` under another mode's icon.

### 3. One render path

The outcome is state the action keeps per context (which outcome, until when). The key's image is produced by the function its regenerate callback already runs, extended to read that state, exactly as it reads the capture display for Capture Profile. A global-settings change during the hold therefore redraws the key with the outcome still on it, instead of dropping it or drawing it in stale colours.

Nothing is persisted and no setting is added. There is no option to turn the feedback off: three seconds of one word on the key that was just pressed is the smallest feedback there is, and a setting would have to be documented and migrated for no one's benefit.

### 4. Order with #1404

#1404 moves the capture out of the action class into a module of its own, so the settings window can call it. Both issues need the outcome as a return value, and whichever lands first introduces it in the shape above. If #1404 lands first, this issue is only sections 2 and 3.

## Alternatives rejected

- **A different icon per outcome** (a green tick, a red cross). The action has one icon per mode and the title slot is how Capture Profile already reports. A second mechanism in the same action is two things to keep working on three hosts.
- **`FAILED` for the no-telemetry case.** It tells a user that iRaceDeck broke when they pressed a key with the sim closed.
- **Showing the outcome on every Take Snapshot key.** It reads as "all of these were pressed", and it needs shared state for an act that has none.
- **The host's own alert indicator** (`showAlert`). It is optional on the deck interface and only the Elgato adapter implements it, and there is no counterpart for success; the title works everywhere the key does.
- **A longer hold, or holding until the next press.** The key has one job after the press, which is to be ready for the next one.

## Out of scope

- A sound, or a Race Engineer line, on save or failure.
- The file name or folder on the key. The log has the path; #1404 shows it in the settings window.
- Opening the folder from the key.
- Feedback for the action's other modes. Toggle Logging, Mark Event and the recording modes send a command to the sim and have no outcome of their own to report.
- Changing what a snapshot contains, or when one is skipped.

## Testing

Unit tests, in the action's test file:

- The capture returns `saved` when the `.json` is written, including when the report write fails afterwards and when the plugin state is an error entry; `failed` when the folder cannot be made and when the write throws; `no-data` when neither read has telemetry.
- The title for each outcome, and none once the hold has passed (fake timers).
- Only the pressed context is redrawn; a second Take Snapshot context keeps its normal title.
- A second press during the hold restarts it.
- The timer is cleared when the key disappears and when its Mode changes; no image is sent afterwards.
- A regenerate during the hold produces the outcome title.
- Capture Profile's existing tests pass unchanged apart from the renamed constant.

By hand, on a deck host:

1. In a session, press a Take Snapshot key: `SAVED` for 3 seconds, then the normal icon, and the files are in the folder.
2. With iRacing closed, press it: `NO DATA`, and the log has the existing "skipped" warning.
3. Set the key's output directory to a path that cannot be written (a file's path, or a drive that does not exist) and press: `FAILED`, with the reason in the log.
4. On a dial, press: the same three results.
5. With two Take Snapshot keys visible, press one: only that key changes.
