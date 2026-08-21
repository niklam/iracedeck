# Issue #1016 — Show that a newer version exists on the What's New tab

Design, 2026-08-21. Target branch `release/3.0`, milestone 3.0.

## Problem

The Settings window's What's New tab renders the release notes **this build ships** (#1011). That is the right answer to "what did I just get?", and it bought two properties worth keeping: the pane works offline, and it never describes a version the user does not have.

It is blind in one direction. A user two releases behind sees a list whose newest entry is badged **Installed** and nothing that hints more exists. The plugin's existing update machinery (`version-check.ts`, `_lastSeenVersion`) compares the running version against what the user last *saw* — it has no idea what has been *published*, so it can only react to an update that already happened.

## Goal

Tell the user, inside the window, that a newer version exists **and what is in it** — without giving up either property #1011 bought.

Two visible outcomes when a newer release is found:

1. An **UPDATE** badge on the sidebar's *What's New* item (the same badge slot *Key Bindings* uses for its count, accent-coloured rather than the neutral count style).
2. The newer releases rendered above the installed one, in the same list, badged **Not installed**, with one accent banner carrying the route to the downloads page.

When the check finds nothing, is switched off, or fails for any reason, the tab is **exactly** what it is today.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Scrape the changelog page, or publish an artifact? | Publish `https://iracedeck.com/changelog.json` | Machine-readable, cannot drift from the rendered page, no HTML parsing against markup that is free to change. |
| Who fetches? | The plugin, served to the page from its own origin | The window is a page on the plugin's loopback origin; a direct fetch to iracedeck.com is cross-origin with no CORS. Same precedent as `GET /simhub/roles`. |
| How often? | On window open, TTL-cached: 1 h after a success, 5 min after a failure | A user who never opens the window makes **zero** outbound requests. Opening the window, switching tabs, and reopening within the hour is one request. The shorter failure TTL means "I just plugged the network back in" does not mean waiting an hour. |
| Opt-out? | Yes — `updateCheck`, default on, enforced plugin-side | A user who wants no unprompted egress gets a real answer, not a firewall rule. The page never decides whether a network call happens. |
| Pre-release builds? | Plain semver comparison, no special case | `3.1.0-dev.0` is already newer than `3.0.0`, so a dev build is never told it is behind a release it skipped — the concern resolves itself. A `3.0.0-rc.1` user **is** told `3.0.0` shipped, which is correct and useful, and the feature stays testable on a dev build. |
| Unreleased sections? | A release counts as published only when it carries a **date** | The top section of `changelog.mdx` is the in-development version with an `_Unreleased_` line until the release tooling stamps it. Advertising it would be the #1011 complaint in a new place. (In practice the site is deployed separately from the repo and has never carried an unreleased section — this is belt and braces, and it costs nothing.) |
| Fetched bullets are HTML — render as-is? | Sanitize plugin-side, allow-list | The window holds an authenticated socket to the plugin. Even a compromised iracedeck.com must not be able to put script on that page. |
| Relationship to the post-upgrade browser page | None; they never speak at the same moment | That page fires *after* an update ("here is what you got"); this fires *before* one ("an update exists"). No suppression logic between them. |

## Architecture

```text
changelog.mdx ──┬─ scripts/lib/changelog-data.mjs ─┬─ plugin artifact (committed, compiled in)
  (one source)  │                                  └─ website public/changelog.json (generated)
                │
                └────────── https://iracedeck.com/changelog.json
                                        │  fetch (plugin process, TTL-cached)
                                        ▼
   changelog-feed-client → published-changelog (parse + sanitize) → update-check (select)
                                        │
                              update-check-service (gate, TTL, single-flight)
                                        │  GET /updates/status
                                        ▼
                          ird-update-notice  →  banner + release cards + UPDATE badge
```

### 1. The published artifact (website)

`packages/website/scripts/generate-changelog-json.mjs` reads `src/content/docs/changelog.mdx`, runs `buildChangelogData` from the repo-root `scripts/lib/changelog-data.mjs`, and writes `packages/website/public/changelog.json`.

- Wired into the website's `dev` and `build` scripts as `generate:changelog-json`, beside `generate:gallery`.
- Output is **gitignored** and regenerated on every build — the same shape as `public/icon-gallery/`. There is no committed duplicate to go stale.
- Astro copies `public/` into `dist/`; Firebase serves `dist/`. No `firebase.json` change is needed.
- One parser, one source file: the plugin's committed artifact and the website's published one are produced by the same function.

A test at the repo root (`scripts/` is where the runner looks for `.mjs` tests) guards the wiring: the artifact the website generator would write is byte-identical to the committed plugin artifact, the website's `build`/`dev` scripts actually invoke the generator, and `.gitignore` covers its output. The two artifacts cannot diverge because they are the same two function calls over the same file.

### 2. deck-core — the update-check subsystem

Five modules, each with one job. Everything except the client is pure.

**`changelog-html-sanitize.ts`** — `sanitizeChangelogHtml(html: string): string`.

The producer (`scripts/lib/changelog-inline-html.mjs`) emits exactly four constructs: `<code>`, `<strong>`, `<em>`, and `<a href="…" target="_blank" rel="noopener noreferrer">`. The sanitizer re-emits only those:

- Text is re-escaped on the way out, so anything that is not an allow-listed tag becomes literal text rather than markup.
- `<a>` keeps only `href`, and only when it parses as `http(s)`. `target`/`rel` are written by us, never copied from the input.
- Unbalanced or unknown tags are escaped, not dropped silently into markup.

**`published-changelog.ts`** — the wire format and its parser.

```ts
interface PublishedRelease { version: string; date: string | null; categories: { title: string; items: string[] }[] }
parsePublishedChangelog(body: unknown): PublishedRelease[] | undefined
```

A Zod schema validates the shape; every bullet goes through the sanitizer before it leaves this module, so nothing downstream ever handles unsanitized remote HTML. A body that does not parse returns `undefined` — the caller treats that as unavailable.

**`changelog-feed-client.ts`** — the only I/O.

```ts
fetchPublishedChangelog(p: { url: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<PublishedRelease[] | undefined>
```

Never throws: a timeout (5 s, `AbortSignal`), a refused connection, a non-OK status, or a body that does not parse all return `undefined`. `fetchImpl` is injected so tests never touch the network.

**`update-check.ts`** — the pure decision.

```ts
selectAvailableUpdates(p: { installedVersion: string; releases: PublishedRelease[] }): PublishedRelease[]
```

Keeps a release when it has a **date**, its `version` is valid semver, and `semver.gt(version, installedVersion)`. Returns newest-first. An invalid installed version yields an empty list (never guess).

**`update-check-service.ts`** — composition.

```ts
createUpdateCheckService(deps: {
  isEnabled(): boolean;
  getInstalledVersion(): string;
  url?: string;              // defaults to the published artifact
  fetchImpl?: typeof fetch;
  now?: () => number;
  successTtlMs?: number;     // default 1 h
  failureTtlMs?: number;     // default 5 min
  logger: ILogger;
}): { get(): Promise<UpdateStatus> }

type UpdateStatus =
  | { state: "disabled"; installedVersion: string }
  | { state: "unavailable"; installedVersion: string }
  | { state: "ok"; installedVersion: string; latestVersion: string; releases: PublishedRelease[]; checkedAt: number };
```

- `isEnabled()` is read on **every** call, so toggling the setting takes effect without a restart and an off setting means no socket is opened at all.
- One in-flight request at a time: concurrent `get()` calls share it.
- The cache holds the parsed release list, not the derived status, so the installed version is re-applied on every call.
- Failures are logged at debug. Nothing here ever throws or rejects.

**Server + controller.** `settings-window-server.ts` gains an `updates?: { get(): Promise<UpdateStatus> }` option served at `GET /updates/status`, modelled on the existing `simHub` block: authorized like every other request, `cache-control: no-store`, and a throwing delegate answers a JSON error body rather than escaping the listener. `settings-window.ts` passes the option through. The page never learns the upstream URL and cannot influence it — no host or path comes from the request, so there is no SSRF surface, exactly as with `/simhub/roles`.

### 3. The setting

`updateCheck` joins `GlobalSettingsSchema`:

```ts
updateCheck: z.union([z.boolean(), z.string()])
  .transform((v) => v === true || v === "true")
  .default(true)
  .catch(true),
```

The control goes in `global-common-updates.ejs`, under the existing *After an update* select:

```html
<sdpi-item label="Check for new versions">
  <sdpi-checkbox setting="updateCheck" label="Tell me when a newer version is available" global default="true"></sdpi-checkbox>
</sdpi-item>
```

`default="true"` renders checked, which is what we want (`default="false"` is the trap — the attribute is a truthy string).

Per `global-settings.md`, flipping a default only reaches new installs; `true` is the new field's default, so every existing install gets it on first write. That is the intent.

### 4. The page runtime

This pane has had no runtime of its own since #1011. It gets one, and only one.

**`ird-update-notice`** (`pi-components/src/components/update-notice.ts`), placed in `settings-window-changelog.ejs` above the list:

```html
<ird-update-notice list="sw-changelog"></ird-update-notice>
```

- Runs only inside the settings window (`inSettingsWindow()`), so it is inert if the bundle is ever loaded elsewhere.
- On connect it fetches `/updates/status` once. `disabled`, `unavailable`, or `ok` with no releases → renders nothing at all and emits nothing. That is the whole failure story: the tab looks like today.
- On `ok` with releases it renders an accent banner — "Version 2.6.0 is available. You're on 2.4.0." plus a link to `https://iracedeck.com/downloads/` (the shared external-link handler routes it to the OS browser) — and prepends one card per release into the element named by `list`, above the built-in ones, each badged **Not installed**.
- It then emits `ird-update-available` (bubbling, composed) with `{ latestVersion, count }`. The page's existing inline script listens and fills the sidebar badge. The component does not reach outside itself to style the nav.

**Card construction.** Cards are built with `createElement`, and every value except a bullet's inner HTML is set with `textContent`. Bullets use `innerHTML`, and only after the plugin sanitized them — the same content the compiled-in path emits raw. The classes mirror `settings-window-changelog.ejs` exactly so a fetched card is visually indistinguishable from a built-in one.

**No duplicates by construction.** The built-in list can only contain versions ≤ this build (it is generated from the changelog at build time); the fetched set is strictly `> installed`. No de-duplication pass is needed, and none is written.

**Sidebar badge.** `settings-window.ejs`'s What's New nav button gets an id and an empty, hidden `.sw-badge`; the inline script fills it with `UPDATE` and adds an accent modifier class on the event.

### 5. Plugin wiring (all three plugins, identically)

```ts
const updateCheck = createUpdateCheckService({
  isEnabled: () => getGlobalSettings().updateCheck !== false,
  getInstalledVersion: getPluginVersion,
  logger: adapter.createLogger("UpdateCheck"),
});
// …
createSettingsWindowController({ /* … */ updates: updateCheck });
```

Mirabox and Ulanzi serve the same window, so the feature ships on all three ecosystems with the same three lines.

## What this deliberately does not do

- **No startup fetch.** Both visible outcomes live inside the window, so nothing needs an earlier check, and a user who never opens the window generates no traffic.
- **No persisted cache.** A stale "update available" after the user has updated would be worse than a fresh request. In-memory only.
- **No new warning banner, no PI surface, no key icon.** The issue asks for a badge and a list inside the window; that is the scope.
- **No interaction with `_lastSeenVersion` or the post-upgrade page.** Different question, different moment.
- **No cap on how many newer releases are listed.** Someone four versions behind should read all four.

## Testing

| Area | Cases |
|---|---|
| `changelog-html-sanitize` | Each allow-listed tag survives; `<script>`, `<img onerror>`, event attributes, `javascript:`/`data:` hrefs, unbalanced tags, nested allow-listed tags, entity round-trips. |
| `published-changelog` | Valid body parses; missing/extra fields; non-array; bullets come back sanitized; malformed body → `undefined`. |
| `changelog-feed-client` | OK body; non-OK status; network throw; timeout; unparseable JSON. Injected `fetch` throughout. |
| `update-check` | Dated filter; strict `gt`; pre-release comparisons both directions; sort order; invalid installed version; empty input. |
| `update-check-service` | `disabled` short-circuits without fetching; TTL suppresses a second fetch; failure TTL is shorter; single-flight; the setting is re-read per call; a throwing delegate cannot reject. |
| Server | `/updates/status` returns the status; requires authorization; absent option → 404; a throwing provider answers rather than crashing. |
| `ird-update-notice` | All four states; renders nothing when there is nothing to say; insertion order and target; bullets rendered as HTML; `textContent` used for versions/dates; event payload; inert outside the settings window. |
| Website artifact | Generator output equals the committed plugin artifact byte for byte; the website `build`/`dev` scripts invoke the generator; `.gitignore` covers the output. |

## Artifacts to update in the same change

- `packages/website` — the generator, the build wiring, `.gitignore`.
- `packages/deck-core` — the five modules, the server option, the controller passthrough, `GlobalSettingsSchema`, the barrel export.
- `packages/pi-components` — the component, its registration, `global-common-updates.ejs`, `settings-window-changelog.ejs`.
- `packages/iracing-actions` — `settings-window.ejs` (nav id + badge, CSS for the banner, the not-installed card, the accent badge, the inline listener).
- All three plugins — the service and the controller option.
- `scripts/lib/settings-window-capture/` — a stub `updates` provider so the recaptured screenshot shows the update-available state; `tabs.mjs`'s `parseNavPanes` regex made attribute-order-agnostic (adding an id to a nav button would otherwise break it).
- `.claude/rules/settings-window.md` — a component-table row for the update check and the endpoint, and **rule 10 rewritten**: the pane now has exactly one runtime, and what it may and may not do.
- Website docs — `docs/getting-started/settings.md` (the What's New section) and `docs/features/whats-new-page.md` (the upstream check and its setting), plus a recaptured `whats-new.png`.
- `changelog.mdx` — one **Features** line under the in-development version.
