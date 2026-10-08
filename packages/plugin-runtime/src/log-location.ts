import type { LogLocation } from "@iracedeck/app-constants";
import type { IDeckPlatformAdapter } from "@iracedeck/deck-core";
import { dirname, join } from "node:path";

/**
 * The adapter's log location, which the watchdog (#1330) and the CPU-profile
 * folder (#1338) need. Every shell builds its adapter with one; only a test or
 * the harness builds one without, and neither starts a plugin.
 */
export function requireLogLocation(adapter: IDeckPlatformAdapter): LogLocation {
  const location = adapter.logLocation;

  if (location === undefined) {
    throw new Error("startPlugin needs an adapter that writes a log file: construct it with a log directory");
  }

  return location;
}

/** Where CPU profiles go: `profiles` beside the log the user already sends from (#1338). */
export function profilesDirFor(location: LogLocation): string {
  return location.kind === "file" ? join(dirname(location.path), "profiles") : join(location.dir, "profiles");
}
