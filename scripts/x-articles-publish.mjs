#!/usr/bin/env node

import { runXArticlesCapabilities, runXArticlesPublish } from '../src/x-articles.js';
import { writeJson } from '../src/output.js';

const HELP = `x-articles-publish

Usage:
  node scripts/x-articles-publish.mjs --dry-run --title <title> --markdown-file <file.md>
  node scripts/x-articles-publish.mjs --inspect [--endpoint <cdp-url>] [--ports <list>]
  node scripts/x-articles-publish.mjs --capabilities [--endpoint <cdp-url>] [--ports <list>]
  node scripts/x-articles-publish.mjs --draft --title <title> --markdown-file <file.md> [--strip-title-heading] [--validate-preview] [--endpoint <cdp-url>]
  node scripts/x-articles-publish.mjs --publish --confirm-publish <exact-title> --title <title> --markdown-file <file.md> [--endpoint <cdp-url>]

Safety:
  The default mode is --dry-run. It validates and converts local Markdown without touching X.
  --inspect opens or finds https://x.com/compose/articles and reports login/editor readiness.
  --capabilities probes currently visible X Article editor controls without publishing.
  --draft fills the visible X Article composer and stops before final publication.
  --validate-preview opens X's preview page after draft fill, verifies visible title/body text, then returns to the editor.
  --publish clicks Publish only when --confirm-publish exactly matches --title.

Formatting:
  Supported Markdown subset: headings, paragraphs, blockquotes, bold, italic, strikethrough, links, ordered lists, unordered lists, standalone local Markdown images, native dividers, native fenced code blocks, native LaTeX blocks, native X post embeds (status URL only), native GIF inserts, and emoji text.
  Remote Markdown image URLs are rejected; download images locally or place them manually during visible review.
`;

function parseArgs(argv) {
  const options = {
    title: undefined,
    markdownFile: undefined,
    endpoint: undefined,
    ports: undefined,
    inspect: false,
    draft: false,
    publish: false,
    capabilities: false,
    dryRun: false,
    confirmPublish: undefined,
    stripTitleHeading: false,
    validatePreview: false,
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
    } else if (arg === '--capabilities') {
      options.capabilities = true;
    } else if (arg === '--draft') {
      options.draft = true;
    } else if (arg === '--publish') {
      options.publish = true;
    } else if (arg === '--confirm-publish') {
      options.confirmPublish = readValue(argv, i, arg);
      i += 1;
    } else if (arg === '--strip-title-heading') {
      options.stripTitleHeading = true;
    } else if (arg === '--validate-preview') {
      options.validatePreview = true;
    } else if (arg === '--title') {
      options.title = readValue(argv, i, arg);
      i += 1;
    } else if (arg === '--markdown-file') {
      options.markdownFile = readValue(argv, i, arg);
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
  const result = options.capabilities
    ? await runXArticlesCapabilities(options)
    : await runXArticlesPublish(options);
  writeJson(result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  writeJson({
    ok: false,
    command: 'x articles publish',
    ready: false,
    diagnostics: [
      {
        category: 'cli_error',
        message: error instanceof Error ? error.message : String(error),
        next_step: 'Run `node scripts/x-articles-publish.mjs --help` and retry.',
      },
    ],
  });
  process.exitCode = 1;
});
