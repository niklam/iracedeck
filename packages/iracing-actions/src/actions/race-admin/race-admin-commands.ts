/**
 * Race Admin Command Building
 *
 * Pure functions for constructing admin chat command strings.
 */
import { getSelectedCar } from "@iracedeck/deck-core";
import { buildTemplateContext, resolveTemplate, type SDKController } from "@iracedeck/iracing-sdk";

import { RACE_ADMIN_MODE_META, type RaceAdminMode, type RaceAdminModeMeta } from "./race-admin-modes.js";

export type DriverTarget = "viewed-car" | "selected-car" | "specific" | "type-in-chat";

export interface RaceAdminSettings {
  mode: RaceAdminMode;
  driverTarget: DriverTarget;
  carNumber: string;
  message: string;
  penaltyType: string;
  penaltyValue: string;
  paceLapsOperation: string;
  paceLapsValue: string;
  gridSetMinutes: string;
  trackStatePercent: string;
}

/**
 * Resolve the driver target for a command.
 *
 * Returns null for the `type-in-chat` driver target — that path doesn't build a
 * full command string at all. The caller (`executeMode`) must branch on
 * `driverTarget === "type-in-chat"` before calling `buildAdminCommand`.
 *
 * @internal Exported for testing
 */
export function resolveDriverTarget(
  settings: RaceAdminSettings,
  viewedCarNumber: string | null,
  meta: RaceAdminModeMeta,
): string | null {
  if (!meta.needsDriver) return null;

  if (settings.driverTarget === "viewed-car") {
    return viewedCarNumber ?? null;
  }

  if (settings.driverTarget === "selected-car") {
    return getSelectedCar()?.carNumber ?? null;
  }

  if (settings.driverTarget === "specific") {
    const carNum = settings.carNumber?.trim();

    return carNum || null;
  }

  return null;
}

/**
 * Build the bare command prefix for a mode (e.g. `"!clear "` with trailing
 * space). Used by the `type-in-chat` flow which pastes the prefix and lets
 * the user type the driver number themselves.
 *
 * Returns null for camera modes (no `meta.command`) — currently unreachable
 * since all 27 modes have a command, but kept defensive.
 *
 * @internal Exported for testing
 */
export function buildAdminCommandPrefix(mode: RaceAdminMode): string | null {
  const meta = RACE_ADMIN_MODE_META[mode];

  if (!meta.command) return null;

  return `${meta.command} `;
}

/**
 * Append mode-specific parameters to a command string.
 */
function appendModeSpecificParams(cmd: string, mode: RaceAdminMode, settings: RaceAdminSettings): string {
  switch (mode) {
    case "black-flag": {
      if (settings.penaltyType === "drivethrough") {
        cmd += " D";
      } else {
        const value = settings.penaltyValue?.trim();

        if (value) {
          cmd += settings.penaltyType === "laps" ? ` ${value}L` : ` ${value}`;
        }
      }

      break;
    }
    case "pace-laps": {
      const op = settings.paceLapsOperation || "+";
      const val = settings.paceLapsValue?.trim() || "1";
      cmd += op === "=" ? ` ${val}` : ` ${op}${val}`;
      break;
    }
    case "grid-set": {
      const minutes = settings.gridSetMinutes?.trim();

      if (minutes) cmd += ` ${minutes}`;

      break;
    }
    case "track-state": {
      const percent = settings.trackStatePercent?.trim();

      if (percent) cmd += ` ${percent}`;

      break;
    }
    default:
      break;
  }

  return cmd;
}

/**
 * Build the full admin chat command string from mode, settings, and driver info.
 *
 * Returns null if the command cannot be built (e.g., required driver missing, camera mode).
 *
 * @internal Exported for testing
 */
export function buildAdminCommand(
  mode: RaceAdminMode,
  settings: RaceAdminSettings,
  viewedCarNumber: string | null,
  sdkController: SDKController,
): string | null {
  const meta = RACE_ADMIN_MODE_META[mode];

  // Camera modes don't use chat commands
  if (!meta.command) return null;

  let cmd = meta.command;

  // Append driver target if needed
  if (meta.needsDriver) {
    const target = resolveDriverTarget(settings, viewedCarNumber, meta);

    if (!target) return null;

    cmd += ` #${target}`;
  }

  // Append mode-specific parameters
  cmd = appendModeSpecificParams(cmd, mode, settings);

  // Append optional/required message with template resolution
  if (meta.hasMessage) {
    const rawMessage = settings.message?.trim();

    if (meta.messageRequired && !rawMessage) return null;

    if (rawMessage) {
      // Collapse newlines to spaces (chat is single-line)
      let message = rawMessage.replace(/\r?\n/g, " ").replace(/\s{2,}/g, " ");

      // Resolve mustache templates
      if (message.includes("{{")) {
        const context = buildTemplateContext(sdkController);
        message = resolveTemplate(message, context);
      }

      cmd += ` ${message}`;
    }
  }

  return cmd;
}
