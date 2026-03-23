---
title: Splits & Reference
description: Cycle splits delta modes, toggle reference car, mark custom sectors, and use active reset
sidebar:
  badge:
    text: "6 modes"
    variant: tip
---

The Splits & Reference action lets you switch between iRacing's different splits delta display modes, toggle the reference car display, mark custom sector start and end points, and use active reset to practice specific track sections.

## Modes

| Mode | Description |
|------|-------------|
| Cycle Delta Mode | Cycles through splits delta display modes (next or previous, configured via direction setting). |
| Toggle Reference Car | Toggles the reference car display on or off. |
| Custom Sector Start | Marks the start point for a custom sector. |
| Custom Sector End | Marks the end point for a custom sector. |
| Set Active Reset Point | Saves the current car state as a reset snapshot (solo practice only). |
| Reset to Start Point | Teleports the car back to the saved active reset snapshot (solo practice only). |

## Encoder Support

Yes — in Cycle mode, rotation cycles through delta modes (clockwise for next, counter-clockwise for previous). In all other modes, pressing the encoder triggers the configured action.

## Notes

- The "Toggle Reference Car" mode replaces the former "Display Reference Car" option in the Toggle UI Elements action.
- Active Reset only works in solo practice sessions. The car's full state (position, speed, temperatures) is captured when setting the point.
- Custom Sector and Active Reset key bindings have no defaults in iRacing — users must configure keys in both iRacing settings and the Stream Deck Property Inspector.
