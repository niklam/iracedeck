/**
 * Pure Elgato ↔ Ulanzi Property-Inspector frame translation for the Ulanzi PI
 * bridge. No DOM dependencies, so it is unit-tested in a plain Node environment;
 * the WebSocket / bootstrap glue that consumes it lives in `index.ts`.
 */

/** Identity of a PI instance, read from the page URL query params. */
export interface BridgeIdentity {
  address: string;
  port: string;
  uuid: string;
  key: string;
  actionid: string;
  device: string;
  language: string;
  controller: string;
}

/** Build the Ulanzi context string: `uuid___key___actionid`. */
export function encodeContext(uuid: string, key: string, actionid: string): string {
  return `${uuid}___${key}___${actionid}`;
}

/** Narrow an unknown value to a plain record (not an array). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Settings live in `settings` (global / didReceiveSettings) or `param` (paramfrom*). */
function settingsOf(frame: Record<string, unknown>): Record<string, unknown> {
  return asRecord(frame.settings) ?? asRecord(frame.param) ?? {};
}

/**
 * Translate an sdpi-components (Elgato) outbound frame into a Ulanzi `cmd` frame,
 * or `null` to swallow it. sdpi's Elgato registration frame swallows to null —
 * the bridge sends the Ulanzi `connected` handshake itself on socket open.
 */
export function elgatoToUlanzi(
  frame: Record<string, unknown>,
  identity: BridgeIdentity,
): Record<string, unknown> | null {
  const base = { uuid: identity.uuid, key: identity.key, actionid: identity.actionid };

  switch (frame.event) {
    case "getGlobalSettings":
      return { cmd: "getGlobalSettings", ...base };
    case "setGlobalSettings":
      return { cmd: "setGlobalSettings", ...base, settings: asRecord(frame.payload) ?? {} };
    case "getSettings":
      return { cmd: "getSettings", ...base };
    case "setSettings":
      return { cmd: "setSettings", ...base, settings: asRecord(frame.payload) ?? {} };
    case "sendToPlugin":
      return { cmd: "sendToPlugin", ...base, payload: asRecord(frame.payload) ?? {} };
    case "openUrl":
      // Relayed out the plugin socket as a sendToPlugin marker: UlanziStudio
      // ignores `openurl` sent on the PI socket but honours it from the plugin
      // socket, so the Ulanzi adapter re-sends it from there (#845).
      return {
        cmd: "sendToPlugin",
        ...base,
        payload: { event: "openUrl", url: String(asRecord(frame.payload)?.url ?? "") },
      };
    case "logMessage":
      return { cmd: "logMessage", message: String(asRecord(frame.payload)?.message ?? ""), level: "info" };
    default:
      return null;
  }
}

/**
 * Translate a Ulanzi inbound `cmd` frame into the Elgato event sdpi-components
 * dispatches on (`didReceiveGlobalSettings` / `didReceiveSettings` /
 * `sendToPropertyInspector`), or `null` to drop it. `action` / `context` /
 * `device` are stamped so sdpi's per-action settings filter matches.
 */
export function ulanziToElgato(
  frame: Record<string, unknown>,
  identity: BridgeIdentity,
): Record<string, unknown> | null {
  const context = encodeContext(identity.uuid, identity.key, identity.actionid);

  switch (frame.cmd) {
    case "didReceiveGlobalSettings":
      return { event: "didReceiveGlobalSettings", payload: { settings: settingsOf(frame) } };
    case "didReceiveSettings":
    case "paramfromapp":
    case "paramfromplugin":
      return {
        event: "didReceiveSettings",
        action: identity.uuid,
        context,
        device: identity.device,
        payload: { settings: settingsOf(frame) },
      };
    case "sendToPropertyInspector":
      return {
        event: "sendToPropertyInspector",
        action: identity.uuid,
        context,
        payload: asRecord(frame.payload) ?? {},
      };
    default:
      return null;
  }
}
