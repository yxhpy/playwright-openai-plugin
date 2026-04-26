import { chromium } from 'playwright';
import {
  classifyOpenaiSurface,
  safeOrigin,
  safePageTitle,
  sanitizeUrl,
} from './cdp.js';
import { buildCandidateEndpoints } from './status.js';

export async function runDiscover(options = {}) {
  const checkedAt = new Date().toISOString();
  const endpoints = buildCandidateEndpoints(options);
  const endpointResult = await connectFirstAvailable(endpoints, options);
  if (!endpointResult.browser) {
    return {
      ok: true,
      command: 'discover',
      ready: false,
      checked_at: checkedAt,
      endpoint: null,
      pages: [],
      diagnostics: endpointResult.diagnostics,
      next_step: 'Run `poai browser launch`, then log into ChatGPT in the managed browser if needed.',
    };
  }

  const { browser, endpoint } = endpointResult;
  try {
    const pages = [];
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const surface = classifyOpenaiSurface(page.url());
        if (surface !== 'none') {
          pages.push(await discoverPage(page, surface));
        }
      }
    }

    const diagnostics = [];
    if (pages.length === 0) {
      diagnostics.push({
        category: 'unsupported_capability',
        message: 'A CDP browser was reachable, but no OpenAI or ChatGPT page was found.',
        next_step: 'Open ChatGPT in the managed browser and rerun `poai discover --json`.',
      });
    }

    return {
      ok: true,
      command: 'discover',
      ready: pages.some((page) => page.session_state === 'app_ready'),
      checked_at: checkedAt,
      endpoint,
      pages,
      diagnostics,
      next_step: chooseNextStep(pages),
    };
  } finally {
    await browser.close();
  }
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
      const browser = await chromium.connectOverCDP(endpoint, {
        timeout: timeoutMs,
      });
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

function formatError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0];
}

async function discoverPage(page, surface) {
  const signals = await collectSignals(page);
  signals.push(...await collectTransientMenuSignals(page));
  const sessionState = classifyDiscoverySessionState(surface, signals);
  return {
    url: sanitizeUrl(page.url()),
    origin: safeOrigin(page.url()),
    openai_surface: surface,
    title: await safePageTitle(page),
    session_state: sessionState,
    signals,
    capabilities: buildDiscoveryCapabilities(surface, sessionState, signals),
  };
}

async function collectSignals(page) {
  const checks = [
    ['composer_editable', 'main [contenteditable="true"], div.ProseMirror, textarea'],
    ['file_input', 'input[type="file"]'],
    ['login_link_or_button', 'a[href*="/auth/login"], a[href*="auth.openai.com"], button:has-text("Log in"), a:has-text("Log in"), button:has-text("登录"), a:has-text("登录")'],
    ['signup_link_or_button', 'button:has-text("Sign up"), a:has-text("Sign up"), button:has-text("注册"), a:has-text("注册")'],
    ['new_chat_control', 'a[href="/"], button:has-text("New chat"), a:has-text("New chat"), button:has-text("新聊天"), a:has-text("新聊天")'],
    ['chatgpt_images_url', 'a[href^="/images"], a[href*="chatgpt.com/images"]'],
    ['auth_form_input', 'input[type="email"], input[name="email"], input[type="password"]'],
    ['model_selector', 'button[data-testid="model-switcher-dropdown-button"], button[aria-label="模型选择器"], button[aria-label*="model selector" i]'],
    ['composer_plus_control', 'button[data-testid="composer-plus-btn"], button[aria-label="添加文件等"], button[aria-label*="Attach" i], button[aria-label*="Add" i]'],
    ['send_button', 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="发送提示"]'],
    ['temporary_chat_control', 'button[aria-label="开启临时聊天"], button[aria-label*="temporary chat" i]'],
    ['group_chat_control', 'button[aria-label="开始群聊"], button[aria-label*="group chat" i]'],
    ['dictation_control', 'button[aria-label="开始听写"], button[aria-label*="dictation" i]'],
    ['voice_control', 'button[aria-label="启动语音功能"], button[aria-label*="voice" i]'],
    ['search_chats_control', 'button:has-text("搜索聊天"), button[aria-label*="Search chats" i]'],
    ['sidebar_control', 'button[aria-label="打开边栏"], button[aria-label="关闭边栏"], button[aria-label*="sidebar" i]'],
    ['gpts_explore_link', 'a[data-testid="explore-gpts-button"], a[href="/gpts"]'],
    ['codex_link', 'a[href*="/codex"]'],
    ['custom_gpt_link', 'a[href^="/g/"]'],
    ['image_edit_control', 'button[aria-label="编辑图片"], button:has-text("编辑")'],
    ['image_share_control', 'button[aria-label*="分享此图片"], button[aria-label*="Share this image" i]'],
    ['image_gallery_candidate', 'button[aria-label^="打开图片"], button[aria-label*="Open image" i]'],
  ];

  const signals = [];
  for (const [name, selector] of checks) {
    signals.push({
      name,
      present: await isPresent(page, selector),
    });
  }
  return signals;
}

async function collectTransientMenuSignals(page) {
  const signals = [];
  signals.push(...await collectMenuTextSignals(page, {
    openSelector: 'button[data-testid="model-switcher-dropdown-button"], button[aria-label="模型选择器"], button[aria-label*="model selector" i]',
    definitions: [
      ['chat_model_instant', /Instant|日常|快速/i],
      ['chat_model_thinking', /Thinking|思考|复杂/i],
      ['chat_model_pro', /\bPro\b|研究级|专业/i],
      ['model_configure_control', /配置|Configure/i],
    ],
  }));
  signals.push(...await collectMenuTextSignals(page, {
    openSelector: 'button[data-testid="composer-plus-btn"], button[aria-label="添加文件等"], button[aria-label*="Attach" i], button[aria-label*="Add" i]',
    definitions: [
      ['attachment_menu_upload', /添加照片和文件|Upload|Attach|照片|文件/i],
      ['recent_files_control', /近期文件|Recent files/i],
      ['image_creation_control', /创建图片|Create image|Image/i],
      ['deep_research_control', /深度研究|Deep research/i],
      ['web_search_control', /网页搜索|Web search/i],
      ['project_attach_control', /项目|Project/i],
    ],
  }));
  await page.keyboard.press('Escape').catch(() => {});
  return dedupeSignals(signals);
}

async function collectMenuTextSignals(page, options) {
  const opener = await firstVisibleLocator(page, options.openSelector);
  if (!opener) {
    return [];
  }

  const text = await readTransientMenuText(page, opener);
  return options.definitions.map(([name, pattern]) => ({
    name,
    present: pattern.test(text),
  }));
}

async function readTransientMenuText(page, opener) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(100).catch(() => {});
  await opener.click({ timeout: 2500 }).catch(async () => {
    await opener.evaluate((element) => element.click()).catch(() => {});
  });
  await page.waitForTimeout(300).catch(() => {});
  const text = await page.evaluate(() => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return [
      ...document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-popper-content-wrapper]'),
    ]
      .filter(isVisible)
      .map((element) => element.innerText || element.textContent || '')
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim();
  }).catch(() => '');
  await page.keyboard.press('Escape').catch(() => {});
  return text;
}

async function firstVisibleLocator(page, selector) {
  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }
  return null;
}

function dedupeSignals(signals) {
  const byName = new Map();
  for (const signal of signals) {
    byName.set(signal.name, {
      name: signal.name,
      present: Boolean(signal.present || byName.get(signal.name)?.present),
    });
  }
  return [...byName.values()];
}

async function isPresent(page, selector) {
  try {
    return (await page.locator(selector).count()) > 0;
  } catch {
    return false;
  }
}

export function classifyDiscoverySessionState(surface, signals) {
  if (surface === 'openai_auth') {
    return 'auth_flow';
  }
  if (
    (hasSignal(signals, 'login_link_or_button') || hasSignal(signals, 'signup_link_or_button')) &&
    hasSignal(signals, 'composer_editable')
  ) {
    return 'login_required_public_composer';
  }
  if (
    hasSignal(signals, 'auth_form_input') ||
    hasSignal(signals, 'login_link_or_button') ||
    hasSignal(signals, 'signup_link_or_button')
  ) {
    return 'login_required';
  }
  if (hasSignal(signals, 'composer_editable') || hasSignal(signals, 'new_chat_control')) {
    return 'app_ready';
  }
  return 'openai_page_present_unknown';
}

export function buildDiscoveryCapabilities(surface, sessionState, signals) {
  const capabilities = [];
  if (sessionState === 'app_ready' && hasSignal(signals, 'composer_editable')) {
    capabilities.push({
      name: 'chat_submit_candidate',
      status: 'available',
      evidence: 'composer_editable',
    });
  }
  if (sessionState === 'app_ready' && hasSignal(signals, 'file_input')) {
    capabilities.push({
      name: 'file_upload_candidate',
      status: 'available',
      evidence: 'file_input',
    });
  }
  if (surface === 'chatgpt_images' || hasSignal(signals, 'chatgpt_images_url')) {
    capabilities.push({
      name: 'images_surface_candidate',
      status: 'available',
      evidence: surface === 'chatgpt_images' ? 'current_url' : 'images_link',
    });
  }
  if (sessionState === 'app_ready' && hasSignal(signals, 'model_selector')) {
    capabilities.push({
      name: 'model_selection_candidate',
      status: 'available',
      evidence: 'model_selector',
    });
  }
  if (sessionState === 'app_ready' && hasSignal(signals, 'web_search_control')) {
    capabilities.push({
      name: 'web_search_candidate',
      status: 'available',
      evidence: 'web_search_control',
    });
  }
  if (sessionState === 'app_ready' && hasSignal(signals, 'deep_research_control')) {
    capabilities.push({
      name: 'deep_research_candidate',
      status: 'available',
      evidence: 'deep_research_control',
    });
  }
  if (sessionState === 'app_ready' && hasSignal(signals, 'image_creation_control')) {
    capabilities.push({
      name: 'image_creation_candidate',
      status: 'available',
      evidence: 'image_creation_control',
    });
  }
  if (sessionState === 'app_ready' && hasSignal(signals, 'temporary_chat_control')) {
    capabilities.push({
      name: 'temporary_chat_candidate',
      status: 'available',
      evidence: 'temporary_chat_control',
    });
  }
  if (surface === 'chatgpt_images' && hasSignal(signals, 'image_edit_control')) {
    capabilities.push({
      name: 'image_edit_candidate',
      status: 'available',
      evidence: 'image_edit_control',
    });
  }
  if (surface === 'chatgpt_images' && hasSignal(signals, 'image_share_control')) {
    capabilities.push({
      name: 'image_share_candidate',
      status: 'available',
      evidence: 'image_share_control',
    });
  }
  return capabilities;
}

function hasSignal(signals, name) {
  return signals.some((signal) => signal.name === name && signal.present);
}

function chooseNextStep(pages) {
  if (pages.length === 0) {
    return 'Open ChatGPT in the managed browser and rerun discovery.';
  }
  if (pages.some((page) => page.session_state === 'app_ready')) {
    return 'Run `poai chat send --prompt <text>` or plan the next capability-specific command.';
  }
  if (pages.some((page) => page.session_state.startsWith('login_required') || page.session_state === 'auth_flow')) {
    return 'Complete login in the managed browser, then rerun `poai discover --json`.';
  }
  return 'Discovery found an OpenAI page but could not classify readiness; inspect UI drift before adding action commands.';
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
