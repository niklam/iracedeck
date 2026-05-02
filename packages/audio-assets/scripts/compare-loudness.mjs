#!/usr/bin/env node

/**
 * One-shot comparison harness for the radio-engineer voice filter chain.
 *
 * Picks a few representative voice clips (long flag, short flag, pit-readback,
 * opener), runs each through every entry in VARIANTS, and writes the results
 * to `<repoRoot>/local/audio-loudness-compare/`.
 *
 * Output naming groups outputs by source so a media player sorted by name
 * walks each clip through every variant in order:
 *   <clip-name>__<NN-variant-label>.mp3
 *
 * Usage:
 *   node packages/audio-assets/scripts/compare-loudness.mjs
 *
 * Edit SOURCES / VARIANTS at the top to try other clips or filter chains.
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const outDir = path.join(repoRoot, "local", "audio-loudness-compare");

// Source clips (relative to packageRoot) — picked to span dynamics and lengths.
const SOURCES = [
  "voice/luca/flags/red-01.mp3",
  "voice/luca/flags/yellow-cleared-01.mp3",
  "voice/luca/pit-readback/tires-all.mp3",
  "voice/luca/pit-readback/opener-entry.mp3",
];

// The radio-engineer chain at the time this comparison was first authored
// (production was the equivalent of variant 01 below). Kept as a literal
// historical baseline so the variant labels (e.g. `+4dB`) stay meaningful
// across re-runs. Production has since moved to variant 03's chain — see
// `RADIO_ENGINEER_FILTER` in `src/presets.mjs` for the live chain.
const CURRENT = "highpass=f=250,lowpass=f=3500,volume=8dB,asoftclip=type=tanh,volume=-6dB,volume=2dB";

// Each variant gets a name (used as filename suffix) and a filter chain. The
// `null` chain means "copy the raw source through" — useful baseline for
// hearing the unfiltered TTS next to the radio-coloured variants.
const VARIANTS = [
  { name: "00-raw", chain: null },
  { name: "01-current", chain: CURRENT },
  // Simple "just louder" — bump the trailing makeup gain. Likely clips peaks.
  {
    name: "02-tail+4dB",
    chain: "highpass=f=250,lowpass=f=3500,volume=8dB,asoftclip=type=tanh,volume=-6dB,volume=6dB",
  },
  // Same +4dB tail, but caught by a brick-wall limiter at -0.5 dBFS. Loudest
  // "safe" option that doesn't change the saturation character.
  {
    name: "03-tail+4dB+limiter",
    chain:
      "highpass=f=250,lowpass=f=3500,volume=8dB,asoftclip=type=tanh,volume=-6dB,volume=6dB,alimiter=limit=0.95",
  },
  // EBU R128 single-pass loudnorm to broadcast TV target (-16 LUFS).
  // Predictable level regardless of input dynamics.
  {
    name: "04-loudnorm-16",
    chain: `${CURRENT},loudnorm=I=-16:TP=-1.5:LRA=11`,
  },
  // Hotter podcast / two-way-radio target (-12 LUFS).
  {
    name: "05-loudnorm-12",
    chain: `${CURRENT},loudnorm=I=-12:TP=-1.5:LRA=8`,
  },
  // Classic "radio compression": squash dynamics, make up gain, brick-wall.
  // No trailing +2dB; the compressor's makeup handles output level.
  {
    name: "06-comp+limiter",
    chain:
      "highpass=f=250,lowpass=f=3500,volume=8dB,asoftclip=type=tanh,volume=-6dB,acompressor=threshold=-20dB:ratio=3:attack=5:release=50:makeup=4,alimiter=limit=0.95",
  },
  // Heavier compression — punchier, more "pinned" sound.
  {
    name: "07-comp-heavy+limiter",
    chain:
      "highpass=f=250,lowpass=f=3500,volume=8dB,asoftclip=type=tanh,volume=-6dB,acompressor=threshold=-22dB:ratio=4:attack=5:release=50:makeup=8,alimiter=limit=0.95",
  },
];

function runFfmpeg(input, output, chain) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      input,
      "-af",
      chain,
      "-codec:a",
      "libmp3lame",
      "-q:a",
      "4",
      output,
    ];
    const proc = spawn(ffmpegPath, args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.trim() || "no output"}`));
    });
  });
}

async function main() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  let made = 0;
  let skipped = 0;

  for (const rel of SOURCES) {
    const src = path.join(packageRoot, rel);

    if (!existsSync(src)) {
      console.warn(`[skip] missing source ${rel}`);
      skipped++;
      continue;
    }

    const base = path.basename(rel, ".mp3");

    for (const v of VARIANTS) {
      const out = path.join(outDir, `${base}__${v.name}.mp3`);

      if (v.chain == null) {
        copyFileSync(src, out);
        console.log(`[copy] ${path.relative(repoRoot, out)}`);
      } else {
        await runFfmpeg(src, out, v.chain);
        console.log(`[ff  ] ${path.relative(repoRoot, out)}`);
      }

      made++;
    }
  }

  console.log(`\n${made} files written to ${path.relative(repoRoot, outDir)}/`);
  if (skipped > 0) console.log(`${skipped} sources skipped (missing).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
