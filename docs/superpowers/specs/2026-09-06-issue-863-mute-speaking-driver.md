> **Issue:** [#863](https://github.com/niklam/iracedeck/issues/863) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Audio Controls: mute the driver who is talking

## The problem

kev2377 asked on Discord for a deck key that mutes the driver currently speaking on voice chat, so one loud or distracting person can be silenced without turning the whole channel off. Audio Controls already covers the channel-wide case: its Voice Chat mode's **Mute** action taps `audioVoiceChatMute`, which is iRacing's *Mute Voice Chat*. There is no per-driver equivalent on the deck today, and the workaround — a raw Stream Deck keyboard key — bypasses the plugin's binding model, so it is invisible to the missing-binding warning and to the settings window's key-bindings table.

iRacing exposes the per-driver case as its own control, **Mute a Driver** (`docs/keyboard-shortcuts.md`, Chat → Voice Chat: default `Shift+Ctrl+Alt+D`, no SDK equivalent). The maintainer's ruling (2026-09-06) follows from that: this is a keybind sub-action of Voice Chat, not an SDK or chat-macro feature, and it is ordered last in 3.3.0.

## What ships

Audio Controls' Voice Chat mode gains a second **Action** value beside Mute: **Mute a Driver** (iRacing's own wording). Pressing the key taps a new global binding, `audioVoiceChatMuteDriver`, defaulting to iRacing's `Shift+Ctrl+Alt+D`. It is the third Voice Chat action and needs no other setting. Keypad only.

## Decisions

### 1. An Action value inside Voice Chat, not a new Mode

The keypad half is a `{category}-{action}` pair, and every consumer keys off that string: `AUDIO_ICONS`, `AUDIO_CONTROLS_TITLES`, `AUDIO_CONTROLS_GLOBAL_KEYS` (through `resolveGlobalKey`), and the comms catalog's `keybindBy("action", …)` map for `voice-chat`. Adding `mute-driver` to the `action` enum and one entry to each of those four tables is the whole feature — no control flow changes, and `setActiveBinding`, the `ird-binding-status` line and the icon's missing-binding overlay all follow for free.

Rejected: a sixth top-level Mode. It would need its own category with exactly one action, a second `voice-chat`-shaped comms entry, and its own PI branch in the category/action visibility script — all to express something the `action` axis already models. It also reads wrong: this *is* a voice-chat control.

The PI's existing machinery covers the new option: `MUTE_CATEGORIES` removes the Mute option from the DOM for every non-Voice-Chat category (`sdpi-select` ignores `style.display`), and the Mute a Driver option is removed by the same code path.

### 2. A plain tap; what iRacing does with it is iRacing's business

`tapBinding("audioVoiceChatMuteDriver")`, exactly like the existing Mute action. No hold, no dual-press.

What the sim does on a second press is **unverified**: `docs/keyboard-shortcuts.md` records the control's name and default key but not whether it toggles the mute on the same driver or only ever mutes. It does not change what the action sends — a keybind action taps the user's binding and iRacing decides — but it does decide one sentence of the website copy, so it must be settled during the manual test (below) before the page is written.

### 3. No readback, and no "who is talking" display in this issue

The action fires blind. iRacing publishes `RadioTransmitCarIdx` ("the car index of the current person speaking on the radio", `docs/reference/telemetry-vars.json`), but nothing in the repo types or reads it today, and there is no telemetry for *who is muted* at all — so even with the transmitter known, the key could not show state. The icon therefore carries no on/off variant, the same blind one-way tap the channel mute already is.

A "currently talking: #77" key or dial strip is a genuinely different feature: it needs `RadioTransmitCarIdx` added to the translator's snapshot and diffed into a bus event, plus a driver-name lookup. Recorded as a possible follow-up on the issue, not built here — #863 is the small keybind the requester asked for.

### 4. Keypad only; the dial press slot stays as it is

The dial's Mute / Unmute press is keyed by `dial.category` through `dialMuteBindingMap()`, a map from keybind category to its mute binding. A driver-mute press exists for exactly one category, so it would need either a fourth `DIAL_PRESS_ACTIONS` value whose availability depends on the selected category — a new PI gating rule and a new hidden-option dance — or a per-category exception inside the existing one. That is not free, and it lands on the dial surface #1120 is actively reworking, while #863 is ordered last in 3.3.0. Keypad only, and revisit once #1120 has shipped.

### 5. One new icon, not a reused one

`packages/icons/audio-controls/voice-chat-mute-driver.svg`: a single head-and-shoulders silhouette wearing a headset, with the same red strike-through the existing `voice-chat-mute` uses (`graphic2Color`, locked). The existing mute icon is a headset flanked by sound waves on both sides — it reads as "the channel"; one person reads as "this person". Two-line title, MUTE over DRIVER. Reusing `voice-chat-mute.svg` with only a different title would leave two visually identical keys doing different things, which `icons.md` forbids.

## Verification

Unit: the settings schema parses `mute-driver` and keeps `.catch` degradation per field; `generateAudioControlsSvg` picks the new icon and title for `voice-chat` + `mute-driver`; `resolveGlobalKey` returns the new binding key; the comms-catalog freshness test and its key cross-check against `key-bindings.json` pass after `pnpm generate:action-comms`; the icon-preview and icon-defaults freshness tests pass after regeneration.

Manual, in a multi-driver online session with voice chat active (the maintainer's stated test condition): with the binding unset, the key shows the ⚠️ overlay and the PI status line says so; with it set, pressing while another driver transmits silences that driver and leaves the rest of the channel audible; the channel-wide Mute still works independently; the binding survives a plugin restart. Settle Decision 2's open question in the same session: press again while the same driver transmits and record whether they come back.

## Affected artifacts

- `packages/iracing-actions/src/actions/audio-controls/`: `audio-controls-settings.ts` (the `action` enum, `VOICE_CHAT_MUTE_DRIVER_KEY`, `AUDIO_CONTROLS_GLOBAL_KEYS`), `audio-controls.ts` (`AUDIO_ICONS`, `AUDIO_CONTROLS_TITLES`), `audio-controls.ejs` (the option + its removal list), and both test files.
- `packages/iracing-actions/src/actions/data/key-bindings.json` (`audioControls` row) and `comms-catalog.ts` + `pnpm generate:action-comms`.
- `packages/icons/audio-controls/voice-chat-mute-driver.svg`, then `node scripts/generate-icon-previews.mjs` and `node scripts/generate-icon-defaults.mjs`.
- Website: `docs/actions/audio-voice/audio-controls.md` (a bullet under Voice Chat → Setting: Action) and the keyboard-shortcut table if it lists the action's bindings; changelog under **Features** plus `pnpm generate:changelog-data`.
- `.claude/skills/iracedeck-actions/SKILL.md`: the Audio Controls mode row's voice-chat action list.
