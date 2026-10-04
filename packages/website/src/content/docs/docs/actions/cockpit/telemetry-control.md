---
title: Telemetry Control
description: Control telemetry logging and recording in iRacing, save telemetry snapshots to disk, and capture a CPU profile of iRaceDeck itself.
sidebar:
  badge:
    text: "7 modes"
    variant: tip
---

Manage iRacing's telemetry logging and recording features. Toggle logging, mark events of interest for later review, start / stop / restart recording sessions, save a snapshot of the live telemetry and session info to disk for diagnostics, and capture a CPU profile of iRaceDeck itself when it is using a lot of CPU.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector.

### Toggle Logging

Toggle iRacing's telemetry log file on or off.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Alt+L`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Mark Event

Mark the current moment in the telemetry log for later review.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `M`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Start Recording

Start a telemetry recording session via the iRacing SDK.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Stop Recording

Stop the current telemetry recording session via the iRacing SDK.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Restart Recording

Stop and immediately restart telemetry recording via the iRacing SDK.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Take Snapshot

Save everything iRaceDeck currently sees from iRacing — the full live telemetry and the session info — to disk. Each press writes two timestamped files to the Output Folder: a `.json` file holding every telemetry variable plus the session info (the raw data), and a companion `.md` report you can read at a glance — the session identification, the running order and the on-track order with each driver's car number, laps completed, and location, and the player's own telemetry. It is a developer / diagnostic tool: attach the files to a bug report, or use them to check what iRacing was reporting at a given moment.

The mode only reads data the plugin already has and sends nothing to iRacing, so it never affects the sim. A press while iRacing isn't running (no telemetry available) is skipped with a warning in the plugin log; a successful save is logged as well, including the file paths. There is no feedback on the key itself.

#### Details

- **Method:** Local file write (saves telemetry to disk) — no iRacing command
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Output Folder

The folder the snapshot files are written to. Leave it blank to use the default — an `iRaceDeck\telemetry-snapshots` folder in your user home folder (for example `C:\Users\<you>\iRaceDeck\telemetry-snapshots`). Any folder path works: environment variables such as `%USERPROFILE%` and a leading `~` are expanded, and a relative path is resolved against your home folder rather than the plugin's own folder. The folder is created if it doesn't exist.

Files are named `telemetry-snapshot-YYYYMMDD-HHMMSS-mmm.json` and `.md` — local time with millisecond resolution, so presses in quick succession normally get their own files rather than overwriting the previous one.

---

### Capture CPU Profile

Record 30 seconds of what iRaceDeck itself is doing, for a report about high CPU use, without leaving the car. It is the same capture as **Capture CPU profile** on the [Settings window's Diagnostics tab](/docs/getting-started/settings/#diagnostics), from a key: useful in a race that cannot be paused, when opening the Settings window is not an option.

While the capture runs, the key counts down the seconds left. When the files are saved it shows **SAVED** for 3 seconds, or **FAILED** if the capture fails, whether it could not start or its files could not be saved (the reason is in the plugin log), then its normal icon again. Only one capture runs at a time: a press while one is running, whether it was started from a key or from the Settings window, is ignored, and every Capture CPU Profile key shows the running capture's countdown.

The capture writes two files to the `profiles` folder next to the plugin log, a `.cpuprofile` and a `.txt` summary, and keeps the five newest captures. Open the folder with **Open folder** beside Capture CPU profile on the Diagnostics tab, then attach both files to your report. See [If iRaceDeck uses a lot of CPU](/docs/getting-started/troubleshooting/#if-iracedeck-uses-a-lot-of-cpu).

The mode sends nothing to iRacing and works with or without iRacing running.

#### Details

- **Method:** Records a CPU profile of iRaceDeck — no iRacing command
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings
