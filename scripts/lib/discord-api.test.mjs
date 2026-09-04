/**
 * The client is the only code that ever holds the bot token, so the tests
 * pin what it does with it: one header, nothing else. The 429 path is tested
 * because Discord's retry_after is in SECONDS and a naive implementation
 * sleeps for 1.5 ms instead of 1.5 s.
 */
import { describe, expect, it, vi } from "vitest";
import { createDiscordClient, DISCORD_API_BASE, DiscordApiError } from "./discord-api.mjs";

const TOKEN = "MTIz.secret.token";

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  };
}

describe("createDiscordClient", () => {
  it("sends the bot token in the Authorization header and nowhere else", async () => {
    const fetchImpl = vi.fn(async () => response(200, { id: "1" }));
    const client = createDiscordClient({ token: TOKEN, fetchImpl });

    const result = await client.get("/users/@me");

    expect(result).toEqual({ id: "1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${DISCORD_API_BASE}/users/@me`);
    expect(init.headers.Authorization).toBe(`Bot ${TOKEN}`);
    expect(url).not.toContain(TOKEN);
    expect(init.body).toBeUndefined();
  });

  it("sends JSON bodies for post and patch", async () => {
    const fetchImpl = vi.fn(async () => response(200, { ok: true }));
    const client = createDiscordClient({ token: TOKEN, fetchImpl });

    await client.post("/channels/1/messages", { content: "hi" });
    await client.patch("/channels/1", { applied_tags: ["2"] });

    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ applied_tags: ["2"] }) });
  });

  it("retries a 429 once after retry_after seconds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(429, { retry_after: 1.5, message: "slow down" }))
      .mockResolvedValueOnce(response(200, { id: "2" }));
    const sleep = vi.fn(async () => {});
    const client = createDiscordClient({ token: TOKEN, fetchImpl, sleep });

    const result = await client.get("/channels/1");

    expect(result).toEqual({ id: "2" });
    expect(sleep).toHaveBeenCalledWith(1500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after the second 429", async () => {
    const fetchImpl = vi.fn(async () => response(429, { retry_after: 0.1, message: "slow down" }));
    const client = createDiscordClient({ token: TOKEN, fetchImpl, sleep: async () => {} });

    await expect(client.get("/channels/1")).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws DiscordApiError with Discord's code and message, without the token", async () => {
    const fetchImpl = vi.fn(async () => response(403, { message: "Missing Access", code: 50001 }));
    const client = createDiscordClient({ token: TOKEN, fetchImpl });

    const error = await client.get("/channels/9").catch((e) => e);

    expect(error).toBeInstanceOf(DiscordApiError);
    expect(error).toMatchObject({ status: 403, code: 50001, path: "/channels/9" });
    expect(error.message).toBe("GET /channels/9 -> 403 (code 50001): Missing Access");
    expect(String(error)).not.toContain(TOKEN);
  });

  it("returns null for an empty body", async () => {
    const fetchImpl = vi.fn(async () => response(204, undefined));
    const client = createDiscordClient({ token: TOKEN, fetchImpl });

    await expect(client.get("/x")).resolves.toBeNull();
  });

  it("refuses to be created without a token", () => {
    expect(() => createDiscordClient({ token: "" })).toThrow(/token/);
  });
});
