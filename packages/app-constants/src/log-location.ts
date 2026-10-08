/**
 * Where a host's own plugin log lives (#1349): one fixed file (Elgato) or a
 * directory of per-day files (Mirabox, Ulanzi `FileSink`). The deck adapter
 * contract reports one (`IDeckPlatformAdapter.logLocation`), and
 * `@iracedeck/diagnostics`' main-thread watchdog appends its reports to the same
 * place (`WatchdogLogTarget` is this type), so it lives below both (#1367).
 */
export type LogLocation =
  /** One fixed file (Elgato: `<cwd>/logs/<plugin UUID>.0.log`). */
  | { kind: "file"; path: string }
  /** A directory whose file is `watchdogDailyLogFileName(now)`, computed per write (Mirabox, Ulanzi `FileSink`). */
  | { kind: "daily"; dir: string };
