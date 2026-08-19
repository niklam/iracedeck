---
title: Dynamic Graphic Scaling
description: Icon artwork automatically scales and repositions based on title placement — larger when title is hidden, repositioned when title moves.
---

iRaceDeck dynamically scales and positions icon artwork based on your title settings. When you hide the title, the icon graphic fills the full button. When you move the title to the top, the graphic shifts down. The result is a clean, balanced layout no matter how you configure your buttons.

## How It Works

Each icon declares the bounding box of its artwork. When the button is rendered, the assembly pipeline:

1. Calculates the available space based on title visibility and position
2. Scales the artwork to fit within that space, preserving aspect ratio
3. Centers the artwork in the available area

| Title Setting | Graphic Behavior |
|---------------|-----------------|
| **Title at bottom** (default) | Artwork in upper area, sized to fit above title |
| **Title at top** | Artwork shifts down below the title |
| **Title hidden** | Artwork scales up to fill the entire button |
| **Title in middle** | Artwork stays at full size (behind text) |

## Graphic Scale Setting

Fine-tune the graphic size with the scale control (50%–150%). At 100%, the artwork fills the available area exactly. Lower values shrink it, higher values enlarge it.

### Global Default

Set a default graphic scale for all buttons:

1. Open the [Settings window](/docs/getting-started/settings/)
2. Go to the **Appearance** tab
3. Find the **Graphic Defaults** section
4. Adjust the **Graphic Scale** slider (default: 100%)

### Per-Button Override

Override the scale on individual buttons:

1. Open the Property Inspector for the action you want to customize
2. Expand **Graphic Overrides**
3. Choose a **Scale Mode**:
   - **Inherit** — uses the global default
   - **Icon Default** — uses 100% regardless of global setting
   - **Override** — shows a slider to set a custom scale

## How Graphic Scale Resolves

1. **Per-button override** (if mode is Override) — highest priority
2. **Per-button Icon Default** (if mode is Icon Default) — forces 100%
3. **Global Graphic Scale** setting — applies to all buttons
4. **System default** — 100%

## Tips

- **Text-only buttons**: When you hide graphics (Show Graphics = No), graphic scaling has no effect — the title fills the button
- **Combine with title settings**: Try hiding the title and increasing the scale for large, clean icon buttons
- **Status bar actions** (Refuel, Windshield Tearoff, etc.) use dynamic templates and are not affected by graphic scaling
