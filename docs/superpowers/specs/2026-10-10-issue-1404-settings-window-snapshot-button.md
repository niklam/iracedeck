# A telemetry snapshot from the settings window's Diagnostics tab

> **Issue:** [#1404](https://github.com/niklam/iracedeck/issues/1404) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

Since #1387 a telemetry snapshot holds what support needs for most reports: the telemetry, the session info and the plugin's own state. The only way to take one is Telemetry Control's Take Snapshot mode, so a user must find the action, place it on a key and know the mode exists. The troubleshooting page's instruction starts with "Add a Telemetry Control key", which is three steps before the one that matters.

The settings window's Diagnostics tab is where the other support tools already are (debug logging, the settings file, the CPU profile capture), and every user can open it on every host.

## Decision

### 1. What the user gets

One row on the Diagnostics tab, in the existing card, built like the CPU profile row beside it:

- **Take snapshot**: captures now.
- **Open folder**: opens the folder the window's snapshots are written to.
- A status line under the buttons, and one sentence of help that says what the files are for and links to "Before you share a snapshot" on the Telemetry Control page, since the files name the user and the other drivers.

The row is rendered in the settings window only, as the CPU profile row is. The Property Inspectors do not get it.

### 2. One capture, in a module of its own

The capture moves out of the `TelemetryControl` class into a module beside it in `@iracedeck/iracing-actions` (`actions/telemetry-control/snapshot-capture.ts`): a plain function that is given its reads (the SDK controller's telemetry and session info), a logger and an output directory, and returns an outcome. The action calls it with the key's directory; `plugin-runtime`'s settings phase passes the command handler a closure that calls it with the default directory. Both write the same files through the same code, so a fix to one is a fix to both.

The function stays synchronous from the telemetry read to the state collection. That is what makes the snapshot's telemetry and its `pluginState` describe one tick (#1387), and a command arriving over the window's socket is handled in one synchronous run, the same as a key press.

The outcome is the one #1403 defines for the key: `saved` with the `.json` path, `failed` with a reason, or `no-data` when there is no telemetry. Whichever of the two issues lands first introduces it.

`@iracedeck/iracing-actions` is where it lives because it is the lowest package that may import everything the capture needs: `iracing-sdk`'s envelope and report builders, `diagnostics`' state collector and `sim-events-iracing`'s latest tick. `plugin-runtime` already depends on it for the action list.

### 3. The command

A new window command, `takeSnapshot`, with no payload, and `openSnapshotsFolder`, with none either. In `@iracedeck/settings-window` that is one optional dependency on the command handler (`takeSnapshot?: () => void`), one path (`snapshotsPath?: string`) and two `case`s; the folder command reuses the injected `openDirectory`, as the profiles folder does.

Neither command takes anything from the page: no path, no file name, no options. The request guard and the server do not change. A command the plugin does not wire (a host without it, a test) is ignored, as every other command is.

### 4. Where the window's snapshots go

`~/iRaceDeck/telemetry-snapshots`, the folder a key with a blank output directory already uses (`defaultSnapshotDir()`). No global setting is added for it.

A key keeps its own output directory. The window does not read any key's setting: which key would it be, and a user following support's instructions should end up in the folder the documentation names. **Open folder** opens that default folder and creates it first when it does not exist, so the button never opens nothing.

### 5. The status line

The capture publishes its outcome under a run-scoped global-settings key, `_snapshotStatus`, a JSON string like `_profileCaptureStatus`:

| State | Fields | The window says |
| --- | --- | --- |
| `idle` | none | nothing |
| `saved` | `at`, `file` (the `.json` file's name, not its path) | Saved, with the file name and the time |
| `failed` | `at`, `reason` | Snapshot failed, with the reason |
| `no-data` | `at` | Nothing to capture: iRacing is not running |

- **Every capture publishes it**, whichever of the key and the window started it, so a window that is open while a key is pressed shows that press. It is the last capture's outcome, not a history.
- **The file name, not the path.** The page gets no path from the plugin for this, and the folder is one click away. A key that writes to its own directory still shows its file name here; the path is in the log.
- **Run-scoped.** The key joins `RUN_SCOPED_SETTING_KEYS`, so it is never written to the settings file and a new plugin start begins at `idle`. Its name is a constant in `@iracedeck/app-constants`, where the page component and the run-scoped list can both import it.
- **It never appears in a snapshot.** The snapshot's settings reader drops every `_` key it does not name (#1387), so the status needs no entry there and must not be given one.
- The status is written after the files are, so it cannot be in the snapshot it describes, and a failure to write the status is logged and changes nothing about the outcome.

The key's own feedback is #1403. A snapshot taken from the window does not light up any key: #1403 shows the outcome on the key that was pressed, and here none was.

### 6. No capture in flight

A snapshot takes tens of milliseconds and is synchronous, so there is no "capturing" state, no countdown and no busy refusal. Two presses in a row are two snapshots with two timestamps. The button is not disabled while iRacing is closed: pressing it then answers the question the user has, in the status line.

## Alternatives rejected

- **A service in `@iracedeck/diagnostics`, like the CPU profile capture.** Diagnostics may not import a sim package (the lint rule from #1351), so the envelope builder, the report generator, the telemetry reads and the latest tick would all be injected through a seam that has one implementation. That is most of the capture passed in as arguments.
- **The capture in `@iracedeck/deck-iracing`.** It has the SDK singleton but would need two new dependency edges, on `diagnostics` and on `sim-events-iracing`, the second making the deck's iRacing side depend on the translator.
- **The capture in `plugin-runtime`.** The action could not call it without a dependency cycle.
- **The window pressing a hidden instance of the action.** There is no such thing as an action without a context, and inventing one to reuse a method is the wrong direction for a seam.
- **A global setting for the snapshot folder.** It would need a field, a migration story and a second place to look when support asks where the file went. The key already has a per-key directory for users who want one.
- **Returning the result over the socket to the page.** The window commands that report back (the CPU profile capture, the voice-pack rescan and install) do it through a settings key or a banner, not a response frame, and the page already knows how to follow a key.
- **A warning banner for a failed snapshot.** Banners are for conditions that persist until fixed. A failed press is an event, and the status line sits beside the button that caused it.
- **Zipping the files, or attaching the plugin log.** Out of scope for #1387 for the same reason: the user attaches files as today.

## Out of scope

- The key's `SAVED` / `FAILED` feedback (#1403).
- Taking a snapshot from a Property Inspector.
- Choosing the folder in the window, or a global default directory for keys.
- A list or history of snapshots, deleting old ones, or a size limit on the folder.
- Uploading, zipping or redacting.
- Any change to what a snapshot contains.
- A snapshot scheduled or triggered by an event (an incident, a callout). A press is the only trigger.

## Testing

Unit tests:

- **Capture module:** the tests that today drive the action's `captureSnapshot` move with it and pass unchanged in meaning: the same-tick telemetry choice, the JSON written before the report, the error entries, the skip with no telemetry. New: each outcome is returned and published under `_snapshotStatus` with the fields in the table, the published file is a name with no directory in it, the status is written after the `.json`, and a throwing status write does not change the outcome.
- **Action:** it calls the module with the key's resolved directory and nothing else of the capture is left in the class.
- **Command handler:** `takeSnapshot` calls the dependency once and passes it nothing from the payload; `openSnapshotsFolder` opens the injected path; each is ignored when its dependency is absent; a payload carrying a `path` or any other field changes nothing.
- **Wiring:** `plugin-runtime`'s settings phase hands the handler both dependencies, with the default directory.
- **Run-scoped:** `_snapshotStatus` is stripped into the cache, out to the file and from a migrated raw, by the existing run-scoped tests extended with the key.
- **Snapshot settings reader:** `_snapshotStatus` present in the settings is absent from `pluginState.settings` (the allow-list test gains the key as one more `_` key that must not pass).
- **Page:** the status component renders each state and nothing for `idle`, and renders a malformed value as nothing.

By hand, on a deck host, with the settings window open on Diagnostics:

1. In a session, press **Take snapshot**: the status line names the file, and **Open folder** shows it with its `.md`.
2. With iRacing closed, press it: the status line says there is nothing to capture, and no file is written.
3. Make the default folder unwritable (replace it with a file of the same name) and press: the status line says it failed, with the reason.
4. Press a Take Snapshot key while the window is open: the status line shows that press.
5. Restart the plugin: the status line is empty.
6. Take a snapshot and search its `.json` for `_snapshotStatus`: it is not there.
7. On Mirabox and Ulanzi, the row is present and steps 1 and 2 behave the same.
