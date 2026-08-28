---
title: Border Indicator
description: Add a colored border around Stream Deck buttons — use a custom color or let toggle actions show on/off state automatically.
---

iRaceDeck lets you add a colored border around any button on your Stream Deck. The border sits between the background and the icon content, providing an extra visual cue. For toggle actions, the border color changes automatically to reflect the current state.

## Border Settings

Each button's border has three settings:

| Setting | What it controls |
|---------|-----------------|
| **Enable Border** | Show or hide the border |
| **Width** | Border thickness (2–40 pixels, step 2) |
| **Color** | Border color (for static actions) |

The border is disabled by default. Enable it per button through the **Border** section in the Property Inspector.

## Static Actions

For non-toggle actions (most actions), you choose the border color yourself:

1. Open the Property Inspector for the action
2. Expand **Border** (below Color Overrides)
3. Check **Enable Border**
4. Adjust the width and pick a color

## Toggle Actions

Actions with on/off functionality automatically use state-driven border colors:

| State | Border Color | Meaning |
|-------|-------------|---------|
| **ON** | Green | Feature is active |
| **OFF** | Red | Feature is inactive |
| **N/A** | Gray | Feature is unavailable |

Toggle actions that support automatic border colors:

- **Pit Speed Limiter**, **Push to Pass**, **DRS**, **Ignition**, and **Starter** (Car Control)
- **Toggle Fuel Fill** (Fuel Service)
- **Windshield Tearoff** and **Fast Repair** (Pit Quick Actions)

For these actions, the color picker in the Border section is ignored — the border color is determined by the current state. The width setting still applies.

## How It Works

The border is rendered as an edge-to-edge stroke around the 144x144 icon canvas. Because the stroke is centered on the canvas boundary, the outer half is clipped, so a width of 8 appears as a 4-pixel inset border.

### Layer Order

1. **Background** — the button's background color (bottom)
2. **Border** — the colored border stroke
3. **Graphics** — icon artwork and status bars
4. **Title** — label text (top)

The border is always behind the icon content, so it never obscures graphics or text.
