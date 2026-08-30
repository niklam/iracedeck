# First-run Getting Started page

> **Issue:** [#1061](https://github.com/niklam/iracedeck/issues/1061) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

A Getting Started page, authored once and rendered both as a Settings-window tab and as a website page, opened automatically once on a genuinely fresh install. #1061 carries what it is and why we want it, and absorbs [#995](https://github.com/niklam/iracedeck/issues/995) (closed as a duplicate), whose two settings prompts become sections of the page. This spec records the decisions behind it and what was refused, so they are not re-litigated.

## `getSettingsStoreSource()` cannot identify a fresh install

This is the load-bearing finding, and the accessor's name is actively misleading. `SettingsStoreSource` is `"file" | "host" | "fresh"`, and none of the three means what a first-run feature needs.

- **`"host"` does not mean "upgrade".** The normal migration path has no emptiness check at all — `answered = Object.keys(raw).length > 0` exists only inside the give-up-retry branch. A deck host that replies `{}` to a brand-new install produces `"host"` with a defaults cache, indistinguishable from a pre-3.0 migration.
- **`"fresh"` does not mean "new user".** It means only "the host did not answer within `MIGRATION_TIMEOUT_MS`". A corrupt settings file is reported as "no file" and arrives the same way, and while [#1056](https://github.com/niklam/iracedeck/issues/1056) stands this is the *normal* path for a Mirabox upgrade.
- **From the second start every install reads `"file"`**, including one migrated the start before: the `"host"` path deletes both migration markers before persisting.

It also has no consumers in the repo, so a first-run feature would have been its first — a poor one.

**The signal is the absence of the passthrough `_lastSeenVersion`.** It has been written by the changelog check on essentially every startup since #680, under every policy except a pre-release build (`never` still persists it via `track-silently`), so its presence means "some iRaceDeck build has completed a startup against this store". Being a passthrough key, a host migration carries it across verbatim — `mergeMigration` gives passthrough keys to the file unconditionally — so an upgrading user whose host answers is correctly identified as not new, whichever source value they landed on.

It is written by nothing else, which makes it pristine at the moment we look **provided the first-run check runs before the changelog check inside the same graced call**. That ordering is a requirement of this design, not an incidental detail.

The unreadable-file path needs no handling: it never becomes ready (`"Deliberately NOT ready and NOT saved"`), so gating on `isSettingsStoreReady()` — which every consumer already does — excludes it.

Content heuristics ("no bindings set", "settings look default") were refused for the reason `global-settings.ts` already refuses them in the give-up retry: `.default(...)` fills every schema-backed field on every parse, so a stored value carries no evidence that a user ever chose anything.

## Two ambiguous cases are accepted by construction

A store that is defaults-born because the host never answered is **indistinguishable from a new install** — there is no signal that separates them, so no amount of care produces one. Two situations reach it: a corrupt settings file moved aside, and a host that does not answer the migration read. Each costs one Getting Started page, once.

This is accepted and documented rather than defended with a heuristic, on the same reasoning as the #1053 accept-and-document outcome: a guess that is right most of the time buys less than a known, bounded, stated failure.

It is narrowed as far as it goes by deferring while `_migrationPending` is set (below), which removes the Mirabox case entirely once the countdown resolves.

## `_firstRunVersion` holds a version, not `true`

A passthrough key in the plugin-owned store, holding the plugin version at which the first-run decision was resolved.

The value shape is not a style choice. #1041 shipped `_migrationAbandoned` as a bare `true`, which made it permanent and unrevisitable; #1047 fixed it by storing the version that gave up, so a later build could re-ask exactly once. The same failure is available here for free — a boolean cannot be revisited by a future release that substantially rewrites the page — and the version costs nothing.

It is written on **every** resolution, including the "existing user, show nothing" case, so the second start never re-evaluates against a `_lastSeenVersion` that is by then no longer pristine. That is why the key is not named `_gettingStartedShownVersion`: that name would be a lie in precisely the case that matters.

**It must not be enrolled in `RUN_SCOPED_SETTING_KEYS`.** That list is stripped at three boundaries — cache-become-ready, every `persist()`, and every `setGlobalSettings` frame the settings server accepts — so enrolling it would make the page reappear on every start. Membership is an explicit list rather than an underscore-prefix convention exactly so this cannot happen by accident; `_lastSeenVersion` is the durable precedent.

## Deferring the changelog check while `_migrationPending` is set

While the countdown is set the store is explicitly provisional: a host answer may still arrive on a later start. The first-run check therefore defers, persisting nothing — and **the changelog check must be deferred on those starts too**, because it is what would write `_lastSeenVersion` and destroy the evidence.

That is a deliberate change to shipped #680/#901 behaviour and needs its own argument, which it has: on a store we already know is provisional, treating the user as a first install and opening release notes at them is the wrong call independently of this feature. It is bounded by `MIGRATION_RETRY_STARTS` (3), after which `_migrationAbandoned` is stamped and the decision is made on what is known.

Failing closed instead — never showing the page when we never learned — was refused because it would disable the feature for every Mirabox user on account of a filed, fixable bug (#1056).

## The Race Engineer control writes two keys

`pitCrewRaceEngineerEnabled` is `.default(false)` (#378), so a page that introduces the Race Engineer must also offer the way on. The control writes both `pitCrewRaceEngineerEnabled = true` and `pitCrewRaceEngineerStartupPolicy = "remember-last"`, unconditionally, on every press.

**The second key is mandatory, and the reason is not the obvious one.** The schema default policy is `remember-last`, under which `resolveStartupGate` returns the remembered gate — so on a *fresh install* the gate alone would survive. What breaks is every upgraded install: `migrateStartupPolicies` maps the retired `…EnabledOnStartup` boolean to `always-on`/`always-off`, and that retired field was schema-backed with a `false` default, so any install that ever performed a write before #1007 carries a stored `false` that the migration reads as an explicit **`always-off`**. `feature-startup-gates.ts` states it plainly: *"only a fresh install (nothing stored) keeps the `remember-last` default."* The tab is permanent, so without the second key an existing user pressing the button gets one session of engineer and silence thereafter.

**`remember-last` and never `always-on`**: the latter would keep forcing the gate at every start, overriding a later deliberate silence from the Pit Crew toggle key — the exact defect #1007 was filed to remove.

Writing unconditionally was the owner's decision, taken on simplicity over a conditional that inspected the current policy first. **Its recorded consequence:** a user who had deliberately chosen `always-on` has that choice changed to `remember-last` by pressing the button. Mild — the feature is still on, and `remember-last` respects a later deliberate toggle where `always-on` overrides it — and the affected population is small, since the page is shown on fresh installs, so reaching it with `always-on` stored means having opened it deliberately later.

The write lives in a settings-window command keyed off `FEATURE_STARTUP_GATES` rather than in browser JavaScript: "these two keys move together" belongs in TypeScript beside the pairing it depends on, where it can be tested, not across two sdpi controls that can drift apart. A regression here is invisible until the next start, which is what makes it worth pinning rather than trusting.

## Crew Chief: a framing rule, not a sentence

- **Function first.** Describe what the Race Engineer does — a spoken race engineer in your ear: flags, fuel, pit calls, gaps, spotter warnings. Never define it as "Crew Chief-like". Naming a competitor in the first sentence a new user reads cedes the frame and invites a feature-by-feature comparison against a much deeper product at the worst possible moment. Anyone who knows Crew Chief makes the connection unprompted, so the recognition is free and the position is not spent.
- **Name it exactly once, for coexistence**, because that is useful rather than competitive: many users run both, two engineers talking over each other is an immediate practical problem, and it would otherwise read as our bug. The per-callout opt-ins such advice points at already exist, so it is actionable today.
- **A head-to-head comparison, if ever wanted, belongs on the website** as a docs/FAQ entry where someone is actively asking — never on the first-run page.

Recorded here because it is a positioning decision that whoever writes the copy would otherwise re-open.

## The authoring pipeline follows #1011, with one correction

One authored Markdown source in the website content tree; a generator emitting a committed JSON artifact; the artifact compiled into all three plugins; the pane rendering it offline with no fetch. Delivery needs no rollup wiring — `createTemplateRequire` resolves any `.json` under the shared templates root, which all three plugin builds already point at.

**`changelog-parse.mjs` is not reusable.** It parses a fixed release/category grammar — version headings, dated lines, ordered bold category headers — and throws on anything else. Prose has none of that structure, so the page needs its own small block grammar (headings, paragraphs, bullets, one marker), written in the same style: strict, line-oriented, throwing with a line number. Its inline sibling `changelog-inline-html.mjs` **is** reused verbatim, and its link discipline — site-absolute `/docs/…` rebased onto iracedeck.com, anything else throwing — is exactly what this page wants.

Refused: fetching the page at runtime (a first-run user may be offline, the page is cross-origin to the window, and the #1016 update-check precedent renders *nothing* on failure — acceptable for a bonus banner, fatal for primary content); authoring twice (#1011 exists because of that drift); a Markdown library plus a sanitizer (a new dependency and a far larger rendering surface than the pane needs).

## Opening it

The trigger reuses the existing machinery rather than adding a parallel one: the same `startupDefaultsApplied` one-shot gated on `isSettingsStoreReady()`, the same `VERSION_CHECK_STARTUP_GRACE_MS`, the same `isSimRunning` gate so the page never opens over a live race, and the same `onIRacingTerminated` re-run. On open, the website changelog is suppressed and `_lastSeenVersion` persisted silently — release notes for a product never run are noise, and it is also what makes the absorbed #995 frequency picker true to its own framing, since otherwise the changelog would open in a browser tab before the user ever reached the picker. `_lastChangelogOpenedAt` is deliberately not stamped on that start: nothing opened, and leaving the anchor unset is what makes a later switch to `monthly` open at the next upgrade.

Two things this introduces that did not exist:

- **A pane deep link.** `SettingsWindowController.open()` takes no arguments and always opens the server's root URL. It gains an optional pane, appended as a `#fragment` — never sent to the server, so the token/`Origin`/cookie model is untouched.
- **The first automatic `.open()` in the codebase.** Every production caller today sits behind a user pressing the settings button. Worth knowing, because it means the window's failure banners become reachable in a context where no Property Inspector may be open to display them.

On a rejected open the flag is deliberately **not** persisted, diverging from `runVersionCheck`'s persist-first rule. The two flags mean different things: the changelog persists first so a flaky open never re-interrupts someone, whereas this flag means "the user was shown this", and a rejected open means they were not. Nothing loops — the retry is one attempt per start and produces no window by definition. The launcher's standing caveat is unchanged and accepted: `openUrl` resolving means *sent*, not *displayed*, so a machine with no usable browser looks like a success and never shows the page.

## Unestablished

These are open and stay open; a spec that quietly firms them up is worse than one that names them.

- Whether a deck host with no stored iRaceDeck settings replies promptly with an empty bucket or stays silent. Ulanzi returns nothing for a *foreign* uuid, but a registered plugin with an empty bucket is untestable on a machine with one plugin installed. The design is deliberately insensitive to this, since it keys on `_lastSeenVersion` rather than on the source.
- Whether Mirabox answers the migration read at all, as opposed to answering it too late (#1056).
- Whether anything enforces "one docs section per settings-window tab" beyond `tabs.test.mjs` pinning the pane list itself.

One known limitation, carried from #995 and not introduced by absorbing it: `focusIRacingWindow` is `.default(true)` since #930, so its suggestion never renders on a genuinely fresh install, and the users who actually have it off reach the page only by opening the tab deliberately. #995 keyed on the same first-install signal and had identical reach. Reaching that population is a separate problem this page cannot solve — a migration would override a real preference, and `ird-warnings` renders `textContent` only, so a banner can name a setting but never offer a control.
