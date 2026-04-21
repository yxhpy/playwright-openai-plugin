import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { classifyOpenaiSurface, sanitizeUrl } from './cdp.js';
import { cleanupJobs, createChatJob, listJobs, readJob, updateJob } from './jobs.js';
import { selectModelForAction } from './model.js';
import { buildCandidateEndpoints } from './status.js';

const COMPOSER_SELECTOR = 'main [contenteditable="true"], div.ProseMirror, textarea';
const COMPOSER_FILE_INPUT_SELECTOR = 'form input[type="file"]';
const LOGIN_SELECTOR = 'a[href*="/auth/login"], a[href*="auth.openai.com"], button:has-text("Log in"), a:has-text("Log in"), button:has-text("登录"), a:has-text("登录"), button:has-text("Sign up"), a:has-text("Sign up"), button:has-text("注册"), a:has-text("注册"), input[type="email"], input[type="password"]';
const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
const SEND_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
  'button[aria-label="发送提示"]',
  'button[aria-label="发送消息"]',
  'form button[type="submit"]',
];
const STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label*="Stop"]',
  'button[aria-label*="停止"]',
];

export async function runChatSend(options = {}) {
  const prompt = String(options.prompt ?? '').trim();
  if (!prompt) {
    throw new Error('Missing --prompt for chat send');
  }

  const timeoutMs = options.timeoutMs ?? 60000;
  const endpointResult = await connectFirstAvailable(buildCandidateEndpoints(options), options);
  if (!endpointResult.browser) {
    return failureResult('connect', endpointResult.endpoint, endpointResult.diagnostics, 'Run `poai browser launch`, then rerun `poai discover --json`.');
  }

  const { browser, endpoint } = endpointResult;
  try {
    const page = await findChatPage(browser);
    if (!page) {
      return failureResult('ready', endpoint, [{
        category: 'unsupported_capability',
        message: 'No ChatGPT page was found in the connected browser.',
        next_step: 'Open ChatGPT in the managed browser and retry.',
      }], 'Open ChatGPT in the managed browser and retry.');
    }

    const readiness = await checkReadiness(page);
    if (!readiness.ready) {
      return failureResult('ready', endpoint, readiness.diagnostics, 'Complete login and rerun `poai discover --json` before sending chat prompts.');
    }

    const model = await selectModelForAction(page, {
      capability: 'chat',
      requestedModel: options.model,
    });
    if (!model.ok) {
      return failureResult('model', endpoint, [model.diagnostic], 'Select a suitable chat model in the managed browser or retry with `--model <label>`.');
    }

    const beforeAssistantCount = await countAssistantMessages(page);
    const composer = await firstVisibleLocator(page, COMPOSER_SELECTOR);
    await fillComposer(page, composer, prompt);
    await submitPrompt(page);
    const response = await waitForLatestAssistant(page, beforeAssistantCount, timeoutMs);

    return {
      ok: true,
      command: 'chat send',
      endpoint,
      phase: response.completed ? 'collect' : 'wait',
      submitted: true,
      completed: response.completed,
      model,
      response: response.text ? { text: response.text } : null,
      diagnostics: response.diagnostics,
      next_step: response.completed
        ? 'Prompt submitted and latest assistant response collected.'
        : 'Prompt submitted, but completion was not detected before timeout. Inspect the visible browser or rerun a future wait/collect command.',
    };
  } finally {
    await browser.close();
  }
}

export async function runChatSubmit(options = {}) {
  const prompt = String(options.prompt ?? '').trim();
  if (!prompt) {
    throw new Error('Missing --prompt for chat submit');
  }

  const attachment = options.filePath ? await validateAttachmentFile(options.filePath) : null;
  if (attachment && !attachment.ok) {
    return chatJobFailureResult('chat submit', 'attach', null, null, [attachment.diagnostic], 'Fix `--file` and retry.');
  }

  const endpointResult = await connectFirstAvailable(buildCandidateEndpoints(options), options);
  if (!endpointResult.browser) {
    return chatJobFailureResult('chat submit', 'connect', null, endpointResult.endpoint, endpointResult.diagnostics, 'Run `poai browser launch`, then rerun `poai discover --json`.');
  }

  const { browser, endpoint } = endpointResult;
  try {
    const page = await findChatPage(browser);
    if (!page) {
      return chatJobFailureResult('chat submit', 'ready', null, endpoint, [{
        category: 'unsupported_capability',
        message: 'No ChatGPT page was found in the connected browser.',
        next_step: 'Open ChatGPT in the managed browser and retry.',
      }], 'Open ChatGPT in the managed browser and retry.');
    }

    const readiness = await checkReadiness(page);
    if (!readiness.ready) {
      return chatJobFailureResult('chat submit', 'ready', null, endpoint, readiness.diagnostics, 'Complete login and rerun `poai discover --json` before submitting chat prompts.');
    }

    const model = await selectModelForAction(page, {
      capability: 'chat',
      requestedModel: options.model,
    });
    if (!model.ok) {
      return chatJobFailureResult('chat submit', 'model', null, endpoint, [model.diagnostic], 'Select a suitable chat model in the managed browser or retry with `--model <label>`.');
    }

    const beforeAssistantCount = await countAssistantMessages(page);
    if (attachment) {
      const attachResult = await attachFileToComposer(page, attachment.path);
      if (!attachResult.attached) {
        return chatJobFailureResult('chat submit', 'attach', null, endpoint, [attachResult.diagnostic], 'Run `poai discover --json` and inspect file upload availability before retrying.');
      }
    }

    const composer = await firstVisibleLocator(page, COMPOSER_SELECTOR);
    await fillComposer(page, composer, prompt);
    if (attachment) {
      const ready = await waitForSubmitReady(page, options.timeoutMs ?? 30000);
      if (!ready) {
        return chatJobFailureResult('chat submit', 'attach', null, endpoint, [{
          category: 'file_upload_timeout',
          message: 'Timed out waiting for the composer to become ready after file selection.',
          next_step: 'Inspect the visible browser. The file may still be uploading or the UI may have drifted.',
        }], 'Inspect the visible browser and retry with a smaller non-sensitive file.');
      }
    }
    await submitPrompt(page);
    const job = await createChatJob({
      endpoint,
      beforeAssistantCount,
      attachmentCount: attachment ? 1 : 0,
      model,
      pageUrl: sanitizeUrl(page.url()),
    }, options);

    return {
      ok: true,
      command: 'chat submit',
      endpoint,
      phase: 'submit',
      job_id: job.id,
      submitted: true,
      completed: false,
      attachment_count: attachment ? 1 : 0,
      model: job.model,
      diagnostics: [],
      next_step: `Run \`poai chat wait --job-id ${job.id}\`, then \`poai chat collect --job-id ${job.id}\`.`,
    };
  } finally {
    await browser.close();
  }
}

export async function runChatWait(options = {}) {
  const job = await readJob(options.jobId, options);
  const timeoutMs = options.timeoutMs ?? 60000;
  const endpointResult = await connectFirstAvailable([job.endpoint], options);
  if (!endpointResult.browser) {
    return chatJobFailureResult('chat wait', 'connect', job.id, job.endpoint, endpointResult.diagnostics, 'Restart the managed browser or rerun `poai browser launch`.');
  }

  const { browser, endpoint } = endpointResult;
  try {
    const page = await findChatPage(browser);
    if (!page) {
      return chatJobFailureResult('chat wait', 'ready', job.id, endpoint, [{
        category: 'unsupported_capability',
        message: 'No ChatGPT page was found in the connected browser.',
        next_step: 'Open the submitted conversation in the managed browser and retry wait.',
      }], 'Open the submitted conversation in the managed browser and retry wait.');
    }

    const response = await waitForLatestAssistant(page, job.before_assistant_count, timeoutMs);
    await updateJob(job.id, {
      status: response.completed ? 'completed' : 'timeout',
      phase: response.completed ? 'wait_complete' : 'wait_timeout',
      completed_at: response.completed ? new Date().toISOString() : job.completed_at,
    }, options);

    return {
      ok: true,
      command: 'chat wait',
      endpoint,
      phase: response.completed ? 'wait_complete' : 'wait_timeout',
      job_id: job.id,
      submitted: true,
      completed: response.completed,
      diagnostics: response.diagnostics,
      next_step: response.completed
        ? `Run \`poai chat collect --job-id ${job.id}\` to retrieve the latest assistant response.`
        : 'The response was not complete before timeout. Retry wait or inspect the visible browser.',
    };
  } finally {
    await browser.close();
  }
}

export async function runChatCollect(options = {}) {
  const job = await readJob(options.jobId, options);
  const endpointResult = await connectFirstAvailable([job.endpoint], options);
  if (!endpointResult.browser) {
    return chatJobFailureResult('chat collect', 'connect', job.id, job.endpoint, endpointResult.diagnostics, 'Restart the managed browser or rerun `poai browser launch`.');
  }

  const { browser, endpoint } = endpointResult;
  try {
    const page = await findChatPage(browser);
    if (!page) {
      return chatJobFailureResult('chat collect', 'ready', job.id, endpoint, [{
        category: 'unsupported_capability',
        message: 'No ChatGPT page was found in the connected browser.',
        next_step: 'Open the submitted conversation in the managed browser and retry collect.',
      }], 'Open the submitted conversation in the managed browser and retry collect.');
    }

    const count = await countAssistantMessages(page);
    if (count <= job.before_assistant_count) {
      return chatJobFailureResult('chat collect', 'collect', job.id, endpoint, [{
        category: 'late_result_possible',
        message: 'No new assistant response was found for this job yet.',
        next_step: `Run \`poai chat wait --job-id ${job.id}\` and retry collect.`,
      }], `Run \`poai chat wait --job-id ${job.id}\` and retry collect.`);
    }

    const text = await readLatestAssistantText(page);
    await updateJob(job.id, {
      status: 'collected',
      phase: 'collect',
      collected_at: new Date().toISOString(),
    }, options);

    return {
      ok: true,
      command: 'chat collect',
      endpoint,
      phase: 'collect',
      job_id: job.id,
      submitted: true,
      completed: true,
      response: text ? { text } : null,
      diagnostics: [],
      next_step: 'Latest assistant response collected. Job metadata does not store the response text.',
    };
  } finally {
    await browser.close();
  }
}

export async function runChatJobsList(options = {}) {
  const jobs = await listJobs({ ...options, jobType: 'chat' });
  return {
    ok: true,
    command: 'chat jobs list',
    jobs,
    count: jobs.length,
    filter: {
      status: options.jobStatus ?? null,
      limit: options.limit ?? 50,
    },
    diagnostics: [],
    next_step: jobs.length > 0
      ? 'Use `poai chat jobs cleanup --status collected --yes` to delete selected metadata files.'
      : 'No job metadata files found.',
  };
}

export async function runChatJobsCleanup(options = {}) {
  const result = await cleanupJobs({ ...options, jobType: 'chat' });
  return {
    ok: true,
    command: 'chat jobs cleanup',
    dry_run: result.dry_run,
    candidates: result.candidates,
    deleted: result.deleted,
    count: result.candidates.length,
    filter: {
      status: options.jobStatus ?? null,
      limit: options.limit ?? 50,
    },
    diagnostics: [],
    next_step: result.dry_run
      ? 'Dry run only. Add `--yes` to delete these job metadata files.'
      : 'Selected job metadata files deleted.',
  };
}

export async function validateAttachmentFile(filePath) {
  const resolvedPath = resolve(String(filePath ?? ''));
  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch {
    return {
      ok: false,
      diagnostic: {
        category: 'file_not_found',
        message: 'Attachment file was not found.',
        next_step: 'Check `--file` and retry with an existing local file.',
      },
    };
  }

  if (!fileStat.isFile()) {
    return {
      ok: false,
      diagnostic: {
        category: 'file_not_regular',
        message: 'Attachment path is not a regular file.',
        next_step: 'Retry with a readable regular file.',
      },
    };
  }

  try {
    await access(resolvedPath, constants.R_OK);
  } catch {
    return {
      ok: false,
      diagnostic: {
        category: 'file_not_readable',
        message: 'Attachment file is not readable.',
        next_step: 'Check local file permissions and retry.',
      },
    };
  }

  return {
    ok: true,
    path: resolvedPath,
    attachmentCount: 1,
  };
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

async function findChatPage(browser) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const surface = classifyOpenaiSurface(page.url());
      if (surface === 'chatgpt') {
        return page;
      }
    }
  }
  return null;
}

async function attachFileToComposer(page, filePath) {
  const input = page.locator(COMPOSER_FILE_INPUT_SELECTOR).first();
  if ((await input.count().catch(() => 0)) === 0) {
    return {
      attached: false,
      diagnostic: {
        category: 'file_upload_unavailable',
        message: 'No composer-scoped file input was found.',
        next_step: 'Run `poai discover --json` and confirm `file_upload_candidate` is available.',
      },
    };
  }

  try {
    await input.setInputFiles(filePath, { timeout: 10000 });
    const selectedCount = await input.evaluate((element) => element.files?.length ?? 0);
    if (selectedCount < 1) {
      return {
        attached: false,
        diagnostic: {
          category: 'file_upload_unavailable',
          message: 'The composer file input did not retain the selected file.',
          next_step: 'Inspect the visible browser and retry.',
        },
      };
    }
    return { attached: true };
  } catch (error) {
    return {
      attached: false,
      diagnostic: {
        category: 'file_upload_unavailable',
        message: formatError(error),
        next_step: 'Inspect the visible browser and retry with a supported file.',
      },
    };
  }
}

async function checkReadiness(page) {
  const loginPresent = await isPresent(page, LOGIN_SELECTOR);
  const composer = await firstVisibleLocator(page, COMPOSER_SELECTOR);
  if (loginPresent) {
    return {
      ready: false,
      diagnostics: [{
        category: 'not_logged_in',
        message: 'Login or signup controls are still visible.',
        next_step: 'Complete login in the managed browser.',
      }],
    };
  }
  if (!composer) {
    return {
      ready: false,
      diagnostics: [{
        category: 'ui_drift',
        message: 'No visible ChatGPT composer was found.',
        next_step: 'Run `poai discover --json` and inspect the current page state.',
      }],
    };
  }
  return { ready: true, diagnostics: [] };
}

async function waitForSubmitReady(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of SEND_SELECTORS) {
      const button = await firstVisibleLocator(page, selector);
      if (!button) {
        continue;
      }
      if (!(await button.isDisabled().catch(() => true))) {
        return true;
      }
    }
    await sleep(500);
  }
  return false;
}

async function fillComposer(page, composer, prompt) {
  try {
    await composer.fill(prompt, { timeout: 5000 });
    return;
  } catch {
    await composer.click({ timeout: 5000 });
    await page.keyboard.insertText(prompt);
  }
}

async function submitPrompt(page) {
  for (const selector of SEND_SELECTORS) {
    const button = await firstVisibleLocator(page, selector);
    if (!button) {
      continue;
    }
    if (await button.isDisabled().catch(() => false)) {
      continue;
    }
    await button.click({ timeout: 5000 });
    return;
  }

  const submitted = await page.evaluate(() => {
    const active = document.activeElement;
    const form = active?.closest?.('form') ?? document.querySelector('form');
    if (form instanceof HTMLFormElement) {
      form.requestSubmit();
      return true;
    }
    return false;
  });
  if (!submitted) {
    throw new Error('Could not find a send control for ChatGPT composer');
  }
}

async function waitForLatestAssistant(page, beforeAssistantCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latestText = '';
  while (Date.now() < deadline) {
    const count = await countAssistantMessages(page);
    if (count > beforeAssistantCount) {
      latestText = await readLatestAssistantText(page);
      if (latestText && !(await isGenerating(page))) {
        return { completed: true, text: latestText, diagnostics: [] };
      }
    }
    await sleep(500);
  }
  return {
    completed: false,
    text: latestText,
    diagnostics: [{
      category: 'timeout',
      message: 'Timed out waiting for the latest assistant response to finish.',
      next_step: 'Inspect the visible browser. The response may still complete later.',
    }],
  };
}

async function readLatestAssistantText(page) {
  const assistantMessages = page.locator(ASSISTANT_SELECTOR);
  const count = await assistantMessages.count();
  if (count === 0) {
    return '';
  }
  return (await assistantMessages.nth(count - 1).innerText({ timeout: 3000 })).trim();
}

async function countAssistantMessages(page) {
  return page.locator(ASSISTANT_SELECTOR).count().catch(() => 0);
}

async function isGenerating(page) {
  for (const selector of STOP_SELECTORS) {
    if (await isPresent(page, selector)) {
      return true;
    }
  }
  return false;
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

async function isPresent(page, selector) {
  return (await page.locator(selector).count().catch(() => 0)) > 0;
}

function failureResult(phase, endpoint, diagnostics, nextStep) {
  return {
    ok: true,
    command: 'chat send',
    endpoint,
    phase,
    submitted: false,
    completed: false,
    response: null,
    diagnostics,
    next_step: nextStep,
  };
}

function chatJobFailureResult(command, phase, jobId, endpoint, diagnostics, nextStep) {
  return {
    ok: true,
    command,
    endpoint,
    phase,
    job_id: jobId,
    submitted: false,
    completed: false,
    response: null,
    diagnostics,
    next_step: nextStep,
  };
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

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
