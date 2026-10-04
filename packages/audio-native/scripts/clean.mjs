import { execSync } from "child_process";
import { platform } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { releasePackageAddon } from "../../../scripts/lib/native-addon-build.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWindows = platform() === "win32";

if (isWindows) {
  // node-gyp clean fails on a .node a running deck host has loaded; move it aside first (#1258).
  releasePackageAddon(join(__dirname, ".."), "audio_native.node");
  console.log("Cleaning native addon (node-gyp clean)...");
  execSync("node-gyp clean", { stdio: "inherit" });
}

console.log("Removing dist directory...");
execSync("rimraf dist", { stdio: "inherit" });
