import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultJobsDir } from './paths.js';

export async function createChatJob(data, options = {}) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    type: 'chat',
    status: 'submitted',
    phase: 'submit',
    endpoint: data.endpoint,
    before_assistant_count: data.beforeAssistantCount,
    attachment_count: data.attachmentCount ?? 0,
    model: sanitizeModel(data.model),
    page_url: data.pageUrl,
    created_at: now,
    updated_at: now,
  };
  await writeJob(job, options);
  return job;
}

export async function createImageJob(data, options = {}) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    type: 'image',
    status: 'submitted',
    phase: 'submit',
    endpoint: data.endpoint,
    before_artifact_count: data.beforeArtifactCount,
    attachment_count: data.attachmentCount ?? 0,
    artifact_count: 0,
    output_count: 0,
    model: sanitizeModel(data.model),
    page_url: data.pageUrl,
    page_key: safeString(data.pageKey),
    page_index: Number.isInteger(data.pageIndex) ? data.pageIndex : null,
    result_surface: typeof data.resultSurface === 'string' ? data.resultSurface : null,
    parent_job_id: safeJobId(data.parentJobId),
    created_at: now,
    updated_at: now,
  };
  await writeJob(job, options);
  return job;
}

export async function readJob(id, options = {}) {
  validateJobId(id);
  return JSON.parse(await readFile(jobPath(id, options), 'utf8'));
}

export async function updateJob(id, patch, options = {}) {
  const job = await readJob(id, options);
  const updated = {
    ...job,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  await writeJob(updated, options);
  return updated;
}

export async function listJobs(options = {}) {
  const dir = options.jobsDir ?? defaultJobsDir();
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const jobs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    try {
      const job = JSON.parse(await readFile(join(dir, entry.name), 'utf8'));
      jobs.push(summarizeJob(job));
    } catch {
      jobs.push({
        id: entry.name.replace(/\.json$/, ''),
        type: 'unknown',
        status: 'unreadable',
        phase: 'unreadable',
        updated_at: null,
        created_at: null,
        page_url: null,
      });
    }
  }

  return filterAndLimitJobs(jobs, options);
}

export async function cleanupJobs(options = {}) {
  const jobs = await listJobs(options);
  const deleted = [];
  if (options.yes) {
    for (const job of jobs) {
      await rm(jobPath(job.id, options), { force: true });
      deleted.push(job.id);
    }
  }

  return {
    candidates: jobs,
    deleted,
    dry_run: !options.yes,
  };
}

export function jobPath(id, options = {}) {
  validateJobId(id);
  return join(options.jobsDir ?? defaultJobsDir(), `${id}.json`);
}

function filterAndLimitJobs(jobs, options = {}) {
  const status = options.jobStatus;
  const type = options.jobType;
  const limit = readLimit(options.limit);
  const filtered = jobs
    .filter((job) => (type ? job.type === type : true))
    .filter((job) => (status ? job.status === status : true));
  return filtered
    .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
    .slice(0, limit);
}

function summarizeJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    phase: job.phase,
    endpoint: job.endpoint,
    page_url: job.page_url,
    page_index: job.page_index ?? null,
    result_surface: job.result_surface ?? null,
    parent_job_id: job.parent_job_id ?? null,
    attachment_count: job.attachment_count ?? 0,
    artifact_count: job.artifact_count ?? 0,
    output_count: job.output_count ?? 0,
    model: job.model ?? null,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at ?? null,
    collected_at: job.collected_at ?? null,
  };
}

function sanitizeModel(model) {
  if (!model?.ok && !model?.selected_label) {
    return null;
  }
  return {
    capability: safeString(model.capability),
    requested: safeString(model.requested),
    selected_label: safeString(model.selected_label),
    selected_testid: safeString(model.selected_testid),
    strategy: safeString(model.strategy),
  };
}

function safeString(value) {
  return typeof value === 'string' && value ? value : null;
}

function safeJobId(value) {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value) ? value : null;
}

function readLimit(value) {
  if (value === undefined || value === null) {
    return 50;
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid --limit value: ${value}`);
  }
  return limit;
}

async function writeJob(job, options = {}) {
  const dir = options.jobsDir ?? defaultJobsDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`, 'utf8');
}

function validateJobId(id) {
  if (!id || !/^[a-f0-9-]{36}$/i.test(id)) {
    throw new Error(`Invalid job id: ${id ?? '(missing)'}`);
  }
}
