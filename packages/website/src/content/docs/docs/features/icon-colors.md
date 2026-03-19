---
title: Customizable Icon Colors
description: Personalize the colors of your Stream Deck buttons — change backgrounds, text, and graphic elements globally or per button.
---

iRaceDeck lets you customize the colors of every icon on your Stream Deck. Change backgrounds, text colors, and graphic elements to match your preferences or improve visibility.

## Color Slots

Each icon supports up to four customizable color slots:

| Slot | What it controls |
|------|-----------------|
| **Background** | The button background color |
| **Text** | Label text below the icon |
| **Graphic 1** | Primary artwork (arrows, outlines, shapes) |
| **Graphic 2** | Secondary element (e.g., chat bubble fill) |

Not all icons support all slots. Icons with complex or data-driven artwork (like Black Box displays) only expose Background and Text.

**Semantic colors are never affected** — green (good), red (alert), yellow (current value), and blue (cold) always keep their meaning regardless of your color choices.

## Global Colors

Set default colors for all icons at once through **Global Settings**, available in the Property Inspector of any iRaceDeck action.

1. Open the Property Inspector for any action
2. Expand **Global Settings** at the bottom
3. Find the **Icon Colors** section
4. Use the preset buttons or pick individual colors

### Presets

- **Default** — removes all global color overrides, each icon uses its original category color
- **White** — white background with black text and graphics
- **Black** — black background with white text and graphics

## Per-Button Overrides

Override colors on individual buttons through **Color Overrides**, available in the Property Inspector between the action settings and Global Settings.

1. Open the Property Inspector for the action you want to customize
2. Expand **Color Overrides**
3. Use the preset buttons or pick individual colors

Per-button overrides take priority over global colors. Use the **Default** preset to clear overrides and fall back to global colors.

## How Colors Resolve

When rendering an icon, colors are resolved through a priority chain:

1. **Per-button override** (if set) — highest priority
2. **Global color** (if set) — applies to all icons
3. **Icon default** — the original color designed for that action category
