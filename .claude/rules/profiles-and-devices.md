---
paths:
  - "packages/deck-core/src/device-profiles.ts"
  - "packages/deck-core/src/device-profiles.test.ts"
  - "packages/iracing-plugin-stream-deck/**"
---

# Profiles & Devices

How iRaceDeck ships **Stream Deck profiles** and what it knows about each **device**. Profiles are an **Elgato-only** feature (Mirabox/Ulanzi have no equivalent), so everything here applies to `@iracedeck/iracing-plugin-stream-deck` only. Introduced by issue #736; the dynamic Race Admin selector (#732) builds on it.

## Canonical source of truth

Device specs and iRaceDeck's support policy live in **`packages/deck-core/src/device-profiles.ts`** — read and update it there, never re-derive device facts inline. It exports the `DeviceType` enum, `DEVICE_SPECS`, `DEVICE_SUPPORT`, the `PROFILE_*` constants, and the lookup helpers (`getDeviceSpec`, `getDeviceSupport`, `isDeviceSupported`, `shipsBundledProfiles`). This rule documents the **policy and the profile-file format**; the module documents the **data**. Keep the two in sync (a freshness-style invariant test guards `columns × rows === keys` and the target/`PROFILE_TARGET_DEVICES` cross-check).

## Device types (Elgato SDK `DeviceType`)

The manifest `Profiles[].DeviceType` field and the runtime `device.type` use these ids:

| ID | Device | Keys | Grid (cols×rows) | Dials | Touch |
|----|--------|------|------------------|-------|-------|
| 0 | Stream Deck / Scissor Keys | 15 | 5×3 | — | — |
| 1 | Stream Deck Mini | 6 | 3×2 | — | — |
| 2 | Stream Deck XL | 32 | 8×4 | — | — |
| 3 | Stream Deck Mobile | ≤64 | variable | — | — |
| 4 | Corsair G-Keys | 6 | — | — | — |
| 5 | Stream Deck Pedal | 3 | 1×3 | — | — |
| 6 | Corsair Voyager | ≤10 | — | — | — |
| 7 | Stream Deck + | 8 | 4×2 | 4 | touch strip |
| 8 | SCUF Controller | 5 | — | — | — |
| 9 | Stream Deck Neo | 8 | 4×2 | — | 2 touch points |
| 10 | Stream Deck Studio | 32 | 8×4 | 2 | — |
| 11 | Virtual Stream Deck | — | — | — | — |
| 12 | Galleon 100 SD | 12 | — | 2 | LCD |
| 13 | Stream Deck + XL | 36 | 6×6 | 6 | touch strip |

## iRaceDeck support matrix

`DEVICE_SUPPORT` encodes two axes (decisions from #736):

- **`controls`** — `keys-and-dials` (Stream Deck +, Studio, Galleon, + XL), `keys` (Stream Deck, Mini, XL, Mobile, Neo — Neo's touch points are **not** supported), or `unsupported` (Corsair G-Keys, Stream Deck Pedal, Corsair Voyager, SCUF Controller).
- **`profileTemplates`** — `target` (the three devices we ship templates for: Stream Deck `0`, XL `2`, + XL `13`), `candidate` (supported decks eligible later: Mini, Stream Deck +, Neo, Galleon), or `excluded` (unsupported devices, plus the deliberate skips **Studio** and **Mobile**, and the **Virtual** testing device).

`PROFILE_TARGET_DEVICES` is the ordered `target` list. When a device graduates from `candidate` to `target`, update `DEVICE_SUPPORT` **and** `PROFILE_TARGET_DEVICES` together (the test enforces they match).

## The three bundled templates

`PROFILE_NAMES`: **iRaceDeck Default**, **iRaceDeck Pit Actions**, **iRaceDeck Replay**. Each target device needs its **own** profile file (one `Profiles[]` entry carries exactly one `DeviceType`), so the full set is 3 templates × 3 devices.

## Manifest registration — `Profiles[]`

Add to `com.iracedeck.sd.core.sdPlugin/manifest.json`:

```json
"Profiles": [
  {
    "Name": "iRaceDeck Default",
    "DeviceType": 2,
    "AutoInstall": true,
    "DontAutoSwitchWhenInstalled": false,
    "Readonly": false
  }
]
```

- **`Name`** (required) — path to the `.streamDeckProfile` **with the extension omitted**, relative to `manifest.json`. Subfolders are allowed (`assets/main-profile`). iRaceDeck places files at the plugin root, so `Name` is just the file's base name.
- **`DeviceType`** (required) — **must match the device the profile was authored on.** An 8×4 (XL) profile registered as `DeviceType: 0` is broken. Verify the layout's grid against the table above.
- **`AutoInstall`** (default `true`), **`DontAutoSwitchWhenInstalled`** (default `false`), **`Readonly`** (default `false`).

## Authoring workflow (the only supported way)

A `.streamDeckProfile` is **authored in the Stream Deck app and exported** — there is no code path that generates one, and you must not hand-edit the bundle (see format below).

1. In the Stream Deck app, build the layout on (or for) the **exact target device** — the grid and dial count must match that `DeviceType`.
2. Give it a clean profile name (no `(dev)` / test suffixes — the internal name is what users see).
3. Right-click the profile → **Export** → `<Name>.streamDeckProfile`.
4. Drop the file next to `manifest.json` in `com.iracedeck.sd.core.sdPlugin/`.
5. Add the `Profiles[]` entry with the matching `DeviceType`.
6. **Validate in the app** — install the plugin build and confirm the profile imports and switches. This can't be unit-tested; it's a manual check.

## Distributed bundle format (reference only — never hand-edit)

Verified from a real exported iRaceDeck profile. A `.streamDeckProfile` is a **ZIP**:

```text
<Name>.streamDeckProfile                         (ZIP archive)
├── package.json                                 # distribution metadata
└── Profiles/<OUTER-UUID>.sdProfile/
    ├── manifest.json                            # outer profile manifest
    ├── Images/
    └── Profiles/<PAGE-UUID>/                    # one dir per page (and per folder/sub-page)
        ├── manifest.json                        # the page's buttons
        └── Images/*.png                         # rendered key images
```

- **`package.json`**: `AppVersion`, `DeviceModel`, `FormatVersion`, `OSType`/`OSVersion`, and `RequiredPlugins` (e.g. `com.iracedeck.sd.core` plus the built-in `com.elgato.streamdeck.profile.openchild` / `…backtoparent` when the profile uses folders).
- **Outer `manifest.json`**: `Device` `{ Model, UUID }` (the `UUID` is **regenerated on export**, not your hardware id), `Name` (the user-visible profile name), `Pages` `{ Current (zeroed on export), Default, Pages[] }`, `Version: "3.0"`.
- **Page `manifest.json`**: `Controllers: [{ Type: "Keypad", Actions: { "col,row": {…} } }]`. Buttons are keyed `"col,row"` (0-indexed); each carries `ActionID` (instance UUID), `UUID` (action type, e.g. `com.iracedeck.sd.core.tire-service`), `Plugin`, **`Settings`** (the action's own settings JSON — same shape as its Zod schema), `State`, and `States[]`.
- UUIDs are app-managed. **Reusing a profile/page UUID across plugin versions makes the app refuse the re-import** — always re-export rather than editing UUIDs by hand.

## Folder navigation (relevant to #732)

Multi-page navigation inside a profile uses **built-in Elgato actions**, not iRaceDeck actions:

- **`com.elgato.streamdeck.profile.openchild`** — enter a child folder page; its `Settings.ProfileUUID` is the child page's UUID.
- **`com.elgato.streamdeck.profile.backtoparent`** — return to the parent page.

These are exposed as `PROFILE_NAV_ACTIONS` in `device-profiles.ts`. Because child-page UUIDs are minted by the app, this navigation is authored in the app, not generated.

## Race Admin car selector (#732)

The dynamic Race Admin / RC car selector is **not** a new action — it's two additions to the existing **Race Admin** action (`packages/iracing-actions/src/actions/race-admin/`), plus two bundled profiles you author in the app:

- **`select-car` mode** — a placeholder key that auto-fills with one car from the live session (by grid position, spectators and pace car excluded) and, on press, stores that car as the shared admin target and switches to the per-car commands profile. Pure helpers (slot math, session→car, icon) live in `race-admin-selector.ts`; the dynamic big-number template is `packages/iracing-actions/icons/race-admin-car-selector.svg`.
- **`selected-car` driver target** — the 4th Driver Target on the command modes (alongside viewed-car / specific / type-in-chat). It reads the shared target and resolves it to the current session car number for the `!cmd #<number>` command and the key icon.
- **Shared state** — the selection is stored as a **`{ carIdx, carNumber }`** record in the internal passthrough global key **`_raceAdminSelectedCar`** (`SELECTED_CAR_KEY`), the same `_`-prefixed convention as `_warnings` / `_lastSeenVersion` (no `GlobalSettingsSchema` field). Written by `select-car`, read by `selected-car`. The number doubles as a **staleness guard**: CarIdx assignments are session-scoped while global settings persist, so `resolveSelectedCar` voids the selection when the stored CarIdx no longer resolves to the stored number (session changed) — never trust the bare CarIdx across sessions.

Both `select-car` and `selected-car` are gated to Elgato in the PI via the `profiles` platform feature flag (profiles are Elgato-only), and `requestProfileSwitch` is a no-op on other hosts anyway.

### Selector layout convention (baked into `computeCarSlotIndex`)

Every selector page reserves three keys and fills the rest with cars, row-major (left→right, top→bottom), sorted by car number (pace car excluded):

- **top-left** `(col 0, row 0)` — Back to default profile
- **bottom-left** `(col 0, row rows-1)` — Previous page
- **bottom-right** `(col cols-1, row rows-1)` — Next page

`carsPerPage = cols*rows − 3` (derived from the device grid via `getDeviceSpec`). The `select-car` key carries a 0-based **`selectorPage`** setting; the global field index is `selectorPage * carsPerPage + (row-major position − reserved-before)`. Keep the three reserved keys on every page so the car-slot count stays uniform. The Elgato `willAppear` payload exposes `coordinates` but **no page index**, which is why the page number is a per-key setting.

### The two bundled selector profiles

- **`iRaceDeck Race Admin Cars`** — the selector pages: Race Admin keys in `select-car` mode, plus the three nav keys per page.
- **`iRaceDeck Race Admin Per Car`** — the commands page: Race Admin command keys set to the `selected-car` target, plus Back/nav.

Both ship as XL (`DeviceType: 2`) bundles registered in `manifest.json` `Profiles[]` (with `DontAutoSwitchWhenInstalled: true`, like Replay) and regenerated into `profiles.json`, and are reached from `iRaceDeck Default` via a **Switch Profile** key. The Switch Profile action ships icons for both (`packages/icons/switch-profile/race-admin-cars.svg`, `race-admin-per-car.svg`) keyed by profile name in its `PROFILE_ICONS` map. The select-car PI's **Target Profile** is an `ird-profile-select` dropdown fed by a `_deviceProfiles` push from the Race Admin action (same pattern as Switch Profile); an empty selection falls back to `DEFAULT_SELECTOR_TARGET_PROFILE`.

## Switching profiles at runtime

Switching goes through the platform abstraction, not the Elgato SDK directly:

```typescript
adapter.switchToProfile(deviceId, "iRaceDeck Default", page); // IDeckPlatformAdapter
```

- Implemented by `ElgatoPlatformAdapter` via `streamDeck.profiles.switchToProfile(deviceId, profile?, page?)`. **Mirabox and Ulanzi implement it as a no-op** — their hosts have no profile system.
- The `profile` argument is the **profile name** matching `Profiles[].Name` — **there is no switch-by-UUID**, because install-time UUIDs are unknown to the plugin. Any cross-profile link (e.g. #732's Main → selector → per-car flow) must use the profile **name** + the built-in folder nav, never a hard-coded installed UUID.
- Omitting `profile` returns the device to its default profile; `page` optionally selects a page within the profile.
- A plugin can only switch to profiles **it ships**; it has no access to user-defined profiles.

## Installing / switching from the PI — the "Stream Deck Profiles" accordion

Bundled profiles do **not** reliably auto-install on plugin updates. The install path iRaceDeck relies on is: **switching to a profile prompts the Stream Deck app to install it** when it isn't installed yet. So every action's Global Settings section shows a **"Stream Deck Profiles" accordion** (partial `global-stream-deck-profiles.ejs`, included once via `global-common-settings.ejs`) with one **button per bundled profile**.

**This accordion is the home for switch buttons for _all_ bundled profiles. When you add a new bundled profile, add a row for it here** — the `profiles` array at the top of `global-stream-deck-profiles.ejs`.

Flow: `<ird-profile-switch profile="…">` (in `@iracedeck/pi-components`) → on click sends `sendToPlugin` `{ event: "switchToProfile", profile }` → `ElgatoPlatformAdapter` (which wires `streamDeck.ui.onSendToPlugin` in its constructor) calls `this.switchToProfile(ev.action.device.id, profile)`, targeting the device whose PI is open.

The accordion is gated to Elgato via the `profiles` platform feature flag (`platform-features.json`), so it's hidden on Mirabox/Ulanzi — whose `switchToProfile` is a no-op regardless.

## Cross-platform

Elgato only. Profiles have no Mirabox/Ulanzi equivalent: `switchToProfile` is a no-op on those adapters and the "Stream Deck Profiles" accordion is hidden there via the `profiles` feature flag. Do not add profile concepts to the Mirabox or Ulanzi plugins — their hosts have no profile system.
