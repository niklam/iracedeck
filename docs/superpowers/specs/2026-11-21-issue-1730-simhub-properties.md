# SimHub properties on a key

> **Issue:** [#1730](https://github.com/niklam/iracedeck/issues/1730) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> **Depends on:** [#1736](https://github.com/niklam/iracedeck/issues/1736), the sim-neutral template engine and deck-core's `registerTemplateNamespace` (`docs/superpowers/specs/2026-11-21-issue-1736-sim-neutral-template-engine.md`). Nothing here is built before it lands.
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Related: #192 (template expressions), #899 (live title templates), #1339 (the lazy template context), #1164 (SimHub commands, the other direction).

## The decision in one paragraph

iRaceDeck reads SimHub properties from SimHub's own built-in web server, the same one on port 8888 that the Control Mapper bindings already use, through its `GET /api/GetProperty/{propertyName}` route. Nothing has to be installed in SimHub. A key names a property as `{{simhub.<full SimHub property name>}}`, for example `{{simhub.DataCorePlugin.GameData.SpeedKmh}}`, or reads it in an expression as `{{= round(simhub.DataCorePlugin.Computed.Fuel_LitersPerLap, 2) }}`. A reader in `@iracedeck/deck-core`, beside `simhub-service.ts`, registers the `simhub` namespace through #1736's `registerTemplateNamespace`, so SimHub values resolve on every display path deck-core composes, whether or not a sim is connected. It polls, every 200 ms, only the properties that visible keys read, keeps the latest value of each, and tells deck-core's refresh signal when values change. While SimHub is not reachable, or a property has no value, the variable renders empty.

## How SimHub exposes property values

### What is documented

Very little. SimHub has no published API reference for its web server. A forum thread asks what data the web server exposes, beyond the dashboard list at `/DashTemplates/List`, and it has no answer ([SimHub forum, "data avilable from web server"](https://www.simhubdash.com/community-2/simhub-support/data-avilable-from-web-server)). The SimHub wiki describes browser dashboards, including a remote-render mode that streams JPEG frames rendered on the PC, but no property read ([SimHub wiki, Dashstudio remote rendering](https://github.com/SHWotever/SimHub/wiki/Dashstudio-remote-rendering)).

The documented way for another program to read properties is a third-party SimHub plugin, the SimHub Property Server ([repository](https://github.com/pre-martin/SimHubPropertyServer), [protocol](https://github.com/pre-martin/SimHubPropertyServer/blob/main/doc/PropertyServer/PropertyServer.adoc)). It is a DLL copied into SimHub's folder and enabled there. It serves a line-based TCP protocol on port 18082: `subscribe <propertyName>`, then lines of the form `Property <name> <type> <value>` pushed on change, at most 10 Hz. Unprefixed names reach almost every SimHub property, NCalc custom properties included. It needs SimHub 9.6.0 or later.

### What the installed SimHub serves (measured 2026-11-21)

Measured against the SimHub installed on the maintainer's PC, its web assembly `SimHub.Plugins.Web.dll` dated 2026-08-27, with an iRacing session running. The route table was read from the strings of that assembly. It contains `/api/GetProperty/{propertyName}`, `/api/EvaluateStringFormula`, `/api/GetGamedata`, `/api/GetGameDataSimple` and the `/api/ControlMapper/*` routes `simhub-service.ts` already uses. Every probe below was a plain `GET` on `127.0.0.1:8888`:

| Request | Answer |
| --- | --- |
| `/api/GetProperty/DataCorePlugin.GameData.SpeedKmh` | `200 application/json`, body `199.84` |
| `/api/GetProperty/DataCorePlugin.GameData.Rpms` | `200 application/json`, body `6936.0` |
| `/api/GetProperty/DataCorePlugin.Computed.Fuel_LitersPerLap` | `200 application/json`, body `2.0162489507145254` (a property SimHub computes, not one iRacing reports) |
| `/api/GetProperty/DataCorePlugin.GameData.Spectating` | `200 application/json`, body `false` |
| `/api/GetProperty/DataCorePlugin.GameData.Flag_Yellow` | `200 application/json`, body `0` (SimHub keeps many flags as integers) |
| `/api/GetProperty/DataCorePlugin.GameData.CurrentLapTime` | `200 application/json`, body `"00:01:01.2500000"` (a TimeSpan, as a JSON string) |
| `/api/GetProperty/DataCorePlugin.GameData.CarModel` | `200 text/plain; charset=utf-8`, body `Super Formula Lights 324` |
| `/api/GetProperty/DataCorePlugin.GameData.Gear` | `200 text/plain; charset=utf-8`, body `3` |
| `/api/GetProperty/DataCorePlugin.GameRawData.Telemetry.CarIdxLapDistPct` | `200 application/json`, a JSON array of 64 numbers |
| `/api/GetProperty/NoSuch.Property.Here` | `204`, no body |
| `/api/GetProperty/` with an encoded `/` in the name | `204` |
| `/api/EvaluateStringFormula?formula=format([DataCorePlugin.GameData.SpeedKmh],'0') + '\|' + [DataCorePlugin.GameData.Gear]` | `200 text/plain`, body `221\|5` |
| `/api/EvaluateStringFormula?formula=[No.Such.Prop]` and a formula with a syntax error | `200 text/plain`, empty body for both |

Each `GetProperty` answer took 1 to 8 ms. The Property Server plugin was not installed, and port 18082 refused the connection, so the route works with nothing added to SimHub. A `204` means both "no such property" and "the property holds null": the route does not tell the two apart.

### Licence

SimHub's licence page says a licence drives "arduinos, displays and shakers to up to 60FPS instead of 10FPS" and lists no other data limit ([SimHub, get a license](https://www.simhubdash.com/get-a-license/)). Nothing found says the web API is licence-gated. Whether the maintainer's SimHub is licensed was not recorded, so the free tier is the one unmeasured case. The design does not depend on the answer, since a free SimHub that refreshes properties at 10 Hz is still faster than the 5 Hz poll below. The check that settles it is named under Testing.

### The read path, and how sure it is

The read path is `GET /api/GetProperty/{propertyName}` on the SimHub host and port from global settings. Confidence is high that it works on the installed build and needs no SimHub plugin, because it was measured. Confidence is lower on two edges, and each gets a check before the PR: whether an unlicensed SimHub answers it the same way, and whether a property the user defines in SimHub is served by it like a built-in one. The reader handles the remaining unknown, older SimHub builds without the route, by treating a `404` from the route as "this SimHub has no property API" (below).

## Decisions

### 1. Poll `GetProperty`, one request per property

SimHub pushes nothing to a plain HTTP client, so the reader polls. Each wanted property is one `GET /api/GetProperty/<encodeURIComponent(name)>`.

- **Cadence: one cycle every 200 ms (5 Hz).** A cycle fetches every wanted property, at most 4 requests in flight, and the next cycle starts 200 ms after the previous one started or as soon as it finishes, whichever is later. Cycles never overlap, so a slow SimHub slows the poll instead of piling up requests. A key repaints at most at 10 Hz (`IconUpdateThrottle`), and a free SimHub updates its own outputs at 10 FPS, so 5 Hz is live to the eye at half the load of matching the key rate.
- **Per-request timeout: 1000 ms**, shorter than the Control Mapper's 2000 ms, because a read has a newer cycle behind it.
- **The body is read with a 16 KiB cap.** A larger body counts as no value. The cap uses `@iracedeck/fetch-utils`' `readCappedJson` for JSON, and the same byte cap for `text/plain`.
- **At most 32 distinct properties are polled.** A 33rd name is not fetched and renders empty; the reader warns once per such name, naming it. 32 properties at 5 Hz is at most 160 loopback requests a second, each measured at a few milliseconds.

Rejected: `EvaluateStringFormula` as one batched request per cycle. It returns text only, so numbers lose their type before an expression reads them, and a missing property, a null one, a syntax error and an empty string all come back as the same empty body. Building the formula also means quoting arbitrary property names into NCalc. It stays the fallback if the per-property poll is measured too heavy. Rejected as well: the Property Server's TCP subscription, which is push and typed but needs the SimHub plugin install this issue exists to remove; the dashboard WebSocket (`/ws`), an undocumented protocol that pushes component updates for a dashboard SimHub evaluates, not property values, and would mean shipping a dashboard file; and `/api/GetGamedata`, which carries only the `GameData` snapshot and none of the plugin or user properties.

### 2. The `simhub` namespace, registered by deck-core

`initializeSimHubProperties(logger)` starts the reader and registers it once:

```typescript
registerTemplateNamespace("simhub", {
  context: simHubPropertiesContext, // answers the path after "simhub.", live
  onChange: onSimHubPropertiesChange, // see section 4
});
```

No hook is added to `iracing-sdk` or `SDKController`, and `plugin-runtime`'s `initSim` wires nothing. `plugin-runtime`'s `startServices` calls `initializeSimHubProperties` right after `initializeSimHub`, since both read the host and port from global settings. #1736 checks collisions in either order of registration and sim initialisation, and iRacing claims no `simhub` namespace, so the phase is free. #1736 also isolates the source: a throw from one of its lookups reads as that path absent and leaves the rest of the template resolved, so a failing SimHub reader never blanks the iRacing values on the same key.

The context answers the remainder of the path, the SimHub property name:

- `display(name)` reads the cached value through `@iracedeck/template-engine`'s `formatScalarLeaf`, the rule iRacing's walking namespaces use: a boolean renders `Yes` / `No`, an integer as is, any other number with two decimals, a string verbatim. A JSON string (a TimeSpan such as `"00:01:01.2500000"`) is a string. A JSON array or object, `null`, or a body over the cap is no value, which renders empty.
- `raw(name)` returns the parsed number, boolean or string. A name with no value is found but holds nothing (`{ found: true, value: undefined }`), so `empty(simhub.X)` is true and arithmetic on it renders empty, never an "unknown variable" for a property that is merely not fetched yet.

### 3. Template syntax

`{{simhub.<name>}}`, with `<name>` written exactly as SimHub lists it, its plugin prefix included (`DataCorePlugin.GameData.SpeedKmh`, `DataCorePlugin.Computed.Fuel_LitersPerLap`). There is no alias table and no case folding: the name is passed through verbatim, so every property SimHub lists, and every one a SimHub plugin or the user adds later, works without a change here. The name is limited by the grammar both placeholders already have: `[A-Za-z0-9_.]` for `{{…}}`, and segments that start with a letter or `_` inside an expression. Neither grammar changes.

### 4. Which properties are fetched, and what drives the refresh

The reader does not parse templates. Every lookup of `simhub.<name>` records the time `<name>` was asked for. A name not asked for in the last 3000 ms leaves the wanted set, and its cached value is dropped with it. A name asked for the first time gets an immediate fetch of its own, outside the cycle, so a new key fills within one round trip.

Lookups only happen when a reader resolves, and since #1736 readers resolve on deck-core's refresh signal, which fires on sim ticks and on a deck-core namespace's `onChange`. With a sim connected the ticks alone keep every visible key resolving. With no sim nothing ticks, so the reader's `onChange` has to keep the keys resolving, and with them the wanted set alive. It calls its listeners:

- after any cycle in which a value changed, a value was dropped, or a first value arrived;
- when SimHub becomes unreachable (every value drops to empty at once) and when it becomes reachable again;
- otherwise at least once every 1000 ms while any name is wanted, as a keep-alive, so a visible key reading a property that does not change still asks for it within the 3000 ms window.

So **polling follows visible keys, with or without a sim**: while at least one visible key reads `simhub.*`, the reader polls; once none has for 3 seconds, it stops and fires nothing. A key that leaves the screen unsubscribes from the refresh signal and stops asking. The keep-alive costs each templated key at most one extra resolve a second, through its 10 Hz throttle, and an image is pushed only when the resolved text changed; with a sim connected the throttle coalesces it with the ticks.

This interest-by-lookup was chosen over scanning templates for names because it needs no second template parser to keep in step with the engine, it covers titles, values and expressions alike, and "visible" falls out of the readers' own subscribe and unsubscribe.

### 5. Where it shows

Every display path #1736 routes through deck-core: Telemetry Display's value and title, every key's Title Text through the #899 watcher, and Chat's key text and message preview.

- **Telemetry Display with no sim.** #1736's `resolveDisplayTemplate` sets `hasSource` when a lookup reached a deck-core namespace, so a key reading `{{simhub.X}}` renders while iRacing is closed, and `---` only when the whole value is empty. Its disconnected look follows the same idea: Telemetry Display overrides `needsSim(settings)` and returns `false` when its value template and title read at least one deck-core namespace and nothing else, so a SimHub-only key is not dimmed while iRacing is closed. The namespaces a template reads come from a new `@iracedeck/template-engine` export, `templateNamespacesRead(text): ReadonlySet<string> | null`, which walks both placeholder kinds with the engine's own parser and returns `null` when an expression does not parse (read as needing the sim). deck-core adds `isDeckTemplateNamespace(name)` over its registry. Any other action keeps needing the sim, since its key does something in iRacing whatever its title shows.
- **Chat and Race Admin sends.** A message resolved at the press combines its fresh iRacing build with deck-core's namespaces, so the message sends the SimHub value its preview shows. deck-core's `getTemplateContext` takes an optional sim context for this, `getTemplateContext(simContext?)`, used in place of the connection's per-tick one; Chat's and Race Admin's send paths pass `buildTemplateContext(sdkController)`. A lookup at the press never waits on HTTP: a name no visible key keeps wanted has no cached value and sends empty, and that first lookup starts its fetch. The Chat key's own preview keeps its message's names wanted, so the common case sends the live value. The website says so.

### 6. What a key shows when SimHub is down or a property does not exist

The variable renders empty. An empty value is never replaced by a guess or a stale one.

- **SimHub not reachable** (connection refused, timeout, a network error): the reader drops every cached value at once, fires `onChange`, logs `SimHub properties unreachable` at info, and stops the 5 Hz cycle. Every 5000 ms, the Control Mapper health check's interval, it probes with one wanted name, and the first answer of any status restores the cycle, fires `onChange` and logs `SimHub properties reachable` at info. A stale value shown as if live would be worse than an empty one, which is why the cache is dropped rather than held.
- **The route is missing** (`404` on `GetProperty`, an older SimHub): the reader warns once, `SimHub property reads are not supported by this SimHub version; update SimHub to show SimHub properties on keys`, renders every name empty and retries every 60 s, so an update is picked up without a restart.
- **No such property, or one holding null** (`204`): that name renders empty and the reader logs the name once at debug. The two cases cannot be told apart on this route, so the website tells users to copy the name from SimHub's property list.
- **A `5xx` or another unexpected status for one name**: that name renders empty for this cycle, logged once per name at debug. SimHub stays reachable.
- **Not fetched yet**: empty until the first answer, at most one round trip.

The Control Mapper's own reachability (`isSimHubReachable`, probed through `GetRoles`) is not touched: it answers whether a role can be pressed, which needs the Control Mapper plugin, while the reader only needs the web server. The two can disagree, and each says what its own feature needs.

### 7. Caching

One cache in the reader: per wanted name, the latest parsed value, replaced by each answer. A lookup reads the cache synchronously and never waits on HTTP, so template resolution stays as cheap as #1736 makes it. The cache is in memory only, per plugin process. Two deck hosts running at once each poll for their own keys, which is acceptable at loopback cost. Nothing is persisted.

### 8. Package placement, the dependency graph and the seam

- **The reader is `@iracedeck/deck-core`'s `simhub-properties.ts`**, beside `simhub-service.ts`, as the issue proposes. SimHub is not a sim, deck-core already owns the SimHub host and port read (`getConnectionConfig`, which moves to a small shared module both files import), and the reader imports nothing sim-specific, so the sim-boundary lint holds. Its API follows the service beside it: `initializeSimHubProperties(logger)` (which registers the namespace), `isSimHubPropertiesInitialized()` and `_resetSimHubProperties()` (which unregisters it).
- **One new dependency edge: `deck-core → fetch-utils`.** deck-core dropped `fetch-utils` in #1367 when its only consumer, the changelog feed client, moved to `app-updates`; the reader brings it back for `readCappedJson`. `fetch-utils` is a dependency-free leaf, so no cycle or sim import comes with it. `deck-core → template-engine` is #1736's edge, not a new one here, and so is `template-engine`'s `templateNamespacesRead`, which is added in that package with its tests.
- **No new seam.** The seam is #1736's `registerTemplateNamespace`, and `simhub` is its first production user. `SimConnection` (SEAM 3) is not touched. The Architecture page's dependency-graph prose and its package dependency map name the `deck-core → fetch-utils` edge, and the page's SEAM 3 discussion gains one sentence: deck-core's own `simhub` namespace resolves beside the sim's, read from SimHub's web server. Its line that the plugin requests nothing but iRacing and SimHub (and the changelog feed) stays true.

## Other artifacts

- `packages/deck-core/CLAUDE.md` (the module list, the dependency list with `fetch-utils` and why), the template-engine package's `CLAUDE.md` (`templateNamespacesRead`) and `.claude/rules/stream-deck-actions.md` (the *Title template variables* paragraph and the `needsSim` overrides list, which gains Telemetry Display for a SimHub-only key).
- Website: a SimHub section on the template-variables page (syntax, copying the name from SimHub, empty while SimHub is closed, no SimHub plugin needed, a value only a sent message reads sends empty), the Telemetry Display page (works without iRacing when it reads only SimHub), the settings page's list of keys the disconnected look skips, the settings window's help text in `global-disconnected-look.ejs`, and a `Features` changelog fragment.
- No new global setting: the host and port are the existing `simHubHost` / `simHubPort`, and the reader is idle while no key reads it. No manifest change in any plugin.
- The `iracedeck-actions` skill changes only if Telemetry Display's one-line description does.

## Out of scope

- **Writing properties, triggering SimHub actions or inputs**, and the SimHub-to-iRaceDeck direction (#1164).
- **SimHub's NCalc or JavaScript formulas typed into a key** (through `EvaluateStringFormula`). iRaceDeck's own expressions (#192) do the arithmetic.
- **Property names the template grammar cannot spell** (spaces, hyphens, a segment starting with a digit inside an expression), arrays and objects, and formatting a TimeSpan.
- **Waiting for a fresh value at a Chat or Race Admin press.** A send reads the cache; it never awaits a fetch.
- **A banner or settings-window indicator** for "SimHub property reads unavailable": the log lines above carry it.
- **The Property Server plugin** as a second transport.
- **Moving the SimHub code out of deck-core** into a package of its own. That split would move the Control Mapper service with it and is a hygiene issue of its own.

## Testing

Unit tests, over a fake SimHub (a stubbed `fetch` as in `simhub-service.test.ts`, with fake timers):

- `simhub-properties.test.ts`: a JSON number, a boolean, a JSON string and a `text/plain` string parse to the right raw value and display through `formatScalarLeaf`; `204`, a JSON array, JSON `null` and a body over 16 KiB are no value; a name looked up once is fetched at once and then polled every 200 ms; no cycle starts while one is in flight, and at most 4 requests are in flight; a name not looked up in 3000 ms stops being polled and its value is dropped; a 33rd name is never fetched and warns once; a network error or timeout clears every value, fires `onChange`, logs unreachable once, and probes every 5000 ms with one request until an answer restores the cycle, fires `onChange` and logs reachable once; a `404` warns once and retries after 60 s; a `500` for one name leaves the others' values alone; the name is URL-encoded; the host and port come from global settings.
- `onChange`: fires after a cycle that changed, dropped or first filled a value, not after one that changed nothing, and at least once a second while a name is wanted; fires nothing once the wanted set is empty.
- Registration: `initializeSimHubProperties` registers `simhub` with deck-core; `_resetSimHubProperties` unregisters it; a throwing lookup reads as absent while an iRacing variable in the same template still resolves (#1736's isolation, exercised through the real registry).
- **No sim:** with the sim connection disconnected and ticking nothing, a `BaseAction` title `{{simhub.X}}` refreshes when the fake SimHub's value changes, and a static value keeps being polled through the keep-alive while the key is visible and stops 3 s after it disappears.
- `template-engine`: `templateNamespacesRead` over both placeholder kinds, a ternary, function calls, `empty()`, literal text only (empty set), and a parse error (`null`).
- Telemetry Display: a `simhub.` variable next to a `telemetry.` one; a SimHub-only key renders its value and `needsSim` is false while iRacing is closed; a mixed key renders `---` and needs the sim, as today.
- Chat and Race Admin: a send combines its press-time iRacing context with `simhub`, sending a cached value and an empty one for a cold name.
- `plugin-runtime`'s `start-services` test records `initializeSimHubProperties` after `initializeSimHub`; `sim.test.ts` records no new call.

Checks before the PR, by the issue's `qa` agent against a real SimHub, each with its evidence recorded in the PR body:

1. **The free tier.** On an unlicensed SimHub (a machine without a licence, or a fresh install in its free mode) with iRacing running, `curl -s -w " %{http_code}" http://127.0.0.1:8888/api/GetProperty/DataCorePlugin.GameData.SpeedKmh` returns `200` and a number, and 50 reads 100 ms apart show how often the value changes. If the route answers anything else there, the read path is reopened before any code merges.
2. **A user-defined property.** A property the user creates in SimHub is returned by `GET /api/GetProperty/<its full name>` with its value. If it is not, the spec is amended to say which kinds of calculated properties are reachable before the docs promise them.
3. **Load.** With 32 SimHub variables on visible keys during a session, the resource monitor's `Resources:` debug lines show the plugin's CPU against a session without them, and once more with iRacing closed and SimHub open.

Manual test on the deck, by Niklas, with SimHub running:

- In an iRacing session, a Telemetry Display key with `{{simhub.DataCorePlugin.GameData.SpeedKmh}} / {{telemetry.Speed}}` shows both and both move live; a Title Text on another action with a SimHub variable updates too.
- An expression `{{= round(simhub.DataCorePlugin.Computed.Fuel_LitersPerLap, 2) }}` renders a rounded number.
- A misspelt property name renders empty (`---` alone on Telemetry Display).
- With iRacing closed, a Telemetry Display key reading only a SimHub property that changes outside a session still shows and updates it, undimmed with the disconnected look on, while the mixed key shows `---`.
- Closing SimHub empties the SimHub values within a second or two while the iRacing values keep going; restarting SimHub brings them back within about 5 s.
- A Chat key whose message holds a SimHub variable sends the value its key shows.
- The same on the Mirabox hardware's keys, since all three plugins share the reader.
