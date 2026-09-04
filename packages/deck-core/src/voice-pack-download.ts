/**
 * A timed, capped, hashing download of a voice-pack archive (issue #1034,
 * stage 2).
 *
 * The one place the install pipeline talks to the archive host, and the only
 * thing it does is move bytes from a response body into an injected sink while
 * hashing them. It decides nothing about where those bytes go — that is
 * `voice-pack-storage.ts` — and it knows nothing about settings, progress
 * surfaces or the catalog. The caller hands it a URL, the digest the catalog
 * promised, the size the catalog promised, and a sink; it hands back one
 * discriminated answer.
 *
 * Three properties are load-bearing, and each is enforced on the bytes that
 * ACTUALLY ARRIVE rather than on anything the server says about them:
 *
 * - The sha-256 is computed as the stream flows. Buffering 12.5 MB to hash it
 *   afterwards would hold the whole archive in memory inside a plugin process
 *   that is also rendering keys and playing audio during a race.
 * - The byte cap is checked per chunk and aborts the moment it is crossed.
 *   `Content-Length` is a claim, not a fact — a server may omit it, and one that
 *   lies would otherwise be believed — so it is used for the progress bar and
 *   for nothing else. See {@link downloadVoicePack} for why it is not even used
 *   to refuse early.
 * - The deadline is an IDLE one, re-armed by every chunk, not a total. See the
 *   comment on {@link VOICE_PACK_DOWNLOAD_STALL_TIMEOUT_MS}. It has a ceiling
 *   beside it, on the network time of the whole download, sized so that it can
 *   never be the thing that cuts an honest one — see {@link
 *   VOICE_PACK_DOWNLOAD_TOTAL_TIMEOUT_MS} for what it is for instead.
 * - The archive is fetched over https, and that is checked where the bytes
 *   come FROM rather than where the URL was written: the catalog schema pins
 *   the scheme, but `fetch` follows redirects, and the release host always
 *   redirects an archive URL to its CDN. The response's own final URL is what
 *   is checked, before a byte of the body is read. See {@link downloadVoicePack}
 *   for what that does and does not cover.
 *
 * Never throws. Every way a download can go wrong is a `failure` kind on the
 * result, because the caller acts differently on them: a hash mismatch is
 * never retried automatically, a transport failure is retried next start, and
 * a cap overrun points at the catalog rather than the network. Collapsing them
 * to one `undefined` the way the changelog client does would throw that
 * distinction away, and here it is the whole point.
 *
 * `fetch` is global (Node >= 24); `fetchImpl` is injected for tests, exactly as
 * `changelog-feed-client.ts` does it, so no test makes a network request.
 */
import { createHash } from "node:crypto";

import { SHA256_HEX_PATTERN } from "./voice-pack-constants.js";

/**
 * How long this function will wait on the NETWORK for the next byte before
 * giving up — the request itself, then each read of the body.
 *
 * Idle rather than total, and that choice is the honest one. A single overall
 * deadline would have to be sized for the slowest connection a 12.5 MB download
 * should still succeed on: at 100 kB/s that is over two minutes, at 50 kB/s
 * over four, and a figure generous enough for those is far too generous to
 * bound a request that has silently died. Bytes arriving are the only signal
 * that separates "slow" from "dead", so the deadline is armed only while we are
 * waiting for bytes and re-armed by every chunk. A download that is making
 * progress, however slowly, is never cut; one that has gone quiet is cut after
 * this long.
 *
 * It is deliberately NOT running while the sink is being written. A slow disk is
 * not a dead connection, and counting disk time against the network would fail
 * a healthy download on a machine whose AV scanner is busy with the very file
 * being written.
 *
 * 30 s: the archive host is a CDN, and a connection to one that has delivered
 * nothing for half a minute is not coming back. The changelog client's 5 s is
 * for a few-kilobyte JSON where the whole request should finish inside it;
 * this is a per-silence budget, and a redirect plus TLS handshake to the
 * release CDN can honestly take a few seconds on a poor link.
 */
export const VOICE_PACK_DOWNLOAD_STALL_TIMEOUT_MS = 30_000;

/**
 * How long this function will wait on the network IN TOTAL, across every
 * chunk, before giving up on a download that is still delivering.
 *
 * The idle deadline above cannot be the only bound. It is re-armed by every
 * chunk, so a server that sends one byte every 29 seconds is never cut by it —
 * and the install reading from it holds the pack's lock, its busy slot and the
 * Remove command for as long as it runs, which without this ceiling is as long
 * as the plugin process lives. The lock's heartbeat keeps refreshing the whole
 * time, so the other ecosystems' plugins wait on it too, until their own wait
 * runs out. Slow-but-alive is what the idle deadline is careful not to kill;
 * too-slow-to-ever-finish is what this one kills.
 *
 * Counted the way the idle deadline counts — while waiting on the network, not
 * while the sink is being written — for the reason given there: a slow disk is
 * not a dripping server. One timer serves both bounds; each arm sets it to
 * whichever is nearer, the idle deadline or what is left of this one.
 *
 * 30 min. The honest worst case is a several-voice pack on a throttled link:
 * 12.5 MB at 20 kB/s — a mobile plan past its data cap — is about ten minutes,
 * and three voices' worth is about thirty. A single-voice pack gets through on
 * anything faster than 7 kB/s (12.5 MB / 1800 s). Slower than that is not a
 * slow link, it is one nobody sits and waits on, and the retry at the next
 * start costs nothing. On the other side of the number, a dripping server now
 * holds the install for half an hour rather than indefinitely — and the other
 * plugins stop waiting on the lock after `VOICE_PACK_LOCK_MAX_WAIT_MS` (ten
 * minutes) in any case.
 */
export const VOICE_PACK_DOWNLOAD_TOTAL_TIMEOUT_MS = 30 * 60_000;

/**
 * The most this function will ever accept, whatever the caller asks for.
 *
 * The caller passes the catalog entry's own `bytes` as `maxBytes`, and that is
 * the TIGHT bound: one byte past the size the catalog promised already
 * guarantees a hash mismatch, so stopping there wastes nothing. This ceiling
 * is what bounds a catalog entry that is itself wrong. The catalog is our own
 * document served over https, but a document is exactly the kind of thing a
 * typo lands in, and `"bytes": 12500000000` should cost a failed install
 * rather than a filled disk.
 *
 * 128 MiB is ten packs' worth. A pack carrying several voices is plausible; a
 * pack larger than this is not, and raising the constant is the whole change.
 */
export const VOICE_PACK_DOWNLOAD_CEILING_BYTES = 128 * 1024 * 1024;

/**
 * Where the bytes go. `write` may be synchronous or return a promise; either
 * way the next chunk is not written until it has finished, so a sink never
 * sees two writes in flight. Throwing or rejecting ends the download as a
 * `sink` failure.
 *
 * Only `write`, on purpose. Opening and closing the destination belong to
 * whoever owns the file — the storage module — so that a download that fails
 * halfway can be discarded by the same hand that created it.
 */
export interface VoicePackDownloadSink {
  write(chunk: Uint8Array): Promise<void> | void;
}

export interface VoicePackDownloadProgress {
  /** Bytes handed to the sink so far. */
  receivedBytes: number;
  /**
   * From `Content-Length`, when the server sent one that parses. A hint for a
   * progress bar and nothing else — the cap is {@link DownloadVoicePackOptions.maxBytes}.
   */
  totalBytes?: number;
}

/**
 * Why a download did not produce a verified archive.
 *
 * - `invalid-request` — the caller's own arguments were unusable: an expected
 *   digest that is not lowercase hex, or a cap that is not a positive integer.
 *   Refused BEFORE any request is made.
 * - `http` — the server answered, and the answer was not a success status.
 * - `insecure-redirect` — the request went out over https and the answer came
 *   from somewhere that is not. Refused after the redirect was followed and
 *   before a byte of the body was read: the archive is never taken in the clear.
 * - `transport` — the request could not be made, or the connection dropped
 *   partway through the body.
 * - `timeout` — no bytes arrived for {@link DownloadVoicePackOptions.stallTimeoutMs},
 *   or the whole download ran past {@link DownloadVoicePackOptions.totalTimeoutMs}.
 *   One kind for both, because the caller does the same with each — retries at
 *   the next start — and the `reason` says which clock ran out.
 * - `too-large` — the body exceeded the cap. Points at the catalog or the
 *   server, never at the network.
 * - `sink` — the destination refused a write. A disk full or a locked file,
 *   not a download problem at all.
 * - `hash-mismatch` — every byte arrived and the archive is not the one the
 *   catalog described. The one kind that must never be retried automatically:
 *   the same URL will hand back the same bytes.
 * - `aborted` — the caller's own `signal` fired.
 */
export const VOICE_PACK_DOWNLOAD_FAILURES = [
  "invalid-request",
  "http",
  "insecure-redirect",
  "transport",
  "timeout",
  "too-large",
  "sink",
  "hash-mismatch",
  "aborted",
] as const;

export type VoicePackDownloadFailure = (typeof VOICE_PACK_DOWNLOAD_FAILURES)[number];

export type VoicePackDownloadResult =
  | { ok: true; /** Lowercase hex, equal to the expected digest. */ sha256: string; bytes: number }
  | {
      ok: false;
      failure: VoicePackDownloadFailure;
      /** For the log. Says what happened; the caller words it for a user. */
      reason: string;
      /** Bytes the sink had received when it went wrong. */
      bytes: number;
    };

export interface DownloadVoicePackOptions {
  url: string;
  /** Lowercase hex sha-256, as the catalog schema pins it. */
  expectedSha256: string;
  /**
   * The most bytes to accept — the catalog entry's `bytes`. Enforced against
   * bytes received, never against `Content-Length`, and never above
   * {@link VOICE_PACK_DOWNLOAD_CEILING_BYTES}.
   */
  maxBytes: number;
  sink: VoicePackDownloadSink;
  /**
   * Called after every chunk. Deliberately unthrottled: the caller writes
   * progress to a run-scoped global at about 1 Hz, and a throttle here would be
   * a second clock disagreeing with that one. Per-chunk is what the caller can
   * throttle; anything coarser is a rate this module has no business choosing.
   */
  onProgress?: (progress: VoicePackDownloadProgress) => void;
  /** The caller's own cancellation — the plugin stopping, say. */
  signal?: AbortSignal;
  stallTimeoutMs?: number;
  /** The ceiling on network time across the whole download — see {@link VOICE_PACK_DOWNLOAD_TOTAL_TIMEOUT_MS}. */
  totalTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Both bounds a digest must meet, in one place: the catalog schema's own rule,
 * restated here because this module compares against the digest it computes
 * and `createHash().digest("hex")` is lowercase. A caller passing an uppercase
 * digest would be refused by the schema before it ever reached here; this
 * guard is for the caller that bypasses the schema, and it refuses BEFORE the
 * download rather than reporting a spurious mismatch after 12.5 MB.
 */
const SHA256_HEX = SHA256_HEX_PATTERN;

/**
 * The cap actually enforced: the caller's, held under the ceiling.
 *
 * @internal Exported for testing — proving the clamp any other way would mean
 * streaming 128 MiB through a test.
 */
export function resolveByteCap(maxBytes: number): number {
  return Math.min(maxBytes, VOICE_PACK_DOWNLOAD_CEILING_BYTES);
}

/**
 * Download `url` into `sink`, hashing as it goes, and verify the digest.
 *
 * `Content-Length` is read for the progress hint only. It is deliberately not
 * used to refuse an oversized body early, tempting as that is: a server that
 * announces a wrong LARGE size but sends a correct body would then be refused
 * for a download that would have verified. The cap that matters is on bytes
 * received, and a lie in the header costs nothing there.
 */
export async function downloadVoicePack(options: DownloadVoicePackOptions): Promise<VoicePackDownloadResult> {
  const {
    url,
    expectedSha256,
    maxBytes,
    sink,
    onProgress,
    signal,
    stallTimeoutMs = VOICE_PACK_DOWNLOAD_STALL_TIMEOUT_MS,
    totalTimeoutMs = VOICE_PACK_DOWNLOAD_TOTAL_TIMEOUT_MS,
    fetchImpl = fetch,
  } = options;

  if (!SHA256_HEX.test(expectedSha256)) {
    return fail("invalid-request", `expected digest "${expectedSha256}" is not a lowercase hex sha-256`, 0);
  }

  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    return fail("invalid-request", `byte cap ${String(maxBytes)} is not a positive integer`, 0);
  }

  // The schema's rule, restated for the caller that bypasses the schema — as
  // with the digest above. The final hop is checked separately, below.
  if (!isHttps(url)) return fail("invalid-request", `"${url}" is not an https URL`, 0);

  if (signal?.aborted) return fail("aborted", "cancelled before the request was made", 0);

  const cap = resolveByteCap(maxBytes);
  const hash = createHash("sha256");
  let received = 0;
  let totalBytes: number | undefined;

  // One controller, two reasons to fire it. Which one fired is recorded in
  // flags rather than read back off the error, because the error a cancelled
  // read produces depends on who made the stream — undici rejects with an
  // AbortError, a hand-built ReadableStream resolves `done` — and neither says
  // WHY it was cancelled.
  //
  // `AbortSignal.timeout` cannot express an idle deadline: it is one fixed
  // instant with no way to push it back per chunk. So the `AbortController`
  // path that `changelog-feed-client.ts` keeps as its fallback is the primary
  // path here, for the same reason that fallback exists there — the request
  // must never run with no deadline at all.
  const controller = new AbortController();
  let stalled = false;
  let exceeded = false;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  // Network time so far, summed over every armed interval. The total ceiling
  // is measured against this rather than the wall clock so that, like the idle
  // deadline, it never counts time spent in the sink.
  let networkMs = 0;
  let armedAt: number | undefined;

  const disarm = (): void => {
    if (timer !== undefined) clearTimeout(timer);

    timer = undefined;

    if (armedAt !== undefined) {
      networkMs += Date.now() - armedAt;
      armedAt = undefined;
    }
  };

  // One timer, two bounds: set to whichever is nearer. Which bound a firing
  // means is decided here, when the timer is set — nothing read back after
  // the abort would say, for the same reason the flags exist at all.
  const arm = (): void => {
    disarm();
    armedAt = Date.now();
    const remaining = totalTimeoutMs - networkMs;
    const totalIsNearer = remaining <= stallTimeoutMs;
    timer = setTimeout(
      () => {
        if (totalIsNearer) exceeded = true;
        else stalled = true;

        controller.abort();
      },
      Math.max(0, totalIsNearer ? remaining : stallTimeoutMs),
    );
  };

  /** Whether any of our own reasons to abort has fired. */
  const fired = (): boolean => cancelled || stalled || exceeded;

  const onCallerAbort = (): void => {
    cancelled = true;
    controller.abort();
  };

  // Cancelling the reader is what makes a pending `read()` come back at all on
  // a body the signal does not reach — every read below checks the flags on
  // its way out. Errors from `cancel` itself are irrelevant: the stream is
  // being thrown away.
  controller.signal.addEventListener("abort", () => {
    reader?.cancel().catch(() => undefined);
  });
  signal?.addEventListener("abort", onCallerAbort, { once: true });

  const interrupted = (err?: unknown): VoicePackDownloadResult => {
    if (cancelled) return fail("aborted", "cancelled by the caller", received);

    if (exceeded) {
      return fail("timeout", `did not finish inside ${describeDuration(totalTimeoutMs)} of network time`, received);
    }

    if (stalled) return fail("timeout", `no data for ${Math.round(stallTimeoutMs / 1000)} s`, received);

    return fail("transport", `the connection failed (${describeError(err)})`, received);
  };

  try {
    let response: Response;
    arm();

    try {
      response = await fetchImpl(url, { signal: controller.signal, cache: "no-store" });
    } catch (err) {
      return interrupted(err);
    }

    disarm();

    // A caller abort that lands between the response resolving and the flag
    // being read is still an abort, not an HTTP verdict.
    if (fired()) return interrupted();

    // `response.url` is where the body is coming FROM — the last hop, after
    // every redirect `fetch` followed — and it is the only view of the redirect
    // chain the Fetch API offers. Checked here, before the body is touched, so
    // the schema's https rule holds for the bytes and not just for the catalog.
    //
    // What this cannot see is an INTERMEDIATE plaintext hop (https -> http ->
    // https): `fetch` follows those silently, and inspecting each hop would
    // mean `redirect: "manual"` and a hand-rolled redirect loop. Not done, on
    // purpose. An attacker on such a hop can send the request anywhere, and
    // everywhere it can be sent is already refused — a plaintext final host
    // here, a different archive by the digest, a huge one by the byte cap.
    // What that leaves them is knowing this machine fetched a public archive,
    // which is not worth a second redirect implementation. Not airtight, and
    // not claimed to be.
    //
    // A `Response` built by hand reports no url at all. undici never produces
    // one — that is a test double — and it is read as "no redirect happened".
    const finalUrl = response.url || url;

    if (!isHttps(finalUrl)) {
      // Cancelled rather than left for the collector: an unread body keeps
      // its connection open, and this one is the whole archive.
      await response.body?.cancel().catch(() => undefined);

      return fail("insecure-redirect", `redirected to ${describeOrigin(finalUrl)}, which is not https`, 0);
    }

    if (!response.ok) {
      // Cancelled for the same reason the redirect branch above cancels: an
      // unread body holds its connection open, and a failing install is
      // exactly the case a user retries, so the leak would accumulate.
      await response.body?.cancel().catch(() => undefined);

      return fail("http", `the server answered HTTP ${response.status}`, 0);
    }

    if (response.body === null) return fail("transport", "the server sent no body", 0);

    totalBytes = parseContentLength(response.headers.get("content-length"));
    const body: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    reader = body;

    for (;;) {
      let step: Awaited<ReturnType<typeof body.read>>;
      arm();

      try {
        step = await body.read();
      } catch (err) {
        return interrupted(err);
      }

      disarm();

      // Checked BEFORE `done`: a cancelled reader reports `done`, and taking
      // that as the end of the body would hash a truncated archive and report
      // it as a mismatch rather than the timeout it was.
      if (fired()) return interrupted();

      if (step.done) break;

      const chunk = step.value;
      received += chunk.byteLength;

      // Checked before the write, so the sink never receives the chunk that
      // crosses the cap. The connection is cancelled rather than drained: the
      // remaining bytes are exactly what we refuse to pay for.
      if (received > cap) {
        await reader.cancel().catch(() => undefined);

        return fail("too-large", `the archive exceeds the ${cap}-byte cap`, received - chunk.byteLength);
      }

      hash.update(chunk);

      try {
        await sink.write(chunk);
      } catch (err) {
        await reader.cancel().catch(() => undefined);

        return fail("sink", `could not write the archive (${describeError(err)})`, received - chunk.byteLength);
      }

      // A progress observer is decoration; the bytes are not. An exception in
      // a UI callback must cost that one update, never the download it was
      // describing — and misreporting it as a transport failure would send
      // the user to check their network over a bug in a progress bar.
      try {
        onProgress?.({ receivedBytes: received, ...(totalBytes === undefined ? {} : { totalBytes }) });
      } catch {
        // Deliberately dropped; see above.
      }
    }

    const sha256 = hash.digest("hex");

    // Exact comparison, both sides lowercase hex — the guard at the top is what
    // makes exactness correct rather than a source of spurious mismatches.
    if (sha256 !== expectedSha256) {
      return fail(
        "hash-mismatch",
        `the archive's sha-256 is ${sha256.slice(0, 12)}…, the catalog promised ${expectedSha256.slice(0, 12)}…`,
        received,
      );
    }

    return { ok: true, sha256, bytes: received };
  } catch (err) {
    // Nothing above is expected to throw; this is the promise the signature
    // makes. A surprise here is a bug, but a bug in a downloader must still
    // read as a failed download rather than end the plugin process.
    return interrupted(err);
  } finally {
    disarm();
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

function fail(failure: VoicePackDownloadFailure, reason: string, bytes: number): VoicePackDownloadResult {
  return { ok: false, failure, reason, bytes };
}

/** The catalog schema's own test, restated for a URL that arrived rather than one that was written. */
function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** `scheme://host[:port]` for the log — the host is what a reader needs — or the raw value when it is no URL at all. */
function describeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

function describeDuration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

/**
 * A parseable, positive `Content-Length`, else nothing. Anything odd — absent,
 * blank, negative, not a number — is simply "no hint", never an error.
 */
function parseContentLength(header: string | null): number | undefined {
  if (header === null) return undefined;

  const value = Number(header.trim());

  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * undici wraps the interesting error — `ECONNREFUSED`, `ENOTFOUND` — in a
 * `TypeError: fetch failed` whose `cause` carries it. The cause is what a log
 * reader needs.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    const inner = cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause);

    return inner === undefined || inner === err.message ? err.message : `${err.message}: ${inner}`;
  }

  return String(err);
}
