> **Issue:** [#1111](https://github.com/niklam/iracedeck/issues/1111) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Stream Deck: switch to a bundled profile automatically by session kind

## The problem

lexoduss asked on Discord for iRaceDeck profiles to be activated automatically by session type, listing eight kinds: Open Practice, Test Drive, Race, Spotting, Open Qualifying, Solo Qualifying, Garage/Replay, Race Control. Peter's reply — "limited to what telemetry options are available to set the profile" — is the right frame, and there is a second limit he did not name that shapes the feature more.

## The constraint that decides the shape

**A plugin can only switch to profiles it ships.** The Elgato SDK's own typing says so in its doc comment ("plugins may only switch to profiles distributed with the plugin, as defined within the manifest, and cannot access user-defined profiles") and `.claude/rules/profiles-and-devices.md` records it as policy. There is no API that activates a user's own profile, and no API that reports which profile is active.

So the request as written — point the feature at _my_ practice profile — is impossible, and no amount of design changes that. What is possible is the thing one step removed: iRaceDeck ships profiles, the user edits them in the app (bundled profiles install with `Readonly: false`), and the plugin switches between those. That is what this spec builds.

Profiles are Elgato-only. Mirabox and Ulanzi have no profile system; `switchToProfile` is a no-op there and the whole feature is gated on the `profiles` platform flag.

## What ships

- Three new bundled profiles per target device — **iRaceDeck Practice**, **iRaceDeck Qualifying**, **iRaceDeck Race** — as editable starting points.
- A **mapping table** in the settings window's Profiles tab: one row per detectable session kind, each a dropdown of bundled profiles plus "no switch", behind a master toggle.
- A reactor that switches every connected profile-capable deck when the kind changes, and returns it to the profile it was on before the first automatic switch when iRacing exits.

## Decisions

### 1. Ship editable canvases, not just a map over the existing four

Mapping only onto Default / Replay / Car Selector / Race Admin Per Car would be a smaller change with almost no value: a driver could route replay to the Replay profile and nothing else, since the other three are not session layouts. The point of the request is a _different_ deck per session, and that needs a profile per kind that the user can shape. The new profiles start as copies of Default so they work before anyone edits them, and ship `DontAutoSwitchWhenInstalled: true` like Replay.

Nine files (three templates × the three target devices, SD / XL / Plus XL) authored in the app per the authoring workflow, registered in `Profiles[]`, regenerated into `profiles.json`. The device-suffix scheme (#753) and `switchToBundledProfile` need no change.

### 2. The kinds are what the sim can tell apart, and the two it cannot are named

`SessionInfo.Sessions[].SessionType` distinguishes more than the shipped three-bucket `classifySessionType()` uses. The map offers:

| Kind            | Signal                                                                   |
| --------------- | ------------------------------------------------------------------------ |
| Practice        | `Practice`, `Lone Practice`, `Warmup`                                    |
| Testing         | `Offline Testing`                                                        |
| Open qualifying | `Open Qualify`                                                           |
| Solo qualifying | `Lone Qualify`                                                           |
| Race            | `Race`                                                                   |
| Replay session  | `WeekendInfo.SimMode === "replay"` (wins over the type)                  |
| In garage       | `IsInGarage` (wins while true; back to the session's profile on leaving) |

**Spotting** and **Race Control** have no signal. There is no spectator or spotter flag in telemetry, and "race control" is a role a human holds, not a state the sim reports; the nearest proxy for spectating (`DriverInfo.DriverCarIdx === -1`) is unmeasured and would be a guess. Both are stated in the issue and on the website as not offered, rather than mapped to a proxy that misfires.

A new `classifySessionKind()` lives beside the existing classifier; the three-bucket one is untouched, because every Race Engineer callout depends on its exact buckets.

### 3. Off by default, pre-filled

`profileAutoSwitchEnabled`, default **off**. Switching a user's deck without being asked is intrusive in a way a voice line is not — it moves the buttons under their hand — so this is the one feature in this batch that does not default on. The mapping (`profileForSessionKind<Kind>`, a bundled display name or empty) ships pre-filled — Practice → Practice, both qualifyings → Qualifying, Race → Race, Replay → Replay, Testing → Practice, Garage → no switch — so enabling the toggle works at once.

### 4. When it switches, and how it gets back

Triggers: the first snapshot after connect (the sim may already be in a session), `session.changed` (its payload carries only session numbers; the kind is read from the translator at that moment, the way the callout engine does), and the two garage edges. On iRacing exit — the app monitor's terminate hook — the reactor returns the deck to the profile it was on before the **first** automatic switch, through the per-device history stack Back-to-previous already keeps (#762); with nothing to pop it falls back the way Back does.

The stack is what makes "back" honest: the app's own back-link works only while the current profile was pushed by this plugin, so the plugin-owned history is the only reliable route, and it is already fed by every named switch.

Every connected profile-capable deck is switched; a device with no variant of the mapped profile is skipped and logged. The mapping is plugin-wide, not per device — per-device tables were weighed and are not worth their PI surface until someone asks.

### 5. Where it lives

A deck-core service: a pure `resolveProfileForKind(kind, mapping)` plus a thin reactor subscribing to the translator's kind and the garage flag, calling `switchToBundledProfile` / `requestProfileSwitchBack`. Wired in the Stream Deck plugin only, gated on `profiles`. The shape is the elevation-check and version-check pair: decision function tested in isolation, adapter thin.

## Alternatives rejected

**Decline.** Considered, because the literal request cannot be built. Rejected because the one-step-removed shape delivers the outcome the user described — a different deck per session — through editable profiles.

**Map onto the existing four only.** Decision 1.

**Proxy Spotting from `DriverCarIdx`.** Unmeasured; a wrong switch is worse than a missing one.

**Default on.** Decision 3.

## Open questions

- **Do user edits survive a plugin update that re-ships the profile file?** Bundled profiles do not reliably auto-install on updates, which suggests edits persist, but nothing in the repo has measured a _changed_ file against an edited install. Task: edit an installed bundled profile, ship a build with a modified file, observe. If edits are lost, the fallback is `AutoInstall: false` for these three plus a documented export-and-reimport step.
- Whether a manual switch to a personal profile mid-session should suppress automatic switching until the next session. Proposed no: the plugin cannot see that switch, and the toggle is the escape hatch.

## Verification

Classifier tests over every known `SessionType` string plus the two modes. Service tests for the trigger matrix and the return-on-exit. Manual: a practice → qualifying → race weekend on hardware, a garage visit mid-practice, closing the sim.
