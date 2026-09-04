/**
 * Settings-window `sendToPlugin` command dispatch (issue #992).
 *
 * The page sends `sendToPlugin` frames for the few things that are the
 * plugin's to do rather than a setting's to store: persisting where the user
 * left the window, and switching a deck's profile. This is the one place
 * those commands are validated and routed — pure over injected delegates so
 * the three plugins share it and it is tested without a socket.
 */
import { z } from "zod";

import { FEATURE_STARTUP_GATES } from "./feature-startup-policy.js";
import type { SettingsWindowBounds } from "./settings-window-launcher.js";
import { packId } from "./voice-pack-manifest.js";

/** Passthrough global-settings key holding the last window bounds. */
export const SETTINGS_WINDOW_BOUNDS_KEY = "_settingsWindowBounds";

/** Sanity limits: anything outside is a corrupt or hostile blob, not a window. */
const MIN_SIZE = 320;
const MAX_SIZE = 16_384;
/**
 * Windows virtual-screen coordinates are 16-bit signed (+/-32767); anything
 * beyond can only reopen the window somewhere no display reaches, so such a
 * persisted position is dropped and the size alone is honoured (the launcher
 * then lets the browser place the window).
 */
export const MAX_ABS_POSITION = 32_767;

const SizeSchema = z.object({
  width: z.number().finite().min(MIN_SIZE).max(MAX_SIZE),
  height: z.number().finite().min(MIN_SIZE).max(MAX_SIZE),
});
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

const PositionSchema = z.object({
  x: z.number().finite().min(-MAX_ABS_POSITION).max(MAX_ABS_POSITION),
  y: z.number().finite().min(-MAX_ABS_POSITION).max(MAX_ABS_POSITION),
});

/**
 * Validate a bounds-shaped value: undefined when the SIZE is off (a corrupt
 * blob), size-only when the position is missing or outside the documented
 * range.
 */
export function parseSettingsWindowBounds(value: unknown): SettingsWindowBounds | undefined {
  const size = SizeSchema.safeParse(value);

  if (!size.success) return undefined;

  const bounds: SettingsWindowBounds = { width: size.data.width, height: size.data.height };
  const position = PositionSchema.safeParse(value);

  if (position.success) {
    bounds.x = position.data.x;
    bounds.y = position.data.y;
  }

  return bounds;
}

export interface SettingsWindowCommandDeps {
  /** Writes a partial into global settings — the plugin binds `updateGlobalSettings`. */
  writeSettings: (partial: Record<string, unknown>) => void;
  /** Elgato only: switch `deviceId` to `profile` (page optional). Omit where profiles don't exist. */
  switchProfile?: (deviceId: string, profile: string, page?: number) => void;
  /**
   * Play an audio preview ("radar" | "voice" | "background") — the window's
   * Test buttons. The kind is passed through as a string; the runner owns
   * the allow-list (deck-core has no audio dependency).
   */
  previewAudio?: (kind: string) => void;
  /** Reveal `storePath` in Explorer — the window's "Open folder" button (#993). */
  openFolder?: (path: string) => void;
  /** The plugin's own settings-file path; the page never supplies one. */
  storePath?: string;
  /**
   * Re-scan the installed Race Engineer voice packs (issue #1034) — the
   * window's "Rescan voices" button. Takes nothing from the page: which
   * directory is scanned is the plugin's decision, exactly as with
   * `openSettingsFolder` above.
   */
  refreshVoicePacks?: () => void;
  /**
   * Download and install the catalog pack `id` (issue #1100).
   *
   * The page names WHICH pack, and that is all it gets to say. Everything else
   * — the catalog the id is looked up in, the URL, the destination directory —
   * is the plugin's, so a page cannot point an install at somewhere of its own
   * choosing. Compare `openSettingsFolder`, which takes nothing at all.
   */
  installVoicePack?: (id: string) => void;
  /** Delete the installed pack `id` (issue #1100). Same rule: an id, never a path. */
  removeVoicePack?: (id: string) => void;
  /**
   * Open a DIRECTORY, as distinct from {@link SettingsWindowCommandDeps.openFolder}
   * which reveals a file by selecting it inside its parent (issue #1100).
   * Sharing one delegate put the user one level above the voice-packs folder.
   */
  openDirectory?: (path: string) => void;
  /** The voice-packs directory; the page never supplies one (issue #1100). */
  voicePacksPath?: string;
}

/** The gate whose two keys the Race Engineer opt-in has to move together (#1061). */
const RACE_ENGINEER_GATE_KEY = "pitCrewRaceEngineerEnabled";

/**
 * The settings one press of a Getting Started opt-in writes, or `undefined` for
 * a feature nothing here knows about.
 *
 * The Race Engineer case writes TWO keys, and the second is not belt-and-braces.
 * `migrateStartupPolicies` maps the retired `…EnabledOnStartup` boolean onto a
 * startup policy, and that retired field was itself schema-backed with a `false`
 * default — so every install that performed a write before #1007 carries an
 * explicit `always-off`. Writing the gate alone would turn the engineer on for
 * this session and `applyStartupFeatureGates` would turn it straight back off on
 * the next start, which on a permanent tab is the worst possible outcome: a
 * button that appears to work and silently reverts. The pair is derived from
 * FEATURE_STARTUP_GATES rather than restated, so renaming either key cannot
 * leave this behind.
 *
 * `remember-last`, never `always-on`: forcing the gate at every start would
 * override a later deliberate silence from the Pit Crew toggle key, which is the
 * defect #1007 exists to remove. It is a literal rather than
 * DEFAULT_FEATURE_STARTUP_POLICY because the value is chosen for that meaning,
 * not for being the default — the two merely coincide today.
 */
export function enableFeatureWrites(feature: unknown): Record<string, unknown> | undefined {
  switch (feature) {
    case "race-engineer": {
      const gate = FEATURE_STARTUP_GATES.find((candidate) => candidate.gateKey === RACE_ENGINEER_GATE_KEY);

      return gate ? { [gate.gateKey]: true, [gate.policyKey]: "remember-last" } : undefined;
    }

    // The button reads "I want to read about new features", and `features` is
    // the value that makes that label true — `always` opens for patch releases
    // too, so the button would promise less than it delivers (#1061).
    case "changelog-updates":
      return { changelogNotification: "features" };

    case "focus-iracing-window":
      return { focusIRacingWindow: true };

    default:
      return undefined;
  }
}

/** Build the handler the settings-window server's `onSendToPlugin` is bound to. */
export function createSettingsWindowCommandHandler(
  deps: SettingsWindowCommandDeps,
): (payload: Record<string, unknown>) => void {
  return (payload) => {
    switch (payload.event) {
      case "windowBounds": {
        const bounds = parseSettingsWindowBounds(payload);

        if (bounds) deps.writeSettings({ [SETTINGS_WINDOW_BOUNDS_KEY]: bounds });

        break;
      }

      case "switchToProfile": {
        // Unlike a PI, the window has NO implicit device: the page must name it.
        if (
          deps.switchProfile &&
          typeof payload.deviceId === "string" &&
          payload.deviceId &&
          typeof payload.profile === "string"
        ) {
          deps.switchProfile(
            payload.deviceId,
            payload.profile,
            isFiniteNumber(payload.page) ? payload.page : undefined,
          );
        }

        break;
      }

      case "audioPreview":
        if (deps.previewAudio && typeof payload.kind === "string") deps.previewAudio(payload.kind);

        break;

      case "openSettingsFolder":
        if (deps.openFolder && deps.storePath) deps.openFolder(deps.storePath);

        break;

      case "enableFeature": {
        const writes = enableFeatureWrites(payload.feature);

        if (!writes) break;

        deps.writeSettings(writes);

        // Turning the engineer on has NO observable consequence on a fresh
        // install: there is no session, so nothing would be said for possibly
        // days. One preview is the only immediate evidence that audio works at
        // all, on the right device, at an audible volume.
        if (payload.feature === "race-engineer") deps.previewAudio?.("voice");

        break;
      }

      case "voicePackRefresh":
        deps.refreshVoicePacks?.();

        break;

      // A pack id reaches the filesystem as a DIRECTORY NAME, so it is
      // validated against the same kebab-case rule the manifest and the catalog
      // enforce rather than trusted because it came from our own page. That is
      // the difference between the page choosing a pack and the page choosing a
      // path: `..` and a drive letter both fail this parse, and the id the
      // installer receives is one it could equally have read from a manifest.
      case "voicePackInstall":
        if (deps.installVoicePack && packId.safeParse(payload.id).success) {
          deps.installVoicePack(payload.id as string);
        }

        break;

      case "voicePackRemove":
        if (deps.removeVoicePack && packId.safeParse(payload.id).success) {
          deps.removeVoicePack(payload.id as string);
        }

        break;

      case "openVoicePacksFolder":
        if (deps.openDirectory && deps.voicePacksPath) deps.openDirectory(deps.voicePacksPath);

        break;

      default:
        break;
    }
  };
}
