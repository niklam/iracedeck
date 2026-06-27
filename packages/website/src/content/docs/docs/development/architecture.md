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

- **A typed, sim-agnostic event catalog** — the vocabulary of things that can happen (`flag.yellow.raised`, an overtake, a fuel-threshold crossing, a pit-lane transition). It's a plain pub/sub package that imports no simulator SDK, so the vocabulary stays the same no matter which sim feeds it.
- **Decoupled fan-out** — publishers and subscribers never reference each other. The translator publishes; the actions and the Race Engineer each subscribe independently. You can add a consumer without touching the producer, and — in principle — swap the producer without touching the consumers.
- **A generic telemetry snapshot on the envelope** — alongside the semantic payload, each event carries the latest raw telemetry in a generic field. This is the sim-specific escape hatch: the Race Engineer's radar and spotter engines read it (via `getLatestTelemetry`) because their job needs the full per-car picture, not a single event. It is also the part of this seam that is **not** sim-agnostic yet — see the leaks below.

The catalog spans around 60 events grouped into families — pit lane and stops, flags, start lights, rolling start, pit service, tires, car control, pit limiter, incidents and off-tracks, overtakes and position changes, laps, fuel, proximity radar, track wetness, damage, and session lifecycle. Payloads range from empty (pure transitions like `pitLane.entered`) to rich records:

```text
flag.yellow.raised          → { scope: "local" | "full" }
fuel.lapsRemaining.crossed  → { threshold: number, laps: number }
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

The render path is fully abstracted: `iracing-actions` hands a finished icon to `deck-core`, and whichever adapter is loaded paints it on the real hardware. The command path has three mechanisms — the SDK broadcast (`getCommands()`) is preferred, native keyboard injection (`getKeyboard()`) covers what the SDK can't, and chat macros cover the rest.

## The Race Engineer branch

The Race Engineer is a self-contained subsystem hanging off SEAM 1. It subscribes to the same bus, but instead of drawing icons it picks voice lines and plays them through a native mixer.

```mermaid
flowchart TB
  bus(["event-bus<br/>SEAM 1"]):::seam
  scen["audio-scenarios<br/>scenario engine"]:::audio
  assets["audio-assets<br/>(voice clips)"]:::audio
  svc["audio-service<br/>(bus routing, volumes)"]:::audio
  nat["audio-native<br/>(miniaudio mixer)"]:::audio
  spk["speakers"]:::ext

  bus -->|"subscribe (when: event)"| scen
  assets -->|"clips"| scen
  scen -->|"play voice sequence"| svc
  svc --> nat
  nat --> spk

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
    pinat["iracing-native"]:::sim
    anat["audio-native"]:::audio
    aasset["audio-assets"]:::audio
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
  asc --> asv
  asc --> aasset
  asc --> eb
  asc --> sei

  sdk --> pinat
  asv --> anat

  classDef seam fill:#8e44ad,color:#fff,stroke:#5e2d73,stroke-width:3px;
  classDef sim fill:#d9822b,color:#fff,stroke:#9c5e1f;
  classDef core fill:#2d7dd2,color:#fff,stroke:#1f5793;
  classDef audio fill:#2e9e5b,color:#fff,stroke:#1f6e40;
  classDef adp fill:#16a085,color:#fff,stroke:#0e6f5c;
  classDef plugin fill:#596775,color:#fff,stroke:#3c4651;
```

To keep this readable, `@iracedeck/logger` (imported by nearly every package) and a few cross-cutting edges are omitted — the three plugins also pull in the audio stack, `event-bus`, and `sim-events-iracing` directly. The shape that matters: `deck-core` is the hub the device adapters share, and the foundation packages at the bottom depend on nothing internal.

## Seams & where the abstraction leaks

The system has exactly two intended seams, and naming what each one buys you is the fastest way to understand the codebase:

- **SEAM 1 — `event-bus`.** Everything upstream is sim-specific; everything that subscribes is meant to be sim-agnostic. Adding a new sim is, in principle, "write a new translator that publishes the same event catalog."
- **SEAM 2 — `IDeckPlatformAdapter`.** One shared action set is defined once and runs on every device. Adding a new device is "write a new adapter that implements the interface" — which is exactly how Mirabox and Ulanzi were added after Elgato.

Honest architecture documents its leaks, too. These are the places where the clean story above doesn't fully hold today:

- **Inbound is abstracted; outbound is not.** Telemetry is funneled through the sim-agnostic bus, but the command path is still iRacing-shaped: `getCommands()` returns iRacing SDK commands, and `deck-core` imports `iracing-sdk` directly. A second sim would need its own command vocabulary, which has no seam yet.
- **The shared layer isn't purely sim-agnostic.** `iracing-actions` imports `iracing-sdk` and `sim-events-iracing` directly — not only `deck-core` + `event-bus`. So "everything right of SEAM 1 is sim-agnostic" is an aspiration the action layer doesn't fully meet.
- **Device differences leak around the adapter.** SVG rendering capability differs by device (QT5 on Mirabox vs QT6.7+ on Elgato). That's handled at *build time* via platform [feature flags](/docs/development/feature-flags/), not expressed through `IDeckPlatformAdapter` — so a real device difference lives outside the device seam.
- **Ulanzi reuses Elgato's plugin and action UUIDs verbatim.** A pragmatic coupling: UlanziStudio doesn't validate the UUID prefix, so reusing the canonical IDs avoided a parallel identity scheme.
- **`openUrl` sits off the interface on purpose.** It's a concrete method on each adapter rather than part of `IDeckPlatformAdapter`, a deliberate gap that avoids touching every typed mock adapter for a rarely-used capability.
- **Some pieces are Windows-native.** `iracing-native` (keyboard/window) and `audio-native` (mixer) are C++ addons that fall back to mocks on other platforms — see [cross-platform development](/docs/development/setup/).
