#!/usr/bin/env node

/**
 * Radio-effect spike.
 *
 * Reads every *.mp3 in scripts/radio-effect/input/, applies each preset from
 * presets.mjs via ffmpeg-static, writes results to
 * scripts/radio-effect/output/<preset-name>/<filename>.
 *
 * Usage:
 *   node scripts/radio-effect/process.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { presets } from "./presets.mjs";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = path.join(__dirname, "input");
const OUTPUT_DIR = path.join(__dirname, "output");

function listInputFiles() {
  if (!fs.existsSync(INPUT_DIR)) return [];
  return fs
    .readdirSync(INPUT_DIR)
    .filter((f) => f.toLowerCase().endsWith(".mp3"))
    .map((f) => path.join(INPUT_DIR, f));
}

function runFfmpeg(inputPath, outputPath, filterChain) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-af",
      filterChain,
      "-codec:a",
      "libmp3lame",
      "-q:a",
      "4",
      outputPath,
    ];
    const proc = spawn(ffmpegPath, args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.trim() || "no output"}`));
    });
  });
}

async function main() {
  const files = listInputFiles();
  if (files.length === 0) {
    console.error(`No MP3 files in ${INPUT_DIR}`);
    console.error("Drop 1+ .mp3 files in that folder, then rerun.");
    process.exit(1);
  }

  console.log(`ffmpeg: ${ffmpegPath}`);
  console.log(`Input:  ${INPUT_DIR} (${files.length} file${files.length === 1 ? "" : "s"})`);
  console.log(`Output: ${OUTPUT_DIR}`);
  console.log(`Presets: ${presets.map((p) => p.name).join(", ")}`);
  console.log();

  for (const preset of presets) {
    const presetOutDir = path.join(OUTPUT_DIR, preset.name);
    fs.mkdirSync(presetOutDir, { recursive: true });
    for (const inputPath of files) {
      const outPath = path.join(presetOutDir, path.basename(inputPath));
      process.stdout.write(`[${preset.name}] ${path.basename(inputPath)} ... `);
      try {
        await runFfmpeg(inputPath, outPath, preset.filterChain);
        console.log("ok");
      } catch (err) {
        console.log(`FAILED (${err.message})`);
        process.exitCode = 1;
      }
    }
  }

  console.log();
  console.log("Done. Listen to output/<preset>/*.mp3 and report back.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
