import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { buildCandidateEndpoints } from './status.js';

const CSDN_EDITOR_URL = 'https://editor.csdn.net/md/';
const CSDN_HOSTS = new Set(['editor.csdn.net', 'mp.csdn.net', 'passport.csdn.net', 'blog.csdn.net']);
const IMAGE_PLACEHOLDER_RE = /\{\{csdn:image:([A-Za-z0-9_.-]+)\}\}/g;
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

const TITLE_SELECTORS = [
  'input[placeholder*="标题"]',
  'textarea[placeholder*="标题"]',
  '#txtTitle',
  '.article-bar__title input',
  '.title-article input',
  'input[maxlength][type="text"]',
];

const EDITOR_SELECTORS = [
  'textarea[placeholder*="正文"]',
  'textarea[placeholder*="请输入"]',
  '.bytemd-editor textarea',
  '.CodeMirror textarea',
  '.cm-content[contenteditable="true"]',
  '.monaco-editor textarea',
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"]',
  'textarea',
];

const PUBLISH_ENTRY_SELECTORS = [
  'button.btn-publish',
  'button:has-text("发布文章")',
  'a:has-text("发布文章")',
  'button:has-text("发布")',
  '.btn-publish',
  '.publish-bar button',
];

const FINAL_PUBLISH_SELECTORS = [
  'button:has-text("确认发布")',
  'button:has-text("发布")',
  '.el-dialog button:has-text("发布")',
  '.modal button:has-text("发布")',
];

const IMAGE_BUTTON_SELECTORS = [
  'button[title*="图片"]',
  'button[aria-label*="图片"]',
  'button:has-text("图片")',
  '.bytemd-toolbar-icon[bytemd-tippy-path*="image"]',
  '.editor-toolbar button:has-text("图片")',
];

export async function runCsdnPublish(options = {}) {
  const title = String(options.title ?? '').trim();
  const markdownPath = options.markdownFile ? resolve(options.markdownFile) : null;
  const mode = resolveMode(options);
  const timeoutMs = options.timeoutMs ?? 15000;
  const diagnostics = [];

  if (!title && mode !== 'inspect') {
    throw new Error('Missing --title for CSDN publish.');
  }
  if (!markdownPath && mode !== 'inspect') {
    throw new Error('Missing --markdown-file for CSDN publish.');
  }

  if (mode === 'publish' && !isPublishConfirmed(title, options.confirmPublish)) {
    return {
      ok: false,
      command: 'csdn publish',
      mode,
      ready: false,
      article: {
        title_length: title.length,
        markdown_chars: 0,
        image_placeholders: [],
        cover_requested: Boolean(options.cover),
      },
      diagnostics: [
        {
          category: 'publish_confirmation_required',
          message: '--publish requires --confirm-publish with the exact article title before any browser mutation.',
          next_step: `Retry only after visible review with --publish --confirm-publish ${JSON.stringify(title)}.`,
        },
      ],
      next_step: 'Use --draft for normal automation. Use --publish only with an exact title confirmation.',
    };
  }

  const markdown = markdownPath ? await readFile(markdownPath, 'utf8') : '';
  const imageMap = parseImageMap(options.images ?? []);
  const cover = options.cover ? await validateReadableImage(options.cover, 'cover') : null;
  const imageFiles = await validateImageMap(imageMap);
  const prepared = prepareCsdnMarkdown(markdown, {
    title,
    stripTitleHeading: Boolean(options.stripTitleHeading),
  });
  const format = analyzeCsdnMarkdown(prepared.markdown, { title, imageKeys: Object.keys(imageMap) });
  const sourceUrl = options.sourceUrl ? validateSourceUrl(options.sourceUrl) : null;

  if (cover && !cover.ok) {
    diagnostics.push(cover.diagnostic);
  }
  if (sourceUrl && !sourceUrl.ok) {
    diagnostics.push(sourceUrl.diagnostic);
  }
  if (requiresSourceUrl(options.articleType) && !sourceUrl) {
    diagnostics.push({
      category: 'source_url_required',
      message: '--source-url is required when --article-type is repost or translated.',
      next_step: 'Pass the original article URL with --source-url, or use --article-type original.',
    });
  }
  for (const image of imageFiles) {
    if (!image.ok) {
      diagnostics.push(image.diagnostic);
    }
  }
  diagnostics.push(...format.diagnostics);

  if (mode === 'dry-run') {
    return {
      ok: diagnostics.length === 0,
      command: 'csdn publish',
      mode,
      ready: diagnostics.length === 0,
      article: articleSummary(title, prepared.markdown, imageMap, cover),
      format,
      diagnostics,
      next_step: diagnostics.length === 0
        ? 'Run with `--inspect` to check the logged-in CSDN editor, then `--draft` to fill the page.'
        : 'Fix the reported local article issues before opening the CSDN editor.',
    };
  }

  const endpointResult = await connectFirstAvailable(buildCandidateEndpoints(options), { timeoutMs });
  if (!endpointResult.browser) {
    return {
      ok: false,
      command: 'csdn publish',
      mode,
      ready: false,
      article: articleSummary(title, prepared.markdown, imageMap, cover),
      diagnostics: endpointResult.diagnostics,
      next_step: 'Start a Chrome CDP session, for example `poai browser launch --url https://editor.csdn.net/md/`, then log into CSDN and retry.',
    };
  }

  const { browser, endpoint } = endpointResult;
  try {
    const page = await findOrOpenCsdnEditor(browser, { timeoutMs });
    const pageState = await inspectCsdnEditorPage(page);
    if (mode === 'inspect') {
      return {
        ok: true,
        command: 'csdn publish',
        mode,
        ready: pageState.session_state === 'editor_ready',
        endpoint,
        page: pageState,
        diagnostics: pageState.diagnostics,
        next_step: pageState.session_state === 'editor_ready'
          ? 'Run with `--dry-run` for article validation, then `--draft` to fill the editor.'
          : 'Complete CSDN login in the visible browser, then rerun `--inspect`.',
      };
    }

    if (pageState.session_state !== 'editor_ready') {
      return {
        ok: false,
        command: 'csdn publish',
        mode,
        ready: false,
        endpoint,
        page: pageState,
        article: articleSummary(title, prepared.markdown, imageMap, cover),
        diagnostics: pageState.diagnostics,
        next_step: 'Complete CSDN login in the visible browser, then rerun the same command.',
      };
    }

    if (diagnostics.length > 0) {
      return {
        ok: false,
        command: 'csdn publish',
        mode,
        ready: false,
        endpoint,
        page: pageState,
        article: articleSummary(title, prepared.markdown, imageMap, cover),
        format,
        diagnostics,
        next_step: 'Fix local article diagnostics before mutating the CSDN editor.',
      };
    }

    await fillTitle(page, title);
    const insertedImages = await fillMarkdownWithImageUploads(page, prepared.markdown, imageMap, timeoutMs);
    let publishDialog = null;
    let publishSettings = null;
    let settingResults = [];
    let settingDiagnostics = [];
    if (mode === 'draft' || mode === 'publish') {
      publishDialog = await openPublishDialog(page, timeoutMs);
      if (cover) {
        await uploadCover(page, cover.path, timeoutMs);
      }
      if (options.summary) {
        settingResults.push({ field: 'summary', ok: await fillSummary(page, options.summary), expected: String(options.summary).slice(0, 256) });
      }
      if (options.tags?.length) {
        settingResults.push({ field: 'tags', ok: await fillTags(page, options.tags), expected: options.tags.slice(0, 5) });
      }
      if (options.category) {
        settingResults.push({ field: 'category', ok: await selectCategory(page, options.category), expected: options.category });
      }
      if (options.articleType) {
        const expected = normalizeArticleType(options.articleType);
        settingResults.push({ field: 'article_type', ok: await selectArticleType(page, options.articleType), expected });
      }
      if (sourceUrl?.ok) {
        settingResults.push({ field: 'source_url', ok: await fillSourceUrl(page, sourceUrl.url), expected: sourceUrl.url });
      }
      if (options.visibility) {
        const expected = expectedVisibilityReadValue(options.visibility);
        settingResults.push({ field: 'visibility', ok: await selectVisibility(page, options.visibility), expected });
      }
      publishSettings = await readPublishSettings(page);
      settingDiagnostics = validatePublishSettings({
        requested: {
          cover: Boolean(cover),
          summary: options.summary,
          tags: options.tags ?? [],
          category: options.category,
          articleType: options.articleType,
          sourceUrl: sourceUrl?.ok ? sourceUrl.url : undefined,
          visibility: options.visibility,
        },
        results: settingResults,
        settings: publishSettings,
      });
    }
    if (settingDiagnostics.length > 0) {
      return {
        ok: false,
        command: 'csdn publish',
        mode,
        ready: false,
        endpoint,
        page: await inspectCsdnEditorPage(page),
        article: articleSummary(title, prepared.markdown, imageMap, cover),
        inserted_images: insertedImages,
        publish_dialog_opened: Boolean(publishDialog),
        publish_settings: publishSettings,
        setting_results: settingResults,
        diagnostics: settingDiagnostics,
        next_step: 'Some requested CSDN publish settings were not confirmed in the visible page. Inspect the browser and update selectors or inputs before publishing.',
      };
    }
    if (mode === 'publish') {
      await clickFirstVisible(page, FINAL_PUBLISH_SELECTORS, timeoutMs);
    }

    return {
      ok: true,
      command: 'csdn publish',
      mode,
      ready: true,
      endpoint,
      page: await inspectCsdnEditorPage(page),
      article: articleSummary(title, prepared.markdown, imageMap, cover),
      inserted_images: insertedImages,
      publish_dialog_opened: Boolean(publishDialog),
      publish_settings: publishSettings ?? await readPublishSettings(page),
      setting_results: settingResults,
      final_publish_clicked: mode === 'publish',
      diagnostics: [],
      next_step: mode === 'publish'
        ? 'Final publish button was clicked; verify the visible CSDN result page.'
        : 'Draft content was filled. Review the visible browser and run again with `--publish` only when ready.',
    };
  } finally {
    await browser.close();
  }
}

export function analyzeCsdnMarkdown(markdown, options = {}) {
  const diagnostics = [];
  const imageKeys = new Set(options.imageKeys ?? []);
  const placeholders = [...markdown.matchAll(IMAGE_PLACEHOLDER_RE)].map((match) => match[1]);
  const missingImages = placeholders.filter((key) => !imageKeys.has(key));
  for (const key of missingImages) {
    diagnostics.push({
      category: 'missing_image_mapping',
      message: `Markdown contains {{csdn:image:${key}}} but no --image ${key}=<path> mapping was provided.`,
      next_step: `Pass --image ${key}=<local-image-path> or remove the placeholder.`,
    });
  }

  for (const match of markdown.matchAll(MARKDOWN_IMAGE_RE)) {
    const alt = match[1].trim();
    const target = match[2].trim();
    if (!alt) {
      diagnostics.push({
        category: 'image_alt_missing',
        message: 'One Markdown image has an empty alt label.',
        next_step: 'Use meaningful image alt text because CSDN displays it when image rendering fails.',
      });
    }
    if (isLocalMarkdownImageTarget(target)) {
      diagnostics.push({
        category: 'local_markdown_image',
        message: 'A Markdown image points at a local file path, which CSDN cannot render after publishing.',
        next_step: 'Use {{csdn:image:key}} plus --image key=<path>, or replace it with a public image URL.',
      });
    }
  }

  const firstHeading = firstNonEmptyLine(markdown);
  if (options.title && firstHeading && normalizeHeading(firstHeading) === normalizeHeading(`# ${options.title}`)) {
    diagnostics.push({
      category: 'duplicate_title_heading',
      severity: 'warning',
      message: 'The first H1 heading duplicates the CSDN title field.',
      next_step: 'Prefer removing the duplicate H1 or pass --strip-title-heading.',
    });
  }

  if (hasOpeningCodeFenceWithoutLanguage(markdown)) {
    diagnostics.push({
      category: 'code_fence_language_missing',
      severity: 'warning',
      message: 'One or more code fences do not declare a language.',
      next_step: 'Use fenced blocks such as ```js or ```bash so CSDN syntax highlighting is stable.',
    });
  }

  return {
    placeholder_count: placeholders.length,
    placeholders,
    diagnostics,
  };
}

export function prepareCsdnMarkdown(markdown, options = {}) {
  let output = markdown.replace(/\r\n/g, '\n').trim();
  if (options.stripTitleHeading && options.title) {
    const lines = output.split('\n');
    if (lines.length > 0 && normalizeHeading(lines[0]) === normalizeHeading(`# ${options.title}`)) {
      output = lines.slice(1).join('\n').trimStart();
    }
  }

  output = output
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n(#{1,6}\s+)/g, '\n\n$1')
    .replace(/([^\n])\n(```[A-Za-z0-9_-]*\n)/g, '$1\n\n$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { markdown: `${output}\n` };
}

export function parseImageMap(values) {
  const map = {};
  for (const value of values) {
    const index = value.indexOf('=');
    if (index <= 0 || index === value.length - 1) {
      throw new Error(`Invalid --image value: ${value}. Expected key=/path/to/image.png`);
    }
    const key = value.slice(0, index).trim();
    const path = value.slice(index + 1).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
      throw new Error(`Invalid --image key: ${key}. Use letters, numbers, dot, underscore, or dash.`);
    }
    map[key] = resolve(path);
  }
  return map;
}

export function isPublishConfirmed(title, confirmation) {
  return String(confirmation ?? '').trim() === String(title ?? '').trim() && String(title ?? '').trim().length > 0;
}

export function validateSourceUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('unsupported protocol');
    }
    return { ok: true, url: url.toString() };
  } catch {
    return {
      ok: false,
      diagnostic: {
        category: 'source_url_invalid',
        message: '--source-url must be an http or https URL.',
        next_step: 'Pass a valid original article URL, for example --source-url https://example.com/article.',
      },
    };
  }
}

export async function inspectCsdnEditorPage(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  const url = page.url();
  const title = await page.title().catch(() => '');
  const signals = {
    login_required: isCsdnLoginUrl(url) || await isPresent(page, 'input[type="password"], button:has-text("微信登录"), button:has-text("验证码登录"), a[href*="passport.csdn.net/login"]'),
    title_input: await hasAny(page, TITLE_SELECTORS),
    editor: await hasAny(page, EDITOR_SELECTORS),
    file_input: await isPresent(page, 'input[type="file"]'),
    publish_button: await hasAny(page, PUBLISH_ENTRY_SELECTORS),
    cover_text: await isPresent(page, 'text=封面'),
  };
  const diagnostics = [];
  let sessionState = 'unknown';
  if (signals.login_required) {
    sessionState = 'login_required';
    diagnostics.push({
      category: 'login_required',
      message: 'CSDN redirected the editor to a login surface.',
      next_step: 'Log into CSDN in the visible managed browser and rerun the command.',
    });
  } else if (signals.title_input && signals.editor) {
    sessionState = 'editor_ready';
  } else {
    sessionState = 'editor_unknown';
    diagnostics.push({
      category: 'editor_controls_not_found',
      message: 'CSDN page loaded, but title/editor controls were not both detected.',
      next_step: 'Inspect the visible browser for UI drift, then update selectors if needed.',
    });
  }
  return { url: sanitizeCsdnUrl(url), title, session_state: sessionState, signals, diagnostics };
}

async function fillTitle(page, title) {
  const locator = await firstVisible(page, TITLE_SELECTORS);
  await locator.fill(title);
}

async function fillMarkdownWithImageUploads(page, markdown, imageMap, timeoutMs) {
  await clearEditor(page);
  const imageEntries = Object.entries(imageMap);
  if (imageEntries.length === 0) {
    await importMarkdownSource(page, markdown, timeoutMs);
    return [];
  }
  const inserted = [];
  const replacements = {};
  for (const [key, imagePath] of imageEntries) {
    const uploaded = await uploadEditorImageAtCursor(page, imagePath, timeoutMs);
    replacements[key] = uploaded.markdown ?? '';
    inserted.push({ key, uploaded });
  }
  const finalMarkdown = markdown.replace(IMAGE_PLACEHOLDER_RE, (_match, key) => replacements[key] || '');
  await importMarkdownSource(page, finalMarkdown, timeoutMs);
  return inserted;
}

async function clearEditor(page) {
  const editor = await firstVisible(page, EDITOR_SELECTORS);
  await editor.click({ timeout: 5000 });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
}

async function insertEditorText(page, text) {
  if (!text) return;
  const editor = await firstVisible(page, EDITOR_SELECTORS);
  await editor.click({ timeout: 5000 });
  await pasteText(page, text);
}

async function importMarkdownSource(page, markdown, timeoutMs) {
  const input = page.locator('#import-markdown-file-input').first();
  if (await input.count()) {
    const dir = await mkdtemp(join(tmpdir(), 'csdn-publish-'));
    const file = join(dir, 'article.md');
    await writeFile(file, markdown, 'utf8');
    const before = await readEditorText(page);
    await input.setInputFiles(file);
    await page.waitForFunction(
      ({ beforeText }) => {
        const el = document.querySelector('[contenteditable="true"]');
        const text = el?.innerText ?? '';
        return text && text !== beforeText;
      },
      { beforeText: before },
      { timeout: timeoutMs },
    ).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return;
  }
  await clearEditor(page);
  await insertEditorText(page, markdown);
}

async function uploadEditorImageAtCursor(page, imagePath, timeoutMs) {
  const before = await readEditorText(page);
  const clicked = await clickFirstVisible(page, IMAGE_BUTTON_SELECTORS, 3000).catch(() => null);
  const input = await firstVisible(page, [
    'input[type="file"][accept*="image"]',
    'input[type="file"]',
  ], { includeHidden: true });
  await input.setInputFiles(imagePath);
  await page.waitForFunction(
    ({ beforeText }) => {
      const text = readLikelyEditorText();
      return text !== beforeText && /!\[[^\]]*\]\(https?:\/\/[^)]+\)|i-blog\.csdnimg\.cn|img-blog\.csdnimg\.cn/.test(text);
      function readLikelyEditorText() {
        const selectors = [
          'textarea[placeholder*="正文"]',
          'textarea[placeholder*="请输入"]',
          '.bytemd-editor textarea',
          '.CodeMirror textarea',
          '.cm-content[contenteditable="true"]',
          '[contenteditable="true"]',
          'textarea',
        ];
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (!el) continue;
          const value = 'value' in el ? el.value : el.innerText;
          if (value) return value;
        }
        return document.body.innerText;
      }
    },
    { beforeText: before },
    { timeout: timeoutMs },
  ).catch(() => {});
  const text = await readEditorText(page);
  const markdown = extractLastMarkdownImage(text);
  return { toolbar_clicked: Boolean(clicked), image_path: '[redacted]', markdown };
}

async function readEditorText(page) {
  return page.evaluate((selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const value = 'value' in el ? el.value : el.innerText;
      if (value) return value;
    }
    return '';
  }, EDITOR_SELECTORS);
}

function extractLastMarkdownImage(text) {
  const matches = [...String(text ?? '').matchAll(MARKDOWN_IMAGE_RE)];
  return matches.length > 0 ? matches[matches.length - 1][0] : '';
}

async function openPublishDialog(page, timeoutMs) {
  if (await page.locator('.modal__publish-article').count()) {
    return true;
  }
  return clickFirstVisible(page, PUBLISH_ENTRY_SELECTORS, timeoutMs);
}

async function uploadCover(page, coverPath, timeoutMs) {
  await page.getByText('封面', { exact: false }).first().waitFor({ timeout: 3000 }).catch(() => {});
  if (await hasVisibleUploadedCover(page)) {
    return;
  }
  const candidateInputs = page.locator('input[type="file"][accept=".png,.jpg,.jpeg,.gif"], input[type="file"][accept*=".png"]');
  const count = await candidateInputs.count();
  if (count === 0) {
    throw new Error('No cover image file input was found after opening the CSDN publish dialog.');
  }
  await candidateInputs.last().setInputFiles(coverPath);
  await page.waitForTimeout(1000);
  const confirm = page.getByText('确认上传', { exact: false }).last();
  if (await confirm.count()) {
    await confirm.click({ timeout: timeoutMs });
  }
  await page.waitForFunction(
    () => [...document.querySelectorAll('.modal__publish-article img')]
      .some((img) => img.getBoundingClientRect().width > 50 && /i-blog\.csdnimg\.cn|img-blog\.csdnimg\.cn/.test(img.src)),
    null,
    { timeout: timeoutMs },
  ).catch(() => {});
}

async function hasVisibleUploadedCover(page) {
  return page.evaluate(() => [...document.querySelectorAll('.modal__publish-article .container-coverimage-box img.preview')]
    .some((img) => {
      const rect = img.getBoundingClientRect();
      return rect.width > 50 && rect.height > 30 && /i-blog\.csdnimg\.cn|img-blog\.csdnimg\.cn/.test(img.src);
    })).catch(() => false);
}

async function fillTags(page, tags) {
  const addButton = page.locator('.modal__publish-article button.tag__btn-tag').first();
  await addButton.click({ timeout: 5000 });
  const input = await firstVisible(page, [
    'input[placeholder*="自定义标签"]',
    'input[placeholder*="搜索"]',
  ]);
  for (const tag of tags.slice(0, 5)) {
    await input.fill(tag);
    await input.press('Enter');
    await page.waitForTimeout(300);
  }
  await closeTopNestedModal(page);
  return true;
}

async function selectCategory(page, category) {
  await closeVisibleOptionsPanel(page);
  const buttons = page.locator('.modal__publish-article button.tag__btn-tag');
  if (await buttons.count() < 2) return false;
  await buttons.nth(1).click({ timeout: 5000 });
  await page.waitForTimeout(500);
  const option = page.locator(`.tag__options-content:visible .tag__option-box:has-text("${cssEscape(category)}")`).first();
  if (await option.count()) {
    const box = await option.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    } else {
      await option.click({ timeout: 5000, force: true });
    }
    await page.waitForTimeout(300);
    await closeVisibleOptionsPanel(page);
    return true;
  }
  return false;
}

async function fillSummary(page, summary) {
  const textarea = page.locator('.modal__publish-article textarea.el-textarea__inner').first();
  if (await textarea.count()) {
    await textarea.fill(String(summary).slice(0, 256));
    return true;
  }
  return false;
}

async function fillSourceUrl(page, sourceUrl) {
  const input = page.locator([
    '.modal__publish-article input[placeholder*="原文"]',
    '.modal__publish-article input[placeholder*="来源"]',
    '.modal__publish-article input[placeholder*="链接"]',
    '.modal__publish-article input[placeholder*="转载"]',
  ].join(', ')).first();
  if (await input.count()) {
    await input.fill(sourceUrl);
    return true;
  }
  return false;
}

async function selectArticleType(page, articleType) {
  const normalized = normalizeArticleType(articleType);
  if (!normalized) return false;
  const input = page.locator(`#${normalized}`);
  if (await input.count()) {
    await input.check({ force: true });
    return true;
  }
  return false;
}

async function selectVisibility(page, visibility) {
  const normalized = normalizeVisibility(visibility);
  if (!normalized) return false;
  const input = page.locator(`#${normalized}`);
  if (await input.count()) {
    await input.check({ force: true });
    return true;
  }
  return false;
}

async function closeTopNestedModal(page) {
  const buttons = page.locator('.modal__publish-article .modal__close-button:visible');
  const count = await buttons.count();
  if (count > 1) {
    await buttons.nth(count - 1).click({ timeout: 5000 });
    await page.waitForTimeout(300);
  }
}

async function closeVisibleOptionsPanel(page) {
  const closeButton = page.locator('.tag__options-content:visible .modal__close-button').first();
  if (await closeButton.count()) {
    await closeButton.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function pasteText(page, text) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  const pasted = await page.evaluate(async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      return false;
    }
  }, text).catch(() => false);
  if (pasted) {
    await page.keyboard.press(`${modifier}+V`);
  } else {
    await page.keyboard.insertText(text);
  }
  await page.waitForTimeout(300);
}

async function readPublishSettings(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const modal = document.querySelector('.modal__publish-article');
    if (!modal) return null;
    return {
      cover_uploaded: [...modal.querySelectorAll('img')].some((img) => visible(img) && /i-blog\.csdnimg\.cn|img-blog\.csdnimg\.cn/.test(img.src)),
      summary: modal.querySelector('textarea.el-textarea__inner')?.value ?? '',
      source_url: [...modal.querySelectorAll('input')].find((el) => /原文|来源|链接|转载/.test(el.placeholder || '') && el.value)?.value ?? '',
      tags_text: [...modal.querySelectorAll('.form-entry')].find((el) => /文章标签/.test(el.innerText))?.innerText ?? '',
      category_text: [...modal.querySelectorAll('.form-entry')].find((el) => /分类专栏/.test(el.innerText))?.innerText ?? '',
      article_type: [...modal.querySelectorAll('input[type="radio"]')].find((el) => el.checked && ['original', 'repost', 'translated'].includes(el.value))?.value ?? '',
      visibility: [...modal.querySelectorAll('input[type="radio"]')].find((el) => el.checked && ['public', 'private', 'read_need_fans', 'read_need_vip'].includes(el.value))?.value ?? '',
    };
  });
}

async function findOrOpenCsdnEditor(browser, options = {}) {
  const contexts = browser.contexts();
  for (const context of contexts) {
    for (const page of context.pages()) {
      if (isCsdnUrl(page.url())) {
        return page;
      }
    }
  }
  const context = contexts[0] ?? await browser.newContext();
  const page = await context.newPage();
  await page.goto(CSDN_EDITOR_URL, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs ?? 15000 });
  return page;
}

async function connectFirstAvailable(endpoints, options) {
  const diagnostics = [];
  for (const endpoint of endpoints) {
    try {
      const timeoutMs = options.timeoutMs ?? 5000;
      const response = await fetchWithTimeout(`${endpoint}/json/version`, timeoutMs);
      if (!response.ok) {
        diagnostics.push({
          category: 'not_cdp_endpoint',
          endpoint,
          message: `${endpoint}/json/version returned HTTP ${response.status}.`,
          next_step: 'Use a Chrome remote debugging endpoint that exposes `/json/version`.',
        });
        continue;
      }
      const browser = await chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
      return { endpoint, browser, diagnostics };
    } catch (error) {
      diagnostics.push({
        category: 'browser_not_found',
        endpoint,
        message: formatError(error),
        next_step: 'Confirm Chrome is running with a remote debugging port.',
      });
    }
  }
  return { endpoint: null, browser: null, diagnostics };
}

async function validateImageMap(imageMap) {
  const results = [];
  for (const [key, imagePath] of Object.entries(imageMap)) {
    results.push(await validateReadableImage(imagePath, `image:${key}`));
  }
  return results;
}

async function validateReadableImage(imagePath, label) {
  const resolved = resolve(imagePath);
  try {
    const info = await stat(resolved);
    if (!info.isFile()) {
      return {
        ok: false,
        label,
        diagnostic: {
          category: 'file_not_regular',
          message: `${label} is not a regular file.`,
          next_step: 'Use a readable png, jpg, jpeg, gif, or webp image file.',
        },
      };
    }
    await access(resolved);
    const ext = resolved.toLowerCase().split('.').pop();
    if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
      return {
        ok: false,
        label,
        diagnostic: {
          category: 'image_file_unsupported',
          message: `${label} has an unsupported image extension.`,
          next_step: 'Use png, jpg, jpeg, gif, or webp.',
        },
      };
    }
    return { ok: true, label, path: resolved };
  } catch {
    return {
      ok: false,
      label,
      diagnostic: {
        category: 'file_not_found',
        message: `${label} was not found or is not readable.`,
        next_step: 'Check the local image path and retry.',
      },
    };
  }
}

function articleSummary(title, markdown, imageMap, cover) {
  return {
    title_length: title.length,
    markdown_chars: markdown.length,
    image_placeholders: Object.keys(imageMap),
    cover_requested: Boolean(cover),
  };
}

function resolveMode(options) {
  if (options.inspect) return 'inspect';
  if (options.publish) return 'publish';
  if (options.draft) return 'draft';
  return 'dry-run';
}

async function clickFirstVisible(page, selectors, timeoutMs) {
  const locator = await firstVisible(page, selectors, { timeoutMs });
  await locator.click({ timeout: timeoutMs });
  return true;
}

async function firstVisible(page, selectors, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;
      if (options.includeHidden || await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`No matching visible element found for selectors: ${selectors.join(', ')}`);
}

async function hasAny(page, selectors) {
  for (const selector of selectors) {
    if (await isPresent(page, selector)) return true;
  }
  return false;
}

async function isPresent(page, selector) {
  try {
    return (await page.locator(selector).count()) > 0;
  } catch {
    return false;
  }
}

function isCsdnUrl(urlText) {
  try {
    const host = new URL(urlText).hostname.replace(/^www\./, '');
    return CSDN_HOSTS.has(host);
  } catch {
    return false;
  }
}

function isCsdnLoginUrl(urlText) {
  try {
    const url = new URL(urlText);
    return url.hostname === 'passport.csdn.net' || url.pathname.includes('/login');
  } catch {
    return false;
  }
}

function sanitizeCsdnUrl(urlText) {
  try {
    const url = new URL(urlText);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

function isLocalMarkdownImageTarget(target) {
  if (/^(https?:)?\/\//i.test(target)) return false;
  if (/^(data|blob):/i.test(target)) return false;
  if (target.startsWith('csdn:') || target.startsWith('local:')) return true;
  return /\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(target);
}

function firstNonEmptyLine(markdown) {
  return markdown.split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
}

function normalizeHeading(value) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeArticleType(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return {
    original: 'original',
    原创: 'original',
    repost: 'repost',
    reprint: 'repost',
    转载: 'repost',
    translated: 'translated',
    translate: 'translated',
    翻译: 'translated',
  }[normalized] ?? null;
}

function requiresSourceUrl(articleType) {
  const normalized = normalizeArticleType(articleType);
  return normalized === 'repost' || normalized === 'translated';
}

function normalizeVisibility(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return {
    public: 'public',
    all: 'public',
    全部可见: 'public',
    private: 'private',
    onlyme: 'private',
    仅我可见: 'private',
    fans: 'needfans',
    read_need_fans: 'needfans',
    粉丝可见: 'needfans',
    vip: 'needvip',
    read_need_vip: 'needvip',
    VIP可见: 'needvip',
    'vip可见': 'needvip',
  }[normalized] ?? null;
}

function expectedVisibilityReadValue(value) {
  const normalized = normalizeVisibility(value);
  return {
    public: 'public',
    private: 'private',
    needfans: 'read_need_fans',
    needvip: 'read_need_vip',
  }[normalized] ?? null;
}

export function validatePublishSettings({ requested, results, settings }) {
  const diagnostics = [];
  if (!settings) {
    diagnostics.push({
      category: 'publish_settings_unreadable',
      message: 'The CSDN publish settings dialog could not be read after filling fields.',
      next_step: 'Inspect the visible browser and update publish dialog selectors.',
    });
    return diagnostics;
  }
  for (const result of results) {
    if (!result.ok) {
      diagnostics.push({
        category: `${result.field}_not_filled`,
        message: `Requested CSDN field ${result.field} could not be filled.`,
        next_step: 'Inspect the visible browser and update the field selector or requested value.',
      });
    }
  }
  if (requested.cover && !settings.cover_uploaded) {
    diagnostics.push({
      category: 'cover_not_confirmed',
      message: 'A cover image was requested, but the publish dialog does not show an uploaded CSDN cover.',
      next_step: 'Inspect the cover upload/crop modal and update cover selectors if needed.',
    });
  }
  if (requested.summary && String(settings.summary ?? '').trim() !== String(requested.summary).slice(0, 256).trim()) {
    diagnostics.push({
      category: 'summary_not_confirmed',
      message: 'The requested summary was not confirmed in CSDN publish settings.',
      next_step: 'Inspect the summary textarea selector and retry draft mode.',
    });
  }
  for (const tag of requested.tags.slice(0, 5)) {
    if (!String(settings.tags_text ?? '').includes(tag)) {
      diagnostics.push({
        category: 'tag_not_confirmed',
        message: `The requested tag "${tag}" was not confirmed in CSDN publish settings.`,
        next_step: 'Inspect the tag picker and retry draft mode.',
      });
    }
  }
  if (requested.category && !String(settings.category_text ?? '').includes(requested.category)) {
    diagnostics.push({
      category: 'category_not_confirmed',
      message: `The requested category "${requested.category}" was not confirmed in CSDN publish settings.`,
      next_step: 'Inspect the category picker and retry with an existing CSDN category name.',
    });
  }
  const expectedArticleType = normalizeArticleType(requested.articleType);
  if (expectedArticleType && settings.article_type !== expectedArticleType) {
    diagnostics.push({
      category: 'article_type_not_confirmed',
      message: `The requested article type "${expectedArticleType}" was not confirmed in CSDN publish settings.`,
      next_step: 'Inspect the article type radio selectors and retry draft mode.',
    });
  }
  if (requested.sourceUrl && String(settings.source_url ?? '').trim() !== String(requested.sourceUrl).trim()) {
    diagnostics.push({
      category: 'source_url_not_confirmed',
      message: 'The requested source URL was not confirmed in CSDN publish settings.',
      next_step: 'Inspect the repost/translated source URL input selector and retry draft mode.',
    });
  }
  const expectedVisibility = expectedVisibilityReadValue(requested.visibility);
  if (expectedVisibility && settings.visibility !== expectedVisibility) {
    diagnostics.push({
      category: 'visibility_not_confirmed',
      message: `The requested visibility "${expectedVisibility}" was not confirmed in CSDN publish settings.`,
      next_step: 'Inspect the visibility radio selectors and retry draft mode.',
    });
  }
  return diagnostics;
}

function cssEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function hasOpeningCodeFenceWithoutLanguage(markdown) {
  let insideFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('```')) continue;
    if (!insideFence) {
      if (trimmed === '```') return true;
      insideFence = true;
    } else {
      insideFence = false;
    }
  }
  return false;
}

function formatError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0];
}

async function fetchWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
