import { execSync } from "node:child_process";

const STREAM_DECK_EXE = "StreamDeck.exe";

function getStreamDeckPath() {
  try {
    const output = execSync(
      `wmic process where "name='${STREAM_DECK_EXE}'" get ExecutablePath`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const match = output
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.endsWith(".exe"));
    return match || null;
  } catch {
    return null;
  }
}

function stopStreamDeck() {
  try {
    execSync(`taskkill /IM ${STREAM_DECK_EXE} /F`, { stdio: "inherit" });
  } catch {
    // Process may have already exited
  }
}

function startStreamDeck(exePath) {
  execSync(`start /B "" "${exePath}"`, { shell: "cmd.exe", stdio: "ignore" });
}

const streamDeckPath = getStreamDeckPath();

if (streamDeckPath) {
  console.log("Stream Deck is running — stopping before build...");
  stopStreamDeck();
}

try {
  execSync("turbo run build", { stdio: "inherit" });
} finally {
  if (streamDeckPath) {
    console.log("Restarting Stream Deck...");
    startStreamDeck(streamDeckPath);
  }
}
