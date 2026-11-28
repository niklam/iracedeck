# Opt-in usage data: a daily install report and anonymous session reports

> **Issue:** [#1814](https://github.com/iracedeck/iracedeck/issues/1814) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Users who opt in send two kinds of report: a pseudonymous daily install report and an anonymous report per sim session. #1814 carries what and why. This spec records how: the privacy model the whole design is held to, the report schemas, the rule that decides which settings may be reported at all, the client in the plugin, the consent surfaces, the Privacy page and pane, the endpoint and its BigQuery storage, erasure, and what was refused.

## Settled with Niklas (2026-11-28), not re-opened here

- **Backend:** our own endpoint. A Firebase Hosting rewrite of `iracedeck.com/api/usage/**` to a Cloud Run function in an EU region, writing to a BigQuery dataset in an EU region. Needs the Firebase Blaze plan.
- **Two report kinds:** a daily install report under a random, locally generated, resettable install ID (pseudonymous), and a session report after each session with no ID of any kind (anonymous), stored in its own table and never joined to install reports. The field lists in *The report schemas* below are his, bucketing and shape are this spec's.
- **Presses, dial turns and callouts heard live on the install report only (Niklas, 2026-11-28: "Yes, move them").** They are counted in the daily install report, split by the length range of the session they happened in plus a bucket for those outside any session ("pit keys: 40 presses in races over 3 h, 2 in sprints"). The session report keeps only what was raced: sim, event type, session kind, team or solo, scheduled and driven length ranges, track (the sim's track id, name and configuration), car (the sim's car id) and car class, ISO week. Why: *The privacy model*.
- **Track and car ids on the session report (Niklas, 2026-11-28: "Tracks should likely contain track ID and car ID as well").** The session report carries the sim's own track id beside the name and configuration, and the sim's id for the player's own car beside the car class, in a sim-neutral shape (section 3).
- **Transport:** queued locally, sent once a day in one request; the endpoint keeps nothing that links a session row to an install ID or to the request.
- **Never sent:** anything the user typed, iRacing identifiers (customer, session, subsession, league, series IDs, iRating, licence, team name), car setups, times finer than a day. The endpoint never stores the IP.
- **Settings are reportable by type,** derived from the zod schemas so that a new setting is safe by default: booleans, numbers and members of a closed enum; free strings never.
- **Consent off by default;** asked in Getting Started, toggled under Settings → General, and asked once on the first Settings window open after updating to the release that ships it; never during a session, never popping up on its own; nobody asked twice.
- **Silent failure:** background, after startup has settled, about 5 s timeout, failures to the debug log only, no retry storms, a week's cap, a server-side off switch.
- **Endpoint hardening:** the same schema package as the plugin, a body cap, in-memory rate limiting, no stored IPs.
- **Privacy written once** as a website page, built into an offline Privacy pane (the #1061 pattern), with the content list from the issue; GDPR basis is consent.
- **All three plugins** get it through the shared `plugin-runtime` and the settings window.
- **Controller and contact (Niklas, 2026-11-28: "I'm responsible with niklas@iracedeck.com").** The Privacy page names Niklas Lampén, personally, as the controller, and niklas@iracedeck.com as the contact for access, erasure and any privacy question.
- **The iRacing event-type rulings (Niklas, 2026-11-28: "I think rulings hold").** A hosted online session with AI cars is `hosted`; official practice and pre-race practice are event `official`, kind `practice`; a live session in which the player's car never went on track (spectating, garage-only) is not reported. Section 5.4 has the model; the named captures are pinned as fixtures when recorded.
- **Delivery (coordinator decision, 2026-11-28):** one issue, one PR. The endpoint can be deployed from the issue branch for the manual test before merge, the Google Cloud setup is a maintainer checklist done before that test, and the test against the real endpoint gates the PR (section 12).

Everything below marked **(author's call)** was decided while writing this spec and is open to his veto through the PO; nothing else is.

## Context

The download counts (#685) say how many people install iRaceDeck and nothing about how it is used. The issue names the questions. The constraint that shapes everything here is that the repository, the endpoint and the schemas are public, and that a pseudonymous history of tracks and cars per install could be matched against iRacing's public results to name a person. The design is therefore built around one invariant, stated in *The privacy model*, and every mechanism is there to keep it.

## Approaches

### Where the data goes

1. **Our own endpoint: a Cloud Run function behind a Firebase Hosting rewrite, writing to BigQuery in the EU (picked, settled).** The site is already Firebase Hosting (`packages/website/firebase.json`, project `iracedeck`, deployed by `firebase-hosting-release.yml`), so the rewrite is one stanza and the endpoint shares the domain the plugin already talks to (changelog, update check, voice catalog). We decide exactly which columns exist, so the privacy page can promise exactly what is stored. At about 10 000 opted-in installs the traffic is roughly 10 000 requests and some 100 MB a day: inside the Cloud Run functions free tier (2 M requests a month), inside the BigQuery Storage Write API free tier (2 TiB a month), and storage of a few GB a year, which is cents a month after the first year. The costs are the Blaze plan and the maintenance of a small function.
2. **PostHog Cloud EU (rejected).** Ready dashboards, but a third-party processor that records IP and geolocation by default and models everything as events on a person, which is the shape this design is trying not to have; promising exactly what is stored becomes a promise about someone else's product configuration.
3. **Aptabase (rejected).** Privacy-first by deliberately not telling installs apart, so "days active", per-install layouts and "Delete my data" cannot exist.
4. **Cloudflare Workers + D1, or Supabase (rejected).** Another provider and another account for no capability the Firebase project lacks.

### How session rows stay unlinkable inside one request

The request carries the install ID and the session reports together, so the server sees both at once; the question is only what it keeps. **Picked:** the session rows carry no ID, no request id and no time finer than an ISO week; the function shuffles them and writes them in a separate write after the install rows; the dataset's time-travel window is set to its minimum, 48 hours, which bounds the only place BigQuery itself records a row's write time (`APPENDS` change history); the session table is clustered by track, which reorders storage away from arrival order. Rejected: a staging table moved daily by a scheduled query (it only replaces one 48-hour window with another and adds DML and a job); a Cloud Tasks hop with a random delay per session (a third product for a residual the time-travel bound already caps); two requests at different times of day (the plugin often runs only while iRacing does, so the second request would routinely not happen, and the maintainer chose one request). The residual is stated honestly on the Privacy page: for up to two days the database's own change history could relate a session row's write time to an install row's; after that nothing does.

### Where per-session usage counts live

1. **On the install report, split by session length range (picked, Niklas's decision).** Presses, dial ticks and callouts heard are keyed by action, mode (or contract id) and the scheduled length range of the session they happened in, with `no-session` for the rest. The questions they answer ("which keys do endurance drivers use", "which callouts play in sprints") need the length, not the track.
2. **Presses, dial ticks and callouts on each session report (rejected, the first draft's shape).** A session's press histogram spans about a hundred action × mode pairs and is close to unique per install; on a day with one session it is the same histogram as that day's install row. Matching the two re-links the install ID to the session's track and car, and repeating that across days rebuilds exactly the per-install history of tracks and cars that the split into two report kinds exists to prevent. With the counts only on the install side, the most an install row and a session row can share is a session's kind and length range in the same week, which thousands of session rows share (section 1 argues the rare cells).

## Design

### 1. The privacy model

| | Install report | Session report |
| --- | --- | --- |
| Identity | A random install ID: pseudonymous, never called anonymous | None of any kind: anonymous |
| Time | The UTC date it covers | The ISO week (its Monday) the session ended in |
| Place and kit | Plugin, deck host and Windows versions, device models | Sim, track (id, name, configuration), car (id) and car class |
| Usage counts | Presses, dial ticks, callouts heard, split by session length range | None |
| What it never holds | Tracks, cars, individual sessions, a day's event types | Any ID, plugin version, an exact time, any press, dial or callout count |
| Erasable | Yes, by install ID | No: nothing can find it; it expires by retention |
| Stored in | `usage.install_reports` | `usage.session_reports` |

**The invariant:** no stored row of one kind can be joined to a row of the other, and no install row describes a session well enough to be matched to one. The threat it answers is concrete: a pseudonymous install linked to the track, car and week of its sessions, day after day, is a history that small public result lists (a hosted or league session) could name a person from. Four consequences follow, each a decision:

- **No usage counts on the session report (Niklas's decision).** A per-session press histogram is a fingerprint that matches the install row of a one-session day exactly (*Approaches*); presses, dial ticks and callouts heard are counted only on the install report, split by length range.
- **The install row carries no per-day event type (author's call; the issue's list had it).** The day's sessions are tallied by kind and by scheduled length range, as two separate tallies. The builder check is right that on a day with one session two marginals are the joint, so the joint is what has to be safe. What an install row and a session row can then share is `(kind, scheduled length range, week)`: 6 kinds × 8 length values, over a week of every opted-in install's sessions (some 100 000 rows at 10 000 installs). The common cells (a race of 20–45 minutes) hold thousands of rows, so a match there says nothing. The rare cells (a qualifying session scheduled over six hours) can hold a handful, and that is the residual: one week's track and car for one install, and only while the install keeps landing in a rare cell. Event type is removed from the install side because it is the dimension that singles out exactly the sessions with small, nameable fields (league and hosted); a rare cell without it still mixes official specials, leagues and hosted events, whose official fields are large and whose small ones cannot be told apart from them. The event mix survives as the 28-day `eventMix` trait, which never names a day. Further coarsening (dropping the length split) was rejected: it is the axis Niklas's decision splits the usage counts by, so it would remove the feature's purpose.
- **Track and car ids add no linkage (Niklas's decision, checked here).** They live only on the ID-less session row; the install row carries no track and no car of any kind, so there is nothing on the install side for them to match, and every match path above is unchanged by them. What they do to a session row on its own: track, car and week narrow it to the drivers of that car at that track that week, a split-sized group at the smallest (a hosted session, a league grid), never to one person, because the row holds nothing about the driver, no result, no position, no lap time and no day. The ids replace nothing a name did not already say; they make rows comparable across renamed tracks and across sims' naming.
- **Traits need five sessions (author's call).** A trait over a 28-day window that saw one session would be that session's event type and length, the joint again; every trait reads `none` until its window holds at least five counted sessions.
- **The session report carries no plugin version (author's call).** The settled field list omits it, and a rare version (a pre-release, a stale install) is exactly the kind of field that narrows an anonymous row to a few installs.
- **Publication needs at least ten installs per group.** Anything published or shared is an aggregate over groups of at least ten distinct installs (install data) or ten session reports (session data); this is on the Privacy page as a promise.

### 2. Packages and where things live (author's call)

Three new packages, each with its own `CLAUDE.md` and an entry in the project `CLAUDE.md`:

- **`@iracedeck/usage-report`: the wire contract, a zod-only leaf** (the `@iracedeck/callout-script` precedent). The envelope, the install and session report schemas, the vocabularies and length buckets, the erase request, the response, and the type rule of section 4 (`reportableValues` and the typed `usageMeta()` helper the schemas annotate with). Nothing that only the client needs lives here. The plugin builds and validates with it and the endpoint validates with it, so the two cannot disagree about what a valid report is; that is the whole reason for the package. `zod` is its only dependency.
- **`@iracedeck/usage-data`: the client.** Install ID and retired IDs, the usage file, the counting wrapper and `UsageActionDescriptor`, the session capture, the day aggregator and traits, the queue, the sender, the consent and erase state machine with `USAGE_DATA_SCOPE`, the preview, and the two interfaces it reads the rest of the plugin through: `UsageSim` (section 5.4) and `UsageSources` (section 5.8). Depends on `usage-report`, `@iracedeck/event-bus` (the `SessionDescriptor` and `SessionKind` read types), `@iracedeck/settings` (the consent key, `createFileSettingsStore`, `GlobalSettingsSchema`, the warnings observer), `@iracedeck/logger`, `@iracedeck/fetch-utils` (`abortAfter`, `readCappedJson`), `@iracedeck/app-constants` (`UnitSystem`, key names), and `@iracedeck/deck-core` for types only (`IDeckActionHandler`, `DeviceType`).
- **`@iracedeck/usage-endpoint`: the function.** A pure handler, the BigQuery writer, the rate limiter, a dev server, the committed BigQuery DDL and scheduled-query SQL. Bundled by its own Rollup config into `dist/` with `usage-report` and `zod` inlined (Cloud Build installs from npm and cannot resolve a workspace package), the Google packages left external and listed with exact versions in a generated `dist/package.json` (the plugins' runtime `bin/package.json` pattern). Not part of any plugin build.

All three join `SIM_NEUTRAL_PACKAGES` in `eslint.config.js`.

Why a separate client package rather than `deck-core` or `plugin-runtime`: `deck-core` is the deck abstraction and gains nothing usage-specific (the counting wrapper takes `deck-core`'s handler type, as `withPressSounds` does, but lives with the recorder it feeds); `plugin-runtime` is the composition root and only wires. Why the descriptor and the scope live in the client, not the contract: neither ever crosses the wire, and the endpoint must bundle nothing it does not validate with.

**New dependency edges**, each a task on the Architecture page (`docs/development/architecture.md`) beside the new packages and the outbound data flow:

| From | To | Why |
| --- | --- | --- |
| `plugin-runtime` | `usage-data` | `initUsageData`, the wrapper, `UsageSim`, `UsageSources` |
| `plugin-runtime` | `usage-report` | the closed vocabularies it maps sources onto when filling `UsageSources` |
| `iracing-actions` | `usage-data` | `UsageActionDescriptor`, typing `usage-catalog.ts` |
| `settings` | `usage-report` | the typed `usageMeta()` annotations on `GlobalSettingsSchema` fields |
| `usage-data` | `event-bus` | `SessionDescriptor`, `SessionKind`, `TrackIdentity` |
| `usage-data` | `usage-report`, `settings`, `logger`, `fetch-utils`, `app-constants`, `deck-core` (types) | as above |
| `usage-endpoint` | `usage-report` | validation, bundled |

### 3. The report schemas

All objects are `.strict()`: an unknown key is a refusal, so a field reaches the table only through a schema change. Strings the client cannot control the content of (track, car class) are capped at 100 characters and refused with a control character; every other string field is a closed enum or a slug (`/^[a-z0-9][a-z0-9._:-]{0,63}$/`). Every array and record has an entry cap.

**Slugs and enums.** A field whose values the client derives from something open-ended is a slug: `sim` (the catalog's sim-id grammar, lowercase letters, digits and hyphens, the shape of `IRACING_SIM_ID`), a device model (`<host>:<model>`, e.g. `elgato:stream-deck-plus`, `mirabox:unknown`), an action key, a mode, a setting path, a callout id, an error kind. A field whose values this spec enumerates is a closed enum: event type, session kind, length buckets, traits, binding state, channel, units. **A new value in a slug field is not a new schema version; a new member of a closed enum is.** That is what lets a new action, mode, setting, deck model or sim reach the table without a release of the endpoint.

**Versioning (author's call):** the envelope carries `schema: 1`. Any change to a report's shape is a new schema version, added beside the old one as a discriminated union member; the endpoint accepts every version it has ever accepted, because plugins in the field keep sending theirs, and a version is never edited after a release ships it. The endpoint deploys from `master` before the plugin that needs a new version is released, which is safe precisely because it only ever accepts a superset. BigQuery stores `schema` on every row.

**The envelope:**

```json
{
  "schema": 1,
  "installReports": [],
  "sessionReports": []
}
```

At most 8 install reports and 100 session reports; the whole body at most 256 KiB.

**Install report** (one per UTC day the plugin ran while opted in):

| Field | Content |
| --- | --- |
| `installId` | UUID v4 |
| `date` | `YYYY-MM-DD`, the UTC day covered |
| `build` | `pluginVersion`, `channel` (`stable` / `prerelease`), `platform` (`getPluginPlatform()`), `host` (`adapter.hostApplication`: name and version), `windows` (`os.release()`), `arch` — the facts `plugin-runtime`'s `readBuildInfo` already reads |
| `sim` | the sim slug (`iracing`), or `none` on a day without a sim connection |
| `devices` | Per device slug `<host>:<model>`, the number of decks seen that day: on Elgato the `DeviceType` member from `deck-core`'s `device-profiles.ts` in kebab case, `<host>:unknown` where the host reports none (Mirabox, Ulanzi today) |
| `layout` | Per action, mode and surface (`key` / `dial`), the number of distinct contexts that appeared that day |
| `presses` | Per action, mode, surface (`key`, `dial`, `touch`) and session length key, the count |
| `dialTicks` | Per action, mode and session length key, the absolute rotation ticks |
| `callouts` | Per Race Engineer contract id and session length key, the number started on the Voice bus |
| `minutes` | `plugin` (process alive), `sim` (sim connected) |
| `sessions` | Two separate tallies of the day's reported sessions: by kind, and by scheduled length value; no event type (section 1) |
| `traits` | Locally derived over the last 28 days: `raceLength` (`sprint` / `mid` / `endurance` / `mixed` / `none`), `eventMix` (`official` / `league` / `hosted` / `ai` / `mixed` / `none`), `team` (`solo` / `team` / `mixed` / `none`) |
| `settings` | Global settings that pass the type rule (section 4), path → value |
| `actionSettings` | Per action, setting path and value, the number of contexts holding it |
| `bindings` | Per known binding key, `unbound` / `keyboard` / `simhub` |
| `voicePack` | `<pack>::<voice>` when the active voice is from the official catalog or the bundled pack, otherwise `custom`; `none` when the Race Engineer has never had a voice |
| `displayUnits` | `metric` / `imperial` / `unknown`, the sim's last reported choice through `UsageSim.getUnitSystem()` (`UnitSystem`, `app-constants`' `display-units.ts`) |
| `nativeAddons` | The load kind of each native addon (`Core.nativeAddons`, #1373), never an error text |
| `errors` | Per code-owned kind, a count (section 5.6) |

"Days active" is not a field: it is the number of report rows per install, which the server can count.

**Session report** (one per sim session the player was present in for at least two minutes):

| Field | Content |
| --- | --- |
| `week` | `YYYY-MM-DD` of the ISO week's Monday in which the session ended |
| `sim` | the sim slug (`iracing`) |
| `eventType` | `official` / `hosted` / `league` / `ai` / `test` / `other` (`other` is the wire's name for a descriptor's `null`) |
| `kind` | `test` / `practice` / `qualifying` / `race` / `replay` / `other` (likewise) |
| `team` | boolean |
| `scheduled` | a length bucket, `laps-only` or `unlimited` |
| `driven` | a length bucket, or `none` when the player's car was on track for under a minute |
| `track` | `id` (the sim's own track id), `name`, `config` |
| `car` | `id` (the sim's own id for the player's car), or `null` when the sim did not say |
| `carClass` | the player's car class short name |

**Track and car ids are sim-neutral on the wire.** The row's `sim` says whose ids they are, so neither object repeats it; each id is the sim's own id written as a string in the id grammar `/^[A-Za-z0-9._-]{1,64}$/` (iRacing's numeric `TrackID` and `CarID` become `"341"` and `"67"`), so a second sim whose ids are strings needs no new schema version. An id is a slug-shaped field in the sense of the versioning rule below.

Nothing else: no press, dial or callout count of any kind (Niklas's decision, section 1).

**The session length key** splits the install report's usage counts: the scheduled length value of the session open when the press, turn or callout happened (a length bucket, `laps-only` or `unlimited`, known when the session opens), or `no-session` when none was. Scheduled rather than driven because it is known at the moment of the press and is what a driver chooses ("a sprint", "a six-hour race"); driven length is only known at the end. A session too short to be reported still keys its presses by its scheduled length: the counts are the install's, and they say nothing about the session's row.

**Length buckets** (author's call on the edges, which follow the issue): `lt20m` [0, 20 min), `20-45m`, `45-90m`, `90m-3h`, `3-6h`, `gt6h` [6 h, ∞); lower edge inclusive. A session below two minutes of presence is not reported at all (loading, a joined-and-left server, a session transition). A live session in which the player's car was never on track is not reported either: spectating an online session, and sitting in the garage for a whole session, are the same thing to the data, a session the player never drove (settled ruling, section 5.4). "Driven" below one minute is `none`. Replays are reported (`kind: replay`, driven `none`): which replay actions people press is one of the questions.

**The other two bodies:** the erase request `{ "schema": 1, "installIds": ["…"] }` (1 to 16 UUIDs) and the response `{ "accepted": boolean, "stop"?: true }`.

### 4. What a setting may report: the type rule

One function in `usage-report`, `reportableValues(schema, parsed)`, decides for global settings (`GlobalSettingsSchema`) and for every action's settings schema alike. It walks the zod 4 object shape (`schema._zod.def`), unwrapping `default`, `catch`, `optional`, `nullable`, `readonly` and following a `pipe` to its output side, and recurses into nested objects with dotted paths (`dial.pressAction`). A leaf is reported only when the schema and the parsed value agree:

| Schema leaf (output side) | Parsed value | Reported |
| --- | --- | --- |
| `boolean`, or a pipe from a union containing `boolean` into a transform | a boolean | yes |
| `enum` (closed) | a member of its options | yes |
| `number` with both `min` and `max`, range at most 10 000 | a finite number in range | yes |
| `number` unbounded on either side, or wider than 10 000 | anything | no |
| `string`, `literal` text, `record`, `array`, `union` of anything else, a transform whose output is not boolean | anything | no |
| a passthrough key (not in the shape at all) | anything | no |

- **Safe by default.** A new free-text setting is a `string` and is never reported; a new identifier-like number is unbounded or wide and is never reported; only a field that is structurally incapable of holding free text passes. That is why the rule keys on both sides: a transform's output type cannot be introspected, so a transform field passes only when the value it produced is a boolean, which cannot carry text.
- **The range bound is what keeps `simHubPort` out** (1–65535), with the other things a user types as numbers; every slider and step field in the schema today (volumes 0–100, delays 0–2000 ms, cooldowns 1–360 s) sits well inside it. A field the rule would wrongly admit is excluded with zod 4 metadata, `.meta(usageMeta.never())`, which the walker honours; a transform field with a closed output (`focusIRacingWindow`'s mode) is admitted only by `.meta(usageMeta.closedOutput(FOCUS_IRACING_MODES))`, and then still only when the value is a member. Metadata can narrow, or widen to a closed list; it can never admit a free string. The helpers are typed and exported by `usage-report`, so a misspelt annotation fails to compile rather than being silently ignored; that is the `settings` → `usage-report` edge.
- **Never reported as a consequence, not as a list:** `driverName`, `simHubHost`, `simHubPort`, the setup-warning patterns, the `profileForSessionKind*` profile names, `raceEngineerVoice` (a string; the voice is reported separately and only as catalog-or-`custom`), every title and colour in an action's settings, every passthrough key (`_lastSeenVersion`, `_settingsChannel`, bindings).
- **Bindings** are passthrough keys and so outside the walk; `bindings` reports, for each key in the list the settings window renders (`iracing-actions`' `key-bindings.json`, handed in through `UsageSources`), only whether it is unbound, a keyboard binding or a SimHub binding (`isSimHubBinding`), never the key, modifiers, code or role (author's call).
- **Action settings** are aggregated, not listed per key: per action, path and value, the number of contexts holding it, with at most 20 distinct numeric values per path (the rest folded into one `other` count). Each action's schema comes from its usage descriptor (section 5.3).
- **Callout opt-ins, the Race Engineer, radar and spotter gates** are booleans in `GlobalSettingsSchema` and are reported by this rule, not by fields of their own.

A path-scoped rule, `.claude/rules/usage-data.md`, states the type rule for whoever adds a setting: a setting is reportable only by its type, free text never, and narrowing or widening goes through the metadata above, never through a hand list.

### 5. The client

#### 5.1 The install ID

A UUID v4 from `crypto.randomUUID()`, derived from nothing about the user, the machine or the iRacing account. Minted on the first opt-in, never before.

**Retired IDs (author's call).** An ID stops being used on opt-out, "Reset my ID" and "Delete my data"; the first two move it to a local `retiredIds` list (at most 10, each dropped 25 months after retirement, when the server's copy has expired anyway) for one purpose only: "Delete my data" erases every ID this install still remembers, so resetting or opting out never strands data the user can no longer delete. A retired ID is never sent with a report again, and the next opt-in or reset mints a new one, so a re-opt-in is not linked to the old rows.

Each deck host's plugin keeps its own usage file (section 5.2), so a PC running two hosts is two installs. Accepted and stated.

#### 5.2 The usage file (author's call)

`usage-data.json` beside the settings file (`resolveSettingsStorePath`'s folder, so `IRACEDECK_SETTINGS_PATH` moves it too), written through `@iracedeck/settings`' `createFileSettingsStore` with its `validate` and `rejectedFallback` options, exactly as `cameras.json` is (#1653): atomic replace, debounce, the exit `flushSync`, a corrupt file moved aside. It holds the install and retired IDs, the pending erase, today's open aggregate, the open session, the sealed queue, the 28-day trait tallies, the last sent envelope and its date, the off-switch marker and the next send time; its own zod schema, with the queued reports validated by `usage-report`'s.

Rejected: passthrough keys in the global settings. Every write there re-parses the whole cache, fans out to every listener and Property Inspector, and rides the once-per-start host mirror into the deck host's own settings file; a counter bumped on every press does not belong in that path, and neither does the install ID. A corrupt usage file costs only its contents: a new ID is minted on the next opt-in check and the old rows expire by retention.

State is persisted every five minutes while dirty, at every seal and session close, and on exit; never per press.

#### 5.3 Counting presses, dial turns and the layout

`withUsageCounting(handler, descriptor, recorder)` in `usage-data`, the shape of `deck-core`'s `withPressSounds`: every `IDeckActionHandler` member is forwarded unchanged; the wrapper records, synchronously and inside its own `try`/`catch`, before forwarding. `onWillAppear` and `onDidReceiveSettings` register the context's action, mode, surface (`action.isDial()`), `deviceType` and `deviceId`; `onWillDisappear` forgets it; `onKeyDown`, `onDialDown`, `onTouchTap` count a press on their surface; `onDialRotate` adds `|ticks|`. Every count goes into today's install aggregate under the current session length key, which the session capture holds (section 5.4) and the recorder reads as one field; nothing is counted into the session. While usage data is off the recorder returns at its first line, so an install that never opted in pays one boolean read per event. A throwing recorder never reaches the handler; the press always happens.

`plugin-runtime`'s `registerActions` wraps outermost: `withUsageCounting(withWindowFocus(withPressSounds(action.create(…))), { key: usageKeyOf(action.uuid), ...action.usage }, usage.recorder)`. Outermost so a press whose focus fails still counts, and because the recording is synchronous and O(1) it cannot move the press-sound timing that put `withWindowFocus` outside `withPressSounds` (#1654).

**The descriptor.** `ActionRegistration` (`plugin-runtime`'s `src/types.ts`) gains a required `usage: UsageActionDescriptor`, so an action cannot register without one: the compiler is the coverage check. The type is `usage-data`'s: `{ settings, mode?, dialMode? }`, where `settings` is the action's zod settings schema and `mode` / `dialMode` the dotted paths to the key and dial mode fields. The values live in one module, `iracing-actions`' `src/actions/usage-catalog.ts`, beside `comms-catalog.ts`, whose `modeSetting` records it reuses. The reported mode is the field's value only when it is a member of that field's enum, read from the schema by the same walker; anything else is `other`, and an action with no mode reports `-`.

**The action key is derived, not declared.** `registerActions` reports each action under `usageKeyOf(uuid)`, the last dot-separated segment of its registration UUID (`com.iracedeck.sd.core.fuel-service` → `fuel-service`). A descriptor that also carried a key would be a second name that can drift from the UUID; the UUID is already a published contract. The legacy Camera Cycle UUID comes out as `camera-cycle` by itself, so its last users show up before anyone retires it. A test runs `usageKeyOf` over every registration of all three hosts (the shared list and the Stream Deck extras) and requires the keys unique and kebab-case.

**Devices and decks** are counted from the contexts seen that day: models by `deviceType` as `<host>:<model>` slugs, decks as distinct `deviceId`s, which are never sent.

**Callouts heard.** `audio-scenarios`' scenario engine gains a read-only observer, `onCalloutStarted(listener: (contractId) => void)`, fired when a fire starts on the Voice bus. The id is a code-owned contract id (#1064), and the recorder keeps it only when it is in the registered catalog's id list, otherwise `other`, counting it into today's install aggregate under the current session length key like a press; both the list and the subscription reach `usage-data` through `UsageSources`. Sim-neutral, so it adds nothing to the audio package's seams.

**Errors: boundary reports.** `@iracedeck/logger`'s `createErrorBoundary` (#1558) gains two options: a required, code-owned `name`, and an optional `classify(id) => string | undefined` that each dispatcher answers from its own tables. The observer receives `(name, subKey?)`, never the reporter id, which carries registration numbers and function names. The boundaries and what they give:

| Boundary | `name` | `classify` |
| --- | --- | --- |
| `SDKController` (`iracing-sdk`) | `sdk-controller` | none: name only |
| the translator's tick steps (`sim-events-iracing`) | `translator-step` | the step's name, from its step table |
| the event bus (`event-bus`) | `event-bus` | the event name stored with the subscription |
| sim presence (`deck-core`'s `sim-connection.ts`) | `sim-presence` | none |
| the harness's mock controller (`scenario-harness`) | `harness-sdk-controller` | none; the harness never reports usage, it only has to compile |

The observer registry is the one process-global in `@iracedeck/logger` (`observeBoundaryReports(listener)`, with `_resetBoundaryObservers()` for tests), recorded as such in logger's `CLAUDE.md`. Process-global because the boundaries are created deep in packages that know nothing of usage, and threading an observer through every constructor would touch every dispatcher's public options for one consumer; one registry with a test reset is the smaller surface. `UsageSources` hands the subscription to `usage-data`, which counts `name` or `name:subKey` as a slug.

**Errors: warning banners.** `@iracedeck/settings` gains one observer at the `_warnings` write, `onWarningRaised(listener: (id) => void)`, called from the single place both writers (`setWarning` and `reconcileWarnings` in `pi-warnings.ts`) write the key, for each id that is newly present. `plugin-runtime` assembles the known ids from each producer's exported constant (the setup warning, the settings-file rejection, the settings window's, the native addons', the voice-script banner) and hands the list and the subscription to `usage-data` through `UsageSources`; any id not on the list is counted as `other`, so a producer added later costs nothing but an `other` until it is listed.

#### 5.4 Sessions, through the sim seam

`usage-data` declares the one interface it reads the sim through:

```typescript
export interface UsageSim {
  /** The current session described, or null when there is none. */
  getSessionDescriptor(): SessionDescriptor | null;
  /** Whether the player's car is on track now; null when unknown. */
  isPlayerOnTrack(): boolean | null;
  isConnected(): boolean;
  /** The unit system the sim displays in; null before it has said. */
  getUnitSystem(): UnitSystem | null;
  /** The sim's after-tick hook (HostSim.onTick's contract). */
  onTick(listener: () => void): () => void;
  /** Each session change, as the catalog's `session.changed` reports it. */
  onSessionChanged(listener: () => void): () => void;
  /** Each time the sim exits. */
  onSimTerminated(listener: () => void): () => void;
}
```

**`SessionDescriptor` is a sim-neutral read type in `@iracedeck/event-bus`'s catalog**, beside `SessionClass` (#1587): a fact the translator answers through a resolver, never publishes. It is general rather than usage-shaped, so a later reader may use it, and it carries raw values; bucketing is `usage-data`'s policy:

```typescript
export type SessionDescriptor = {
  /** The sim's id, in the catalog's sim-id grammar (`"iracing"`). */
  readonly sim: string;
  /** null when the sim's session does not fit one of the five kinds. */
  readonly kind: SessionKind | null;
  /** null when the sim's description fits none of the event types. */
  readonly eventType: "official" | "hosted" | "league" | "ai" | "test" | null;
  readonly team: boolean;
  /** null for a session with no time limit. */
  readonly scheduledSeconds: number | null;
  /** null for a session with no lap limit. */
  readonly scheduledLaps: number | null;
  readonly track: TrackIdentity;
  /** The player's own car; null when the sim has not said. */
  readonly car: CarIdentity | null;
  /** The player's car class as the sim names it; "" when it names none. */
  readonly carClass: string;
};
```

- **`SessionKind` moves into the catalog** beside `SessionCategory`; `sim-events-iracing`'s `session-kind.ts` re-exports it, so no importer changes, and `plugin-runtime`'s `SessionKindsAgree` pin in `src/phases/sim.ts` stays as it is.
- **`TrackIdentity`** is extracted from `PitLaneTrackIdentity` (`sim`, `trackId`, `trackName`, `trackConfigName`), which then extends it with its version and length fields; one track identity in the catalog, not two.
- **`CarIdentity`** is new, in the same style: `{ sim: string; carId: number; carName: string }` (the sim, its id of the car, its name of the car). The descriptor holds it nullable, since a session can be read before the player's car is known (spectating, a replay with no player car); `usage-data` sends `carId` only, written as a string, and `null` when the descriptor's `car` is.
- **Nullable, not `other`.** The catalog says "unknown" as `null`; `other` is a wire value, and only `usage-data` produces it.
- **No units.** Display units are not a fact about the session; they come from `UsageSim.getUnitSystem()` (below).
- **No iRacing identifier.** The translator reads `LeagueID` and `Official` to classify the event type and returns only the class.

It is a catalog change, reviewed at `xhigh`. **The pin is one-way and exhaustive**, in `usage-data`: `const WIRE_KIND = { … } satisfies Record<SessionKind, WireSessionKind>` (and the same for the event type), with `null` mapped to `other`. A kind added to the catalog then fails to compile until the wire has a value for it, while the wire is free to keep `other`, which the catalog never has; a two-way equality would force the two vocabularies to be identical, which they deliberately are not.

**The iRacing side** is `sim-events-iracing`'s new `getSessionDescriptor()` and `isPlayerOnTrack()`, beside `getSessionKind()`:

| Field | iRacing source |
| --- | --- |
| `eventType` | `official` when `WeekendInfo.Official` is 1; `league` when `LeagueID` is above 0; `test` for `Offline Testing` / `EventType: Test`; `ai` for an offline session with AI opponents (`CarIsAI` in `DriverInfo.Drivers`); `hosted` for any other online session, AI cars included; `null` for anything else |
| `kind` | `classifySessionKind` (#1111) |
| `team` | `WeekendInfo.TeamRacing` |
| `scheduledSeconds` / `scheduledLaps` | the current `SessionInfo.Sessions[]` entry's `SessionTime` and `SessionLaps`, `null` for `unlimited` |
| `track` | `TrackID`, `readTrackDisplayName`, `readTrackConfigName`, under `IRACING_SIM_ID` |
| `car` | the player's entry in `DriverInfo.Drivers` (at `DriverCarIdx`): `CarID` and `CarScreenName`, under `IRACING_SIM_ID`; `null` when there is no player car |
| `carClass` | the player's `CarClassShortName` |

**The event-type model is decided here, and confirmed by captures rather than waited for** (the repo's rule: no spec deferral for missing captures). Three rulings, **confirmed by Niklas (2026-11-28: "I think rulings hold")**:

- A hosted online session with AI cars in it is `hosted`, not `ai`: `ai` means the player raced the AI offline.
- Official practice, and the registration or pre-race practice before an official race, are event `official`, kind `practice`.
- Spectating an online session is not reported as a session: the player never drove (section 3's rule for a live session never on track).

The captures that confirm the model: a league session, a hosted online session, a team event, a hosted session with AI cars, and spectating an online session. Implementation proceeds on fixtures built from the existing `local/` session-info snapshots; each new capture is pinned as a fixture of `getSessionDescriptor()` when Niklas records it, and a capture that contradicts a row changes the row, not the model's shape.

**Wiring:** `plugin-runtime`'s `initSim` builds the `UsageSim` beside `HostSim`, as `HostSim` is built (#1500): `getSessionDescriptor`, `isPlayerOnTrack` and `onTick` from the translator; `onSessionChanged` from the bus's `session.changed`; `onSimTerminated` from `deck-iracing`'s `onIRacingTerminated`; `isConnected` from the controller; `getUnitSystem` as `deck-iracing`'s `unitSystemOf` over the controller's latest `DisplayUnits`. `unitSystemOf` stays where #1662 put it, in `deck-iracing`: the composition root reads it there, and the translator never needs it. A separate interface per reader, never members added to another's surface.

**Boundaries.** The capture opens a session on the first tick with a descriptor, and closes it on `onSessionChanged` (the catalog's own boundary, so the translator's identity rule #1509 decides, not this package), on disconnect, on `onSimTerminated` and on plugin exit (where the partial session is sealed and queued by the exit flush). A live session closed without the player's car ever on track is discarded. While a session is open the capture exposes its session length key (its scheduled length value) to the recorder, and `no-session` otherwise; the open session itself holds only the descriptor, its presence and driven times, and never a usage count. Presence time is wall time while open; driven time accumulates on ticks where `isPlayerOnTrack()` is true. Ticks are sampled at most once a second, so the capture costs nothing per tick beyond a timestamp compare.

#### 5.5 The day, sealing, traits

Counters accumulate into today's aggregate (UTC date). A 60-second `unref`'d timer, running only while opted in, adds plugin minutes and, while `isConnected()`, sim minutes, and checks for a date change. On a date change or at a start that finds an older open aggregate, the day is sealed: the settings, action-settings histogram, bindings, voice pack and units are read at that moment, the report is validated against `usage-report`'s schema (an invalid item is dropped with a debug line, never queued), and it joins the queue. The 28-day trait tallies count each closed session's kind, event type, team and scheduled bucket per day, and the traits are derived from them at seal: a value is the trait when at least 60 % of the races (or sessions, for `eventMix` and `team`) carry it, `mixed` otherwise, and `none` until the window holds at least five counted sessions (section 1; author's call).

#### 5.6 Sending, failure, the off switch

- **When.** At most one attempt a day. The first opportunity is three minutes after `whenSettingsStoreSettled()` plus a random 0–10 minutes, then every 30 minutes the sender checks whether a send is due; it waits while a session is open (no request during a race, author's call) and is skipped entirely while usage data is off. A dev build (a `-dev` version) never sends, unless `IRACEDECK_USAGE_ENDPOINT` names another endpoint, which is how QA points a build at the local dev server.
- **What.** One envelope: queued install reports oldest first, then session reports, packed until the encoded body reaches 200 KiB; the rest waits for the next day.
- **How.** `fetch` with `abortAfter(5_000)` from `@iracedeck/fetch-utils`, `POST https://iracedeck.com/api/usage/report`, JSON, no cookies; the response read with `readCappedJson` under 4 KiB.
- **Outcomes.** `200` with `accepted`: drop what was sent, keep the envelope as "last sent", schedule the next day. `200` with `stop`, or `410`: the off switch. `400` or `413`: drop what was sent (the client validated it, so this means a contract mismatch nobody should retry). `404`, `429`, `5xx`, a timeout or a network error: keep everything, try again the next day. Never a retry within the day, so nothing can storm.
- **Caps.** Items older than 8 days are dropped at each seal, and the queue holds at most 100 session reports.
- **Failures are silent.** One debug line per outcome; never a warning banner, never an `info` line, never anything in a key or the window beyond the accordion's status line.
- **The off switch.** The usage file records `stoppedForVersion` with the running version and the client stops counting and sending and drops its queue, until a build whose version is semver-newer starts; the toggle keeps the user's choice and the accordion says collection is paused by iracedeck.com until the next update. Erasure is not affected by it.

#### 5.7 Opting out, resetting, deleting

| Action | Effect |
| --- | --- |
| Opt out (toggle off) | Stop counting at once; drop today's aggregate, the open session and the whole queue; retire the install ID. Nothing is sent after the toggle moves. |
| Reset my ID | Retire the current ID and mint a new one; drop the queued install reports (sending old-ID and new-ID rows in one request would link them), keep the queued session reports, which carry no ID; today continues under the new ID. |
| Delete my data | Queue an erase of the current and every retired ID, drop the queue and today's aggregate; mint a new ID when still opted in (continuing under an erased ID would be deleted again by the server's daily job). The erase is sent at once and, when it cannot be, at every later send opportunity, whether or not usage data is on; it clears the retired list when accepted. |

The accordion says what is pending: "Deletion requested: it will be sent when iracedeck.com can be reached."

#### 5.8 Startup

`usage-data` declares a second interface for everything it reads that is not the sim, so it imports none of the packages those facts come from:

| `UsageSources` member | Filled by `initUsageData` from |
| --- | --- |
| `build` | `readBuildInfo(adapter)` |
| `nativeAddons` | `Core.nativeAddons` kinds |
| `bindingKeys` | `iracing-actions`' `key-bindings.json` list |
| `classifyVoice()` | the voice-pack service and catalog: `<pack>::<voice>`, `custom` or `none` |
| `calloutIds`, `onCalloutStarted` | the registered catalog's contract ids and the scenario engine's observer |
| `onBoundaryReport` | `@iracedeck/logger`'s `observeBoundaryReports` |
| `warningIds`, `onWarningRaised` | each producer's exported warning-id constant, and `@iracedeck/settings`' `onWarningRaised` |

A new phase, `initUsageData(core, sim, voicePacks)`, between `initRaceEngineer` and `initSettings`, fills `UsageSources`, takes `sim.usage` and returns `UsageData` (`recorder`, `service`): it constructs only, so it adds no effectful call before `startServices` beyond what the order test records. `initSettings` takes it for the window's commands, the preview route and the first-run stamp (section 6); `registerActions` takes `recorder`; `startServices` calls `service.start()` after `initGlobalSettings`, which loads the usage file, reconciles consent, subscribes the capture, the callout observer and the error observer, and arms the timers. `start-plugin.test.ts`'s `expectedOrder()` gains the phase's recorded calls.

### 6. Consent

#### 6.1 Keys

| Key | Kind | Meaning |
| --- | --- | --- |
| `usageDataEnabled` | Schema field, `union(boolean, string)` → boolean, `.default(false).catch(false)` (#896) | The toggle |
| `_usageDataAskedVersion` | Durable passthrough | The plugin version at which the user was asked; a version, never `true` (#1047, #1061) |
| `_usageDataConsentScope` | Durable passthrough | The `USAGE_DATA_SCOPE` (`usage-data`) the user consented under |

Named after `profileAutoSwitchEnabled` / `updateCheck` and `_firstRunVersion` (author's call); the names are `app-constants` constants the page and the plugin share, held equal to the schema by a test, as `PROFILE_AUTO_SWITCH_ENABLED_KEY` is. Neither passthrough key is run-scoped, and neither is kept by `readSettingsForSnapshot`.

**The asked marker is stamped by the plugin, never the page:** whenever `usageDataEnabled` changes (toggle, Getting Started button, ask card), when the ask card reports that it was shown, and when the first-run check opened Getting Started. For the last, `runFirstRunCheck` reports its outcome rather than a bare "consumed" boolean, and the store-ready step stamps the marker after a successful open: a fresh install's Getting Started block is its ask, so nobody is asked twice.

**The consent scope (author's call).** `USAGE_DATA_SCOPE` is 1 today. Adding a value to an existing field (a new action, a new setting, a new callout) is within the scope; a new category of data (a new report kind, a new kind of fact about the machine or the user) raises it. A build whose scope is higher than the stored one treats the stored consent as not given: it writes `usageDataEnabled = false`, clears the asked marker and so asks again on the next window open, saying what is new. That is the GDPR answer to "consent was for what was described at the time", decided now so that nobody widens collection under an old yes.

#### 6.2 Settings → General: the Usage data accordion

A new accordion after Press Sounds, rendered by a new `global-common-usage-data` partial around a new `ird-usage-data` component; the toggle is an ordinary global sdpi checkbox bound to `usageDataEnabled`.

```text
Usage data
  [ ] Share usage data
      Help shape iRaceDeck: a small daily summary of which actions, modes and
      features you use, and a short anonymous note after each session.
      No names, no iRacing account or session IDs, nothing you typed.
  Last sent: 27 Nov 2026            (or: Nothing sent yet / Paused by iracedeck.com
                                     until the next update / Deletion requested …)
  [See exactly what's sent]  [Reset my ID]  [Delete my data]
  Read what is collected and why →  (jumps to the Privacy pane)
```

- **See exactly what's sent** expands a read-only viewer with two tabs, *Next send* (the envelope that would be sent now, plus today's report still being collected, marked so) and *Last sent* (the stored envelope and its date), pretty-printed JSON from `GET /usage/preview`. While off it shows "Nothing is collected while sharing is off."
- **Delete my data** asks inline first: "This asks iracedeck.com to delete every daily summary stored under this computer's IDs. Session notes carry no ID, so nothing can find them; they are deleted after 24 months. [Delete] [Cancel]". Shown whenever there is an ID, current or retired.
- **Reset my ID** has no confirm; it loses nothing the user can see.

#### 6.3 The one-time ask

A card at the top of the window's content, above whichever pane opened, never a modal and never a window of its own. It renders when `usageDataEnabled` is off and `_usageDataAskedVersion` is absent, and not on a load whose fragment is `#getting-started` (that open is the ask; the fragment check covers the moment before the plugin's stamp lands). Rendering it sends `usageDataAskShown`, so closing the window without answering still counts as asked.

```text
Help make iRaceDeck better?
iRaceDeck can send a small daily summary of which actions and features you use,
under a random ID made on this computer, and a short anonymous note after each
session: the track, the car and roughly how long. No names, no iRacing account or session IDs,
nothing you typed. You can see exactly what's sent and turn it off any time.
[Yes, share usage data]   [No thanks]   What's sent? →
```

The window is only ever opened by the user (or by first-run, which never shows the card), so the ask can never appear during a session on its own.

#### 6.4 Getting Started

`first-steps.md` gains a short section, "Help shape iRaceDeck", whose prose stands without a control (the website renders none: "You can share usage data from the Settings window's General tab"), and the marker `<!-- ird:action enable-usage-data -->`. The partial's `ACTIONS` maps it to `<ird-enable-feature feature="usage-data">`; `ENABLE_FEATURE_COPY` gains the entry (action "Share usage data", done "Thanks. Usage data is on; see or change it under General → Usage data."), and `enableFeatureWrites("usage-data")` returns `{ usageDataEnabled: true }`.

#### 6.5 The window's plumbing

- `settings-window-commands.ts` gains `usageDataAskShown`, `usageDataReset` and `usageDataErase`, routed to delegates `plugin-runtime` injects (the package imports no usage code, as it imports no voice-pack code).
- `settings-window-server.ts` gains `GET /usage/preview`, answered by an injected `usagePreview()`, behind the same `authorizeSettingsRequest` as `GET /updates/status`; it takes no parameters. The server is `xhigh` code; the guard itself is unchanged.
- `PRIVACY_PANE` (`privacy`) joins the pane ids, and the accordion's jump uses the #1061 pane deep link.

### 7. The Privacy page and pane

**One source:** a new website page, `packages/website/src/content/docs/privacy.md` (`/privacy/`), linked from the site footer and from the settings docs page. **One artifact:** the Getting Started generator (#1061) is page-agnostic apart from its names, so its parser moves to `scripts/lib/pane-page-parse.mjs` and the generator emits `privacy.json` beside `getting-started.json`, committed and freshness-tested the same way; the post-edit hook's generator table gains the page (author's call). **One pane:** `settings-window-privacy.ejs` in `pi-components` renders it offline, in the nav slot #1815 reserved after License (`… Diagnostics, License, Privacy, Support iRaceDeck`); `SETTINGS_WINDOW_TABS` gains `{ pane: "privacy", label: "Privacy", file: "privacy.png", elgatoOnly: false }`. Its one action marker, `open-usage-data-settings`, jumps to the General accordion.

What the page covers, in this order (the wording is drafted and approved with the docs, not here):

1. Who is responsible and how to reach them: Niklas Lampén, personally, as the controller, at niklas@iracedeck.com for access and erasure requests and any privacy question.
2. What the plugin contacts iracedeck.com for without any opt-in: the published changelog for the update check (`updateCheck`), the voice-pack catalog, and the changelog page the browser opens after an upgrade (per `changelogNotification`); voice-pack downloads from GitHub. Each request shows the server the machine's IP address, as every web request does; none carries anything else about the user.
3. Usage data: off by default; the install report (pseudonymous: a random ID made on this computer, never called anonymous) and the session report (anonymous: no ID), each with what it contains and never contains, in plain words and with the field list. Said plainly: which keys you press, which dials you turn and which callouts you hear are counted only in the daily summary, split by how long the sessions were, and never in a session note, so a session note cannot be matched back to your summary; the daily summary never names a track, a car or the kind of event. The session note names the track and car by the sim's own ids as well as by name; those ids identify a track layout and a car model, never a driver, and sit only on the note that has no ID. The iRacing identifiers that are never sent are those of people and events: customer, session, subsession, league and series IDs, iRating, licence, team name. How to see exactly what is sent.
4. Where and how long: Google Cloud in the EU; reports deleted after 24 months; the IP address never stored, with the request-log measure of section 11 in one sentence; the two-day residual of *Approaches* in one sentence.
5. Sharing: "We may publish or share aggregate statistics that cannot identify any individual install", only over groups of at least ten installs; "we never sell your data"; "if iRaceDeck changes hands, this data goes with it under the same terms".
6. Your choices: opting out, resetting the ID, deleting data (and why session notes cannot be found to delete).
7. The legal basis (consent), Google as processor under its Cloud data processing terms, and the rights of access (what the plugin shows is what was stored; a copy on request), erasure and withdrawal.
8. The website's Google Analytics (#685): what it is, that it is the website's and not the plugin's.

### 8. The endpoint

`firebase-functions` v2 `onRequest` in `europe-west1` (author's call: a region Firebase Hosting rewrites to functions in, with the BigQuery dataset co-located), `maxInstances: 2`, `minInstances: 0`, 256 MiB, 10 s timeout, a dedicated service account holding only BigQuery Data Editor on the `usage` dataset. `firebase.json` gains `{ "source": "/api/usage/**", "function": { "functionId": "usage", "region": "europe-west1" } }` and a `functions` entry pointing at the endpoint's `dist/`.

The handler is a pure function of `{ method, path, contentType, rawBody, clientKey }` and injected `writer`, `limiter`, `clock` and `config`, wrapped by a thin adapter; the dev server and every test call it directly.

1. `POST` only, `application/json` only, to `/api/usage/report` or `/api/usage/erase`; anything else `404`.
2. Body over 256 KiB: `413`, unparsed.
3. Rate limit, in memory only: per instance, at most 20 requests an hour per client key and 4 report requests a day per install ID, plus a global 50 a second; over it, `429`. The client key is a SHA-256 of the forwarded address with a per-instance random salt, held for the hour and never written anywhere. `maxInstances` bounds the whole thing, so the limits are approximate by design: they exist to bound cost and noise, not to authenticate.
4. `UsageEnvelopeSchema.safeParse` from `usage-report`, the plugin's own schema; failure `400` with no detail beyond "invalid". Then the server-side date checks: an install `date` not in the future and at most 14 days old, a session `week` a Monday within the last three weeks.
5. Intake stopped (the `USAGE_INTAKE` parameter is `stop`): `200 { accepted: false, stop: true }`, nothing written.
6. Write the install rows, then the session rows, shuffled, in a separate write with no request id; install first because only install rows can be de-duplicated (by install ID and date) if a client retries after a half-failed write. Either write failing: `503`.
7. `200 { accepted: true }`.

The function logs one line per request at most: the outcome and counts, never a body, header or address.

### 9. BigQuery

Dataset `usage` in `europe-west1`, `max_time_travel_hours = 48`; DDL committed in `packages/usage-endpoint/bigquery/` and applied by the maintainer with `bq` (author's call: the CI deploy identity never needs dataset-admin rights). Writes through the Storage Write API default stream.

| Table | Partitioned by | Clustered by | Expiry | Notes |
| --- | --- | --- | --- | --- |
| `install_reports` | `report_date` (DAY) | `install_id` | 730 days | `require_partition_filter`; nested counts as `REPEATED RECORD`, `settings` / `action_settings` / `bindings` as `JSON` |
| `session_reports` | `week` (DAY; one partition per week) | `sim`, `track_id`, `car_id` | 730 days | `require_partition_filter`; no install or request ID, no timestamp column, no count column |
| `erasures` | `requested_date` (DAY) | `install_id` | 760 days | tombstones |

Views: `v_install_reports` (one row per install and date, erased IDs excluded) and `v_session_reports`; anything shared is queried through them.

**Cost controls:** partition filters required on both report tables; the project's custom quota *Query usage per day* at 30 GiB (the 1 TiB monthly free tier spread over a month), which hard-stops any query beyond it; a billing budget of $5 a month with alerts at 50, 90 and 100 %; `maxInstances: 2` on the function. Retention is partition expiration, so nothing has to run for data to leave.

### 10. Erasure

`POST /api/usage/erase` validates the request and inserts one tombstone per ID into `erasures`; `200`. Erased IDs vanish from the views at once. A scheduled query runs daily: `DELETE FROM install_reports WHERE install_id IN (SELECT install_id FROM erasures WHERE requested_date <= CURRENT_DATE() - 2)`. The two-day wait is what keeps the statement clear of BigQuery's restriction on DML over freshly streamed rows: the client stops writing under an ID the moment it erases it, so after two days no row for that ID can be fresh. The job runs over all tombstones each day, so a straggling row that arrived after the erase is deleted too. Tombstones expire after 760 days; by then nothing remains under them.

### 11. Logs and the IP

The IP reaches three places, and each is closed:

- **Cloud Run's request log** (`run.googleapis.com/requests`) records `remoteIp` by default. A Cloud Logging exclusion on the `_Default` sink for that log of the `usage` service drops it before storage; excluded logs are neither stored nor billed. The `_Required` bucket holds only audit logs, which carry no client address.
- **Firebase Hosting's own request logging** is an opt-in Cloud Logging integration; it stays off, and the maintainer setup says so.
- **The function** never logs a header or the address, and keeps the rate-limit key only as a salted hash in memory.

### 12. Deploy and maintainer setup

**Delivery (coordinator decision): one issue, one PR.** The client, the endpoint, the DDL, the workflow, the pages and the docs land together.

**The workflow,** `deploy-usage-endpoint.yml`, runs on a push to `master` touching only what the endpoint bundles (`packages/usage-endpoint/**`, `packages/usage-report/src/**`, `packages/usage-report/package.json`), and on `workflow_dispatch` from any ref with an `intake` input (`open` / `stop`). Dispatch serves two purposes: deploying from the issue branch for the manual test before merge, and the off switch, one workflow run away. It installs, builds and tests the endpoint, then runs `firebase deploy --only functions:usage` with `firebase-tools` at an exact version and a new, narrower service-account secret; third-party actions are pinned to a commit hash (#1663). **When its deploy secret or project configuration is absent it exits green with a `::notice::` saying the endpoint was not deployed and why, never red**, so a merge before the Google Cloud setup cannot turn `master` red (`scripts/` holds a test of that branch, as the voice-pack publish workflow's checks are tested).

**Why an early production deploy is safe.** No client sends to the endpoint before the release that ships the feature: release builds post only through the hosting rewrite, which goes live with the website at that release, and a dev build sends only when `IRACEDECK_USAGE_ENDPOINT` points it somewhere. Deploying from `master` (or the issue branch) is also safe for compatibility, because the endpoint accepts a superset of every schema version (section 3). Until the rewrite is live, a release candidate's request reads `404`, which the client treats as "try tomorrow".

**The maintainer's checklist,** done before the manual test, kept in the endpoint's `CLAUDE.md`:

1. The Blaze plan on the `iracedeck` project and its billing account.
2. Accept the Google Cloud data processing terms.
3. The `usage` dataset, tables, views and the scheduled erase query, applied with `bq` from the committed SQL.
4. Two service accounts: the function's runtime identity (BigQuery Data Editor on `usage` only) and the deploy identity, whose key becomes the workflow's secret.
5. The Cloud Logging exclusion for the `usage` service's request log, and a check that Firebase Hosting's Cloud Logging integration is off.
6. The custom query quota (30 GiB a day) and the $5 budget alert.

Manual-test step 10, against the real endpoint, gates the PR.

## Seams and packages touched

| Package or file | Change |
| --- | --- |
| `usage-report` (new) | The wire contract: schemas, vocabularies, buckets, `reportableValues`, `usageMeta` |
| `usage-data` (new) | The client, `UsageActionDescriptor`, `USAGE_DATA_SCOPE`, `UsageSim`, `UsageSources` |
| `usage-endpoint` (new) | The function, DDL, SQL, dev server |
| `event-bus` | `SessionDescriptor`; `SessionKind` moved in beside `SessionCategory`; `TrackIdentity` extracted from `PitLaneTrackIdentity`; `CarIdentity` new; the event-name classifier on its boundary (`xhigh`) |
| `sim-events-iracing` | `getSessionDescriptor()`, `isPlayerOnTrack()`; re-exports `SessionKind`; the step-name classifier on its boundary |
| `iracing-sdk` | `SDKController`'s boundary gains its `name` |
| `deck-core` | the sim-presence boundary gains its `name` |
| `scenario-harness` | its mock controller's boundary gains its `name` |
| `audio-scenarios` | `onCalloutStarted` observer on the engine |
| `logger` | `createErrorBoundary`'s `name` and `classify` options; `observeBoundaryReports`, the one process-global registry, with its test reset (recorded in its `CLAUDE.md`) |
| `settings` | `usageDataEnabled`; the `usageMeta` annotations; `runFirstRunCheck`'s outcome; `onWarningRaised`, one observer at the `_warnings` write covering `setWarning` and `reconcileWarnings` |
| `app-constants` | key names, `PRIVACY_PANE` |
| `iracing-actions` | `usage-catalog.ts`; the settings-window page: nav, Privacy pane, accordion, ask card |
| `plugin-runtime` | `initUsageData` and `UsageSources`, `Sim.usage`, `ActionRegistration.usage`, `usageKeyOf`, the wrap, the start, the window wiring, the warning-id list |
| `settings-window` | three commands, `GET /usage/preview`, `enableFeatureWrites("usage-data")` (`xhigh` for the server) |
| `pi-components` | `ird-usage-data`, `ird-usage-ask`, the privacy partial, the usage partial, `ENABLE_FEATURE_COPY` |
| `scripts/` | the pane-page generator and parser, `tabs.mjs`, the post-edit hook's generator table |
| `website` | `privacy.md`, `first-steps.md`, `settings.mdx`, footer link, `firebase.json`, the Architecture page (the three new packages, every new edge in section 2's table, and the outbound data flow), a changelog fragment |
| `.github/workflows/` | `deploy-usage-endpoint.yml` |
| `eslint.config.js` | `usage-report`, `usage-data` and `usage-endpoint` in `SIM_NEUTRAL_PACKAGES` |
| Rules and docs | new `usage-data.md` (path-scoped: the type rule, the privacy invariant), `global-settings.md` (the keys), `settings-window.md` (the route and commands), the project `CLAUDE.md` package list, `README.md` (features, structure) |

The three plugin shells are untouched, and `deck-core` only names its boundary: every host gets the feature through `plugin-runtime` and the shared window. The review level for the branch is `xhigh`: a persisted settings key, a sim-event catalog type, the settings-window server, and a published privacy promise all sit in that row.

## Trade-offs

- **Two more direct translator getters.** The architecture review's count of getters the composition root reads straight off the translator goes from 11 to 13 (`getSessionDescriptor`, `isPlayerOnTrack`). That follows #1500's `HostSim` pattern on purpose: `initSim` assembles a per-reader interface from the getters, so `usage-data` sees only `UsageSim`, and a second sim supplies its own getters to the same interface. The alternative, publishing session facts on the bus, would add catalog events for a value read on demand.
- **One process-global observer registry in `@iracedeck/logger`.** Accepted over threading an observer through every dispatcher's options (section 5.3), with a test reset and the fact recorded in logger's `CLAUDE.md`.
- **A two-day window in which BigQuery's change history could relate a session row's write time to an install row's** (*Approaches*), stated on the Privacy page.
- **Rare `(kind, scheduled length, week)` cells.** An install whose only session of a day falls in a cell few others share that week can be matched to that session's row, lending it one week's track and car (section 1). Accepted after removing the per-day event type, which is what made the dangerous cells rare; coarsening the length split instead would remove what the usage counts are split by.
- **Two deck hosts on one PC are two installs** (section 5.1).

## Out of scope

- Dashboards, saved analyses and any public statistics page; only the views of section 9 ship.
- The License pane (#1815), beyond taking the slot after it.
- Telemetry beyond what the settled field lists name: no crash dumps, no log upload, no CPU profiles, no performance timings.
- Any per-user or per-session view on the website, and any way to read one's own server-side rows other than the plugin's "last sent" copy and a request to niklas@iracedeck.com.
- Re-asking existing users when nothing in scope changed, and any reminder after "No thanks".
- A second sim's `SessionDescriptor` reader; the type is ready for it.
- Changing what the plugin already sends without opt-in (update check, catalog); the Privacy page only describes it.

## Testing

**Unit and integration (CI):**

- **`usage-report`:** every schema refuses an unknown key, an over-cap array, a long or control-character string, a non-slug enum-ish string; the envelope's caps; bucket edges at 19:59/20:00, 45, 90, 180 and 360 minutes; the response and erase shapes. **The session report holds no usage count:** a test asserts its schema's keys are exactly the raced fields (`week`, `sim`, `eventType`, `kind`, `team`, `scheduled`, `driven`, `track`, `car`, `carClass`) and that a session report carrying `presses`, `dialTicks` or `callouts` is refused; track and car ids accept a numeric-string and a non-numeric id alike and refuse one outside the id grammar, and `car` accepts `null`; the install report's schema has no track or car field at any depth; another asserts the install report's `sessions` tallies have no event-type key.
- **The type rule, with a positive control** (the reason this suite exists). Over the real `GlobalSettingsSchema` and every action schema in `usage-catalog.ts`, a test plants a unique sentinel string in every string leaf the schema has (found by the same walk), a sentinel number in every unbounded or wide number, and known values in `driverName`, `simHubHost`, `simHubPort`, both setup-warning patterns, all five profile names, `raceEngineerVoice` and a binding; it then asserts no sentinel appears anywhere in the serialized output. The control runs first: the same detector run over the raw parsed settings must find every sentinel, so a detector that finds nothing cannot pass. A synthetic schema covers each row of the rule's table, `usageMeta.never()`, the closed-output widening, and that metadata cannot admit a free string.
- **Slugs and enums:** a new slug value (an unseen action key, device or sim) validates under schema 1; a value outside a closed enum is refused.
- **Descriptors and keys:** every descriptor's `mode` / `dialMode` path resolves to a closed enum in its schema; `usageKeyOf` over every registration of all three hosts yields unique kebab-case keys, `camera-cycle` among them.
- **Boundaries:** each named boundary reports `(name, subKey?)` to the observer, the event bus with the event name and the translator with the step name; no observed value contains a registration number or a function name; `_resetBoundaryObservers()` leaves none behind.
- **Warnings:** `onWarningRaised` fires once per newly present id from both `setWarning` and `reconcileWarnings`, and not for an id already present; an id outside the assembled list is counted as `other`.
- **`withUsageCounting`:** every handler member forwarded with the same event, `this` and result (the `press-sounds.test.ts` shape); counts per surface; ticks; off costs nothing and records nothing; a throwing recorder still calls the handler.
- **Session capture** over a fake `UsageSim` and fake clock: open on the first descriptor, close on `onSessionChanged`, disconnect, `onSimTerminated` and exit; under two minutes not reported; a live session never on track not reported; driven `none` under a minute; replay sessions; `null` kind and event type reported as `other`. **The session length key:** a press, a dial turn and a callout outside a session count under `no-session`; inside one, under that session's scheduled value (a bucket, `laps-only`, `unlimited`), also for a session later discarded as too short; at a session change the key moves with it; nothing is ever counted into the session's own record. **Traits:** `none` with four sessions in the window, a value with five.
- **Day, queue, sender** over a fake clock and fake `fetch`: sealing at the UTC boundary and at a stale start; the 8-day and 100-session caps; the 200 KiB packing; every outcome of section 5.6, including no in-day retry, no send during a session, none while off, none from a dev build without the override, and the 5 s abort.
- **State machine:** opt-out, reset, delete and the off switch per the table of section 5.7; erase queued offline, sent later while off, retired IDs cleared only on acceptance; a corrupt usage file moved aside.
- **Consent:** the marker stamped on each of its four triggers and never by the page; the scope bump turning the toggle off and clearing the marker; `enableFeatureWrites("usage-data")`; the ask card's render conditions in a page test, the `#getting-started` load included.
- **Window:** the three commands; `GET /usage/preview` refused without the token, `Origin` and cookie like every route (`settings-window-server.test.ts`), answered with the injected preview otherwise.
- **Pane page:** the generator's freshness and parse tests for `privacy.json`; `tabs.test.mjs`, `settings-window-page.test.ts` (Support last, Privacy after License).
- **Sim seam:** `getSessionDescriptor()` over fixtures built from the existing `local/` session-info snapshots (an official race and its practice, an AI race, offline testing, an unlimited and a laps-only session, as many as they cover), each later capture (league, hosted, team, hosted with AI, spectating) added as a fixture when recorded; the `satisfies Record<SessionKind, …>` maps compile only when exhaustive; `SessionKindsAgree` still compiles with `SessionKind` moved; `PitLaneTrackIdentity` still extends `TrackIdentity`; every fixture's descriptor carries the snapshot's `TrackID` and the player's `CarID` and `CarScreenName`, and a snapshot with no player car (a replay, spectating) gives `car: null`, sent as `null`; `UsageSim.getUnitSystem()` built over `unitSystemOf`.
- **Startup:** `start-plugin.test.ts`'s order with the new phase; a `register-actions` test that every registered handler is the counting wrapper around the focus wrapper, keyed by `usageKeyOf`; an `initUsageData` test that every `UsageSources` member is filled.
- **Workflow:** with the deploy secret absent the job ends green with its notice and deploys nothing; the push trigger's paths are exactly the endpoint's bundled inputs.
- **Endpoint:** the handler over every step of section 8 with a fake writer: wrong method, path and content type; 413 before parsing; 400; the date checks; 429 per key, per install ID and globally; intake stopped; install-then-session write order and the 503s; the session rows carry no install ID, no request id and arrive shuffled; and no row, log line or response contains the test's remote address or forwarded header (asserted on the serialized writes and the captured logger). A source test that the endpoint imports its schemas from `usage-report` and defines none. A DDL test that both report tables carry the partition expiry and `require_partition_filter`, and the session table no ID, timestamp or count column.

**By hand (Niklas on the decks and in the window; the `qa` agent for the endpoint and workflow, per #1532):**

1. Build with the dev flag and `IRACEDECK_USAGE_ENDPOINT` pointing at the endpoint's dev server, which validates with the real handler and prints rows.
2. Fresh settings: Getting Started shows the block; press it; General shows the toggle on; the ask card never appears.
3. Press keys and turn a dial with iRacing closed; "See exactly what's sent" shows today's counts under the right actions and modes, keyed `no-session`, and no name, profile name or binding key.
4. Drive a session of a few minutes pressing keys, then end it; the preview's install report holds those presses (and any callouts heard) under the session's scheduled length, and *Next send* holds a session report with the track id, name and configuration, the car id, car class and buckets, no install ID and no count of any kind.
5. Seal and send now (dev flag); the dev server prints one install row and one session row; *Last sent* matches.
6. Stop the dev server; send again: nothing on any surface but a debug log line; the queue is kept.
7. Delete my data while offline: the status says it is pending; start the server: the erase arrives, a new ID is in the preview.
8. Simulate an upgrade (remove `_usageDataAskedVersion`, toggle off): the next window open shows the card on the General pane; close without answering; reopen: no card.
9. Repeat 2 and 8 on Mirabox and Ulanzi.
10. **Gates the PR.** After the maintainer checklist (section 12), deploy the endpoint from the issue branch with `workflow_dispatch`, and point the branch build's `IRACEDECK_USAGE_ENDPOINT` at the deployed function: rows land in both tables; Logs Explorer shows no request log and no address for the `usage` service; a dispatch with `intake: stop` makes the next send record the off switch; the scheduled erase, run by hand on a two-day-old tombstone, deletes that ID's rows.
