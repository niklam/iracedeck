/**
 * Global Settings Manager
 *
 * Manages plugin-level global settings that apply across all action instances.
 * Platform-agnostic: uses IDeckPlatformAdapter instead of a specific SDK.
 *
 * Usage:
 * 1. Call initGlobalSettings(adapter, logger) once at plugin startup
 * 2. Use getGlobalSettings() to access current settings
 * 3. Settings are automatically updated when changed in Property Inspector
 *
 * Write-safety model (issue #896): global settings are one JSON blob with two
 * independent full-object writers (the PI via sdpi-components, and this
 * module), so every write path here defends against stale-cache lost updates —
 * a first-arrival gate queues writes made before the host has delivered real
 * settings, pending local writes are re-applied over stale host echoes,
 * unparseable persisted values are salvaged per-key instead of aborting the
 * whole parse, and a shrink guard restores host-known keys into outgoing
 * writes so they can never be silently deleted from storage.
 */
import type { ILogger } from "@iracedeck/logger";
import { z } from "zod";

import {
  DEFAULT_SETUP_WARNING_QUALIFYING_PATTERN,
  DEFAULT_SETUP_WARNING_RACE_PATTERN,
} from "./setup-warning-constants.js";
import type { IDeckPlatformAdapter } from "./types.js";
import { CHANGELOG_NOTIFICATION_POLICIES } from "./version-check.js";

/**
 * Schema for key binding values stored in global settings.
 * Matches the format used by the ird-key-binding component.
 * Exported for use by plugins defining their own key binding schemas.
 */
export const KeyBindingValueSchema = z.object({
  // default("keyboard") provides backward compat with persisted values that lack the field
  type: z.literal("keyboard").default("keyboard"),
  key: z.string().min(1),
  modifiers: z.array(z.string()).default([]),
  /** KeyboardEvent.code (e.g., "Quote") - identifies the physical key position */
  code: z.string().optional(),
  /** KeyboardEvent.key (e.g., "ä") - locale-correct character for display */
  displayKey: z.string().optional(),
});

export type KeyBindingValue = z.infer<typeof KeyBindingValueSchema>;

/**
 * Schema for SimHub Control Mapper role bindings.
 * Stored by the ird-key-binding component when in SimHub mode.
 */
export const SimHubBindingValueSchema = z.object({
  type: z.literal("simhub"),
  role: z.string().min(1),
});

export type SimHubBindingValue = z.infer<typeof SimHubBindingValueSchema>;

/**
 * Union type for all binding values (keyboard shortcut or SimHub role).
 */
export type BindingValue = KeyBindingValue | SimHubBindingValue;

/**
 * Type guard to check if a binding value is a SimHub role binding.
 */
export function isSimHubBinding(value: BindingValue | null | undefined): value is SimHubBindingValue {
  return value != null && value.type === "simhub";
}

/**
 * Schema for global plugin settings.
 * Uses passthrough to allow dynamic key binding properties (e.g., blackBoxLapTiming, blackBoxFuel).
 */
export const GlobalSettingsSchema = z
  .object({
    /**
     * When true, buttons show inactive/disabled state when iRacing is not connected.
     * Default: true. Uses the standard string/boolean coercion (issue #896) so a
     * persisted string value can't abort the whole settings parse.
     */
    disableWhenDisconnected: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true)
      .catch(true),
    /**
     * When true, the plugin writes verbose `DEBUG`-level logs; when false it
     * logs at `INFO` (issue #609). Production default is `false` so a fresh
     * install doesn't flood its `.log` with debug detail — debug logging is
     * opt-in for troubleshooting, enabled from the PI "Enable debug logging"
     * checkbox without a rebuild or reinstall. On Elgato the change takes
     * effect at runtime (`streamDeck.logger.setLevel` is runtime-mutable); on
     * Mirabox the adapter holds a shared mutable level its loggers read live,
     * so a mid-session toggle takes effect on the next log call. Persists
     * across restarts (it's a global setting). Default: false.
     */
    debugLogging: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(false),
    /**
     * When true, focus the iRacing window before sending keyboard inputs.
     * Ensures key presses reach iRacing even when another window is in the foreground.
     * Default: false (opt-in)
     */
    focusIRacingWindow: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(false),
    /**
     * Hostname or IP address of the SimHub instance for Control Mapper integration.
     * Default: "127.0.0.1"
     */
    // `.catch(...)` on this and every plain-value field below (issue #896): a
    // malformed persisted value falls back to the field default instead of
    // throwing and aborting the entire GlobalSettingsSchema.parse — which
    // would stall every setting, key bindings included (the
    // `spotterStillThereSeconds` / `changelogNotification` precedent).
    simHubHost: z.preprocess(
      (val) => (val === "" ? undefined : val),
      z.string().default("127.0.0.1").catch("127.0.0.1"),
    ),
    /**
     * HTTP port for SimHub's REST API (Control Mapper).
     * Default: 8888
     */
    simHubPort: z.preprocess(
      (val) => (val === "" ? undefined : val),
      z.coerce.number().min(1).max(65535).default(8888).catch(8888),
    ),
    /**
     * When true, changing fuel amount (add/reduce/set) automatically enables the fuel fill checkbox.
     * When false, the fuel fill state is preserved (uses #-fuel macro prefix).
     * Default: true (matches iRacing default behavior)
     */
    enableFuelingOnChange: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * On/off for the Race Engineer voice (Pit Crew action, Race Engineer
     * mode). Toggled by pressing the Race Engineer button — when off, the
     * Voice and Background audio buses are zeroed so any in-flight clip
     * silences immediately. Persists across plugin restarts. Default: false
     * — fresh installs stay quiet until the user opts in (issue #378).
     *
     * Renamed from `raceEngineerEnabled` (issue #515): the original name
     * shipped on builds where audio could fire without a Pit Crew button on
     * the deck. The rename forces every existing user back to the schema
     * default on next startup so the buggy state can't carry forward; an
     * active migration in plugin startup wipes the old key from storage.
     */
    pitCrewRaceEngineerEnabled: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(false),
    /**
     * On/off for the directional Radar proximity ticks (Pit Crew action,
     * Radar mode). Toggled by pressing the Radar button — independent from
     * Race Engineer so silencing the voice to talk to teammates on Discord
     * doesn't kill the proximity alerts. Persists across plugin restarts.
     * Default: false — fresh installs stay quiet until the user opts in
     * (issue #378). Renamed from `radarEnabled` (issue #515) — see the
     * note on `pitCrewRaceEngineerEnabled` for context.
     */
    pitCrewRadarEnabled: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(false),
    /**
     * Spotter per-callout opt-ins (issue #651). The spoken Spotter proximity
     * calls are a Race Engineer callout family — there is no standalone master;
     * they ride `pitCrewRaceEngineerEnabled` like flags/position/lap-time.
     * "Cars" gates every transition call (car/two cars/one car/three wide/clear/
     * combined); "StillThere" gates the repeating reminder while alongside (its
     * cadence is set by `spotterStillThereSeconds`).
     * Default `true` so users discover the calls (with Race Engineer enabled)
     * and turn off what they don't want; opt-out takes effect at event-arrival
     * time without cutting in-flight playback. Canonical id↔key mapping in
     * `SPOTTER_CALLOUT_SETTING_KEYS` (in `@iracedeck/audio-scenarios`).
     */
    calloutEnabledSpotterCars: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledSpotterStillThere: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * "Still there" reminder cadence in seconds (issue #651). While a car is
     * alongside the spotter repeats its reminder every N seconds; user-
     * configurable 1–10 s, default 3. Read live by the spotter engine on each
     * tick, so a change takes effect on the next reminder without a restart.
     */
    // `.catch(3)` so an out-of-range / malformed persisted value (e.g. a
    // hand-edited settings file) falls back to the default instead of throwing
    // and aborting the entire GlobalSettingsSchema.parse — which would stall
    // every setting, not just this one.
    spotterStillThereSeconds: z.coerce.number().min(1).max(10).default(3).catch(3),
    /**
     * Startup defaults for `pitCrewRaceEngineerEnabled` /
     * `pitCrewRadarEnabled` (issue #482). On every plugin start, after the
     * first global-settings arrival, the plugin copies these values into
     * the runtime keys above — overriding whatever the user toggled in the
     * previous session. Editing these during a running session is also
     * mirrored immediately into the runtime keys, so the checkbox has
     * visible effect without waiting for a restart. Default false — fresh
     * installs stay quiet on startup (matches the runtime keys'
     * fresh-install posture from #378). Renamed from
     * `raceEngineerEnabledOnStartup` / `radarEnabledOnStartup` (issue #515).
     */
    pitCrewRaceEngineerEnabledOnStartup: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(false),
    pitCrewRadarEnabledOnStartup: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(false),
    /**
     * Volume for the directional Radar ticks, 0–100 (mapped to 0.0–1.0 on
     * `AudioBus.Alerts`). Stepped by the Radar Volume Up/Down modes of the
     * Pit Crew action; sliding to 0 mutes the radar without toggling the
     * feature off. Default: 50 (issue #522 — first-run mix sits below
     * full-tilt so the slider has headroom in both directions).
     */
    radarVolume: z.coerce.number().min(0).max(100).default(50).catch(50),
    /**
     * Active voice used by Race Engineer scenarios — the key under
     * `voice/<voice>/` in `@iracedeck/audio-assets` (e.g., `"luca"`,
     * `"titan"`). Substituted into scenario `base: "voice/{voice}"` at
     * clip-resolution time. Empty string or unset means "no voice
     * selected" — the plugin seeds the first available voice from the
     * audio-assets manifest on startup. Persists across plugin restarts.
     */
    raceEngineerVoice: z.preprocess((val) => (val === undefined || val === null ? "" : val), z.string().default("")),
    /**
     * Volume for the Race Engineer voice, 0–100 (mapped to 0.0–1.0 on
     * `AudioBus.Voice`). Sliding to 0 silences voice scenarios without
     * disabling the feature. Default: 50 (issue #522 — first-run mix
     * sits below full-tilt so the slider has headroom in both
     * directions).
     */
    raceEngineerVolume: z.coerce.number().min(0).max(100).default(50).catch(50),
    /**
     * Volume for the pit ambience and walkie-talkie SFX, 0–100 (mapped to
     * 0.0–1.0 on `AudioBus.Background`, which carries both the ambient
     * loop and the radio open/close SFX). Defaults to 25 (issue #522 —
     * sits under the new 50 voice default so the engineer cuts through
     * cleanly out of the box; turn it up for a louder pit-lane
     * atmosphere). Lower default also helps users with audio-processing
     * sensitivities. Only takes effect while Race Engineer is enabled —
     * when the engineer is off, Background is muted to 0 regardless of
     * this value (issue #471).
     */
    backgroundVolume: z.coerce.number().min(0).max(100).default(25).catch(25),
    /**
     * Driver name the Race Engineer addresses the user as — the key
     * under `voice/<voice>/names/` (e.g., `"niklas"`, `"oivindl"`).
     * Substituted into welcome / pit-callout flows by referencing
     * `voice/{voice}/names/{driverName}.mp3`. Empty string means "no
     * name picked" — the plugin seeds the first available name on
     * startup.
     */
    driverName: z.preprocess((val) => (val === undefined || val === null ? "" : val), z.string().default("")),
    /**
     * Per-callout opt-in toggles (issue #467). Each subject the Race
     * Engineer announces has its own boolean — when false, that specific
     * callout is suppressed at event-arrival time so currently playing
     * announcements continue uninterrupted but no new callout of that
     * subject fires until the user re-enables it. All default to true so
     * existing users automatically receive any newly added callout
     * subject in a future release (forward-compat by default — the load-
     * bearing reason this is per-item booleans rather than an array).
     *
     * Naming convention: `callout<Polarity><Family><Subject>`. Polarity
     * is always positive (`Enabled`); the family noun (`Flag`,
     * `PitAction`, …) groups every member of the family for grep. The
     * canonical id↔key mapping lives in `@iracedeck/audio-scenarios`
     * (`FLAG_CALLOUT_SETTING_KEYS`). See `.claude/rules/global-settings.md`
     * for the full convention.
     */
    calloutEnabledFlagYellowLocal: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagYellowFull: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagYellowCleared: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagGreen: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagBlue: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagWhite: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagRed: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagBlack: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagCheckered: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagDebris: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagMeatball: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Missing-session-flag callout opt-ins (issue #480). Driver-black
     * (disqualify/furled/dq-scoring-invalid), race-progression
     * (crossed/one-pace-lap-to-go/green-held/ten-to-go/five-to-go), and
     * caution-waving (yellow-waving/caution-waving) variants. Plus two
     * grouped start-light opt-ins: `calloutEnabledStartLights` (the 3
     * gantry lines) and `calloutEnabledStartCountdown` (the 5 numeric
     * countdown clips). Same forward-compat semantics as the flag callouts
     * above — default `true` so existing users receive them automatically.
     * Canonical id↔key mappings in `FLAG_CALLOUT_SETTING_KEYS` and
     * `START_LIGHT_CALLOUT_SETTING_KEYS`.
     */
    calloutEnabledFlagDisqualify: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagFurled: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    // Furled-warning withdrawn callout opt-in (issue #669).
    calloutEnabledFlagFurledCleared: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagDqScoringInvalid: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagCrossed: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagOnePaceLapToGo: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagGreenHeld: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagTenToGo: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagFiveToGo: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagYellowWaving: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFlagCautionWaving: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledStartLights: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledStartCountdown: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    // Rolling-start pace-car callout opt-in (issue #660).
    calloutEnabledRollingStartPaceCar: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    // Pit-window open/closed callout opt-in (issue #655). One subject covers
    // both directions (pits opened / closed). Canonical id↔key mapping in
    // `PIT_WINDOW_CALLOUT_SETTING_KEYS`.
    calloutEnabledPitOpenClosed: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Damage callout opt-in (issue #489). Fires after the rising-edge
     * debounce on `EngineWarnings & (MandRepNeeded | OptRepNeeded)`. Same
     * forward-compat semantics as the flag callouts above. Canonical
     * id↔key mapping in `DAMAGE_CALLOUT_SETTING_KEYS`.
     */
    calloutEnabledDamageRepairNeeded: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Pit-service readback opt-ins (issue #476). Two subjects: the
     * "We're …" callout on pit entry and the "To confirm: …" callout
     * after pit exit. Same forward-compat semantics as flag callouts —
     * default `true` so existing users receive the readback without
     * editing settings, opt-out toggles them off at event-arrival
     * time without cutting in-flight playback. Canonical id↔key
     * mapping in `PIT_READBACK_CALLOUT_SETTING_KEYS`.
     */
    calloutEnabledPitReadbackEntry: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledPitReadbackExit: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Family-wide gate for the per-toggle pit-service request
     * confirmations (issue #468). One boolean covers fuel, tire-set,
     * compound, windshield-tearoff, and fast-repair on/off acks — the
     * driver either wants the engineer chiming in on every checkbox flip
     * or they don't, no per-service granularity needed.
     *
     * Read live via a closure passed into `registerPitCrew(...)` so a
     * mid-session toggle takes effect on the next event arrival without
     * cutting an in-flight clip. Default `true` so existing users keep
     * the acks they have today.
     */
    calloutEnabledPitServiceRequests: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Pit-service status callout opt-ins (issue #479). One boolean per
     * non-`None` `PlayerCarPitSvStatus` target — the silent idle state
     * has no opt-out because it never reaches the bus.
     *
     * Same forward-compat semantics as the other callout families:
     * default `true` so a future plugin upgrade automatically enables
     * a new subject for existing users (`.passthrough()` on the schema
     * makes that property hold without a migration). Canonical id↔key
     * mapping in `PIT_STATUS_CALLOUT_SETTING_KEYS`.
     */
    calloutEnabledPitStatusInProgress: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledPitStatusComplete: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledPitStatusTooFarLeft: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledPitStatusTooFarRight: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledPitStatusTooFarForward: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledPitStatusTooFarBack: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledPitStatusBadAngle: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledPitStatusCantFixThat: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Per-incident-type callout opt-ins (issue #530). One boolean per
     * `irsdk_IncidentFlags` report-byte category surfaced by the bus.
     * Every category defaults `true` so a fresh install gets full
     * type-specific coaching (track limits / composure / contact vs
     * collision-with-penalty) — the user can silence individual
     * categories from the PI mid-session and the change takes effect on
     * the next event arrival without cutting an in-flight clip. Same
     * forward-compat semantics as the other callout families. Canonical
     * id↔key mapping in `INCIDENT_CALLOUT_SETTING_KEYS`.
     */
    calloutEnabledIncidentOffTrack: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledIncidentOutOfControl: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledIncidentContactWorld: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledIncidentCollisionWorld: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledIncidentContactCar: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledIncidentCollisionCar: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Master opt-in for the track-conditions callout family (issue #526).
     * Single subject for v1 — every (direction × target) combination of the
     * Race Engineer's track-wetness change announcement is gated by this one
     * boolean. Forward-compat: future track-related callouts (temperature,
     * weather type) join the same `Track` family with their own per-subject
     * keys, following the
     * `callout<Polarity><Family><Subject>` convention. See the canonical
     * id↔key mapping in `TRACK_CONDITIONS_CALLOUT_SETTING_KEYS`.
     */
    calloutEnabledTrackWetness: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Opt-in for the session-start readout (issues #542, #668). One boolean
     * for the whole readout — the engineer's greeting + session-type line +
     * pit speed limit + track/air temperature + track wetness. Fired when a
     * practice or qualifying session starts (on `session.changed`, ~3 s in),
     * whether or not the driver leaves the garage; also fires when the plugin
     * connects into a practice/qualifying session mid-way (fresh-connect
     * synthesis). Defaults `true` so a fresh install hears it; the user can
     * silence it from the PI mid-session and the change takes effect on the
     * next session without cutting an in-flight clip. Canonical id↔key mapping
     * in `SESSION_START_CALLOUT_SETTING_KEYS` (in `@iracedeck/audio-scenarios`).
     */
    calloutEnabledSessionStart: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Opt-in for the Race Engineer audible toggle acknowledgement
     * (issue #554). When enabled, pressing the Race Engineer button on the
     * Pit Crew action plays a short voice line confirming the new state
     * ("going silent" on disable, "resuming communication" on enable). UI-side
     * acknowledgement only — the scenario engine isn't involved. Read live in
     * `PitCrew.toggleRaceEngineer()`; if disabled, the toggle remains silent
     * (border/status indicator still updates). Default `true` so existing
     * users get the ack without editing settings.
     */
    calloutEnabledToggleRaceEngineer: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Opt-in for the Race Engineer radio check fired when iRacing telemetry
     * starts flowing (issue #554 follow-up). On a false→true transition of
     * the SDK controller's connection state, the Pit Crew action plays the
     * driver-name clip followed by `toggle/radio-check-01` — "<name>, …
     * radio check. Standing by." — so the user has audible confirmation
     * that the plugin is talking to iRacing. Gated on Race Engineer being
     * enabled (master gate) AND this opt-in. UI-side, no scenario engine.
     * Read live so a mid-session PI toggle takes effect on the next
     * connect. Default `true`.
     */
    calloutEnabledTelemetryConnectRadioCheck: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Opt-in for the lap-time best-lap callout (issue #555). One boolean for
     * the family — the engineer announces the lap time after S/F when the
     * driver sets a new personal best (or completes their first valid lap of
     * the session). Defaults `true` so a fresh install hears it; the user can
     * silence it from the PI mid-session and the change takes effect on the
     * next lap completion without cutting an in-flight clip. Canonical id↔key
     * mapping in `LAP_TIME_CALLOUT_SETTING_KEYS` (in
     * `@iracedeck/audio-scenarios`).
     */
    calloutEnabledLapTimeBestLap: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Opt-in for the corner-name callouts (issue #888). One boolean for the
     * family — the engineer announces the upcoming corner's name in practice
     * and test sessions. Defaults `true`. Canonical id↔key mapping in
     * `CORNER_NAME_CALLOUT_SETTING_KEYS` (in `@iracedeck/audio-scenarios`).
     */
    calloutEnabledCornerNames: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Opt-in for the position-change callout (issues #566 + #569). One boolean
     * for the family — the engineer announces the driver's current position
     * after a qualifying or race lap whose effective position changed. In
     * qualifying the engineer also speaks a status line when position holds on
     * a non-PB lap and a dedicated pole call on an improvement to P1; in race
     * only real changes fire, because the every-3-laps race-status callout
     * (`calloutEnabledRaceStatus`) owns hold-position updates. Practice /
     * test sessions stay silent. Defaults `true`; the user can silence it
     * mid-session and the change takes effect on the next lap completion
     * without cutting an in-flight clip. Canonical id↔key mapping in
     * `POSITION_CALLOUT_SETTING_KEYS` (in `@iracedeck/audio-scenarios`).
     */
    calloutEnabledPositionChange: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Opt-in for the qualifying lap-invalidation callout (issue #567). One
     * boolean for the family — the engineer announces "This lap will be
     * invalidated." plus a tail picked from the snapshot's `lapsRemaining`
     * (out-of-laps / per-N counted line / plenty-of-laps fallback). **Fires
     * only in qualifying sessions** — race / practice stay silent because the
     * lap-invalidation phrasing only makes sense for a timed qualifying lap.
     * Defaults `true` so a fresh install hears it; the user can silence it
     * from the PI mid-session and the change takes effect on the next event
     * without cutting an in-flight clip. Canonical id↔key mapping in
     * `QUALIFYING_INVALIDATION_CALLOUT_SETTING_KEYS` (in
     * `@iracedeck/audio-scenarios`).
     */
    calloutEnabledQualifyingLapInvalidated: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Opt-in for the race-status periodic position update (issue #569). One
     * boolean for the family — the engineer announces the driver's current
     * position every 3 laps as long as position holds (counter resets on every
     * position change). **Fires only in race sessions**; qualifying / practice /
     * test stay silent because the standings-after-lap model doesn't fit. Leader
     * gets a dedicated "We're still leading the race. Keep it up." line;
     * everyone else hears the reused "We're currently P[n]" status. Defaults
     * `true` so a fresh install hears it. Canonical id↔key mapping in
     * `RACE_STATUS_CALLOUT_SETTING_KEYS` (in `@iracedeck/audio-scenarios`).
     */
    calloutEnabledRaceStatus: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Opt-in for the race-end final-result callout (issue #569). One boolean
     * for the family — the engineer greets the driver by name and speaks the
     * final result after the driver crosses S/F under the checkered flag in a
     * race session. Per-position branches: P1 ("we won!"), P2 ("second place"),
     * P3 ("podium"), P4+ ("the race is over. The final result for us is P[n]").
     * Defaults `true` so a fresh install hears it. Canonical id↔key mapping in
     * `RACE_END_CALLOUT_SETTING_KEYS` (in `@iracedeck/audio-scenarios`).
     */
    calloutEnabledRaceEnd: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Opt-in for the race-start greeting + qualifying-position readout (issue
     * #568). One boolean for the family — the engineer fires ~3 s after the
     * iRacing session changes to a race session (even if the driver is still
     * in pit/garage), greets the driver by name, reports the grid position,
     * and reads the track + air temperature + wetness brief. **Replaces** the
     * session-start callout in race sessions so there is no double-greeting.
     * Defaults `true` so a fresh install hears it; the user can silence it
     * from the PI mid-session and the change takes effect on the next
     * `session.changed` without cutting an in-flight clip. Canonical id↔key
     * mapping in `RACE_START_CALLOUT_SETTING_KEYS` (in
     * `@iracedeck/audio-scenarios`).
     */
    calloutEnabledRaceStart: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Opt-ins for the overtake gain / loss callouts (issue #574). Two booleans
     * — independently toggleable so a driver who wants congratulations but not
     * chastisement (or vice versa) gets per-direction control. The engineer
     * fires mid-race when the driver gains a position ("Nice pass. That puts
     * us to P[n].") or loses one ("Come on, [name]. Don't give up positions
     * like that. We're now in P[n]."), and the gain side has a dedicated
     * "we're now leading race" line when the pass takes the player to P1.
     * Both default `true`. Canonical id↔key mapping in
     * `OVERTAKE_CALLOUT_SETTING_KEYS` (in `@iracedeck/audio-scenarios`).
     */
    calloutEnabledOvertakeGained: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledOvertakeLost: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Opt-in for the pit-box count-in (issue #600). One boolean for the whole
     * countdown — as the driver drives down pit road toward their box the
     * engineer counts the remaining distance down ("five… four… three… two…
     * one… pit now") so they know when to stop without overshooting the stall.
     * The box position comes from `DriverInfo.DriverPitTrkPct`, so it works on
     * the first stop of a session. Fires whenever the car is on pit road and
     * approaching the box (including drive-throughs). Defaults `true` so a fresh
     * install hears it; the user can silence it mid-session and the change takes
     * effect on the next mark without cutting an in-flight clip. Canonical
     * id↔key mapping in `PIT_BOX_CALLOUT_SETTING_KEYS` (in
     * `@iracedeck/audio-scenarios`).
     */
    calloutEnabledPitBoxCountIn: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Per-count opt-ins for the estimated laps-of-fuel-left callouts (issue
     * #838). One boolean per spoken count 10 → 1 plus the count-0 "box this
     * lap for fuel" call. Unlike most callout families the defaults are NOT
     * uniform: 5, 3, 2, 1 and Box ship ON, the rest OFF (the Discord-request
     * baseline) — a driver who wants the full countdown opts the other counts
     * in. Canonical id↔key mapping in `FUEL_CALLOUT_SETTING_KEYS` (in
     * `@iracedeck/audio-scenarios`); the margin slider below tunes the
     * estimate they all speak.
     */
    calloutEnabledFuelLapsLeft10: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(false),
    calloutEnabledFuelLapsLeft9: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(false),
    calloutEnabledFuelLapsLeft8: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(false),
    calloutEnabledFuelLapsLeft7: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(false),
    calloutEnabledFuelLapsLeft6: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(false),
    calloutEnabledFuelLapsLeft5: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFuelLapsLeft4: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(false),
    calloutEnabledFuelLapsLeft3: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFuelLapsLeft2: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFuelLapsLeft1: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledFuelLapsLeftBox: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Safety margin in laps subtracted from the raw laps-of-fuel-left
     * estimate before the Race Engineer derives the spoken count (issue
     * #838). The spoken number is deliberately conservative relative to
     * Session Info's Laps to Empty display. Range 0.0–3.0 in 0.1 steps,
     * default 0.3. Must match `FUEL_CALLOUT_DEFAULT_MARGIN_LAPS` (and the
     * min/max constants) in `@iracedeck/sim-events-iracing`. The preprocess
     * normalizes empty-ish persisted values (`null`, `""`, whitespace) to
     * the default — `z.coerce.number()` would otherwise turn them into `0`
     * and silently disable the margin — and the `.catch` keeps any other
     * malformed value from aborting the whole settings parse (the
     * `changelogNotification` precedent).
     */
    fuelCalloutMarginLaps: z.preprocess(
      (val) => (val == null || (typeof val === "string" && val.trim() === "") ? undefined : val),
      z.coerce.number().min(0).max(3).default(0.3).catch(0.3),
    ),
    /**
     * Corner-name announcement lead in seconds (issue #888) — how far ahead
     * of the corner the name is spoken, scaled by current speed in the
     * translator. Slider 0–5 s, default 1. Must match the
     * `CORNER_CALLOUT_*_SECONDS` constants in `@iracedeck/sim-events-iracing`.
     * Same preprocess/catch shape as `fuelCalloutMarginLaps` so empty-ish or
     * malformed persisted values fall back instead of aborting the parse.
     */
    cornerCalloutLeadSeconds: z.preprocess(
      (val) => (val == null || (typeof val === "string" && val.trim() === "") ? undefined : val),
      z.coerce.number().min(0).max(5).default(1).catch(1),
    ),
    /**
     * Setup-name mismatch warning opt-in (issue #625). When on, the Race
     * Engineer appends a "double-check your setup" nudge after the session-start
     * (qualifying) and race-start intros when the loaded setup name looks wrong
     * for the session type. Default true — the family's natural baseline.
     */
    calloutEnabledSetupWarning: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Case-insensitive regex applied during **qualifying** sessions to flag a
     * race-looking setup name (issue #625). Empty (or any non-string, e.g. a
     * corrupted `null`) falls back to the default rather than throwing, so a bad
     * persisted value can't break the whole settings parse; an invalid regex
     * skips the warning and banners the PI. Canonical default:
     * `DEFAULT_SETUP_WARNING_QUALIFYING_PATTERN` in `setup-warning-constants.ts`.
     */
    setupWarningQualifyingPattern: z.preprocess(
      (val) => (typeof val === "string" && val !== "" ? val : undefined),
      z.string().default(DEFAULT_SETUP_WARNING_QUALIFYING_PATTERN),
    ),
    /**
     * Case-insensitive regex applied during **race** sessions to flag a
     * qualifying-looking setup name (issue #625). Same fallback/guard rules as
     * the qualifying pattern. Canonical default:
     * `DEFAULT_SETUP_WARNING_RACE_PATTERN` in `setup-warning-constants.ts`.
     */
    setupWarningRacePattern: z.preprocess(
      (val) => (typeof val === "string" && val !== "" ? val : undefined),
      z.string().default(DEFAULT_SETUP_WARNING_RACE_PATTERN),
    ),
    /**
     * Duration in seconds the flag overlay flashes after a new flag
     * transition (issue #490). The flash auto-stops after this duration even
     * while the underlying iRacing flag is still raised, so long full-course
     * yellows don't turn into sustained visual noise. A new flag transition
     * during or after the window starts a fresh timer.
     *
     * `0` disables the auto-stop and reverts to the original behaviour
     * (flash continuously while the flag is raised). Range 0–30 seconds,
     * default 15. The blink rate (`FLAG_FLASH_INTERVAL_MS`) is a separate
     * concept and stays a constant.
     */
    flagFlashDurationSeconds: z.coerce.number().min(0).max(30).default(15).catch(15),
    /**
     * Threshold in milliseconds separating a short tap from a long press for
     * dual-press controls (issue #540). On a View sub-mode of a setup action,
     * a press shorter than this fires the configured tap direction and a
     * press at or above it fires the opposite direction. Range 200–2000 ms,
     * default 500 ms. The fallback used by `getDualPressThresholdMs()` when
     * settings are unavailable matches this default.
     */
    dualPressThresholdMs: z.coerce.number().min(200).max(2000).default(500).catch(500),
    /**
     * Which direction a short press fires on a dual-press setup View sub-mode
     * (issue #540). The long-press always fires the opposite. Plugin-wide
     * because drivers want a consistent muscle-memory rule across every setup
     * action, not a per-key choice.
     *
     * - `"tap-increases"` — tap fires Increase, long-press fires Decrease (default)
     * - `"tap-decreases"` — tap fires Decrease, long-press fires Increase
     */
    dualPressDirections: z.enum(["tap-increases", "tap-decreases"]).default("tap-increases").catch("tap-increases"),
    /**
     * Delay in milliseconds between consecutive replay lap-search broadcasts
     * the Replay Control "Jump to Fastest Lap" mode emits while walking the
     * cursor to the target lap (issue #577). Even when the replay is paused,
     * iRacing resolves the exact lap-boundary position asynchronously after
     * each `ReplaySearch`, and a follow-up broadcast that arrives before
     * that work finishes leaves the cursor parked mid-lap. 400 ms is the
     * empirical default that works reliably; slower machines and longer
     * tracks may need higher values. Range 50–1000 ms, step 50.
     */
    fastestLapSearchDelayMs: z.coerce.number().min(50).max(1000).default(400).catch(400),
    /**
     * Delay in milliseconds the Chat > Send Message pipeline waits after
     * opening the chat window (BeginChat) before pasting the message
     * (issue #581). Also used by Race Admin "Type in Chat" for its
     * open→paste wait. Too short and the paste lands before iRacing has
     * focused the chat input, dropping the text — slower machines, heavy
     * load, or a clipboard-manager app stealing focus all push this out.
     * Range 0–2000 ms, step 100, default 200.
     */
    chatOpenToPasteDelayMs: z.coerce.number().min(0).max(2000).default(200).catch(200),
    /**
     * Delay in milliseconds the Chat > Send Message pipeline waits after
     * pasting before pressing Enter (issue #581). Too short and Enter fires
     * before the paste has registered, sending an empty or partial message.
     * Race Admin doesn't press Enter, so this delay doesn't apply there.
     * Range 0–2000 ms, step 100, default 200.
     */
    chatPasteToEnterDelayMs: z.coerce.number().min(0).max(2000).default(200).catch(200),
    /**
     * Delay in milliseconds the Chat > Send Message pipeline waits after
     * pressing Enter before closing the chat box (Cancel broadcast) (issue
     * #589). Too short and the close fires before iRacing has finished
     * processing the submit, so the Cancel is dropped and the chat window
     * keeps focus. Race Admin doesn't close the chat, so this delay doesn't
     * apply there. Range 0–2000 ms, step 100, default 200.
     */
    chatEnterToCloseDelayMs: z.coerce.number().min(0).max(2000).default(200).catch(200),
    /**
     * When the "what's new" changelog page opens after a plugin upgrade
     * (issue #742). `always` opens once per stable update (the pre-#742
     * behavior and the default, keeping the feature opt-out); `features`
     * opens only for major/minor updates and records patch releases
     * silently; `monthly` opens at most once per 30 days — a suppressed
     * update stays pending and opens at the first startup after the window
     * passes; `never` still records the version silently so switching back
     * later doesn't replay an old release. Consumed by `runVersionCheck`
     * alongside the passthrough `_lastSeenVersion` /
     * `_lastChangelogOpenedAt` keys — see `version-check.ts`.
     */
    // `.catch("always")` so a malformed persisted value (e.g. a hand-edited
    // settings file) falls back to the default instead of throwing and
    // aborting the entire GlobalSettingsSchema.parse — which would stall
    // every setting, not just this one (the `spotterStillThereSeconds`
    // precedent).
    changelogNotification: z.enum(CHANGELOG_NOTIFICATION_POLICIES).default("always").catch("always"),
  })
  .passthrough();

export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>;

/**
 * Current settings cache - updated when settings change
 */
let currentSettings: GlobalSettings = GlobalSettingsSchema.parse({});

/**
 * Listeners that get called when global settings change
 */
type GlobalSettingsListener = (settings: GlobalSettings) => void;
const listeners: Set<GlobalSettingsListener> = new Set();

/**
 * Whether initGlobalSettings has been called
 */
let initialized = false;

/**
 * Logger instance for this module
 */
let logger: ILogger | null = null;

/**
 * Stored adapter reference for writing settings back
 */
let adapterRef: IDeckPlatformAdapter | null = null;

/**
 * Whether the host has delivered at least one real settings payload this
 * session (issue #896). Until it has, `currentSettings` is nothing but schema
 * defaults — persisting a merge over defaults would overwrite host storage
 * and wipe every key the user ever saved (key bindings included). Local
 * writes before this flips are applied to the cache and queued; they flush
 * once the first arrival lands.
 */
let hostSettingsReceived = false;

/**
 * Whether any local write was queued while waiting for the first host
 * settings arrival (issue #896). Drives the one-shot flush on first arrival.
 */
let hasQueuedWrites = false;

/**
 * A local write not yet confirmed by a host echo (issue #896). `value` is
 * what this module last wrote for the key; `previousValue` is what the cache
 * held before that write — a host payload still carrying `previousValue` (or
 * missing the key) is a stale echo and must not roll the write back.
 */
interface PendingLocalWrite {
  value: unknown;
  previousValue: unknown;
}

/**
 * Local writes awaiting host confirmation, keyed by setting name (#896).
 */
const pendingLocalWrites = new Map<string, PendingLocalWrite>();

/**
 * Keys explicitly removed via `deleteGlobalSettings` and not yet confirmed
 * gone by a host payload (issue #896). The shrink guard must not resurrect
 * these, and stale echoes still carrying them must re-drop them.
 */
const pendingLocalDeletes = new Set<string>();

/**
 * The raw (unparsed) settings object from the most recent host delivery
 * (issue #896). This is the shrink guard's reference: any key the host knows
 * that is missing from an outgoing write — and not explicitly deleted — is
 * restored into the write so it can never be silently dropped from storage.
 */
let lastHostSettings: Record<string, unknown> | null = null;

/**
 * Value equality for pending-write reconciliation (#896). Primitives compare
 * by their string form because the PI persists numbers and booleans as
 * strings ("80", "true") while plugin writes persist parsed values (80,
 * true) — a strict comparison would misread a stale echo carrying the
 * string form of the pre-write value as a newer foreign write and roll the
 * local write back. The JSON fallback covers the few object-shaped
 * passthrough values (e.g. `_selectedCar`).
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  const isComparablePrimitive = (v: unknown): v is string | number | boolean =>
    typeof v === "string" || typeof v === "number" || typeof v === "boolean";

  if (isComparablePrimitive(a) && isComparablePrimitive(b)) {
    return String(a) === String(b);
  }

  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Parse a settings object, salvaging what a strict parse would abort on
 * (issue #896). When the parse fails, the offending top-level keys (from the
 * Zod issue paths) are dropped and the parse retried, so one corrupt value
 * degrades to its schema default instead of stalling every setting — before
 * this, a single bad field left the cache at defaults forever and every key
 * binding looked unset. Returns null only when the failure isn't attributable
 * to specific keys (e.g. the payload isn't an object).
 */
function parseWithSalvage(raw: Record<string, unknown>): { settings: GlobalSettings; droppedKeys: string[] } | null {
  let candidate = raw;
  const droppedKeys: string[] = [];

  // Each iteration drops at least one key, so the loop terminates; the bound
  // is a safety net against a pathological schema.
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = GlobalSettingsSchema.safeParse(candidate);

    if (result.success) {
      return { settings: result.data, droppedKeys };
    }

    const badKeys = [
      ...new Set(
        result.error.issues
          .map((issue) => issue.path[0])
          .filter((key): key is string => typeof key === "string" && key.length > 0 && key in candidate),
      ),
    ];

    if (badKeys.length === 0) return null;

    candidate = { ...candidate };

    for (const key of badKeys) {
      delete candidate[key];
      droppedKeys.push(key);
    }
  }

  return null;
}

/**
 * Send the live cache to the host, with the shrink guard applied (issue
 * #896): keys the host is known to hold that are missing from the outgoing
 * object — and were not explicitly deleted — are restored into the write.
 * This is the last line of defense against a write silently deleting
 * settings (the "key bindings not saved" bug), and it also carries values
 * the cache had to drop as unparseable back to storage untouched.
 */
function persistCurrentSettings(): void {
  if (!adapterRef) return;

  const outgoing: Record<string, unknown> = { ...(currentSettings as Record<string, unknown>) };

  if (lastHostSettings) {
    const restored: string[] = [];

    for (const key of Object.keys(lastHostSettings)) {
      if (!(key in outgoing) && !pendingLocalDeletes.has(key)) {
        outgoing[key] = lastHostSettings[key];
        restored.push(key);
      }
    }

    if (restored.length > 0) {
      logger?.warn("Restored host-known keys missing from outgoing global settings write");
      logger?.debug(`Restored keys: ${restored.join(", ")}`);
    }
  }

  adapterRef.setGlobalSettings(outgoing);
}

/**
 * Initialize global settings manager.
 * Sets up the listener for global settings changes.
 * The platform adapter will send current settings via the onDidReceiveGlobalSettings callback.
 * Should be called once at plugin startup, before adapter.connect().
 *
 * @param adapter - The platform adapter instance
 * @param log - Logger instance for this module
 * @returns Current global settings (may be defaults until adapter sends actual values)
 */
export function initGlobalSettings(adapter: IDeckPlatformAdapter, log: ILogger): GlobalSettings {
  logger = log;
  adapterRef = adapter;
  logger.info("Initializing");

  if (initialized) {
    logger.debug("Already initialized, returning cached");

    return currentSettings;
  }

  // Listen for changes from Property Inspector
  adapter.onDidReceiveGlobalSettings((settings: unknown) => {
    logger?.info("Settings received");
    logger?.debug(`Raw settings: ${JSON.stringify(settings)}`);

    const raw = (settings !== null && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
    const firstArrival = !hostSettingsReceived;
    hostSettingsReceived = true;
    lastHostSettings = { ...raw };

    const merged: Record<string, unknown> = { ...raw };

    // Reconcile pending local deletes (#896): a payload still carrying a
    // deleted key is a stale echo — re-drop it; a payload without it
    // confirms the delete.
    for (const key of [...pendingLocalDeletes]) {
      if (key in merged) {
        delete merged[key];
        logger?.debug(`Re-dropped pending local delete over stale host settings: ${key}`);
      } else {
        pendingLocalDeletes.delete(key);
      }
    }

    // Reconcile pending local writes (#896): confirmed values drop off the
    // pending map; stale echoes (key missing, or still the pre-write value)
    // get the local write re-applied; a genuinely different value is a
    // newer foreign write and wins. On the FIRST arrival local writes
    // always win — anything queued this session is newer than storage.
    const reappliedKeys: string[] = [];

    for (const [key, pending] of [...pendingLocalWrites]) {
      const rawHasKey = key in raw;

      if (rawHasKey && sameValue(raw[key], pending.value)) {
        pendingLocalWrites.delete(key);
      } else if (firstArrival || !rawHasKey || sameValue(raw[key], pending.previousValue)) {
        merged[key] = pending.value;
        reappliedKeys.push(key);
      } else {
        pendingLocalWrites.delete(key);
        logger?.debug(`Pending local write superseded by newer host value: ${key}`);
      }
    }

    if (reappliedKeys.length > 0) {
      logger?.info("Re-applied pending local writes over stale host settings");
      logger?.debug(`Re-applied keys: ${reappliedKeys.join(", ")}`);
    }

    const salvage = parseWithSalvage(merged);

    if (!salvage) {
      // Not attributable to specific keys — keep the previous cache rather
      // than resetting every setting to defaults. lastHostSettings still
      // remembers the payload, so the shrink guard preserves its keys.
      logger?.error("Host settings payload unparseable; keeping previous settings");

      return;
    }

    if (salvage.droppedKeys.length > 0) {
      logger?.warn("Dropped unparseable global settings values (schema defaults used)");
      logger?.debug(`Dropped keys: ${salvage.droppedKeys.join(", ")}`);
    }

    applyParsedSettings(salvage.settings);

    // Flush writes queued before the first arrival (#896) — now merged over
    // the real settings instead of clobbering them with defaults.
    if (firstArrival && hasQueuedWrites) {
      hasQueuedWrites = false;
      logger?.info("Flushing global settings writes queued before first host settings arrival");
      persistCurrentSettings();
    }
  });

  initialized = true;

  // Request current global settings - this triggers the onDidReceiveGlobalSettings callback
  adapter.getGlobalSettings();
  logger.info("Initialized");

  return currentSettings;
}

/**
 * Get current global settings.
 * Returns default values if settings haven't been initialized yet.
 *
 * @returns Current global settings
 */
export function getGlobalSettings(): GlobalSettings {
  return currentSettings;
}

/**
 * Subscribe to global settings changes.
 *
 * @param listener - Function called when settings change
 * @returns Unsubscribe function
 */
export function onGlobalSettingsChange(listener: GlobalSettingsListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Update global settings by merging partial values into current settings.
 * Writes the merged result back to the platform adapter **and** updates the
 * in-memory cache synchronously so subsequent reads in the same task see the
 * new value. The host's `onDidReceiveGlobalSettings` echo is not guaranteed to
 * fire promptly — in observed Stream Deck sessions the echo has arrived
 * minutes after the write — and without the synchronous cache update every
 * read-modify-write toggle (Pit Crew Radar, Race Engineer) gets stuck because
 * subsequent presses re-read the stale value and compute the same "next"
 * again. See #419.
 *
 * Writes are guarded against the stale-cache clobber (#896): before the
 * first real host settings arrival they are queued instead of persisted (a
 * defaults-based write would wipe storage), each written key stays pending
 * until a host payload confirms it (stale echoes can't roll it back), and
 * the outgoing object passes the shrink guard so host-known keys can never
 * silently vanish from storage.
 *
 * @param partial - Partial settings to merge into current settings
 */
export function updateGlobalSettings(partial: Record<string, unknown>): void {
  if (!adapterRef) {
    logger?.warn("Cannot update global settings: adapter not initialized");

    return;
  }

  const base = currentSettings as Record<string, unknown>;
  const merged = { ...base, ...partial };
  logger?.info("Updating global settings");
  logger?.debug(`Partial update: ${JSON.stringify(partial)}`);

  // Parse + apply synchronously so the cache and listeners reflect the
  // new value immediately. The later `onDidReceiveGlobalSettings` echo
  // re-parses the same payload and reconciles as a no-op.
  const salvage = parseWithSalvage(merged);

  if (!salvage) {
    logger?.error("Global settings update unparseable; write skipped");

    return;
  }

  if (salvage.droppedKeys.length > 0) {
    logger?.warn("Dropped unparseable values from global settings update");
    logger?.debug(`Dropped keys: ${salvage.droppedKeys.join(", ")}`);
  }

  // Record the surviving partial keys as pending until a host payload
  // confirms them (#896) — a stale echo arriving later must not roll them
  // back. A write supersedes any pending delete of the same key. Record the
  // PARSED value, not the raw input: the outgoing write sends the parsed
  // cache, so the host echo carries the parsed form — recording the raw
  // input (e.g. an out-of-range number the schema `.catch()`-ed) would
  // leave the key pending forever, re-applied and logged on every echo.
  const parsedView = salvage.settings as Record<string, unknown>;

  for (const key of Object.keys(partial)) {
    if (salvage.droppedKeys.includes(key)) continue;

    pendingLocalDeletes.delete(key);
    pendingLocalWrites.set(key, { value: parsedView[key], previousValue: base[key] });
  }

  applyParsedSettings(salvage.settings);

  // Before the first real host settings arrival the cache is defaults —
  // persisting now would overwrite storage with those defaults and wipe
  // every key the user ever saved (#896). Queue instead; the first arrival
  // flushes the write merged over the real settings.
  if (!hostSettingsReceived) {
    hasQueuedWrites = true;
    logger?.info("Global settings write queued until first host settings arrival");

    return;
  }

  // Persist the LIVE cache, not a snapshot from above. A listener fired by
  // `applyParsedSettings` may itself call `updateGlobalSettings`, layering
  // more partials on top — sending a snapshot would clobber those nested
  // updates back to the snapshot's stale view (#441 bug:
  // `_raceEngineerVoices` push from inside the audio-device push listener
  // was being overwritten by the outer audio-device-only payload).
  persistCurrentSettings();
}

/**
 * Remove the listed keys from the global settings cache and persist the
 * trimmed result. Used for one-shot schema migrations (#515) — pass the
 * old key names that have been renamed away, the keys vanish from storage
 * on the first call, and subsequent calls are no-ops because the keys are
 * no longer present.
 *
 * Idempotent: when none of the listed keys are in the cache, the function
 * returns without writing to the adapter or notifying listeners. Only an
 * actual deletion triggers a re-parse + write — same shape as
 * `updateGlobalSettings`.
 *
 * @param keys - Names of keys to drop from the cache
 */
export function deleteGlobalSettings(keys: readonly string[]): void {
  if (!adapterRef) {
    logger?.warn("Cannot delete global settings: adapter not initialized");

    return;
  }

  const next: Record<string, unknown> = { ...(currentSettings as Record<string, unknown>) };
  const deleted: string[] = [];

  for (const key of keys) {
    if (key in next) {
      delete next[key];
      deleted.push(key);
    } else if (lastHostSettings && key in lastHostSettings && !pendingLocalDeletes.has(key)) {
      // The cache never held the key (e.g. its value was unparseable and
      // salvaged away), but the host still stores it — record the delete so
      // the shrink guard stops preserving it (#896).
      deleted.push(key);
    }
  }

  if (deleted.length === 0) return;

  for (const key of deleted) {
    pendingLocalDeletes.add(key);
    pendingLocalWrites.delete(key);
  }

  logger?.info("Deleting global settings keys");
  logger?.debug(`Deleted: ${deleted.join(", ")}`);

  const salvage = parseWithSalvage(next);

  if (!salvage) {
    logger?.error("Global settings delete left an unparseable object; write skipped");

    return;
  }

  applyParsedSettings(salvage.settings);

  // Same first-arrival gate as updateGlobalSettings (#896).
  if (!hostSettingsReceived) {
    hasQueuedWrites = true;
    logger?.info("Global settings delete queued until first host settings arrival");

    return;
  }

  persistCurrentSettings();
}

/**
 * Apply a parsed settings object: update the cache and notify listeners.
 * Shared between the host-echo path (`onDidReceiveGlobalSettings`) and the
 * local-write path (`updateGlobalSettings`) so both stay in sync.
 */
function applyParsedSettings(parsed: GlobalSettings): GlobalSettings {
  currentSettings = parsed;

  for (const listener of listeners) {
    listener(parsed);
  }

  return parsed;
}

/**
 * Check if global settings have been initialized.
 *
 * @returns true if initialized, false otherwise
 */
export function isGlobalSettingsInitialized(): boolean {
  return initialized;
}

/**
 * Get current global color preferences.
 * Reads flat color keys (colorBackgroundColor, colorTextColor, etc.)
 * from global settings and returns them as a ColorSlots object.
 *
 * @returns Color preferences, with undefined for unset slots
 */
export function getGlobalColors(): {
  backgroundColor?: string;
  textColor?: string;
  graphic1Color?: string;
  graphic2Color?: string;
} {
  const settings = currentSettings as Record<string, unknown>;

  const color = (key: string): string | undefined => {
    const val = settings[key];

    // Ignore empty strings (current "not set" value from <ird-color-picker>)
    // and #000001 (legacy sentinel from <sdpi-color> era — kept for backward compat)
    if (typeof val !== "string" || val.length === 0 || val === "#000001") {
      return undefined;
    }

    return val;
  };

  return {
    backgroundColor: color("colorBackgroundColor"),
    textColor: color("colorTextColor"),
    graphic1Color: color("colorGraphic1Color"),
    graphic2Color: color("colorGraphic2Color"),
  };
}

/**
 * Resolve the active Race Engineer voice key, falling back to the first
 * entry in `availableVoices` if the persisted value is empty or missing
 * from the available list (e.g. user picked "titan" earlier, the package
 * was rebuilt without that voice).
 *
 * Returns `null` only if no voices are available at all — callers should
 * suppress voice scenarios in that case.
 */
export function resolveActiveRaceEngineerVoice(availableVoices: readonly string[]): string | null {
  if (availableVoices.length === 0) return null;

  const chosen = currentSettings.raceEngineerVoice ?? "";

  if (chosen.length > 0 && availableVoices.includes(chosen)) {
    return chosen;
  }

  return availableVoices[0];
}

/**
 * Resolve the active driver-name key (the name the engineer addresses
 * the user as). Returns the persisted value when present in the list,
 * otherwise `defaultName` if supplied and present in the list, otherwise
 * the first list entry, or `null` when no names exist (caller should
 * skip name-dependent playback). `defaultName` mirrors the `default`
 * attribute on `<ird-name-select>` so the UI dropdown and runtime
 * playback agree on the fallback even before the user opens the PI.
 */
export function resolveActiveDriverName(availableNames: readonly string[], defaultName?: string): string | null {
  if (availableNames.length === 0) return null;

  const chosen = currentSettings.driverName ?? "";

  if (chosen.length > 0 && availableNames.includes(chosen)) {
    return chosen;
  }

  if (defaultName !== undefined && defaultName.length > 0 && availableNames.includes(defaultName)) {
    return defaultName;
  }

  return availableNames[0];
}

/**
 * Reset global settings state (for testing purposes only).
 * @internal
 */
export function _resetGlobalSettings(): void {
  currentSettings = GlobalSettingsSchema.parse({});
  listeners.clear();
  initialized = false;
  adapterRef = null;
  hostSettingsReceived = false;
  hasQueuedWrites = false;
  pendingLocalWrites.clear();
  pendingLocalDeletes.clear();
  lastHostSettings = null;
}
