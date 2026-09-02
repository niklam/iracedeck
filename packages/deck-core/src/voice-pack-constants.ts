/**
 * Constants shared between the voice-pack producer and modules that must not
 * depend on it — the run-scoped-key enrolment in particular (issue #1034).
 *
 * A leaf module with no imports, mirroring `pi-warnings-constants.ts`, so
 * `run-scoped-settings.ts` can name the key without pulling in the scanner.
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
 * Passthrough global mapping a voice id to the label its pack declared, as JSON:
 * `{ "<voice-id>": "<label>", … }`.
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
 * Absence is normal, not an error. A voice with no entry — the bundled one,
 * which has no manifest to declare a label in — renders as `titleCase(id)`,
 * which is what every voice rendered as before this key existed.
 */
export const VOICE_LABELS_KEY = "_voiceLabels";

/**
 * Passthrough global holding what this run knows about downloadable packs, as
 * JSON: `{ catalog: …, installs: { "<pack-id>": { phase, … }, … } }`
 * (issue #1034, stage 2). See `voice-pack-status.ts` for the payload.
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
 * state has to reach the Race Engineer card AND the warning banner any PI
 * shows, and a global reaches both with no second auth surface.
 *
 * Run-scoped (see `RUN_SCOPED_SETTING_KEYS`). A download that was in flight
 * when the plugin stopped is not in flight any more, and a failure the user
 * never saw is not a fact about their installation — persisting either would
 * put a frozen progress bar or a dead error in front of them on a run where
 * neither is true.
 */
export const VOICE_PACK_STATUS_KEY = "_voicePackStatus";

/**
 * A lowercase hex sha-256 digest — the archive hash the catalog publishes, the
 * installer computes, and `.install.json` records.
 *
 * One pattern rather than four copies, because those four are the same value
 * being handed between modules: the catalog states it, the downloader compares
 * what it computed against it, the storage layer names a staging directory
 * after it, and the provenance record keeps it for the next update check. A
 * copy that drifted would not fail loudly — it would make one module refuse a
 * digest another had just accepted, which reads as a corrupt download.
 *
 * Case is pinned rather than normalised on purpose: two spellings of one digest
 * compare unequal, and the bug that produces is a silent re-download of a pack
 * that was already installed.
 *
 * A plain RegExp, not a Zod schema, so this module keeps its no-imports
 * property — `run-scoped-settings.ts` depends on it and must not acquire a
 * validation-library edge to name a settings key.
 */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** The message every schema built on {@link SHA256_HEX_PATTERN} reports. */
export const SHA256_HEX_MESSAGE = "must be a lowercase hex sha-256 digest";

/**
 * The installer's provenance record, written into a pack directory.
 *
 * Named here rather than in `voice-pack-provenance.ts` so the scanner and the
 * storage layer can agree on the filename without either depending on the
 * other, and without the leaf that names it pulling in a parser.
 */
export const VOICE_PACK_PROVENANCE_FILE = ".install.json";
