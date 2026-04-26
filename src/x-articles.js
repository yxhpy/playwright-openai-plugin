import { constants, existsSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { buildCandidateEndpoints } from './status.js';

const X_ARTICLE_COMPOSE_URL = 'https://x.com/compose/articles';
const X_HOSTS = new Set(['x.com', 'twitter.com']);
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const MARKDOWN_IMAGE_LINE_RE = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
const SUPPORTED_ARTICLE_IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']);
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
const TITLE_SELECTORS = [
  'textarea[placeholder="添加标题"]',
  'textarea[placeholder*="标题"]',
  'textarea[placeholder*="Title" i]',
  'input[placeholder*="Title" i]',
  '[contenteditable="true"][aria-label*="Title" i]',
  '[data-testid*="title" i] [contenteditable="true"]',
  '[role="textbox"][aria-label*="Title" i]',
];
const BODY_SELECTORS = [
  '[data-testid="composer"][contenteditable="true"]',
  '[data-testid="articleBody"] [contenteditable="true"]',
  '[data-testid*="article" i] [contenteditable="true"]',
  'main [contenteditable="true"][role="textbox"]',
  'main [contenteditable="true"]',
  '[role="textbox"][contenteditable="true"]',
  '[contenteditable="true"]',
  'textarea',
];
const WRITE_SELECTORS = [
  '[data-testid="empty_state_button_text"]',
  'a[href="/compose/article"]',
  'a[href="/compose/articles"]',
  'a[href*="/compose/article"]',
  'a[href*="/compose/articles"]',
  'a:has-text("Write")',
  'button:has-text("Write")',
  'a:has-text("撰写")',
  'button:has-text("撰写")',
  'a:has-text("写文章")',
  'button:has-text("写文章")',
];
const PUBLISH_SELECTORS = [
  'button[data-testid="publishButton"]',
  'button:has-text("Publish")',
  'div[role="button"]:has-text("Publish")',
  'button:has-text("发布")',
  'div[role="button"]:has-text("发布")',
];
const LOGIN_SELECTORS = [
  'a[href*="/login"]',
  'a[href*="/i/flow/login"]',
  'input[autocomplete="username"]',
  'input[name="text"]',
  'input[type="password"]',
  'span:has-text("Sign in")',
  'span:has-text("Log in")',
  'span:has-text("登录")',
];

export async function runXArticlesPublish(options = {}) {
  const mode = resolveMode(options);
  const title = String(options.title ?? '').trim();
  const markdownPath = options.markdownFile ? resolve(options.markdownFile) : null;
  const timeoutMs = options.timeoutMs ?? 15000;

  if (!title && mode !== 'inspect') {
    throw new Error('Missing --title for X Articles publish.');
  }
  if (!markdownPath && mode !== 'inspect') {
    throw new Error('Missing --markdown-file for X Articles publish.');
  }

  if (mode === 'publish' && !isPublishConfirmed(title, options.confirmPublish)) {
    return {
      ok: false,
      command: 'x articles publish',
      mode,
      ready: false,
      article: emptyArticleSummary(title),
      diagnostics: [{
        category: 'publish_confirmation_required',
        message: '--publish requires --confirm-publish with the exact article title before any browser mutation.',
        next_step: `Review the visible X Article draft first, then retry with --publish --confirm-publish ${JSON.stringify(title)}.`,
      }],
      next_step: 'Use --draft for normal automation. Use --publish only after a visible browser review.',
    };
  }

  const markdown = markdownPath ? await readFile(markdownPath, 'utf8') : '';
  const markdownDir = markdownPath ? dirname(markdownPath) : process.cwd();
  const prepared = prepareXArticleMarkdown(markdown, {
    title,
    stripTitleHeading: Boolean(options.stripTitleHeading),
  });
  const format = analyzeXArticleMarkdown(prepared.markdown, { title, baseDir: markdownDir });
  const html = markdownToXArticleHtml(prepared.markdown);
  const article = articleSummary(title, prepared.markdown, html);

  if (mode === 'dry-run') {
    return {
      ok: format.diagnostics.filter((item) => item.severity !== 'warning').length === 0,
      command: 'x articles publish',
      mode,
      ready: format.diagnostics.filter((item) => item.severity !== 'warning').length === 0,
      article,
      format,
      diagnostics: format.diagnostics,
      next_step: format.diagnostics.length === 0
        ? 'Run --inspect after logging into X in the managed browser, then --draft to fill the Article composer.'
        : 'Fix the reported format issues before opening the X Article composer.',
    };
  }

  const endpointResult = await connectFirstAvailable(buildCandidateEndpoints(options), { timeoutMs });
  if (!endpointResult.browser) {
    return {
      ok: false,
      command: 'x articles publish',
      mode,
      ready: false,
      article,
      diagnostics: endpointResult.diagnostics,
      next_step: 'Start a managed CDP browser, for example `poai browser launch --url https://x.com/compose/articles`, log into X, then retry.',
    };
  }

  const { browser, endpoint } = endpointResult;
  try {
    const page = await findOrOpenXArticleComposer(browser, { timeoutMs });
    const pageState = await inspectXArticlePage(page);
    if (mode === 'inspect') {
      return {
        ok: true,
        command: 'x articles publish',
        mode,
        ready: pageState.session_state === 'editor_ready',
        endpoint,
        page: pageState,
        diagnostics: pageState.diagnostics,
        next_step: pageState.session_state === 'editor_ready'
          ? 'Run --dry-run for local format validation, then --draft to fill the visible Article composer.'
          : 'Complete X login/subscription access in the visible browser, then rerun --inspect.',
      };
    }

    const blockingDiagnostics = format.diagnostics.filter((item) => item.severity !== 'warning');
    if (blockingDiagnostics.length > 0) {
      return {
        ok: false,
        command: 'x articles publish',
        mode,
        ready: false,
        endpoint,
        page: pageState,
        article,
        format,
        diagnostics: blockingDiagnostics,
        next_step: 'Fix local article diagnostics before mutating the X editor.',
      };
    }

    if (pageState.session_state !== 'editor_ready') {
      return {
        ok: false,
        command: 'x articles publish',
        mode,
        ready: false,
        endpoint,
        page: pageState,
        article,
        diagnostics: pageState.diagnostics,
        next_step: 'Complete X login and confirm Articles access in the visible browser, then rerun the command.',
      };
    }

    await closeVisibleDialogs(page);
    await fillXArticleTitle(page, title);
    await fillXArticleBody(page, html, prepared.text, prepared.markdown, { baseDir: markdownDir });

    if (mode === 'publish') {
      await clickFirstVisible(page, PUBLISH_SELECTORS, timeoutMs);
    }

    const verification = await readXArticleDraft(page);
    const draftDiagnostics = verifyDraftContent({ title, text: prepared.text }, verification);
    const preview = options.validatePreview
      ? await validateXArticlePreview(page, {
        title,
        text: previewVerificationText(prepared.markdown, prepared.text),
      })
      : null;
    const previewDiagnostics = preview?.diagnostics ?? [];
    return {
      ok: draftDiagnostics.length === 0 && previewDiagnostics.length === 0,
      command: 'x articles publish',
      mode,
      ready: draftDiagnostics.length === 0 && previewDiagnostics.length === 0,
      endpoint,
      page: await inspectXArticlePage(page),
      article,
      draft: verification,
      ...(preview ? { preview } : {}),
      final_publish_clicked: mode === 'publish',
      diagnostics: [...draftDiagnostics, ...previewDiagnostics],
      next_step: mode === 'publish'
        ? 'The X publish control was clicked; verify the visible result page.'
        : 'Draft content was filled. Review the visible browser and use --publish only with exact title confirmation.',
    };
  } finally {
    await browser.close();
  }
}

export async function runXArticlesCapabilities(options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const endpointResult = await connectFirstAvailable(buildCandidateEndpoints(options), { timeoutMs });
  if (!endpointResult.browser) {
    return {
      ok: false,
      command: 'x articles capabilities',
      ready: false,
      diagnostics: endpointResult.diagnostics,
      next_step: 'Start a managed CDP browser, open X Articles, then retry.',
    };
  }

  const { browser, endpoint } = endpointResult;
  try {
    const page = await findOrOpenXArticleComposer(browser, { timeoutMs });
    const pageState = await inspectXArticlePage(page);
    if (pageState.session_state !== 'editor_ready') {
      return {
        ok: false,
        command: 'x articles capabilities',
        ready: false,
        endpoint,
        page: pageState,
        diagnostics: pageState.diagnostics,
        next_step: 'Complete X login and open the Article editor before probing capabilities.',
      };
    }
    const capabilities = await probeXArticleCapabilities(page);
    return {
      ok: true,
      command: 'x articles capabilities',
      ready: true,
      endpoint,
      page: await inspectXArticlePage(page),
      capabilities,
      diagnostics: capabilities.diagnostics,
      next_step: 'Use capabilities.observed_native for X UI support and capabilities.automated_by_script for currently automated support.',
    };
  } finally {
    await browser.close();
  }
}

export function analyzeXArticleMarkdown(markdown, options = {}) {
  const diagnostics = [];
  const normalized = String(markdown ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    diagnostics.push({
      category: 'empty_article',
      message: 'The Markdown body is empty.',
      next_step: 'Add article body content before drafting.',
    });
  }

  const firstHeading = firstNonEmptyLine(normalized);
  if (options.title && firstHeading && normalizeHeading(firstHeading) === normalizeHeading(`# ${options.title}`)) {
    diagnostics.push({
      category: 'duplicate_title_heading',
      severity: 'warning',
      message: 'The first H1 heading duplicates the X Article title field.',
      next_step: 'Prefer removing the duplicate H1 or pass --strip-title-heading.',
    });
  }

  if (/```/.test(normalized)) {
    const unterminatedFences = (normalized.match(/```/g) ?? []).length % 2 === 1;
    if (unterminatedFences) {
      diagnostics.push({
        category: 'unterminated_code_fence',
        message: 'One fenced code block is missing a closing ``` marker.',
        next_step: 'Close the fenced code block before drafting.',
      });
    }
  }

  for (const line of normalized.split('\n')) {
    const marker = parseXPostMarker(line);
    if (marker && !isXPostUrl(marker.url)) {
      diagnostics.push({
        category: 'x_post_url_invalid',
        message: 'X post embed markers must point to an x.com or twitter.com /status/ URL.',
        next_step: 'Use {{x:post:https://x.com/user/status/123}} or keep the URL as a normal link.',
      });
    }
    const gif = parseXGifMarker(line);
    if (gif && !gif.query) {
      diagnostics.push({
        category: 'x_gif_query_missing',
        message: 'X GIF markers must include a search query.',
        next_step: 'Use {{x:gif:celebrate}} or remove the marker.',
      });
    }
  }

  for (const match of normalized.matchAll(MARKDOWN_IMAGE_RE)) {
    const alt = match[1].trim();
    const target = match[2].trim();
    if (!alt) {
      diagnostics.push({
        category: 'image_alt_missing',
        severity: 'warning',
        message: 'One Markdown image has an empty alt label.',
        next_step: 'Use meaningful alt text so the draft is easier to audit.',
      });
    }
    const standalone = normalized.split('\n').some((line) => line.trim() === match[0]);
    if (!standalone) {
      diagnostics.push({
        category: 'article_image_must_be_standalone',
        message: 'Automated X Article image upload requires Markdown images on their own line.',
        next_step: 'Move the image syntax to its own paragraph before drafting.',
      });
    }
    if (/^https?:\/\//i.test(target)) {
      diagnostics.push({
        category: 'remote_article_image_unsupported',
        message: 'Remote Markdown image URLs are not currently automated for X Articles.',
        next_step: 'Download the image and reference a local jpg/png/webp/gif file, or place the image manually during visible review.',
      });
      continue;
    }
    if (!isLocalPath(target)) {
      diagnostics.push({
        category: 'article_image_path_unsupported',
        message: 'Markdown image targets must be local paths for automated X Article media upload.',
        next_step: 'Use a relative, absolute, or file:// local image path.',
      });
      continue;
    }
    const localPath = resolveLocalImagePath(target, options.baseDir);
    const extension = extname(localPath).toLowerCase();
    if (!SUPPORTED_ARTICLE_IMAGE_EXTENSIONS.has(extension)) {
      diagnostics.push({
        category: 'article_image_type_unsupported',
        message: 'X Article automated image upload currently supports jpg, png, webp, and gif files.',
        next_step: 'Convert the image to jpg, png, webp, or gif before drafting.',
      });
    }
    if (!existsSync(localPath)) {
      diagnostics.push({
        category: 'article_image_not_found',
        message: 'A local Markdown image file was not found.',
        next_step: 'Fix the image path relative to the Markdown file before drafting.',
      });
    }
  }

  const operations = xArticleInsertionPlan(normalized, { baseDir: options.baseDir });
  const firstImage = operations.findIndex((operation) => operation.type === 'image');
  if (firstImage >= 0 && operations.slice(firstImage + 1).some((operation) => operation.type !== 'rich_text' && operation.type !== 'image')) {
    diagnostics.push({
      category: 'article_native_block_after_image_unstable',
      message: 'Native X Article blocks after local images are not stable enough for automated formatting.',
      next_step: 'Move dividers, code, LaTeX, X post embeds, and GIF markers before local images, or keep only ordinary text after images.',
    });
  }

  return {
    chars: normalized.length,
    paragraphs: normalized.split(/\n{2,}/).filter((part) => part.trim()).length,
    diagnostics,
  };
}

export function prepareXArticleMarkdown(markdown, options = {}) {
  let output = String(markdown ?? '').replace(/\r\n/g, '\n').trim();
  if (options.stripTitleHeading && options.title) {
    const lines = output.split('\n');
    if (lines.length > 0 && normalizeHeading(lines[0]) === normalizeHeading(`# ${options.title}`)) {
      output = lines.slice(1).join('\n').trimStart();
    }
  }
  output = output
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n(#{1,6}\s+)/g, '\n\n$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const text = markdownToPlainText(output);
  return { markdown: `${output}\n`, text };
}

export function markdownToXArticleHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = null;
  let blockquote = [];
  let inFence = false;
  let fenceLines = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.type === 'ol' ? 'ol' : 'ul';
    blocks.push(`<${tag}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`);
    list = null;
  };
  const flushBlockquote = () => {
    if (blockquote.length === 0) return;
    blocks.push(`<blockquote>${renderInline(blockquote.join(' '))}</blockquote>`);
    blockquote = [];
  };
  const flushFence = () => {
    if (!inFence) return;
    blocks.push(`<pre>${escapeHtml(fenceLines.join('\n'))}</pre>`);
    inFence = false;
    fenceLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith('```')) {
      flushParagraph();
      flushList();
      flushBlockquote();
      if (inFence) {
        flushFence();
      } else {
        inFence = true;
        fenceLines = [];
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(rawLine);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushBlockquote();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      flushBlockquote();
      const level = heading[1].length <= 2 ? 'h2' : 'h3';
      blocks.push(`<${level}>${renderInline(heading[2].trim())}</${level}>`);
      continue;
    }
    const quoted = /^>\s?(.+)$/.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      blockquote.push(quoted[1].trim());
      continue;
    }
    const unordered = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      flushBlockquote();
      const type = ordered ? 'ol' : 'ul';
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((unordered ?? ordered)[1].trim());
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushBlockquote();
  flushFence();
  return blocks.join('\n');
}

export function xArticleInsertionPlan(markdown, options = {}) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const operations = [];
  let buffer = [];
  let inFence = false;
  let fenceLanguage = '';
  let fenceLines = [];
  let inLatex = false;
  let latexLines = [];

  const flushText = () => {
    const chunk = buffer.join('\n').trim();
    buffer = [];
    if (!chunk) return;
    operations.push({
      type: 'rich_text',
      markdown: `${chunk}\n`,
      html: markdownToXArticleHtml(`${chunk}\n`),
      text: markdownToPlainText(`${chunk}\n`),
    });
  };
  const flushFence = () => {
    operations.push({
      type: 'code',
      language: fenceLanguage,
      code: fenceLines.join('\n').trimEnd(),
    });
    inFence = false;
    fenceLanguage = '';
    fenceLines = [];
  };
  const flushLatex = () => {
    const tex = latexLines.join('\n').trim();
    if (tex) operations.push({ type: 'latex', tex });
    inLatex = false;
    latexLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const fence = /^```\s*([A-Za-z0-9_+.-]*)\s*$/.exec(line);
    if (fence) {
      if (inFence) {
        flushFence();
      } else {
        flushText();
        inFence = true;
        fenceLanguage = fence[1] ?? '';
        fenceLines = [];
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(rawLine);
      continue;
    }

    if (/^\$\$\s*$/.test(line)) {
      if (inLatex) {
        flushLatex();
      } else {
        flushText();
        inLatex = true;
        latexLines = [];
      }
      continue;
    }
    if (inLatex) {
      latexLines.push(rawLine);
      continue;
    }

    const inlineLatex = /^\$\$(.+)\$\$\s*$/.exec(line);
    if (inlineLatex) {
      flushText();
      operations.push({ type: 'latex', tex: inlineLatex[1].trim() });
      continue;
    }

    if (isMarkdownDivider(line)) {
      flushText();
      operations.push({ type: 'divider' });
      continue;
    }

    const post = parseXPostMarker(line);
    if (post) {
      flushText();
      operations.push({ type: 'x_post', url: post.url });
      continue;
    }

    const gif = parseXGifMarker(line);
    if (gif) {
      flushText();
      operations.push({ type: 'gif', query: gif.query });
      continue;
    }

    const image = MARKDOWN_IMAGE_LINE_RE.exec(line.trim());
    if (image) {
      flushText();
      operations.push({
        type: 'image',
        alt: image[1].trim(),
        target: image[2].trim(),
        path: resolveLocalImagePath(image[2].trim(), options.baseDir),
      });
      continue;
    }

    buffer.push(rawLine);
  }

  if (inFence) {
    buffer.push('```', ...fenceLines);
  }
  if (inLatex) {
    buffer.push('$$', ...latexLines);
  }
  flushText();
  return operations;
}

export function isPublishConfirmed(title, confirmation) {
  return String(confirmation ?? '').trim() === String(title ?? '').trim() && String(title ?? '').trim().length > 0;
}

export async function inspectXArticlePage(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  const url = page.url();
  const title = await page.title().catch(() => '');
  const signals = {
    x_host: isXUrl(url),
    login_required: await hasAny(page, LOGIN_SELECTORS),
    title_input: await hasAny(page, TITLE_SELECTORS),
    body_editor: await hasAny(page, BODY_SELECTORS),
    write_entry: await hasAny(page, WRITE_SELECTORS),
    publish_button: await hasAny(page, PUBLISH_SELECTORS),
    premium_required_text: await isPresent(page, 'text=/Premium|Premium\\+|Subscribe|订阅/i'),
  };
  const diagnostics = [];
  let sessionState = 'unknown';
  if (!signals.x_host) {
    sessionState = 'not_x_page';
    diagnostics.push({
      category: 'not_x_page',
      message: 'The selected page is not an X/Twitter page.',
      next_step: 'Open https://x.com/compose/articles in the managed browser.',
    });
  } else if (signals.login_required) {
    sessionState = 'login_required';
    diagnostics.push({
      category: 'login_required',
      message: 'X is showing a login surface.',
      next_step: 'Log into X in the visible managed browser and rerun --inspect.',
    });
  } else if (signals.title_input && signals.body_editor) {
    sessionState = 'editor_ready';
  } else if (signals.premium_required_text && !signals.body_editor) {
    sessionState = 'articles_access_required';
    diagnostics.push({
      category: 'articles_access_required',
      message: 'The page appears to require Premium/Premium+ or organization access before the Article editor is available.',
      next_step: 'Use an account with X Articles access or open the Articles tab manually and rerun --inspect.',
    });
  } else {
    sessionState = 'editor_unknown';
    diagnostics.push({
      category: 'editor_controls_not_found',
      message: 'X loaded, but Article title/body controls were not both detected.',
      next_step: 'Open the Articles tab, click Write, then rerun --inspect; update selectors if the UI changed.',
    });
  }
  return { url: sanitizeXUrl(url), title: redactTitle(title), session_state: sessionState, signals, diagnostics };
}

async function findOrOpenXArticleComposer(browser, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (isXArticleEditUrl(page.url())) {
        await page.bringToFront().catch(() => {});
        if (await hasAny(page, TITLE_SELECTORS) && await hasAny(page, BODY_SELECTORS)) {
          return page;
        }
      }
    }
  }
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (isXArticleListUrl(page.url())) {
        await page.bringToFront().catch(() => {});
        await openWriteEntryIfNeeded(page, timeoutMs);
        if (await hasAny(page, TITLE_SELECTORS) && await hasAny(page, BODY_SELECTORS)) {
          return page;
        }
      }
    }
  }
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = await context.newPage();
  await page.goto(X_ARTICLE_COMPOSE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
  await openWriteEntryIfNeeded(page, timeoutMs);
  return page;
}

async function openWriteEntryIfNeeded(page, timeoutMs) {
  if (await hasAny(page, TITLE_SELECTORS) && await hasAny(page, BODY_SELECTORS)) return;
  const write = await firstVisible(page, WRITE_SELECTORS, { timeoutMs: 3000 }).catch(() => null);
  if (write) {
    await write.click({ timeout: timeoutMs }).catch(() => {});
    await page.waitForURL(/\/compose\/articles\/edit\//, { timeout: timeoutMs }).catch(() => {});
    await page.waitForFunction(
      ({ titleSelectors, bodySelectors }) => {
        return titleSelectors.some((selector) => document.querySelector(selector))
          && bodySelectors.some((selector) => document.querySelector(selector));
      },
      { titleSelectors: TITLE_SELECTORS, bodySelectors: BODY_SELECTORS },
      { timeout: timeoutMs },
    ).catch(() => {});
  }
  if (!(await hasAny(page, TITLE_SELECTORS)) || !(await hasAny(page, BODY_SELECTORS))) {
    await page.goto(X_ARTICLE_COMPOSE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    const retryWrite = await firstVisible(page, WRITE_SELECTORS, { timeoutMs: 5000 }).catch(() => null);
    if (retryWrite) {
      await retryWrite.click({ timeout: timeoutMs }).catch(() => {});
      await page.waitForURL(/\/compose\/articles\/edit\//, { timeout: timeoutMs }).catch(() => {});
    }
    await page.waitForFunction(
      ({ titleSelectors, bodySelectors }) => {
        return titleSelectors.some((selector) => document.querySelector(selector))
          && bodySelectors.some((selector) => document.querySelector(selector));
      },
      { titleSelectors: TITLE_SELECTORS, bodySelectors: BODY_SELECTORS },
      { timeout: timeoutMs },
    ).catch(() => {});
  }
}

async function fillXArticleTitle(page, title) {
  const titleInput = await firstVisible(page, TITLE_SELECTORS);
  await fillEditable(page, titleInput, title);
}

async function fillXArticleBody(page, html, fallbackText, markdown, options = {}) {
  const body = await firstVisible(page, BODY_SELECTORS);
  await body.click({ timeout: 5000 });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  const operations = xArticleInsertionPlan(markdown, { baseDir: options.baseDir });
  if (operations.some((operation) => operation.type !== 'rich_text')) {
    await fillXArticleBodyFromPlan(page, body, operations);
    return;
  }
  await pasteHtml(page, html, fallbackText);
}

async function fillXArticleBodyFromPlan(page, body, operations) {
  for (const operation of operations) {
    if (operation.type === 'rich_text') {
      await focusBodyEnd(page, body);
      await pasteHtml(page, operation.html, operation.text);
    } else if (operation.type === 'divider') {
      await insertNativeDivider(page, body);
    } else if (operation.type === 'code') {
      await insertNativeCode(page, body, operation);
    } else if (operation.type === 'latex') {
      await insertNativeLatex(page, body, operation);
    } else if (operation.type === 'x_post') {
      await insertNativeXPost(page, body, operation);
    } else if (operation.type === 'gif') {
      await insertNativeGif(page, body, operation);
    } else if (operation.type === 'image') {
      await insertNativeImage(page, body, operation);
    }
  }
}

async function insertNativeDivider(page, body) {
  await focusBodyEnd(page, body);
  await clickInsertMenuItem(page, /分割线|Divider/i);
  await page.waitForTimeout(500);
}

async function insertNativeCode(page, body, operation) {
  if (!operation.code.trim()) return;
  await focusBodyEnd(page, body);
  await clickInsertMenuItem(page, /代码|Code/i);
  const dialog = await waitForVisibleDialog(page);
  await dialog.locator('textarea[name="code-input"], input[name="code-input"]').fill(operation.code);
  await clickDialogInsert(page);
}

async function insertNativeLatex(page, body, operation) {
  if (!operation.tex.trim()) return;
  await focusBodyEnd(page, body);
  await clickInsertMenuItem(page, /LaTeX/i);
  const dialog = await waitForVisibleDialog(page);
  await dialog.locator('textarea[name="tex-input"], input[name="tex-input"]').fill(operation.tex);
  await clickDialogInsert(page);
}

async function insertNativeXPost(page, body, operation) {
  await focusBodyEnd(page, body);
  await clickInsertMenuItem(page, /帖子|Post/i);
  const dialog = await waitForVisibleDialog(page);
  await dialog.locator('input[name="TweetByUrlInput"], textarea[name="TweetByUrlInput"]').fill(operation.url);
  const expectedHandle = xPostHandle(operation.url);
  const expectedStatus = xPostStatusId(operation.url);
  await page.waitForFunction(
    ({ handle, status }) => {
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find(visible);
      if (!dialog) return false;
      const text = dialog.innerText || '';
      return !/帖子未找到|Post not found/i.test(text)
        && ((handle && new RegExp(`@${handle}`, 'i').test(text)) || (status && text.length > 0));
    },
    { handle: expectedHandle, status: expectedStatus },
    { timeout: 10000 },
  );
  await clickDialogButtonByText(page, expectedHandle ? new RegExp(`@${escapeRegExp(expectedHandle)}\\b`, 'i') : /./);
  await page.waitForTimeout(1200);
}

async function insertNativeGif(page, body, operation) {
  await focusBodyEnd(page, body);
  const beforeMedia = await articleMediaCount(page);
  await clickInsertMenuItem(page, /GIF/i);
  const dialog = await waitForVisibleDialog(page);
  const search = dialog.locator('input[placeholder*="GIF" i], input, textarea, [contenteditable="true"][role="textbox"]').first();
  if (operation.query) {
    await search.fill(operation.query).catch(async () => {
      await search.click({ timeout: 3000, force: true });
      await page.keyboard.insertText(operation.query);
    });
  }
  await page.waitForFunction(() => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    return [...document.querySelectorAll('[role="dialog"] button')]
      .some((button) => visible(button) && button.querySelector('img[src*="giphy"], img[src*="tenor"]'));
  }, null, { timeout: 10000 });
  await clickFirstGifResult(page);
  await page.waitForFunction((count) => {
    const composer = document.querySelector('[data-testid="composer"]');
    return composer && composer.querySelectorAll('section[contenteditable="false"] img, section[contenteditable="false"] video, section[contenteditable="false"] source').length > count;
  }, beforeMedia, { timeout: 15000 });
  await page.waitForTimeout(500);
}

async function insertNativeImage(page, body, operation) {
  if (!operation.path) return;
  await focusBodyEnd(page, body);
  const beforeMedia = await articleMediaCount(page);
  await clickInsertMenuItem(page, /媒体|Media/i);
  const dialog = await waitForVisibleDialog(page);
  await dialog.locator('input[type="file"]').first().setInputFiles(operation.path);
  await page.waitForFunction((count) => {
    const composer = document.querySelector('[data-testid="composer"]');
    return composer && composer.querySelectorAll('section[contenteditable="false"] img, section[contenteditable="false"] video, section[contenteditable="false"] source').length > count;
  }, beforeMedia, { timeout: 20000 });
  await page.waitForTimeout(500);
}

async function focusBodyEnd(page, body) {
  const selected = await body.evaluate((el) => {
    if (el.isContentEditable) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    if ('selectionStart' in el && 'value' in el) {
      el.focus();
      el.selectionStart = el.value.length;
      el.selectionEnd = el.value.length;
      return true;
    }
    return false;
  }).catch(() => false);
  if (!selected) {
    await body.click({ timeout: 5000 });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End').catch(() => {});
  }
  await page.waitForTimeout(100);
}

async function articleMediaCount(page) {
  return await page.evaluate(() => {
    const composer = document.querySelector('[data-testid="composer"]');
    return composer?.querySelectorAll('section[contenteditable="false"] img, section[contenteditable="false"] video, section[contenteditable="false"] source').length ?? 0;
  }).catch(() => 0);
}

async function clickFirstGifResult(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const box = await page.evaluate(() => {
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const button = [...document.querySelectorAll('[role="dialog"] button')]
        .find((candidate) => visible(candidate) && candidate.querySelector('img[src*="giphy"], img[src*="tenor"]'));
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    if (!box) throw new Error('X Article GIF result not found.');
    await page.waitForTimeout(750);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(1000);
    const stillOpen = await page.evaluate(() => {
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      return [...document.querySelectorAll('[role="dialog"]')].some(visible);
    }).catch(() => false);
    if (!stillOpen) return;
  }
}

async function clickDialogButtonByText(page, pattern) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const box = await page.evaluate((source) => {
      const pattern = new RegExp(source, 'i');
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const button = [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] [role="button"]')]
        .find((el) => visible(el) && pattern.test((el.innerText || el.getAttribute('aria-label') || '').trim()));
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, pattern.source);
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(1000);
      return;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`X Article dialog card not found for ${pattern}`);
}

async function clickInsertMenuItem(page, pattern) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.getByLabel(/添加媒体内容|Insert/i).click({ timeout: 5000 });
  await page.waitForTimeout(250);
  const menuItems = page.locator('[role="menuitem"]');
  const count = await menuItems.count();
  for (let index = 0; index < count; index += 1) {
    const item = menuItems.nth(index);
    if (!(await item.isVisible({ timeout: 200 }).catch(() => false))) continue;
    const text = (await item.innerText().catch(() => '')).trim();
    if (pattern.test(text)) {
      await item.click({ timeout: 5000 });
      await page.waitForTimeout(500);
      return;
    }
  }
  throw new Error(`X Article insert menu item not found: ${pattern}`);
}

async function clickDialogInsert(page) {
  const dialog = await waitForVisibleDialog(page);
  const insert = dialog.locator([
    'button:has-text("插入")',
    'div[role="button"]:has-text("插入")',
    'button:has-text("Insert")',
    'div[role="button"]:has-text("Insert")',
  ].join(', ')).last();
  await insert.click({ timeout: 5000, force: true });
  await page.waitForTimeout(1000);
}

async function waitForVisibleDialog(page) {
  await page.waitForFunction(() => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    return [...document.querySelectorAll('[role="dialog"]')].some(visible);
  }, null, { timeout: 7000 });
  const index = await page.evaluate(() => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    return [...document.querySelectorAll('[role="dialog"]')].findIndex(visible);
  });
  if (index < 0) throw new Error('No visible X Article dialog found.');
  return page.locator('[role="dialog"]').nth(index);
}

async function closeVisibleDialogs(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const hasDialog = await page.evaluate(() => {
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      return [...document.querySelectorAll('[role="dialog"]')].some(visible);
    }).catch(() => false);
    if (!hasDialog) return;

    let closed = false;
    const discardButton = page.locator('[role="dialog"] button:has-text("放弃"), [role="dialog"] div[role="button"]:has-text("放弃"), [role="dialog"] button:has-text("Discard"), [role="dialog"] div[role="button"]:has-text("Discard")').last();
    if (await discardButton.isVisible({ timeout: 200 }).catch(() => false)) {
      closed = await discardButton.click({ timeout: 1000, force: true }).then(() => true).catch(() => false);
      await page.waitForTimeout(500);
      if (closed) continue;
    }
    const closeButtons = page.locator('[role="dialog"] [data-testid="app-bar-close"], [role="dialog"] button:has-text("关闭"), [role="dialog"] div[role="button"]:has-text("关闭"), [role="dialog"] button:has-text("Close"), [role="dialog"] div[role="button"]:has-text("Close")');
    const count = await closeButtons.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const button = closeButtons.nth(index);
      if (!(await button.isVisible({ timeout: 200 }).catch(() => false))) continue;
      closed = await button.click({ timeout: 1000, force: true }).then(() => true).catch(() => false);
      if (closed) break;
    }
    if (!closed) {
      await page.keyboard.press('Escape').catch(() => {});
    }
    await page.waitForTimeout(closed ? 500 : 300);
  }
}

async function fillEditable(page, locator, text) {
  await locator.click({ timeout: 5000 });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(text);
}

async function pasteHtml(page, html, fallbackText) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://x.com' }).catch(() => {});
  const nativeClipboard = await page.evaluate(async ({ htmlValue, textValue }) => {
    if (!globalThis.ClipboardItem) return false;
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([htmlValue], { type: 'text/html' }),
      'text/plain': new Blob([textValue], { type: 'text/plain' }),
    })]);
    return true;
  }, { htmlValue: html, textValue: fallbackText }).catch(() => false);
  if (nativeClipboard) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    await page.waitForTimeout(500);
    return;
  }

  const syntheticPaste = await page.evaluate(({ htmlValue, textValue }) => {
    const active = document.activeElement;
    if (!active) return false;
    const data = new DataTransfer();
    data.setData('text/html', htmlValue);
    data.setData('text/plain', textValue);
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    return active.dispatchEvent(event);
  }, { htmlValue: html, textValue: fallbackText }).catch(() => false);
  if (!syntheticPaste) {
    await page.keyboard.insertText(fallbackText);
  }
  await page.waitForTimeout(500);
}

async function readXArticleDraft(page) {
  const titleText = await readFirstText(page, TITLE_SELECTORS);
  const bodyTexts = [];
  const body = await firstVisible(page, BODY_SELECTORS).catch(() => null);
  const bodyLocators = body ? [body] : [];
  let bodyStructure = {};
  for (const locator of bodyLocators) {
    const text = await locator.evaluate((el) => 'value' in el ? el.value : el.innerText).catch(() => '');
    if (text?.trim()) bodyTexts.push(normalizeText(text));
    bodyStructure = await locator.evaluate((el) => ({
      blockquotes: el.querySelectorAll('blockquote').length,
      separators: el.querySelectorAll('[role="separator"]').length,
      embedded_posts: el.querySelectorAll('article[role="article"], article').length,
      media_blocks: el.querySelectorAll('section[contenteditable="false"] img, section[contenteditable="false"] video, section[contenteditable="false"] source').length,
      native_sections: [...el.querySelectorAll('section[contenteditable="false"]')]
        .map((section) => (section.innerText || '').trim())
        .filter(Boolean),
    })).catch(() => ({}));
  }
  return {
    title: normalizeText(titleText),
    body_text: bodyTexts.at(-1) ?? '',
    body_candidates: bodyTexts.length,
    body_structure: bodyStructure,
  };
}

async function validateXArticlePreview(page, expected) {
  const editUrl = page.url();
  const previewUrl = editUrl.replace(/\/preview(?:$|[?#].*)/, '');
  await page.goto(`${previewUrl}/preview`, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  await page.waitForURL(/\/preview(?:$|[?#])/, { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  const expectedStart = canonicalDraftText(expected.text).slice(0, 60);
  await page.waitForFunction(
    ({ titleValue, bodyStart }) => {
      const canonical = (value) => String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/(^|\s)[-*]\s+/g, '$1')
        .replace(/(^|\s)\d+[.)]\s+/g, '$1');
      const text = canonical(document.body?.innerText || '');
      return text.includes(canonical(titleValue)) && (!bodyStart || text.includes(bodyStart));
    },
    { titleValue: expected.title, bodyStart: expectedStart },
    { timeout: 15000 },
  ).catch(() => {});
  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const diagnostics = [];
  if (!/\/preview(?:$|[?#])/.test(page.url())) {
    diagnostics.push({
      category: 'preview_navigation_failed',
      message: 'The X Article preview URL was not reached after clicking Preview.',
      next_step: 'Inspect the visible browser; X may have changed the preview control.',
    });
  }
  if (!canonicalDraftText(bodyText).includes(canonicalDraftText(expected.title))) {
    diagnostics.push({
      category: 'preview_title_mismatch',
      message: 'The X Article preview does not include the expected title.',
      next_step: 'Return to the editor and inspect the preview before publishing.',
    });
  }
  if (expectedStart && !canonicalDraftText(bodyText).includes(expectedStart)) {
    diagnostics.push({
      category: 'preview_body_mismatch',
      message: 'The X Article preview does not include the expected opening body text.',
      next_step: 'Return to the editor and inspect formatting before publishing.',
    });
  }
  await page.goto(previewUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  await page.waitForFunction(
    ({ titleSelectors, bodySelectors }) => {
      return titleSelectors.some((selector) => document.querySelector(selector))
        && bodySelectors.some((selector) => document.querySelector(selector));
    },
    { titleSelectors: TITLE_SELECTORS, bodySelectors: BODY_SELECTORS },
    { timeout: 10000 },
  ).catch(() => {});
  return {
    url: sanitizeXUrl(`${previewUrl}/preview`),
    title: redactTitle(title),
    body_text_sample: normalizeText(bodyText).slice(0, 500),
    diagnostics,
  };
}

async function probeXArticleCapabilities(page) {
  await page.keyboard.press('Escape').catch(() => {});
  const base = await page.evaluate(() => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const controls = [...document.querySelectorAll('button,a,input,textarea,[contenteditable="true"],div[role="button"]')]
      .filter(visible)
      .map((el) => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        testid: el.getAttribute('data-testid'),
        aria: el.getAttribute('aria-label'),
        href: el.getAttribute('href'),
        type: el.getAttribute('type'),
        accept: el.getAttribute('accept'),
        placeholder: el.getAttribute('placeholder'),
        text: (el.innerText || el.value || '').trim(),
      }));
    const hasTestId = (value) => controls.some((item) => item.testid === value);
    const hasText = (pattern) => controls.some((item) => pattern.test([item.text, item.aria, item.placeholder, item.href].filter(Boolean).join(' ')));
    return {
      title_field: controls.some((item) => item.placeholder && /标题|Title/i.test(item.placeholder)),
      body_editor: hasTestId('composer') || controls.some((item) => item.role === 'textbox' && item.tag === 'DIV'),
      publish_button: hasText(/发布|Publish/i),
      preview_link: hasText(/预览|Preview/i),
      focus_mode: hasText(/专注模式|Focus/i),
      keyboard_shortcuts: hasText(/键盘快捷键|keyboard/i),
      toolbar: {
        bold: hasTestId('btn-bold'),
        italic: hasTestId('btn-italic'),
        strikethrough: hasTestId('btn-strikethrough'),
        blockquote: hasTestId('btn-blockquote'),
        unordered_list: hasTestId('btn-ul'),
        ordered_list: hasTestId('btn-ol'),
        link: hasTestId('btn-link'),
        emoji: hasTestId('btn-emoji'),
      },
      style_button_text: controls.find((item) => item.tag === 'BUTTON' && /正文|副标题|标题|Body|Heading/i.test(item.text))?.text ?? '',
      media: {
        insert_button: hasText(/插入|添加媒体内容|Insert/i),
        add_photo_video_button: hasText(/添加照片或视频|photo|video/i),
        file_input_accept: controls.find((item) => item.type === 'file')?.accept ?? '',
        remove_photo_button_visible: hasText(/移除照片|Remove photo/i),
      },
    };
  });

  const linkDialog = await probeLinkDialog(page);
  const insertMenu = await probeInsertMenu(page);
  const mediaDialog = insertMenu.media ? await probeMediaDialog(page) : { available: false };
  const diagnostics = [];
  if (!base.title_field || !base.body_editor) {
    diagnostics.push({
      category: 'editor_controls_missing',
      message: 'Title or body editor controls were not observed while probing capabilities.',
      next_step: 'Rerun --inspect and update selectors if X changed the editor.',
    });
  }

  return {
    observed_native: {
      ...base,
      media: {
        ...base.media,
        file_input_accept: mediaDialog.file_input_accept || base.media.file_input_accept,
        dialog: mediaDialog,
      },
      link_dialog: linkDialog,
      insert_menu: insertMenu,
    },
    automated_by_script: {
      title: true,
      body_rich_text_paste: true,
      headings: true,
      paragraphs: true,
      bold: true,
      italic: true,
      strikethrough: true,
      links: true,
      unordered_list: true,
      ordered_list: true,
      publish_confirmation_lock: true,
      blockquote: true,
      indentation: false,
      local_media_upload: true,
      gif_insert: true,
      x_post_embed: true,
      x_post_article_url_supported: false,
      divider: true,
      code_block_native: true,
      latex: true,
      cover_or_header_image: false,
      emoji_insert: true,
      preview_validation: true,
    },
    diagnostics,
  };
}

async function probeLinkDialog(page) {
  await page.keyboard.press('Escape').catch(() => {});
  const button = page.locator('[data-testid="btn-link"]').first();
  if (!(await button.count().catch(() => 0))) {
    return { available: false, fields: [], insert_button: false };
  }
  await button.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);
  const dialog = await page.evaluate(() => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
    const text = dialogs.map((el) => el.innerText || '').join('\n');
    const fields = [...document.querySelectorAll('[role="dialog"] input, [role="dialog"] textarea')]
      .filter(visible)
      .map((el) => el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.name || '');
    return {
      available: dialogs.length > 0 && /链接|link|URL/i.test(text),
      text: text.trim().slice(0, 300),
      fields,
      insert_button: /插入|Insert/i.test(text),
    };
  });
  await page.locator('[data-testid="app-bar-close"]').first().click({ timeout: 1000 }).catch(async () => {
    await page.keyboard.press('Escape').catch(() => {});
  });
  return dialog;
}

async function probeInsertMenu(page) {
  await page.keyboard.press('Escape').catch(() => {});
  const clicked = await page.getByLabel(/添加媒体内容|Insert/i).click({ timeout: 3000 }).then(() => true).catch(() => false);
  if (!clicked) return { available: false, items: [] };
  await page.waitForTimeout(300);
  const menu = await page.evaluate(() => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const items = [...document.querySelectorAll('[role="menuitem"]')]
      .filter(visible)
      .map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim())
      .filter(Boolean);
    return {
      available: items.length > 0,
      items,
      media: items.some((item) => /媒体|Media/i.test(item)),
      gif: items.some((item) => /GIF/i.test(item)),
      post_embed: items.some((item) => /帖子|Post/i.test(item)),
      divider: items.some((item) => /分割线|Divider/i.test(item)),
      code: items.some((item) => /代码|Code/i.test(item)),
      latex: items.some((item) => /LaTeX/i.test(item)),
    };
  });
  await page.keyboard.press('Escape').catch(() => {});
  return menu;
}

async function probeMediaDialog(page) {
  await page.keyboard.press('Escape').catch(() => {});
  const opened = await openInsertMenuItemForProbe(page, /媒体|Media/i);
  if (!opened) return { available: false };
  await page.waitForTimeout(300);
  const media = await page.evaluate(() => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(visible);
    if (!dialog) return { available: false };
    const input = dialog.querySelector('input[type="file"]');
    return {
      available: true,
      text: (dialog.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 300),
      file_input_accept: input?.getAttribute('accept') ?? '',
      file_input_visible: input ? visible(input) : false,
    };
  });
  await page.locator('[data-testid="app-bar-close"]').first().click({ timeout: 1000 }).catch(async () => {
    await page.keyboard.press('Escape').catch(() => {});
  });
  return media;
}

async function openInsertMenuItemForProbe(page, pattern) {
  const clicked = await page.getByLabel(/添加媒体内容|Insert/i).click({ timeout: 3000 }).then(() => true).catch(() => false);
  if (!clicked) return false;
  await page.waitForTimeout(300);
  const menuItems = page.locator('[role="menuitem"]');
  const count = await menuItems.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = menuItems.nth(index);
    if (!(await item.isVisible({ timeout: 200 }).catch(() => false))) continue;
    const text = (await item.innerText().catch(() => '')).trim();
    if (pattern.test(text)) {
      await item.click({ timeout: 3000 });
      return true;
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

function verifyDraftContent(expected, actual) {
  const diagnostics = [];
  if (normalizeText(actual.title) !== normalizeText(expected.title)) {
    diagnostics.push({
      category: 'draft_title_mismatch',
      message: 'The visible X Article title does not match the requested title.',
      next_step: 'Inspect the title field before publishing; update selectors if the title was written to the wrong control.',
    });
  }
  const expectedStart = canonicalDraftText(expected.text).slice(0, 60);
  const actualBody = canonicalDraftText(actual.body_text);
  if (expectedStart && !actualBody.includes(expectedStart)) {
    diagnostics.push({
      category: 'draft_body_mismatch',
      message: 'The visible X Article body does not contain the expected opening text.',
      next_step: 'Inspect the body editor before publishing; update paste handling if rich-text paste was rejected.',
    });
  }
  return diagnostics;
}

async function connectFirstAvailable(endpoints, options) {
  const diagnostics = [];
  for (const endpoint of endpoints) {
    let browser;
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: options.timeoutMs ?? 5000 });
      return { browser, endpoint, diagnostics };
    } catch (error) {
      diagnostics.push({
        category: 'browser_not_found',
        message: `Could not connect to ${endpoint}: ${formatError(error)}`,
        endpoint,
        next_step: 'Confirm Chrome is running with a remote debugging port.',
      });
      if (browser) await browser.close().catch(() => {});
    }
  }
  return { browser: null, endpoint: null, diagnostics };
}

async function validateReadableFile(path) {
  const absolute = resolve(path);
  await access(absolute, constants.R_OK);
  return absolute;
}

async function firstVisible(page, selectors, options = {}) {
  const locators = await visibleLocators(page, selectors, options);
  if (locators.length === 0) {
    throw new Error(`No visible element found for selectors: ${selectors.join(', ')}`);
  }
  return locators[0];
}

async function visibleLocators(page, selectors, options = {}) {
  const locators = [];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible({ timeout: options.timeoutMs ?? 500 }).catch(() => false)) {
        locators.push(candidate);
      }
    }
  }
  return locators;
}

async function clickFirstVisible(page, selectors, timeoutMs) {
  const locator = await firstVisible(page, selectors, { timeoutMs });
  await locator.click({ timeout: timeoutMs });
}

async function hasAny(page, selectors) {
  for (const selector of selectors) {
    if (await isPresent(page, selector)) return true;
  }
  return false;
}

async function isPresent(page, selector) {
  const locator = page.locator(selector).first();
  return await locator.count().then((count) => count > 0).catch(() => false);
}

async function readFirstText(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0)) {
      const text = await locator.evaluate((el) => 'value' in el ? el.value : el.innerText).catch(() => '');
      if (text) return text;
    }
  }
  return '';
}

function renderInline(text) {
  return escapeHtml(text)
    .replace(LINK_RE, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(MARKDOWN_IMAGE_RE, '');
}

function markdownToPlainText(markdown) {
  return String(markdown ?? '')
    .replace(/^```\s*[\w+.-]*\s*\n([\s\S]*?)\n```\s*$/gm, '$1')
    .replace(/^\$\$\s*\n([\s\S]*?)\n\$\$\s*$/gm, '$1')
    .replace(/^\$\$(.+)\$\$\s*$/gm, '$1')
    .replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, '')
    .replace(/^\{\{x:post:(https?:\/\/[^}]+)\}\}\s*$/gm, '$1')
    .replace(/^\{\{x:gif:([^}]+)\}\}\s*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*]\s+/gm, '- ')
    .replace(/^\d+[.)]\s+/gm, (match) => match.replace(/[.)]\s*$/, '. '))
    .replace(MARKDOWN_IMAGE_RE, '')
    .replace(LINK_RE, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function articleSummary(title, markdown, html) {
  return {
    title_length: title.length,
    markdown_chars: markdown.length,
    plain_text_chars: markdownToPlainText(markdown).length,
    html_chars: html.length,
  };
}

function emptyArticleSummary(title) {
  return {
    title_length: title.length,
    markdown_chars: 0,
    plain_text_chars: 0,
    html_chars: 0,
  };
}

function resolveMode(options) {
  if (options.inspect) return 'inspect';
  if (options.publish) return 'publish';
  if (options.draft) return 'draft';
  return 'dry-run';
}

function firstNonEmptyLine(markdown) {
  return String(markdown ?? '').split('\n').find((line) => line.trim())?.trim() ?? '';
}

function normalizeHeading(value) {
  return String(value ?? '').trim().replace(/^#+\s*/, '').replace(/\s+/g, ' ').toLowerCase();
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function canonicalDraftText(value) {
  return normalizeText(value)
    .replace(/编辑\s+提供字幕（可选）/g, ' ')
    .replace(/提供字幕（可选）/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)[-*]\s+/g, '$1')
    .replace(/(^|\s)\d+[.)]\s+/g, '$1');
}

function previewVerificationText(markdown, fallbackText) {
  const operations = xArticleInsertionPlan(markdown);
  if (!operations.some((operation) => operation.type === 'image')) {
    return fallbackText;
  }
  return operations.find((operation) => operation.type === 'rich_text')?.text ?? fallbackText;
}

function isLocalPath(value) {
  const text = String(value ?? '').trim();
  if (/^file:\/\//i.test(text) || /^[A-Za-z]:[\\/]/.test(text)) return true;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text);
}

function resolveLocalImagePath(value, baseDir = process.cwd()) {
  const text = String(value ?? '').trim();
  if (/^file:\/\//i.test(text)) {
    return new URL(text).pathname;
  }
  return resolve(baseDir || process.cwd(), text);
}

function isXArticleEditUrl(value) {
  try {
    const url = new URL(value);
    return isXUrl(value) && /^\/compose\/articles\/edit\/[^/]+/.test(url.pathname);
  } catch {
    return false;
  }
}

function isXArticleListUrl(value) {
  try {
    const url = new URL(value);
    return isXUrl(value) && /^\/compose\/articles\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function isMarkdownDivider(line) {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function parseXPostMarker(line) {
  const match = /^\s*\{\{x:post:(https?:\/\/(?:x\.com|twitter\.com)\/[^}\s]+\/status\/\d+[^}\s]*)\}\}\s*$/i.exec(line);
  return match ? { url: match[1] } : null;
}

function parseXGifMarker(line) {
  const match = /^\s*\{\{x:gif:([^}]+)\}\}\s*$/i.exec(line);
  return match ? { query: match[1].trim() } : null;
}

function isXPostUrl(value) {
  return /^https?:\/\/(?:x\.com|twitter\.com)\/[^/\s]+\/status\/\d+/i.test(value);
}

function xPostHandle(value) {
  return /^https?:\/\/(?:x\.com|twitter\.com)\/([^/\s]+)\/status\/\d+/i.exec(value)?.[1] ?? '';
}

function xPostStatusId(value) {
  return /^https?:\/\/(?:x\.com|twitter\.com)\/[^/\s]+\/status\/(\d+)/i.exec(value)?.[1] ?? '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isXUrl(urlText) {
  try {
    const host = new URL(urlText).hostname.replace(/^www\./, '');
    return X_HOSTS.has(host);
  } catch {
    return false;
  }
}

function sanitizeXUrl(urlText) {
  try {
    const url = new URL(urlText);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

function redactTitle(title) {
  const normalized = String(title ?? '').trim();
  if (!normalized || /^X$|^Twitter$/i.test(normalized)) return normalized;
  return '[redacted]';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function formatError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0];
}

export async function validateXArticleFile(path) {
  return validateReadableFile(path);
}
