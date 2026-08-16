/**
 * Settings-window `sendToPlugin` command dispatch (issue #992).
 *
 * The page sends `sendToPlugin` frames for the few things that are the
 * plugin's to do rather than a setting's to store: persisting where the user
 * left the window, and switching a deck's profile. This is the one place
 * those commands are validated and routed — pure over injected delegates so
 * the three plugins share it and it is tested without a socket.
 */
import type { SettingsWindowBounds } from "./settings-window-launcher.js";

/** Passthrough global-settings key holding the last window bounds. */
export const SETTINGS_WINDOW_BOUNDS_KEY = "_settingsWindowBounds";

/** Sanity limits: anything outside is a corrupt or hostile blob, not a window. */
const MIN_SIZE = 320;
const MAX_SIZE = 16_384;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Validate a bounds-shaped value; undefined when anything is off. */
export function parseSettingsWindowBounds(value: unknown): SettingsWindowBounds | undefined {
  if (value === null || typeof value !== "object") return undefined;

  const { width, height, x, y } = value as Record<string, unknown>;

  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return undefined;

  if (width < MIN_SIZE || width > MAX_SIZE || height < MIN_SIZE || height > MAX_SIZE) return undefined;

  const bounds: SettingsWindowBounds = { width, height };

  if (isFiniteNumber(x) && isFiniteNumber(y)) {
    bounds.x = x;
    bounds.y = y;
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

      default:
        break;
    }
  };
}
