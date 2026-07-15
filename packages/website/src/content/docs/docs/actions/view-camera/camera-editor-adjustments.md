---
title: Camera Editor Adjustments
description: Fine-tune camera position, orientation, FOV, vanishing point, and audio settings in the iRacing camera editor.
sidebar:
  badge:
    text: "15 modes"
    variant: tip
---

Precise control over every adjustable camera parameter in iRacing's camera editor. Each mode targets a specific axis or property. Use this action alongside [Camera Editor Controls](/docs/actions/view-camera/camera-editor-controls/) for a complete editing workflow. Placed on a **Stream Deck+ dial**, the same action becomes a camera-tool dial — turn to nudge one parameter, with the parameter's name on the touch strip — see [On a dial](#on-a-dial) below.

## Modes

Select the mode from the **Adjustment** dropdown in the Property Inspector. Every adjustment except Auto Set Mic Gain exposes a **Direction** setting for Increase / Decrease.

### Latitude

Move the camera along the latitude axis.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `D` (increase) and `A` (decrease)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button increases latitude
- **Decrease** — Pressing the button decreases latitude

---

### Longitude

Move the camera along the longitude axis.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `S` (increase) and `W` (decrease)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button increases longitude
- **Decrease** — Pressing the button decreases longitude

---

### Altitude

Move the camera along the altitude axis.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Alt+S` (increase) and `Alt+W` (decrease)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button increases altitude
- **Decrease** — Pressing the button decreases altitude

---

### Yaw

Rotate the camera on the yaw axis.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Ctrl+D` (increase) and `Ctrl+A` (decrease)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button rotates yaw clockwise
- **Decrease** — Pressing the button rotates yaw counter-clockwise

---

### Pitch

Tilt the camera on the pitch axis.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Ctrl+W` (increase) and `Ctrl+S` (decrease)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button tilts pitch upward
- **Decrease** — Pressing the button tilts pitch downward

---

### FOV Zoom

Adjust the camera field of view.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `[` (increase/zoom in) and `]` (decrease/zoom out)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button zooms in (narrower FOV)
- **Decrease** — Pressing the button zooms out (wider FOV)

---

### Key Step

Adjust the camera editor key step size.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `-` (increase) and `=` (decrease)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the step size
- **Decrease** — Pressing the button lowers the step size

---

### Vanish X

Shift the vanishing point along the X axis.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Alt+X` (increase/right) and `Ctrl+X` (decrease/left)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button shifts the vanishing point right
- **Decrease** — Pressing the button shifts the vanishing point left

---

### Vanish Y

Shift the vanishing point along the Y axis.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Alt+Y` (increase/up) and `Ctrl+Y` (decrease/down)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button shifts the vanishing point up
- **Decrease** — Pressing the button shifts the vanishing point down

---

### Blimp Radius

Adjust the blimp camera orbit radius.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Ctrl+H` (increase) and `Ctrl+G` (decrease)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button increases the radius
- **Decrease** — Pressing the button decreases the radius

---

### Blimp Velocity

Adjust the blimp camera orbit velocity.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Alt+H` (increase) and `Alt+G` (decrease)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button increases the velocity
- **Decrease** — Pressing the button decreases the velocity

---

### Mic Gain

Adjust the camera microphone gain.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Alt+Up` (increase) and `Alt+Down` (decrease)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the mic gain
- **Decrease** — Pressing the button lowers the mic gain

---

### Auto Set Mic Gain

Automatically set the microphone gain for the current camera. Non-directional toggle.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Ctrl+Alt+Down`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### F-number

Adjust the camera aperture (depth of field strength).

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Alt+U` (increase) and `Alt+I` (decrease)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the F-number
- **Decrease** — Pressing the button lowers the F-number

---

### Focus Depth

Adjust the focus depth.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Ctrl+U` (increase) and `Ctrl+I` (decrease)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button increases focus depth
- **Decrease** — Pressing the button decreases focus depth

## On a dial

Placed on a Stream Deck+ dial, Camera Editor Adjustments becomes a precision camera-tool dial — ideal for a broadcast operator mapping latitude, yaw, zoom, and focus across the four dials. Pick one parameter with the dial's **Adjustment** dropdown; turning the dial steps it up or down in the camera editor. It uses the same key bindings as the keypad modes, so no extra configuration is needed if you already use them. The Property Inspector automatically shows the dial settings below (instead of the keypad Adjustment and Direction) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

#### Details

- **Method:** Key binding — the same Camera Editor Adjustments increase/decrease bindings the keypad modes use, plus the *Auto Set Mic Gain* binding for the press gestures. Configure them in the **Related Key Bindings** section; the Property Inspector shows a status line indicating whether each is set.
- **Dial:** Rotating adjusts the selected parameter (clockwise = increase, counter-clockwise = decrease). Both the increase and decrease key bindings must be set.
- **Telemetry-aware:** No. iRacing exposes no camera-tool state, so the touch strip shows the selected parameter's name only — never a live value.

#### Controls

- **Elgato Stream Deck+** — dial rotation, a press (short or long), and a touchscreen readout that always shows. A touchscreen tap or long tap runs its own configured Tap Display / Long Touch action.

Dials are currently Stream Deck+ only — the action can't be placed on Mirabox knobs or Ulanzi dials yet (see [Dials](/docs/features/dials/)).

#### Setting: Adjustment

The camera-tool parameter the dial controls. Each renders as a color-coded "dash box" showing the parameter's short label — because iRacing exposes no camera-tool values, the box shows the label only, never a number. Each setting has a built-in accent color, but you can override the border, label, value, and background colors in the **Dash Box Appearance** section of the dial settings. Only the 14 rotatable parameters are offered — Auto Set Mic Gain is a one-shot with no direction, so it's available as a press gesture instead.

| Setting | Label | Telemetry source | Shown as |
|---|---|---|---|
| Latitude | LAT | *(none — iRacing exposes no camera-tool state)* | label only |
| Longitude | LON | *(none)* | label only |
| Altitude | ALT | *(none)* | label only |
| Yaw | YAW | *(none)* | label only |
| Pitch | PITCH | *(none)* | label only |
| FOV Zoom | FOV | *(none)* | label only |
| F-number | F-NUM | *(none)* | label only |
| Focus Depth | FOCUS | *(none)* | label only |
| VanishX | VAN X | *(none)* | label only |
| VanishY | VAN Y | *(none)* | label only |
| Blimp Radius | B-RAD | *(none)* | label only |
| Blimp Velocity | B-VEL | *(none)* | label only |
| Key Step | STEP | *(none)* | label only |
| Mic Gain | MIC | *(none)* | label only |

#### Setting: Press Action / Long Press

What a short or long press of the dial button does, chosen from:

- **None** (default for both) — does nothing.
- **Auto Set Mic Gain** — taps the *Auto Set Mic Gain* binding, which auto-sets the microphone gain for the current camera.

A press is classified when you release the dial — a hold past the [Long-press threshold](/docs/features/dials/#the-long-press-threshold) fires the Long Press action. Turning the dial while pressed adjusts the parameter (a "push + turn") and never fires the press action.

#### Setting: Tap Display / Long Touch

Optional touch-strip gestures (Stream Deck+ only), each over { Auto Set Mic Gain, None }. Both default to **None** for VR safety.
