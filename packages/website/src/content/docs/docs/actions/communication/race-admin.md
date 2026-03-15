---
title: Race Admin
description: Session admin commands for league race directors — yellows, penalties, pit control, chat management, and car navigation.
sidebar:
  badge:
    text: "29 modes"
    variant: tip
---

Quick access to iRacing session admin chat commands from your Stream Deck. Designed for league race directors and hosted session admins who need to issue commands like `!yellow`, `!black`, `!pitclose`, and more without typing them manually.

All commands are sent as chat messages via the iRacing SDK. Commands that accept a `<driver>` parameter support automatic targeting of the currently viewed car or a pre-defined car number.

## Race Control

| Mode | Command | Description |
|------|---------|-------------|
| Throw Yellow Flag | `!yellow [message]` | Throw a caution flag |
| Black Flag Driver | `!black <driver> [time/laps/D]` | Issue a penalty — time (seconds), laps, or drive-through |
| Disqualify Driver | `!dq <driver> [message]` | Disqualify a driver without removing them |
| Show Disqualifications (Field) | `!showdqs` | Display disqualifications for the entire field |
| Show Disqualifications (Driver) | `!showdqs <driver>` | Display disqualifications for a specific driver |
| Clear Driver Penalties | `!clear <driver> [message]` | Clear all penalties for a driver |
| Clear All Penalties | `!clearall` | Clear all penalties for the entire field |
| Wave Driver Around | `!waveby <driver> [message]` | Move car to next lap and end of pace line |
| End of Line Penalty | `!eol <driver> [message]` | Move driver to end of pace line |
| Close Pit Entrance | `!pitclose` | Close pit entrances during green flag |
| Open Pit Entrance | `!pitopen` | Open pit entrances during green flag |
| Adjust Pace Laps | `!pacelaps <+n\|-n\|n>` | Add, subtract, or set pace laps until green |
| Single-File Restart | `!restart single` | Switch to single-file restart rules |
| Double-File Restart | `!restart double` | Switch to double-file restart rules |

## Session Management

| Mode | Command | Description |
|------|---------|-------------|
| Advance Session | `!advance [message]` | Advance to the next session (e.g., qualify to grid) |
| Delay Race Start | `!gridset [minutes]` | Disable auto-race start (max 10 minutes) |
| Start Race | `!gridstart` | Initiate the pace car or standing start sequence |
| Track State (Rubber) | `!trackstate [percent]` | Set track usage % for next session (0-100, or -1 to carry over) |

## Driver & Chat Management

| Mode | Command | Description |
|------|---------|-------------|
| Grant Admin | `!admin <driver> [message]` | Grant admin privileges to a driver |
| Revoke Admin | `!nadmin <driver> [message]` | Revoke admin privileges from a driver |
| Remove Driver | `!remove <driver> [message]` | Permanently remove a driver from the session |
| Enable Chat (All) | `!chat` | Re-enable chat for all drivers |
| Enable Chat (Driver) | `!chat <driver>` | Re-enable chat for a specific driver |
| Disable Chat (All) | `!nchat` | Disable chat for all non-admin drivers |
| Mute Driver | `!nchat <driver>` | Mute a specific driver |
| Message All Participants | `/all <message>` | Send a message to all participants (bypasses chat disable) |
| Race Control Message | `/rc <message>` | Send a message visible only to administrators |

## Car Navigation

| Mode | Description |
|------|-------------|
| Next Car (Number Order) | Switch camera to the next car by car number order (includes cars in pits) |
| Previous Car (Number Order) | Switch camera to the previous car by car number order (includes cars in pits) |

:::note
Car navigation modes differ from Replay Control's Next/Previous Car — these navigate strictly by car number order and include all cars (even those in pits), while Replay Control skips cars not on track and uses track position order.
:::

## Driver Targeting

Commands that accept a `<driver>` parameter have two targeting methods:

### Currently Viewed Car (default)

When the **"Use Viewed Car"** checkbox is checked (the default), the action automatically reads the car number of the car currently being followed in the replay/broadcast view. Simply view a car and press the button — the command targets that car.

### Pre-defined Car Number

When the checkbox is unchecked, a number input appears where you enter a car number. This car number is used every time the action fires, regardless of which car is being viewed. The car number is also displayed on the button icon.

## Message Templates

Commands that accept an optional `[message]` parameter support [template variables](/docs/features/template-variables/). This lets you include dynamic data in your messages:

```text
!advance Race starting in {{session.time_remaining}}
!yellow Caution for incident on lap {{self.lap}}
/all Welcome to {{track.short_name}}!
```

## Black Flag Penalty Types

The Black Flag mode supports three penalty types:

- **Time** — Penalty duration in seconds (e.g., 30)
- **Laps** — Number of laps to serve (e.g., 2)
- **Drive-Through** — Drive-through penalty

## Encoder Support

Yes — dial rotation is supported for **Car Navigation** modes. Rotate the dial to cycle through cars by number order. Press the dial to execute the currently selected command.

## Common Workflows

**Issue a black flag:**
1. Set the mode to "Black Flag Driver" with your desired penalty type
2. View the offending car in the replay/broadcast
3. Press the button — the command targets the viewed car automatically

**Throw a yellow with a message:**
1. Set the mode to "Throw Yellow Flag"
2. Enter a message like "Caution for debris"
3. Press the button at any time

**Quick pit control:**
1. Set up two buttons: one for "Close Pit Entrance", one for "Open Pit Entrance"
2. Press to toggle pit status during green flag racing
