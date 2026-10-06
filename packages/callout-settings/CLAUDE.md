# @iracedeck/callout-settings

The Race Engineer callout opt-in registry (#1350). It is the only place a `calloutEnabled*` settings key is declared: every key, its PI label, its default and the callout id it serves live in one entry here, and everything else derives from it. Design record: `docs/superpowers/specs/2026-10-06-issue-1350-callout-settings-registry.md`.

**Zero dependencies — keep it that way.** Plain TypeScript, no `zod`, no `@iracedeck/*` package. `deck-core` and `audio-scenarios` cannot depend on each other, so the registry has to be a leaf both can reach (the same reason `callout-script` and `track-data` are leaves). If this package seems to need something from another one, that something belongs here or the need belongs in the consumer.

## Modules (`src/`)

- `define.ts` — the shapes and typed helpers. `CalloutEntry` (`key`, `label`, optional `default`), `CalloutFamily` (`id`, `callouts`), `defineCalloutFamily` (identity at runtime; its `const` type parameter keeps every id and key a literal type), `CalloutIdOf<F>` and `CalloutKeyOf<F>` (distributes over a union of families), `calloutKey(family, id)` (typed as exactly that id's key; an unknown id, which only an unchecked value can reach, throws naming the family and the id) and `calloutIdForKey(family, key)`.
- `families/*.ts` — one file per family, 35 in all, each exporting `<PREFIX>_CALLOUTS`. A family is named for the `audio-scenarios` family it serves, and its object keys are that family's callout ids. Five small families (`pit-service-requests`, `setup-warning`, `race-engineer-toggle`, `corner-names-toggle`, `telemetry-connect`) hold the keys no scenario family reads; they are named for what reads them. Entries are in PI order, and the rationale that used to sit on each schema field sits on its entry.
- `pi-groups.ts` — `CALLOUT_PI_GROUPS`: the 29 headings of the PI and the settings window's Callouts card, in render order, each an ordered list of families.
- `index.ts` — the public surface: everything above (each family re-exported by name), plus `CALLOUT_FAMILIES` (every family, in PI order, derived from `CALLOUT_PI_GROUPS` rather than listed), `CalloutSettingKey` (the union of every key, derived), `RegisteredCalloutFamily` (any family placed in a group: a generic helper that must yield a `CalloutSettingKey` constrains on it, since `CalloutKeyOf` of a bare `CalloutFamily` is only `` `calloutEnabled${string}` ``), `CALLOUT_SETTING_KEYS`, `calloutEntry(key)` and `calloutDefault(key)`.

## The entry and its default

`default` is optional and can only be `false`: absent means on. New Race Engineer functionality ships on, so an off default is a visible, deliberate exception rather than a value every entry repeats. Today six entries carry it, the fuel countdown counts 10, 9, 8, 7, 6 and 4. `calloutDefault(key)` turns it into the schema default.

A `key` is a persisted settings key and a published contract: never rename or drop one without a migration, and never change a default casually. `deck-core`'s frozen baseline (`src/__fixtures__/callout-settings-baseline.json`) fails on either.

## Families versus PI groups

A family is the unit of ownership: the ids are family-scoped (`ack` is an id of both toggle families, `speeding` of both `pit-limiter` and `no-limiter`, and `furled`, `black`, `meatball` and `disqualify` of both `flag` and `opponent-flag`), so the family is what `audio-scenarios` derives its id types from. A PI group is a heading in the window. Most groups hold one family; three span several (Pit Service, Race, Corner Names), and a group's rows are its families' entries concatenated in list order. Every family belongs to exactly one group.

## Consumers

- `deck-core` builds a `GlobalSettingsSchema` field for every `CalloutSettingKey` with `.default(calloutDefault(key))`, and exports the typed lookup `isCalloutEnabled(key)`.
- `audio-scenarios` derives each family's callout id type with `CalloutIdOf<typeof X_CALLOUTS>` and gates through `isCalloutEnabled(calloutKey(X_CALLOUTS, id))`.
- `pi-components` renders the Callouts rows from `CALLOUT_PI_GROUPS`, with `default="true"` exactly where `calloutDefault(key)` is true.

## Adding a callout

Add an entry to its family here. When the family is new, that is a new family file, its place in one group of `CALLOUT_PI_GROUPS` (which is what registers it: `CALLOUT_FAMILIES` is derived from the groups) and its re-export from `index.ts` (`registry.test.ts` fails on a placed family the index does not export). The schema field, the PI row and the id type follow from it, and no test pins a count to bump.
