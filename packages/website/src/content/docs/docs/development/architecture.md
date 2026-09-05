---
title: Architecture
description: How data and control flow through iRaceDeck — from iRacing telemetry to the Stream Deck, Mirabox, and Ulanzi plugins.
---

iRaceDeck is shaped like an **hourglass**. Many possible sims funnel *in* through one narrow seam, pass through a single shared "brain," then fan *out* through a second narrow seam to many devices. Those two seams — the **event bus** (inbound) and the **`IDeckPlatformAdapter`** (outbound) — are the whole architecture in a sentence: add a sim by writing one new translator, add a device by writing one new adapter, and nothing else changes.

This page is the visual companion to the [Tech Stack](/docs/development/tech-stack/) page (which lists what each package *is*). Here we show how they *fit and flow*.

## The big picture

```mermaid
flowchart TB
  ir["iRacing sim"]:::ext
  future["future sims<br/>(AC, rF2, ...)"]:::ghost
  futureTrans["future translator<br/>(sim-events-...)"]:::ghost
  sdk["iracing-sdk"]:::sim
  trans["sim-events-iracing<br/>(translator)"]:::sim
  bus(["event-bus<br/>SEAM 1 — semantic events"]):::seam
  actions["iracing-actions<br/>(icons + buttons)"]:::core
  re["audio-scenarios<br/>(Race Engineer)"]:::audio
  adapter(["IDeckPlatformAdapter<br/>SEAM 2 — device boundary"]):::seam
  elg["Elgato adapter"]:::adp
  mir["Mirabox adapter"]:::adp
  ula["Ulanzi adapter"]:::adp
  deck["Stream Deck / Mirabox / Ulanzi hardware"]:::ext
  spk["audio output"]:::ext

  ir --> sdk
  sdk --> trans
  trans --> bus
  future -.-> futureTrans
  futureTrans -.-> bus
  bus --> actions
  bus --> re
  actions --> adapter
  adapter --> elg
  adapter --> mir
  adapter --> ula
  elg --> deck
  mir --> deck
  ula --> deck
  re --> spk

  classDef ext fill:#33404d,color:#fff,stroke:#1d262e;
  classDef ghost fill:#33404d,color:#c5ccd3,stroke:#5a6573,stroke-dasharray:4 3;
  classDef sim fill:#d9822b,color:#fff,stroke:#9c5e1f;
  classDef seam fill:#8e44ad,color:#fff,stroke:#5e2d73,stroke-width:3px;
  classDef core fill:#2d7dd2,color:#fff,stroke:#1f5793;
  classDef audio fill:#2e9e5b,color:#fff,stroke:#1f6e40;
  classDef adp fill:#16a085,color:#fff,stroke:#0e6f5c;
```

Arrows show **runtime flow**. The two purple stadium nodes are the abstraction seams; they're styled the same way in every diagram below so you can anchor on them. The dashed node is hypothetical — it shows where a second sim would plug in.

Two things to notice. First, only `iracing-actions` flows down to the device seam — the **Race Engineer** (`audio-scenarios`) is a sibling consumer whose output goes to your speakers, never through the deck. Second, everything left of SEAM 1 is sim-specific; everything right of it is sim-agnostic — in principle (the action layer doesn't fully hold to this; see the *Seams & where the abstraction leaks* section below).

## Inbound: telemetry → semantic events

The only package coupled to iRacing telemetry is the **translator**, `sim-events-iracing`. It subscribes to the SDK controller's ticks, diffs each snapshot against the previous one, and publishes **semantic events** onto the bus — events named for what they *mean* in racing terms (`flag.yellow.raised`, `lap.completed`) rather than for the raw telemetry they were derived from, each fired once on the meaningful change. The bus envelope carries telemetry as a generic field — it imports no SDK — which is what makes it reusable for a future `sim-events-<sim>`.

```mermaid
flowchart TB
  ir["iRacing sim"]:::ext
  mem["shared memory"]:::ext
  sdk["iracing-sdk<br/>sdkController"]:::sim
  trans["sim-events-iracing<br/>translator"]:::sim
  bus(["event-bus<br/>SEAM 1"]):::seam
  a["iracing-actions"]:::core
  re["audio-scenarios"]:::audio

  ir --> mem
  mem -->|"polls telemetry"| sdk
  sdk -->|"tick: snapshot"| trans
  trans -->|"diff vs previous → semantic event<br/>(e.g. flag.yellow.raised)"| bus
  bus -->|"subscribe"| a
  bus -->|"subscribe"| re

  classDef ext fill:#33404d,color:#fff,stroke:#1d262e;
  classDef sim fill:#d9822b,color:#fff,stroke:#9c5e1f;
  classDef seam fill:#8e44ad,color:#fff,stroke:#5e2d73,stroke-width:3px;
  classDef core fill:#2d7dd2,color:#fff,stroke:#1f5793;
  classDef audio fill:#2e9e5b,color:#fff,stroke:#1f6e40;
```

This is why a button "knows" a yellow is out: it never reads telemetry itself — it subscribes to an event the translator derived.

## What the event bus provides

`event-bus` is the contract every consumer codes against. It gives them three things:

- **A typed, sim-agnostic event catalog** — the vocabulary of things that can happen (`flag.yellow.raised`, an overtake, a laps-of-fuel-left crossing, a pit-lane transition). It's a plain pub/sub package that imports no simulator SDK, so the vocabulary stays the same no matter which sim feeds it.
- **Decoupled fan-out** — publishers and subscribers never reference each other. The translator publishes; the actions and the Race Engineer each subscribe independently. You can add a consumer without touching the producer, and — in principle — swap the producer without touching the consumers.
- **A generic telemetry snapshot on the envelope** — alongside the semantic payload, each event carries the latest raw telemetry in a generic field. This is the sim-specific escape hatch: the Race Engineer's radar and spotter engines read it (via `getLatestTelemetry`) because their job needs the full per-car picture, not a single event. It is also the part of this seam that is **not** sim-agnostic yet — see the leaks below.

The catalog spans around 60 events grouped into families — pit lane and stops, flags, start lights, rolling start, pit service, tires, car control, pit limiter, incidents and off-tracks, overtakes and position changes, laps, fuel, proximity radar, track wetness, damage, and session lifecycle. Payloads range from empty (pure transitions like `pitLane.entered`) to rich records:

```text
flag.yellow.raised          → { scope: "local" | "full" }
fuel.lapsLeft.crossed       → { count: number, lapsLeft: number }
overtake.completed          → { position, previousPosition, gapBehindMeters?, isLeader, … }
```

The canonical, always-current list — every event name and its exact payload — is the `SimEventMap` type in [`event-bus/src/event-catalog.ts`](https://github.com/niklam/iracedeck/blob/master/packages/event-bus/src/event-catalog.ts). This page deliberately doesn't reproduce it: the types are the source of truth, and they change too often to mirror by hand.

## Outbound: reactions to devices, commands to iRacing

There are two outbound paths, and they're easy to conflate. The **render path** turns an event or state change into pixels on a key. The **command path** turns a button press into an action inside iRacing. Both run through `iracing-actions`, but they exit through different doors.

```mermaid
flowchart TB
  evt["event / state change<br/>(from SEAM 1)"]:::seam
  press["button / dial press"]:::ext
  action["iracing-actions<br/>action handler"]:::core
  icon["assembleIcon()<br/>icon-composer"]:::core
  core(["deck-core<br/>IDeckPlatformAdapter — SEAM 2"]):::seam
  elg["Elgato"]:::adp
  mir["Mirabox"]:::adp
  ula["Ulanzi"]:::adp
  dev["device pixels"]:::ext
  ir["iRacing"]:::ext

  evt -->|"render"| action
  action --> icon
  icon --> core
  core --> elg
  core --> mir
  core --> ula
  elg --> dev
  mir --> dev
  ula --> dev

  press -->|"command"| action
  action -->|"getCommands() — SDK broadcast"| ir
  action -->|"getKeyboard() — native inject"| ir
  action -->|"chat #macro"| ir

  classDef ext fill:#33404d,color:#fff,stroke:#1d262e;
  classDef seam fill:#8e44ad,color:#fff,stroke:#5e2d73,stroke-width:3px;
  classDef core fill:#2d7dd2,color:#fff,stroke:#1f5793;
  classDef adp fill:#16a085,color:#fff,stroke:#0e6f5c;
```

The render path is fully abstracted: `iracing-actions` hands a finished icon — an SVG data URI — to `deck-core`, and whichever adapter is loaded paints it on the real hardware. The icon crosses SEAM 2 unchanged, still as SVG; inside each adapter's context implementation (`setImage`, Elgato's `setFeedback`), `deck-core`'s rasterizer service converts it to PNG in-plugin (`@iracedeck/rasterizer`, wrapping `@resvg/resvg-js`, via the render function the plugin injected at startup) and sends the device pixels rather than an SVG string, so every key and dial looks identical regardless of which host's own SVG engine it's running on. The command path has three mechanisms — the SDK broadcast (`getCommands()`) is preferred, native keyboard injection (`getKeyboard()`) covers what the SDK can't, and chat macros cover the rest.

### The settings path (the settings window and the Property Inspectors)

Since #992 there is a third outbound path that has nothing to do with iRacing: the plugin **serves a web page** and the user's browser is a client of the plugin. And since #993 the plugin also **owns the settings themselves**: plugin-global settings live in one JSON file per ecosystem (`SettingsStore` → `%LOCALAPPDATA%\iRaceDeck\Settings\<Stream Deck | Mirabox | Ulanzi>\global-settings.json`), loaded at startup and saved — debounced and atomically — on every change. Both editing surfaces reach it the same way: the settings window and **every Property Inspector** speak the PI protocol to the plugin's own loopback server. The deck host's store is **read once and written once**: read only when there is no file yet, to migrate an existing installation across on the first start after the upgrade; written exactly once per start with a full mirror of the cache plus `_settingsChannel` (the loopback server's port and token), which is the bootstrap a Property Inspector needs to find the plugin. The mirror is a whole object because a deck host's `setGlobalSettings` replaces rather than merges, and it is skipped entirely when the migration read went unanswered — mirroring schema defaults would destroy a copy the plugin never got to see. That copy doubles as the downgrade safety net.

```mermaid
flowchart LR
  pi["Property Inspectors<br/>(sdpi-components<br/>+ pi-settings-bridge / ulanzi-pi-bridge)"]:::ext
  win["Settings window<br/>(browser --app=, same sdpi-components<br/>+ settings-window-bridge)"]:::ext
  srv["deck-core<br/>settings-window server<br/>loopback · token · Origin/cookie<br/>(runs for the plugin's lifetime)"]:::core
  gs["deck-core<br/>global-settings<br/>(single writer)"]:::core
  boot["plugin.ts<br/>store-ready startup block"]:::core
  store["SettingsStore<br/>global-settings.json<br/>(per ecosystem, under LOCALAPPDATA)"]:::core
  core(["IDeckPlatformAdapter — SEAM 2"]):::seam
  host["deck host store"]:::ext
  site["iracedeck.com<br/>changelog.json · voice-catalog.json"]:::ext

  win -->|"PI protocol over ws://127.0.0.1"| srv
  pi -->|"global settings over ws://127.0.0.1, token on the upgrade"| srv
  srv -->|"changed keys only"| gs
  gs -->|"save (debounced, atomic)"| store
  store -->|"load at startup"| gs
  gs -->|"push on any change"| srv
  srv --> win
  srv --> pi
  win -->|"GET /updates/status — is there a newer version?"| srv
  srv -->|"fetch changelog.json — 1 h cache, opt-out"| site
  host -->|"read ONCE — migration"| core
  core --> gs
  gs -->|"store ready"| boot
  boot -->|"mirror once per start — full object + _settingsChannel"| core
  core --> host
  host -.->|"one bootstrap read — _settingsChannel"| pi
  pi -->|"per-action settings, sendToPlugin, the bootstrap read"| host

  classDef ext fill:#33404d,color:#fff,stroke:#1d262e;
  classDef seam fill:#8e44ad,color:#fff,stroke:#5e2d73,stroke-width:3px;
  classDef core fill:#2d7dd2,color:#fff,stroke:#1f5793;
```

The window is the PI framework re-hosted: the same `sdpi-components.js`, `pi-components.js`, and `global-*.ejs` partials, talking to a **fake host** inside the plugin that speaks the global-settings subset of the Elgato PI protocol. Anything the plugin does on the window's behalf — persist its bounds, switch a deck's profile, play an audio preview, reveal the settings file in Explorer, answer SimHub reachability (a direct fetch from the window's origin is cross-origin) — arrives as a `sendToPlugin` command and is validated in `deck-core`. The same cross-origin constraint gives the window's What's New tab its one runtime (#1016): the plugin fetches the changelog artifact the website publishes, keeps only the dated releases newer than the running build, sanitizes their bullets to a four-tag allow-list, and serves the verdict at `GET /updates/status` — cached for an hour, gated on a setting, and silent about every failure, so the compiled-in release notes never depend on it. That is the only request the plugin makes to anything but iRacing and SimHub. The page is opened as a chromeless app window in a Chromium browser with a dedicated profile, and closes itself when its socket to the plugin dies. The server is no longer started on demand: it comes up from the plugin's store-ready startup block and stays up, so its address is known before any UI asks for it — and that same block, in each plugin's `plugin.ts` rather than `deck-core`'s global-settings module, is what mirrors the store, plus the server's `_settingsChannel`, to the deck host for the PIs to bootstrap from — the channel itself is never persisted in the plugin's own file. If the settings file can't be read, the block never runs: no server, no channel.

Property Inspectors reach the same server through a bridge script the build injects ahead of `sdpi-components.js` (`pi-settings-bridge.js` on Elgato and Mirabox, the Ulanzi PI bridge on Ulanzi). Both run one shared state machine: when the PI's host socket opens it makes a single plain `getGlobalSettings` read, takes `_settingsChannel` out of the answer, opens the loopback socket, and from then on global-settings frames go to the plugin and the plugin's pushes go to sdpi — the host's are dropped, because the file is truth. Everything else a PI does (per-action settings, `sendToPlugin`, `openUrl`) still goes to the deck host untouched. If there is no channel, the socket is refused, or a phase doesn't settle within three seconds, the PI falls back to the host path with a console warning — it keeps displaying and per-action settings keep working, but global-settings edits made there stay in the deck host's copy, which the plugin no longer reads; a later push carrying a channel it hasn't tried switches it over. So the loopback server is the one writer's front door for every surface, and the guard that protects it accepts a valid token whatever the request's `Origin` — Property Inspectors are `file://` or host-served pages — while a token-less request must still match the loopback origin before its `SameSite=Strict` cookie counts. Details, security model, and rules: `.claude/rules/settings-window.md` and `.claude/rules/global-settings.md`.

## The Race Engineer branch

The Race Engineer is a self-contained subsystem hanging off SEAM 1. It subscribes to the same bus, but instead of drawing icons it picks voice lines and plays them through a native mixer.

Its clips come from two places (#1034). The compiled-in manifest is the **built-in** half — the walkie-talkie sfx plus whatever voice the plugin bundles. **Installed voice packs** under `%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices` supply the rest — dropped in by hand, or downloaded from the published catalog by `deck-core`'s installer (#1100), which verifies the archive against the hash the catalog states, extracts it under its own entry validation, and swaps it into place so a failure at any step leaves the pack already installed untouched. Either way `deck-core` scans that directory, `audio-service` resolves a clip against an ordered list of roots (the plugin's own assets first, then one root per pack), and the scenario engine consumes the union of their manifests. Because each pack contributes paths in the same `voice/<id>/…` shape, nothing downstream — pool derivation, `{voice}` substitution, validation — knows a second root exists.

Since #1064 the **words** are the pack's too, not only the recordings. A scenario is split into two artifacts that pair by id. The code keeps the **contract** — the trigger (`when` / `where`), the scheduling knobs (weight, family, interrupt, cooldown, …), the channel, and the default radio frame — and registers the **vocabulary** a script may name: every spoken value (`defineVar`), yes/no condition (`defineCond`) and multi-way `case` (`defineCase`, with its key set declared) is a resolver in code, each with a description the future reference is generated from. The pack owns the **script**: `voice/<id>/callouts.json`, one per voice, a JSON document in the `@iracedeck/callout-script` grammar that says which clips, pools and vocabulary to assemble for each contract, in what order, and which callouts to skip. The grammar's only operator is `!`; a pack can reference the vocabulary but never define any of it, so it cannot change when a callout fires or what it may interrupt. The same scanner in `deck-core` that admits a pack's clips reads its script beside them — and the same reader serves the plugin's bundled voice — and the voice-pack service hands the engine one map of voice id → parsed script (`setScripts`) after every scan, straight after the merged manifest, so a script is never live before its clips are. The engine compiles every voice's script eagerly against the contracts and vocabulary it holds: an entry naming something unknown is skipped with one warning, a callout the script leaves out is skipped silently, and a voice with no script is a valid clips-only voice whose callouts all skip (the plugins raise the `voice-script-missing` banner when that voice is the active one). At fire time a contract looks up the active voice's compiled sequence and wraps it in the **frame** the pack defines — the radio beeps and the ambience bed, once inline in 35 sequences as `@pit-crew.radio-open` / `-close` — dropping the beep steps or the ambient steps according to the **Radio beeps** / **Pit ambience** settings, read live, and only when there is speech to wrap. The grammar is its own leaf package (`zod` its only dependency) because three consumers that must not depend on each other validate the same contract: the engine (compile), the scanner (admit), and the asset generator that extracts the committed artifact from `configs/<id>.voice.json` (`pnpm generate:callout-scripts`), which the plugin build copies into `assets/audio` and the packer stages into every archive. The flags family took this shape in #1064 and #1065 moved every other family across, one conditional step at a time (a closed-set table becomes a `case`, a predicate a named condition, a value a var; a script may also define `fragments` it includes within itself, inlined at compile time), so the whole catalog is contracts in code plus entries in the pack — the `Scenario` type with an inline sequence survives only as an engine primitive for tests — and the bundled voice's script is held complete by a test, while each voice's script is held to its own clips by another.

```mermaid
flowchart TB
  bus(["event-bus<br/>SEAM 1"]):::seam
  scen["audio-scenarios<br/>scenario engine<br/>(contracts + vocabulary in code)"]:::audio
  assets["audio-assets<br/>(bundled clips + callouts.json)"]:::audio
  packs["installed voice packs<br/>(%LOCALAPPDATA%)<br/>clips + callouts.json per voice"]:::ext
  scan["deck-core<br/>voice-pack scanner + service"]:::core
  gs["deck-core<br/>global settings<br/>Radio beeps · Pit ambience"]:::core
  svc["audio-service<br/>(ordered audio roots)"]:::audio
  nat["audio-native<br/>(miniaudio mixer)"]:::audio
  spk["speakers"]:::ext

  bus -->|"subscribe (when: event)"| scen
  assets -->|"built-in manifest"| scen
  assets -->|"bundled voice's script"| scan
  packs -->|"scan: clips + scripts"| scan
  scan -->|"merged manifest (setManifest)"| scen
  scan -->|"voice id → script (setScripts)"| scen
  gs -.->|"frame options, read at fire time"| scen
  cat["iracedeck.com<br/>voice-catalog.json"]:::ext
  inst["deck-core<br/>voice-pack installer<br/>verify · validate · atomic swap"]:::core
  cat -->|"catalog (user-initiated)"| inst
  inst -->|"install / update / remove"| packs
  scen -->|"play voice sequence<br/>(frame + script, compiled per voice)"| svc
  assets -.->|"root 1"| svc
  packs -.->|"root 2..n"| svc
  svc --> nat
  nat --> spk

  classDef core fill:#2c3e50,color:#fff,stroke:#1a252f;
  classDef ext fill:#33404d,color:#fff,stroke:#1d262e;
  classDef seam fill:#8e44ad,color:#fff,stroke:#5e2d73,stroke-width:3px;
  classDef audio fill:#2e9e5b,color:#fff,stroke:#1f6e40;
```

## Package dependency map

The diagrams above show **runtime flow**. This one shows something different: **build-time imports** — which package depends on which. Read the arrows as "imports." They point *downward*, toward the foundation.

```mermaid
flowchart TB
  subgraph plugins["Plugins — compose everything"]
    psd["iracing-plugin-stream-deck"]:::plugin
    pmb["iracing-plugin-mirabox"]:::plugin
    pul["iracing-plugin-ulanzi"]:::plugin
  end
  subgraph adapters["Device adapters"]
    aelg["deck-adapter-elgato"]:::adp
    amb["deck-adapter-mirabox"]:::adp
    aul["deck-adapter-ulanzi"]:::adp
  end
  subgraph shared["Shared action layer"]
    acts["iracing-actions"]:::core
    pic["pi-components"]:::core
  end
  subgraph brain["Core / translate / scenarios"]
    dc["deck-core"]:::core
    sei["sim-events-iracing"]:::sim
    asc["audio-scenarios"]:::audio
  end
  subgraph platform["Platform + services"]
    sdk["iracing-sdk"]:::sim
    eb(["event-bus"]):::seam
    asv["audio-service"]:::audio
    ic["icon-composer"]:::core
  end
  subgraph foundation["Foundation — no internal deps"]
    icons["icons"]:::core
    rast["rasterizer"]:::core
    pinat["iracing-native"]:::sim
    anat["audio-native"]:::audio
    aasset["audio-assets"]:::audio
    tdata["track-data"]:::sim
    cscript["callout-script"]:::audio
  end

  psd --> aelg
  pmb --> amb
  pul --> aul
  psd --> acts
  pmb --> acts
  pul --> acts
  psd --> pic
  pmb --> pic
  pul --> pic
  psd --> rast
  pmb --> rast
  pul --> rast

  aelg --> dc
  amb --> dc
  aul --> dc

  acts --> dc
  acts --> eb
  acts --> icons
  acts --> sei
  acts --> asc

  dc --> ic
  dc --> sdk
  sei --> eb
  sei --> sdk
  sei --> tdata
  asc --> asv
  asc --> aasset
  asc --> eb
  asc --> sei
  asc --> cscript
  dc --> cscript
  aasset -.-> cscript

  sdk --> pinat
  asv --> anat

  classDef seam fill:#8e44ad,color:#fff,stroke:#5e2d73,stroke-width:3px;
  classDef sim fill:#d9822b,color:#fff,stroke:#9c5e1f;
  classDef core fill:#2d7dd2,color:#fff,stroke:#1f5793;
  classDef audio fill:#2e9e5b,color:#fff,stroke:#1f6e40;
  classDef adp fill:#16a085,color:#fff,stroke:#0e6f5c;
  classDef plugin fill:#596775,color:#fff,stroke:#3c4651;
```

To keep this readable, `@iracedeck/logger` (imported by nearly every package) and a few cross-cutting edges are omitted — the three plugins also pull in the audio stack, `event-bus`, and `sim-events-iracing` directly. The shape that matters: `deck-core` is the hub the device adapters share, and the foundation packages at the bottom depend on nothing internal. `rasterizer` is a foundation package too (it wraps `@resvg/resvg-js` and has no internal iRaceDeck dependencies), but note the arrow direction: each **plugin** imports it and injects a render function into `deck-core`'s rasterizer service at startup (`initializeRasterizer(...)`, gated by the `pngRasterization` feature flag) — `deck-core` itself never imports `rasterizer`, so there's deliberately no `deck-core → rasterizer` edge here. `callout-script` (#1064) is the other foundation package with more than one importer above it: the voice-pack script grammar and its parser, with `zod` as its only dependency, imported by `audio-scenarios` (to compile a script against the contracts), by `deck-core` (to admit one while scanning a pack), and — the dashed edge, a devDependency — by `audio-assets`, whose generator extracts the committed `voice/<id>/callouts.json` from the authored voice config and validates it with the same parser. It is a separate package precisely so those three never have to import each other: `deck-core` must not depend on the Race Engineer to validate a file.

## Seams & where the abstraction leaks

The system has exactly two intended seams, and naming what each one buys you is the fastest way to understand the codebase:

- **SEAM 1 — `event-bus`.** Everything upstream is sim-specific; everything that subscribes is meant to be sim-agnostic. Adding a new sim is, in principle, "write a new translator that publishes the same event catalog."
- **SEAM 2 — `IDeckPlatformAdapter`.** One shared action set is defined once and runs on every device. Adding a new device is "write a new adapter that implements the interface" — which is exactly how Mirabox and Ulanzi were added after Elgato.

Honest architecture documents its leaks, too. These are the places where the clean story above doesn't fully hold today:

- **Inbound is abstracted; outbound is not.** Telemetry is funneled through the sim-agnostic bus, but the command path is still iRacing-shaped: `getCommands()` returns iRacing SDK commands, and `deck-core` imports `iracing-sdk` directly. A second sim would need its own command vocabulary, which has no seam yet.
- **The shared layer isn't purely sim-agnostic.** `iracing-actions` imports `iracing-sdk` and `sim-events-iracing` directly — not only `deck-core` + `event-bus`. So "everything right of SEAM 1 is sim-agnostic" is an aspiration the action layer doesn't fully meet.
- **Device differences leak around the adapter.** The Stream Deck+ touch strip only exists on Elgato hardware, so touch-strip feedback and touch-tap input are handled at *build time* via a platform [feature flag](/docs/development/feature-flags/) (`dialFeedback`), not expressed through `IDeckPlatformAdapter` — a real device difference living outside the device seam. (A previous device difference here — divergent SVG rendering capability between hosts' own engines — was eliminated rather than papered over: since issue #642, icons still cross SEAM 2 as SVG, but each adapter's context implementation converts them to PNG in-plugin via `deck-core`'s rasterizer service before the host send, so no host-specific SVG engine is in the picture anymore.)
- **Ulanzi reuses Elgato's plugin and action UUIDs verbatim.** A pragmatic coupling: UlanziStudio doesn't validate the UUID prefix, so reusing the canonical IDs avoided a parallel identity scheme.
- **`onHostReady` sits ON the interface, but optional.** Only the two WebSocket adapters can report the moment their socket opens; Elgato's SDK queues a send until the connection exists, so it declares nothing at all. Optional rather than required so that absence is a statement — "there is nothing to wait for" — instead of a stub that satisfies the type while never honouring the contract. It is the inverse of the `openUrl` gap below: on the seam because `deck-core` must consume it, optional because two of three adapters have nothing to say.
- **`openUrl` sits off the interface on purpose.** It's a concrete method on each adapter rather than part of `IDeckPlatformAdapter`, a deliberate gap that avoids touching every typed mock adapter for a rarely-used capability.
- **Some pieces are Windows-native.** `iracing-native` (keyboard/window) and `audio-native` (mixer) are C++ addons that fall back to mocks on other platforms — see [cross-platform development](/docs/development/setup/).
