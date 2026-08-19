/**
 * Deterministic settings fixture for the Settings window screenshots
 * (issue #1010).
 *
 * The captures must look the same on every machine and every release, so they
 * are taken against THIS fixture rather than against whoever ran the harness.
 * Two reasons that matters: a screenshot of a real install would publish that
 * person's key bindings and audio devices, and it would change for unrelated
 * reasons every time someone else recaptured, making the diff useless for
 * review.
 *
 * Values are chosen to look like a plausibly configured install — enough
 * bindings that the Key Bindings table shows real chords rather than a column
 * of "Not set", and the runtime-pushed lists (`_raceEngineerVoices`,
 * `_driverNames`, `_audioDeviceList`, `_deckDevices`) populated so their
 * dropdowns render with options instead of empty.
 */

/** Where the Diagnostics tab says settings are stored. A stable fake path. */
export const SEED_STORE_PATH = "C:\\Users\\Driver\\AppData\\Local\\iRaceDeck\\Settings\\settings.json";

/**
 * Build the settings object the capture serves to the page.
 *
 * Returned fresh on every call: the page writes back as it renders (sdpi saves
 * a whole-page snapshot on any edit), so a shared module-level object would let
 * one capture run's writes leak into the next.
 *
 * @returns {Record<string, unknown>} A complete settings payload.
 */
export function buildSeedSettings() {
  return {
    // ── Runtime-pushed lists (the plugin publishes these; no schema field) ──
    _raceEngineerVoices: JSON.stringify(["default", "luca", "martin", "schumi"]),
    _driverNames: JSON.stringify(["driver", "carl", "craig", "holger", "lex"]),
    _audioDeviceList: JSON.stringify([
      { id: "", name: "System Default", isDefault: true },
      { id: "6865616470686f6e6573", name: "Headphones (USB Audio Device)" },
      { id: "737065616b657273", name: "Speakers (Realtek High Definition Audio)" },
    ]),
    _deckDevices: JSON.stringify([{ id: "DEVICE-1", name: "Stream Deck +", type: 7 }]),
    _settingsStorePath: SEED_STORE_PATH,

    // ── General ──
    // No dual-press ENABLE here on purpose: that one is a per-action setting
    // (the setup actions own it), not a plugin-global, so the General tab shows
    // only the threshold and the direction.
    focusIRacingWindow: true,
    disableWhenDisconnected: true,
    dualPressThresholdMs: 500,
    dualPressDirections: "tap-increases",

    // ── Race Engineer ──
    pitCrewRaceEngineerEnabled: true,
    pitCrewRadarEnabled: false,
    pitCrewRaceEngineerStartupPolicy: "remember-last",
    pitCrewRadarStartupPolicy: "always-off",
    raceEngineerVoice: "default",
    driverName: "driver",
    audioOutputDevice: "",
    raceEngineerVolume: 60,
    backgroundVolume: 25,
    radarVolume: 50,

    // ── SimHub ──
    simHubHost: "127.0.0.1",
    simHubPort: 8888,

    // ── Updates / diagnostics ──
    changelogNotification: "features",
    debugLogging: false,

    // ── A representative handful of key bindings ──
    // Enough for the Key Bindings table to show real chords in its first
    // screenful, including one SimHub-role binding so both binding types are
    // visible in a single shot.
    blackBoxLapTiming: JSON.stringify({ type: "keyboard", key: "f1", modifiers: [] }),
    blackBoxFuel: JSON.stringify({ type: "keyboard", key: "f7", modifiers: [] }),
    blackBoxTires: JSON.stringify({ type: "keyboard", key: "f2", modifiers: [] }),
    lookDirectionLeft: JSON.stringify({ type: "keyboard", key: "left", modifiers: ["alt"] }),
    lookDirectionRight: JSON.stringify({ type: "keyboard", key: "right", modifiers: ["alt"] }),
    aiSpotterLouder: JSON.stringify({ type: "simhub", role: "Spotter Volume Up" }),
  };
}
