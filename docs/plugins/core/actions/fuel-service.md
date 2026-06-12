# Fuel Service

Manages fuel pit stop settings: toggle fueling, add/reduce/set fuel amounts, clear fuel, toggle autofuel, and adjust lap margins.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.fuel-service` |
| Type | Multi-toggle |
| SDK Support | Yes (toggle, clear) / No (macros, keyboard modes) |
| Communication Method | iRacing API (varies by mode — see note) |
| Encoder Support | No |

> **Communication method by mode:** Toggle Fuel Fill and Clear Fuel Checkbox use the **iRacing API**; Add Fuel, Reduce Fuel, and Set Fuel Amount use **Chat command** (`#fuel` macros); Toggle Autofuel and Lap Margin Increase/Decrease use **Key binding**.

## Behavior

### Button Press
- **Toggle Fuel Fill**: Toggles the "Begin Fueling" pit service checkbox (SDK)
- **Add Fuel**: Sends `#fuel +<amount><unit>$` chat macro to add fuel
- **Reduce Fuel**: Sends `#fuel -<amount><unit>$` chat macro to reduce fuel
- **Set Fuel Amount**: Sends `#fuel <amount><unit>$` chat macro to set fuel
- **Clear Fuel Checkbox**: Clears the fuel fill checkbox (SDK)
- **Toggle Autofuel**: Toggles autofuel via keyboard binding
- **Lap Margin Increase/Decrease**: Adjusts autofuel lap margin via keyboard binding

### Long-Press (Add/Reduce only)
Holding the button repeats the action every 250ms.

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Mode | Dropdown | Toggle Fuel Fill | Fuel service operation mode |
| Amount | Number | 1 | Fuel amount (macro modes only) |
| Unit | Dropdown | Liters | Fuel unit: Liters, Gallons, Kilograms |

### Mode Options
- **Toggle Fuel Fill** - Toggles the "Begin Fueling" checkbox on/off
- **Add Fuel** - Adds the specified amount of fuel
- **Reduce Fuel** - Reduces fuel by the specified amount
- **Set Fuel Amount** - Sets fuel to the specified amount
- **Clear Fuel Checkbox** - Clears the fuel fill checkbox
- **Toggle Autofuel** - Toggles the autofuel setting
- **Lap Margin Increase** - Increases the autofuel lap margin
- **Lap Margin Decrease** - Decreases the autofuel lap margin

## Global Settings

### Auto-Enable Fueling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Enable fuel fill when changing amount | Checkbox | Checked | Controls whether changing fuel amount auto-enables the "Begin Fueling" checkbox |

When **checked** (default): Fuel macros use `#fuel` prefix, which sets the amount and enables the fueling checkbox (standard iRacing behavior).

When **unchecked**: The action preserves the current fueling state:
- If "Begin Fueling" is **currently off** → uses `#-fuel` prefix (amount changes without enabling fueling)
- If "Begin Fueling" is **currently on** → uses `#fuel` prefix (keeps it enabled)

This setting appears in the PI for: Add Fuel, Reduce Fuel, Set Fuel Amount, Lap Margin Increase, and Lap Margin Decrease modes.

### Keyboard Bindings

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Toggle Autofuel | *(none)* | Toggle Autofuel |
| Lap Margin Increase | *(none)* | Increase Lap Margin |
| Lap Margin Decrease | *(none)* | Decrease Lap Margin |

## Icon States

| Mode | Icon |
|------|------|
| Toggle Fuel Fill (on) | Fuel icon with green "ON" status bar |
| Toggle Fuel Fill (off) | Fuel icon with red "OFF" status bar |
| Add Fuel | Green-accented icon with amount display |
| Reduce Fuel | Red-accented icon with amount display |
| Set Fuel Amount | Yellow-accented icon with amount display |
| Clear Fuel | Static "CLEAR FUEL" icon |
| Toggle Autofuel (on) | "AUTO FUEL" title with fuel amount and green "ON" status bar |
| Toggle Autofuel (off) | "AUTO FUEL" title with fuel amount and red "OFF" status bar |
| Toggle Autofuel (n/a) | "AUTO FUEL" title with fuel amount and gray "N/A" status bar (autofuel system not available for this car/series) |
| Lap Margin +/- | Static "INCREASE/DECREASE LAP MARGIN" icon |
