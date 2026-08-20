/**
 * Global Settings Manager
 *
 * Manages plugin-level global settings that apply across all action instances.
 * Platform-agnostic: uses IDeckPlatformAdapter instead of a specific SDK.
 *
 * Usage:
 * 1. Call initGlobalSettings(adapter, logger, store) once at plugin startup
 * 2. Use getGlobalSettings() to access current settings
 * 3. Change them with updateGlobalSettings()/deleteGlobalSettings(): each write
 *    updates the cache, notifies subscribers, and saves the file
 *
 * Single-writer model (issue #993): the plugin owns the settings, in the
 * `SettingsStore` file passed to `initGlobalSettings`. That file is the only
 * persistent copy — every UI (the settings window, every Property Inspector)
 * reaches it through this module, so the two-independent-writers problem the
 * #896 machinery existed to survive is gone: no first-arrival gate, no
 * pending-write overlay, no shrink guard. The deck host's own global-settings
 * store is read exactly ONCE, to migrate an existing installation's settings
 * into the file, and is ignored from then on. Per-key salvage stays — it now
 * protects against a partially-bad file instead of a partially-bad host
 * payload.
 *
 * Until the Property Inspector bridge lands (#993 phase 2) a PI still saves to
 * the deck host's copy, which this module now ignores; the settings window
 * (#992) already writes through the plugin.
 */
import type { ILogger } from "@iracedeck/logger";
import { z } from "zod";

import { DEFAULT_FEATURE_STARTUP_POLICY, FEATURE_STARTUP_POLICIES } from "./feature-startup-policy.js";
import { hasOnlyRunScopedKeys, stripRunScopedKeys } from "./run-scoped-settings.js";
import type { SettingsStore } from "./settings-store.js";
import {
  DEFAULT_SETUP_WARNING_QUALIFYING_PATTERN,
  DEFAULT_SETUP_WARNING_RACE_PATTERN,
} from "./setup-warning-constants.js";
import type { IDeckPlatformAdapter } from "./types.js";
import { CHANGELOG_NOTIFICATION_POLICIES, DEFAULT_CHANGELOG_NOTIFICATION_POLICY } from "./version-check.js";

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
      .default(false)
      .catch(false),
    /**
     * When true, focus the iRacing window before sending inputs.
     *
     * Default: true (issue #930). Keystrokes go to whatever window has focus,
     * so every keybind- and chat-driven action silently does nothing when
     * iRacing is in the background — no error, nothing on screen, a recurring
     * support pattern. Focusing costs nothing when iRacing is already in front
     * (`FocusResult.AlreadyFocused`), so on-by-default makes those actions work
     * out of the box. Note this does NOT apply to pure SDK broadcasts, which
     * reach iRacing regardless of focus (`SendNotifyMessage(HWND_BROADCAST, …)`);
     * those fail only on an integrity-level mismatch, which focusing can't fix.
     *
     * Existing installs are unaffected: writes persist the whole parsed cache,
     * so their stored `false` predates this flip and keeps winning. Only fresh
     * installs (and any settings blob without the key) see the new default.
     */
    focusIRacingWindow: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true)
      .catch(true),
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
     * Startup policy for `pitCrewRaceEngineerEnabled` / `pitCrewRadarEnabled`
     * (issue #1007, replacing the `…EnabledOnStartup` booleans of #482).
     * `remember-last` carries the previous session's gate over, `always-on` /
     * `always-off` force it. Only the plugin's first-arrival block reads
     * these — editing one mid-session deliberately does NOT touch the live
     * gate, which is what the old booleans got wrong: they were labelled "On
     * startup" but silently overrode the Pit Crew toggle key.
     *
     * `.catch(...)` so a malformed persisted value falls back to the default
     * instead of throwing and aborting the entire GlobalSettingsSchema.parse
     * — which would stall every setting, not just this one (the
     * `spotterStillThereSeconds` / `changelogNotification` precedent).
     */
    pitCrewRaceEngineerStartupPolicy: z
      .enum(FEATURE_STARTUP_POLICIES)
      .default(DEFAULT_FEATURE_STARTUP_POLICY)
      .catch(DEFAULT_FEATURE_STARTUP_POLICY),
    pitCrewRadarStartupPolicy: z
      .enum(FEATURE_STARTUP_POLICIES)
      .default(DEFAULT_FEATURE_STARTUP_POLICY)
      .catch(DEFAULT_FEATURE_STARTUP_POLICY),
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
    // Opponent-pit callout opt-ins (issue #622). Two subjects — the race
    // leader entering the pits, and same-lap competitors within ±2 effective
    // positions (class space in multi-class, incl. the aggregate tail).
    // Canonical id↔key mapping in `OPPONENT_PIT_CALLOUT_SETTING_KEYS`.
    calloutEnabledOpponentPitLeader: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledOpponentPitNearby: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    // Opponent-flag callout opt-ins (issue #936). Four subjects — penalty
    // flags on cars that matter to us (standings neighbours + slow traffic
    // ahead). Canonical id↔key mapping in `OPPONENT_FLAG_CALLOUT_SETTING_KEYS`.
    calloutEnabledOpponentFlagFurled: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledOpponentFlagBlack: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledOpponentFlagMeatball: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledOpponentFlagDisqualify: z
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
     * Corner Names toggle acknowledgment (issue #897). When enabled, the Pit
     * Crew Corner Names key speaks a short confirmation on every toggle
     * ("corner calls coming up" / "dropping the corner calls"). Only gates
     * the ack — the toggle itself always applies, and the ack additionally
     * requires the Race Engineer master gate to be on. UI-side, no scenario
     * engine. Read live in `toggleCornerNamesFeature()`. Default `true`.
     */
    calloutEnabledToggleCornerNames: z
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
     * Opt-ins for the gap callout family (issue #933): the sustained
     * trend-flip announcement ("we're gaining on the car ahead") and the
     * threshold-crossing alert ("we've caught the car ahead"), both against
     * the class-standings neighbors. Default `true`. Canonical id↔key
     * mapping in `GAP_CALLOUT_SETTING_KEYS` (in `@iracedeck/audio-scenarios`).
     */
    calloutEnabledGapTrend: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledGapThreshold: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * Gap alert threshold in seconds (issue #933): the engineer calls out
     * when a neighbor's gap first drops below this. 0.5–3.0, default 1.0.
     * Read live by the translator's gap diff, so a slider change re-arms /
     * fires without a restart.
     */
    // `.catch(1)` per #896 — a malformed persisted value must not abort the
    // whole settings parse (the `spotterStillThereSeconds` precedent).
    gapAlertThresholdSeconds: z.coerce.number().min(0.5).max(3).default(1).catch(1),
    /**
     * Shared cooldown between gap callouts in seconds (issue #933). 1–360,
     * default 30. Read live at event arrival by the gap scenarios.
     */
    gapCalloutCooldownSeconds: z.coerce.number().min(1).max(360).default(30).catch(30),
    /**
     * Minimum gap movement (seconds) since a side's last gap announcement
     * before another one may fire for that side (issue #933 follow-up: a
     * rate wobbling around the bars ping-ponged "pulling away" / "closing
     * in" while the gap itself barely moved). 0–10, default 1.5; 0 disables
     * the gate. Read live by the translator's gap diff.
     */
    gapCalloutMinChangeSeconds: z.coerce.number().min(0).max(10).default(1.5).catch(1.5),
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
    // "We have enough fuel to finish the race. No need to box for fuel." —
    // fires once per stint in the race endgame (10 or fewer laps to go by
    // the binding limit) when the tank covers the remaining distance with a
    // lap in hand — even when no warning was ever close (issue #880).
    calloutEnabledFuelLapsLeftRaceCovered: z
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
     * behavior, and the default until #901); `features` opens only for
     * major/minor updates and records patch releases silently (the default
     * since #901); `monthly` opens at most once per 30 days — a suppressed
     * update stays pending and opens at the first startup after the window
     * passes; `never` still records the version silently so switching back
     * later doesn't replay an old release. Consumed by `runVersionCheck`
     * alongside the passthrough `_lastSeenVersion` /
     * `_lastChangelogOpenedAt` keys — see `version-check.ts`.
     */
    // `.catch(DEFAULT_CHANGELOG_NOTIFICATION_POLICY)` so a malformed
    // persisted value (e.g. a hand-edited settings file) falls back to the
    // default instead of throwing and aborting the entire
    // GlobalSettingsSchema.parse — which would stall every setting, not just
    // this one (the `spotterStillThereSeconds` precedent).
    changelogNotification: z
      .enum(CHANGELOG_NOTIFICATION_POLICIES)
      .default(DEFAULT_CHANGELOG_NOTIFICATION_POLICY)
      .catch(DEFAULT_CHANGELOG_NOTIFICATION_POLICY),
  })
  .passthrough();

export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>;

/**
 * Current settings cache — truth for every reader, backed by the store.
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
 * The plugin-owned settings store (issue #993): the single persistent copy of
 * global settings, and the only thing this module ever writes to.
 */
let storeRef: SettingsStore | null = null;

/**
 * True once the cache reflects the store — loaded from the file, or migrated
 * once from the deck host (issue #993). Until then the cache is pure schema
 * defaults; anything that must not act on defaults (window focus, one-shot
 * migrations, the plugins' startup-defaults block) gates on this.
 */
let storeReady = false;

export type SettingsStoreSource = "file" | "host" | "fresh";

/** How the cache was filled — set by becomeReady(); null until then. */
let storeSource: SettingsStoreSource | null = null;

/**
 * True when becomeReady()'s parseWithSalvage() came back null — a WHOLESALE
 * parse failure, so the cache is pure schema defaults rather than anything
 * read from the store. hostMirrorPayload() must never mirror that: a host
 * write would broadcast schema defaults to every Property Inspector as if
 * they were the real settings. Set once in becomeReady(); cleared only by
 * `_resetGlobalSettings()` (tests) — there is no path back to a healthy cache
 * within a single run once the store is marked ready on a null salvage.
 */
let storeSalvageFailed = false;

/** Writes made before the store is ready; applied over the loaded settings when it is. */
let earlyWrites: Record<string, unknown> | null = null;

/** Keys deleted before the store is ready; dropped from the loaded settings when it is. */
let earlyDeletes: Set<string> | null = null;

/**
 * Deadline for the one-time host migration read, and the settings-file read
 * retry. Module-level so `_resetGlobalSettings()` can clear them — a timer
 * surviving a reset would fire into an unrelated run (tests) long after its
 * store is gone.
 */
let migrationTimer: ReturnType<typeof setTimeout> | undefined;
let loadRetryTimer: ReturnType<typeof setTimeout> | undefined;

/** How long to wait for the deck host to answer the one-time migration read. */
export const MIGRATION_TIMEOUT_MS = 10_000;

/**
 * Base delay before retrying a failed settings-file read; each further retry
 * doubles it (1 s, 2 s, 4 s, 8 s, 16 s — ~31 s in all), so a scanner or backup
 * agent holding the file at login has time to let go before the session is
 * written off as defaults-only.
 */
export const LOAD_RETRY_DELAY_MS = 1_000;

/** How many times the settings file is read before giving up on it. */
export const LOAD_ATTEMPTS = 6;

/**
 * Passthrough marker persisted into a settings file that was born WITHOUT the
 * deck host's settings — the one-time migration read timed out (#993). Its
 * value counts the starts that went unanswered. While it is present (and
 * below {@link MIGRATION_RETRY_STARTS}) the migration is retried on every
 * start — the host is asked again; a real answer merges under the file's own
 * writes and clears the marker — and the host mirror is skipped, so a
 * defaults file can never be mirrored over a host copy the plugin has not yet
 * been able to read. A host that stays silent for that many starts is taken
 * at its word: the file becomes authoritative, the marker clears, and the
 * mirror resumes so Property Inspectors are not left channel-less forever.
 */
export const MIGRATION_PENDING_KEY = "_migrationPending";

/** How many unanswered starts the pending migration is retried for before the file is accepted as-is. */
export const MIGRATION_RETRY_STARTS = 3;

/**
 * Passthrough key holding the loopback settings server's `{ port, token }`
 * (#993): written to the store and mirrored to the deck host by
 * `createSettingsChannelPublisher`, read by the PI bridges' router
 * (`pi-components/src/settings-channel/router.ts` pins the same literal).
 */
export const SETTINGS_CHANNEL_KEY = "_settingsChannel";

/**
 * Value equality across the persisted/parsed divide. Primitives compare by
 * their string form because a Property Inspector saves numbers and booleans
 * as strings ("80", "true") while this module persists parsed values (80,
 * true) — a strict comparison would report a difference where there is none.
 * The JSON fallback covers the few object-shaped passthrough values (e.g.
 * `_selectedCar`). Used by the settings window's save diff
 * (`settings-window-server.ts`), which only forwards genuinely changed keys.
 */
export function sameValue(a: unknown, b: unknown): boolean {
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
 * binding looked unset. Still load-bearing under the single-writer model: it
 * now guards the stored file (hand-edited, or written by an older schema)
 * instead of a host payload. Returns null only when the failure isn't
 * attributable to specific keys (e.g. the payload isn't an object).
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
 * Merge the deck host's migration answer under a settings file that was born
 * WITHOUT it (a fresh start, see MIGRATION_PENDING_KEY): the host supplies
 * every key, and the file wins only where it deviates from the schema default —
 * a value still at its default in a defaults-born file was almost certainly
 * never touched, so the host's (the user's real, pre-#993) value is the one to
 * keep; anything the user changed in the meantime survives. Passthrough keys
 * the file added (device lists, `_lastSeenVersion`, …) have no default and so
 * always win. With no file at all (`base` = {}) this is the plain host copy.
 */
/** How many unanswered starts a stored (or in-memory) settings object records; 0 without the marker. */
function pendingMigrationStarts(settings: Record<string, unknown>): number {
  const marker = settings[MIGRATION_PENDING_KEY];

  if (marker === true) return 1;

  return typeof marker === "number" && Number.isFinite(marker) && marker > 0 ? Math.floor(marker) : 0;
}

/**
 * The one place settings reach the disk.
 *
 * Every save goes through here so the write boundary is stated once: the LIVE
 * cache (never a snapshot — a listener may have layered more updates on top,
 * #441), copied so the cache object itself never escapes into a store, minus
 * the run-scoped keys that must not be persisted at all (#1014).
 */
function persist(store: SettingsStore | null): void {
  store?.save(stripRunScopedKeys(currentSettings as Record<string, unknown>));
}

function mergeMigration(host: Record<string, unknown>, base: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...host };
  const defaults = GlobalSettingsSchema.parse({}) as Record<string, unknown>;

  for (const [key, value] of Object.entries(base)) {
    if (key === MIGRATION_PENDING_KEY) continue;

    if (key in defaults && sameValue(defaults[key], value)) continue;

    merged[key] = value;
  }

  return merged;
}

export interface InitGlobalSettingsOptions {
  /** Test hook; production uses {@link MIGRATION_TIMEOUT_MS}. */
  migrationTimeoutMs?: number;
  /** Test hook; production uses {@link LOAD_RETRY_DELAY_MS}. */
  loadRetryDelayMs?: number;
}

/**
 * Initialize the global settings manager against the plugin-owned store.
 *
 * Returns immediately with the current (default) cache and finishes loading in
 * the background: the store is read, or — when there is no file yet — the deck
 * host is asked once so an existing installation's settings migrate into the
 * file. Listeners fire once when the cache first reflects the store, and
 * {@link isSettingsStoreReady} reports when that has happened. Should be called
 * once at plugin startup, before adapter.connect().
 *
 * @param adapter - The platform adapter instance (migration source only)
 * @param log - Logger instance for this module
 * @param store - The plugin-owned settings store (issue #993)
 * @param opts - Test hooks
 * @returns Current global settings (schema defaults until the store has loaded)
 */
export function initGlobalSettings(
  adapter: IDeckPlatformAdapter,
  log: ILogger,
  store: SettingsStore,
  opts: InitGlobalSettingsOptions = {},
): GlobalSettings {
  if (initialized) {
    logger?.warn("Global settings already initialized");

    return currentSettings;
  }

  logger = log;
  storeRef = store;
  initialized = true;
  logger.info("Initializing");

  const migrationTimeoutMs = opts.migrationTimeoutMs ?? MIGRATION_TIMEOUT_MS;
  const loadRetryDelayMs = opts.loadRetryDelayMs ?? LOAD_RETRY_DELAY_MS;
  let migrationRequested = false;
  let migrationDone = false;
  /** What the store held when the migration read went out: {} for no file, or a fresh-born file. */
  let migrationBase: Record<string, unknown> = {};

  // A `_resetGlobalSettings()` (tests) retargets `storeRef`, so an in-flight
  // load or a late host payload from THIS init must not write to module state
  // that now belongs to a different run.
  const isCurrent = (): boolean => storeRef === store;

  const becomeReady = (raw: Record<string, unknown>, source: "file" | "host" | "fresh"): void => {
    if (storeReady || !isCurrent()) return;

    // The load boundary for run-scoped keys (#1014): a warning stored by an
    // earlier run describes that run, not this one, so it never enters the
    // cache — whichever source filled `raw` (file, host migration, fresh).
    // Stripping BEFORE the early writes below is what keeps this run's own
    // banners: a producer that reported while the store was still loading
    // recorded an early write, and that one is current. (The elevation probe
    // can — it fires on an SDK connection, which does not wait for the file
    // read.)
    const merged = stripRunScopedKeys(raw);

    // Early writes/deletes (made before ready) win over the loaded settings —
    // anything written this session is newer than storage.
    if (earlyDeletes) for (const key of earlyDeletes) delete merged[key];

    if (earlyWrites) Object.assign(merged, earlyWrites);

    // A fresh start carries the pending-migration marker into the file so the
    // next start asks the host again (see MIGRATION_PENDING_KEY) — counting
    // the unanswered starts; a real load or a real host answer clears it.
    if (source === "fresh") merged[MIGRATION_PENDING_KEY] = pendingMigrationStarts(raw) + 1;
    else delete merged[MIGRATION_PENDING_KEY];

    const salvage = parseWithSalvage(merged);

    if (salvage === null) {
      storeSalvageFailed = true;
      logger?.error(
        "Stored settings could not be parsed at all; starting from schema defaults and LEAVING the stored copy untouched for inspection",
      );
    } else {
      if (salvage.droppedKeys.length > 0) {
        logger?.warn("Some stored settings were invalid and reset to their defaults");
        logger?.debug(`Dropped keys: ${salvage.droppedKeys.join(", ")}`);
      }

      currentSettings = salvage.settings;
    }

    storeReady = true;
    storeSource = source;
    earlyWrites = null;
    earlyDeletes = null;
    logger?.info(
      source === "file"
        ? "Global settings loaded from the settings file"
        : source === "host"
          ? "Migrated global settings from the deck host"
          : "No stored settings found; starting fresh (the deck host will be asked again next start)",
    );
    logger?.debug(`Settings store: ${store.path} (${Object.keys(raw).length} stored keys)`);

    // Migration and fresh start both write the file so the next start loads
    // it directly. A file load re-saves too — harmless, and it heals a file
    // whose salvage dropped keys.
    //
    // The one exception is a WHOLESALE parse failure: the cache is then pure
    // schema defaults, and writing those would destroy the very file someone
    // needs to look at to find out why. Leave it alone; the user keeps their
    // settings on disk, and a fixed file loads normally next start. (Defensive:
    // parseWithSalvage only fails wholesale on a root-level type error, and
    // `merged` above is always a fresh object literal — so this is unreachable
    // today. It stops being unreachable the moment the schema grows a
    // root-level refinement.)
    if (salvage !== null) persist(store);

    notifyListeners();
  };

  // The host is consulted ONLY as a migration source, and only when we asked
  // (i.e. there is no file). Every other payload — a PI's save echo, an
  // unsolicited push racing the file load — is ignored for the cache; the
  // store is truth (#993).
  adapter.onDidReceiveGlobalSettings((settings: unknown) => {
    if (!isCurrent()) return;

    if (storeReady || migrationDone || !migrationRequested) {
      // Not worth an info line: only fallback-path PI saves (a PI that never
      // switched to the loopback channel) and, on hosts that echo, the
      // plugin's own mirror write arrive here now, and none of them are
      // ingested.
      logger?.debug("Ignoring host settings payload: the settings store is authoritative");

      return;
    }

    logger?.info("Settings received from host for migration");
    logger?.debug(`Raw host settings: ${JSON.stringify(settings)}`);

    migrationDone = true;

    if (migrationTimer !== undefined) {
      clearTimeout(migrationTimer);
      migrationTimer = undefined;
    }

    const raw = (settings !== null && typeof settings === "object" ? settings : {}) as Record<string, unknown>;

    becomeReady(mergeMigration(raw, migrationBase), "host");
  });

  const onLoaded = (loaded: Record<string, unknown> | undefined): void => {
    if (!isCurrent()) return;

    if (loaded !== undefined) {
      const unanswered = pendingMigrationStarts(loaded);

      if (unanswered === 0) {
        becomeReady(loaded, "file");

        return;
      }

      if (unanswered >= MIGRATION_RETRY_STARTS) {
        // The host has now stayed silent for this many starts: stop paying
        // the timeout on every launch and keeping PIs channel-less; the file
        // is what we have. `becomeReady(…, "file")` drops the marker.
        logger?.warn(
          "Deck host never answered the migration read; keeping the settings file as-is and no longer asking",
        );
        becomeReady(loaded, "file");

        return;
      }
    }

    // No file yet — or a file born from a fresh start that never saw the
    // host's settings: migrate once from the host, or start fresh on timeout.
    // The file's own writes (if any) win over the host's answer; see
    // mergeMigration.
    migrationBase = loaded ?? {};
    logger?.info(
      loaded === undefined
        ? "No settings file yet; requesting the deck host's settings for a one-time migration"
        : "Settings file was written without the deck host's settings; requesting them again for the one-time migration",
    );
    migrationRequested = true;
    adapter.getGlobalSettings();

    // A host that answers synchronously (the scenario harness, test mocks) has
    // already migrated us — there is no deadline left to arm.
    if (migrationDone) return;

    migrationTimer = setTimeout(() => {
      migrationTimer = undefined;

      if (storeReady || migrationDone || !isCurrent()) return;

      migrationDone = true;
      logger?.warn("Deck host did not answer the migration read; starting fresh");
      becomeReady(migrationBase, "fresh");
    }, migrationTimeoutMs);
  };

  const onLoadFailed = (attempt: number, error: unknown): void => {
    if (!isCurrent()) return;

    if (attempt < LOAD_ATTEMPTS) {
      // Doubling back-off: a scanner/backup agent holding the file at login
      // usually lets go within seconds, not within the first two.
      const delayMs = loadRetryDelayMs * 2 ** (attempt - 1);

      logger?.warn("Could not read the settings file; retrying");
      logger?.debug(
        `Read attempt ${attempt}/${LOAD_ATTEMPTS} of ${store.path} failed: ${String(error)}; next try in ${delayMs} ms`,
      );
      loadRetryTimer = setTimeout(() => {
        loadRetryTimer = undefined;

        if (isCurrent()) attemptLoad(attempt + 1);
      }, delayMs);

      return;
    }

    // Out of attempts. Deliberately NOT ready and NOT saved: `save` replaces
    // the file atomically, so writing schema defaults over settings we merely
    // failed to READ (a locked or permission-denied file — AV scanner, backup
    // agent, stale handle) would destroy them. Not-ready keeps every gate
    // closed; the session runs on defaults and the file is left untouched.
    logger?.error(
      "Settings file could not be read; running on defaults WITHOUT saving so the file is not overwritten — check the file's permissions/locks and restart",
    );
    logger?.debug(`Settings store: ${store.path}; last error: ${String(error)}`);
  };

  // Two-arg `then`, not `.catch`: only a store READ failure may reach
  // `onLoadFailed`. A throw from applying the settings (a subscriber, say)
  // is a different fault — it must not be reported as a store failure, and
  // must never trigger a re-read.
  function attemptLoad(attempt: number): void {
    void store.load().then(
      (loaded) => {
        try {
          onLoaded(loaded);
        } catch (error: unknown) {
          logger?.error("Failed to apply the loaded global settings");
          logger?.debug(`Apply error: ${String(error)}`);
        }
      },
      (error: unknown) => onLoadFailed(attempt, error),
    );
  }

  attemptLoad(1);

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
 * Whether the cache reflects the settings store yet — loaded from the file, or
 * migrated once from the deck host (issue #993). Before that it is pure schema
 * defaults (passthrough keys absent), so any consumer deciding on the ABSENCE
 * of a key — e.g. a one-shot key migration — must wait for this.
 */
export function isSettingsStoreReady(): boolean {
  return storeReady;
}

/** How the cache was filled once ready ("file" | "host" | "fresh"); null before. */
export function getSettingsStoreSource(): SettingsStoreSource | null {
  return storeSource;
}

/**
 * The ONE write the plugin makes to the deck host per start (#993 phase 2):
 * a full mirror of the cache plus `_settingsChannel`, so Property Inspectors
 * can bootstrap the loopback channel from a plain host read and a downgraded
 * plugin still finds its settings. Every host's setGlobalSettings REPLACES the
 * whole stored object, so this must never be a partial — and it must be
 * skipped when the store started fresh (the host never answered the migration
 * read): writing defaults over a host copy we could not read would destroy it.
 * Also skipped when the stored file failed to parse at all
 * (`storeSalvageFailed`) — that cache is pure schema defaults too, and
 * mirroring it would broadcast those defaults to every Property Inspector as
 * if they were real settings, the same failure mode as the fresh-start case.
 * Returns undefined when the write must be skipped.
 *
 * Called with NO channel when the settings server failed to start (#1005).
 * That mirror still matters — arguably more: with no server there is no
 * loopback channel, so every Property Inspector falls back to reading the host
 * copy, and this is the only way anything the plugin has written (notably the
 * `_warnings` banner explaining why the settings window will not open) reaches
 * it at all. Any channel is stripped rather than carried over, so a PI does not
 * spend a bootstrap attempt dialling the previous run's dead port. The skip
 * guards above apply unchanged: a defaults cache must never be broadcast as if
 * it were real settings, banner or no banner.
 */
export function hostMirrorPayload(channel?: { port: number; token: string }): Record<string, unknown> | undefined {
  if (!storeReady || storeSource === "fresh" || storeSalvageFailed) return undefined;

  // Belt and braces with the "fresh" check above: a cache carrying the
  // pending-migration marker is a defaults file, whatever path filled it.
  if (pendingMigrationStarts(currentSettings as Record<string, unknown>) > 0) return undefined;

  const mirror = { ...(currentSettings as Record<string, unknown>) };

  if (channel === undefined) {
    delete mirror[SETTINGS_CHANNEL_KEY];

    return mirror;
  }

  return { ...mirror, [SETTINGS_CHANNEL_KEY]: { ...channel } };
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
 * The merged result is parsed, applied to the cache synchronously (so
 * subsequent reads in the same task see the new value — see #419), handed to
 * the listeners, and saved to the store.
 *
 * Writes made before the store has loaded are additionally recorded as early
 * writes and re-applied over the loaded/migrated settings, so a startup write
 * (e.g. the audio-device list) is neither lost nor able to overwrite the file
 * with schema defaults.
 *
 * @param partial - Partial settings to merge into current settings
 */
export function updateGlobalSettings(partial: Record<string, unknown>): void {
  logger?.info("Updating global settings");
  logger?.debug(`Partial update: ${JSON.stringify(partial)}`);

  const merged = { ...(currentSettings as Record<string, unknown>), ...partial };
  const salvage = parseWithSalvage(merged);

  if (salvage === null) {
    logger?.error("Global settings update rejected: result unparseable");

    return;
  }

  if (salvage.droppedKeys.length > 0) {
    logger?.warn("Some updated settings were invalid and reset to their defaults");
    logger?.debug(`Dropped keys: ${salvage.droppedKeys.join(", ")}`);
  }

  if (!storeReady) {
    // Applied over the loaded settings when the store is ready — read-your-writes
    // now. Record what actually TOOK (the parsed value, only for keys salvage
    // kept): replaying a value the schema rejected would drop it again in
    // becomeReady and persist the default over the user's stored value.
    const parsedView = salvage.settings as Record<string, unknown>;

    earlyWrites ??= {};

    for (const key of Object.keys(partial)) {
      if (salvage.droppedKeys.includes(key)) continue;

      earlyWrites[key] = parsedView[key];
      earlyDeletes?.delete(key);
    }
  }

  applyParsedSettings(salvage.settings);

  // Save the LIVE cache, not a snapshot from above: a listener fired by
  // `applyParsedSettings` may itself call `updateGlobalSettings`, layering
  // more partials on top — saving a snapshot would drop those nested updates
  // (#441).
  //
  // A write touching ONLY run-scoped keys is skipped: the stripped payload is
  // byte-for-byte what is already on disk, so it can only cost a rewrite and,
  // on a locked file, a retry schedule (#1014). A layering listener still
  // issues its own write, and that one persists the live cache.
  if (storeReady && !hasOnlyRunScopedKeys(Object.keys(partial))) persist(storeRef);
}

/**
 * Remove the listed keys from the global settings cache and save the trimmed
 * result. Used for one-shot schema migrations (#515) — pass the old key names
 * that have been renamed away, the keys vanish from storage on the first call,
 * and subsequent calls are no-ops because the keys are no longer present.
 *
 * Idempotent: when none of the listed keys are in the cache, the function
 * returns without saving or notifying listeners. Only an actual deletion
 * triggers a re-parse + save — the startup migrations call this on every
 * launch, long after the keys are gone.
 *
 * @param keys - Names of keys to drop from the cache
 */
export function deleteGlobalSettings(keys: readonly string[]): void {
  if (!storeReady) {
    // The cache is still defaults, so a key that lives only in storage isn't
    // visible yet — record the delete and apply it to the loaded settings.
    earlyDeletes = new Set([...(earlyDeletes ?? []), ...keys]);

    if (earlyWrites) for (const key of keys) delete earlyWrites[key];
  }

  const next = { ...(currentSettings as Record<string, unknown>) };
  const deleted = keys.filter((key) => key in next);

  if (deleted.length === 0) return;

  logger?.info("Deleting global settings keys");
  logger?.debug(`Deleted: ${deleted.join(", ")}`);

  for (const key of deleted) delete next[key];

  const salvage = parseWithSalvage(next);

  if (salvage === null) {
    logger?.error("Global settings delete left an unparseable object; save skipped");

    return;
  }

  applyParsedSettings(salvage.settings);

  if (storeReady) persist(storeRef);
}

/**
 * Hand the live cache to every subscriber. Reads `currentSettings` rather than
 * a snapshot so a listener that writes during the fan-out doesn't leave the
 * listeners after it looking at a stale object.
 */
function notifyListeners(): void {
  for (const listener of listeners) {
    listener(currentSettings);
  }
}

/**
 * Apply a parsed settings object: update the cache and notify listeners.
 * Shared by `updateGlobalSettings` and `deleteGlobalSettings` so both stay
 * in sync; the store load has its own path (`becomeReady`).
 */
function applyParsedSettings(parsed: GlobalSettings): GlobalSettings {
  currentSettings = parsed;
  notifyListeners();

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
  storeRef = null;
  storeReady = false;
  storeSource = null;
  storeSalvageFailed = false;
  earlyWrites = null;
  earlyDeletes = null;

  if (migrationTimer !== undefined) {
    clearTimeout(migrationTimer);
    migrationTimer = undefined;
  }

  if (loadRetryTimer !== undefined) {
    clearTimeout(loadRetryTimer);
    loadRetryTimer = undefined;
  }
}
