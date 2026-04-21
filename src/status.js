import { inspectCandidateEndpoints } from './cdp.js';

const DEFAULT_PORTS = ['9333', '9222', '9223', '9224', '9225', '9229'];

export async function runStatus(options = {}) {
  const startedAt = new Date().toISOString();
  const endpoints = buildCandidateEndpoints(options);
  const inspection = await inspectCandidateEndpoints(endpoints, {
    timeoutMs: options.timeoutMs ?? 5000,
  });
  const selected = inspection.find((item) => item.connected) ?? null;
  const openaiPages = selected?.pages.filter((page) => page.openai_surface !== 'none') ?? [];
  const diagnostics = buildDiagnostics(inspection, selected, openaiPages);
  const ready = Boolean(selected && openaiPages.length > 0);

  return {
    ok: true,
    command: 'status',
    ready,
    checked_at: startedAt,
    browser: {
      cdp_available: Boolean(selected),
      selected_endpoint: selected?.endpoint ?? null,
      probes: inspection.map((item) => ({
        endpoint: item.endpoint,
        cdp_available: item.cdp_available,
        connected: item.connected,
        category: item.category,
        http_status: item.http_status ?? null,
        browser: item.browser ?? null,
        page_count: item.pages?.length ?? 0,
      })),
    },
    openai: {
      session_state: classifySessionState(selected, openaiPages),
      page_count: openaiPages.length,
      pages: openaiPages,
    },
    diagnostics,
    next_step: chooseNextStep(selected, openaiPages),
  };
}

export function buildCandidateEndpoints(options) {
  const candidates = [];
  if (options.endpoint) {
    candidates.push(options.endpoint);
  }
  if (process.env.OPENAI_BROWSER_CDP_URL) {
    candidates.push(process.env.OPENAI_BROWSER_CDP_URL);
  }

  const ports = options.ports?.length ? options.ports : DEFAULT_PORTS;
  for (const port of ports) {
    candidates.push(`http://127.0.0.1:${port}`);
  }

  return [...new Set(candidates.map(normalizeEndpoint))];
}

function normalizeEndpoint(endpoint) {
  return endpoint.replace(/\/+$/, '');
}

function classifySessionState(selected, openaiPages) {
  if (!selected) {
    return 'unknown_no_cdp';
  }
  if (openaiPages.length === 0) {
    return 'unknown_no_openai_page';
  }
  return 'openai_page_present_login_not_verified';
}

function buildDiagnostics(inspection, selected, openaiPages) {
  const diagnostics = [];
  if (!selected) {
    diagnostics.push({
      category: 'browser_not_found',
      message: 'No usable Chrome DevTools Protocol endpoint was found.',
      next_step: 'Run `poai browser launch`, then rerun `poai status --json`.',
    });
  }

  for (const item of inspection) {
    if (!selected && !item.cdp_available) {
      diagnostics.push({
        category: item.category,
        message: item.message,
        endpoint: item.endpoint,
        http_status: item.http_status ?? null,
        next_step: item.next_step,
      });
    }
  }

  if (selected && openaiPages.length === 0) {
    diagnostics.push({
      category: 'unsupported_capability',
      message: 'A CDP browser was reachable, but no OpenAI or ChatGPT page was found.',
      endpoint: selected.endpoint,
      next_step: 'Open ChatGPT or an OpenAI web surface in that browser and rerun status.',
    });
  }

  return diagnostics;
}

function chooseNextStep(selected, openaiPages) {
  if (!selected) {
    return 'Run `poai browser launch` to start a managed CDP browser, then rerun status.';
  }
  if (openaiPages.length === 0) {
    return 'Open ChatGPT/OpenAI in the connected browser and rerun status.';
  }
  return 'Use this endpoint for the next read-only capability discovery iteration.';
}
