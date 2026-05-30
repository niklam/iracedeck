# Elevation/integrity mismatch detection + reusable PI warning banner — design

Issue: #610 (follow-up to #609)

## Problem

When iRacing runs elevated (as Administrator) and the Stream Deck app/plugin does not, Windows UIPI silently blocks every outbound path from the plugin to iRacing — scan-code injection and SDK broadcast messages alike. Read-only telemetry (shared memory) still works, so the plugin connects, reads variables, and fires telemetry-driven Race Engineer callouts, but **no button affects iRacing**. Command dispatch is fire-and-forget, so the log shows every command "succeeding". There is currently no signal pointing at the real cause.

A functional probe cannot detect this: UIPI-blocked `SendInput`/`PostMessage` still report success. **Comparing integrity/elevation levels is the only reliable signal.**

## Goal

Detect the elevation mismatch up front and surface a clear, actionable warning to the user — turning a silent "nothing works" into an explicit message. The plugin is **never gated or disabled**; telemetry-only features keep working. This is purely diagnostic.

## Approved decisions

1. **Generic, reusable warnings mechanism** — not an elevation-only one-off. Elevation mismatch is its first producer.
2. **Auto-injected banner** — a bootstrap in `head-common.ejs` (loaded by every PI) prepends the banner element to the top of `<body>`. Zero per-template edits; covers every current and future PI.
3. **Shown on every PI** — all 35 action PIs plus the global Settings PI.

## Architecture

Four layers, each independently testable.

### Layer 1 — Native elevation probe (`@iracedeck/iracing-native`)

**`addon.cc`** — new `getElevationStatus()` returning an object:

```ts
{
  selfElevated: boolean;        // this process's TokenElevation.TokenIsElevated
  iracingFound: boolean;        // FindWindowA("iRacing.com Simulator") succeeded
  iracingQueryDenied: boolean;  // OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) failed with ERROR_ACCESS_DENIED
  iracingElevated: boolean;     // iRacing's TokenElevation (only meaningful when query succeeded)
  mismatch: boolean;            // !selfElevated && iracingFound && (iracingQueryDenied || iracingElevated)
}
```

- **Self elevation:** `OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &t)` → `GetTokenInformation(t, TokenElevation, …)` → `TOKEN_ELEVATION.TokenIsElevated`.
- **iRacing PID:** reuse the existing `FindWindowA(NULL, "iRacing.com Simulator")` + `GetWindowThreadProcessId` building blocks (already in `addon.cc`).
- **iRacing elevation:** `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)`. `ERROR_ACCESS_DENIED` on an existing process ⇒ higher integrity than us (`iracingQueryDenied = true`). On success, read its `TokenElevation` directly (`iracingElevated`).
- **Mismatch** captures *relative* integrity, so it also catches non-"admin" integrity differences, not just the literal Administrator case.
- Registered in `Init()`. Windows-only; on the C++ side there is no non-Windows build (the addon only compiles on Windows), consistent with the existing functions.

**`src/index.ts`** — export an `ElevationStatus` type and a `getElevationStatus(): ElevationStatus` method on `IRacingNative` that delegates to `addon` or the mock. Mock returns a safe "no mismatch" result: all fields `false`.

**`src/mock-impl.ts`** — add `getElevationStatus()` returning `{ selfElevated:false, iracingFound:false, iracingQueryDenied:false, iracingElevated:false, mismatch:false }`.

### Layer 2 — Reusable PI warnings store (`@iracedeck/deck-core`)

A global setting `_warnings` (passthrough key, like `_audioDeviceList`) holds a JSON array of warning records:

```ts
type PiWarningLevel = "info" | "warning" | "error";
type PiWarning = { id: string; level: PiWarningLevel; message: string };
```

New module `packages/deck-core/src/pi-warnings.ts`:

- `setWarning(id, level, message)` — read `_warnings` from the live cache, upsert the record keyed by `id` (replace if `id` exists, append otherwise), write back via `updateGlobalSettings({ _warnings: JSON.stringify(list) })`. No-op write skipped if the serialized list is unchanged (avoids settings churn / re-render loops).
- `clearWarning(id)` — remove the record with that `id`; write back only if it was present.
- Internal `readWarnings()` parses the cache defensively (bad JSON / non-array ⇒ `[]`).

Exported from `deck-core/src/index.ts`. Keyed by `id` so independent producers (elevation now, others later) coexist without clobbering each other.

`_warnings` needs no `GlobalSettingsSchema` field — `.passthrough()` already carries dynamic keys (same as `_audioDeviceList`).

### Layer 3 — Elevation→warning decision (shared, pure, tested)

New module `packages/deck-core/src/elevation-warning.ts`:

```ts
const ELEVATION_WARNING_ID = "elevation-mismatch";

// Structural param shape — avoids a deck-core → iracing-native dependency.
function evaluateElevationWarning(status: { mismatch: boolean }):
  | { id: string; level: "warning"; message: string }
  | null;
```

Returns the warning record (`id`, `level: "warning"`, the user-facing message) when `status.mismatch`, else `null`. The message:

> ⚠️ iRacing seems to be running as Administrator while iRaceDeck is not. Run Stream Deck as Administrator (or run iRacing without Administrator) so that buttons reach iRacing.

Both plugins call this so the wording stays identical. Unit-tested in deck-core (mismatch ⇒ record; no mismatch ⇒ null).

### Layer 4 — `ird-warnings` web component (`@iracedeck/pi-components`)

New `src/components/warnings.ts` defining `<ird-warnings>`:

- On `connectedCallback`, subscribes to `_warnings` via `window.SDPIComponents.useGlobalSettings("_warnings", cb)` (same hook `ird-audio-device-select` uses).
- Parses the JSON array and renders one banner row per record at the top of the PI: an icon by level (`info` ℹ️ / `warning` ⚠️ / `error` ⛔), the message text, level-driven background/border colours. Empty/absent list ⇒ renders nothing (collapses).
- State-driven, **not dismissible**: elevation can't change without restarting one of the apps, so the banner must persist until the mismatch actually clears. (Dismissibility can be added later for other warning types without changing the store.)
- Styles injected once (the established `styleInjected` pattern), using the shared PI font stack.
- Exported from `src/components/index.ts`.

**Auto-injection** — `head-common.ejs` gains a small bootstrap script that, on `DOMContentLoaded`, prepends a single `<ird-warnings>` as the first child of `<body>` if one isn't already present. Because `head-common` is included by every PI and `pi-components.js` is loaded there, every PI gets the banner with no per-template edits.

### Layer 5 — Detection wiring (both `plugin.ts`)

In `iracing-plugin-stream-deck` and `iracing-plugin-mirabox`, after global settings are initialised, subscribe to the SDK controller and act on a disconnected→connected transition:

```ts
let wasConnected = false;
let elevationChecked = false;
getController().subscribe("elevation-check", (_telemetry, isConnected) => {
  if (isConnected && !wasConnected && !elevationChecked) {
    elevationChecked = true;                 // one-shot per connection
    const status = native.getElevationStatus();
    const warning = evaluateElevationWarning(status);
    if (warning) {
      logger.warn("Elevation mismatch: iRacing appears elevated while the plugin is not; outbound commands will be silently dropped");
      setWarning(warning.id, warning.level, warning.message);
    } else {
      clearWarning(ELEVATION_WARNING_ID);
    }
  }
  if (!isConnected) { wasConnected = false; elevationChecked = false; } // re-arm for reconnect
  else { wasConnected = true; }
});
```

Per-tick cost is a boolean compare; the probe runs once per connection. `setReconnectEnabled(false/true)` (app monitor) drives disconnect→reconnect, which re-arms the check. WARN is logged once per connection (the floor); the banner is the visible surface.

## Data flow

```text
iRacing connects
  → SDKController fires subscriber (isConnected: false→true)
    → native.getElevationStatus()  [Windows token comparison]
      → evaluateElevationWarning(status)
        → mismatch? setWarning("elevation-mismatch", "warning", msg)
                    + logger.warn(...)
          → updateGlobalSettings({ _warnings: [...] })
            → Stream Deck echoes global settings
              → every open PI's <ird-warnings> useGlobalSettings cb fires
                → banner renders at top of PI
        → no mismatch? clearWarning("elevation-mismatch")
```

## Error handling

- Native probe wraps each Win32 call and degrades to "no mismatch" on any unexpected failure (never throws into JS). A failed `OpenProcessToken`/`GetTokenInformation` for *self* ⇒ treat `selfElevated` as unknown→`false` only affects the message, never crashes.
- TS wrapper / mock return the safe no-mismatch result off-Windows and when the addon is absent → acceptance criterion "no-op on non-Windows and mock mode" holds.
- `readWarnings()` tolerates malformed `_warnings` JSON (returns `[]`).
- The component tolerates parse errors (keeps prior render).

## Testing

- **deck-core `pi-warnings.test.ts`** — upsert by id, replace existing id, clear present/absent, malformed-cache tolerance, no-op write when unchanged. (Mock `getGlobalSettings`/`updateGlobalSettings`.)
- **deck-core `elevation-warning.test.ts`** — mismatch ⇒ record with the exact id/level/message; no mismatch ⇒ null.
- **iracing-native** — TS wrapper/mock returns no-mismatch when the addon is absent. (C++ itself is not unit-tested, consistent with the existing addon.)
- **pi-components `warnings.test.ts`** — render N records, level→icon mapping, empty list ⇒ no banner, malformed JSON tolerated. (Follow `audio-device-select.test.ts` DOM-stub style.)
- Plugin-side wiring is thin glue over the tested helpers; the transition/one-shot logic could be extracted into a tiny tested function if it grows, but the pure decision already lives in `evaluateElevationWarning`.

## Affected artifacts

- **iracing-native** — `addon.cc` (new fn + `Init()`), `src/index.ts` (type + method + mock branch), `src/mock-impl.ts`, **`CLAUDE.md`** (document the new function).
- **deck-core** — `pi-warnings.ts`, `elevation-warning.ts`, `index.ts` exports, tests.
- **pi-components** — `src/components/warnings.ts`, `src/components/index.ts`, `partials/head-common.ejs` (auto-inject bootstrap), tests. Rebuild `pi-components.js`.
- **Both plugins** — `plugin.ts` detection wiring.
- **Website** — `troubleshooting.md` FAQ entry ("Buttons do nothing in iRacing" → match elevation; references the in-app warning).
- **Docs & rules** — `.claude/rules/keyboard-shortcuts.md` ("Cross-Package Sync" gains the new native export; note the detector + elevation-matching guidance), `.claude/rules/global-settings.md` (`_warnings` key + `setWarning`/`clearWarning` helpers), `.claude/rules/pi-templates.md` / `stream-deck-actions.md` (the `ird-warnings` component, auto-injected).

## Acceptance criteria (from the issue)

- iRacing elevated + Stream Deck not ⇒ a clear `WARN` shortly after connecting **and** a visible banner on every PI.
- Both at the same integrity level ⇒ no warning, behaviour unchanged.
- No-op / safe default on non-Windows and in mock mode.
- Plugin never blocked or disabled by the check.
- `pnpm build`, `pnpm test`, `pnpm lint:fix`, `pnpm format:fix` all pass.

## Out of scope

- Fixing fire-and-forget dispatch self-reporting (#609).
- Dismissible / persisted-dismissal warnings (the store supports adding it later).
- Auto-relaunching elevated (security-sensitive; not pursued).
```