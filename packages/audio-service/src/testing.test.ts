import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AudioChannel, type IAudioService } from "./audio-service.js";
import { createFakeAudio } from "./testing.js";

const PACKAGES_ROOT = join(import.meta.dirname, "..", "..");

/** An import of the testing entry, static, dynamic or re-exported. */
const TESTING_IMPORT = /["']@iracedeck\/audio-service\/testing["']/;

/** True for a test, a test-support module, a test utility or anything under a `test-support` directory. */
function isTestSource(path: string): boolean {
  return /\.test\.ts$|\.test-support\.ts$|\.test-util\.ts$/.test(path) || path.split(sep).includes("test-support");
}

/** Every `.ts` file under each package's `src/`, absolute. */
function packageSources(): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);

        continue;
      }

      if (entry.name.endsWith(".ts")) found.push(full);
    }
  };

  for (const pkg of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;

    try {
      walk(join(PACKAGES_ROOT, pkg.name, "src"));
    } catch {
      // A package without a src/ directory has nothing to scan.
    }
  }

  return found;
}

/** The files among `files` that import the testing entry, relative to the packages directory. */
function testingImportersOf(files: string[]): string[] {
  return files
    .filter((file) => TESTING_IMPORT.test(readFileSync(file, "utf8")))
    .map((file) => relative(PACKAGES_ROOT, file).split(sep).join("/"));
}

describe("createFakeAudio (#1504)", () => {
  it("is an IAudioService with every member a mock", () => {
    const audio = createFakeAudio();
    const service: IAudioService = audio;

    expect(service.init()).toBe(true);
    expect(audio.init).toHaveBeenCalledTimes(1);
    expect(vi.isMockFunction(audio.setPlaybackObserver)).toBe(true);
  });

  it("records plays with loop defaulting to false, and stops", () => {
    const audio = createFakeAudio();

    expect(audio.playOnChannel(AudioChannel.Voice, "voice/a.mp3")).toBe(true);
    audio.playOnChannel(AudioChannel.Ambient, "ambient.mp3", true);
    audio.stopChannel(AudioChannel.Ambient);

    expect(audio._played).toEqual([
      { channel: AudioChannel.Voice, path: "voice/a.mp3", loop: false },
      { channel: AudioChannel.Ambient, path: "ambient.mp3", loop: true },
    ]);
    expect(audio._stopped).toEqual([AudioChannel.Ambient]);
  });

  it("fires a channel's completion once, and never after the channel was stopped", () => {
    const audio = createFakeAudio();
    const voiceDone = vi.fn();
    const sfxDone = vi.fn();

    audio.onChannelComplete(AudioChannel.Voice, voiceDone);
    audio.onChannelComplete(AudioChannel.SFX, sfxDone);
    audio.stopChannel(AudioChannel.SFX);
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);

    expect(voiceDone).toHaveBeenCalledTimes(1);
    expect(sfxDone).not.toHaveBeenCalled();
  });

  it("_reset empties the recorders and forgets completions but keeps call history", () => {
    const audio = createFakeAudio();
    const done = vi.fn();

    audio.playOnChannel(AudioChannel.Voice, "voice/a.mp3");
    audio.stopChannel(AudioChannel.SFX);
    audio.onChannelComplete(AudioChannel.Feedback, done);
    audio._reset();
    audio._triggerChannelEnd(AudioChannel.Feedback);

    expect(audio._played).toEqual([]);
    expect(audio._stopped).toEqual([]);
    expect(done).not.toHaveBeenCalled();
    expect(audio.playOnChannel).toHaveBeenCalledTimes(1);
  });

  it("takes a per-test override through the member's mock", () => {
    const audio = createFakeAudio();

    audio.isChannelPlaying.mockReturnValue(true);

    expect(audio.isChannelPlaying(AudioChannel.Voice)).toBe(true);
    expect(createFakeAudio().isChannelPlaying(AudioChannel.Voice)).toBe(false);
  });
});

describe("the testing entry stays out of production (#1504)", () => {
  it("flags an import of the testing entry (positive control)", () => {
    expect(TESTING_IMPORT.test(`import { createFakeAudio } from "@iracedeck/audio-service/testing";`)).toBe(true);
    expect(TESTING_IMPORT.test(`await import('@iracedeck/audio-service/testing')`)).toBe(true);
    expect(TESTING_IMPORT.test(`import { getAudio } from "@iracedeck/audio-service";`)).toBe(false);
    // The scan reaches the real tests that import it, so an empty production result means something.
    expect(testingImportersOf(packageSources().filter(isTestSource)).length).toBeGreaterThan(30);
  });

  it("no production source imports the testing entry", () => {
    const production = packageSources().filter((file) => !isTestSource(file));

    expect(production.length).toBeGreaterThan(500);
    expect(testingImportersOf(production)).toEqual([]);
  });
});
