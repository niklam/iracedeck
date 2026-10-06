# One registry for the Race Engineer callout opt-ins

> **Issue:** [#1350](https://github.com/niklam/iracedeck/issues/1350) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

Each of the 100 `calloutEnabled*` keys is written by hand in up to four places, measured on `master` at `b990046bd`:

| Place | What it holds | Count |
| --- | --- | --- |
| `GlobalSettingsSchema` (`deck-core/src/global-settings.ts`) | one zod field per key, all the same shape: `z.union([z.boolean(), z.string()]).transform((val) => val === true \|\| val === "true").default(…)` | 100 |
| `*_CALLOUT_SETTING_KEYS` (`audio-scenarios/src/catalog/pit-crew/`) | `Record<XCalloutId, string>`, the callout id → key map | 30 maps, 95 keys |
| `race-engineer-callouts.ejs` (`pi-components/partials/`) | `{ setting, label }` arrays, one per PI heading | 29 arrays, 100 keys |
| Literal reads | `(getGlobalSettings() as Record<string, unknown>).calloutEnabledX !== false` in `race-engineer-wiring`, `plugin-runtime` and `iracing-actions` | the 5 keys in no map, plus a few more |

Nothing but comments ties them together. `deck-core` and `audio-scenarios` cannot import each other, so the map values are plain `string`. The `global-settings.test.ts` lists that say "Keys must match … exactly" assert the schema against its own literal copies and never import the map. Every literal read casts `getGlobalSettings()` to `Record<string, unknown>`, so a misspelt key compiles and reads as "on".

`race-engineer-wiring/src/pit-crew-deps.ts` imports all 30 maps (#1349 already folded the three plugins' copies into it) to build 30 `getXCalloutEnabled(id)` dependencies through one `optIn()` helper, plus a bespoke `getPitServiceRequestsEnabled`.

Defaults are not uniform. 94 keys default to `true`. Six fuel countdown keys (`calloutEnabledFuelLapsLeft10`, `9`, `8`, `7`, `6`, `4`) default to `false`: that is the Discord-request baseline, where only 5, 3, 2, 1, Box and race-covered ship on. That default is written twice, as `.default(false)` in the schema and as an `on: false` flag in the PI's fuel array. The PI copy sits beside a warning that `default="false"` renders the box checked (the sdpi truthy-attribute trap), so an off default must omit the attribute.

## Decision

### A new leaf package: `@iracedeck/callout-settings`

The registry is plain TypeScript, with no zod and no `@iracedeck/*` dependencies, in the same spirit as `track-data`. `deck-core`, `audio-scenarios` and `pi-components` depend on it; it depends on nothing.

| Rejected home | Why |
| --- | --- |
| `callout-script` | Already the leaf both sides share, but its job is the `callouts.json` grammar; a settings registry is a second, unrelated responsibility. |
| `audio-scenarios`, injected into `deck-core` at startup | Truest to "the family owns it", but `GlobalSettings` would lose its static field types, and the module-load `GlobalSettingsSchema.parse({})` would need reordering behind an injection step. That is the highest risk to a published contract, for no gain the leaf package lacks. |
| `deck-core` | It is the deck-platform layer. #1351 exists to take Race Engineer concerns out of it, not to add more. |

### The unit is the family

One file per family under `src/families/`, named for the `audio-scenarios` family it serves:

```typescript
// src/families/fuel.ts
export const FUEL_CALLOUTS = defineCalloutFamily({
  id: "fuel",
  callouts: {
    "laps-left-10": { key: "calloutEnabledFuelLapsLeft10", label: "10 laps of fuel left", default: false },
    // …
    "laps-left-5": { key: "calloutEnabledFuelLapsLeft5", label: "5 laps of fuel left" },
  },
} as const);
```

- **The object keys are the family's callout ids**, copied from today's maps. Ids are family-scoped (`report`, `changed` and `status` each belong to one family), which is why the family is the unit rather than the PI heading.
- **`audio-scenarios` derives its id types from the registry** (`type FuelCalloutId = CalloutIdOf<typeof FUEL_CALLOUTS>`) and deletes its 30 maps. A `SCENARIO_ID_TO_*` entry naming an id the family no longer has is then a compile error.
- **`key`** is typed `` `calloutEnabled${string}` ``.
- **`label`** is the PI checkbox text, moved verbatim from the EJS.
- **`default`** is optional and can only be `false`; absent means on. That keeps "new Race Engineer functionality defaults on" the structural norm and makes an off default a visible, deliberate exception. The issue's task list names "default" as a registry field; this is that field, narrowed to the one value that carries information.
- **Per-key rationale** (the JSDoc that sits on each schema field today, with its issue references) moves onto the registry entry.
- **The five keys with no family today** get small families of their own, named for what reads them: `calloutEnabledPitServiceRequests`, `calloutEnabledSetupWarning`, `calloutEnabledToggleRaceEngineer`, `calloutEnabledToggleCornerNames` and `calloutEnabledTelemetryConnectRadioCheck`. After this change the registry is the only place any `calloutEnabled*` key is declared.

The index exports:

- `CALLOUT_FAMILIES`, every family;
- `CalloutSettingKey`, the union of every `key`, derived;
- `CALLOUT_SETTING_KEYS`, the keys as an array;
- `calloutDefault(key)`, which returns `true` unless the entry says `false`;
- `CALLOUT_PI_GROUPS` (below).

### PI groups: an ordered list over families

```typescript
export const CALLOUT_PI_GROUPS = [
  { id: "flags", title: "Flags", families: [FLAG_CALLOUTS] },
  // …
  { id: "pit-service", title: "Pit Service", families: [PIT_READBACK_CALLOUTS, TIRE_WEAR_CALLOUTS, PIT_SERVICE_REQUEST_CALLOUTS, AUTO_FUEL_CALLOUTS] },
  { id: "race", title: "Race", families: [RACE_START_CALLOUTS, RACE_STATUS_CALLOUTS, RACE_END_CALLOUTS] },
  // …
] as const;
```

There are 29 headings over 35 families. Three headings span several families (Pit Service, Race, Corner Names), and each of those is contiguous by family today. So a heading's rows are its families' entries concatenated in list order, which reproduces today's row order exactly. A family belongs to exactly one group.

### `deck-core` assembles the schema

- `global-settings.ts` deletes its 100 hand-written fields.
- One helper builds a field for every `CalloutSettingKey`, with the shape above and `.default(calloutDefault(key))`. The result is spread into the same `z.object({...}).passthrough()` literal.
- The key union is literal, so `GlobalSettings` keeps a statically typed field per key.
- Passthrough, the salvage parse (#896) and every other field are untouched.
- `deck-core` knows key names and their defaults, and nothing else about callouts.

**Key order changes; nothing reads it.** The 100 fields become one contiguous block in `GlobalSettingsSchema.parse({})` output instead of being interleaved with the other Race Engineer keys. The settings store serialises whatever object it holds. `sameValue` and `mergeMigration` compare values key by key. JSON readers ignore order. No migration.

### One generic lookup

`deck-core` exports `isCalloutEnabled(key: CalloutSettingKey): boolean`, which is `getGlobalSettings()[key] !== false`. It is typed, with no cast. It sits beside `getGlobalSettings` because that is where the cache lives.

- **`PitCrewDeps`** (`audio-scenarios`) loses its 30 `getXCalloutEnabled(id)` members and `getPitServiceRequestsEnabled`. It gains `isCalloutEnabled?: (key: CalloutSettingKey) => boolean`, with `DEFAULT_DEPS` returning `true`.
- **Each family resolves its own id to a key** through a typed helper: `isCalloutEnabled(calloutKey(FUEL_CALLOUTS, id))`.
- **`race-engineer-wiring`** passes `isCalloutEnabled` through. The 30 map imports, `optIn()` and the bespoke pit-service closure go.
- **`plugin-runtime`'s opponent-flag gate** (the translator-side gate in `phases/sim.ts`) resolves the bus flag through the registry and the same lookup.
- **The literal reads in `iracing-actions`** (toggle acknowledgements, corner names, the radio check) and **`deck-core`'s `SETUP_WARNING_ENABLED_KEY`** use the lookup or the registry entry, and their casts go.
- **The master switches are unchanged.** `pitCrewRaceEngineerEnabled` and `pitCrewRadarEnabled` are not `calloutEnabled*` keys and read `=== true`.

Test doubles become typed literals (`isCalloutEnabled: (key) => key !== "calloutEnabledCautionFollow"`), so a misspelt key in a test is a compile error too.

### The PI renders from the registry; the layout stays in the EJS

- `pi-components` depends on `@iracedeck/callout-settings`, and `pi-template-plugin.mjs` passes `calloutPiGroups` into the EJS render data. The template `require` reads only JSON from the templates directory, and a committed generated file would need a freshness test; passing the built package's data needs neither.
- The partial deletes its 29 `{ setting, label }` arrays and their per-array `map` functions. Each heading becomes one helper call that renders:
  - the `<sdpi-item>` from the group's `title`;
  - the existing two-column grid (`rows = ceil(n / 2)`) from its entries;
  - each checkbox with `default="true"` exactly when `calloutDefault(key)` is true, and no `default` attribute otherwise. That retires fuel's `on` flag and the attribute trap together.
- The non-callout items interleaved between headings stay hand-placed exactly where they are. These are the opponent-flag range, the three gap thresholds, the spotter reminder interval, the fuel margin and the corner-call lead.
- The rendered window is unchanged.

## Out of scope

- **The other Race Engineer keys**: the volumes, thresholds, `pitCrew*` masters and startup policies, `driverName` and the setup-warning patterns. Moving Race Engineer settings out of `deck-core` as a whole is #1351. This registry is the piece of that #1351 can carry along.
- **A "supported sims" field on a family.** It is YAGNI until a second sim exists. Adding an optional field to `defineCalloutFamily` later is non-breaking.
- **Persistence layout.** That is #1038, which splits the settings file by category. This issue changes where keys are declared, never what is written or where.
- **Renaming or re-defaulting any key.** Every persisted name and default is identical before and after.
- **Changing the window's appearance.** That includes the order of headings, rows and the interleaved numeric items.

## Testing

**The equivalence proof is the first commit.**

1. **Capture the baseline.** The branch's first commit, made before any schema edit, writes `packages/deck-core/src/__fixtures__/callout-settings-baseline.json`. It is generated from `master`'s schema and records each of the 100 keys with:
   - its parsed default;
   - its result for `true`, `"true"`, `false`, `"false"` and `"x"`;
   - whether a number is rejected.
2. **Assert against it after the switch.** The assembled schema must reproduce every row, and:
   - `GlobalSettingsSchema.parse({})` must have the same key set and values as before (compared as a set: the order changes, as above);
   - an unknown key must still pass through.
3. **Keep the baseline as a guard.** It stays as a frozen record of a published contract, not a list kept in step:
   - Adding a callout needs no edit to it.
   - Dropping or renaming a stored key fails, and that is the moment a migration is owed.
   - Changing a stored key's default fails too, which is a user-visible behaviour change that deserves the deliberate edit.

**Cross-package tests**

- **`callout-settings`:**
  - family ids are unique;
  - keys are unique across all families, and each starts with `calloutEnabled`;
  - labels and titles are non-empty;
  - every family appears in exactly one PI group;
  - every PI group has at least one family.
- **`audio-scenarios`:**
  - every scenario id in each `SCENARIO_ID_TO_*` map resolves to a registry key (contract id → key);
  - every id of a scenario-backed family is reached by at least one scenario. This is a runtime check, not just a type check.
- **`deck-core`:**
  - every `CalloutSettingKey` is a schema field (key → schema field);
  - `isCalloutEnabled` returns the parsed value, and `true` for a key left at an on default.
- **`pi-components`:**
  - every registry key renders exactly once;
  - an off-default key renders with no `default` attribute;
  - an on-default key renders with `default="true"`.
- **Deleted, as made redundant:**
  - `BOTH_FAMILY_CALLOUT_KEYS`, `CAUTION_CALLOUT_KEYS` and the tire-wear literal in `global-settings.test.ts`;
  - `caution.test.ts`'s literal `toEqual` of the map;
  - the per-family "has a setting key" assertions the derived types now enforce.

**Manual verification.** Open the settings window from a plugin built off the branch and compare the Callouts card against `master`: the same headings, rows, order and checked states. Then do the same with a settings file that has a few keys switched off, including one of the off-by-default fuel counts switched on. Run one session in the harness to confirm that a callout switched off is silent and one left alone still speaks.

## Documentation changed with it

- **`.claude/rules/race-engineer-callouts.md`:** the add-a-callout steps for the map, the Zod field, the checkbox row and the wiring closure collapse into "add an entry to the family in `callout-settings`".
- **Updated for the new ownership:**
  - `.claude/rules/race-engineer-callout-examples.md`, where an example cites the old steps;
  - `.claude/rules/global-settings.md`, for the per-callout opt-in convention;
  - the `audio-scenarios` and `deck-core` `CLAUDE.md` files.
- **Additions for the new package:**
  - a `CLAUDE.md` of its own;
  - an entry in the root `CLAUDE.md` package list;
  - an entry in the `README.md` project structure;
  - the package and its three dependency edges on the developer Architecture page.
- **No changelog line.** Nothing a user can see changes.
