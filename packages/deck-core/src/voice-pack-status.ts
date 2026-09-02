/**
 * What this run knows about downloadable voice packs (issue #1034, stage 2).
 *
 * The payload behind `VOICE_PACK_STATUS_KEY`. Pure types and pure builders: the
 * producer is the install service, and the consumers are the settings window's
 * Race Engineer card and the `_warnings` banner any Property Inspector shows.
 *
 * Everything here is passive by construction, which is the feature's one hard
 * constraint restated as a data shape. An install runs while iRacing is
 * running, so it may never put anything in front of the driver — it may only
 * leave a record in a surface the user has already chosen to open. There is
 * therefore no "prompt", "confirm" or "dismiss" state anywhere in this file,
 * and adding one would be a design change to argue in the spec rather than a
 * field to add here.
 */

/**
 * How far along an install is.
 *
 * A SUCCEEDED install has no phase, because it is no longer an install — it is
 * a pack, and it appears in `_voicePacks` like any other. Keeping a terminal
 * "done" here would mean two keys both claiming to say whether `luca` is
 * installed, and they would disagree the moment a user deleted the folder by
 * hand. `failed` is the one terminal state that stays, because a failure the
 * user has not seen yet is not visible anywhere else.
 */
export const VOICE_PACK_INSTALL_PHASES = ["downloading", "verifying", "extracting", "swapping", "failed"] as const;

export type VoicePackInstallPhase = (typeof VOICE_PACK_INSTALL_PHASES)[number];

/** One pack's in-flight or failed install. */
export type VoicePackInstallState = {
  phase: VoicePackInstallPhase;
  /** Bytes received so far. Present while downloading; absent afterwards. */
  receivedBytes?: number;
  /** The archive's total size, from the catalog entry. */
  totalBytes?: number;
  /**
   * Why it failed, for a human. Only ever set with `phase: "failed"`.
   *
   * Written for someone who is not debugging: it says what happened and what
   * they can do, never a stack or an errno. The detail goes to the log.
   */
  error?: string;
};

/**
 * What the catalog fetch last answered.
 *
 * `unknown` is one state covering every way asking can fail — refused, timed
 * out, an HTTP error, not JSON, the wrong shape — because a user can act on
 * exactly the same thing in all of them, and a UI that distinguishes them is
 * offering a distinction nobody can use. It is not the same as an EMPTY
 * catalog, which is a successful answer meaning there is nothing to offer.
 */
export type VoicePackCatalogState =
  { state: "unknown" } | { state: "ok"; packs: readonly VoicePackOffer[]; checkedAt: number };

/**
 * A catalog entry as the UI needs it: the pack, plus this installation's answer
 * to "what would pressing the button do?".
 *
 * The verdict is computed once, by the plugin, rather than by each surface that
 * renders it. Two surfaces deriving "is this an update or a fresh install?"
 * from a hash comparison of their own is two chances to disagree, and the
 * settings window and the warning banner would disagree silently.
 */
export type VoicePackOffer = {
  id: string;
  label: string;
  version: string;
  description?: string;
  bytes: number;
  /**
   * `install` — not present. `update` — present at a different archive hash.
   * `installed` — present at this exact hash, nothing to do. `unsupported` —
   * the pack needs a newer plugin than this one, so it is shown and not
   * offered.
   */
  verdict: VoicePackOfferVerdict;
  /** Set only for `unsupported`, so the UI can say which version is needed. */
  minPluginVersion?: string;
};

export const VOICE_PACK_OFFER_VERDICTS = ["install", "update", "installed", "unsupported"] as const;

export type VoicePackOfferVerdict = (typeof VOICE_PACK_OFFER_VERDICTS)[number];

/** The whole payload. */
export type VoicePackStatus = {
  catalog: VoicePackCatalogState;
  /** Keyed by pack id. A pack with nothing in flight and no failure is absent. */
  installs: Record<string, VoicePackInstallState>;
};

/** The payload a run starts with: nothing asked, nothing in flight. */
export function emptyVoicePackStatus(): VoicePackStatus {
  return { catalog: { state: "unknown" }, installs: {} };
}
