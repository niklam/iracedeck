#!/usr/bin/env node
/**
 * CLI tool to take a snapshot of current iRacing telemetry
 *
 * Usage:
 *   npx telemetry-snapshot [options]
 *
 * Options:
 *   --format=json|keyvalue  Output format (default: json)
 *   --output=<file>         Write to file instead of stdout
 *   --output-dir=<dir>      Write to dir with auto-generated timestamped filename
 *   --include-session       Include session info in output
 *   --vars=<var1,var2,...>  Only include specific variables
 *   --help                  Show help
 */
import { consoleLogger, silentLogger } from "@iracedeck/logger";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createSDK } from "../factory.js";
import { buildSnapshotEnvelope, generateMarkdown, snapshotBaseName } from "../snapshot.js";

interface CliOptions {
  format: "json" | "keyvalue";
  output: string | null;
  outputDir: string | null;
  includeSession: boolean;
  vars: string[] | null;
  help: boolean;
  verbose: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    format: "json",
    output: null,
    outputDir: null,
    includeSession: false,
    vars: null,
    help: false,
    verbose: false,
  };

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--include-session") {
      options.includeSession = true;
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg.startsWith("--format=")) {
      const format = arg.slice("--format=".length);

      if (format === "json" || format === "keyvalue") {
        options.format = format;
      } else {
        console.error(`Invalid format: ${format}. Use 'json' or 'keyvalue'.`);
        process.exit(1);
      }
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else if (arg.startsWith("--vars=")) {
      options.vars = arg
        .slice("--vars=".length)
        .split(",")
        .map((v) => v.trim());
    }
  }

  return options;
}

function showHelp(): void {
  console.log(`
iRacing Telemetry Snapshot

Takes a snapshot of current iRacing telemetry data.

Usage:
  npx @iracedeck/iracing-sdk telemetry-snapshot [options]
  pnpm telemetry-snapshot [options]

Options:
  --format=json|keyvalue  Output format (default: json)
  --output=<file>         Write to file instead of stdout
  --output-dir=<dir>      Write to dir with timestamped filename
  --include-session       Include session info in output
  --vars=<var1,var2,...>  Only include specific variables
  --verbose, -v           Show connection info
  --help, -h              Show this help

Examples:
  # Output all telemetry as JSON
  pnpm telemetry-snapshot

  # Output as key=value pairs
  pnpm telemetry-snapshot --format=keyvalue

  # Save to file
  pnpm telemetry-snapshot --output=snapshot.json

  # Only specific variables
  pnpm telemetry-snapshot --vars=Speed,Gear,RPM,FuelLevel

  # Include session info
  pnpm telemetry-snapshot --include-session --output=full-snapshot.json
`);
}

function formatKeyValue(data: Record<string, unknown>, prefix = ""): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (value === null || value === undefined) {
      lines.push(`${fullKey}=null`);
    } else if (Array.isArray(value)) {
      // Format arrays inline for simple values
      if (value.length <= 10 && value.every((v) => typeof v !== "object")) {
        lines.push(`${fullKey}=[${value.join(", ")}]`);
      } else {
        // For long arrays, show each element
        for (let i = 0; i < value.length; i++) {
          const item = value[i];

          if (typeof item === "object" && item !== null) {
            lines.push(formatKeyValue(item as Record<string, unknown>, `${fullKey}[${i}]`));
          } else {
            lines.push(`${fullKey}[${i}]=${item}`);
          }
        }
      }
    } else if (typeof value === "object") {
      lines.push(formatKeyValue(value as Record<string, unknown>, fullKey));
    } else {
      lines.push(`${fullKey}=${value}`);
    }
  }

  return lines.join("\n");
}

function filterVars(data: Record<string, unknown>, vars: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const varName of vars) {
    if (varName in data) {
      result[varName] = data[varName];
    }
  }

  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  const logger = options.verbose ? consoleLogger : silentLogger;
  const { sdk } = createSDK(logger);

  if (options.verbose) {
    console.error("Connecting to iRacing...");
  }

  if (!sdk.connect()) {
    console.error("Error: Could not connect to iRacing. Is iRacing running?");
    process.exit(1);
  }

  if (options.verbose) {
    console.error("Connected. Reading telemetry...");
  }

  // Get telemetry with retry (waitForData may return null if no new frame is ready)
  let telemetry = null;
  const maxRetries = 10;
  const retryDelayMs = 50;

  for (let i = 0; i < maxRetries; i++) {
    telemetry = sdk.getTelemetry();

    if (telemetry) {
      break;
    }

    if (options.verbose) {
      console.error(`Waiting for telemetry data (attempt ${i + 1}/${maxRetries})...`);
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  if (!telemetry) {
    console.error("Error: Could not read telemetry data after multiple attempts.");
    sdk.disconnect();
    process.exit(1);
  }

  // Filter variables if specified
  if (options.vars) {
    telemetry = filterVars(telemetry, options.vars) as typeof telemetry;
  }

  // Always read session info (needed for markdown driver names)
  const sessionInfo = sdk.getSessionInfo() ?? null;

  // Build output object
  const output = buildSnapshotEnvelope(
    telemetry as unknown as Record<string, unknown>,
    sessionInfo as Record<string, unknown> | null,
    options.includeSession,
  );

  // Disconnect
  sdk.disconnect();

  // Format output
  let result: string;

  if (options.format === "json") {
    result = JSON.stringify(output, null, 2);
  } else {
    result = formatKeyValue(output as unknown as Record<string, unknown>);
  }

  // Resolve output path
  let outputPath: string | null = null;

  if (options.output) {
    outputPath = resolve(process.env.INIT_CWD || process.cwd(), options.output);
  } else if (options.outputDir) {
    const ext = options.format === "json" ? "json" : "txt";
    const baseDir = resolve(process.env.INIT_CWD || process.cwd(), options.outputDir);
    mkdirSync(baseDir, { recursive: true });
    outputPath = join(baseDir, `${snapshotBaseName()}.${ext}`);
  }

  // Generate markdown
  const markdown = generateMarkdown(
    telemetry as unknown as Record<string, unknown>,
    sessionInfo as Record<string, unknown> | null,
  );

  // Output
  if (outputPath) {
    writeFileSync(outputPath, result, "utf-8");
    console.error(`Snapshot saved to: ${outputPath}`);

    const mdPath = outputPath.replace(/\.[^.]+$/, ".md");
    writeFileSync(mdPath, markdown, "utf-8");
    console.error(`Markdown saved to: ${mdPath}`);
  } else {
    console.log(result);
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
