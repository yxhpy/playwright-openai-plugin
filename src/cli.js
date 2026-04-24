#!/usr/bin/env node

import { runStatus } from './status.js';
import { runBrowserLaunch, runBrowserStop } from './browser.js';
import { runDiscover } from './discover.js';
import {
  runChatCollect,
  runChatJobsCleanup,
  runChatJobsList,
  runChatSend,
  runChatSubmit,
  runChatWait,
} from './chat.js';
import {
  runImageCollect,
  runImageInspect,
  runImageJobsCleanup,
  runImageJobsList,
  runImageRevise,
  runImageSend,
  runImageSubmit,
  runImageWait,
} from './images.js';
import { runActionPackCreate } from './action-pack.js';
import { writeJson, writeText } from './output.js';

const HELP = `playwright-openai

Usage:
  poai status [--json] [--text] [--endpoint <url>] [--ports <list>] [--timeout-ms <ms>]
  poai discover [--json] [--text] [--endpoint <url>] [--ports <list>] [--timeout-ms <ms>]
  poai chat send --prompt <text> [--model <auto|pro|thinking|instant|label>] [--json] [--text] [--endpoint <url>] [--timeout-ms <ms>]
  poai chat submit --prompt <text> [--file <path>] [--model <auto|pro|thinking|instant|label>] [--json] [--text] [--endpoint <url>]
  poai chat wait --job-id <id> [--json] [--text] [--timeout-ms <ms>]
  poai chat collect --job-id <id> [--json] [--text]
  poai chat jobs list [--json] [--text] [--status <status>] [--limit <n>]
  poai chat jobs cleanup [--json] [--text] [--status <status>] [--limit <n>] [--yes]
  poai image send --prompt <text> [--file <path>] [--model <auto|instant|thinking|light|low|medium|high|extended|heavy|xhigh|standard|advanced|label>] [--output-dir <path>] [--max-artifacts <n>] [--json] [--text] [--endpoint <url>] [--timeout-ms <ms>]
  poai image submit --prompt <text> [--file <path>] [--model <auto|instant|thinking|light|low|medium|high|extended|heavy|xhigh|standard|advanced|label>] [--json] [--text] [--endpoint <url>]
  poai image revise --job-id <id> --prompt <text> [--file <path>] [--model <auto|instant|thinking|light|low|medium|high|extended|heavy|xhigh|label>] [--json] [--text]
  poai image inspect --job-id <id> [--json] [--text]
  poai image wait --job-id <id> [--json] [--text] [--timeout-ms <ms>]
  poai image collect --job-id <id> [--output-dir <path>] [--max-artifacts <n>] [--json] [--text]
  poai image jobs list [--json] [--text] [--status <status>] [--limit <n>]
  poai image jobs cleanup [--json] [--text] [--status <status>] [--limit <n>] [--yes]
  poai action-pack create [--character <text> | --from-dir <path>] [--actions <list>] [--file <path>] [--model <auto|instant|thinking|light|low|medium|high|extended|heavy|xhigh|label>] [--output-dir <path>] [--name <name>] [--grid <CxR>] [--frames-per-action <n>] [--frame-size <WxH>] [--background <auto|none|#rrggbb>] [--tolerance <n>] [--qa <strict|warn|off>] [--regen-failed] [--regen-attempts <n>] [--delay-ms <ms>] [--json] [--text] [--timeout-ms <ms>]
  poai browser launch [--json] [--text] [--port <n>] [--profile-dir <path>] [--chrome-path <path>] [--url <url>] [--headless]
  poai browser stop [--json] [--text]

Environment:
  OPENAI_BROWSER_CDP_URL  Preferred Chrome DevTools Protocol endpoint.

Commands:
  status                  Inspect local browser/CDP readiness without reading session secrets.
  discover                Read safe page-state and capability signals from OpenAI pages.
  chat send               Submit a prompt and collect the latest assistant response in one command.
  chat submit             Select a model, submit a prompt, optionally attach one file, and create a resumable job.
  chat wait               Wait for a submitted job to finish.
  chat collect            Collect the latest assistant response for a job.
  chat jobs list          List non-secret local chat job metadata.
  chat jobs cleanup       Preview or delete selected local chat job metadata.
  image send              Route by image prompt difficulty by default, optionally attach one image, submit, wait, and collect generated image artifacts.
  image submit            Route by image prompt difficulty by default, optionally attach one image, submit a prompt, and create a resumable job.
  image revise            Continue an existing image job conversation with a new prompt and optional replacement reference image.
  image inspect           Read-only status for an image job: page, generation, artifacts, and next action.
  image wait              Wait for generated image artifacts to appear.
  image collect           Download generated image artifacts for a job.
  image jobs list         List non-secret local image job metadata.
  image jobs cleanup      Preview or delete selected local image job metadata.
  action-pack create      Generate or package action sprite sheets into frames, atlas, GIF, manifest, and zip.
  browser launch          Start a managed Chrome profile with a standard CDP endpoint.
  browser stop            Stop the managed Chrome process launched by this CLI.
`;

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'status';
  const subcommand = (command === 'browser' || command === 'chat' || command === 'image' || command === 'action-pack') && args[0] && !args[0].startsWith('-') ? args.shift() : undefined;
  const action = (command === 'chat' || command === 'image') && subcommand === 'jobs' && args[0] && !args[0].startsWith('-') ? args.shift() : undefined;
  const options = {
    format: 'json',
    endpoint: undefined,
    ports: undefined,
    port: undefined,
    profileDir: undefined,
    chromePath: undefined,
    url: undefined,
    prompt: undefined,
    model: undefined,
    filePath: undefined,
    outputDir: undefined,
    jobId: undefined,
    jobStatus: undefined,
    limit: undefined,
    maxArtifacts: undefined,
    actions: undefined,
    character: undefined,
    fromDir: undefined,
    name: undefined,
    grid: undefined,
    framesPerAction: undefined,
    frameSize: undefined,
    background: undefined,
    backgroundTolerance: undefined,
    qaMode: undefined,
    regenFailed: false,
    regenAttempts: undefined,
    delayMs: undefined,
    yes: false,
    headless: false,
    timeoutMs: undefined,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      options.format = 'json';
    } else if (arg === '--text') {
      options.format = 'text';
    } else if (arg === '--endpoint') {
      options.endpoint = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--ports') {
      options.ports = readValue(args, i, arg)
        .split(',')
        .map((port) => port.trim())
        .filter(Boolean);
      i += 1;
    } else if (arg === '--port') {
      options.port = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--profile-dir') {
      options.profileDir = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--chrome-path') {
      options.chromePath = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--url') {
      options.url = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--prompt') {
      options.prompt = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--model') {
      options.model = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--file') {
      if (options.filePath !== undefined) {
        throw new Error('Only one --file is supported.');
      }
      options.filePath = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--output-dir') {
      options.outputDir = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--actions') {
      options.actions = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--character') {
      options.character = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--from-dir') {
      options.fromDir = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--name') {
      options.name = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--grid') {
      options.grid = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--frames-per-action') {
      const value = Number(readValue(args, i, arg));
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid --frames-per-action value: ${args[i + 1]}`);
      }
      options.framesPerAction = value;
      i += 1;
    } else if (arg === '--frame-size') {
      options.frameSize = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--background') {
      options.background = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--tolerance') {
      const value = Number(readValue(args, i, arg));
      if (!Number.isFinite(value) || value < 0 || value > 255) {
        throw new Error(`Invalid --tolerance value: ${args[i + 1]}`);
      }
      options.backgroundTolerance = value;
      i += 1;
    } else if (arg === '--qa') {
      options.qaMode = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--regen-failed') {
      options.regenFailed = true;
    } else if (arg === '--regen-attempts') {
      const value = Number(readValue(args, i, arg));
      if (!Number.isInteger(value) || value < 0 || value > 5) {
        throw new Error(`Invalid --regen-attempts value: ${args[i + 1]}`);
      }
      options.regenAttempts = value;
      i += 1;
    } else if (arg === '--delay-ms') {
      const value = Number(readValue(args, i, arg));
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid --delay-ms value: ${args[i + 1]}`);
      }
      options.delayMs = value;
      i += 1;
    } else if (arg === '--job-id') {
      options.jobId = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--status') {
      options.jobStatus = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--limit') {
      const value = Number(readValue(args, i, arg));
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid --limit value: ${args[i + 1]}`);
      }
      options.limit = value;
      i += 1;
    } else if (arg === '--max-artifacts') {
      const value = Number(readValue(args, i, arg));
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid --max-artifacts value: ${args[i + 1]}`);
      }
      options.maxArtifacts = value;
      i += 1;
    } else if (arg === '--yes') {
      options.yes = true;
    } else if (arg === '--headless') {
      options.headless = true;
    } else if (arg === '--timeout-ms') {
      const value = Number(readValue(args, i, arg));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid --timeout-ms value: ${args[i + 1]}`);
      }
      options.timeoutMs = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { command, subcommand, action, options };
}

function readValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

async function main() {
  const { command, subcommand, action, options } = parseArgs(process.argv.slice(2));
  if (options.help || command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  const result = await dispatch(command, subcommand, action, options);
  if (options.format === 'text') {
    writeText(result);
  } else {
    writeJson(result);
  }
}

async function dispatch(command, subcommand, action, options) {
  if (command === 'status') {
    return runStatus(options);
  }
  if (command === 'discover') {
    return runDiscover(options);
  }
  if (command === 'chat' && subcommand === 'send') {
    return runChatSend(options);
  }
  if (command === 'chat' && subcommand === 'submit') {
    return runChatSubmit(options);
  }
  if (command === 'chat' && subcommand === 'wait') {
    return runChatWait(options);
  }
  if (command === 'chat' && subcommand === 'collect') {
    return runChatCollect(options);
  }
  if (command === 'chat' && subcommand === 'jobs' && action === 'list') {
    return runChatJobsList(options);
  }
  if (command === 'chat' && subcommand === 'jobs' && action === 'cleanup') {
    return runChatJobsCleanup(options);
  }
  if (command === 'chat' && subcommand === 'jobs') {
    throw new Error(`Unknown chat jobs action: ${action ?? '(missing)'}`);
  }
  if (command === 'chat') {
    throw new Error(`Unknown chat subcommand: ${subcommand ?? '(missing)'}`);
  }
  if (command === 'image' && subcommand === 'send') {
    return runImageSend(options);
  }
  if (command === 'image' && subcommand === 'submit') {
    return runImageSubmit(options);
  }
  if (command === 'image' && subcommand === 'revise') {
    return runImageRevise(options);
  }
  if (command === 'image' && subcommand === 'inspect') {
    return runImageInspect(options);
  }
  if (command === 'image' && subcommand === 'wait') {
    return runImageWait(options);
  }
  if (command === 'image' && subcommand === 'collect') {
    return runImageCollect(options);
  }
  if (command === 'image' && subcommand === 'jobs' && action === 'list') {
    return runImageJobsList(options);
  }
  if (command === 'image' && subcommand === 'jobs' && action === 'cleanup') {
    return runImageJobsCleanup(options);
  }
  if (command === 'image' && subcommand === 'jobs') {
    throw new Error(`Unknown image jobs action: ${action ?? '(missing)'}`);
  }
  if (command === 'image') {
    throw new Error(`Unknown image subcommand: ${subcommand ?? '(missing)'}`);
  }
  if (command === 'action-pack' && subcommand === 'create') {
    return runActionPackCreate(options);
  }
  if (command === 'action-pack') {
    throw new Error(`Unknown action-pack subcommand: ${subcommand ?? '(missing)'}`);
  }
  if (command === 'browser' && subcommand === 'launch') {
    return runBrowserLaunch(options);
  }
  if (command === 'browser' && subcommand === 'stop') {
    return runBrowserStop(options);
  }
  if (command === 'browser') {
    throw new Error(`Unknown browser subcommand: ${subcommand ?? '(missing)'}`);
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  writeJson({
    ok: false,
    command: 'unknown',
    ready: false,
    diagnostics: [
      {
        category: 'cli_error',
        message: error instanceof Error ? error.message : String(error),
        next_step: 'Run `poai --help` and retry with a supported command.',
      },
    ],
  });
  process.exitCode = 1;
});
