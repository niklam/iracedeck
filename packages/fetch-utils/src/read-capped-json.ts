/**
 * Reads a fetched JSON document under a byte cap (issue #1101).
 *
 * The two feed clients in deck-core — `changelog-feed-client.ts` and
 * `voice-pack-catalog-client.ts` — each used to call `response.json()`, which
 * buffers the whole body into the plugin's heap before parsing begins. Their
 * only bound was the 5-second request timeout, so the real limit was whatever
 * a fast link can deliver in five seconds: a hijacked CDN edge, a captive
 * portal or a misconfigured origin serving a large error page would be held
 * whole inside the process that renders keys and mixes audio during a race.
 *
 * The standard is the one `voice-pack-download.ts` set for archives: count
 * the bytes ACTUALLY received and stop the moment the count crosses the cap,
 * never trusting a declared `Content-Length`. The count is of the decoded
 * body, after any `Content-Encoding` is undone, because that is what fills the
 * heap — a small gzip that inflates to gigabytes is refused like any other.
 *
 * Throws on every failure, an oversized body included: both callers already
 * fold a throw into their "we do not know" answer, so a refusal here needs no
 * outcome of its own.
 */

/** Thrown when a body crosses its cap; the read is cancelled at that point. */
export class ResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`response body exceeds the ${maxBytes}-byte cap`);
    this.name = "ResponseTooLargeError";
  }
}

/**
 * Read `response`'s body as JSON, refusing it once more than `maxBytes` have
 * arrived. Decodes as UTF-8 with a leading BOM dropped, the same as
 * `response.json()`.
 */
export async function readCappedJson(response: Response, maxBytes: number): Promise<unknown> {
  // `received > NaN` is never true, so an unvalidated cap could switch itself
  // off without a word. Refused the way voice-pack-download.ts refuses one.
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    await response.body?.cancel().catch(() => undefined);

    throw new RangeError(`byte cap ${String(maxBytes)} is not a positive integer`);
  }

  // Decoded as the chunks arrive, so no copy of the raw bytes outlives the
  // chunk it came in.
  const decoder = new TextDecoder();
  const text: string[] = [];
  let received = 0;

  if (response.body !== null) {
    const reader = response.body.getReader();

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      received += value.byteLength;

      if (received > maxBytes) {
        // Cancelling releases the connection rather than leaving the rest of
        // the body to drain into a buffer nobody reads.
        await reader.cancel().catch(() => undefined);

        throw new ResponseTooLargeError(maxBytes);
      }

      text.push(decoder.decode(value, { stream: true }));
    }
  }

  text.push(decoder.decode());

  // An empty body is "" here and a SyntaxError from the parse, exactly as it
  // is from `response.json()`.
  return JSON.parse(text.join(""));
}
