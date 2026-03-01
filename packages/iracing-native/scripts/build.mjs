import { execSync } from "child_process";
import { existsSync } from "fs";
import { platform } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWindows = platform() === "win32";
const addonPath = join(__dirname, "..", "build", "Release", "iracing_native.node");

if (isWindows) {
  console.log("Building native addon (node-gyp rebuild)...");
  try {
    execSync("node-gyp rebuild", { stdio: "inherit" });
  } catch {
    if (existsSync(addonPath)) {
      console.warn("node-gyp rebuild failed (file may be locked by a running process). Using existing native addon.");
    } else {
      throw new Error("node-gyp rebuild failed and no existing addon found. Close any processes using the addon and retry.");
    }
  }
} else {
  console.log(`Skipping node-gyp on ${platform()} (native addon is Windows-only)`);
}

console.log("Compiling TypeScript...");
execSync("tsc", { stdio: "inherit" });
