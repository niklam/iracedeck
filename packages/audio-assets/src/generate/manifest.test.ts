import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadManifest, type Manifest, saveManifest } from "./manifest.ts";

// A write that fails part-way, as ENOSPC does: the destination is opened (so
// truncated) and left holding a fragment, then the call throws.
const fsHook = vi.hoisted(() => ({ failsAt: null as ((destination: string) => boolean) | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
    if (typeof file === "string" && fsHook.failsAt?.(file)) {
      actual.writeFileSync(file, "{ partial");
      throw Object.assign(new Error(`ENOSPC: no space left on device, write '${file}'`), { code: "ENOSPC" });
    }

    actual.writeFileSync(file, data, options);
  };

  return { ...actual, default: { ...actual, writeFileSync }, writeFileSync };
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-manifest-"));
  fsHook.failsAt = null;
});

afterEach(() => {
  fsHook.failsAt = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

const row = (hash: string): Manifest["entries"][string] => ({
  hash,
  voiceId: "v",
  model: "eleven_v4",
  textPreview: "t",
  generatedAt: "2026-11-16T00:00:00.000Z",
  requestId: `req-${hash}`,
});

describe("saveManifest (#1643)", () => {
  it("writes the manifest so loadManifest reads it back, two-space JSON with a trailing newline, no temp file left", () => {
    const file = path.join(dir, "generate.manifest.json");
    const manifest: Manifest = { version: 1, entries: { "voice/default/g/x.mp3": row("a") } };

    saveManifest(file, manifest);

    expect(loadManifest(file)).toEqual(manifest);
    expect(fs.readFileSync(file, "utf-8")).toBe(JSON.stringify(manifest, null, 2) + "\n");
    expect(fs.readdirSync(dir)).toEqual(["generate.manifest.json"]);
  });

  it("replaces an existing manifest whole", () => {
    const file = path.join(dir, "generate.manifest.json");

    saveManifest(file, { version: 1, entries: { "voice/default/g/x.mp3": row("a") } });
    saveManifest(file, { version: 1, entries: { "voice/default/g/y.mp3": row("b") } });

    expect(Object.keys(loadManifest(file).entries)).toEqual(["voice/default/g/y.mp3"]);
  });

  it("leaves the previous manifest intact when a write fails part-way, and removes its temp file", () => {
    const file = path.join(dir, "generate.manifest.json");
    const previous: Manifest = { version: 1, entries: { "voice/default/g/x.mp3": row("a") } };

    saveManifest(file, previous);
    // Every write fails part-way, wherever it lands: the manifest's own path
    // (a direct write) or a temp file beside it.
    fsHook.failsAt = (destination) => path.dirname(destination) === dir;

    expect(() => saveManifest(file, { version: 1, entries: { "voice/default/g/y.mp3": row("b") } })).toThrow(/ENOSPC/);
    expect(loadManifest(file)).toEqual(previous);
    expect(fs.readdirSync(dir)).toEqual(["generate.manifest.json"]);
  });
});
