# Surface each action/mode's sim-communication method (#612)

Status: approved design, ready for implementation planning
Date: 2026-05-31
Issue: #612 (milestone v1.20.0)
Scope decision: implement the **entire** feature in one PR (foundation + PI status line + icon overlay + docs/website explainer + per-action audit + labels).

## Problem

iRaceDeck actions talk to iRacing through three mechanisms — the **iRacing API/SDK**, simulated **key bindings**, and **chat/text commands** — and which one a given action *mode* uses is invisible to the user. A mode can silently do nothing because a required binding was never set, and users can't reason about reliability or troubleshoot without knowing the mechanism.

A "binding" is a discriminated union: a keyboard combination **or** a SimHub Control Mapper role (`BindingValue = KeyBindingValue | SimHubBindingValue`). A mode bound to a SimHub role is fully configured and must never be flagged "no binding set" — but it only works while SimHub is running, which the UI must surface.

The communication method is **per-mode, not per-action**: a single action routinely mixes all three methods. Fuel Service is the canonical example — `toggle-autofuel` / `lap-margin-*` are keybind, `add/reduce/set-fuel` are chat macros, `clear-fuel` / `toggle-fuel-fill` are SDK.

## Goal

Make each action/mode's communication method obvious, and make a missing-but-required binding impossible to miss — in the Property Inspector, on the key icon, and in the documentation. A SimHub-bound mode reads as configured; the "SimHub must be running" caveat is surfaced separately.

## Architecture overview

Four layers over one shared foundation:

1. **Foundation** — a per-`(action, mode)` communication descriptor, authoritative in TS, generated to JSON for non-TS consumers.
2. **PI status line** — a shared `ird-binding-status` web component placed under the Mode selector.
3. **Icon overlay** — a centered ⚠️ over dimmed artwork, applied in the shared icon-assembly layer.
4. **Docs/website** — an explainer page on the three methods plus per-mode method labels, backed by a full audit of every action/mode.

## 1. Foundation — per-mode communication descriptor

### Descriptor shape

```ts
export type CommMethod = "api" | "keybind" | "chat";

export type CommDescriptor = {
  method: CommMethod;
  // Present only when method === "keybind". A keybind mode always requires a binding.
  binding?: {
    key: string; // global-settings key (e.g. "fuelServiceToggleAutofuel") or per-action settings key
    scope: "global" | "action";
  };
};

// One action's modes -> descriptor. Keyed by the mode string used in the action's `mode` setting.
export type ActionCommMap = Record<string, CommDescriptor>;
```

`method: "keybind"` is the only method that requires a binding, so no separate `required` flag is needed. `api` and `chat` modes never warn and never overlay.

### Source of truth (Approach A — approved)

TS descriptors are **authoritative**; JSON is **generated**.

- Each action exports a typed descriptor, e.g. `export const FUEL_SERVICE_COMMS: ActionCommMap = { ... }`, type-checked so every key corresponds to a real mode. Where the action already encodes the mapping (e.g. `FUEL_SERVICE_GLOBAL_KEYS`), that map is **derived from** the descriptor (single source — no duplicate mode→key tables).
- A barrel (`packages/iracing-actions/src/actions/comms-catalog.ts`) aggregates every action's `ActionCommMap` keyed by action folder name into a single `COMMS_CATALOG: Record<string, ActionCommMap>`.
- `scripts/generate-action-comms.mjs` emits `packages/iracing-actions/src/actions/data/action-comms.json` from the catalog. A Vitest freshness test asserts the committed JSON matches the catalog (mirrors the existing `generate-icon-defaults.mjs` + freshness-test convention).
- Consumers: action TS imports the catalog directly (icon overlay); the PI EJS `require()`s `data/action-comms.json` at compile time (same mechanism as `data/key-bindings.json`); docs generation reads the same JSON.

### Shared binding helpers

`parseBinding`, `isSimHubBinding`, and `formatKeyBinding` are pure and currently live in `deck-core`. Extract them (and the `KeyBindingValue` / `SimHubBindingValue` / `BindingValue` types) into a pure module importable by **both** `deck-core` and the browser-bundled `pi-components`, so the PI status component and the icon layer share one definition of "is this binding configured?" Re-export from `deck-core` for backward compatibility (no churn at call sites).

## 2. Property Inspector — `ird-binding-status` component

A new `ird-*` web component in `packages/pi-components/src/components/` (no raw HTML controls, per the rules). Placed directly under the Mode selector in each action's `.ejs`:

```html
<sdpi-item label="Mode"> ... </sdpi-item>
<ird-binding-status
  mode-select="mode-select"
  comms='<%- JSON.stringify(require("./data/action-comms.json")["fuel-service"]) %>'
></ird-binding-status>
```

Behavior:

- Reads the current mode from the referenced `<sdpi-select>` (live: `change` + `input` + polling fallback, per the project's documented sdpi-select quirk).
- Looks up the descriptor for the current mode in its `comms` attribute and renders exactly one status line. Method is always named (approved):
  - `api` → ✅ "iRacing API — no binding needed."
  - `chat` → ✅ "Chat command — no binding needed."
  - `keybind`, keyboard binding set → ✅ "Key binding — currently set: Ctrl + X." (via `formatKeyBinding`)
  - `keybind`, SimHub role set → ✅ "Bound to SimHub role: «role»." **plus** caveat ⚠️ "Requires SimHub to be running." The caveat renders live-red when SimHub is not reachable and muted when reachable.
  - `keybind`, neither keyboard nor SimHub set → ⚠️ "No binding set — **set it here**." ("set it here" is a link.)
- Subscribes to global-settings changes so it updates live as the user sets/clears/switches a binding (including keyboard↔SimHub) without changing mode.
- "Set it here" link: opens the global key-bindings accordion (located via its `data-accordion-id`, persisting open state through `_accordionState` exactly as the `accordion` partial already does) and `scrollIntoView`s it. The accordion-open + scroll logic lives **inside** the component so every action navigates identically. The link does not need to focus the exact field — getting the user to the open accordion is sufficient.

SimHub reachability reaches the browser PI via a plugin-maintained `_simHubReachable` passthrough global setting (same pattern as `_audioDeviceList` / `_warnings`), written from the existing `onSimHubReachabilityChange` in both plugins. The component reads it for the live caveat state.

## 3. Icon overlay — centered ⚠️ over dimmed art

`assembleIcon` gains an option:

```ts
assembleIcon({ /* ... existing ... */ bindingMissing?: boolean })
```

When `bindingMissing` is true, the composed graphic content is wrapped in `<g opacity="0.25">…</g>` and a centered warning triangle is appended. The glyph is drawn with SVG Tiny 1.2-safe primitives only (a `polygon` triangle + an exclamation built from `rect`/`text` — no filters, masks, or clipPath), so it renders on Mirabox's QT5 engine. Approved treatment: **triangle over dimmed art** (art stays identifiable, warning unmistakable).

A standalone exported helper `bindingWarningSvg()` (returns the triangle SVG snippet) plus a `dimWrap(content)` helper cover dynamic-template actions that bypass `assembleIcon` (e.g. fuel-service's telemetry-driven `toggle-autofuel`), so those actions can compose the same overlay into their `{{iconContent}}`.

`ConnectionStateAwareAction` gains `protected isActiveBindingMissing(): boolean`, derived from the **same** source of truth as readiness (the binding dispatcher / global settings, keyboard-OR-SimHub aware) — it returns true only when the active binding key has neither a keyboard binding nor a SimHub role. Each action computes the flag from its current mode's descriptor and passes `bindingMissing` into its icon generator.

Semantics:

- The warning is **independent of connection state** — a missing binding is a configuration error, shown whether or not iRacing is connected.
- A **SimHub-configured** mode never shows the overlay (SimHub-not-running is the separate inactive/reachability state, surfaced in the PI caveat, not a missing binding).
- The overlay clears the instant a keyboard binding or a SimHub role is set.

## 4. Documentation, website, and the per-action audit

### Audit

Classify every mode of all ~36 actions by reading each dispatch path (`executeMode`-style switches, `getCommands()` vs `tapBinding`/`holdBinding` vs `chat.sendMessage`). Produce a classification table (action → mode → method → binding key/scope). **The table is reviewed and verified by the maintainer before it is frozen** into the TS descriptors and docs — the audit's correctness is a hard gate.

### Docs

- New explainer page (`docs/` + website) covering the three methods, the reliability rationale (API → key binding → chat), and that a "key binding" is fulfilled by a keyboard combination **or** a SimHub Control Mapper role (which requires SimHub running).
- Extend `.claude/rules/action-documentation.md`: the action-doc template gains a per-mode **Method** expression (e.g. a Method column in the mode/settings table, or a per-mode method line). Backfill every existing action doc under `docs/`.
- Website (`@iracedeck/website`): per-action / per-mode method labels on action pages, plus the new explainer page in navigation. Update action counts / feature lists only if affected.

## 5. Testing

- **Descriptor freshness**: committed `action-comms.json` matches `COMMS_CATALOG`; every descriptor key is a real mode for its action (cross-checked against each action's mode enum where feasible).
- **`ird-binding-status` states**: api, chat, keyboard-set, SimHub-set, neither-set; live keyboard↔SimHub switching; SimHub reachable vs unreachable caveat; mode-change re-render.
- **Accordion navigation**: "set it here" opens the target accordion (sets `open` + persists `_accordionState`) and calls `scrollIntoView`.
- **Icon overlay**: on when binding missing, off when keyboard or SimHub configured; SimHub-configured never overlays; cross-platform-safe SVG (no filter/mask/clipPath tokens in output); `bindingWarningSvg()` snippet shape.
- **`isActiveBindingMissing`**: true only when neither keyboard nor SimHub set; false for api/chat modes and for configured bindings.
- **Shared helper extraction**: existing `parseBinding`/`isSimHubBinding`/`formatKeyBinding` tests continue to pass against the relocated module and the `deck-core` re-export.

## Affected artifacts (sync in the same PR)

- **pi-components** — new `ird-binding-status` component (SimHub-aware, accordion-open + scroll-to nav); extracted shared binding helpers; build/register the component.
- **iracing-actions** — per-mode `*_COMMS` descriptors per action, `comms-catalog.ts` barrel, generated `data/action-comms.json`, `generate-action-comms.mjs`, wire `<ird-binding-status>` into every action `.ejs` under the Mode selector; derive existing mode→key maps from descriptors.
- **icon-composer / deck-core** — `assembleIcon` `bindingMissing` option, `bindingWarningSvg()` + `dimWrap()` helpers, `ConnectionStateAwareAction.isActiveBindingMissing()`.
- **Both plugins (Elgato + Mirabox)** — maintain `_simHubReachable` global setting from `onSimHubReachabilityChange`; pick up the shared PI component and icon overlay; verify overlay renders on QT5.
- **Website** (`@iracedeck/website`) — explainer page + per-action method labels.
- **Docs** (`docs/`) — explainer page; per-mode method in action-doc template; backfill all action docs.
- **Rules** — `action-documentation.md` (method field), `stream-deck-actions.md`, `pi-templates.md` (new partial/component + accordion navigation), `key-icon-types.md` (overlay), `global-settings.md` (binding-status / union usage, `_simHubReachable`), `svg-platform-compatibility.md` (confirm the glyph is safe).
- **Skills** — `iracedeck-actions` (per-mode method listing).
- **Tests** — all of section 5.

## Acceptance criteria (from the issue)

- For any action, the PI shows, under the Mode selector, whether the current mode needs a binding and — if so — whether one is set (keyboard **or** SimHub), with a link to set it, plus the communication method.
- A SimHub-bound mode shows as configured (never the ⚠️ "no binding" state); status reflects switching between Keyboard and SimHub live; the SimHub-must-be-running caveat is surfaced.
- The "set it here" link opens the correct key-binding accordion and scrolls it into view within the PI.
- A mode requiring a binding with **neither** keyboard nor SimHub set shows a centered ⚠️ on the key icon, on both Elgato and Mirabox; it clears once either binding type is configured.
- A docs/website page explains the three methods (and keyboard-vs-SimHub bindings), and every action/mode is labeled with its method.
- No raw HTML controls in PI templates; icon overlay uses cross-platform-safe SVG only.
- `pnpm build`, `pnpm test`, `pnpm lint:fix`, `pnpm format:fix` all pass.

## Notes / non-goals

- Auto-fuel dispatch-method verification (#611) is a separate, smaller issue and not in scope here.
- Per-action vs global binding scope: the descriptor supports both via `binding.scope`; the audit determines which actions use per-action key bindings (most keybind modes use global keys today).
