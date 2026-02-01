# Stream Deck Plugin Core — Action Planning

All planned actions will be built into the existing `@iracedeck/stream-deck-plugin-core` package (`com.iracedeck.sd.core`). The plugin supports up to 32 main actions, each containing multiple sub-actions selectable via Property Inspector dropdown.

**Benefits of consolidating into one plugin:**

- Single plugin to install/maintain
- Simpler user experience
- Reduced manifest complexity
- Shared global settings across all actions

---

## Long-Press Modes

Each sub-action specifies a long-press behavior that determines what happens when the Stream Deck button is held down:

| Mode           | Behavior                                                                                                                                                                                                                          | Implementation                                                                                                               | Example                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **None**       | Sends a single action (key tap or SDK command) regardless of how long the button is held. The key is pressed and immediately released on button down; holding the Stream Deck button has no additional effect.                    | Implemented. See `black-box-selector.ts` — `onKeyDown` calls `sendKeyCombination()` (tap).                                   | Black Box Selector, Toggle UI Elements |
| **Long press** | Holds the key down when the Stream Deck button is pressed, and releases it when the button is released. The action is active for the entire duration of the press.                                                                | Implemented. See `look-direction.ts` — `onKeyDown` calls `pressKeyCombination()`, `onKeyUp` calls `releaseKeyCombination()`. | Look Direction, Starter                |
| **Repeat**     | Sends a single action immediately on button down, waits 500 ms, then repeats the action every 250 ms until the Stream Deck button is released. Useful for incremental adjustments where holding the button should keep adjusting. | Not yet implemented.                                                                                                         | FOV Adjust, Volume +/-                 |

---

# Core Racing Actions

## Main Action 1: Black Box Selector

Opens a specific black box or cycles through them.

| Sub-Action           | Default Key      | iRacing Setting | Long-Press | Notes |
| -------------------- | ---------------- | --------------- | ---------- | ----- |
| Lap Timing           | F1               | -               | None       | -     |
| Standings            | F2               | -               | None       | -     |
| Relative             | F3               | -               | None       | -     |
| Fuel                 | F4               | -               | None       | -     |
| Tires                | F5               | -               | None       | -     |
| Tire Info            | F6               | -               | None       | -     |
| Pit Stop Adjustments | F7               | -               | None       | -     |
| In-Car Adjustments   | F8               | -               | None       | -     |
| Mirror Adjustments   | F9               | -               | None       | -     |
| Radio Adjustments    | F10              | -               | None       | -     |
| Graphics Adjustments | F11              | -               | None       | -     |
| Cycle Next           | _(configurable)_ | -               | None       | -     |
| Cycle Previous       | _(configurable)_ | -               | None       | -     |

**Type:** Multi-toggle with mode selector (Direct/Next/Previous)

---

## Main Action 2: Splits Delta Cycle

Cycles through split/delta display modes.

| Sub-Action | Default Key | iRacing Setting | Long-Press | Notes |
| ---------- | ----------- | --------------- | ---------- | ----- |
| Next       | TAB         | -               | None       | -     |
| Previous   | Shift+TAB   | -               | None       | -     |

**Type:** +/- (direction selector)

---

## Main Action 3: Toggle UI Elements

Toggles various UI display elements on/off.

| Sub-Action            | Default Key | iRacing Setting | Long-Press | Notes |
| --------------------- | ----------- | --------------- | ---------- | ----- |
| Dash Box              | D           | -               | None       | -     |
| Speed/Gear/Pedals     | P           | -               | None       | -     |
| Radio Display         | O           | -               | None       | -     |
| FPS/Network Display   | F           | -               | None       | -     |
| Weather Radar         | Shift+Alt+R | -               | None       | -     |
| Virtual Mirror        | Alt+M       | -               | None       | -     |
| UI Edit Mode          | Alt+K       | -               | None       | -     |
| Display Reference Car | Ctrl+C      | -               | None       | -     |
| Replay UI Visibility  | _(SDK)_     | SDK             | None       | -     |

**Type:** Toggle (item selector dropdown)

---

## Main Action 4: Car Control

Core car operation controls.

| Sub-Action         | Default Key | iRacing Setting | Long-Press | Notes                |
| ------------------ | ----------- | --------------- | ---------- | -------------------- |
| Starter            | S           | -               | Long press | Hold to crank engine |
| Ignition           | I           | -               | None       | -                    |
| Pit Speed Limiter  | A           | -               | None       | -                    |
| Enter/Exit/Tow Car | Shift+R     | -               | None       | -                    |
| Pause Sim          | Shift+P     | -               | None       | -                    |

**Type:** Button/Toggle (item selector dropdown)

---

## Main Action 5: Look Direction

Changes driver view direction.

| Sub-Action | Default Key | iRacing Setting | Long-Press | Notes        |
| ---------- | ----------- | --------------- | ---------- | ------------ |
| Look Left  | Z           | -               | Long press | Hold to look |
| Look Right | X           | -               | Long press | Hold to look |
| Look Up    | ↑           | -               | Long press | Hold to look |
| Look Down  | ↓           | -               | Long press | Hold to look |

**Type:** Multi-toggle (direction selector)

---

## Main Action 6: View Adjustment

Camera/view position adjustments.

| Sub-Action         | Default Key   | iRacing Setting | Long-Press | Notes |
| ------------------ | ------------- | --------------- | ---------- | ----- |
| FOV Increase       | ]             | -               | Repeat     | -     |
| FOV Decrease       | [             | -               | Repeat     | -     |
| Horizon Up         | Shift+]       | -               | Repeat     | -     |
| Horizon Down       | Shift+[       | -               | Repeat     | -     |
| Driver Height Up   | Ctrl+]        | -               | Repeat     | -     |
| Driver Height Down | Ctrl+[        | -               | Repeat     | -     |
| Recenter VR        | ;             | -               | None       | -     |
| UI Size Increase   | Ctrl+PageUp   | -               | Repeat     | -     |
| UI Size Decrease   | Ctrl+PageDown | -               | Repeat     | -     |

**Type:** +/- or Button (item + direction selector)

---

## Main Action 7: Cockpit Misc

Miscellaneous cockpit controls including dashboard settings.

| Sub-Action             | Default Key | iRacing Setting | Long-Press | Notes |
| ---------------------- | ----------- | --------------- | ---------- | ----- |
| Trigger Wipers         | Ctrl+Alt+W  | -               | None       | -     |
| FFB Max Force Increase | _(SDK)_     | SDK             | Repeat     | -     |
| FFB Max Force Decrease | _(SDK)_     | SDK             | Repeat     | -     |
| Report Latency         | L           | -               | None       | -     |
| Dash Page 1 +/-        | -           | Adjustment      | Repeat     | -     |
| Dash Page 2 +/-        | -           | Adjustment      | Repeat     | -     |
| In Lap Mode Toggle     | Shift+Alt+L | -               | None       | -     |

**Type:** Button or +/- (item selector)

---

# Pit Service Actions

## Main Action 8: Pit Quick Actions

Quick pit stop toggles (no adjustment values).

| Sub-Action           | Default Key | iRacing Setting | Long-Press | Notes |
| -------------------- | ----------- | --------------- | ---------- | ----- |
| Clear All Checkboxes | _(SDK)_     | SDK             | None       | -     |
| Windshield Tearoff   | _(SDK)_     | SDK             | None       | -     |
| Request Fast Repair  | _(SDK)_     | SDK             | None       | -     |

**Type:** Button/Toggle (item selector)

---

## Main Action 9: Fuel Service

Complete fuel management for pit stops and autofuel.

| Sub-Action          | Default Key  | iRacing Setting | Long-Press | Notes         |
| ------------------- | ------------ | --------------- | ---------- | ------------- |
| Add Fuel            | -            | SDK             | Repeat     | Adjust amount |
| Reduce Fuel         | -            | SDK             | Repeat     | Adjust amount |
| Set Fuel Amount     | -            | SDK             | None       | Direct value  |
| Clear Fuel Checkbox | _(SDK)_      | SDK             | None       | -             |
| Toggle Autofuel     | Shift+Ctrl+A | -               | None       | -             |
| Increase Lap Margin | Shift+Alt+X  | -               | Repeat     | -             |
| Decrease Lap Margin | Shift+Alt+S  | -               | Repeat     | -             |

**Type:** Adjustment/Toggle (+/- or value input)
**SDK Support:** Partial (pit commands via SDK, autofuel via keyboard)

---

## Main Action 10: Tire Service

Tire request, compound, and clear management.

| Sub-Action           | Default Key | iRacing Setting | Long-Press | Notes |
| -------------------- | ----------- | --------------- | ---------- | ----- |
| Request LF           | _(SDK)_     | SDK             | None       | -     |
| Request RF           | _(SDK)_     | SDK             | None       | -     |
| Request LR           | _(SDK)_     | SDK             | None       | -     |
| Request RR           | _(SDK)_     | SDK             | None       | -     |
| Request All          | _(SDK)_     | SDK             | None       | -     |
| Change Compound      | _(SDK)_     | SDK             | None       | -     |
| Clear Tires Checkbox | _(SDK)_     | SDK             | None       | -     |

**Type:** Configurable (tire selector checkboxes + compound dropdown)
**SDK Support:** Yes

---

# Communication Actions

## Main Action 11: Chat

All text chat operations, messages, and macros.

| Sub-Action         | Default Key | iRacing Setting | Long-Press | Notes               |
| ------------------ | ----------- | --------------- | ---------- | ------------------- |
| Open Chat          | T           | SDK             | None       | -                   |
| Reply to Chat      | R           | SDK             | None       | -                   |
| Whisper            | / [num]     | -               | None       | -                   |
| Respond to Last PM | /r          | SDK             | None       | -                   |
| Cancel Chat        | _(SDK)_     | SDK             | None       | -                   |
| Send Message       | -           | SDK             | None       | Configurable text   |
| Macro (1-15)       | -           | SDK             | None       | Select number in PI |

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

| Sub-Action             | Default Key             | iRacing Setting | Long-Press | Notes |
| ---------------------- | ----------------------- | --------------- | ---------- | ----- |
| Spotter Volume Up      | Shift+Ctrl+NUMPAD +     | -               | Repeat     | -     |
| Spotter Volume Down    | Shift+Ctrl+NUMPAD -     | -               | Repeat     | -     |
| Spotter Silence        | Shift+Ctrl+M            | -               | None       | -     |
| Voice Chat Volume Up   | Shift+Ctrl+Alt+NUMPAD + | -               | Repeat     | -     |
| Voice Chat Volume Down | Shift+Ctrl+Alt+NUMPAD - | -               | Repeat     | -     |
| Voice Chat Mute        | Shift+Ctrl+Alt+M        | -               | None       | -     |
| Master Volume Increase | Shift+Alt+NUMPAD +      | -               | Repeat     | -     |
| Master Volume Decrease | Shift+Alt+NUMPAD -      | -               | Repeat     | -     |

**Type:** +/- or Toggle (category + action selector)

---

# Replay Actions

## Main Action 13: Replay Transport

Playback control for replays.

| Sub-Action     | Default Key    | iRacing Setting | Long-Press | Notes |
| -------------- | -------------- | --------------- | ---------- | ----- |
| Play           | _(SDK)_        | SDK             | None       | -     |
| Pause          | _(SDK)_        | SDK             | None       | -     |
| Stop           | NUMPAD .       | SDK             | None       | -     |
| Fast Forward   | Shift+NUMPAD 6 | SDK             | None       | -     |
| Rewind         | Shift+NUMPAD 4 | SDK             | None       | -     |
| Slow Motion    | NUMPAD 8       | SDK             | None       | -     |
| Frame Forward  | NUMPAD 6       | SDK             | Repeat     | -     |
| Frame Backward | NUMPAD 4       | SDK             | Repeat     | -     |

**Type:** Button (transport action selector)

---

## Main Action 14: Replay Speed

Set replay playback speed.

| Sub-Action  | Default Key | iRacing Setting | Long-Press | Notes          |
| ----------- | ----------- | --------------- | ---------- | -------------- |
| Speed Value | _(SDK)_     | SDK             | Repeat     | SDK adjustment |

**Type:** Adjustment
**SDK Support:** Yes

---

## Main Action 15: Replay Navigation

Jump to specific points in replay.

| Sub-Action          | Default Key    | iRacing Setting | Long-Press | Notes        |
| ------------------- | -------------- | --------------- | ---------- | ------------ |
| Next Session        | Ctrl+NUMPAD 6  | SDK             | None       | -            |
| Previous Session    | Ctrl+NUMPAD 4  | SDK             | None       | -            |
| Next Lap            | Shift+NUMPAD 3 | SDK             | None       | -            |
| Previous Lap        | Shift+NUMPAD 1 | SDK             | None       | -            |
| Next Incident       | Ctrl+NUMPAD 3  | SDK             | None       | -            |
| Previous Incident   | Ctrl+NUMPAD 1  | SDK             | None       | -            |
| Jump to Start       | NUMPAD 7       | SDK             | None       | -            |
| Jump to End         | NUMPAD 1       | SDK             | None       | -            |
| Set Play Position   | _(SDK)_        | SDK             | None       | Configurable |
| Search Session Time | _(SDK)_        | SDK             | None       | Configurable |
| Erase Tape          | _(SDK)_        | SDK             | None       | -            |

**Type:** Button/Configurable (navigation action selector)

---

# Camera Actions

## Main Action 16: Camera Cycle

Cycle through cameras and cars.

| Sub-Action              | Default Key | iRacing Setting | Long-Press | Notes |
| ----------------------- | ----------- | --------------- | ---------- | ----- |
| Next Camera             | C           | SDK             | None       | -     |
| Previous Camera         | Shift+C     | SDK             | None       | -     |
| Next Sub-Camera         | B           | SDK             | None       | -     |
| Previous Sub-Camera     | Shift+B     | SDK             | None       | -     |
| Next Car                | V           | SDK             | None       | -     |
| Previous Car            | Shift+V     | SDK             | None       | -     |
| Next Driving Camera     | PageDown    | SDK             | None       | -     |
| Previous Driving Camera | PageUp      | SDK             | None       | -     |

**Type:** +/- (camera type + direction selector)

---

## Main Action 17: Camera Focus

Focus camera on specific target.

| Sub-Action            | Default Key | iRacing Setting | Long-Press | Notes        |
| --------------------- | ----------- | --------------- | ---------- | ------------ |
| Focus Your Car        | Ctrl+V      | SDK             | None       | -            |
| Focus on Leader       | _(SDK)_     | SDK             | None       | -            |
| Focus on Incident     | _(SDK)_     | SDK             | None       | -            |
| Focus on Exiting Cars | _(SDK)_     | SDK             | None       | -            |
| Switch by Position    | _(SDK)_     | SDK             | None       | Configurable |
| Switch by Car Number  | _(SDK)_     | SDK             | None       | Configurable |
| Set Camera State      | _(SDK)_     | SDK             | None       | Configurable |

**Type:** Button/Configurable (focus target selector)

---

## Main Action 18: Camera Editor - Adjustments

Camera position and view editing (for broadcasters).

| Sub-Action         | Default Key     | iRacing Setting | Long-Press | Notes |
| ------------------ | --------------- | --------------- | ---------- | ----- |
| Latitude +/-       | D / A           | -               | Repeat     | -     |
| Longitude +/-      | S / W           | -               | Repeat     | -     |
| Altitude +/-       | Alt+S / Alt+W   | -               | Repeat     | -     |
| Yaw +/-            | Ctrl+D / Ctrl+A | -               | Repeat     | -     |
| Pitch +/-          | Ctrl+W / Ctrl+S | -               | Repeat     | -     |
| FOV Zoom +/-       | [ / ]           | -               | Repeat     | -     |
| Key Step +/-       | - / =           | -               | Repeat     | -     |
| VanishX +/-        | Alt+X / Ctrl+X  | -               | Repeat     | -     |
| VanishY +/-        | Alt+Y / Ctrl+Y  | -               | Repeat     | -     |
| Blimp Radius +/-   | Ctrl+H / Ctrl+G | -               | Repeat     | -     |
| Blimp Velocity +/- | Alt+H / Alt+G   | -               | Repeat     | -     |
| Mic Gain +/-       | Alt+Up/Down     | -               | Repeat     | -     |
| Auto Set Mic Gain  | Ctrl+Alt+Down   | -               | None       | -     |
| F-number +/-       | Alt+U / Alt+I   | -               | Repeat     | -     |
| Focus Depth +/-    | Ctrl+U / Ctrl+I | -               | Repeat     | -     |

**Type:** +/- or Button (adjustment selector)

---

## Main Action 19: Camera Editor - Controls

Camera editor toggles and management (for broadcasters).

| Sub-Action              | Default Key       | iRacing Setting | Long-Press | Notes |
| ----------------------- | ----------------- | --------------- | ---------- | ----- |
| Open Camera Tool        | Ctrl+F12          | -               | None       | -     |
| Key Acceleration Toggle | Ctrl+P            | -               | None       | -     |
| Key 10x Toggle          | Alt+P             | -               | None       | -     |
| Parabolic Mic Toggle    | Ctrl+O            | -               | None       | -     |
| Cycle Position Type     | Alt+N             | -               | None       | -     |
| Cycle Aim Type          | Alt+M             | -               | None       | -     |
| Acquire Start           | Ctrl+Q            | -               | None       | -     |
| Acquire End             | Shift+Q           | -               | None       | -     |
| Temporary Edits Toggle  | Ctrl+L            | -               | None       | -     |
| Dampening Toggle        | Ctrl+N            | -               | None       | -     |
| Zoom Toggle             | Ctrl+M            | -               | None       | -     |
| Beyond Fence Toggle     | Ctrl+B            | -               | None       | -     |
| In Cockpit Toggle       | Alt+B             | -               | None       | -     |
| Mouse Navigation Toggle | Ctrl+Z            | -               | None       | -     |
| Pitch Gyro Toggle       | Ctrl+J            | -               | None       | -     |
| Roll Gyro Toggle        | Alt+J             | -               | None       | -     |
| Limit Shot Range Toggle | Alt+O             | -               | None       | -     |
| Show Camera Toggle      | Alt+Q             | -               | None       | -     |
| Shot Selection Toggle   | Ctrl+T            | -               | None       | -     |
| Manual Focus Toggle     | Ctrl+F            | -               | None       | -     |
| Insert Camera           | Shift+Ctrl+Insert | -               | None       | -     |
| Remove Camera           | Shift+Ctrl+Delete | -               | None       | -     |
| Copy Camera             | Shift+Ctrl+C      | -               | None       | -     |
| Paste Camera            | Shift+Ctrl+V      | -               | None       | -     |
| Copy Group              | Ctrl+Alt+C        | -               | None       | -     |
| Paste Group             | Ctrl+Alt+V        | -               | None       | -     |
| Save Track Camera       | Ctrl+F11          | -               | None       | -     |
| Load Track Camera       | Shift+Ctrl+F11    | -               | None       | -     |
| Save Car Camera         | Alt+F11           | -               | None       | -     |
| Load Car Camera         | Shift+Alt+F11     | -               | None       | -     |

**Type:** Button/Toggle (action selector)

---

# Media & Telemetry Actions

## Main Action 20: Media Capture

Video and screenshot functions.

| Sub-Action            | Default Key       | iRacing Setting | Long-Press | Notes        |
| --------------------- | ----------------- | --------------- | ---------- | ------------ |
| Start/Stop Video      | Ctrl+Alt+Shift+V  | SDK             | None       | -            |
| Video Timer           | Alt+V             | SDK             | None       | -            |
| Toggle Video Capture  | _(SDK)_           | SDK             | None       | -            |
| Take Screenshot       | Ctrl+Alt+Shift+S  | SDK             | None       | -            |
| Take Giant Screenshot | Ctrl+Shift+PrtScn | -               | None       | -            |
| Reload All Textures   | Ctrl+R            | SDK             | None       | -            |
| Reload Car Textures   | _(SDK)_           | SDK             | None       | Configurable |

**Type:** Button/Toggle (capture action selector)

---

## Main Action 21: Telemetry Control

Telemetry logging and recording.

| Sub-Action        | Default Key | iRacing Setting | Long-Press | Notes |
| ----------------- | ----------- | --------------- | ---------- | ----- |
| Toggle Logging    | Alt+L       | SDK             | None       | -     |
| Mark Event        | M           | -               | None       | -     |
| Toggle Recording  | _(SDK)_     | SDK             | None       | -     |
| Restart Recording | _(SDK)_     | SDK             | None       | -     |

**Type:** Button/Toggle (telemetry action selector)

---

# Car Setup Actions

## Main Action 22: Setup - Brakes

Brake-related car adjustments.

| Sub-Action          | Default Key | iRacing Setting | Long-Press | Notes |
| ------------------- | ----------- | --------------- | ---------- | ----- |
| ABS Toggle          | -           | -               | None       | -     |
| ABS Adjust +/-      | -           | Adjustment      | Repeat     | -     |
| Brake Bias +/-      | - / =       | -               | Repeat     | -     |
| Brake Bias Fine +/- | -           | Adjustment      | Repeat     | -     |
| Peak Brake Bias +/- | -           | Adjustment      | Repeat     | -     |
| Brake Misc +/-      | -           | Adjustment      | Repeat     | -     |
| Engine Braking +/-  | -           | Adjustment      | Repeat     | -     |

**Type:** Toggle or +/- (setting + direction selector)

---

## Main Action 23: Setup - Engine

Engine power and throttle adjustments.

| Sub-Action           | Default Key | iRacing Setting | Long-Press | Notes |
| -------------------- | ----------- | --------------- | ---------- | ----- |
| Engine Power +/-     | -           | Adjustment      | Repeat     | -     |
| Throttle Shaping +/- | -           | Adjustment      | Repeat     | -     |
| Boost Level +/-      | -           | Adjustment      | Repeat     | -     |
| Launch RPM +/-       | -           | Adjustment      | Repeat     | -     |

**Type:** +/- (setting selector)

---

## Main Action 24: Setup - Fuel

Fuel mixture and cut adjustments (in-car setup, not pit service).

| Sub-Action            | Default Key | iRacing Setting | Long-Press | Notes |
| --------------------- | ----------- | --------------- | ---------- | ----- |
| Fuel Mixture +/-      | -           | Adjustment      | Repeat     | -     |
| Fuel Cut Position +/- | -           | Adjustment      | Repeat     | -     |
| Disable Fuel Cut      | -           | -               | None       | -     |
| Low Fuel Accept       | -           | -               | None       | -     |
| FCY Mode Toggle       | -           | -               | None       | -     |

**Type:** Toggle/Button or +/- (setting selector)

---

## Main Action 25: Setup - Traction

Traction control adjustments.

| Sub-Action    | Default Key | iRacing Setting | Long-Press | Notes |
| ------------- | ----------- | --------------- | ---------- | ----- |
| TC Toggle     | -           | -               | None       | -     |
| TC Slot 1 +/- | -           | Adjustment      | Repeat     | -     |
| TC Slot 2 +/- | -           | Adjustment      | Repeat     | -     |
| TC Slot 3 +/- | -           | Adjustment      | Repeat     | -     |
| TC Slot 4 +/- | -           | Adjustment      | Repeat     | -     |

**Type:** Toggle or +/- (TC slot selector)

---

## Main Action 26: Setup - Chassis

Suspension and handling adjustments.

| Sub-Action               | Default Key | iRacing Setting | Long-Press | Notes |
| ------------------------ | ----------- | --------------- | ---------- | ----- |
| Differential Preload +/- | -           | Adjustment      | Repeat     | -     |
| Differential Entry +/-   | -           | Adjustment      | Repeat     | -     |
| Differential Middle +/-  | -           | Adjustment      | Repeat     | -     |
| Differential Exit +/-    | -           | Adjustment      | Repeat     | -     |
| Front ARB +/-            | -           | Adjustment      | Repeat     | -     |
| Rear ARB +/-             | -           | Adjustment      | Repeat     | -     |
| Left Spring +/-          | -           | Adjustment      | Repeat     | -     |
| Right Spring +/-         | -           | Adjustment      | Repeat     | -     |
| LF Shock +/-             | -           | Adjustment      | Repeat     | -     |
| RF Shock +/-             | -           | Adjustment      | Repeat     | -     |
| LR Shock +/-             | -           | Adjustment      | Repeat     | -     |
| RR Shock +/-             | -           | Adjustment      | Repeat     | -     |
| Power Steering +/-       | -           | Adjustment      | Repeat     | -     |

**Type:** +/- (component selector)

---

## Main Action 27: Setup - Aero

Aerodynamic adjustments.

| Sub-Action          | Default Key | iRacing Setting | Long-Press | Notes |
| ------------------- | ----------- | --------------- | ---------- | ----- |
| Front Wing +/-      | -           | Adjustment      | Repeat     | -     |
| Rear Wing +/-       | -           | Adjustment      | Repeat     | -     |
| Qualifying Tape +/- | -           | Adjustment      | Repeat     | -     |
| RF Brake Attached   | -           | -               | None       | -     |

**Type:** +/- or Toggle (aero component selector)

---

## Main Action 28: Setup - Hybrid

Hybrid/ERS system adjustments.

| Sub-Action             | Default Key | iRacing Setting | Long-Press | Notes         |
| ---------------------- | ----------- | --------------- | ---------- | ------------- |
| MGU-K Re-Gen Gain +/-  | -           | Adjustment      | Repeat     | -             |
| MGU-K Deploy Mode +/-  | -           | Adjustment      | Repeat     | -             |
| MGU-K Fixed Deploy +/- | -           | Adjustment      | Repeat     | -             |
| HYS Boost              | -           | -               | Long press | Hold to boost |
| HYS Regen              | -           | -               | Long press | Hold to regen |
| HYS No Boost           | -           | -               | None       | -             |

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
- All actions use the plugin UUID `com.iracedeck.sd.core`
- Long-press behavior is specified per sub-action; see the [Long-Press Modes](#long-press-modes) section for definitions
