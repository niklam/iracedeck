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

import type { SettingsWindowBounds } from "./settings-window-launcher.js";

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
