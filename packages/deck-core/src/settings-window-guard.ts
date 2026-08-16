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
  /** The token the server generated when it started (reused for every later open). */
  expectedToken: string;
  /**
   * The session cookie value, if any. The URL token authenticates only the
   * FIRST navigation; the server then sets a `SameSite=Strict; HttpOnly` cookie
   * holding the same token, and every same-origin request after that (the
   * page's relative `<script src>` fetches, the WebSocket upgrade) carries the
   * cookie instead. A Strict cookie is never sent cross-site, and a
   * DNS-rebound hostname is a different cookie host — the Origin check below
   * is what makes that guarantee hold, so it always runs before the cookie is
   * even looked at. The query token, unlike the cookie, is checked BEFORE the
   * Origin check (#993 phase 2) — see the token comment below.
   */
  cookie?: string | undefined;
}

export function authorizeSettingsRequest(input: SettingsRequestInput): SettingsRequestDecision {
  // A valid launch token authenticates on its own, whatever the Origin: the
  // token is the secret (per-launch, 48 hex chars, reachable only through the
  // window's URL and the plugin's own settings store), and the Property
  // Inspectors that carry it are file:// (Origin "null") or host-served pages
  // (#993 phase 2). No CORS header is ever emitted, so a page cannot read a
  // response it was not meant to see.
  if (input.token !== undefined && input.token === input.expectedToken) return { allowed: true };

  // Without the token, Origin FIRST. A browser navigating top-level sends no
  // Origin header; a cross-site fetch or WebSocket upgrade always does. This
  // check is the DNS-rebinding mitigation for the cookie path, so it must
  // never be skipped for it.
  if (input.origin !== undefined && input.origin !== input.expectedOrigin) {
    return { allowed: false, reason: "bad-origin" };
  }

  if (input.cookie !== undefined && input.cookie === input.expectedToken) return { allowed: true };

  return { allowed: false, reason: "bad-token" };
}
