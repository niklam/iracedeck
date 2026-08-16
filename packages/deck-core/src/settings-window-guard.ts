/**
 * Settings-window request guard (issue #992).
 *
 * The settings window is served by the plugin process over a loopback HTTP
 * server. Loopback is reachable by any local process AND by any web page the
 * user visits (browsers permit cross-origin requests to 127.0.0.1 unless the
 * server refuses them), so every request must be authorized before it is
 * served. This module is the single decision point, kept pure so it can be
 * tested without a socket.
 */

export type SettingsRequestDenial = "bad-origin" | "bad-token";

export type SettingsRequestDecision = { allowed: true } | { allowed: false; reason: SettingsRequestDenial };

export interface SettingsRequestInput {
  /** The request's `Origin` header, if any. */
  origin: string | undefined;
  /** The origin the server actually launched the page from. */
  expectedOrigin: string;
  /** The `t` query parameter, if any. */
  token: string | undefined;
  /** The per-launch token the server generated. */
  expectedToken: string;
}

export function authorizeSettingsRequest(input: SettingsRequestInput): SettingsRequestDecision {
  // Origin FIRST. A browser navigating top-level sends no Origin header; a
  // cross-site fetch or WebSocket upgrade always does. This check — not the
  // token — is the DNS-rebinding mitigation, so it must never be skipped
  // because the token happened to be wrong too.
  if (input.origin !== undefined && input.origin !== input.expectedOrigin) {
    return { allowed: false, reason: "bad-origin" };
  }

  if (input.token === undefined || input.token !== input.expectedToken) {
    return { allowed: false, reason: "bad-token" };
  }

  return { allowed: true };
}
