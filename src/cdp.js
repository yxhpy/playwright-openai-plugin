import { chromium } from 'playwright';

const OPENAI_HOSTS = new Set([
  'auth.openai.com',
  'chatgpt.com',
  'chat.openai.com',
  'openai.com',
  'platform.openai.com',
]);

export async function inspectCandidateEndpoints(endpoints, options = {}) {
  const results = [];
  for (const endpoint of endpoints) {
    const probe = await probeCdpEndpoint(endpoint, options);
    if (!probe.cdp_available) {
      results.push(probe);
      continue;
    }
    results.push(await inspectWithPlaywright(endpoint, probe, options));
  }
  return results;
}

async function probeCdpEndpoint(endpoint, options) {
  const versionUrl = `${endpoint}/json/version`;
  let response;
  try {
    response = await fetchWithTimeout(versionUrl, options.timeoutMs);
  } catch (error) {
    return {
      endpoint,
      cdp_available: false,
      connected: false,
      category: 'browser_not_found',
      message: `Cannot reach ${versionUrl}: ${formatError(error)}`,
      next_step: 'Confirm Chrome is running with a remote debugging port.',
    };
  }

  if (!response.ok) {
    return {
      endpoint,
      cdp_available: false,
      connected: false,
      category: 'not_cdp_endpoint',
      http_status: response.status,
      message: `${versionUrl} returned HTTP ${response.status}, so this is not a usable CDP endpoint.`,
      next_step: 'Use a Chrome remote debugging endpoint that exposes `/json/version`.',
    };
  }

  let metadata;
  try {
    metadata = await response.json();
  } catch (error) {
    return {
      endpoint,
      cdp_available: false,
      connected: false,
      category: 'not_cdp_endpoint',
      http_status: response.status,
      message: `${versionUrl} did not return JSON metadata: ${formatError(error)}`,
      next_step: 'Use a Chrome remote debugging endpoint that exposes valid CDP JSON metadata.',
    };
  }

  return {
    endpoint,
    cdp_available: true,
    connected: false,
    category: 'cdp_metadata_available',
    browser: safeString(metadata.Browser),
    protocol_version: safeString(metadata['Protocol-Version']),
  };
}

async function inspectWithPlaywright(endpoint, probe, options) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, {
      timeout: options.timeoutMs ?? 5000,
    });
    const contexts = browser.contexts();
    const pages = [];
    for (const context of contexts) {
      for (const page of context.pages()) {
        pages.push(await summarizePage(page));
      }
    }

    return {
      ...probe,
      connected: true,
      category: 'connected',
      context_count: contexts.length,
      pages,
    };
  } catch (error) {
    return {
      ...probe,
      connected: false,
      category: 'session_detached',
      message: `CDP metadata was available but Playwright could not connect: ${formatError(error)}`,
      next_step: 'Retry status. If this repeats, restart Chrome with a fresh remote debugging port.',
      pages: [],
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function summarizePage(page) {
  const url = page.url();
  const safeUrl = sanitizeUrl(url);
  return {
    url: safeUrl,
    origin: safeOrigin(url),
    openai_surface: classifyOpenaiSurface(url),
    title: await safePageTitle(page),
  };
}

export async function safePageTitle(page) {
  try {
    const title = await page.title();
    if (!title) {
      return { value: '', redacted: false };
    }
    if (isGenericTitle(title)) {
      return { value: title, redacted: false };
    }
    return { value: '[redacted]', redacted: true };
  } catch {
    return { value: '[unavailable]', redacted: true };
  }
}

export function classifyOpenaiSurface(urlText) {
  let url;
  try {
    url = new URL(urlText);
  } catch {
    return 'none';
  }

  const host = url.hostname.replace(/^www\./, '');
  if (!OPENAI_HOSTS.has(host)) {
    return 'none';
  }
  if (host === 'auth.openai.com') {
    return 'openai_auth';
  }
  if (host === 'chatgpt.com' || host === 'chat.openai.com') {
    if (url.pathname.startsWith('/images')) {
      return 'chatgpt_images';
    }
    if (url.pathname.startsWith('/g/')) {
      return 'chatgpt_gpt';
    }
    return 'chatgpt';
  }
  if (host === 'platform.openai.com') {
    return 'platform';
  }
  return 'openai_web';
}

export function sanitizeUrl(urlText) {
  try {
    const url = new URL(urlText);
    const host = url.hostname.replace(/^www\./, '');
    if ((host === 'chatgpt.com' || host === 'chat.openai.com') && url.pathname.startsWith('/c/')) {
      return `${url.origin}/c/[redacted]`;
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

export function safeOrigin(urlText) {
  try {
    return new URL(urlText).origin;
  } catch {
    return '[invalid-origin]';
  }
}

function isGenericTitle(title) {
  const normalized = title.trim().toLowerCase();
  return [
    'chatgpt',
    'chatgpt 图片 | ai 图片生成器',
    'chatgpt images | ai image generator',
    'openai',
    'platform.openai.com',
  ].includes(normalized);
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

function formatError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0];
}

function safeString(value) {
  return typeof value === 'string' ? value : null;
}
