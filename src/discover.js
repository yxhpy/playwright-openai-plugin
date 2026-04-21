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
