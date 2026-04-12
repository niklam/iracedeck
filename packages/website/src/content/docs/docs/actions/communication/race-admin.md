---
title: Race Admin
description: Session admin commands for league race directors — yellows, penalties, pit control, and chat management.
sidebar:
  badge:
    text: "27 modes"
    variant: tip
---

Quick access to iRacing session admin chat commands from your Stream Deck. Designed for league race directors and hosted session admins who need to issue commands like `!yellow`, `!black`, `!pitclose`, and more without typing them manually. Every mode sends its command through the iRacing SDK chat API — no keyboard bindings, no telemetry awareness.

Every command that accepts an optional `[message]` parameter supports [template variables](/docs/features/template-variables/), so you can include live data like lap number, session time, or track name in the messages you send.

:::note
Commands that accept a `<driver>` parameter share a **Driver Target** setting that decides how the car number is picked at send time. Rather than repeating the full setting on every such mode, it is documented once in the **Shared settings** section at the bottom of this page.
:::

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector. The dropdown is grouped by **Race Control**, **Session Management**, and **Driver & Chat Management**.

### Throw Yellow Flag

Throw a caution flag — sends `!yellow [message]`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Message

Optional caution message (supports template variables).

---

### Black Flag Driver

Issue a penalty — sends `!black <driver> [time/laps/D]`. Black Flag supports three penalty types.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Driver Target

See **Shared settings** below — this mode needs a driver.

#### Setting: Penalty Type

- **Time** (default) — Penalty duration in seconds (e.g., `30`)
- **Laps** — Number of laps to serve (e.g., `2`)
- **Drive-Through** — Drive-through penalty (`D`)

---

### Disqualify Driver

Disqualify a driver without removing them — sends `!dq <driver> [message]`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Driver Target

See **Shared settings** below — this mode needs a driver.

#### Setting: Message

Optional disqualification message (supports template variables).

---

### Show Disqualifications (Field)

Display disqualifications for the entire field — sends `!showdqs`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Show Disqualifications (Driver)

Display disqualifications for a specific driver — sends `!showdqs <driver>`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Driver Target

See **Shared settings** below — this mode needs a driver.

---

### Clear Driver Penalties

Clear all penalties for a driver — sends `!clear <driver> [message]`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Driver Target

See **Shared settings** below — this mode needs a driver.

#### Setting: Message

Optional explanation (supports template variables).

---

### Clear All Penalties

Clear all penalties for the entire field — sends `!clearall`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Wave Driver Around

Wave a car to the next lap and the end of the pace line — sends `!waveby <driver> [message]`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Driver Target

See **Shared settings** below — this mode needs a driver.

#### Setting: Message

Optional explanation (supports template variables).

---

### End of Line Penalty

Move a driver to the end of the pace line — sends `!eol <driver> [message]`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Driver Target

See **Shared settings** below — this mode needs a driver.

#### Setting: Message

Optional explanation (supports template variables).

---

### Close Pit Entrance

Close pit entrances during green flag running — sends `!pitclose`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Open Pit Entrance

Open pit entrances during green flag running — sends `!pitopen`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Adjust Pace Laps

Add, subtract, or set pace laps until green — sends `!pacelaps <+n|-n|n>`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Pace Laps Operation

- **+** (default) — Add the given number of pace laps
- **−** — Subtract the given number of pace laps
- **=** — Set the absolute pace lap count

#### Setting: Pace Laps Value

The number of laps passed with the operation.

---

### Single-File Restart

Switch to single-file restart rules — sends `!restart single`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Double-File Restart

Switch to double-file restart rules — sends `!restart double`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Advance Session

Advance to the next session (e.g., qualify to grid) — sends `!advance [message]`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Message

Optional message to broadcast with the session change (supports template variables).

---

### Delay Race Start

Disable auto-race start for a number of minutes — sends `!gridset [minutes]` (max 10 minutes).

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Minutes

Number of minutes to delay. iRacing caps this at 10.

---

### Start Race

Initiate the pace car or standing start sequence — sends `!gridstart`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Track State (Rubber)

Set the track usage percentage for the next session — sends `!trackstate [percent]`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Percent

Track usage percent from `0` to `100`, or `-1` to carry the current state forward.

---

### Grant Admin

Grant admin privileges to a driver — sends `!admin <driver> [message]`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Driver Target

See **Shared settings** below — this mode needs a driver.

#### Setting: Message

Optional message (supports template variables).

---

### Revoke Admin

Revoke admin privileges from a driver — sends `!nadmin <driver> [message]`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Driver Target

See **Shared settings** below — this mode needs a driver.

#### Setting: Message

Optional message (supports template variables).

---

### Remove Driver

Permanently remove a driver from the session — sends `!remove <driver> [message]`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Driver Target

See **Shared settings** below — this mode needs a driver.

#### Setting: Message

Optional removal message (supports template variables).

---

### Enable Chat (All)

Re-enable chat for all drivers — sends `!chat`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Enable Chat (Driver)

Re-enable chat for a specific driver — sends `!chat <driver>`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Driver Target

See **Shared settings** below — this mode needs a driver.

---

### Disable Chat (All)

Disable chat for all non-admin drivers — sends `!nchat`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Mute Driver

Mute a specific driver — sends `!nchat <driver>`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Driver Target

See **Shared settings** below — this mode needs a driver.

---

### Message All Participants

Send a message to every participant, bypassing chat disables — sends `/all <message>`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Message

Required. Supports template variables.

---

### Race Control Message

Send a message visible only to administrators — sends `/rc <message>`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Message

Required. Supports template variables.

## Shared settings

### Driver Target

Every mode that accepts a `<driver>` parameter shares a single targeting setting with two options:

- **Use Viewed Car** (default) — The action reads the car number of the car currently being followed in the replay / broadcast view at send time. View a car and press the button; the command targets that car.
- **Pre-defined Car Number** — Unchecking **Use Viewed Car** reveals a number input. The same car number is used on every press, regardless of which car is being viewed, and is also rendered on the button icon so you can tell which car the button targets.

### Message templates

Every `[message]` parameter supports [template variables](/docs/features/template-variables/), so you can include live telemetry or session data in the messages you send. Examples:

```text
!advance Race starting in {{session.time_remaining}}
!yellow Caution for incident on lap {{self.lap}}
/all Welcome to {{track.short_name}}!
```

## Common workflows

**Issue a black flag:**

1. Set the mode to **Black Flag Driver** with your desired penalty type
2. View the offending car in the replay / broadcast
3. Press the button — the command targets the viewed car automatically

**Throw a yellow with a message:**

1. Set the mode to **Throw Yellow Flag**
2. Enter a message like `Caution for debris`
3. Press the button when you need the caution

**Quick pit control:**

1. Set up two buttons: one for **Close Pit Entrance**, one for **Open Pit Entrance**
2. Press to toggle pit status during green flag racing
