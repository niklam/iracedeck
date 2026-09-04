/**
 * Minimal Discord REST client for the maintainer tooling behind
 * `scripts/discord/feature-requests.mjs` (#1114).
 *
 * Deliberately tiny: `Authorization: Bot <token>`, JSON in and out, one retry
 * on 429. It knows nothing about forums, threads, or tags — that lives in
 * `discord-forum.mjs`. The token enters here and goes into exactly one header;
 * it is never logged and never part of a thrown message.
 */

export const DISCORD_API_BASE = "https://discord.com/api/v10";

/** Discord asks bots to identify with this shape. */
const DEFAULT_USER_AGENT = "DiscordBot (https://github.com/niklam/iracedeck, 1.0)";

export class DiscordApiError extends Error {
  constructor({ method, path, status, code, message }) {
    super(`${method} ${path} -> ${status}${code === undefined ? "" : ` (code ${code})`}: ${message}`);
    this.name = "DiscordApiError";
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

function parseJson(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {string} options.token Bot token. Required.
 * @param {typeof fetch} [options.fetchImpl] Injected for tests.
 * @param {(ms: number) => Promise<void>} [options.sleep] Injected for tests.
 * @param {string} [options.base]
 * @param {string} [options.userAgent]
 */
export function createDiscordClient({
  token,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  base = DISCORD_API_BASE,
  userAgent = DEFAULT_USER_AGENT,
}) {
  if (!token) throw new Error("createDiscordClient: a bot token is required");

  async function request(method, path, body, attempt = 0) {
    const headers = { Authorization: `Bot ${token}`, "User-Agent": userAgent };

    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetchImpl(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const json = parseJson(text);

    if (response.status === 429 && attempt === 0) {
      const retryAfterSeconds = Number(json?.retry_after ?? response.headers.get("retry-after") ?? 1);
      await sleep(Math.ceil(retryAfterSeconds * 1000));

      return request(method, path, body, attempt + 1);
    }

    if (!response.ok) {
      throw new DiscordApiError({
        method,
        path,
        status: response.status,
        code: json?.code,
        message: json?.message ?? (text || response.statusText),
      });
    }

    return json;
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
  };
}
