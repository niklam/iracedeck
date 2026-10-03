import { describe, expect, it } from "vitest";

import { readCappedJson, ResponseTooLargeError } from "./read-capped-json.js";

const encoder = new TextEncoder();

/**
 * A body served chunk by chunk on demand, recording how many chunks were
 * pulled and whether the reader cancelled — which is what proves the read
 * stopped mid-body rather than draining the stream and checking afterwards.
 */
function streamedResponse(chunks: string[], headers?: Record<string, string>) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled === chunks.length) {
        controller.close();

        return;
      }

      controller.enqueue(encoder.encode(chunks[state.pulled]));
      state.pulled++;
    },
    cancel() {
      state.cancelled = true;
    },
  });

  return { response: new Response(stream, { headers }), state };
}

describe("readCappedJson", () => {
  it("parses a body under the cap", async () => {
    const response = new Response(JSON.stringify({ releases: [1, 2, 3] }));

    await expect(readCappedJson(response, 1024)).resolves.toEqual({ releases: [1, 2, 3] });
  });

  it("parses a body exactly at the cap", async () => {
    const text = JSON.stringify({ a: "xyz" });

    await expect(readCappedJson(new Response(text), encoder.encode(text).byteLength)).resolves.toEqual({ a: "xyz" });
  });

  it("joins a body that arrives in several chunks, multi-byte characters split across them", async () => {
    // "ä" is two bytes in UTF-8; splitting the string is not splitting the
    // bytes, so this checks the chunks are joined before decoding.
    const { response } = streamedResponse(['{"name":"R', "äikkö", 'nen"}']);

    await expect(readCappedJson(response, 1024)).resolves.toEqual({ name: "Räikkönen" });
  });

  it("drops a leading byte-order mark, as response.json() does", async () => {
    const response = new Response('﻿{"ok":true}');

    await expect(readCappedJson(response, 1024)).resolves.toEqual({ ok: true });
  });

  it("refuses a body over the cap and cancels the read the moment it is crossed", async () => {
    const chunk = "x".repeat(100);
    const { response, state } = streamedResponse(Array.from({ length: 50 }, () => chunk));

    await expect(readCappedJson(response, 250)).rejects.toBeInstanceOf(ResponseTooLargeError);
    // 100 + 100 + 100 crosses 250 on the third chunk; nothing after it is read.
    expect(state.pulled).toBeLessThanOrEqual(4);
    expect(state.cancelled).toBe(true);
  });

  it("counts the bytes received, not the declared Content-Length", async () => {
    const { response } = streamedResponse(["x".repeat(600)], { "Content-Length": "10" });

    await expect(readCappedJson(response, 500)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("throws on a body that is not JSON", async () => {
    await expect(readCappedJson(new Response("<html>captive portal</html>"), 1024)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("throws on an empty body", async () => {
    await expect(readCappedJson(new Response(null), 1024)).rejects.toBeInstanceOf(SyntaxError);
  });
});
