import { execSync } from "node:child_process";

execSync("turbo run build", { stdio: "inherit" });
