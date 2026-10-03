import { execSync } from "child_process";
import { platform } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { releaseNativeAddon } from "../../../scripts/lib/native-addon-build.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWindows = platform() === "win32";
const packageDir = join(__dirname, "..");

if (isWindows) {
  // A running deck host has the .node loaded, which node-gyp's clean step
  // cannot delete; move it aside first so the rebuild always produces a fresh
  // binary (#1258). Any failure of the rebuild itself fails the build.
  releaseNativeAddon({
    addonPath: join(packageDir, "build", "Release", "audio_native.node"),
    asideDir: join(packageDir, ".locked-native"),
  });
  console.log("Building native addon (node-gyp rebuild)...");
  execSync("node-gyp rebuild", { stdio: "inherit" });
} else {
  console.log(`Skipping node-gyp on ${platform()} (native addon is Windows-only)`);
}

console.log("Compiling TypeScript...");
execSync("tsc", { stdio: "inherit" });
