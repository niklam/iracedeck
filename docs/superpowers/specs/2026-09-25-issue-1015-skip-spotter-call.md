# Skip Spotter Call

> **Issue:** [#1015](https://github.com/niklam/iracedeck/issues/1015) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

The issue was filed while 2.5.0 was unreleased and #809's spotter dial press had not shipped. Both have shipped since: the keypad label `MUTE SPOTTER` since the AI Spotter Controls action landed, and the Audio Controls dial's Spotter **Mute / Unmute** press in 3.0.0. Two of the issue's premises therefore no longer hold — "no settings migration" and "edit the existing 2.5.0 changelog line" — and this spec replaces them. Everything else in the issue stands.

## Decisions

### 1. The keypad mode is renamed, its value is not

The AI Spotter Controls mode reads **Skip Spotter Call** in the PI; `SPOTTER_TITLES.silence` and the `<desc>` title in `packages/icons/ai-spotter-controls/silence.svg` both become `SKIP CALL\nSPOTTER` (the map wins at runtime, so they change together). The stored `control: "silence"` value and the `spotterSilence` binding key stay: a value rename strands placed keys for no user-visible gain, and the binding label `Spotter Silence` is iRacing's own control name, which the user must match in iRacing's controls screen.

### 2. The dial gets a new press, `skip-call`, in its own binding table

Spotter's **Mute / Unmute** press is replaced by a new press value `skip-call`, labelled **Skip Spotter Call** in the PI and `Skip spotter call` on the touch strip. It is modelled exactly like #863's `mute-driver`: a new `DIAL_SKIP_CALL_BINDINGS: Partial<Record<KeybindDialCategory, string>>` with the single entry `spotter: SPOTTER_GLOBAL_KEYS.silence`, a `dialSkipCallBindingMap()` twin, a `pressBindingKeys` branch, a dispatch branch in `audio-dial-surface.ts`, a `"skip-call"` entry in the comms catalog built with `keybindBy("dial.category", dialSkipCallBindingMap())`, and a PI conditional option driven by the generated comms entry. `spotter` leaves `DIAL_MUTE_BINDINGS`, so Mute / Unmute is offered for Voice Chat, Race Engineer and Radar only.

Rejected: relabelling Mute / Unmute per category. The #863 spec already rejected one press value meaning different things by Mode, because the trigger description and the PI option cannot honestly label it.

### 3. Stored `spotter` + `mute-unmute` is migrated in place

A dial saved on 3.0–3.3 with `{ category: "spotter", pressAction: "mute-unmute" }` is rewritten to `pressAction: "skip-call"`. Without it the dial would silently lose its press: the dispatcher would find no mute binding for spotter, and the PI's "a press the current Mode cannot fire falls back to None" rule would overwrite the choice the first time the PI opened.

The shape follows `camera-controls/migrate-focus-on-exiting.ts`: a pure `migrateSpotterMuteToSkipCall(raw) → { migrated, changed }` helper in `audio-controls/`. The action's settings parse runs every read through it, so dispatch is right even before the write lands, and `onWillAppear` / `onDidReceiveSettings` persist the migrated object with `setSettings` when `changed`, logging and swallowing a failed persist. The helper touches only `dial.pressAction` for that one pair and returns every other key untouched, including unknown ones. Only a spotter dial is rewritten; `mute-unmute` under any other category is left alone.

`willAppear` fires before the PI can open on that instance, so the PI sees the migrated value and the None fallback never meets the legacy pair.

### 4. Documentation says the control is one-shot, and that no permanent mute exists

The AI Spotter Controls page's section becomes **Skip Spotter Call**: it stops the call currently playing, and iRacing offers no control that mutes the spotter permanently. The Audio Controls page loses the sentence implying a silenced state we merely cannot read; a one-shot has no state to show. `docs/reference/actions.json` and the `iracedeck-actions` skill drop the "like voice-chat mute" analogy and list the new press. The keyboard-shortcut tables and `docs/stream-deck-plugin-unified.md` are left alone: they name the iRacing binding, which is unchanged.

### 5. Changelog: one Improvements line under 3.4.0

Both shipped behaviours change, so this is one **Improvements** bullet in the unreleased 3.4.0 section covering the key label, the dial press and the fact that existing dials carry over. The 3.0.0 line describing the old press is released history and is not edited. Keys whose user typed their own Title Text keep it, which is correct.

## Out of scope

- What is sent: both surfaces still tap iRacing's Spotter Silence binding.
- The `silence.svg` graphic (a head with a red slash). The label carries the meaning at speed; a new graphic is a separate icon decision.
- Renaming `control: "silence"`, the `spotterSilence` key, or the `SpotterControl` union member.
- Any Mirabox / Ulanzi dial surface — dials are Elgato-only, though the migration runs in the shared action and so covers any host's stored settings.

## Testing

- Unit: the migration helper (spotter + mute-unmute rewritten; other categories, other presses, missing `dial`, non-object input and unknown sibling keys untouched); the action persisting the migration on appear and on received settings, and not calling `setSettings` when nothing changed; `pressBindingKeys`, dispatch and trigger description for `skip-call`; `mute-unmute` no longer resolving for spotter; the new `SPOTTER_TITLES` value; the regenerated `action-comms.json`.
- Manual, on a Stream Deck+: a dial saved on master as Spotter + Mute / Unmute shows **Skip Spotter Call** in the PI after upgrading, the strip reads `Skip spotter call`, and a press cuts the current spotter call in iRacing; a fresh Spotter dial offers Skip Spotter Call and not Mute / Unmute; Voice Chat still offers Mute / Unmute; an AI Spotter Controls key without a Title override reads `SKIP CALL / SPOTTER`.
