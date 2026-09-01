# Fake deck-host harness

A fake WebSocket deck host that lets you watch the plugin behave across the host socket boundary **with the connect timing under your control**. Nothing else in the repo can do that: unit tests mock `ws` and run on fake timers, and `@iracedeck/scenario-harness` mocks the adapter entirely and never connects.

It exists because that blind spot hides real bugs. While validating #1056 it showed the first implementation was incomplete — a handshake slower than `MIGRATION_TIMEOUT_MS` still gave up — after an `xhigh` code review across ten angles had found nothing. That is not a failure of the review: a review of the code against its design cannot surface a gap *in* the design. This is the instrument for that class of question.

> **Verified against:** issue #1056, 2026-08-31. See _Rot_ below before trusting a negative result.

## The two scripts

- **`fake-vsd-host.mjs`** — listens immediately, then deliberately holds the WebSocket **upgrade** for N seconds before completing it. Holding the upgrade is the whole trick: it reproduces "the socket exists but is not OPEN", which is the actual condition. You cannot get there by starting the listener late, because a refused connection makes both clients end the process.
- **`probe-readystate.mjs`** — drives the built clients directly and samples `ws.readyState` on a timeline. This is how "a slow host and a dead host are indistinguishable at the deadline" was settled by measurement rather than argument (the table is in the #1056 spec).

Both speak the Mirabox (`event`) and Ulanzi (`cmd`) frame dialects, so one script serves both hosts.

## Run the control first — this is the discipline, not a suggestion

The harness hardcodes frame shapes that belong to the **hosts' protocols, not ours**, so they cannot be imported from our packages and will eventually go stale. The failure mode is the bad one: a stale reply shape looks exactly like "the host never answered". So a negative result is only trustworthy if the control passed in the same session.

```bash
# 1. CONTROL — a connect well inside the migration budget. This MUST migrate.
node scripts/deck-host-harness/fake-vsd-host.mjs --repo . --port 12346 --delay 5 --answer --shutdown 6

# 2. In another shell, with the plugin already built (pnpm build):
cd packages/iracing-plugin-mirabox/com.iracedeck.sd.core.sdPlugin/bin
IRACEDECK_SETTINGS_PATH=/tmp/gs-harness.json node plugin.js -port 12346 -pluginUUID com.iracedeck.sd.core -registerEvent registerPlugin
```

Expect `Migrated global settings from the deck host`. If you do not get it, **fix the harness before believing anything else it tells you** — the frame shapes have drifted.

### What is load-bearing and what is an example

Getting this backwards is how a procedure that reads as literal quietly becomes wrong.

| Part | Status |
| --- | --- |
| `IRACEDECK_SETTINGS_PATH` pointing somewhere disposable | **Load-bearing.** Without it the run reads and rewrites your real settings file. |
| Running the control before the case under test | **Load-bearing.** See above. |
| The plugin being freshly built | **Load-bearing.** The harness drives the built bundle, not the sources. |
| No settings file at that path | **Load-bearing** for anything about migration — with a file present, deck-core never issues the read. |
| `--port 12346` | Example. Any free port; use different ones for concurrent runs. |
| `--repo .` | Example. Defaults to the working directory; it only tells the script where to resolve `ws` from. |
| `--delay 5` / `--delay 15` | Example values chosen either side of the 10 s budget. |
| The Mirabox plugin specifically | Example. The Ulanzi plugin takes `<address> <port> <language>` positionally instead. |

## The cases worth running

```bash
--delay 5  --answer    # control: connect inside the budget, host answers
--delay 15 --answer    # the case #1056's bounded grace exists for
--never                # R1: accepts TCP, never upgrades — must still reach the give-up
```

### Pass criteria, verbatim

Recorded here so nobody reconstructs them by re-running the instrument, which is how criteria drift into whatever the instrument currently does.

**`--delay 15 --answer`** — a handshake slower than the whole budget still migrates:

```text
[GlobalSettings] Initializing
[VSD:WebSocket] Connecting to VSD Craft
[GlobalSettings] No settings file yet; requesting the deck host's settings for a one-time migration
[GlobalSettings] Deck host not reachable yet; extending the migration deadline once
[VSD:WebSocket] Connected to VSD Craft
[GlobalSettings] Settings received from host for migration
[GlobalSettings] Migrated global settings from the deck host
```

The settings file then holds `driverName: "fake-host-migrated"` and `blackBoxFuel: "F6"`, with no `_migrationPending`.

**`--never`** — the give-up path survives the grace (this is #1056's R1):

```text
[GlobalSettings] Initializing
[GlobalSettings] No settings file yet; requesting the deck host's settings for a one-time migration
[GlobalSettings] Deck host not reachable yet; extending the migration deadline once
[GlobalSettings] Deck host did not answer the migration read; starting fresh
[GlobalSettings] No stored settings found; starting fresh (the deck host will be asked again next start)
```

The settings file then holds `driverName: ""` and `_migrationPending: 1`.

## Rot

There is no automated self-check, deliberately. The tempting one — "watch for the plugin mirroring settings back, which would prove it understood the reply" — depends on the settings-window server having started, which does not reliably happen in a bare harness run; that was observed, not assumed, so it is not proposed. The control run above is the mitigation instead: the tool carries its own positive control.

Update the _Verified against_ line above whenever the harness is exercised against a change. Name the **issue and date**, never a commit SHA: feature PRs are squash-merged, so no branch SHA survives into the history anyone would read this from.

## Housekeeping

- Not in CI, and that is a recommendation rather than an omission. It drives the built plugin over a real socket with real waits — a meaningful run is 15–60 s of mostly sleeping, to assert what the unit tests already assert deterministically with fake timers. Its value is precisely where determinism ends, which is the worst thing to put in a job people need to trust.
- **Check these files with `pnpm lint`, not `pnpm lint:fix`.** The two commands do not cover the same set: `lint` includes `scripts/**/*.mjs`, `lint:fix` drops that glob entirely, and neither `format` nor `format:fix` touches `.mjs` at all (both match only `**/*.ts` and `**/*.json`). So a clean `lint:fix` says nothing about this directory, and `pnpm lint` can fail on a file `lint:fix` never looked at, let alone fixed. Keep them lint-clean by hand.
- This landed alongside #1056, the fix it validated. Its permanent home is pending that issue's sibling; if the sibling is declined, the commit that added this directory can be dropped without touching the fix.
