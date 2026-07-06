---
paths:
  - "packages/deck-core/src/device-profiles.ts"
  - "packages/deck-core/src/device-profiles.test.ts"
  - "packages/iracing-plugin-stream-deck/**"
---

# Profiles & Devices

How iRaceDeck ships **Stream Deck profiles** and what it knows about each **device**. Profiles are an **Elgato-only** feature (Mirabox/Ulanzi have no equivalent), so everything here applies to `@iracedeck/iracing-plugin-stream-deck` only. Introduced by issue #736; the dynamic Race Admin selector (#732) builds on it.

## Canonical source of truth

Device specs and iRaceDeck's support policy live in **`packages/deck-core/src/device-profiles.ts`** — read and update it there, never re-derive device facts inline. It exports the `DeviceType` enum, `DEVICE_SPECS`, `DEVICE_SUPPORT`, the `PROFILE_*` constants, the lookup helpers (`getDeviceSpec`, `getDeviceSupport`, `isDeviceSupported`, `shipsBundledProfiles`), and the profile-name scheme (`PROFILE_DEVICE_SUFFIXES`, `profileDeviceSuffix`, `deviceProfileName`, `profileDisplayName`, `resolveProfileNameForDevice`, #753). This rule documents the **policy and the profile-file format**; the module documents the **data**. Keep the two in sync (a freshness-style invariant test guards `columns × rows === keys` and the target/`PROFILE_TARGET_DEVICES` cross-check).

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

## The bundled templates

Four templates are registered and shipped: **iRaceDeck Default**, **iRaceDeck Replay**, **iRaceDeck Car Selector**, **iRaceDeck Race Admin Per Car** — currently for the classic Stream Deck and the XL only (8 `Profiles[]` entries; the `+ XL` target device has no registered profiles yet). `PROFILE_NAMES` additionally defines **iRaceDeck Pit Actions**, which is not registered or shipped. Each target device needs its **own** profile file (one `Profiles[]` entry carries exactly one `DeviceType`) — one device-suffixed file each, per the naming scheme below.

## Profile naming — device-suffixed files, clean user-facing names (#753)

One template ships as one file per device. The **file / manifest name** carries a device suffix; the **user-facing name** (the internal `Name` inside the exported bundle — what the Stream Deck app shows) stays the clean display name:

- File / manifest name (`Profiles[].Name`, and the string passed to `switchToProfile`): `iRaceDeck <template> <suffix>` — e.g. `iRaceDeck Default XL.streamDeckProfile`, `iRaceDeck Race Admin Per Car Plus XL.streamDeckProfile`.
- User-facing name: `iRaceDeck <template>`, **no device suffix** — the app's profile list is already per-device, so a suffix there is pure noise. A plain file rename does not touch the ZIP contents, so renaming a file never changes what users see.

**Device-suffix mapping** (canonical: `PROFILE_DEVICE_SUFFIXES` in `device-profiles.ts`; `scripts/generate-action-profiles.mjs` mirrors it under a cross-check test):

| Device | Suffix |
|--------|--------|
| Stream Deck (0) | `SD` |
| Stream Deck Mini (1) | `Mini` |
| Stream Deck XL (2) | `XL` |
| Stream Deck + (7) | `Plus` |
| Stream Deck Neo (9) | `Neo` |
| Corsair Galleon 100 SD (12) | `Corsair Galleon` |
| Stream Deck + XL (13) | `Plus XL` |

Rule: devices named "Stream Deck …" use the latter part (`Plus` spelled out for `+`); the classic Stream Deck, whose latter part is empty, uses `SD`. Only profile-capable devices (`target`/`candidate` in `DEVICE_SUPPORT`) get a suffix.

**Name resolution.** Code shows clean display names wherever users see them and resolves the device-suffixed manifest name at switch time, via the `device-profiles.ts` helpers: `profileDisplayName(name)` strips a trailing suffix (longest first, so `Plus XL` wins over `XL`), `deviceProfileName(name, deviceType)` appends the device's suffix (idempotent), and `resolveProfileNameForDevice(name, deviceType, availableNames)` maps a stored name — exact, legacy pre-#753 unsuffixed, or suffixed for another device — to this device's manifest name (`undefined` when the device has no variant; callers fall back to the device's Default profile). The generated `profiles.json` carries `{ name, deviceType, displayName }` per manifest entry, and the actions push `_deviceProfiles` as `{ name, label }` entries so the `ird-profile-select` dropdowns display suffix-free labels.

## Manifest registration — `Profiles[]`

Add to `com.iracedeck.sd.core.sdPlugin/manifest.json`:

```json
"Profiles": [
  {
    "Name": "iRaceDeck Default XL",
    "DeviceType": 2,
    "AutoInstall": true,
    "DontAutoSwitchWhenInstalled": false,
    "Readonly": false
  }
]
```

- **`Name`** (required) — path to the `.streamDeckProfile` **with the extension omitted**, relative to `manifest.json`. Subfolders are allowed (`assets/main-profile`). iRaceDeck places files at the plugin root, so `Name` is just the file's base name — device-suffixed per the naming scheme above.
- **`DeviceType`** (required) — **must match the device the profile was authored on.** An 8×4 (XL) profile registered as `DeviceType: 0` is broken. Verify the layout's grid against the table above.
- **`AutoInstall`** (default `true`), **`DontAutoSwitchWhenInstalled`** (default `false`), **`Readonly`** (default `false`).

## Authoring workflow (the only supported way)

A `.streamDeckProfile` is **authored in the Stream Deck app and exported** — there is no code path that generates one, and you must not hand-edit the bundle (see format below).

1. In the Stream Deck app, build the layout on (or for) the **exact target device** — the grid and dial count must match that `DeviceType`.
2. Give it a clean profile name (no `(dev)` / test suffixes, **no device suffix** — the internal name is what users see; the device suffix belongs only in the exported file's name, #753).
3. **Set the host-profile marker** on every Switch Profile key in the profile: its *Placed in profile* dropdown must name the profile being authored (#762). This is how the plugin learns the active profile at runtime — the Elgato SDK cannot query it — so the Back-to-previous history stays correct across manual navigation and plugin restarts. Every bundled profile page that can be entered should contain at least one marked key.
4. Right-click the profile → **Export** → rename the export to the device-suffixed file name, `<display name> <suffix>.streamDeckProfile` (e.g. `iRaceDeck Default XL.streamDeckProfile`) — renaming the file does not touch the bundle contents.
5. Drop the file next to `manifest.json` in `com.iracedeck.sd.core.sdPlugin/`.
6. Add the `Profiles[]` entry (device-suffixed `Name`) with the matching `DeviceType`, then run `pnpm generate:action-profiles`.
7. **Validate in the app** — install the plugin build and confirm the profile imports and switches. This can't be unit-tested; it's a manual check.

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

## Folder and page navigation (relevant to #732)

Navigation inside a profile uses **built-in Elgato actions**, not iRaceDeck actions:

- **`com.elgato.streamdeck.page.previous` / `com.elgato.streamdeck.page.next`** — move ±1 between a profile's pages. This is what the bundled selector profile actually uses (verified from the exported bundle).
- **`com.elgato.streamdeck.profile.openchild`** — enter a child folder page; its `Settings.ProfileUUID` is the child page's UUID.
- **`com.elgato.streamdeck.profile.backtoparent`** — return to the parent folder.

The folder pair is exposed as `PROFILE_NAV_ACTIONS` in `device-profiles.ts`. Because child-page UUIDs are minted by the app, folder navigation is authored in the app, not generated. Page navigation is strictly ±1 on the device — a property the selector's page-count learning relies on (below).

## Race Admin car selector (#732)

The dynamic Race Admin / RC car selector is **not** a new action — it's two additions to the existing **Race Admin** action (`packages/iracing-actions/src/actions/race-admin/`), plus two bundled profiles you author in the app:

- **`select-car` mode** — a placeholder key that auto-fills with one car from the live session (by grid position, spectators and pace car excluded) and, on press, stores that car as the shared admin target and switches to the per-car commands profile. Pure helpers (slot math, session→car, icon) live in `race-admin-selector.ts`; the dynamic big-number template is `packages/iracing-actions/icons/race-admin-car-selector.svg`.
- **`selected-car` driver target** — the 4th Driver Target on the command modes (alongside viewed-car / specific / type-in-chat). It reads the shared target and resolves it to the current session car number for the `!cmd #<number>` command and the key icon. Note the user-vs-car target split (#747): modes flagged `targetsUser` in `RACE_ADMIN_MODE_META` (grant/revoke admin, per-driver chat, remove driver) refuse AI/pace-car and not-in-session targets at dispatch via `classifyCarNumberTarget`, because iRacing applies user-management commands to the SENDER when the target matches no user; car-targeted race-control commands stay valid against AI cars.
- **Shared state** — the selection is stored as a **`{ carIdx, carNumber }`** record in the internal passthrough global key **`_selectedCar`** (`SELECTED_CAR_KEY`; the pre-#790 name `_raceAdminSelectedCar` / `LEGACY_SELECTED_CAR_KEY` is read as a fallback, never written), the same `_`-prefixed convention as `_warnings` / `_lastSeenVersion` (no `GlobalSettingsSchema` field). Written by `select-car`, read by `selected-car`. The number doubles as a **staleness guard**: CarIdx assignments are session-scoped while global settings persist, so `resolveSelectedCar` voids the selection when the stored CarIdx no longer resolves to the stored number (session changed) — never trust the bare CarIdx across sessions.

Both `select-car` and `selected-car` are gated to Elgato in the PI via the `profiles` platform feature flag (profiles are Elgato-only), and `requestProfileSwitch` is a no-op on other hosts anyway.

### Selector slot assignment — ordinal + learned page counts (#754)

A `select-car` key's field slot is its **row-major ordinal among the select-car keys visible on the same device + page**, offset by the **learned key counts of all earlier pages**. There are **no reserved cells and no grid assumptions**: any number of keys, placed anywhere (corners included), on devices with or without a fixed grid (`DEVICE_SPECS.grid` is not consulted), and every page may hold a different number of keys.

- Pure helpers in `race-admin-selector.ts`: `selectorOrdinal` (row-major position among visible keys), `pageStartSlot` (prefix sum of learned counts; `null` while any earlier page is unknown → the key renders blank rather than guessing), `parseSelectorPage`.
- The action (`race-admin.ts`) tracks visible select-car contexts per device (`selectorContexts`) and learns each page's key count as pages are visited (`selectorPageCounts`). Counts record immediately on `willAppear` (monotonic during a page-appear burst) and on a **settled** recount after `willDisappear` (`SELECTOR_COUNT_SETTLE_MS`) — an emptied page is a page switch and is skipped, so teardown never corrupts a learned count.
- **Entry lands on page 0**: every named profile switch (Switch Profile action, the select-car target switch) passes `page 0`, and device page nav is strictly ±1 — so by the time page N is visible, pages 0..N−1 have been counted. The counts are in-memory: after a plugin restart mid-browse, later pages stay blank until page 0 is revisited.
- The `select-car` key still carries a 0-based **`selectorPage`** setting (the Elgato `willAppear` payload exposes `coordinates` but **no page index**), which identifies which page a key belongs to.

The field is sorted by car number (pace car and spectators excluded). The **Elgato** Race Admin manifest entry uses the committed neutral `imgs/blank-key` as its `States[0].Image` so page flips show blank black keys instead of flashing the static Race Admin artwork before the dynamic icons render. The Mirabox and Ulanzi manifests deliberately keep the static `imgs/actions/race-admin/key` image — those hosts have no profile pages to flip (the flash this fixes is Elgato-specific), and select-car is Elgato-gated anyway.

### The two bundled selector profiles

- **`iRaceDeck Car Selector`** — the selector pages: Race Admin keys in `select-car` mode, plus the three nav keys per page.
- **`iRaceDeck Race Admin Per Car`** — the commands page: Race Admin command keys set to the `selected-car` target, plus Back/nav.

Both ship as one device-suffixed bundle per target device (currently XL `DeviceType: 2` and classic SD `DeviceType: 0` — e.g. `iRaceDeck Car Selector XL.streamDeckProfile` / `iRaceDeck Car Selector SD.streamDeckProfile`, #753) registered in `manifest.json` `Profiles[]` (with `DontAutoSwitchWhenInstalled: true`, like Replay) and regenerated into `profiles.json`, and are reached from `iRaceDeck Default` via a **Switch Profile** key. The Switch Profile action ships icons for both (`packages/icons/switch-profile/car-selector.svg`, `race-admin-per-car.svg`) keyed by **display name** (device suffix stripped) in its `PROFILE_ICONS` map. The select-car PI's **Target Profile** is an `ird-profile-select` dropdown fed by a `_deviceProfiles` push from the Race Admin action (same pattern as Switch Profile); an empty selection falls back to `DEFAULT_SELECTOR_TARGET_PROFILE` (a display name), and the stored target is resolved to the pressing device's manifest name at press time via `resolveProfileNameForDevice`.

**Focus intent (#790).** The selector is a generic pick-a-car surface: an in-memory per-device intent (`packages/iracing-actions/src/shared/car-select-intent.ts`) set by the entry key decides what a car press means. Camera Controls' `focus-select-car` mode sets `{ action: "focus-camera" }` and opens the selector; with the intent active a press focuses the camera (`camera.switchNum(raw, 0, 0)`) and stays on the grid (the key whose car matches `CamCarIdx` renders a green highlight ring); without it the press is the legacy admin flow. Every Switch Profile press clears the device's intent, as does a host-profile marker reporting a non-selector profile. Legacy profile names resolve via `LEGACY_PROFILE_NAMES` in `device-profiles.ts`; the selection key is `_selectedCar` (legacy `_raceAdminSelectedCar` read as fallback). Residual gap: switches that bypass the Switch Profile action (the PI "Stream Deck Profiles" accordion, manual app-side navigation to a marker-less personal profile) don't clear the intent until the next Switch Profile press or non-selector marker report — closing it fully would need a switch/visibility hook on deck-core's profile-switcher.

## Switching profiles at runtime

Switching goes through the platform abstraction, not the Elgato SDK directly:

```typescript
adapter.switchToProfile(deviceId, "iRaceDeck Default XL", page); // IDeckPlatformAdapter
```

- Implemented by `ElgatoPlatformAdapter` via `streamDeck.profiles.switchToProfile(deviceId, profile?, page?)`. **Mirabox and Ulanzi implement it as a no-op** — their hosts have no profile system.
- The `profile` argument is the **profile name** matching `Profiles[].Name` — the device-suffixed manifest name (#753), **not** the display name; actions resolve stored/display names via `resolveProfileNameForDevice` before switching. **There is no switch-by-UUID**, because install-time UUIDs are unknown to the plugin. Any cross-profile link (e.g. #732's Main → selector → per-car flow) must use the profile **name** + the built-in folder nav, never a hard-coded installed UUID.
- Omitting `profile` asks the app to return to the previously active profile, but **the app only honors this while the current profile was pushed by this plugin** (a one-shot back-link, consumed on use) — anywhere else it logs `Profile not found` and does nothing (verified from Stream Deck app logs; the `@elgato/streamdeck` SDK JSDoc oversells it). Switch Profile's "Back to previous" mode therefore uses `requestProfileSwitchBack` (deck-core `profile-switcher.ts`), which walks a per-device **stack** of visited profiles **by name** (#762). The stack is fed by the plugin's own named switches (Switch Profile keys, the PI "Stream Deck Profiles" accordion via the adapter's `sendToPlugin` routing, the Race Admin selector) and by `notifyProfileVisible` reports from keys carrying the **host-profile marker** (the Switch Profile `hostProfile` setting, authored into the bundled profiles) — the only ways to know the active profile, since the SDK can't be queried for it. Re-switching to a profile already on the stack unwinds to it; with nothing left to pop, Back switches to the device's bundled Default profile (resolved via `profiles.json`), and only without that falls back to the app-level pop. Named forward switches pass `page 0` (#754); Back passes no page, so the app restores the page you left. `page` optionally selects a page within the profile (requires Stream Deck app 6.5+).
- A plugin can only switch to profiles **it ships**; it has no access to user-defined profiles.

## Installing / switching from the PI — the "Stream Deck Profiles" accordion

Bundled profiles do **not** reliably auto-install on plugin updates. The install path iRaceDeck relies on is: **switching to a profile prompts the Stream Deck app to install it** when it isn't installed yet. So every action's Global Settings section shows a **"Stream Deck Profiles" accordion** (partial `global-stream-deck-profiles.ejs`, included once via `global-common-settings.ejs`) with one **button per bundled profile template** — the rows are the unique `displayName`s from the generated `profiles.json`, so device variants of one template collapse into a single suffix-free row (#753) and a new template gets a row automatically once its files are in the manifest and `pnpm generate:action-profiles` has run.

Flow: `<ird-profile-switch profile="<display name>">` (in `@iracedeck/pi-components`) → on click sends `sendToPlugin` `{ event: "switchToProfile", profile }` → `ElgatoPlatformAdapter` (which wires `streamDeck.ui.onSendToPlugin` in its constructor) resolves the pressing device's manifest name via `deviceProfileName(profile, ev.action.device.type)` (#753) and routes it through `requestProfileSwitch`, targeting the device whose PI is open.

The accordion is gated to Elgato via the `profiles` platform feature flag (`platform-features.json`), so it's hidden on Mirabox/Ulanzi — whose `switchToProfile` is a no-op regardless.

## Cross-platform

Elgato only. Profiles have no Mirabox/Ulanzi equivalent: `switchToProfile` is a no-op on those adapters and the "Stream Deck Profiles" accordion is hidden there via the `profiles` feature flag. Do not add profile concepts to the Mirabox or Ulanzi plugins — their hosts have no profile system.
