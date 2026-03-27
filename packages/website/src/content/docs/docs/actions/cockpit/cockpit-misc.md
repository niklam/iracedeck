---
title: Cockpit Misc
description: Miscellaneous cockpit controls including wipers, FFB, latency, dash pages, and enter/exit/tow
sidebar:
  badge:
    text: "11 modes"
    variant: tip
---

The Cockpit Misc action groups together various cockpit controls that don't fit neatly into other categories. Manage wipers, force feedback, latency reporting, dashboard pages, in-lap mode, and car entry/exit/tow.

## Modes

| Mode | Description |
|------|-------------|
| Toggle Wipers | Toggles the windshield wipers on or off. |
| Trigger Wipers | Triggers a single wiper sweep. |
| FFB Max Force Up | Increases the force feedback maximum force. |
| FFB Max Force Down | Decreases the force feedback maximum force. |
| Report Latency | Reports the current network latency. |
| Dash Page 1 Next | Cycles to the next page on dashboard display 1. |
| Dash Page 1 Previous | Cycles to the previous page on dashboard display 1. |
| Dash Page 2 Next | Cycles to the next page on dashboard display 2. |
| Dash Page 2 Previous | Cycles to the previous page on dashboard display 2. |
| In-Lap Mode | Toggles in-lap mode. |
| Enter / Exit / Tow Car | Context-aware car entry, exit, pit reset, or tow. Icon updates dynamically based on telemetry. |

### Enter / Exit / Tow Car States

The Enter / Exit / Tow Car mode dynamically changes its icon based on your current state in iRacing:

| State | Condition | Icon |
|-------|-----------|------|
| Enter Car | Out of car (replay/spectator) | Car with inward arrow |
| Exit Car | In the pits | Car with outward arrow |
| Reset to Pits | On track, non-race session | Car with reset arrow |
| Tow | On track, race session | Tow hook |

This mode uses a long-press pattern — hold the button to confirm the action.

## Keyboard Simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Enter / Exit / Tow Car | Shift+R | Enter/Exit/Tow Car |

## Encoder Support

Yes.
