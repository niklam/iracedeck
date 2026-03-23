/**
 * SimHub Control Mapper Service Singleton
 *
 * Provides a lazy-initialized singleton for triggering SimHub Control Mapper roles
 * via SimHub's HTTP REST API. This is an optional third control mechanism alongside
 * iRacing SDK commands and keyboard simulation.
 *
 * SimHub's Control Mapper exposes:
 * - POST /api/ControlMapper/StartRole/ — activate a named role
 * - POST /api/ControlMapper/StopRole/ — deactivate a named role
 * - GET /api/ControlMapper/GetRoles/ — list available role names
 *
 * Usage:
 * 1. Call initializeSimHub() once at plugin startup
 * 2. Use getSimHub() in your actions to trigger roles
 *
 * @example
 * // In plugin.ts (entry point)
 * import { initializeSimHub } from "@iracedeck/deck-core";
 * initializeSimHub(adapter.createLogger("SimHub"));
 *
 * // In action files
 * import { getSimHub } from "@iracedeck/deck-core";
 * await getSimHub().startRole("MyRole");
 */
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

import { getGlobalSettings } from "./global-settings.js";

/** Fixed owner ID sent to SimHub for de-duplication and ownership tracking. */
const OWNER_ID = "iRaceDeck";

/** Default SimHub host when not configured in global settings. */
const DEFAULT_HOST = "127.0.0.1";

/** Default SimHub HTTP API port when not configured in global settings. */
const DEFAULT_PORT = 8888;

/** HTTP request timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 2000;

/**
 * Interface for the SimHub Control Mapper service.
 */
export interface ISimHubService {
  /**
   * Activate a named role.
   * @param roleName - The SimHub Control Mapper role name to activate
   * @returns true on success, false on error (e.g., SimHub not running)
   */
  startRole(roleName: string): Promise<boolean>;

  /**
   * Deactivate a named role.
   * @param roleName - The SimHub Control Mapper role name to deactivate
   * @returns true on success, false on error
   */
  stopRole(roleName: string): Promise<boolean>;

  /**
   * Fetch available role names from SimHub.
   * @returns Array of role name strings, or empty array if SimHub is unreachable
   */
  getRoles(): Promise<string[]>;
}

/**
 * Read the SimHub host and port from global settings, falling back to defaults.
 */
function getConnectionConfig(): { host: string; port: number } {
  const settings = getGlobalSettings() as Record<string, unknown>;
  const host =
    typeof settings.simHubHost === "string" && settings.simHubHost.length > 0 ? settings.simHubHost : DEFAULT_HOST;
  const port = typeof settings.simHubPort === "number" ? settings.simHubPort : DEFAULT_PORT;

  return { host, port };
}

/**
 * SimHub Control Mapper service implementation.
 * Uses Node's built-in fetch for HTTP requests — no external dependencies.
 */
class SimHubService implements ISimHubService {
  private logger: ILogger;

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  async startRole(roleName: string): Promise<boolean> {
    this.logger.info("Starting role");
    this.logger.debug(`Role: ${roleName}`);

    return this.postRole("StartRole", roleName);
  }

  async stopRole(roleName: string): Promise<boolean> {
    this.logger.info("Stopping role");
    this.logger.debug(`Role: ${roleName}`);

    return this.postRole("StopRole", roleName);
  }

  async getRoles(): Promise<string[]> {
    const { host, port } = getConnectionConfig();
    const url = `http://${host}:${port}/api/ControlMapper/GetRoles/`;

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.warn(`GetRoles failed with status ${response.status}`);

        return [];
      }

      const roles = (await response.json()) as string[];
      this.logger.debug(`Available roles: ${JSON.stringify(roles)}`);

      return roles;
    } catch (error) {
      this.logger.warn(`Failed to fetch roles from SimHub at ${url}: ${error}`);

      return [];
    }
  }

  /**
   * Send a StartRole or StopRole POST request to SimHub.
   */
  private async postRole(action: "StartRole" | "StopRole", roleName: string): Promise<boolean> {
    const { host, port } = getConnectionConfig();
    const url = `http://${host}:${port}/api/ControlMapper/${action}/`;
    const body = new URLSearchParams({ ownerId: OWNER_ID, roleName });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.warn(`${action} failed with status ${response.status} for role "${roleName}"`);

        return false;
      }

      return true;
    } catch (error) {
      this.logger.warn(`Failed to ${action} role "${roleName}" at ${url}: ${error}`);

      return false;
    }
  }
}

// Singleton instance
let simHubService: SimHubService | null = null;

/**
 * Initialize the SimHub Control Mapper service singleton.
 * Should be called once at plugin startup.
 *
 * The service gracefully handles SimHub being absent — failed HTTP calls
 * return false/[] with a warning log, never throw.
 *
 * @param logger - Logger instance for SimHub service logging
 * @returns The initialized SimHub service
 * @throws Error if called more than once
 */
export function initializeSimHub(logger: ILogger = silentLogger): ISimHubService {
  if (simHubService) {
    throw new Error("SimHub service already initialized. initializeSimHub() should only be called once.");
  }

  simHubService = new SimHubService(logger);
  logger.info("Initialized");

  return simHubService;
}

/**
 * Get the SimHub Control Mapper service for triggering roles.
 *
 * @returns The SimHub service instance
 * @throws Error if SimHub service hasn't been initialized
 */
export function getSimHub(): ISimHubService {
  if (!simHubService) {
    throw new Error("SimHub service not initialized. Call initializeSimHub() first in your plugin entry point.");
  }

  return simHubService;
}

/**
 * Check if the SimHub service has been initialized.
 *
 * @returns true if SimHub service is initialized, false otherwise
 */
export function isSimHubInitialized(): boolean {
  return simHubService !== null;
}

/**
 * Reset the SimHub service singleton (for testing purposes only).
 * @internal
 */
export function _resetSimHub(): void {
  simHubService = null;
}
