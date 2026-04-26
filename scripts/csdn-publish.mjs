#!/usr/bin/env node

import { runCsdnPublish } from '../src/csdn.js';
import { writeJson } from '../src/output.js';

const HELP = `csdn-publish

Usage:
  node scripts/csdn-publish.mjs --dry-run --title <title> --markdown-file <file.md> [--image key=path] [--cover path]
  node scripts/csdn-publish.mjs --inspect [--endpoint <cdp-url>] [--ports <list>]
  node scripts/csdn-publish.mjs --draft --title <title> --markdown-file <file.md> [--image key=path] [--cover path] [--summary <text>] [--tag <tag>] [--category <name>] [--article-type <original|repost|translated>] [--source-url <url>] [--visibility <public|private|fans|vip>]
  node scripts/csdn-publish.mjs --publish --confirm-publish <exact-title> --title <title> --markdown-file <file.md> [--image key=path] [--cover path] [--summary <text>] [--tag <tag>] [--category <name>] [--article-type <original|repost|translated>] [--source-url <url>] [--visibility <public|private|fans|vip>]

Article image placeholders:
  Write {{csdn:image:hero}} in Markdown, then pass --image hero=/absolute/or/relative/hero.png.
  The script uploads that image through the CSDN editor at the placeholder position.

Safety:
  The default mode is --dry-run. It validates local article format and files without touching CSDN.
  --draft fills the visible CSDN editor and opens publish settings without final confirmation.
  --publish clicks the final CSDN publish button only when --confirm-publish exactly matches --title.
`;

function parseArgs(argv) {
  const options = {
    title: undefined,
    markdownFile: undefined,
    cover: undefined,
    images: [],
    tags: [],
    category: undefined,
    summary: undefined,
    articleType: undefined,
    sourceUrl: undefined,
    visibility: undefined,
    endpoint: undefined,
    ports: undefined,
    inspect: false,
    draft: false,
    publish: false,
    confirmPublish: undefined,
    stripTitleHeading: false,
    timeoutMs: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
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
    } else if (arg === '--cover') {
      options.cover = readValue(argv, i, arg);
      i += 1;
    } else if (arg === '--image') {
      options.images.push(readValue(argv, i, arg));
      i += 1;
    } else if (arg === '--tag') {
      options.tags.push(readValue(argv, i, arg));
      i += 1;
    } else if (arg === '--tags') {
      options.tags.push(...readValue(argv, i, arg).split(',').map((tag) => tag.trim()).filter(Boolean));
      i += 1;
    } else if (arg === '--category') {
      options.category = readValue(argv, i, arg);
      i += 1;
    } else if (arg === '--summary') {
      options.summary = readValue(argv, i, arg);
      i += 1;
    } else if (arg === '--article-type') {
      options.articleType = readValue(argv, i, arg);
      i += 1;
    } else if (arg === '--source-url') {
      options.sourceUrl = readValue(argv, i, arg);
      i += 1;
    } else if (arg === '--visibility') {
      options.visibility = readValue(argv, i, arg);
      i += 1;
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const result = await runCsdnPublish(options);
  writeJson(result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  writeJson({
    ok: false,
    command: 'csdn publish',
    ready: false,
    diagnostics: [
      {
        category: 'cli_error',
        message: error instanceof Error ? error.message : String(error),
        next_step: 'Run `node scripts/csdn-publish.mjs --help` and retry.',
      },
    ],
  });
  process.exitCode = 1;
});
