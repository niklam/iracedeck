# Voice-pack installs stream the archive, and the size ceiling rises to 2 GB

> **Issue:** [#1102](https://github.com/niklam/iracedeck/issues/1102) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

An install never holds the archive in memory. The installer reads the staged archive from disk as a stream, hashes each chunk as it passes, and hands the same chunks to the extractor, which now takes an async iterable of chunks instead of a `Uint8Array`. The read-back digest is compared when the stream ends, and a mismatch discards the staging tree before anything is promoted. Peak memory during an install is then the extractor's per-entry buffer (`maxEntryBytes`, 16 MB) plus its one-slice inflate transient (~17 MB) plus a read chunk, whatever the archive's size.

With memory no longer a function of the archive, the size limits rise to what the maintainer chose (2026-10-03), because the packs being prepared are higher-bitrate and carry several voices, and are already past 100 MB:

| Limit | Was | Now |
| --- | --- | --- |
| `VOICE_PACK_DOWNLOAD_CEILING_BYTES` (download) | 128 MiB | 2 GB (`2_000_000_000`, decimal like the extractor's caps and the size the card shows) |
| `maxTotalBytes` (unpacked, all files) | 512 MB | 4 GB |
| `maxEntries` | 20 000 | 100 000 |
| `maxEntryBytes` (one file) | 16 MB | unchanged — two hundred times the largest clip, and it is the per-entry buffer that bounds memory |
| `maxCompressionRatio`, `ratioGraceBytes` | 100, 1 MB | unchanged |

The download's total-time ceiling grows with the pack: `max(30 min, maxBytes ÷ 100 kB/s)`. At 30 min flat a 2 GB pack would need 1.1 MB/s sustained, and the ceiling exists to bound a dripping server, not to cut an honest slow download. 100 kB/s (0.8 Mbit/s) keeps every pack up to 180 MB on today's 30 minutes, and gives a 2 GB pack about 5.5 hours. An explicit `totalTimeoutMs` still wins over the derived value.

## One pass, not two

The issue's wording keeps the read-back "before anything is extracted". Streaming makes that ordering cost the very property the read-back exists for. With a buffer, the bytes hashed and the bytes extracted were the same object. With a stream, a hashing pass followed by an extracting pass reads the file twice, and anything that rewrites it in between — the AV scanner or the overlapping download the installer's comment names — is extracted unverified. That is exactly the gap the read-back closed. Node cannot open the file without `FILE_SHARE_WRITE` to forbid the rewrite.

So the hash is taken on the extraction pass itself, and the guarantee is stated as what it always protected: **no byte that fails the catalog digest is installed.** The staging directory is created fresh for this install, the extractor writes nothing outside it, and promotion runs only after the digest matches. The extractor already treats every byte as hostile, since the download's own digest is only a claim about what crossed the network.

When the extractor refuses the archive part-way, the installer drains the rest of the stream into the hash before it reports anything. A digest mismatch then reports the existing "archive changed on disk" verify failure rather than an extract failure, because a rewritten file is the cause and a malformed entry only its symptom. Draining is a plain read with no decompression, so it costs disk time only.

The read-back still counts bytes. The stream must deliver exactly `entry.bytes`, which matches the digest's own guarantee and costs nothing.

## The extractor's source

`ExtractVoicePackArchiveOptions.archive: Uint8Array` becomes `source: AsyncIterable<Uint8Array>`. Chunks may be any size. The extractor re-slices them into `VOICE_PACK_ARCHIVE_PUSH_BYTES` (16 KB) pushes, so the bomb transient bound is unchanged. It also keeps yielding to the event loop every `SLICES_PER_TURN` slices, beside the natural yield every awaited read gives.

- **The local-header check** buffers the first four bytes from however many chunks they span, then pushes them on.
- **The end of the archive** is the iterator's end: fflate's `Unzip` takes an empty final push (`push(new Uint8Array(0), true)`). This was checked against the installed fflate, and the truncated-entry and empty-archive checks after the loop are unchanged.
- **A source that throws** is caught by the loop's existing `try` and reported as `malformed` ("damaged or truncated"). The extractor still never throws. The installer's wrapper records the read error itself, so the user is told the archive "could not be read back" (a `storage` failure) and not that it is damaged.
- **The aggregate compression ratio** (#1100) loses `archive.length` as its denominator. It now uses **the compressed bytes consumed so far**, counted by the extractor as it pushes. Like `archive.length`, nobody can misdeclare it, because it is bytes the extractor has actually been handed. It is never larger than the archive's length, so the check can only get stricter, and it judges an attack at the point it happens rather than against a total that has not arrived yet. Taking the length from the caller was rejected, because the extractor would then trust a number it cannot see. A real pack runs about 1:1 at every point, and the 1 MB grace still applies before the check judges anything.

The extractor keeps no `Uint8Array` overload. Tests wrap a buffer in a small helper, so the module has one input shape.

## The installer

- `VoicePackInstallerFileSystem` gains `readStream(file): AsyncIterable<Uint8Array>`, implemented with `createReadStream`. `readFile` stays for the bundled seed, which reads one clip at a time.
- `stageFromCatalog` creates the staging directory, then extracts from the hashing wrapper. It checks, in order, a read error (`storage`), then the digest and byte count, drained to the end (`verify`), then the extractor's verdict (`extract`), and only then calls `finishStaging`.
- The long comment that the #1100 review left on the buffered read is replaced by one that states the new single-pass reasoning above.
- **Phases.** No separate verify step exists any more, so `verifying` leaves `VOICE_PACK_INSTALL_PHASES`, along with the card's `KNOWN_PHASES` and its label. The combined pass reports `extracting`. `_voicePackStatus` is run-scoped, and the same build both writes and reads it, so no older reader exists to keep the value for. The `verify` failure code stays.

## Out of scope

- **Streaming each entry to disk.** Entries are still buffered whole up to `maxEntryBytes` and written once. That is the per-entry buffer the issue's verification is stated against, and it keeps the "no partial file to clean up" property. Writing in chunks would lower the peak by 16 MB and add a cleanup path for half-written files.
- **A free-space check before downloading.** An install needs up to the archive plus its unpacked staging copy on disk at once (worst case about 6 GB at the new caps). Running out of space today fails as a `storage` or `write` failure, and the staging tree is discarded. That is the right outcome; a pre-check would only make it come earlier.
- **Extraction progress.** The `extracting` phase reports no bytes. A large pack can now spend a minute unpacking under one label. A progress figure is a status-contract change of its own.
- **The install lock.** Other plugins stop waiting after `VOICE_PACK_LOCK_MAX_WAIT_MS` (10 min) and proceed as `acquireLock` already explains. A longer download makes that path more common, but it does not make it less safe.
- **Sideloaded packs.** They are copied in by hand and never pass through the extractor, so none of these limits apply to them.
- **The #1269 speech-asset spec** names the old 128 MiB ceiling as a fact of its day. It is a point-in-time record and is left alone.

## Testing

Unit (`voice-pack-archive.test.ts`, `voice-pack-download.test.ts`, `voice-pack-installer.test.ts`):

- The extractor runs every existing case through a buffer-to-chunks helper at several chunk sizes: 1 byte, 3 bytes, 16 KB, 64 KB, and one whole chunk. The local-header check, entry boundaries and the truncation checks must not depend on where the chunks split.
- **Laziness.** A generator source records how many chunks have been pulled. The extractor must not pull chunk N+1 before chunk N has been pushed, and it must stop pulling at the first refusal.
- **The aggregate ratio.** It is judged against consumed bytes, which needs a case where the old `archive.length` denominator would have accepted a front-loaded expansion that the running count refuses. The thin-spread bomb that #1100 added still fails.
- A throwing source reports `malformed`, and nothing escapes the extractor.
- The new default caps are pinned, including the 2 GB `resolveByteCap` clamp and the derived total timeout at 12.5 MB, 180 MB and 2 GB.
- **The installer.** The archive path never calls `readFile`. A digest mismatch reports `verify` even when the extractor refused first, and the remaining bytes are drained. A read error reports `storage`. A wrong byte count with a matching prefix fails. No path promotes on a mismatch.
- **The card.** It has no `verifying` label, and the phase lists in deck-core and pi-components stay equal.

Manual, recorded in the PR: a throwaway script, not committed, builds a synthetic ~1.5 GB pack of stored random-byte `.mp3` entries. It runs that pack through `extractVoicePackArchive` over a real `createReadStream` into a temp directory and samples `process.memoryUsage().rss` and `arrayBuffers` throughout. Peak growth must stay within a small multiple of 16 MB and must not track the archive's size. The same script run against the old buffered code shows the difference. The maintainer then installs the managed `default` pack from the real catalog, with the install going through the plugin as usual, to confirm the path end to end.
