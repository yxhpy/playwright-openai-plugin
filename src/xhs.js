import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { buildCandidateEndpoints } from './status.js';

const XHS_PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official';
const XHS_HOSTS = new Set(['creator.xiaohongshu.com', 'www.xiaohongshu.com', 'edith.xiaohongshu.com']);
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

const TITLE_SELECTORS = [
  'input[placeholder*="标题"]',
  'textarea[placeholder*="标题"]',
  '[contenteditable="true"][placeholder*="标题"]',
  '[role="textbox"][aria-label*="标题"]',
];
const BODY_SELECTORS = [
  'textarea[placeholder*="正文"]',
  'textarea[placeholder*="描述"]',
  'textarea[placeholder*="分享"]',
  'textarea[placeholder*="添加正文"]',
  '[contenteditable="true"][data-placeholder*="正文"]',
  '[contenteditable="true"][data-placeholder*="描述"]',
  '[contenteditable="true"][placeholder*="正文"]',
  '[contenteditable="true"][role="textbox"]',
  '[role="textbox"][contenteditable="true"]',
  '[contenteditable="true"]',
];
const FILE_INPUT_SELECTORS = [
  'input[type="file"][accept*="image"]',
  'input[type="file"][accept*="video"]',
  'input[type="file"]',
];
const UPLOAD_ENTRY_SELECTORS = [
  'button:has-text("上传")',
  'div:has-text("上传图文")',
  'div:has-text("上传图片")',
  'span:has-text("上传图文")',
  'span:has-text("上传图片")',
  '[class*="upload"]',
];
const PUBLISH_SELECTORS = [
  'button:has-text("发布")',
  'button:has-text("提交")',
  'div[role="button"]:has-text("发布")',
  '.publishBtn',
  '[class*="publish"]:has-text("发布")',
];
const CONTENT_TYPE_OPTIONS = new Map([
  ['fiction', '虚构演绎，仅供娱乐'],
  ['ai', '笔记含AI合成内容'],
  ['marketing', '内容包含营销广告'],
  ['source', '内容来源声明'],
]);
const VISIBILITY_OPTIONS = new Map([
  ['public', '公开可见'],
  ['private', '仅自己可见'],
  ['mutual', '仅互关好友可见'],
  ['include', '只给谁看'],
  ['exclude', '不给谁看'],
]);
const SUPPORTED_IMAGE_RE = /\.(?:jpe?g|png|webp)$/i;
const MAX_XHS_IMAGES = 18;
const LOGIN_SELECTORS = [
  'input[placeholder*="手机号"]',
  'input[placeholder*="验证码"]',
  'button:has-text("登录")',
  'button:has-text("扫码登录")',
  'text=/APP扫一扫登录|解锁创作者专属功能/',
  'text=/登录|扫码|验证码/',
];

export async function runXhsPublish(options = {}) {
  if (options.capabilities) {
    return runXhsCapabilities();
  }
  const mode = resolveMode(options);
  const title = String(options.title ?? '').trim();
  const markdownPath = options.markdownFile ? resolve(options.markdownFile) : null;
  const imagePaths = options.images ?? [];
  const timeoutMs = options.timeoutMs ?? 15000;

  if (!title && mode !== 'inspect') {
    throw new Error('Missing --title for Xiaohongshu publish.');
  }
  if (!markdownPath && mode !== 'inspect') {
    throw new Error('Missing --markdown-file for Xiaohongshu publish.');
  }
  if (mode === 'publish' && !isPublishConfirmed(title, options.confirmPublish)) {
    return {
      ok: false,
      command: 'xhs publish',
      mode,
      ready: false,
      article: emptyNoteSummary(title),
      diagnostics: [{
        category: 'publish_confirmation_required',
        message: '--publish requires --confirm-publish with the exact note title before any browser mutation.',
        next_step: `Review the visible Xiaohongshu draft first, then retry with --publish --confirm-publish ${JSON.stringify(title)}.`,
      }],
      next_step: 'Use --draft for normal automation. Use --publish only after visible browser review.',
    };
  }

  const markdown = markdownPath ? await readFile(markdownPath, 'utf8') : '';
  const images = await validateImages(imagePaths);
  const prepared = prepareXhsMarkdown(markdown, {
    title,
    stripTitleHeading: Boolean(options.stripTitleHeading),
    topics: options.topics ?? [],
  });
  const format = analyzeXhsMarkdown(prepared.markdown, { title, imageCount: images.length });
  const article = noteSummary(title, prepared.text, images);
  const imageDiagnostics = images.filter((image) => !image.ok).map((image) => image.diagnostic);
  const diagnostics = [...imageDiagnostics, ...format.diagnostics];

  if (mode === 'dry-run') {
    return {
      ok: blockingDiagnostics(diagnostics).length === 0,
      command: 'xhs publish',
      mode,
      ready: blockingDiagnostics(diagnostics).length === 0,
      article,
      format,
      diagnostics,
      next_step: diagnostics.length === 0
        ? 'Run --inspect after logging into Xiaohongshu Creator, then --draft to fill the visible note editor.'
        : 'Fix the reported note issues before opening the Xiaohongshu editor.',
    };
  }

  const endpointResult = await connectFirstAvailable(buildCandidateEndpoints(options), { timeoutMs });
  if (!endpointResult.browser) {
    return {
      ok: false,
      command: 'xhs publish',
      mode,
      ready: false,
      article,
      diagnostics: endpointResult.diagnostics,
      next_step: 'Start a managed CDP browser, for example `poai browser launch --url https://creator.xiaohongshu.com/publish/publish?source=official`, log into Xiaohongshu Creator, then retry.',
    };
  }

  const { browser, endpoint } = endpointResult;
  try {
    const page = await findOrOpenXhsPublisher(browser, { timeoutMs });
    const pageState = await inspectXhsPublisherPage(page);
    if (mode === 'inspect') {
      return {
        ok: true,
        command: 'xhs publish',
        mode,
        ready: pageState.session_state === 'editor_ready',
        endpoint,
        page: pageState,
        diagnostics: pageState.diagnostics,
        next_step: pageState.session_state === 'editor_ready'
          ? 'Run --dry-run for local validation, then --draft to fill the visible Xiaohongshu editor.'
          : 'Complete Xiaohongshu login in the visible browser, open the publish page, then rerun --inspect.',
      };
    }

    const blockers = blockingDiagnostics(diagnostics);
    if (blockers.length > 0) {
      return {
        ok: false,
        command: 'xhs publish',
        mode,
        ready: false,
        endpoint,
        page: pageState,
        article,
        format,
        diagnostics: blockers,
        next_step: 'Fix local note diagnostics before mutating the Xiaohongshu editor.',
      };
    }

    if (pageState.session_state !== 'editor_ready') {
      return {
        ok: false,
        command: 'xhs publish',
        mode,
        ready: false,
        endpoint,
        page: pageState,
        article,
        diagnostics: pageState.diagnostics,
        next_step: 'Complete Xiaohongshu login and open the publish page in the visible browser, then rerun the command.',
      };
    }

    const uploadedImages = await uploadXhsImages(page, images.map((image) => image.path), timeoutMs);
    await fillXhsTitle(page, title);
    await fillXhsBody(page, prepared.text);
    const settings = await applyXhsSettings(page, options, timeoutMs);

    if (mode === 'publish') {
      await clickFirstVisible(page, PUBLISH_SELECTORS, timeoutMs);
    }

    const verification = await readXhsDraft(page);
    const draftDiagnostics = verifyDraftContent({ title, text: prepared.text, minImages: images.length }, verification);
    let saveDraftClicked = false;
    if (options.saveDraft) {
      await clickFirstVisible(page, ['button:has-text("暂存离开")', 'div[role="button"]:has-text("暂存离开")'], timeoutMs);
      saveDraftClicked = true;
      await page.waitForTimeout(1000);
    }
    return {
      ok: draftDiagnostics.length === 0,
      command: 'xhs publish',
      mode,
      ready: draftDiagnostics.length === 0,
      endpoint,
      page: await inspectXhsPublisherPage(page),
      article,
      draft: verification,
      uploaded_images: uploadedImages,
      settings,
      final_publish_clicked: mode === 'publish',
      save_draft_clicked: saveDraftClicked,
      diagnostics: draftDiagnostics,
      next_step: mode === 'publish'
        ? 'The Xiaohongshu publish control was clicked; verify the visible result page.'
        : 'Draft content was filled. Review the visible browser and use --publish only with exact title confirmation.',
    };
  } finally {
    await browser.close();
  }
}

export function runXhsCapabilities() {
  return {
    ok: true,
    command: 'xhs publish',
    mode: 'capabilities',
    ready: true,
    supported: {
      browser_inspect: true,
      image_text_tab_switch: true,
      image_upload: {
        supported: true,
        max_files_observed: MAX_XHS_IMAGES,
        extensions_observed: ['.jpg', '.jpeg', '.png', '.webp'],
        flag: '--image <path>',
      },
      title: { supported: true, flag: '--title <text>' },
      body_markdown_to_text: { supported: true, flag: '--markdown-file <file.md>' },
      topics: { supported: true, flag: '--topic <name>', behavior: 'Appends #topic text into the body before filling.' },
      original_declaration: { supported: true, flag: '--original true|false' },
      content_type_declaration: {
        supported: true,
        flag: '--content-type <fiction|ai|marketing|source>',
        labels: Object.fromEntries(CONTENT_TYPE_OPTIONS),
      },
      location: { supported: 'best_effort', flag: '--location <query>', behavior: 'Searches the location picker and chooses the first matching visible result.' },
      visibility: {
        supported: true,
        flag: '--visibility <public|private|mutual|include|exclude>',
        labels: Object.fromEntries(VISIBILITY_OPTIONS),
      },
      allow_duet: { supported: true, flag: '--allow-duet true|false' },
      allow_copy: { supported: true, flag: '--allow-copy true|false' },
      schedule_publish: {
        supported: true,
        flag: '--schedule-at "YYYY-MM-DD HH:mm"',
        behavior: 'Toggles 定时发布, fills the observed schedule input, and leaves the final click behind the normal publish confirmation gate.',
      },
      save_draft: {
        supported: true,
        flag: '--save-draft',
        behavior: 'Clicks 暂存离开 after filling the draft. This is opt-in because it navigates away from the editor.',
      },
    },
    not_yet_supported: {
      final_publish_without_confirmation: 'Intentionally unsupported; use --publish --confirm-publish <exact title>.',
      cover_editing: 'Observed 图片编辑/封面建议, but crop/template editing is visual and remains manual.',
      image_marker: 'Observed 标记地点或标记朋友, but per-image hotspot selection is visual and remains manual.',
      group_chat: 'Observed 选择群聊, but this account currently has no groups; selection remains manual.',
      live_preview: 'Observed 关联直播预告; account/live-state dependent and remains manual.',
      travel_route: 'Observed 添加路线/选择文件; route-file format and picker behavior remain manual.',
      smart_title: 'Observed 智能标题 suggestions; script keeps caller-provided --title for deterministic drafts.',
    },
  };
}

export function analyzeXhsMarkdown(markdown, options = {}) {
  const diagnostics = [];
  const normalized = String(markdown ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    diagnostics.push({
      category: 'empty_note',
      message: 'The Xiaohongshu note body is empty.',
      next_step: 'Add note body content before drafting.',
    });
  }
  if ((options.imageCount ?? 0) === 0) {
    diagnostics.push({
      category: 'media_required',
      message: 'Xiaohongshu publish flow requires at least one local image or video upload for an automated draft.',
      next_step: 'Pass one or more --image <local-media-path> values.',
    });
  }
  if ((options.imageCount ?? 0) > MAX_XHS_IMAGES) {
    diagnostics.push({
      category: 'too_many_images',
      message: `Xiaohongshu image-text upload accepts up to ${MAX_XHS_IMAGES} images in the observed web editor.`,
      next_step: `Pass ${MAX_XHS_IMAGES} or fewer --image values.`,
    });
  }
  if (String(options.title ?? '').trim().length > 20) {
    diagnostics.push({
      category: 'title_may_be_too_long',
      severity: 'warning',
      message: 'Xiaohongshu note titles are short in the web editor; long titles may be truncated or rejected.',
      next_step: 'Prefer a concise title around 20 Chinese characters or fewer.',
    });
  }
  if (markdownToXhsText(normalized).length > 1000) {
    diagnostics.push({
      category: 'body_too_long',
      message: 'The prepared note body is over 1000 characters.',
      next_step: 'Shorten the Xiaohongshu body or split it into multiple notes.',
    });
  }

  const firstHeading = firstNonEmptyLine(normalized);
  if (options.title && firstHeading && normalizeHeading(firstHeading) === normalizeHeading(`# ${options.title}`)) {
    diagnostics.push({
      category: 'duplicate_title_heading',
      severity: 'warning',
      message: 'The first H1 heading duplicates the Xiaohongshu title field.',
      next_step: 'Prefer removing the duplicate H1 or pass --strip-title-heading.',
    });
  }

  for (const match of normalized.matchAll(MARKDOWN_IMAGE_RE)) {
    const target = match[2].trim();
    diagnostics.push({
      category: isLocalPath(target) ? 'local_markdown_image_unsupported' : 'markdown_image_ignored',
      message: 'Markdown image syntax is not mapped into the Xiaohongshu editor by this script.',
      next_step: 'Pass local media through --image in display order and keep image captions in body text.',
    });
  }

  return {
    chars: normalized.length,
    prepared_text_chars: markdownToXhsText(normalized).length,
    image_count: options.imageCount ?? 0,
    diagnostics,
  };
}

export function prepareXhsMarkdown(markdown, options = {}) {
  let output = String(markdown ?? '').replace(/\r\n/g, '\n').trim();
  if (options.stripTitleHeading && options.title) {
    const lines = output.split('\n');
    if (lines.length > 0 && normalizeHeading(lines[0]) === normalizeHeading(`# ${options.title}`)) {
      output = lines.slice(1).join('\n').trimStart();
    }
  }
  output = output.replace(/\n{3,}/g, '\n\n').trim();
  const text = appendXhsTopics(markdownToXhsText(output), options.topics ?? []);
  return { markdown: `${output}\n`, text };
}

export function markdownToXhsText(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const output = [];
  let inFence = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      output.push(rawLine);
      continue;
    }
    if (!line.trim()) {
      if (output.at(-1) !== '') output.push('');
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      output.push(stripInlineMarkdown(heading[2].trim()));
      continue;
    }
    const unordered = /^[-*]\s+(.+)$/.exec(line);
    if (unordered) {
      output.push(`- ${stripInlineMarkdown(unordered[1].trim())}`);
      continue;
    }
    const ordered = /^(\d+)[.)]\s+(.+)$/.exec(line);
    if (ordered) {
      output.push(`${ordered[1]}. ${stripInlineMarkdown(ordered[2].trim())}`);
      continue;
    }
    output.push(stripInlineMarkdown(line.trim()));
  }
  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function isPublishConfirmed(title, confirmation) {
  return String(confirmation ?? '').trim() === String(title ?? '').trim() && String(title ?? '').trim().length > 0;
}

export async function inspectXhsPublisherPage(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await settleXhsPage(page);
  const url = page.url();
  const title = await page.title().catch(() => '');
  const signals = {
    xhs_host: isXhsUrl(url),
    title_input: await hasAny(page, TITLE_SELECTORS),
    body_editor: await hasAny(page, BODY_SELECTORS),
    file_input: await hasAny(page, FILE_INPUT_SELECTORS),
    publish_button: await hasAny(page, PUBLISH_SELECTORS),
    upload_entry: await hasAny(page, UPLOAD_ENTRY_SELECTORS),
  };
  signals.login_required = isXhsLoginUrl(url)
    || (!signals.file_input && !signals.publish_button && await hasAny(page, LOGIN_SELECTORS));
  const diagnostics = [];
  let sessionState = 'unknown';
  if (!signals.xhs_host) {
    sessionState = 'not_xhs_page';
    diagnostics.push({
      category: 'not_xhs_page',
      message: 'The selected page is not a Xiaohongshu Creator page.',
      next_step: 'Open https://creator.xiaohongshu.com/publish/publish?source=official in the managed browser.',
    });
  } else if (signals.login_required && !signals.file_input && !signals.title_input) {
    sessionState = 'login_required';
    diagnostics.push({
      category: 'login_required',
      message: 'Xiaohongshu is showing a login surface.',
      next_step: 'Log into Xiaohongshu Creator in the visible managed browser and rerun --inspect.',
    });
  } else if ((signals.file_input || signals.upload_entry) && (signals.title_input || signals.body_editor || signals.publish_button)) {
    sessionState = 'editor_ready';
  } else {
    sessionState = 'editor_unknown';
    diagnostics.push({
      category: 'editor_controls_not_found',
      message: 'Xiaohongshu loaded, but upload/title/body controls were not detected together.',
      next_step: 'Open the publish page manually and rerun --inspect; update selectors if the UI changed.',
    });
  }
  return { url: sanitizeXhsUrl(url), title: redactTitle(title), session_state: sessionState, signals, diagnostics };
}

async function findOrOpenXhsPublisher(browser, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (isXhsUrl(page.url())) {
        await page.bringToFront().catch(() => {});
        if (!/\/publish/.test(new URL(page.url()).pathname)) {
          await page.goto(XHS_PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
        }
        await settleXhsPage(page);
        await openImageTextTabIfNeeded(page);
        return page;
      }
    }
  }
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = await context.newPage();
  await page.goto(XHS_PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
  await settleXhsPage(page);
  await openImageTextTabIfNeeded(page);
  return page;
}

async function settleXhsPage(page) {
  await page.waitForTimeout(1200).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
}

async function openImageTextTabIfNeeded(page) {
  const alreadyOnImageTab = await page.evaluate(() => {
    return [...document.querySelectorAll('input[type="file"]')]
      .some((el) => String(el.getAttribute('accept') || '').includes('.jpg'));
  }).catch(() => false);
  if (alreadyOnImageTab) return;

  const clicked = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('div,button,span,a,li')]
      .filter((el) => (el.textContent || '').trim() === '上传图文');
    const visibleCandidate = candidates.find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0;
    }) ?? candidates[0];
    if (!visibleCandidate) return false;
    const target = visibleCandidate.closest('div,button,a,li') || visibleCandidate;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    target.click?.();
    return true;
  }).catch(() => false);

  if (clicked) {
    await page.waitForTimeout(1500).catch(() => {});
  }
}

async function uploadXhsImages(page, imagePaths, timeoutMs) {
  if (imagePaths.length === 0) return { requested: 0, input_found: false };
  const input = await firstAttached(page, FILE_INPUT_SELECTORS, { timeoutMs });
  await input.setInputFiles(imagePaths, { timeout: timeoutMs });
  await page.waitForTimeout(1500);
  return { requested: imagePaths.length, input_found: true };
}

async function fillXhsTitle(page, title) {
  const titleInput = await firstVisible(page, TITLE_SELECTORS);
  await fillEditable(page, titleInput, title);
}

async function fillXhsBody(page, text) {
  const body = await firstVisible(page, BODY_SELECTORS);
  await fillEditable(page, body, text);
}

async function applyXhsSettings(page, options, timeoutMs) {
  const applied = {};
  if (options.original !== undefined) {
    applied.original = await setSwitchByText(page, '原创声明', options.original);
  }
  if (options.contentType) {
    applied.content_type = await selectContentType(page, options.contentType, timeoutMs);
  }
  if (options.location) {
    applied.location = await selectLocation(page, options.location, timeoutMs);
  }
  if (options.visibility) {
    applied.visibility = await selectVisibility(page, options.visibility, timeoutMs);
  }
  if (options.allowDuet !== undefined) {
    applied.allow_duet = await setSwitchByText(page, '允许合拍', options.allowDuet);
  }
  if (options.allowCopy !== undefined) {
    applied.allow_copy = await setSwitchByText(page, '允许正文复制', options.allowCopy);
  }
  if (options.scheduleAt) {
    applied.schedule = await setScheduleAt(page, options.scheduleAt);
  }
  return applied;
}

async function setSwitchByText(page, label, desired) {
  const result = await page.evaluate(({ switchLabel, desiredState }) => {
    const cards = [...document.querySelectorAll('.custom-switch-wrapper, .custom-switch-card, .post-time-switch-container')];
    const card = cards.find((el) => (el.textContent || '').includes(switchLabel));
    if (!card) return { ok: false, reason: 'switch_not_found', label: switchLabel };
    const simulator = card.querySelector('.d-switch-simulator');
    const current = simulator ? String(simulator.className || '').includes('checked') : null;
    if (current === desiredState) return { ok: true, changed: false, value: current, label: switchLabel };
    const target = card.querySelector('.d-switch, .custom-switch-switch') || card;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    target.click?.();
    return { ok: true, changed: true, value: desiredState, label: switchLabel };
  }, { switchLabel: label, desiredState: Boolean(desired) });
  await page.waitForTimeout(500);
  return result;
}

async function selectContentType(page, value, timeoutMs) {
  const label = CONTENT_TYPE_OPTIONS.get(String(value).trim()) ?? String(value).trim();
  if (await visibleTextIncludes(page, label)) {
    return { ok: true, changed: false, value: label };
  }
  await clickSelectorOrText(page, '.custom-select-44:has-text("添加内容类型声明"), .custom-select-44:has-text("虚构演绎"), .custom-select-44:has-text("笔记含AI"), .custom-select-44:has-text("营销广告"), .custom-select-44:has-text("来源声明")', '添加内容类型声明', timeoutMs);
  await page.waitForTimeout(500);
  const selected = await clickVisibleExactText(page, label);
  return { ok: selected, value: label };
}

async function selectVisibility(page, value, timeoutMs) {
  const label = VISIBILITY_OPTIONS.get(String(value).trim()) ?? String(value).trim();
  if (await visibleTextIncludes(page, label)) {
    return { ok: true, changed: false, value: label };
  }
  await clickSelectorOrText(page, '.permission-card-select', '公开可见', timeoutMs);
  await page.waitForTimeout(500);
  const selected = await clickVisibleExactText(page, label);
  return { ok: selected, value: label };
}

async function selectLocation(page, query, timeoutMs) {
  await clickSelectorOrText(page, '.address-card-select', '添加地点', timeoutMs);
  await page.waitForTimeout(500);
  await page.keyboard.insertText(String(query));
  await page.waitForTimeout(1200);
  const selectedText = await clickFirstLocationResult(page, query);
  return { ok: Boolean(selectedText), query: String(query), selected: selectedText ?? null };
}

async function setScheduleAt(page, value) {
  const scheduleValue = normalizeScheduleAt(value);
  const switchResult = await setSwitchByText(page, '定时发布', true);
  await page.waitForTimeout(800);
  const input = await findScheduleInput(page);
  if (!input) {
    return { ok: false, value: scheduleValue, switch: switchResult, reason: 'schedule_input_not_found' };
  }
  await input.click({ timeout: 5000 });
  await input.evaluate((el) => {
    if ('value' in el) el.value = '';
  }).catch(() => {});
  await input.fill(scheduleValue, { timeout: 5000 }).catch(async () => {
    await input.click({ timeout: 5000 });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.insertText(scheduleValue);
  });
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(500);
  const actual = await input.evaluate((el) => 'value' in el ? el.value : el.innerText).catch(() => '');
  return { ok: normalizeText(actual).includes(scheduleValue), value: scheduleValue, actual: normalizeText(actual), switch: switchResult };
}

async function findScheduleInput(page) {
  const candidates = [
    'input[value*="-"][value*=":"]',
    'input.d-text',
    '.post-time-wrapper input',
    '.post-time-switch-container ~ input',
  ];
  for (const selector of candidates) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      const text = await candidate.evaluate((el) => ('value' in el ? el.value : el.innerText) || '').catch(() => '');
      const box = await candidate.boundingBox().catch(() => null);
      if (box && (/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(text) || box.width > 100)) {
        return candidate;
      }
    }
  }
  return null;
}

function normalizeScheduleAt(value) {
  const text = String(value ?? '').trim().replace('T', ' ');
  const match = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})/.exec(text);
  if (!match) {
    throw new Error('Invalid --schedule-at value. Use "YYYY-MM-DD HH:mm".');
  }
  return `${match[1]} ${match[2]}:${match[3]}`;
}

async function clickSelectorOrText(page, selector, text, timeoutMs) {
  const locator = page.locator(selector).first();
  if (await locator.count().catch(() => 0)) {
    await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => {});
    const box = await locator.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.click(box.x + box.width - 20, box.y + box.height / 2);
    } else {
      await locator.click({ timeout: timeoutMs, force: true });
    }
    return;
  }
  await page.getByText(text, { exact: true }).first().click({ timeout: timeoutMs, force: true });
}

async function clickVisibleExactText(page, text) {
  return await page.evaluate((label) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const candidates = [...document.querySelectorAll('div,span,li,button')]
      .filter((el) => visible(el) && (el.innerText || el.textContent || '').trim() === label);
    const target = candidates.at(-1);
    if (!target) return false;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    target.click?.();
    return true;
  }, text).catch(() => false);
}

async function visibleTextIncludes(page, text) {
  return await page.evaluate((label) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return [...document.querySelectorAll('div,span,button,input')]
      .some((el) => visible(el) && ((el.innerText || el.value || el.textContent || '').trim() === label));
  }, text).catch(() => false);
}

async function clickFirstLocationResult(page, query) {
  return await page.evaluate((locationQuery) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const optionItems = [...document.querySelectorAll('.option-item, .d-grid-item')]
      .filter((el) => visible(el))
      .map((el) => ({ el, text: (el.innerText || el.textContent || '').trim() }))
      .filter((item) => item.text && item.text !== '添加地点' && item.text.includes(locationQuery));
    const candidates = optionItems.length > 0 ? optionItems : [...document.querySelectorAll('div,li,span')]
      .filter((el) => visible(el))
      .map((el) => ({ el, text: (el.innerText || el.textContent || '').trim() }))
      .filter((item) => item.text && item.text !== '添加地点' && item.text.includes(locationQuery) && item.text.length < 240);
    const target = candidates.find((item) => item.text.includes('\n')) ?? candidates[0];
    if (!target) return null;
    target.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    target.el.click?.();
    return target.text.slice(0, 200);
  }, String(query)).catch(() => null);
}

async function fillEditable(page, locator, text) {
  await locator.click({ timeout: 5000 });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(text);
}

async function readXhsDraft(page) {
  const titleText = await readFirstText(page, TITLE_SELECTORS);
  const bodyText = await readFirstText(page, BODY_SELECTORS);
  const fileInputCount = await page.locator(FILE_INPUT_SELECTORS.join(',')).count().catch(() => 0);
  const mediaPreviewCount = await page.locator('img, video, [class*="preview"], [class*="cover"]').count().catch(() => 0);
  return {
    title: normalizeText(titleText),
    body_text: normalizeText(bodyText),
    file_inputs: fileInputCount,
    media_preview_count: mediaPreviewCount,
  };
}

function verifyDraftContent(expected, actual) {
  const diagnostics = [];
  if (normalizeText(actual.title) !== normalizeText(expected.title)) {
    diagnostics.push({
      category: 'draft_title_mismatch',
      message: 'The visible Xiaohongshu title does not match the requested title.',
      next_step: 'Inspect the title field before publishing; update selectors if the title was written to the wrong control.',
    });
  }
  const expectedStart = canonicalDraftText(removeTrailingTopicText(expected.text)).slice(0, 50);
  const actualBody = canonicalDraftText(actual.body_text);
  if (expectedStart && !actualBody.includes(expectedStart)) {
    diagnostics.push({
      category: 'draft_body_mismatch',
      message: 'The visible Xiaohongshu body does not contain the expected opening text.',
      next_step: 'Inspect the body editor before publishing; update selectors if the body was written to the wrong control.',
    });
  }
  if (expected.minImages > 0 && actual.media_preview_count === 0) {
    diagnostics.push({
      category: 'draft_media_not_observed',
      severity: 'warning',
      message: 'The script set local media files, but no visible media preview was detected by generic selectors.',
      next_step: 'Review the visible browser before publishing; update preview selectors if uploads succeeded.',
    });
  }
  return diagnostics;
}

async function validateImages(values) {
  const images = [];
  if (values.length > MAX_XHS_IMAGES) {
    for (const value of values) {
      images.push({
        ok: false,
        path: resolve(value),
        diagnostic: {
          category: 'too_many_images',
          message: `Xiaohongshu image-text upload accepts up to ${MAX_XHS_IMAGES} images in the observed web editor.`,
          next_step: `Pass ${MAX_XHS_IMAGES} or fewer --image values.`,
        },
      });
    }
    return images;
  }
  for (const value of values) {
    const absolute = resolve(value);
    try {
      await access(absolute, constants.R_OK);
      if (!SUPPORTED_IMAGE_RE.test(absolute)) {
        images.push({
          ok: false,
          path: absolute,
          diagnostic: {
            category: 'media_file_unsupported',
            message: 'The observed Xiaohongshu image-text tab accepts .jpg, .jpeg, .png, and .webp files.',
            next_step: 'Use a supported image file or publish video manually from the upload-video tab.',
          },
        });
        continue;
      }
      images.push({ ok: true, path: absolute });
    } catch (error) {
      images.push({
        ok: false,
        path: absolute,
        diagnostic: {
          category: 'media_file_not_readable',
          message: `Cannot read local media file ${absolute}: ${formatError(error)}`,
          next_step: 'Pass an existing local image/video path to --image.',
        },
      });
    }
  }
  return images;
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

async function firstVisible(page, selectors, options = {}) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible({ timeout: options.timeoutMs ?? 500 }).catch(() => false)) {
        return candidate;
      }
    }
  }
  throw new Error(`No visible element found for selectors: ${selectors.join(', ')}`);
}

async function firstAttached(page, selectors, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      if (count > 0) return locator.first();
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`No attached element found for selectors: ${selectors.join(', ')}`);
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

function stripInlineMarkdown(text) {
  return String(text ?? '')
    .replace(MARKDOWN_IMAGE_RE, '$1')
    .replace(LINK_RE, '$1 $2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1');
}

function appendXhsTopics(text, topics) {
  const normalizedTopics = topics
    .map((topic) => String(topic ?? '').trim().replace(/^#+/, ''))
    .filter(Boolean)
    .map((topic) => `#${topic}`);
  if (normalizedTopics.length === 0) return text;
  return [text, normalizedTopics.join(' ')].filter(Boolean).join('\n\n');
}

function resolveMode(options) {
  if (options.inspect) return 'inspect';
  if (options.publish) return 'publish';
  if (options.draft) return 'draft';
  return 'dry-run';
}

function blockingDiagnostics(diagnostics) {
  return diagnostics.filter((item) => item.severity !== 'warning');
}

function noteSummary(title, text, images) {
  return {
    title_length: title.length,
    body_chars: text.length,
    media_count: images.length,
    media_paths: images.map((image) => redactPath(image.path)),
  };
}

function emptyNoteSummary(title) {
  return {
    title_length: title.length,
    body_chars: 0,
    media_count: 0,
  };
}

function firstNonEmptyLine(text) {
  return String(text ?? '').split('\n').find((line) => line.trim()) ?? '';
}

function normalizeHeading(text) {
  return String(text ?? '').replace(/^#+\s*/, '').trim().toLowerCase();
}

function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function canonicalDraftText(text) {
  return normalizeText(text).replace(/\s/g, '');
}

function removeTrailingTopicText(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => {
      const parts = line.trim().split(/\s+/).filter(Boolean);
      return parts.length === 0 || !parts.every((part) => /^#[^\s#]+$/.test(part));
    })
    .join('\n')
    .trim();
}

function isLocalPath(value) {
  return /^(?:\.{1,2}\/|\/|~\/|[A-Za-z]:[\\/])/.test(value);
}

function isXhsUrl(value) {
  try {
    const url = new URL(value);
    return XHS_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function isXhsLoginUrl(value) {
  try {
    const url = new URL(value);
    return XHS_HOSTS.has(url.hostname) && /\/login/.test(url.pathname);
  } catch {
    return false;
  }
}

function sanitizeXhsUrl(value) {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function redactTitle(value) {
  return value ? '[redacted-title]' : '';
}

function redactPath(value) {
  return value ? '[local-media]' : '';
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
