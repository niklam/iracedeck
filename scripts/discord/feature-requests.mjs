#!/usr/bin/env node
/**
 * Maintainer CLI for the Discord feature-requests forum (#1114): list posts,
 * read one, reply into it, set its status tag, and compute which posts lag
 * behind their GitHub issues. Used by the `discord-feature-requests` skill;
 * every write here is one the maintainer has approved in that session.
 *
 * Reads DISCORD_BOT_TOKEN, DISCORD_GUILD_ID and
 * DISCORD_FEATURE_REQUESTS_CHANNEL_ID from the shell or the gitignored
 * .env.local at the repo root (see .env.local.example).
 *
 * The behaviour lives in lib/discord-forum-commands.mjs; this file is argv.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createDiscordClient } from "../lib/discord-api.mjs";
import { readConfig, runFollowUp, runList, runReply, runShow, runTag } from "../lib/discord-forum-commands.mjs";

const USAGE = `Usage: node scripts/discord/feature-requests.mjs <command> [options]

Commands
  list [--untagged]              every post, newest first (--untagged: no status tag yet)
  show <post-id>                 the post, its replies, votes and author
  reply <post-id> --text "…"     post a reply into the thread (or --file <path>)
  tag <post-id> "<status tag>"   set Will Add | In progress | Completed | Released | Won't do
  follow-up                      Discord-sourced issues vs their posts' status tags

Options
  --json      machine-readable output (list, show, follow-up)
  --dry-run   print the request and send nothing (reply, tag)
  -h, --help  this text`;

const POST_ID = /^\d{17,20}$/;
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function exec(file, args) {
  // gh and git never need the bot token. readConfig reads .env.local into a
  // COPY of the environment, so the only way it can be here is a shell
  // export — scrubbed all the same; an undefined value drops the key from
  // the child's environment rather than passing it on empty.
  return execFileSync(file, args, {
    encoding: "utf8",
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, DISCORD_BOT_TOKEN: undefined },
  });
}

function requirePostId(id) {
  if (!id || !POST_ID.test(id)) {
    console.error(`Error: a post id is required (a 17–20 digit Discord id), got "${id ?? ""}".`);

    return false;
  }

  return true;
}

async function main(command, positionals, values) {
  const config = readConfig(root);

  if (config.error) {
    console.error(`Error: ${config.error}`);

    return 1;
  }

  const deps = { config, client: createDiscordClient({ token: config.token }), log: console, exec };
  const [postId, ...rest] = positionals;

  try {
    switch (command) {
      case "list":
        return await runList({ untagged: values.untagged, json: values.json }, deps);
      case "show":
        return requirePostId(postId) ? await runShow({ postId, json: values.json }, deps) : 1;
      case "reply": {
        if (!requirePostId(postId)) return 1;

        const text = values.file ? readFileSync(values.file, "utf8") : values.text;

        return await runReply({ postId, text, dryRun: values["dry-run"] }, deps);
      }
      case "tag":
        return requirePostId(postId) ? await runTag({ postId, tagName: rest.join(" "), dryRun: values["dry-run"] }, deps) : 1;
      case "follow-up":
        return await runFollowUp({ json: values.json }, deps);
      default:
        console.error(`Unknown command "${command}".\n\n${USAGE}`);

        return 1;
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);

    return 1;
  }
}

let cli = null;

try {
  cli = parseArgs({
    allowPositionals: true,
    options: {
      untagged: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      text: { type: "string" },
      file: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (error) {
  // Strict parsing: an unknown option or a value-less --text is a usage
  // error, not a stack trace.
  console.error(`Error: ${error.message}\n\n${USAGE}`);
  process.exitCode = 1;
}

if (cli) {
  const { values, positionals } = cli;
  const [command, ...args] = positionals;

  if (values.help || !command) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
  } else {
    process.exitCode = await main(command, args, values);
  }
}
