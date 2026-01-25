# Stream Deck Unified Plugin Planning

Alternative to multi-plugin architecture: a single plugin with max 32 main actions, each containing multiple sub-actions selectable via Property Inspector dropdown.

**Benefits:**

- Single plugin to install/maintain
- Simpler user experience
- Reduced manifest complexity
- Shared global settings across all actions

---

# Core Racing Actions

## Main Action 1: Black Box Selector

Opens a specific black box or cycles through them.

| Sub-Action           | Default Key      | iRacing Setting |
| -------------------- | ---------------- | --------------- |
| Lap Timing           | F1               | -               |
| Standings            | F2               | -               |
| Relative             | F3               | -               |
| Fuel                 | F4               | -               |
| Tires                | F5               | -               |
| Tire Info            | F6               | -               |
| Pit Stop Adjustments | F7               | -               |
| In-Car Adjustments   | F8               | -               |
| Mirror Adjustments   | F9               | -               |
| Radio Adjustments    | F10              | -               |
| Graphics Adjustments | F11              | -               |
| Cycle Next           | _(configurable)_ | -               |
| Cycle Previous       | _(configurable)_ | -               |

**Type:** Multi-toggle with mode selector (Direct/Next/Previous)

---

## Main Action 2: Splits Delta Cycle

Cycles through split/delta display modes.

| Sub-Action | Default Key | iRacing Setting |
| ---------- | ----------- | --------------- |
| Next       | TAB         | -               |
| Previous   | Shift+TAB   | -               |

**Type:** +/- (direction selector)

---

## Main Action 3: Toggle UI Elements

Toggles various UI display elements on/off.

| Sub-Action            | Default Key | iRacing Setting |
| --------------------- | ----------- | --------------- |
| Dash Box              | D           | -               |
| Speed/Gear/Pedals     | P           | -               |
| Radio Display         | O           | -               |
| FPS/Network Display   | F           | -               |
| Weather Radar         | Shift+Alt+R | -               |
| Virtual Mirror        | Alt+M       | -               |
| UI Edit Mode          | Alt+K       | -               |
| Display Reference Car | Ctrl+C      | -               |
| Replay UI Visibility  | _(SDK)_     | SDK             |

**Type:** Toggle (item selector dropdown)

---

## Main Action 4: Car Control

Core car operation controls.

| Sub-Action         | Default Key | iRacing Setting |
| ------------------ | ----------- | --------------- |
| Starter            | S           | -               |
| Ignition           | I           | -               |
| Pit Speed Limiter  | A           | -               |
| Enter/Exit/Tow Car | Shift+R     | -               |
| Pause Sim          | Shift+P     | -               |

**Type:** Button/Toggle (item selector dropdown)

---

## Main Action 5: Look Direction

Changes driver view direction.

| Sub-Action | Default Key | iRacing Setting |
| ---------- | ----------- | --------------- |
| Look Left  | Z           | -               |
| Look Right | X           | -               |
| Look Up    | ↑           | -               |
| Look Down  | ↓           | -               |

**Type:** Multi-toggle (direction selector)

---

## Main Action 6: View Adjustment

Camera/view position adjustments.

| Sub-Action         | Default Key   | iRacing Setting |
| ------------------ | ------------- | --------------- |
| FOV Increase       | ]             | -               |
| FOV Decrease       | [             | -               |
| Horizon Up         | Shift+]       | -               |
| Horizon Down       | Shift+[       | -               |
| Driver Height Up   | Ctrl+]        | -               |
| Driver Height Down | Ctrl+[        | -               |
| Recenter VR        | ;             | -               |
| UI Size Increase   | Ctrl+PageUp   | -               |
| UI Size Decrease   | Ctrl+PageDown | -               |

**Type:** +/- or Button (item + direction selector)

---

## Main Action 7: Cockpit Misc

Miscellaneous cockpit controls including dashboard settings.

| Sub-Action             | Default Key | iRacing Setting |
| ---------------------- | ----------- | --------------- |
| Trigger Wipers         | Ctrl+Alt+W  | -               |
| FFB Max Force Increase | _(SDK)_     | SDK             |
| FFB Max Force Decrease | _(SDK)_     | SDK             |
| Report Latency         | L           | -               |
| Dash Page 1 +/-        | -           | Adjustment      |
| Dash Page 2 +/-        | -           | Adjustment      |
| In Lap Mode Toggle     | Shift+Alt+L | -               |

**Type:** Button or +/- (item selector)

---

# Pit Service Actions

## Main Action 8: Pit Quick Actions

Quick pit stop toggles (no adjustment values).

| Sub-Action           | Default Key | iRacing Setting |
| -------------------- | ----------- | --------------- |
| Clear All Checkboxes | _(SDK)_     | SDK             |
| Windshield Tearoff   | _(SDK)_     | SDK             |
| Request Fast Repair  | _(SDK)_     | SDK             |

**Type:** Button/Toggle (item selector)

---

## Main Action 9: Fuel Service

Complete fuel management for pit stops and autofuel.

| Sub-Action          | Default Key  | Notes               |
| ------------------- | ------------ | ------------------- |
| Add Fuel            | -            | SDK - adjust amount |
| Reduce Fuel         | -            | SDK - adjust amount |
| Set Fuel Amount     | -            | SDK - direct value  |
| Clear Fuel Checkbox | _(SDK)_      | SDK                 |
| Toggle Autofuel     | Shift+Ctrl+A | -                   |
| Increase Lap Margin | Shift+Alt+X  | -                   |
| Decrease Lap Margin | Shift+Alt+S  | -                   |

**Type:** Adjustment/Toggle (+/- or value input)
**SDK Support:** Partial (pit commands via SDK, autofuel via keyboard)

---

## Main Action 10: Tire Service

Tire request, compound, and clear management.

| Sub-Action           | Notes |
| -------------------- | ----- |
| Request LF           | SDK   |
| Request RF           | SDK   |
| Request LR           | SDK   |
| Request RR           | SDK   |
| Request All          | SDK   |
| Change Compound      | SDK   |
| Clear Tires Checkbox | SDK   |

**Type:** Configurable (tire selector checkboxes + compound dropdown)
**SDK Support:** Yes

---

# Communication Actions

## Main Action 11: Chat

All text chat operations, messages, and macros.

| Sub-Action         | Default Key | Notes                     |
| ------------------ | ----------- | ------------------------- |
| Open Chat          | T           | SDK                       |
| Reply to Chat      | R           | SDK                       |
| Whisper            | / [num]     | -                         |
| Respond to Last PM | /r          | SDK                       |
| Cancel Chat        | _(SDK)_     | SDK                       |
| Send Message       | -           | SDK - configurable text   |
| Macro (1-15)       | -           | SDK - select number in PI |

**Settings for Send Message mode:**

- Message Text (user-configurable)

**Settings for Macro mode:**

- Macro Number (1-15 dropdown)
- Custom Key Text (optional display text)
- Icon Color (color picker)

**Type:** Button/Configurable (mode selector)
**SDK Support:** Yes

---

## Main Action 12: Audio Controls

All audio volume and mute controls.

| Sub-Action             | Default Key             | iRacing Setting |
| ---------------------- | ----------------------- | --------------- |
| Spotter Volume Up      | Shift+Ctrl+NUMPAD +     | -               |
| Spotter Volume Down    | Shift+Ctrl+NUMPAD -     | -               |
| Spotter Silence        | Shift+Ctrl+M            | -               |
| Voice Chat Volume Up   | Shift+Ctrl+Alt+NUMPAD + | -               |
| Voice Chat Volume Down | Shift+Ctrl+Alt+NUMPAD - | -               |
| Voice Chat Mute        | Shift+Ctrl+Alt+M        | -               |
| Master Volume Increase | Shift+Alt+NUMPAD +      | -               |
| Master Volume Decrease | Shift+Alt+NUMPAD -      | -               |

**Type:** +/- or Toggle (category + action selector)

---

# Replay Actions

## Main Action 13: Replay Transport

Playback control for replays.

| Sub-Action     | Default Key    | Notes |
| -------------- | -------------- | ----- |
| Play           | _(SDK)_        | SDK   |
| Pause          | _(SDK)_        | SDK   |
| Stop           | NUMPAD .       | SDK   |
| Fast Forward   | Shift+NUMPAD 6 | SDK   |
| Rewind         | Shift+NUMPAD 4 | SDK   |
| Slow Motion    | NUMPAD 8       | SDK   |
| Frame Forward  | NUMPAD 6       | SDK   |
| Frame Backward | NUMPAD 4       | SDK   |

**Type:** Button (transport action selector)

---

## Main Action 14: Replay Speed

Set replay playback speed.

| Settings    | Notes          |
| ----------- | -------------- |
| Speed Value | SDK adjustment |

**Type:** Adjustment
**SDK Support:** Yes

---

## Main Action 15: Replay Navigation

Jump to specific points in replay.

| Sub-Action          | Default Key    | Notes              |
| ------------------- | -------------- | ------------------ |
| Next Session        | Ctrl+NUMPAD 6  | SDK                |
| Previous Session    | Ctrl+NUMPAD 4  | SDK                |
| Next Lap            | Shift+NUMPAD 3 | SDK                |
| Previous Lap        | Shift+NUMPAD 1 | SDK                |
| Next Incident       | Ctrl+NUMPAD 3  | SDK                |
| Previous Incident   | Ctrl+NUMPAD 1  | SDK                |
| Jump to Start       | NUMPAD 7       | SDK                |
| Jump to End         | NUMPAD 1       | SDK                |
| Set Play Position   | _(SDK)_        | SDK - configurable |
| Search Session Time | _(SDK)_        | SDK - configurable |
| Erase Tape          | _(SDK)_        | SDK                |

**Type:** Button/Configurable (navigation action selector)

---

# Camera Actions

## Main Action 16: Camera Cycle

Cycle through cameras and cars.

| Sub-Action              | Default Key | Notes |
| ----------------------- | ----------- | ----- |
| Next Camera             | C           | SDK   |
| Previous Camera         | Shift+C     | SDK   |
| Next Sub-Camera         | B           | SDK   |
| Previous Sub-Camera     | Shift+B     | SDK   |
| Next Car                | V           | SDK   |
| Previous Car            | Shift+V     | SDK   |
| Next Driving Camera     | PageDown    | SDK   |
| Previous Driving Camera | PageUp      | SDK   |

**Type:** +/- (camera type + direction selector)

---

## Main Action 17: Camera Focus

Focus camera on specific target.

| Sub-Action            | Default Key | Notes              |
| --------------------- | ----------- | ------------------ |
| Focus Your Car        | Ctrl+V      | SDK                |
| Focus on Leader       | _(SDK)_     | SDK                |
| Focus on Incident     | _(SDK)_     | SDK                |
| Focus on Exiting Cars | _(SDK)_     | SDK                |
| Switch by Position    | _(SDK)_     | SDK - configurable |
| Switch by Car Number  | _(SDK)_     | SDK - configurable |
| Set Camera State      | _(SDK)_     | SDK - configurable |

**Type:** Button/Configurable (focus target selector)

---

## Main Action 18: Camera Editor - Adjustments

Camera position and view editing (for broadcasters).

| Sub-Action         | Default Key     | Notes |
| ------------------ | --------------- | ----- |
| Latitude +/-       | D / A           | -     |
| Longitude +/-      | S / W           | -     |
| Altitude +/-       | Alt+S / Alt+W   | -     |
| Yaw +/-            | Ctrl+D / Ctrl+A | -     |
| Pitch +/-          | Ctrl+W / Ctrl+S | -     |
| FOV Zoom +/-       | [ / ]           | -     |
| Key Step +/-       | - / =           | -     |
| VanishX +/-        | Alt+X / Ctrl+X  | -     |
| VanishY +/-        | Alt+Y / Ctrl+Y  | -     |
| Blimp Radius +/-   | Ctrl+H / Ctrl+G | -     |
| Blimp Velocity +/- | Alt+H / Alt+G   | -     |
| Mic Gain +/-       | Alt+Up/Down     | -     |
| Auto Set Mic Gain  | Ctrl+Alt+Down   | -     |
| F-number +/-       | Alt+U / Alt+I   | -     |
| Focus Depth +/-    | Ctrl+U / Ctrl+I | -     |

**Type:** +/- or Button (adjustment selector)

---

## Main Action 19: Camera Editor - Controls

Camera editor toggles and management (for broadcasters).

| Sub-Action              | Default Key       | Notes |
| ----------------------- | ----------------- | ----- |
| Open Camera Tool        | Ctrl+F12          | -     |
| Key Acceleration Toggle | Ctrl+P            | -     |
| Key 10x Toggle          | Alt+P             | -     |
| Parabolic Mic Toggle    | Ctrl+O            | -     |
| Cycle Position Type     | Alt+N             | -     |
| Cycle Aim Type          | Alt+M             | -     |
| Acquire Start           | Ctrl+Q            | -     |
| Acquire End             | Shift+Q           | -     |
| Temporary Edits Toggle  | Ctrl+L            | -     |
| Dampening Toggle        | Ctrl+N            | -     |
| Zoom Toggle             | Ctrl+M            | -     |
| Beyond Fence Toggle     | Ctrl+B            | -     |
| In Cockpit Toggle       | Alt+B             | -     |
| Mouse Navigation Toggle | Ctrl+Z            | -     |
| Pitch Gyro Toggle       | Ctrl+J            | -     |
| Roll Gyro Toggle        | Alt+J             | -     |
| Limit Shot Range Toggle | Alt+O             | -     |
| Show Camera Toggle      | Alt+Q             | -     |
| Shot Selection Toggle   | Ctrl+T            | -     |
| Manual Focus Toggle     | Ctrl+F            | -     |
| Insert Camera           | Shift+Ctrl+Insert | -     |
| Remove Camera           | Shift+Ctrl+Delete | -     |
| Copy Camera             | Shift+Ctrl+C      | -     |
| Paste Camera            | Shift+Ctrl+V      | -     |
| Copy Group              | Ctrl+Alt+C        | -     |
| Paste Group             | Ctrl+Alt+V        | -     |
| Save Track Camera       | Ctrl+F11          | -     |
| Load Track Camera       | Shift+Ctrl+F11    | -     |
| Save Car Camera         | Alt+F11           | -     |
| Load Car Camera         | Shift+Alt+F11     | -     |

**Type:** Button/Toggle (action selector)

---

# Media & Telemetry Actions

## Main Action 20: Media Capture

Video and screenshot functions.

| Sub-Action            | Default Key       | Notes              |
| --------------------- | ----------------- | ------------------ |
| Start/Stop Video      | Ctrl+Alt+Shift+V  | SDK                |
| Video Timer           | Alt+V             | SDK                |
| Toggle Video Capture  | _(SDK)_           | SDK                |
| Take Screenshot       | Ctrl+Alt+Shift+S  | SDK                |
| Take Giant Screenshot | Ctrl+Shift+PrtScn | -                  |
| Reload All Textures   | Ctrl+R            | SDK                |
| Reload Car Textures   | _(SDK)_           | SDK - configurable |

**Type:** Button/Toggle (capture action selector)

---

## Main Action 21: Telemetry Control

Telemetry logging and recording.

| Sub-Action        | Default Key | Notes |
| ----------------- | ----------- | ----- |
| Toggle Logging    | Alt+L       | SDK   |
| Mark Event        | M           | -     |
| Toggle Recording  | _(SDK)_     | SDK   |
| Restart Recording | _(SDK)_     | SDK   |

**Type:** Button/Toggle (telemetry action selector)

---

# Car Setup Actions

## Main Action 22: Setup - Brakes

Brake-related car adjustments.

| Sub-Action          | Notes      |
| ------------------- | ---------- |
| ABS Toggle          | Toggle     |
| ABS Adjust +/-      | Adjustment |
| Brake Bias +/-      | - / = keys |
| Brake Bias Fine +/- | Adjustment |
| Peak Brake Bias +/- | Adjustment |
| Brake Misc +/-      | Adjustment |
| Engine Braking +/-  | Adjustment |

**Type:** Toggle or +/- (setting + direction selector)

---

## Main Action 23: Setup - Engine

Engine power and throttle adjustments.

| Sub-Action           | Notes      |
| -------------------- | ---------- |
| Engine Power +/-     | Adjustment |
| Throttle Shaping +/- | Adjustment |
| Boost Level +/-      | Adjustment |
| Launch RPM +/-       | Adjustment |

**Type:** +/- (setting selector)

---

## Main Action 24: Setup - Fuel

Fuel mixture and cut adjustments (in-car setup, not pit service).

| Sub-Action            | Notes      |
| --------------------- | ---------- |
| Fuel Mixture +/-      | Adjustment |
| Fuel Cut Position +/- | Adjustment |
| Disable Fuel Cut      | Toggle     |
| Low Fuel Accept       | Button     |
| FCY Mode Toggle       | Toggle     |

**Type:** Toggle/Button or +/- (setting selector)

---

## Main Action 25: Setup - Traction

Traction control adjustments.

| Sub-Action    | Notes      |
| ------------- | ---------- |
| TC Toggle     | Toggle     |
| TC Slot 1 +/- | Adjustment |
| TC Slot 2 +/- | Adjustment |
| TC Slot 3 +/- | Adjustment |
| TC Slot 4 +/- | Adjustment |

**Type:** Toggle or +/- (TC slot selector)

---

## Main Action 26: Setup - Chassis

Suspension and handling adjustments.

| Sub-Action               | Notes      |
| ------------------------ | ---------- |
| Differential Preload +/- | Adjustment |
| Differential Entry +/-   | Adjustment |
| Differential Middle +/-  | Adjustment |
| Differential Exit +/-    | Adjustment |
| Front ARB +/-            | Adjustment |
| Rear ARB +/-             | Adjustment |
| Left Spring +/-          | Adjustment |
| Right Spring +/-         | Adjustment |
| LF Shock +/-             | Adjustment |
| RF Shock +/-             | Adjustment |
| LR Shock +/-             | Adjustment |
| RR Shock +/-             | Adjustment |
| Power Steering +/-       | Adjustment |

**Type:** +/- (component selector)

---

## Main Action 27: Setup - Aero

Aerodynamic adjustments.

| Sub-Action          | Notes      |
| ------------------- | ---------- |
| Front Wing +/-      | Adjustment |
| Rear Wing +/-       | Adjustment |
| Qualifying Tape +/- | Adjustment |
| RF Brake Attached   | Toggle     |

**Type:** +/- or Toggle (aero component selector)

---

## Main Action 28: Setup - Hybrid

Hybrid/ERS system adjustments.

| Sub-Action             | Notes      |
| ---------------------- | ---------- |
| MGU-K Re-Gen Gain +/-  | Adjustment |
| MGU-K Deploy Mode +/-  | Adjustment |
| MGU-K Fixed Deploy +/- | Adjustment |
| HYS Boost              | Hold       |
| HYS Regen              | Hold       |
| HYS No Boost           | Toggle     |

**Type:** +/-, Toggle, or Hold (hybrid setting selector)

---

## Summary

| #   | Main Action                 | Sub-Actions | Primary Type  | Category          |
| --- | --------------------------- | ----------- | ------------- | ----------------- |
| 1   | Black Box Selector          | 13          | Multi-toggle  | Core Racing       |
| 2   | Splits Delta Cycle          | 2           | +/-           | Core Racing       |
| 3   | Toggle UI Elements          | 9           | Toggle        | Core Racing       |
| 4   | Car Control                 | 5           | Button/Toggle | Core Racing       |
| 5   | Look Direction              | 4           | Multi-toggle  | Core Racing       |
| 6   | View Adjustment             | 9           | +/-           | Core Racing       |
| 7   | Cockpit Misc                | 7           | Mixed         | Core Racing       |
| 8   | Pit Quick Actions           | 3           | Button/Toggle | Pit Service       |
| 9   | Fuel Service                | 7           | Mixed         | Pit Service       |
| 10  | Tire Service                | 7           | Configurable  | Pit Service       |
| 11  | Chat                        | 7           | Mixed         | Communication     |
| 12  | Audio Controls              | 8           | +/-/Toggle    | Communication     |
| 13  | Replay Transport            | 8           | Button        | Replay            |
| 14  | Replay Speed                | 1           | Adjustment    | Replay            |
| 15  | Replay Navigation           | 11          | Button/Config | Replay            |
| 16  | Camera Cycle                | 8           | +/-           | Camera            |
| 17  | Camera Focus                | 7           | Button/Config | Camera            |
| 18  | Camera Editor - Adjustments | 15          | +/-           | Camera            |
| 19  | Camera Editor - Controls    | 30          | Button/Toggle | Camera            |
| 20  | Media Capture               | 7           | Button/Toggle | Media & Telemetry |
| 21  | Telemetry Control           | 4           | Button/Toggle | Media & Telemetry |
| 22  | Setup - Brakes              | 7           | Toggle/+/-    | Car Setup         |
| 23  | Setup - Engine              | 4           | +/-           | Car Setup         |
| 24  | Setup - Fuel                | 5           | Mixed         | Car Setup         |
| 25  | Setup - Traction            | 5           | Toggle/+/-    | Car Setup         |
| 26  | Setup - Chassis             | 13          | +/-           | Car Setup         |
| 27  | Setup - Aero                | 4           | +/-/Toggle    | Car Setup         |
| 28  | Setup - Hybrid              | 6           | Mixed         | Car Setup         |

**Total: 28 main actions containing 196 sub-actions**

**Remaining slots: 4 actions available for future expansion**

---

## Notes

- All keyboard shortcuts are user-configurable via Property Inspector
- Sub-actions are selected via dropdown in the Property Inspector
- For +/- actions, direction is set via a second dropdown (Increase/Decrease or Next/Previous)
- Actions marked "SDK" use iRacing SDK commands (preferred over keyboard shortcuts)
- Camera Editor actions are specialized for broadcasters/content creators
- The unified plugin UUID would be `com.iracedeck.sd`
