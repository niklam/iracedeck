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

/**
 * The iRaceDeck plugin UUID — must match the manifest and the plugin main
 * service's `PLUGIN_UUID` (deck-adapter-ulanzi). UlanziStudio persists global
 * settings bucketed by the frame's `uuid` verbatim, so a global-settings WRITE
 * must carry this UUID (with an empty key/actionid) to land in the same bucket
 * the plugin main service reads at boot. Carrying the PI's per-action identity
 * instead scatters key bindings into per-action buckets the plugin never reads
 * back — they then vanish on restart (#868).
 *
 * A READ is the other way round; see {@link PI_READ_ACTIONID}.
 */
export const PLUGIN_UUID = "com.iracedeck.sd.core";

/**
 * Stand-in `actionid` for a global-settings read from a PI whose URL carried
 * none.
 *
 * UlanziStudio answers a `getGlobalSettings` only when `actionid` is non-empty
 * — it routes the reply by that field — while the bucket it hands back is the
 * plugin-wide one whatever the frame's `uuid` says. So a read needs the
 * opposite of what a write needs: an address, not a blank scope. #895 gave both
 * directions the blank scope to fix the write, which left every read
 * unanswered; the PI's settle timer then expired, sdpi's `getGlobalSettings()`
 * promise never resolved, and every `global` control rendered empty (#1039).
 *
 * `readIdentity` defaults `actionid` to "" when the query string omits it, which
 * would walk straight back into that. The host echoes the field rather than
 * looking it up — a value that has never existed is routed just as happily — so
 * any non-empty constant restores the reply, and it is strictly no worse than
 * the empty string it replaces.
 */
export const PI_READ_ACTIONID = "iracedeck-pi-global-read";

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
  // Global settings are plugin-wide: scope a WRITE to the plugin UUID so it
  // lands in the same UlanziStudio bucket the plugin main service reads (#868).
  const globalScope = { uuid: PLUGIN_UUID, key: "", actionid: "" };
  // A READ keeps that UUID but must carry the PI's own routing identity, or the
  // host never replies (#1039) — see PI_READ_ACTIONID.
  const globalReadScope = {
    uuid: PLUGIN_UUID,
    key: identity.key,
    actionid: identity.actionid || PI_READ_ACTIONID,
  };

  switch (frame.event) {
    case "getGlobalSettings":
      return { cmd: "getGlobalSettings", ...globalReadScope };
    case "setGlobalSettings":
      return { cmd: "setGlobalSettings", ...globalScope, settings: asRecord(frame.payload) ?? {} };
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
