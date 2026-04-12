---
title: Camera Controls
description: Cycle cameras, change camera groups, and focus on specific targets with a single button or dial.
sidebar:
  badge:
    text: "12 modes"
    variant: tip
---

Camera Controls combines camera group selection, camera cycling, and focus targeting into one action. Everything is driven by the iRacing SDK camera commands — no keyboard shortcuts and no configurable bindings.

## Modes

Select the mode from the **Target** dropdown in the Property Inspector.

### Change Camera

Switch the active camera group to a specific numeric group (1–20). Useful when you want a single button to always jump to the same camera.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Camera Group

The numeric camera group to select (1–20). Defaults to `9`. The mapping from number to group (Nose, Cockpit, TV1, etc.) depends on the car and track combination — hover over the group dropdown in the Property Inspector for the list of available groups.

---

### Cycle Camera

Cycle through camera groups. The **Direction** setting picks whether pressing the button advances to the next group or goes back. When a subset is configured, only the selected groups are cycled.

#### Details

- **Dial:** Rotation cycles camera groups (clockwise = next, counter-clockwise = previous), regardless of the Direction setting
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the button shows a preview icon for the currently active camera group (Nose, Cockpit, TV1, etc.)

#### Setting: Direction

- **Next** (default) — Pressing the button advances to the next camera group
- **Previous** — Pressing the button goes back to the previous camera group

#### Setting: Camera Group Subset

A checkbox grid in the Property Inspector lets you pick exactly which groups should participate in the cycle. By default Nose, Cockpit, Chase, TV1, TV2, and TV3 are enabled. Use **Select All** / **Clear Selection** to manage the list quickly.

The subset is stored as a global setting shared across every Camera Controls instance — configure it once and every cycling button respects the same list.

---

### Cycle Sub-Camera

Cycle sub-cameras within the currently active camera group (e.g., left / right / front nose variants).

#### Details

- **Dial:** Rotation cycles sub-cameras (clockwise = next, counter-clockwise = previous), regardless of the Direction setting
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Next** (default) — Pressing the button advances to the next sub-camera
- **Previous** — Pressing the button goes back to the previous sub-camera

---

### Cycle Car

Switch camera focus to the next / previous car in the field.

#### Details

- **Dial:** Rotation cycles cars (clockwise = next, counter-clockwise = previous), regardless of the Direction setting
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Next** (default) — Pressing the button focuses the next car
- **Previous** — Pressing the button focuses the previous car

---

### Cycle Driving Camera

Cycle through the driving-style cameras (cockpit, bumper, nose, chase, etc.).

#### Details

- **Dial:** Rotation cycles driving cameras (clockwise = next, counter-clockwise = previous), regardless of the Direction setting
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Next** (default) — Pressing the button advances to the next driving camera
- **Previous** — Pressing the button goes back to the previous driving camera

---

### Focus Your Car

Center the camera on your own car.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Focus on Leader

Focus the camera on the current race leader.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Focus on Incident

Focus the camera on the latest incident reported by iRacing.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Focus on Exiting

Focus the camera on a car that is currently exiting pit lane.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Switch by Position

Switch camera focus to the car currently running in a specific race position.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Position

The race position to focus. Integer from `1` up. Defaults to `1` (race leader).

---

### Switch by Car Number

Switch camera focus to a car by its car number.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Car Number

The car number to focus. Integer. Defaults to `0`.

---

### Set Camera State

Apply a predefined iRacing camera state bit flag. Useful for scripting camera setups during replays.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Camera State

The numeric camera state value passed to the iRacing SDK. Integer. Defaults to `0`.
