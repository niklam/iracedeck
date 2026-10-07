/**
 * The voice-pack setting keys and the managed pack's id (issue #1034), in the
 * `app-constants` leaf so the settings schema, the run-scoped-key enrolment,
 * the voice-pack stack and the plugin runtime all name them without depending
 * on one another (spec #1351).
 */

/**
 * Passthrough global holding the last voice-pack scan as JSON:
 * `{ packs: [{ id, label, version, voices }, …], problems: [{ pack, reason }, …] }`.
 *
 * Both halves of one scan, in one key: a pack that was ignored is as much a
 * result of the scan as one that loaded, and publishing them separately would
 * let a Property Inspector show an installed list and a stale reason list.
 * Note the two are not exclusive — a pack that loads but declares one voice
 * with no clips under it appears in both.
 *
 * Run-scoped (see `RUN_SCOPED_SETTING_KEYS`): it describes what is on disk
 * during THIS run, not a user choice, so persisting it would let a pack the
 * user deleted reappear in the settings window after a restart. The plugin
 * re-asserts it on every scan and on every Property Inspector appearance,
 * which is the contract an enrolled key owes.
 */
export const VOICE_PACKS_KEY = "_voicePacks";

/**
 * Passthrough global mapping a voice's composite id (`<pack id>::<voice id>`,
 * #1144) to the label its pack declared, as JSON:
 * `{ "<pack-id>::<voice-id>": "<label>", … }`.
 *
 * A separate key from `_raceEngineerVoices` on purpose. That list is the set of
 * voices that EXIST, derived from the merged manifest's clip paths, and it is
 * what `resolveActiveRaceEngineerVoice` and its four call sites consume. Labels
 * are presentation laid over it, so folding them in would have changed the shape
 * of a published global and dragged those call sites along for a cosmetic
 * change. The id is identity; the label is decoration.
 *
 * The two are written in ONE `updateGlobalSettings` call and share a lifetime —
 * deliberately NOT run-scoped, matching `_raceEngineerVoices`. A pair that is
 * published together and read together must expire together; giving the map a
 * shorter life than the list is exactly the drift keeping them in one write
 * exists to prevent.
 *
 * Absence is normal, not an error. A voice with no entry renders as the title
 * case of its voice half, which is what every voice rendered as before this
 * key existed.
 */
export const VOICE_LABELS_KEY = "_voiceLabels";

/**
 * The pack iRaceDeck keeps current unasked (#1034 stage 3) — a PACK id, and
 * the pack half of the default voice's composite id (#1144).
 *
 * Here rather than in deck-core's `voice-pack-launch.ts`, which owns the
 * ensure: `global-settings.ts` needs it to anchor the default voice and to
 * qualify a stored bare id, and importing the launch step from there would
 * close a cycle the plugins' Rollup builds fail on.
 */
export const ENSURED_VOICE_PACK_ID = "default";

/**
 * Passthrough global holding what this run knows about downloadable packs, as
 * JSON: `{ catalog: …, installs: { "<pack-id>": { phase, … }, … } }`
 * (issue #1034, stage 2). See `voice-pack-status.ts` (this package) for the payload.
 *
 * Both halves in one key, for the reason `_voicePacks` above carries its two:
 * a UI must never be able to render a fresh catalog beside a stale set of
 * install states, or an install reported against a pack the catalog no longer
 * lists. They are one observation and they expire together.
 *
 * The catalog rides this key rather than an authorized HTTP route of its own —
 * the shape `/updates/status` uses for the changelog feed — because a Property
 * Inspector can read a global and cannot reach that route. The changelog pane
 * exists only in the settings window, so a route cost it nothing; the voice
 * state reaches the settings window through the same publish path
 * `_voicePacks` already uses, and adding an authorized route would be a second
 * auth surface for one card.
 *
 * NOTE what does NOT consume it, since an earlier draft of this comment claimed
 * otherwise: no Property Inspector warning banner and no key icon reads this in
 * this release. The settings window is the only consumer. Both were designed
 * and neither was built, so do not cite them as the reason for this shape.
 *
 * Run-scoped (see `RUN_SCOPED_SETTING_KEYS`). A download that was in flight
 * when the plugin stopped is not in flight any more, and a failure the user
 * never saw is not a fact about their installation — persisting either would
 * put a frozen progress bar or a dead error in front of them on a run where
 * neither is true.
 */
export const VOICE_PACK_STATUS_KEY = "_voicePackStatus";
