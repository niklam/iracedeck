---
title: Title Customization
description: Customize button title text — change font size, position, visibility, and content globally or per button.
---

iRaceDeck lets you customize the title text on every button. Change the text content, font size, position, bold styling, and visibility — or hide the icon graphics entirely for clean text-only buttons.

## What You Can Customize

| Setting | What it controls |
|---------|-----------------|
| **Show Title** | Whether title text appears on the button |
| **Show Graphics** | Whether the icon artwork appears (status bars always stay visible) |
| **Title Text** | Override the default label with custom text (supports multiple lines and [template variables](/docs/features/template-variables/)) |
| **Bold** | Bold or normal text weight |
| **Font Size** | Size of the title text (5–100) |
| **Position** | Where the title appears: top, middle, bottom, or custom offset |

## Global Title Defaults

Set default title settings for all buttons at once in the [Settings window](/docs/getting-started/settings/), on the **Appearance** tab.

1. Open the [Settings window](/docs/getting-started/settings/)
2. Go to the **Appearance** tab
3. Find the **Title Defaults** section

### Global Options

- **Show Title** / **Show Graphics** — toggle visibility for all buttons
- **Bold** — choose Default (use each icon's own setting), Yes, or No
- **Font Size** — check "Use icon default" to let each icon use its designed size, or uncheck to set a global size
- **Position** — choose Default (use each icon's designed position), or pick Top, Middle, Bottom, or Custom

When set to **Default**, each icon uses the position and font size it was designed with. For example, status bar icons (like Refuel, Windshield Tearoff) default to top position, while most other actions default to bottom.

## Per-Button Overrides

Override title settings on individual buttons through **Title Overrides**, in that button's own Property Inspector.

1. Open the Property Inspector for the action you want to customize
2. Expand **Title Overrides**
3. Adjust the settings

### Per-Button Options

- **Show Title** / **Show Graphics** / **Bold** — choose Inherit (use global setting), Yes, or No
- **Title Text** — type custom text (leave empty to use the default). Press Enter for multiple lines
- **Font Size** — check "Override font size" to set a custom size for this button
- **Position** — choose Inherit (use global setting), or pick a specific position

### Live Data in Titles

Title Text supports [template variables](/docs/features/template-variables/): put `{{variable}}` placeholders or `{{= … }}` expressions in the text and the title resolves against live iRacing telemetry, updating on the key as the values change. For example, `{{track_ahead.car_number}}` on a Camera Controls next-car button shows which car the button will switch to. While iRacing is not connected, variables render as empty text; a syntax error in an expression stays visible so you can spot it.

## How Title Settings Resolve

When rendering a button, title settings are resolved through a priority chain:

1. **Per-button override** (if set) — highest priority
2. **Global setting** (if not set to "Default") — applies to all buttons
3. **Icon default** (from the icon's design metadata) — the designed setting for that action
4. **System default** — bottom position, bold, font size 9

## Tips

- **Text-only buttons**: Set "Show Graphics" to No and increase the font size for clean, readable labels
- **Custom position**: Use the Custom position with the offset slider for precise vertical placement
- **Status bar actions** (Refuel, Windshield Tearoff, Fast Repair, Push to Pass, DRS): The ON/OFF status bar always stays visible, even when graphics are hidden
