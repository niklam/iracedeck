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
 * `_driverNames`, `_audioDeviceList`, `_deckDevices`, `_voicePacks`) populated
 * so their dropdowns and lists render with content instead of empty.
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
    _raceEngineerVoices: JSON.stringify(["default", "luca"]),
    _driverNames: JSON.stringify(["driver", "carl", "craig", "holger", "lex"]),
    _audioDeviceList: JSON.stringify([
      { id: "", name: "System Default", isDefault: true },
      { id: "6865616470686f6e6573", name: "Headphones (USB Audio Device)" },
      { id: "737065616b657273", name: "Speakers (Realtek High Definition Audio)" },
    ]),
    _deckDevices: JSON.stringify([{ id: "DEVICE-1", name: "Stream Deck +", type: 7 }]),
    // The one non-bundled voice above, as the pack that provides it, plus one
    // pack that was ignored — the Installed Voices list shows both halves of a
    // scan (#1034), and a shot of the empty state would document neither. Kept
    // to two rows deliberately: the capture is the real window at its default
    // size, so a longer list pushes the Rescan button below the fold.
    _voicePacks: JSON.stringify({
      packs: [
        { id: "luca", label: "Luca", version: "1.2.0", voices: ["luca"] },
      ],
      problems: [{ pack: "nina", reason: "no voice-pack.json" }],
    }),
    _settingsStorePath: SEED_STORE_PATH,

    // ── General ──
    // No dual-press ENABLE here on purpose: that one is a per-action setting
    // (the setup actions own it), not a plugin-global, so the General tab shows
    // only the threshold and the direction.
    focusIRacingWindow: true,
    disableWhenDisconnected: true,
    // The Mouse to Sim pointer target (#1029), seeded at its shipped defaults on
    // purpose: the shot then shows what a fresh install shows, and it shows it
    // from the fixture rather than from the controls' own `default=` attributes.
    mouseToSimAnchorX: "center",
    mouseToSimOffsetX: 0,
    mouseToSimAnchorY: "top",
    mouseToSimOffsetY: 12.5,
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
    changelogNotification: "never",
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
    // On a binding the Key Bindings table shows in its FIRST screenful, so the
    // screenshot actually demonstrates both binding types. `Cycle Next` also
    // ships no keyboard default, so this fills a row that would otherwise read
    // "Not set". A role on a binding further down the table is invisible in the
    // capture — which is what the earlier `spotterLouder` seeding got wrong.
    blackBoxCycleNext: JSON.stringify({ type: "simhub", role: "Black Box Next" }),
  };
}

/**
 * The update-check answer the capture serves (issue #1016).
 *
 * The What's New tab's banner, its UPDATE badge and its "Not installed" cards
 * only exist when a newer version has been published — so a capture against a
 * real check would show the feature switched off on the day the newest release
 * IS the one being captured, which is every release day. A fixture makes the
 * screenshot show the state worth documenting, and makes it identical on every
 * machine, which is the whole point of this file.
 *
 * @param {string} installedVersion - The version the built page reports.
 * @returns {Record<string, unknown>} An `ok` UpdateStatus.
 */
export function buildSeedUpdateStatus(installedVersion) {
  return {
    state: "ok",
    installedVersion,
    latestVersion: "9.9.0",
    checkedAt: 0,
    releases: [
      {
        version: "9.9.0",
        // A PAST date, fixed: an update you have not installed is one that already
        // shipped, and a screenshot must not drift into showing a future release.
        date: "2026-08-14",
        categories: [
          {
            title: "Features",
            items: [
              "An example of a release you have not installed yet — the notes come from the website, so you can read what is in an update before taking it.",
            ],
          },
          { title: "Bug Fixes", items: ["Another entry from that same newer release."] },
        ],
      },
    ],
  };
}
