import { execSync } from "child_process";
import { existsSync } from "fs";
import { platform } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWindows = platform() === "win32";
const addonPath = join(__dirname, "..", "build", "Release", "audio_native.node");

if (isWindows) {
  console.log("Building native addon (node-gyp rebuild)...");
  try {
    execSync("node-gyp rebuild", { stdio: "inherit" });
  } catch (error) {
    // Only treat as recoverable when Windows reports the .node file is locked
    // (Stream Deck / dev plugin holding the DLL). Everything else (compiler
    // errors, missing toolchain, bad gyp config, …) must surface so real
    // build regressions aren't silently papered over.
    const err = /** @type {NodeJS.ErrnoException} */ (error);
    const message = String(err?.message ?? "");
    const isLockOrPermissionError =
      err?.code === "EBUSY" ||
      err?.code === "EPERM" ||
      /in use by another process|being used by another process|permission denied/i.test(message);

    if (isLockOrPermissionError && existsSync(addonPath)) {
      console.warn("node-gyp rebuild failed (file may be locked by a running process). Using existing native addon.");
    } else {
      throw error;
    }
  }
} else {
  console.log(`Skipping node-gyp on ${platform()} (native addon is Windows-only)`);
}

console.log("Compiling TypeScript...");
execSync("tsc", { stdio: "inherit" });
