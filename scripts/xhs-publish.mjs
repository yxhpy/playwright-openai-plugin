#!/usr/bin/env node

import { runXhsPublish } from '../src/xhs.js';
import { writeJson } from '../src/output.js';

const HELP = `xhs-publish

Usage:
  node scripts/xhs-publish.mjs --capabilities
  node scripts/xhs-publish.mjs --dry-run --title <title> --markdown-file <file.md> --image <media>
  node scripts/xhs-publish.mjs --inspect [--endpoint <cdp-url>] [--ports <list>]
  node scripts/xhs-publish.mjs --draft --title <title> --markdown-file <file.md> --image <media> [--topic <name>] [--visibility <mode>] [--strip-title-heading] [--endpoint <cdp-url>]
  node scripts/xhs-publish.mjs --publish --confirm-publish <exact-title> --title <title> --markdown-file <file.md> --image <media> [--endpoint <cdp-url>]

Safety:
  The default mode is --dry-run. It validates local note text and media without touching Xiaohongshu.
  --inspect opens or finds the Xiaohongshu Creator publish page and reports login/editor readiness.
  --draft uploads media, fills title/body, and stops before final publication.
  --publish clicks Publish only when --confirm-publish exactly matches --title.

Formatting:
  Supported Markdown subset: headings, paragraphs, bold, italic, strikethrough, links, ordered lists, unordered lists, and fenced text.
  Markdown image syntax is not mapped into the editor; pass display-order local media with repeated --image flags.

Settings:
  --topic <name>                         Append a Xiaohongshu topic tag; repeatable.
  --original true|false                  Toggle 原创声明.
  --content-type fiction|ai|marketing|source
  --location <query>                     Search 添加地点 and choose the first matching result.
  --visibility public|private|mutual|include|exclude
  --allow-duet true|false                Toggle 允许合拍.
  --allow-copy true|false                Toggle 允许正文复制.
  --schedule-at "YYYY-MM-DD HH:mm"        Toggle 定时发布 and fill the schedule time.
  --save-draft                           Click 暂存离开 after filling the draft.
`;

function parseArgs(argv) {
  const options = {
    title: undefined,
    markdownFile: undefined,
    images: [],
    topics: [],
    endpoint: undefined,
    ports: undefined,
    inspect: false,
    draft: false,
    publish: false,
    dryRun: false,
    confirmPublish: undefined,
    stripTitleHeading: false,
    timeoutMs: undefined,
    capabilities: false,
    original: undefined,
    contentType: undefined,
    location: undefined,
    visibility: undefined,
    allowDuet: undefined,
    allowCopy: undefined,
    scheduleAt: undefined,
    saveDraft: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--capabilities') {
      options.capabilities = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--inspect') {
      options.inspect = true;
    } else if (arg === '--draft') {
      options.draft = true;
    } else if (arg === '--publish') {
      options.publish = true;
    } else if (arg === '--confirm-publish') {
      options.confirmPublish = readValue(argv, i, arg);
      i += 1;
    } else if (arg === '--strip-title-heading') {
      options.stripTitleHeading = true;
    } else if (arg === '--title') {
      options.title = readValue(argv, i, arg);
      i += 1;
    } else if (arg === '--markdown-file') {
      options.markdownFile = readValue(argv, i, arg);
      i += 1;
    } else if (arg === '--image') {
      options.images.push(readValue(argv, i, arg));
      i += 1;
    } else if (arg === '--topic') {
      options.topics.push(readValue(argv, i, arg));
      i += 1;
    } else if (arg === '--original') {
      options.original = parseBoolean(readValue(argv, i, arg), arg);
      i += 1;
    } else if (arg === '--content-type') {
      options.contentType = readValue(argv, i, arg);
      i += 1;
    } else if (arg === '--location') {
      options.location = readValue(argv, i, arg);
      i += 1;
    } else if (arg === '--visibility') {
      options.visibility = readValue(argv, i, arg);
      i += 1;
    } else if (arg === '--allow-duet') {
      options.allowDuet = parseBoolean(readValue(argv, i, arg), arg);
      i += 1;
    } else if (arg === '--allow-copy') {
      options.allowCopy = parseBoolean(readValue(argv, i, arg), arg);
      i += 1;
    } else if (arg === '--schedule-at') {
      options.scheduleAt = readValue(argv, i, arg);
      i += 1;
    } else if (arg === '--save-draft') {
      options.saveDraft = true;
    } else if (arg === '--endpoint') {
      options.endpoint = readValue(argv, i, arg);
      i += 1;
    } else if (arg === '--ports') {
      options.ports = readValue(argv, i, arg).split(',').map((port) => port.trim()).filter(Boolean);
      i += 1;
    } else if (arg === '--timeout-ms') {
      const value = Number(readValue(argv, i, arg));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid --timeout-ms value: ${argv[i + 1]}`);
      }
      options.timeoutMs = value;
      i += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function readValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseBoolean(value, flag) {
  if (['true', '1', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
  if (['false', '0', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  throw new Error(`Invalid ${flag} value: ${value}. Expected true or false.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const result = await runXhsPublish(options);
  writeJson(result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  writeJson({
    ok: false,
    command: 'xhs publish',
    ready: false,
    diagnostics: [
      {
        category: 'cli_error',
        message: error instanceof Error ? error.message : String(error),
        next_step: 'Run `node scripts/xhs-publish.mjs --help` and retry.',
      },
    ],
  });
  process.exitCode = 1;
});
