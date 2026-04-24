import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, mkdir, open, stat, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { classifyOpenaiSurface, sanitizeUrl } from './cdp.js';
import {
  cleanupJobs,
  createImageJob,
  listJobs,
  readJob,
  updateJob,
} from './jobs.js';
import { isImageModeRequest, normalizeModelRequest, resolveImageModelRequest, selectModelForAction } from './model.js';
import { defaultImageOutputDir } from './paths.js';
import { buildCandidateEndpoints } from './status.js';

const IMAGES_URL = 'https://chatgpt.com/images/';
const COMPOSER_SELECTOR = 'main [contenteditable="true"], div.ProseMirror, textarea';
const COMPOSER_IMAGE_FILE_INPUT_SELECTOR = 'form input[type="file"][accept*="image"], form input[type="file"]';
const LOGIN_SELECTOR = 'a[href*="/auth/login"], a[href*="auth.openai.com"], button:has-text("Log in"), a:has-text("Log in"), button:has-text("登录"), a:has-text("登录"), button:has-text("Sign up"), a:has-text("Sign up"), button:has-text("注册"), a:has-text("注册"), input[type="email"], input[type="password"]';
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
const GENERATING_HINT_SELECTORS = [
  'button[aria-label*="思考中"]',
  'button[aria-label*="正在生成"]',
  'button[aria-label*="生成中"]',
  'button[aria-label*="Generating" i]',
  'button[aria-label*="Creating" i]',
  'text=/思考中|正在生成|生成中|Generating|Creating/i',
];

export async function runImageSend(options = {}) {
  const submit = await runImageSubmit(options);
  if (!submit.submitted || !submit.job_id) {
    return {
      ...submit,
      command: 'image send',
    };
  }

  const wait = await runImageWait({
    ...options,
    jobId: submit.job_id,
    timeoutMs: options.timeoutMs ?? 180000,
  });
  if (!wait.completed) {
    return {
      ...wait,
      command: 'image send',
      next_step: `Image prompt submitted but generation did not finish before timeout. Run \`poai image wait --job-id ${submit.job_id}\`, then collect.`,
    };
  }

  const collect = await runImageCollect({
    ...options,
    jobId: submit.job_id,
  });
  return {
    ...collect,
    command: 'image send',
  };
}

export async function runImageSubmit(options = {}) {
  const prompt = String(options.prompt ?? '').trim();
  if (!prompt) {
    throw new Error('Missing --prompt for image submit');
  }

  const attachment = options.filePath ? await validateImageAttachmentFile(options.filePath) : null;
  if (attachment && !attachment.ok) {
    return imageFailureResult('image submit', 'attach', null, null, [attachment.diagnostic], 'Fix `--file` and retry with a supported local image.');
  }

  const endpointResult = await connectFirstAvailable(buildCandidateEndpoints(options), options);
  if (!endpointResult.browser) {
    return imageFailureResult('image submit', 'connect', null, endpointResult.endpoint, endpointResult.diagnostics, 'Run `poai browser launch`, then rerun `poai discover --json`.');
  }

  const { browser, endpoint } = endpointResult;
  try {
    const modelPlan = await selectImageSubmitModel(browser, options);
    if (!modelPlan.ok) {
      return imageFailureResult('image submit', 'model', null, endpoint, [modelPlan.diagnostic], 'Select Instant, Thinking, or a supported Images mode in the managed browser, then retry.');
    }

    const page = await findOrOpenImagesPage(browser, { refresh: modelPlan.refreshImagesPage });
    const readiness = await checkImageReadiness(page);
    if (!readiness.ready) {
      return imageFailureResult('image submit', 'ready', null, endpoint, readiness.diagnostics, 'Complete login and rerun `poai discover --json` before submitting image prompts.');
    }

    const model = modelPlan.selection;

    const beforeArtifactCount = await countImageArtifacts(page);
    const context = page.context();
    const knownPages = new Set(context.pages());
    if (attachment) {
      const attachResult = await attachImageToComposer(page, attachment.path);
      if (!attachResult.attached) {
        return imageFailureResult('image submit', 'attach', null, endpoint, [attachResult.diagnostic], 'Run `poai discover --json` and inspect image upload availability before retrying.');
      }
    }

    const composer = await firstVisibleLocator(page, COMPOSER_SELECTOR);
    await fillComposer(page, composer, prompt);
    if (attachment) {
      const ready = await waitForSubmitReady(page, options.timeoutMs ?? 30000);
      if (!ready) {
        return imageFailureResult('image submit', 'attach', null, endpoint, [{
          category: 'image_upload_timeout',
          message: 'Timed out waiting for the image composer to become ready after file selection.',
          next_step: 'Inspect the visible browser. The reference image may still be uploading or the UI may have drifted.',
        }], 'Inspect the visible browser and retry with a smaller non-sensitive image.');
      }
    }
    await submitPrompt(page);
    const resultPage = await resolvePostSubmitPage(browser, page, knownPages);
    const job = await createImageJob({
      endpoint,
      beforeArtifactCount,
      attachmentCount: attachment ? 1 : 0,
      model,
      pageUrl: sanitizeUrl(resultPage.url()),
      pageKey: pageKey(resultPage.url()),
      pageIndex: resultPage.context().pages().indexOf(resultPage),
      resultSurface: classifyOpenaiSurface(resultPage.url()),
    }, options);

    return {
      ok: true,
      command: 'image submit',
      endpoint,
      phase: 'submit',
      job_id: job.id,
      submitted: true,
      completed: false,
      attachment_count: attachment ? 1 : 0,
      artifact_count: 0,
      model: job.model,
      diagnostics: [],
      next_step: `Run \`poai image wait --job-id ${job.id}\`, then \`poai image collect --job-id ${job.id}\`.`,
    };
  } finally {
    await browser.close();
  }
}

export async function runImageRevise(options = {}) {
  const prompt = String(options.prompt ?? '').trim();
  if (!prompt) {
    throw new Error('Missing --prompt for image revise');
  }

  const parentJob = await readJob(options.jobId, options);
  if (parentJob.type !== 'image') {
    throw new Error(`Job ${parentJob.id} is not an image job.`);
  }

  const attachment = options.filePath ? await validateImageAttachmentFile(options.filePath) : null;
  if (attachment && !attachment.ok) {
    return imageFailureResult('image revise', 'attach', parentJob.id, parentJob.endpoint, [attachment.diagnostic], 'Fix `--file` and retry with a supported local image.');
  }

  const endpointResult = await connectFirstAvailable([parentJob.endpoint], options);
  if (!endpointResult.browser) {
    return imageFailureResult('image revise', 'connect', parentJob.id, parentJob.endpoint, endpointResult.diagnostics, 'Restart the managed browser or rerun `poai browser launch`.');
  }

  const { browser, endpoint } = endpointResult;
  try {
    const page = await findImageRevisionPage(browser, parentJob);
    if (!page) {
      return imageFailureResult('image revise', 'ready', parentJob.id, endpoint, [{
        category: 'parent_page_unavailable',
        message: 'The parent image conversation page is not open in the connected browser.',
        next_step: 'Open the parent conversation in the managed browser, then retry `poai image revise`.',
      }], 'Open the parent conversation in the managed browser, then retry `poai image revise`.');
    }
    const readiness = await checkImageReadiness(page);
    if (!readiness.ready) {
      return imageFailureResult('image revise', 'ready', parentJob.id, endpoint, readiness.diagnostics, 'Open the parent image conversation in the managed browser and retry.');
    }
    if (await isGenerating(page) && !(await hasCollectedImageOutput(page, parentJob))) {
      return imageFailureResult('image revise', 'ready', parentJob.id, endpoint, [{
        category: 'still_generating',
        message: 'The parent image conversation still appears to be generating.',
        next_step: `Run \`poai image wait --job-id ${parentJob.id}\` before submitting a revision.`,
      }], `Run \`poai image wait --job-id ${parentJob.id}\` before submitting a revision.`);
    }

    const modelPlan = await selectImageRevisionModel(browser, page, options);
    if (!modelPlan.ok) {
      const fallbackPlan = await parentModelFallback(page, parentJob, modelPlan.diagnostic, options);
      if (!fallbackPlan.ok) {
        return imageFailureResult('image revise', 'model', parentJob.id, endpoint, [modelPlan.diagnostic], 'Select a suitable image model in the managed browser or retry with `--model instant`.');
      }
      modelPlan.selection = fallbackPlan.selection;
      modelPlan.ok = true;
    }

    const beforeArtifactCount = await countImageArtifacts(page);
    const context = page.context();
    const knownPages = new Set(context.pages());
    if (attachment) {
      const attachResult = await attachImageToComposer(page, attachment.path);
      if (!attachResult.attached) {
        return imageFailureResult('image revise', 'attach', parentJob.id, endpoint, [attachResult.diagnostic], 'Inspect image upload availability before retrying.');
      }
    }

    const composer = await firstVisibleLocator(page, COMPOSER_SELECTOR);
    await fillComposer(page, composer, prompt);
    if (attachment) {
      const ready = await waitForSubmitReady(page, options.timeoutMs ?? 30000);
      if (!ready) {
        return imageFailureResult('image revise', 'attach', parentJob.id, endpoint, [{
          category: 'image_upload_timeout',
          message: 'Timed out waiting for the image composer to become ready after file selection.',
          next_step: 'Inspect the visible browser. The reference image may still be uploading or the UI may have drifted.',
        }], 'Inspect the visible browser and retry with a smaller non-sensitive image.');
      }
    }
    await submitPrompt(page);
    const resultPage = await resolvePostSubmitPage(browser, page, knownPages);
    const job = await createImageJob({
      endpoint,
      beforeArtifactCount,
      attachmentCount: attachment ? 1 : 0,
      model: modelPlan.selection,
      pageUrl: sanitizeUrl(resultPage.url()),
      pageKey: pageKey(resultPage.url()),
      pageIndex: resultPage.context().pages().indexOf(resultPage),
      resultSurface: classifyOpenaiSurface(resultPage.url()),
      parentJobId: parentJob.id,
    }, options);

    return {
      ok: true,
      command: 'image revise',
      endpoint,
      phase: 'submit',
      job_id: job.id,
      parent_job_id: parentJob.id,
      submitted: true,
      completed: false,
      attachment_count: attachment ? 1 : 0,
      artifact_count: 0,
      model: job.model,
      diagnostics: [],
      next_step: `Run \`poai image wait --job-id ${job.id}\`, then \`poai image collect --job-id ${job.id}\`.`,
    };
  } finally {
    await browser.close();
  }
}

export async function validateImageAttachmentFile(filePath) {
  const resolvedPath = resolve(String(filePath ?? ''));
  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch {
    return {
      ok: false,
      diagnostic: {
        category: 'file_not_found',
        message: 'Reference image file was not found.',
        next_step: 'Check `--file` and retry with an existing local image file.',
      },
    };
  }

  if (!fileStat.isFile()) {
    return {
      ok: false,
      diagnostic: {
        category: 'file_not_regular',
        message: 'Reference image path is not a regular file.',
        next_step: 'Retry with a readable PNG, JPEG, GIF, or WebP file.',
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
        message: 'Reference image file is not readable.',
        next_step: 'Check local file permissions and retry.',
      },
    };
  }

  const imageType = await detectImageType(resolvedPath);
  if (!imageType) {
    return {
      ok: false,
      diagnostic: {
        category: 'image_file_unsupported',
        message: 'Reference file is not a supported PNG, JPEG, GIF, or WebP image.',
        next_step: 'Retry with a supported non-sensitive image file.',
      },
    };
  }

  return {
    ok: true,
    path: resolvedPath,
    attachmentCount: 1,
    imageType,
  };
}

export async function runImageWait(options = {}) {
  const job = await readJob(options.jobId, options);
  if (job.type !== 'image') {
    throw new Error(`Job ${job.id} is not an image job.`);
  }
  const timeoutMs = options.timeoutMs ?? 180000;
  const endpointResult = await connectFirstAvailable([job.endpoint], options);
  if (!endpointResult.browser) {
    return imageFailureResult('image wait', 'connect', job.id, job.endpoint, endpointResult.diagnostics, 'Restart the managed browser or rerun `poai browser launch`.');
  }

  const { browser, endpoint } = endpointResult;
  try {
    const page = await findImageJobPage(browser, job);
    const response = await waitForImageArtifacts(page, job.before_artifact_count, timeoutMs);
    await updateJob(job.id, {
      status: response.completed ? 'completed' : 'timeout',
      phase: response.completed ? 'wait_complete' : 'wait_timeout',
      completed_at: response.completed ? new Date().toISOString() : job.completed_at,
      artifact_count: response.artifactCount,
    }, options);

    return {
      ok: true,
      command: 'image wait',
      endpoint,
      phase: response.completed ? 'wait_complete' : 'wait_timeout',
      job_id: job.id,
      submitted: true,
      completed: response.completed,
      artifact_count: response.artifactCount,
      diagnostics: response.diagnostics,
      next_step: response.completed
        ? `Run \`poai image collect --job-id ${job.id}\` to download generated image artifacts.`
        : 'The image was not complete before timeout. Retry wait or inspect the visible browser.',
    };
  } finally {
    await browser.close();
  }
}

export async function runImageCollect(options = {}) {
  const job = await readJob(options.jobId, options);
  if (job.type !== 'image') {
    throw new Error(`Job ${job.id} is not an image job.`);
  }
  const endpointResult = await connectFirstAvailable([job.endpoint], options);
  if (!endpointResult.browser) {
    return imageFailureResult('image collect', 'connect', job.id, job.endpoint, endpointResult.diagnostics, 'Restart the managed browser or rerun `poai browser launch`.');
  }

  const { browser, endpoint } = endpointResult;
  try {
    const page = await findImageJobPage(browser, job);
    const candidates = await getImageCandidates(page);
    const newCount = Math.max(0, candidates.length - job.before_artifact_count);
    if (newCount < 1) {
      return imageFailureResult('image collect', 'collect', job.id, endpoint, [{
        category: 'late_result_possible',
        message: 'No new generated image artifact was found for this job yet.',
        next_step: `Run \`poai image wait --job-id ${job.id}\` and retry collect.`,
      }], `Run \`poai image wait --job-id ${job.id}\` and retry collect.`);
    }

    const limit = options.maxArtifacts ?? newCount;
    const startIndex = job.before_artifact_count ?? 0;
    const outputDir = resolve(options.outputDir ?? defaultImageOutputDir(job.id));
    const artifacts = await downloadImageArtifacts(page, candidates.slice(startIndex, startIndex + Math.min(limit, newCount)), outputDir);
    await page.keyboard.press('Escape').catch(() => {});
    await updateJob(job.id, {
      status: 'collected',
      phase: 'collect',
      collected_at: new Date().toISOString(),
      artifact_count: candidates.length,
      output_count: artifacts.length,
    }, options);

    return {
      ok: true,
      command: 'image collect',
      endpoint,
      phase: 'collect',
      job_id: job.id,
      submitted: true,
      completed: true,
      artifact_count: artifacts.length,
      output_dir: outputDir,
      artifacts,
      diagnostics: [],
      next_step: 'Generated image artifacts collected. Job metadata does not store prompts or source URLs.',
    };
  } finally {
    await browser.close();
  }
}

export async function runImageInspect(options = {}) {
  const job = await readJob(options.jobId, options);
  if (job.type !== 'image') {
    throw new Error(`Job ${job.id} is not an image job.`);
  }

  const endpointResult = await connectFirstAvailable([job.endpoint], options);
  if (!endpointResult.browser) {
    return {
      ok: true,
      command: 'image inspect',
      endpoint: job.endpoint,
      phase: 'connect',
      job_id: job.id,
      parent_job_id: job.parent_job_id ?? null,
      page_found: false,
      page_match: 'unavailable',
      submitted: true,
      completed: isCompletedJob(job),
      attachment_count: job.attachment_count ?? 0,
      artifact_count: job.artifact_count ?? 0,
      new_artifact_count: 0,
      output_count: job.output_count ?? 0,
      generating: false,
      can_wait: false,
      can_collect: false,
      can_revise: false,
      model: job.model ?? null,
      diagnostics: endpointResult.diagnostics,
      next_step: 'Restart the managed browser or rerun `poai browser launch`, then retry inspect.',
    };
  }

  const { browser, endpoint } = endpointResult;
  try {
    const located = await findImageInspectPage(browser, job);
    if (!located.page) {
      return {
        ok: true,
        command: 'image inspect',
        endpoint,
        phase: 'inspect',
        job_id: job.id,
        parent_job_id: job.parent_job_id ?? null,
        page_found: false,
        page_match: located.match,
        submitted: true,
        completed: isCompletedJob(job),
        attachment_count: job.attachment_count ?? 0,
        artifact_count: job.artifact_count ?? 0,
        new_artifact_count: 0,
        output_count: job.output_count ?? 0,
        generating: false,
        can_wait: false,
        can_collect: false,
        can_revise: false,
        model: job.model ?? null,
        diagnostics: [{
          category: 'parent_page_unavailable',
          message: 'The image job conversation page is not open in the connected browser.',
          next_step: 'Open the job conversation in the managed browser, then retry inspect.',
        }],
        next_step: 'Open the job conversation in the managed browser, then retry inspect.',
      };
    }

    const candidates = await getImageCandidates(located.page);
    const artifactCount = candidates.length;
    const beforeCount = job.before_artifact_count ?? 0;
    const newArtifactCount = Math.max(0, artifactCount - beforeCount);
    const rawGenerating = await isGenerating(located.page);
    const collectedOutputVisible = await hasCollectedImageOutput(located.page, job);
    const generating = rawGenerating && !collectedOutputVisible;
    const uncollectedArtifactCount = Math.max(0, newArtifactCount - Number(job.output_count ?? 0));
    const canCollect = uncollectedArtifactCount > 0;
    const canWait = !canCollect && !isCompletedJob(job);
    const canRevise = !generating && (canCollect || isCompletedJob(job));

    return {
      ok: true,
      command: 'image inspect',
      endpoint,
      phase: 'inspect',
      job_id: job.id,
      parent_job_id: job.parent_job_id ?? null,
      page_found: true,
      page_match: located.match,
      page_confidence: located.confidence,
      page_url: sanitizeUrl(located.page.url()),
      submitted: true,
      completed: isCompletedJob(job) || canCollect,
      attachment_count: job.attachment_count ?? 0,
      artifact_count: artifactCount,
      before_artifact_count: beforeCount,
      new_artifact_count: newArtifactCount,
      uncollected_artifact_count: uncollectedArtifactCount,
      output_count: job.output_count ?? 0,
      generating,
      can_wait: canWait,
      can_collect: canCollect,
      can_revise: canRevise,
      model: job.model ?? null,
      diagnostics: buildInspectDiagnostics({ located, job, rawGenerating, generating, canCollect, canRevise }),
      next_step: chooseInspectNextStep({ job, generating, canCollect, canWait, canRevise }),
    };
  } finally {
    await browser.close();
  }
}

export async function runImageJobsList(options = {}) {
  const jobs = await listJobs({ ...options, jobType: 'image' });
  return {
    ok: true,
    command: 'image jobs list',
    jobs,
    count: jobs.length,
    filter: {
      status: options.jobStatus ?? null,
      limit: options.limit ?? 50,
    },
    diagnostics: [],
    next_step: jobs.length > 0
      ? 'Use `poai image jobs cleanup --status collected --yes` to delete selected metadata files.'
      : 'No image job metadata files found.',
  };
}

export async function runImageJobsCleanup(options = {}) {
  const result = await cleanupJobs({ ...options, jobType: 'image' });
  return {
    ok: true,
    command: 'image jobs cleanup',
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
      ? 'Dry run only. Add `--yes` to delete these image job metadata files.'
      : 'Selected image job metadata files deleted.',
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

async function selectImageSubmitModel(browser, options = {}) {
  const routing = resolveImageModelRequest({
    model: options.model,
    prompt: options.prompt,
    hasAttachment: Boolean(options.filePath),
  });
  if (isImageModeRequest(routing.targetModel)) {
    const page = await findOrOpenImagesPage(browser);
    const selection = await selectModelForAction(page, {
      capability: 'image',
      requestedModel: routing.targetModel,
    });
    return selection.ok
      ? { ok: true, selection: enrichImageModelSelection(selection, routing), refreshImagesPage: false }
      : { ok: false, diagnostic: selection.diagnostic };
  }

  const page = await findOrOpenTopModelPage(browser);
  const selection = await selectModelForAction(page, {
    capability: 'chat',
    requestedModel: imageTopModelRequest(routing.targetModel),
  });
  return selection.ok
    ? {
      ok: true,
      selection: enrichImageModelSelection(selection, routing),
      refreshImagesPage: true,
    }
    : { ok: false, diagnostic: selection.diagnostic };
}

async function selectImageRevisionModel(browser, preferredPage, options = {}) {
  const routing = resolveImageModelRequest({
    model: options.model,
    prompt: options.prompt,
    hasAttachment: Boolean(options.filePath),
  });
  if (isImageModeRequest(routing.targetModel)) {
    return {
      ok: false,
      diagnostic: {
        category: 'model_selection_failed',
        message: 'Images surface mode selection is only supported for new image submissions, not same-conversation revisions.',
        next_step: 'Retry with `--model auto`, `--model instant`, `--model thinking`, `--model extended`, or `--model heavy`.',
      },
    };
  }

  const page = await findTopModelPage(browser, preferredPage);
  const selection = await selectModelForAction(page, {
    capability: 'chat',
    requestedModel: imageTopModelRequest(routing.targetModel),
  });
  return selection.ok
    ? {
      ok: true,
      selection: enrichImageModelSelection(selection, routing),
    }
    : { ok: false, diagnostic: selection.diagnostic };
}

async function parentModelFallback(page, parentJob, diagnostic, options = {}) {
  if (diagnostic?.category !== 'model_selection_failed') {
    return { ok: false };
  }
  if (!(await hasCollectedImageOutput(page, parentJob))) {
    return { ok: false };
  }
  if (!parentJob.model?.selected_label) {
    return { ok: false };
  }
  return {
    ok: true,
    selection: {
      ok: true,
      capability: 'image',
      requested: normalizeModelRequest(options.model),
      selected_label: parentJob.model.selected_label,
      selected_testid: parentJob.model.selected_testid ?? null,
      changed: false,
      strategy: 'parent_collected_model_fallback',
    },
  };
}

async function findOrOpenTopModelPage(browser) {
  return findTopModelPage(browser, null);
}

async function findTopModelPage(browser, preferredPage) {
  if (
    preferredPage &&
    (await preferredPage.locator('button[data-testid="model-switcher-dropdown-button"]').count().catch(() => 0)) > 0
  ) {
    await preferredPage.bringToFront().catch(() => {});
    return preferredPage;
  }

  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (
        classifyOpenaiSurface(page.url()) === 'chatgpt' &&
        (await page.locator('button[data-testid="model-switcher-dropdown-button"]').count().catch(() => 0)) > 0
      ) {
        await page.bringToFront().catch(() => {});
        return page;
      }
    }
  }

  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  return page;
}

function imageTopModelRequest(requested) {
  if (requested === 'auto' || requested === 'image') {
    return 'instant';
  }
  if (requested === 'pro') {
    return 'thinking';
  }
  return requested;
}

function enrichImageModelSelection(selection, routing) {
  return {
    ...selection,
    capability: 'image',
    requested: routing.requested,
    strategy: routing.strategy,
    routing_difficulty: routing.routingDifficulty,
    requested_thinking_effort: routing.requestedThinkingEffort,
  };
}

async function findOrOpenImagesPage(browser, options = {}) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (classifyOpenaiSurface(page.url()) === 'chatgpt_images') {
        await page.bringToFront().catch(() => {});
        if (options.refresh) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(1500);
        }
        return page;
      }
    }
  }

  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = await context.newPage();
  await page.goto(IMAGES_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  return page;
}

async function resolvePostSubmitPage(browser, submitPage, knownPages) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (classifyOpenaiSurface(submitPage.url()) === 'chatgpt') {
      return submitPage;
    }
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (!knownPages.has(page) && classifyOpenaiSurface(page.url()) === 'chatgpt') {
          await page.bringToFront().catch(() => {});
          return page;
        }
      }
    }
    await sleep(250);
  }
  return submitPage;
}

async function findImageJobPage(browser, job) {
  if (job.page_key) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (pageKey(page.url()) === job.page_key) {
          await page.bringToFront().catch(() => {});
          return page;
        }
      }
    }
  }

  for (const context of browser.contexts()) {
    const pages = context.pages();
    if (Number.isInteger(job.page_index) && pages[job.page_index]) {
      const page = pages[job.page_index];
      if (classifyOpenaiSurface(page.url()) !== 'none') {
        const count = await countImageArtifacts(page);
        if ((job.artifact_count ?? 0) <= (job.before_artifact_count ?? 0) || count > (job.before_artifact_count ?? 0)) {
          await page.bringToFront().catch(() => {});
          return page;
        }
      }
    }
  }

  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if ((await countImageArtifacts(page)) > 0) {
        await page.bringToFront().catch(() => {});
        return page;
      }
    }
  }

  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (classifyOpenaiSurface(page.url()) === 'chatgpt_images') {
        await page.bringToFront().catch(() => {});
        return page;
      }
    }
  }

  return findOrOpenImagesPage(browser);
}

async function findImageRevisionPage(browser, job) {
  if (job.page_key) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (classifyOpenaiSurface(page.url()) === 'chatgpt' && pageKey(page.url()) === job.page_key) {
          await page.bringToFront().catch(() => {});
          return page;
        }
      }
    }
  }

  for (const context of browser.contexts()) {
    const pages = context.pages();
    if (Number.isInteger(job.page_index) && pages[job.page_index]) {
      const page = pages[job.page_index];
      if (classifyOpenaiSurface(page.url()) === 'chatgpt') {
        await page.bringToFront().catch(() => {});
        return page;
      }
    }
  }

  return null;
}

async function findImageInspectPage(browser, job) {
  if (job.page_key) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (pageKey(page.url()) === job.page_key) {
          return {
            page,
            match: 'page_key',
            confidence: 'high',
          };
        }
      }
    }
  }

  for (const context of browser.contexts()) {
    const pages = context.pages();
    if (Number.isInteger(job.page_index) && pages[job.page_index]) {
      const page = pages[job.page_index];
      if (classifyOpenaiSurface(page.url()) !== 'none') {
        return {
          page,
          match: 'page_index',
          confidence: job.page_key ? 'low_page_key_missed' : 'low_legacy_job',
        };
      }
    }
  }

  return {
    page: null,
    match: job.page_key ? 'page_key_missing' : 'page_unavailable',
    confidence: 'none',
  };
}

async function checkImageReadiness(page) {
  const loginPresent = await isPresent(page, LOGIN_SELECTOR);
  const composer = await firstVisibleLocator(page, COMPOSER_SELECTOR);
  if (loginPresent) {
    return {
      ready: false,
      diagnostics: [{
        category: 'not_logged_in',
        message: 'Login or signup controls are still visible on the images surface.',
        next_step: 'Complete login in the managed browser.',
      }],
    };
  }
  if (!composer) {
    return {
      ready: false,
      diagnostics: [{
        category: 'ui_drift',
        message: 'No visible image prompt composer was found.',
        next_step: 'Run `poai discover --json` and inspect the current images page state.',
      }],
    };
  }
  return { ready: true, diagnostics: [] };
}

async function attachImageToComposer(page, filePath) {
  const input = page.locator(COMPOSER_IMAGE_FILE_INPUT_SELECTOR).first();
  if ((await input.count().catch(() => 0)) === 0) {
    return {
      attached: false,
      diagnostic: {
        category: 'image_upload_unavailable',
        message: 'No composer-scoped image file input was found.',
        next_step: 'Run `poai discover --json` and confirm image file upload is available.',
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
          category: 'image_upload_unavailable',
          message: 'The image composer file input did not retain the selected file.',
          next_step: 'Inspect the visible browser and retry.',
        },
      };
    }
    return { attached: true };
  } catch (error) {
    return {
      attached: false,
      diagnostic: {
        category: 'image_upload_unavailable',
        message: formatError(error),
        next_step: 'Inspect the visible browser and retry with a supported image file.',
      },
    };
  }
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
    throw new Error('Could not find a send control for the image composer');
  }
}

async function waitForImageArtifacts(page, beforeArtifactCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let artifactCount = await countImageArtifacts(page);
  while (Date.now() < deadline) {
    artifactCount = await countImageArtifacts(page);
    const state = classifyImageWaitState({
      artifactCount,
      beforeArtifactCount,
      generating: await isGenerating(page),
    });
    if (state.completed) {
      return {
        completed: true,
        artifactCount,
        diagnostics: state.diagnostics,
      };
    }
    await sleep(1000);
  }
  return {
    completed: false,
    artifactCount,
    diagnostics: [{
      category: await isGenerating(page) ? 'still_generating' : 'timeout',
      message: await isGenerating(page)
        ? 'Timed out while the page still appears to be generating the image.'
        : 'Timed out waiting for generated image artifacts.',
      next_step: 'Inspect the visible browser. The image may still complete later; retry `poai image wait` before resubmitting.',
    }],
  };
}

export function classifyImageWaitState({ artifactCount, beforeArtifactCount, generating }) {
  if (Number(artifactCount) <= Number(beforeArtifactCount)) {
    return {
      completed: false,
      diagnostics: [],
    };
  }

  if (!generating) {
    return {
      completed: true,
      diagnostics: [],
    };
  }

  return {
    completed: true,
    diagnostics: [{
      category: 'stale_generation_indicator',
      message: 'A generated image artifact is ready while the page still shows a generation/thinking indicator.',
      next_step: 'Collect the ready artifact. Inspect the visible browser if you expected additional outputs.',
    }],
  };
}

async function downloadImageArtifacts(page, candidates, outputDir) {
  await mkdir(outputDir, { recursive: true });
  const artifacts = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const payload = await downloadImageCandidate(page, candidates[i]);
    const extension = extensionForContentType(payload.contentType);
    const filename = `image-${i + 1}.${extension}`;
    const path = resolve(outputDir, filename);
    await writeFile(path, Buffer.from(payload.base64, 'base64'));
    artifacts.push({
      filename,
      path,
      content_type: payload.contentType,
      bytes: payload.bytes,
    });
  }
  return artifacts;
}

async function downloadImageCandidate(page, candidate) {
  if (candidate.kind === 'file_button') {
    await openFileButtonImage(page, candidate);
    const dialogCandidate = (await getImageCandidates(page)).find((item) => item.kind === 'dialog_image');
    if (!dialogCandidate) {
      throw new Error('Generated file opened, but no preview image was found.');
    }
    return downloadImageCandidate(page, dialogCandidate);
  }

  return page.evaluate(async (src) => {
    const response = await fetch(src);
    if (!response.ok) {
      throw new Error(`Image download failed with HTTP ${response.status}.`);
    }
    const contentType = response.headers.get('content-type') || 'image/png';
    const buffer = await response.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return {
      contentType,
      bytes: bytes.length,
      base64: btoa(binary),
    };
  }, candidate.src);
}

async function countImageArtifacts(page) {
  return (await getImageCandidates(page)).length;
}

async function getImageCandidates(page) {
  const imageCandidates = await page.locator('[role="dialog"] img, [data-message-author-role="assistant"] img').evaluateAll((images) => images
    .map((image, index) => {
      const rect = image.getBoundingClientRect();
      const src = image.currentSrc || image.src || '';
      const inDialog = Boolean(image.closest('[role="dialog"]'));
      return {
        kind: inDialog ? 'dialog_image' : 'assistant_image',
        index,
        src,
        width: image.naturalWidth || Math.round(rect.width),
        height: image.naturalHeight || Math.round(rect.height),
        visible: rect.width >= 96 && rect.height >= 96,
      };
    })
    .filter((image) => image.visible)
    .filter((image) => image.width >= 128 && image.height >= 128)
    .filter((image) => /^(https?:|blob:)/.test(image.src)));

  const generatedPageImages = await page.locator('img').evaluateAll((images) => images
    .map((image, index) => {
      const rect = image.getBoundingClientRect();
      const src = image.currentSrc || image.src || '';
      const alt = image.alt || '';
      return {
        kind: 'generated_page_image',
        index,
        src,
        width: image.naturalWidth || Math.round(rect.width),
        height: image.naturalHeight || Math.round(rect.height),
        visible: rect.width >= 256 && rect.height >= 256,
        generatedAlt: /generated image|已生成图片/i.test(alt),
      };
    })
    .filter((image) => image.visible)
    .filter((image) => image.generatedAlt)
    .filter((image) => /^(https?:|blob:)/.test(image.src)));

  const fileButtons = await page.locator('[data-message-author-role="assistant"] button').evaluateAll((buttons) => buttons
    .map((button) => ({
      text: (button.innerText || '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((button) => /\.(png|jpe?g|webp|gif)$/i.test(button.text))
    .map((button, index) => ({
      kind: 'file_button',
      index,
      text: button.text,
    })));

  return dedupeImageCandidates([...imageCandidates, ...generatedPageImages, ...fileButtons]);
}

async function openFileButtonImage(page, candidate) {
  const buttons = page.locator('[data-message-author-role="assistant"] button');
  const count = await buttons.count().catch(() => 0);
  let imageButtonIndex = -1;
  for (let i = 0; i < count; i += 1) {
    const text = (await buttons.nth(i).innerText({ timeout: 1000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!/\.(png|jpe?g|webp|gif)$/i.test(text)) {
      continue;
    }
    imageButtonIndex += 1;
    if (imageButtonIndex === candidate.index) {
      await buttons.nth(i).click({ timeout: 5000 });
      await page.locator('[role="dialog"] img').first().waitFor({ state: 'visible', timeout: 10000 });
      return;
    }
  }
  throw new Error('Generated image file button was no longer available.');
}

function dedupeImageCandidates(candidates) {
  const seen = new Set();
  const deduped = [];
  for (const candidate of candidates) {
    const key = candidate.kind === 'file_button'
      ? `${candidate.kind}:${candidate.text}`
      : `${candidate.kind}:${candidate.src}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function isCompletedJob(job) {
  return job.status === 'completed' || job.status === 'collected' || Number(job.output_count ?? 0) > 0;
}

function buildInspectDiagnostics({ located, job, rawGenerating, generating, canCollect, canRevise }) {
  const diagnostics = [];
  if (located.confidence?.startsWith('low')) {
    diagnostics.push({
      category: 'low_confidence_page_match',
      message: 'The job page was matched by page index instead of page key.',
      next_step: 'Use wait/collect carefully. If the page looks wrong, reopen the intended conversation before continuing.',
    });
  }
  if (generating) {
    diagnostics.push({
      category: 'still_generating',
      message: 'The page still shows a visible generation/thinking indicator.',
      next_step: `Run \`poai image wait --job-id ${job.id}\` before submitting a revision.`,
    });
  } else if (rawGenerating && isCompletedJob(job)) {
    diagnostics.push({
      category: 'stale_generation_indicator',
      message: 'The page shows an old generation/thinking control, but the collected output is visible.',
      next_step: 'Revision is allowed; use `poai image revise` if you want another version.',
    });
  }
  if (canCollect) {
    diagnostics.push({
      category: 'artifact_ready',
      message: 'At least one generated artifact appears ready to collect.',
      next_step: `Run \`poai image collect --job-id ${job.id}\`.`,
    });
  }
  if (isCompletedJob(job) && !canRevise) {
    diagnostics.push({
      category: 'revision_not_ready',
      message: 'The job is marked complete locally, but the live page is not ready for revision.',
      next_step: 'Inspect the visible browser before revising.',
    });
  }
  return diagnostics;
}

function chooseInspectNextStep({ job, generating, canCollect, canWait, canRevise }) {
  if (canCollect) {
    return `Run \`poai image collect --job-id ${job.id}\`.`;
  }
  if (generating || canWait) {
    return `Run \`poai image wait --job-id ${job.id}\`.`;
  }
  if (canRevise) {
    return `Run \`poai image revise --job-id ${job.id} --prompt <text>\` to continue this image conversation.`;
  }
  return 'Inspect the visible browser before deciding whether to wait, collect, or revise.';
}

async function isGenerating(page) {
  for (const selector of STOP_SELECTORS) {
    if (await firstVisibleLocator(page, selector)) {
      return true;
    }
  }
  for (const selector of GENERATING_HINT_SELECTORS) {
    if (await firstVisibleLocator(page, selector)) {
      return true;
    }
  }
  return false;
}

async function hasCollectedImageOutput(page, job) {
  if (job.status !== 'collected') {
    return false;
  }
  const expectedCount = Math.max(
    Number(job.artifact_count ?? 0),
    Number(job.before_artifact_count ?? 0),
    1,
  );
  return (await countImageArtifacts(page)) >= expectedCount;
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

function imageFailureResult(command, phase, jobId, endpoint, diagnostics, nextStep) {
  return {
    ok: true,
    command,
    endpoint,
    phase,
    job_id: jobId,
    submitted: false,
    completed: false,
    artifact_count: 0,
    artifacts: [],
    diagnostics,
    next_step: nextStep,
  };
}

function extensionForContentType(contentType) {
  const normalized = String(contentType ?? '').toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) {
    return 'jpg';
  }
  if (normalized.includes('webp')) {
    return 'webp';
  }
  if (normalized.includes('gif')) {
    return 'gif';
  }
  return 'png';
}

async function detectImageType(filePath) {
  const extension = extname(filePath).toLowerCase();
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(16);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, result.bytesRead);
    if (isPng(bytes)) {
      return 'png';
    }
    if (isJpeg(bytes)) {
      return 'jpeg';
    }
    if (isGif(bytes)) {
      return 'gif';
    }
    if (isWebp(bytes)) {
      return 'webp';
    }
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)) {
      return extension.replace(/^\./, '').replace('jpg', 'jpeg');
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isPng(bytes) {
  return bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
}

function isJpeg(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isGif(bytes) {
  const header = bytes.subarray(0, 6).toString('ascii');
  return header === 'GIF87a' || header === 'GIF89a';
}

function isWebp(bytes) {
  return bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

function pageKey(url) {
  return createHash('sha256').update(String(url ?? '')).digest('hex').slice(0, 16);
}

function formatError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0];
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
