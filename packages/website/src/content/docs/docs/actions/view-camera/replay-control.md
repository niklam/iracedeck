---
title: Replay Control
description: Full replay transport, speed, and navigation in a single configurable action.
sidebar:
  badge:
    text: "23 modes"
    variant: tip
---

Replay Control gives you complete command over iRacing's replay system. Playback transport, progressive speed control, and session/lap/incident navigation are all available as selectable modes on a single action.

:::note
Replay Control replaces the legacy Replay Transport, Replay Speed, and Replay Navigation actions. Existing button configurations using those actions will continue to work.
:::

## Transport

| Mode | Description |
|------|-------------|
| Play / Pause | Toggle forward playback. Remembers slow-motion speed across pause/resume. |
| Play / Pause Backward | Toggle reverse playback. Mirrors slow-motion speed when switching direction. |
| Stop | Pause and reset speed memory so next play starts at 1x. |
| Fast Forward | Progressive fast-forward: each press increases speed 2x → 3x → ... → 16x. |
| Rewind | Progressive rewind: each press increases reverse speed -2x → -3x → ... → -16x. |
| Slow Motion | Quick shortcut to 1/2x slow motion. |
| Frame Forward | Advance one frame. |
| Frame Backward | Step back one frame. |

## Speed

| Mode | Description |
|------|-------------|
| Increase Speed | Traverse full speed range upward: 1/16x → ... → 1/2x → 1x → 2x → ... → 16x. Direction-aware. |
| Decrease Speed | Traverse full speed range downward. Direction-aware (works in reverse too). |
| Set Speed | Set a specific speed via dropdown (31 options from 1/16x to 16x). |
| Speed Display | Read-only display of current replay speed from telemetry. |

## Navigation

| Mode | Description |
|------|-------------|
| Next Session | Jump to the next session. |
| Previous Session | Jump to the previous session. |
| Next Lap | Jump to the next lap. |
| Previous Lap | Jump to the previous lap. |
| Next Incident | Jump to the next incident. |
| Previous Incident | Jump to the previous incident. |
| Jump to Beginning | Jump to the start of the replay. |
| Jump to Live | Jump to the live session. |

## Camera

| Mode | Description |
|------|-------------|
| Jump to My Car | Jump the replay camera to your own car. |
| Next Car | Switch to the next car in the replay. |
| Previous Car | Switch to the previous car in the replay. |

## Long-Press Repeat

Fast Forward, Rewind, Frame Forward, Frame Backward, Increase Speed, and Decrease Speed support long-press: hold the button to repeat the command automatically (500ms initial delay, then every 250ms).

## Encoder Support

Yes — rotation behavior depends on the selected mode:
- **Speed modes**: rotate adjusts speed progressively
- **Navigation modes**: rotate cycles next/previous
- **Camera modes**: rotate cycles next/previous car; push executes the selected action
- **Transport modes**: rotate steps forward/backward by one frame
