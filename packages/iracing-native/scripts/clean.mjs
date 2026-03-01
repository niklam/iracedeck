import { execSync } from "child_process";
import { platform } from "os";

const isWindows = platform() === "win32";

if (isWindows) {
  console.log("Cleaning native addon (node-gyp clean)...");
  execSync("node-gyp clean", { stdio: "inherit" });
}

console.log("Removing dist directory...");
execSync("rimraf dist", { stdio: "inherit" });
