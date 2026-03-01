import { execFileSync } from "child_process";
import { platform } from "os";

const isWindows = platform() === "win32";

if (isWindows) {
  console.log("Building native addon (node-gyp rebuild)...");
  execFileSync("node-gyp", ["rebuild"], { stdio: "inherit" });
} else {
  console.log(`Skipping node-gyp on ${platform()} (native addon is Windows-only)`);
}

console.log("Compiling TypeScript...");
execFileSync("npx", ["tsc"], { stdio: "inherit" });
