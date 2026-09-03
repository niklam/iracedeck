import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadVoicePack,
  resolveByteCap,
  VOICE_PACK_DOWNLOAD_CEILING_BYTES,
  VOICE_PACK_DOWNLOAD_STALL_TIMEOUT_MS,
  VOICE_PACK_DOWNLOAD_TOTAL_TIMEOUT_MS,
  type VoicePackDownloadProgress,
  type VoicePackDownloadSink,
} from "./voice-pack-download.js";

const URL_ = "https://github.example/releases/luca-1.0.0.zip";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sha256(chunks: readonly Uint8Array[]): string {
  const hash = createHash("sha256");

  for (const chunk of chunks) hash.update(chunk);

  return hash.digest("hex");
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/** An in-memory sink that records every write in order. */
function memorySink(): VoicePackDownloadSink & { chunks: Uint8Array[]; received(): number } {
  const chunks: Uint8Array[] = [];

  return {
    chunks,
    write(chunk) {
      chunks.push(Uint8Array.from(chunk));
    },
    received: () => chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  };
}

/**
 * A response body that hands out `chunks` one per pull and records whether the
 * consumer cancelled it. `pull` is called only when the reader asks, so
 * `pulls` says how far the download actually read — a cancelled stream stops
 * being pulled, which is how "the sink stopped receiving" is proved from the
 * SOURCE side as well.
 */
function chunkedBody(chunks: readonly Uint8Array[], opts: { hang?: boolean; failAfter?: number } = {}) {
  const state = { pulls: 0, cancelled: false };
  let index = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls += 1;

        if (opts.failAfter !== undefined && index >= opts.failAfter) {
          controller.error(new Error("ECONNRESET"));

          return;
        }

        if (index < chunks.length) {
          controller.enqueue(chunks[index]);
          index += 1;

          return;
        }

        // Past the last chunk: either a body that never ends, or a clean close.
        if (opts.hang) return new Promise<void>(() => undefined);

        controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    },
    // No read-ahead: with the default high-water mark of 1 the stream pulls a
    // chunk it has not been asked for, and `pulls` would count the stream's
    // own buffering rather than what the download actually consumed.
    { highWaterMark: 0 },
  );

  return { stream, state };
}

function respondWith(
  stream: ReadableStream<Uint8Array> | null,
  init: {
    status?: number;
    contentLength?: string;
    /** The final URL, as if a redirect had been followed. */ url?: string;
  } = {},
): typeof fetch {
  return vi.fn(async (_url: unknown, requestInit?: RequestInit) => {
    const signal = requestInit?.signal;

    if (signal?.aborted) throw new DOMException("aborted", "AbortError");

    const response = new Response(stream, {
      status: init.status ?? 200,
      headers: init.contentLength === undefined ? {} : { "content-length": init.contentLength },
    });

    // `Response.url` is read-only and "" on a hand-built one; stamping it on
    // as an own property is the shape undici hands back after following a
    // redirect, without a server to follow it from.
    if (init.url !== undefined) Object.defineProperty(response, "url", { value: init.url });

    return response;
  }) as unknown as typeof fetch;
}

const THREE = [bytes("abc"), bytes("defg"), bytes("hij")];
const THREE_DIGEST = sha256(THREE);

afterEach(() => {
  vi.useRealTimers();
});

describe("downloadVoicePack", () => {
  it("streams every byte to the sink in order, and reports the verified digest and size", async () => {
    const sink = memorySink();
    const { stream } = chunkedBody(THREE);

    const result = await downloadVoicePack({
      url: URL_,
      expectedSha256: THREE_DIGEST,
      maxBytes: 10,
      sink,
      fetchImpl: respondWith(stream),
    });

    expect(result).toEqual({ ok: true, sha256: THREE_DIGEST, bytes: 10 });
    expect(Buffer.from(concat(sink.chunks)).toString()).toBe("abcdefghij");
  });

  it("requests the url it was given, with no-store and an abort signal", async () => {
    const fetchImpl = respondWith(chunkedBody(THREE).stream);
    await downloadVoicePack({ url: URL_, expectedSha256: THREE_DIGEST, maxBytes: 10, sink: memorySink(), fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      URL_,
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
  });

  describe("progress", () => {
    it("reports cumulative bytes after every chunk, with Content-Length as the total", async () => {
      const seen: VoicePackDownloadProgress[] = [];
      await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink: memorySink(),
        fetchImpl: respondWith(chunkedBody(THREE).stream, { contentLength: "10" }),
        onProgress: (progress) => seen.push(progress),
      });

      expect(seen).toEqual([
        { receivedBytes: 3, totalBytes: 10 },
        { receivedBytes: 7, totalBytes: 10 },
        { receivedBytes: 10, totalBytes: 10 },
      ]);
    });

    it("omits the total when the server sends no usable Content-Length", async () => {
      for (const contentLength of [undefined, "", "abc", "-5", "0"]) {
        const seen: VoicePackDownloadProgress[] = [];
        await downloadVoicePack({
          url: URL_,
          expectedSha256: THREE_DIGEST,
          maxBytes: 10,
          sink: memorySink(),
          fetchImpl: respondWith(chunkedBody(THREE).stream, { contentLength }),
          onProgress: (progress) => seen.push(progress),
        });

        expect(seen.at(-1)).toEqual({ receivedBytes: 10 });
      }
    });

    it("survives a progress callback that throws — the bytes still land and verify", async () => {
      const sink = memorySink();

      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink,
        fetchImpl: respondWith(chunkedBody(THREE).stream),
        onProgress: () => {
          throw new Error("progress bar bug");
        },
      });

      expect(result.ok).toBe(true);
      expect(sink.received()).toBe(10);
    });
  });

  describe("Content-Length is a hint, never the limit", () => {
    it("accepts a body larger than a lying-small Content-Length", async () => {
      const seen: VoicePackDownloadProgress[] = [];

      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink: memorySink(),
        fetchImpl: respondWith(chunkedBody(THREE).stream, { contentLength: "4" }),
        onProgress: (progress) => seen.push(progress),
      });

      expect(result.ok).toBe(true);
      // The hint is passed through untouched, wrong as it is; it is the
      // caller's progress bar that has to cope, not the cap.
      expect(seen.at(-1)).toEqual({ receivedBytes: 10, totalBytes: 4 });
    });

    it("does not refuse early on a lying-large Content-Length when the body itself is fine", async () => {
      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink: memorySink(),
        fetchImpl: respondWith(chunkedBody(THREE).stream, { contentLength: "999999999999" }),
      });

      expect(result).toMatchObject({ ok: true, bytes: 10 });
    });
  });

  describe("byte cap", () => {
    it("aborts the moment received bytes exceed the cap, and the sink never sees the crossing chunk", async () => {
      const sink = memorySink();
      const { stream, state } = chunkedBody(THREE);

      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 5,
        sink,
        fetchImpl: respondWith(stream),
      });

      expect(result).toMatchObject({ ok: false, failure: "too-large", bytes: 3 });
      // "abc" fit under the cap; "defg" crossed it and was never written.
      expect(sink.chunks.map((chunk) => Buffer.from(chunk).toString())).toEqual(["abc"]);
      // The source was cancelled rather than drained: two pulls, never a third.
      expect(state.cancelled).toBe(true);
      expect(state.pulls).toBe(2);
    });

    it("accepts a body exactly at the cap", async () => {
      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink: memorySink(),
        fetchImpl: respondWith(chunkedBody(THREE).stream),
      });

      expect(result.ok).toBe(true);
    });

    it("enforces the cap even when Content-Length claims the body is small", async () => {
      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 5,
        sink: memorySink(),
        fetchImpl: respondWith(chunkedBody(THREE).stream, { contentLength: "5" }),
      });

      expect(result).toMatchObject({ ok: false, failure: "too-large" });
    });

    it("holds the caller's cap under the module ceiling", () => {
      expect(resolveByteCap(10)).toBe(10);
      expect(resolveByteCap(VOICE_PACK_DOWNLOAD_CEILING_BYTES)).toBe(VOICE_PACK_DOWNLOAD_CEILING_BYTES);
      expect(resolveByteCap(VOICE_PACK_DOWNLOAD_CEILING_BYTES * 100)).toBe(VOICE_PACK_DOWNLOAD_CEILING_BYTES);
    });
  });

  describe("digest", () => {
    it("reports a mismatch as its own failure, distinct from transport", async () => {
      const sink = memorySink();
      const wrong = "0".repeat(64);

      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: wrong,
        maxBytes: 10,
        sink,
        fetchImpl: respondWith(chunkedBody(THREE).stream),
      });

      expect(result).toMatchObject({ ok: false, failure: "hash-mismatch", bytes: 10 });
      expect((result as { reason: string }).reason).toContain(THREE_DIGEST.slice(0, 12));
      // Every byte arrived — the archive is complete and simply not the one
      // promised. The caller discards it; nothing here pretends otherwise.
      expect(sink.received()).toBe(10);
    });

    it("refuses an expected digest that is not lowercase hex without making a request", async () => {
      const fetchImpl = respondWith(chunkedBody(THREE).stream);

      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST.toUpperCase(),
        maxBytes: 10,
        sink: memorySink(),
        fetchImpl,
      });

      expect(result).toMatchObject({ ok: false, failure: "invalid-request" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("refuses a cap that is not a positive integer without making a request", async () => {
      for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const fetchImpl = respondWith(chunkedBody(THREE).stream);

        const result = await downloadVoicePack({
          url: URL_,
          expectedSha256: THREE_DIGEST,
          maxBytes,
          sink: memorySink(),
          fetchImpl,
        });

        expect(result).toMatchObject({ ok: false, failure: "invalid-request" });
        expect(fetchImpl).not.toHaveBeenCalled();
      }
    });
  });

  describe("failures", () => {
    it("reports a non-success status as http", async () => {
      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink: memorySink(),
        fetchImpl: respondWith(chunkedBody([]).stream, { status: 404 }),
      });

      expect(result).toMatchObject({ ok: false, failure: "http", reason: expect.stringContaining("404"), bytes: 0 });
    });

    it("reports a request that throws as transport, naming undici's cause", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED 127.0.0.1:443") });
      }) as unknown as typeof fetch;

      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink: memorySink(),
        fetchImpl,
      });

      expect(result).toMatchObject({ ok: false, failure: "transport", bytes: 0 });
      expect((result as { reason: string }).reason).toContain("ECONNREFUSED");
    });

    it("reports a body that errors mid-stream as transport, with the bytes that did arrive", async () => {
      const sink = memorySink();

      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink,
        fetchImpl: respondWith(chunkedBody(THREE, { failAfter: 2 }).stream),
      });

      expect(result).toMatchObject({ ok: false, failure: "transport", bytes: 7 });
      expect(sink.received()).toBe(7);
    });

    it("reports a missing body as transport", async () => {
      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink: memorySink(),
        fetchImpl: respondWith(null),
      });

      expect(result).toMatchObject({ ok: false, failure: "transport" });
    });

    it("reports a sink that rejects as sink, and cancels the source", async () => {
      const { stream, state } = chunkedBody(THREE);
      let writes = 0;
      const sink: VoicePackDownloadSink = {
        async write() {
          writes += 1;

          if (writes === 2) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
        },
      };

      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink,
        fetchImpl: respondWith(stream),
      });

      expect(result).toMatchObject({ ok: false, failure: "sink", bytes: 3 });
      expect((result as { reason: string }).reason).toContain("no space left");
      expect(state.cancelled).toBe(true);
    });

    it("reports the caller's own abort as aborted", async () => {
      const controller = new AbortController();
      const { stream, state } = chunkedBody(THREE, { hang: true });
      const sink: VoicePackDownloadSink = {
        write() {
          // Cancel once the first chunk has landed, while the read is pending.
          controller.abort();
        },
      };

      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink,
        signal: controller.signal,
        fetchImpl: respondWith(stream),
      });

      expect(result).toMatchObject({ ok: false, failure: "aborted" });
      expect(state.cancelled).toBe(true);
    });

    it("reports a signal that was already aborted without making a request", async () => {
      const controller = new AbortController();
      controller.abort();
      const fetchImpl = respondWith(chunkedBody(THREE).stream);

      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink: memorySink(),
        signal: controller.signal,
        fetchImpl,
      });

      expect(result).toMatchObject({ ok: false, failure: "aborted", bytes: 0 });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("https only", () => {
    it("refuses a url that is not https before making a request", async () => {
      for (const url of [
        "http://github.example/releases/luca-1.0.0.zip",
        "ftp://github.example/luca.zip",
        "not a url",
      ]) {
        const fetchImpl = respondWith(chunkedBody(THREE).stream);

        const result = await downloadVoicePack({
          url,
          expectedSha256: THREE_DIGEST,
          maxBytes: 10,
          sink: memorySink(),
          fetchImpl,
        });

        expect(result).toMatchObject({ ok: false, failure: "invalid-request", bytes: 0 });
        expect(fetchImpl).not.toHaveBeenCalled();
      }
    });

    it("refuses an archive whose final hop, after redirects, is not https — and reads none of it", async () => {
      const sink = memorySink();
      const { stream, state } = chunkedBody(THREE);

      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink,
        fetchImpl: respondWith(stream, { url: "http://cdn.example/luca-1.0.0.zip" }),
      });

      expect(result).toMatchObject({ ok: false, failure: "insecure-redirect", bytes: 0 });
      expect((result as { reason: string }).reason).toContain("http://cdn.example");
      // Not a byte was read or written, and the connection was released
      // rather than left open on an archive we refuse to take.
      expect(sink.received()).toBe(0);
      expect(state.pulls).toBe(0);
      expect(state.cancelled).toBe(true);
    });

    it("accepts a redirect that stays on https — the release host always sends one", async () => {
      const result = await downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink: memorySink(),
        fetchImpl: respondWith(chunkedBody(THREE).stream, { url: "https://release-assets.example/luca-1.0.0.zip" }),
      });

      expect(result).toEqual({ ok: true, sha256: THREE_DIGEST, bytes: 10 });
    });
  });

  describe("stall timeout", () => {
    it("cuts a body that goes silent, after the bytes that did arrive", async () => {
      vi.useFakeTimers();
      const sink = memorySink();
      const { stream, state } = chunkedBody(THREE, { hang: true });

      const pending = downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink,
        fetchImpl: respondWith(stream),
      });

      // Let the three chunks flow, then let the silence run past the deadline.
      await vi.advanceTimersByTimeAsync(VOICE_PACK_DOWNLOAD_STALL_TIMEOUT_MS + 1);

      const result = await pending;

      expect(result).toMatchObject({ ok: false, failure: "timeout", bytes: 10 });
      expect(sink.received()).toBe(10);
      expect(state.cancelled).toBe(true);
    });

    it("cuts a request that never answers", async () => {
      vi.useFakeTimers();
      const fetchImpl = vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ) as unknown as typeof fetch;

      const pending = downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink: memorySink(),
        fetchImpl,
      });
      await vi.advanceTimersByTimeAsync(VOICE_PACK_DOWNLOAD_STALL_TIMEOUT_MS + 1);

      expect(await pending).toMatchObject({ ok: false, failure: "timeout", bytes: 0 });
    });

    it("never cuts a slow download that is still delivering — the deadline is idle, not total", async () => {
      vi.useFakeTimers();
      // Each chunk arrives two-thirds of the way through the stall window, so
      // the whole download takes about twice the window. A total deadline of
      // one window would kill it; an idle one lets it through.
      const gap = Math.floor((VOICE_PACK_DOWNLOAD_STALL_TIMEOUT_MS * 2) / 3);
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              if (index < THREE.length) controller.enqueue(THREE[index++]);
              else controller.close();

              resolve();
            }, gap);
          });
        },
      });

      const pending = downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink: memorySink(),
        fetchImpl: respondWith(stream),
      });
      await vi.advanceTimersByTimeAsync(gap * 5);

      expect(await pending).toEqual({ ok: true, sha256: THREE_DIGEST, bytes: 10 });
    });

    it("does not count time spent in a slow sink against the network", async () => {
      vi.useFakeTimers();
      const sink: VoicePackDownloadSink = {
        write: () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, VOICE_PACK_DOWNLOAD_STALL_TIMEOUT_MS * 2);
          }),
      };

      const pending = downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink,
        fetchImpl: respondWith(chunkedBody(THREE).stream),
      });
      await vi.advanceTimersByTimeAsync(VOICE_PACK_DOWNLOAD_STALL_TIMEOUT_MS * 7);

      expect(await pending).toEqual({ ok: true, sha256: THREE_DIGEST, bytes: 10 });
    });

    it("honours a caller-supplied stall window", async () => {
      vi.useFakeTimers();
      const { stream } = chunkedBody(THREE, { hang: true });

      const pending = downloadVoicePack({
        url: URL_,
        expectedSha256: THREE_DIGEST,
        maxBytes: 10,
        sink: memorySink(),
        stallTimeoutMs: 1_000,
        fetchImpl: respondWith(stream),
      });
      await vi.advanceTimersByTimeAsync(1_001);

      expect(await pending).toMatchObject({ ok: false, failure: "timeout" });
    });
  });

  describe("total ceiling", () => {
    /**
     * A body that delivers one byte every `gap` ms, `count` times, then closes.
     * With `gap` under the idle deadline it is never silent long enough to
     * stall — which is exactly the download the ceiling exists for.
     */
    function drip(count: number, gap: number) {
      const chunks = Array.from({ length: count }, (_, i) => bytes(String(i % 10)));
      const state = { cancelled: false };
      let index = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            return new Promise<void>((resolve) => {
              setTimeout(() => {
                // A cut mid-pull leaves this timer to fire on a cancelled
                // stream, where enqueue/close would throw.
                if (!state.cancelled) {
                  if (index < chunks.length) controller.enqueue(chunks[index++]);
                  else controller.close();
                }

                resolve();
              }, gap);
            });
          },
          cancel() {
            state.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );

      return { stream, state, digest: sha256(chunks) };
    }

    it("cuts a download that stays under the idle deadline but never gets anywhere", async () => {
      vi.useFakeTimers();
      const gap = VOICE_PACK_DOWNLOAD_STALL_TIMEOUT_MS - 1_000;
      // Enough bytes, one per gap, to outlast the ceiling by a few chunks —
      // without the ceiling this download COMPLETES and verifies.
      const count = Math.ceil(VOICE_PACK_DOWNLOAD_TOTAL_TIMEOUT_MS / gap) + 5;
      const sink = memorySink();
      const { stream, state, digest } = drip(count, gap);

      const pending = downloadVoicePack({
        url: URL_,
        expectedSha256: digest,
        maxBytes: count,
        sink,
        fetchImpl: respondWith(stream),
      });
      await vi.advanceTimersByTimeAsync(count * gap + VOICE_PACK_DOWNLOAD_STALL_TIMEOUT_MS);

      const result = await pending;

      expect(result).toMatchObject({ ok: false, failure: "timeout" });
      expect((result as { reason: string }).reason).toContain("30 min");
      // Cut at the ceiling with the bytes that had arrived by then — not
      // reported at the end as a stall it never was.
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.bytes).toBeLessThan(count);
      expect(sink.received()).toBe(result.bytes);
      expect(state.cancelled).toBe(true);
    });

    it("counts network time only — a sink slower than the whole ceiling, per write, does not trip it", async () => {
      vi.useFakeTimers();
      // Reads that take real (fake) time, so a ceiling measured on the wall
      // clock would find one pending to cut; the sink then eats a whole
      // ceiling per write, and the network never sees more than seconds.
      const { stream, digest } = drip(3, 1_000);
      const sink: VoicePackDownloadSink = {
        write: () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, VOICE_PACK_DOWNLOAD_TOTAL_TIMEOUT_MS);
          }),
      };

      const pending = downloadVoicePack({
        url: URL_,
        expectedSha256: digest,
        maxBytes: 3,
        sink,
        fetchImpl: respondWith(stream),
      });
      await vi.advanceTimersByTimeAsync(VOICE_PACK_DOWNLOAD_TOTAL_TIMEOUT_MS * 4);

      expect(await pending).toEqual({ ok: true, sha256: digest, bytes: 3 });
    });

    it("honours a caller-supplied ceiling, and its reason names the ceiling rather than a stall", async () => {
      vi.useFakeTimers();
      const { stream, digest } = drip(20, 1_100);

      const pending = downloadVoicePack({
        url: URL_,
        expectedSha256: digest,
        maxBytes: 20,
        sink: memorySink(),
        totalTimeoutMs: 5_000,
        fetchImpl: respondWith(stream),
      });
      await vi.advanceTimersByTimeAsync(30_000);

      const result = await pending;

      expect(result).toMatchObject({ ok: false, failure: "timeout" });
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.bytes).toBeLessThan(20);
      expect((result as { reason: string }).reason).toContain("5 s");
      expect((result as { reason: string }).reason).not.toContain("no data");
    });
  });
});
