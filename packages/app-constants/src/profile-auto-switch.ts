/**
 * Automatic profile switching by session kind (issue #1111).
 *
 * When iRacing enters a session, the Stream Deck plugin can switch every deck
 * to the bundled profile the user mapped to that session's kind, and back when
 * iRacing exits. The five kinds, the setting keys that hold the mapping and the
 * labels the settings window shows for them live here because the settings
 * schema, the plugin's reactor and the settings window's card all name the
 * same values.
 *
 * Each `profileForSessionKind*` key stores a bundled profile's display name
 * (`iRaceDeck Practice`), or `""` for "Do not change the profile". The keys
 * are persisted contracts: a key never changes once shipped.
 */

/** The session kinds a profile can be mapped to, in the order the settings window lists them. */
export const PROFILE_SWITCH_SESSION_KINDS = ["test", "practice", "qualifying", "race", "replay"] as const;

export type ProfileSwitchSessionKind = (typeof PROFILE_SWITCH_SESSION_KINDS)[number];

/** The global setting that turns automatic profile switching on (boolean, default off). */
export const PROFILE_AUTO_SWITCH_ENABLED_KEY = "profileAutoSwitchEnabled";

/** The global setting that holds each session kind's mapped profile display name. */
export const PROFILE_FOR_SESSION_KIND_KEYS = {
  test: "profileForSessionKindTest",
  practice: "profileForSessionKindPractice",
  qualifying: "profileForSessionKindQualifying",
  race: "profileForSessionKindRace",
  replay: "profileForSessionKindReplay",
} as const satisfies Readonly<Record<ProfileSwitchSessionKind, string>>;

/** The row label the settings window shows for each session kind. */
export const PROFILE_SWITCH_SESSION_KIND_LABELS: Readonly<Record<ProfileSwitchSessionKind, string>> = {
  test: "Test",
  practice: "Practice",
  qualifying: "Qualifying",
  race: "Race",
  replay: "Replay",
};
