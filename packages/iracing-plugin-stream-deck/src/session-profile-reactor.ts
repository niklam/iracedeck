/**
 * Automatic profile switching by session kind (#1111).
 *
 * When the sim enters a session, every connected deck with a variant of the
 * profile the user mapped to that session's kind is switched to it; when
 * iRacing exits, each deck the reactor switched goes back to the profile it was
 * on before its first automatic switch. Design: Decision 4 of
 * `docs/superpowers/specs/2026-09-04-issue-1111-profile-by-session-kind.md`.
 *
 * Sim-neutral (spec Decision 5): the kind, the tick, the exit edge, the
 * settings, the decks and the switch are all injected, so nothing here imports
 * an iRacing package. `elgato-extension.ts` wires the real ones.
 */
import { PROFILE_FOR_SESSION_KIND_KEYS, type ProfileSwitchSessionKind } from "@iracedeck/app-constants";
import { PROFILE_NAMES, resolveProfileNameForDevice } from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";

type ProfileForSessionKindKey = (typeof PROFILE_FOR_SESSION_KIND_KEYS)[ProfileSwitchSessionKind];

/** The global settings the reactor reads: the master toggle and one mapped display name per kind. */
export type ProfileAutoSwitchSettings = { readonly profileAutoSwitchEnabled: boolean } & {
  readonly [K in ProfileForSessionKindKey]: string;
};

/** A connected deck, as the reactor needs it. */
export interface SessionProfileDeck {
  readonly id: string;
  readonly type: number;
}

export interface SessionProfileReactorDeps {
  /** The current session's kind, or `null` when there is none or the sim's session type is unknown. */
  getSessionKind(): ProfileSwitchSessionKind | null;
  /** The sim's raw session type, only for the debug line naming a type that classified as nothing. */
  getRawSessionType?(): string;
  /** Subscribe to the sim's telemetry ticks; returns the unsubscribe. */
  subscribeTicks(onTick: () => void): () => void;
  /** Subscribe to the sim exiting; returns the unsubscribe. */
  onSimTerminated(listener: () => void): () => void;
  getSettings(): ProfileAutoSwitchSettings;
  /** The decks connected right now. */
  listDecks(): readonly SessionProfileDeck[];
  /** The bundled profiles' manifest names available for a device type. */
  availableProfiles(deviceType: number): readonly string[];
  /** The profile the plugin last knew the deck to be on (the profile history's top), if any. */
  getCurrentProfile(deviceId: string): string | undefined;
  /** Switch a deck to a bundled profile by manifest name. */
  switchProfile(deviceId: string, profile: string, page?: number): Promise<void>;
  logger: ILogger;
}

export interface SessionProfileReactor {
  start(): void;
  stop(): void;
}

/**
 * The bundled profile's display name mapped to `kind`, or `undefined` when the
 * row is "Do not change the profile" (`""`), holds no string, or `kind` is not
 * a session kind a profile can be mapped to.
 */
export function resolveProfileForKind(
  kind: string | null | undefined,
  settings: Readonly<Partial<Record<ProfileForSessionKindKey, unknown>>>,
): string | undefined {
  if (!kind || !Object.hasOwn(PROFILE_FOR_SESSION_KIND_KEYS, kind)) return undefined;

  const value = settings[PROFILE_FOR_SESSION_KIND_KEYS[kind as ProfileSwitchSessionKind]];

  return typeof value === "string" && value !== "" ? value : undefined;
}

/** What the reactor remembers about a deck it switched. */
interface SwitchedDeck {
  readonly type: number;
  /** The deck's profile before its first automatic switch; `undefined` when the plugin did not know it. */
  readonly previous: string | undefined;
}

export function createSessionProfileReactor(deps: SessionProfileReactorDeps): SessionProfileReactor {
  const { logger } = deps;

  // The (kind, mapped profile) pair last acted on; `null` kind = nothing acted
  // on yet. A tick that reads the same pair does nothing, so a manual switch
  // mid-session is never fought.
  let lastKind: ProfileSwitchSessionKind | null = null;
  let lastProfile = "";
  // The raw session type last named in the "classified as nothing" debug line,
  // so an unknown session logs once rather than at every tick.
  let lastUnclassifiedType = "";
  // Bumped at every exit and every newly acted-on pair, so a switch still in
  // flight for a session that ended, or for a mapping that has since been
  // superseded, stops before it touches another deck or the newer state.
  let epoch = 0;
  const switched = new Map<string, SwitchedDeck>();
  let unsubscribers: Array<() => void> = [];

  const resetSession = (): void => {
    lastKind = null;
    lastProfile = "";
    lastUnclassifiedType = "";
    switched.clear();
  };

  const noteUnclassified = (): void => {
    const raw = deps.getRawSessionType?.() ?? "";

    if (raw === "" || raw === lastUnclassifiedType) return;

    lastUnclassifiedType = raw;
    logger.debug(`Session type "${raw}" has no session kind; the profile is left as it is`);
  };

  const switchDecks = async (kind: ProfileSwitchSessionKind, profile: string): Promise<void> => {
    const startedIn = epoch;

    logger.info("Switching decks to the session's profile");
    logger.debug(`Session kind "${kind}" maps to "${profile}"`);

    for (const deck of deps.listDecks()) {
      if (epoch !== startedIn) return;

      const manifestName = resolveProfileNameForDevice(profile, deck.type, deps.availableProfiles(deck.type));

      if (!manifestName) {
        logger.debug(`Deck ${deck.id} (type ${deck.type}) has no variant of "${profile}"; skipped`);
        continue;
      }

      const first = !switched.has(deck.id);

      if (first) {
        switched.set(deck.id, { type: deck.type, previous: deps.getCurrentProfile(deck.id) });
      }

      try {
        await deps.switchProfile(deck.id, manifestName, 0);
        logger.info("Deck switched to the session's profile");
        logger.debug(`Deck ${deck.id} switched to "${manifestName}"`);
      } catch (error) {
        // A deck whose first switch failed was never moved: forget it, so the
        // exit does not "return" it to a Default it never left.
        if (first && epoch === startedIn) switched.delete(deck.id);

        logger.error(`Automatic profile switch failed: ${String(error)}`);
      }
    }
  };

  const onTick = (): void => {
    try {
      // The toggle first: it is off by default, and then a tick costs one read.
      const settings = deps.getSettings();

      if (settings.profileAutoSwitchEnabled !== true) {
        // Nothing is recorded while off, so turning it on applies at once; a
        // switch still in flight stops.
        if (lastKind !== null) {
          lastKind = null;
          lastProfile = "";
          epoch += 1;
        }

        return;
      }

      const kind = deps.getSessionKind();

      if (kind === null) {
        noteUnclassified();

        return;
      }

      const profile = resolveProfileForKind(kind, settings) ?? "";

      if (kind === lastKind && profile === lastProfile) return;

      lastKind = kind;
      lastProfile = profile;
      epoch += 1;

      if (profile === "") {
        logger.debug(`Session kind "${kind}" is set to not change the profile`);

        return;
      }

      void switchDecks(kind, profile).catch((error: unknown) => {
        logger.error(`Automatic profile switch failed: ${String(error)}`);
      });
    } catch (error) {
      logger.error(`Automatic profile switch failed: ${String(error)}`);
    }
  };

  const returnDecks = async (decks: ReadonlyArray<[string, SwitchedDeck]>): Promise<void> => {
    const connected = new Set(deps.listDecks().map((deck) => deck.id));

    for (const [deckId, { type, previous }] of decks) {
      if (!connected.has(deckId)) {
        logger.debug(`Deck ${deckId} is no longer connected; not returned`);
        continue;
      }

      const target = previous ?? resolveProfileNameForDevice(PROFILE_NAMES.default, type, deps.availableProfiles(type));

      if (!target) {
        logger.debug(`Deck ${deckId} has no profile to return to`);
        continue;
      }

      try {
        // No page, like Back to previous: the app restores the page the deck was on.
        await deps.switchProfile(deckId, target);
        logger.info("Deck returned to its profile from before the session");
        logger.debug(`Deck ${deckId} returned to "${target}"`);
      } catch (error) {
        logger.error(`Returning a deck's profile failed: ${String(error)}`);
      }
    }
  };

  const onTerminated = (): void => {
    epoch += 1;

    const decks = [...switched];

    resetSession();

    if (decks.length === 0) return;

    void returnDecks(decks).catch((error: unknown) => {
      logger.error(`Returning a deck's profile failed: ${String(error)}`);
    });
  };

  return {
    start: () => {
      if (unsubscribers.length > 0) return;

      unsubscribers = [deps.subscribeTicks(onTick), deps.onSimTerminated(onTerminated)];
    },
    stop: () => {
      for (const unsubscribe of unsubscribers) unsubscribe();

      unsubscribers = [];
      epoch += 1;
      resetSession();
    },
  };
}
