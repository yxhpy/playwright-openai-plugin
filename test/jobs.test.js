import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  cleanupJobs,
  createChatJob,
  createImageJob,
  jobPath,
  listJobs,
} from '../src/jobs.js';

test('createChatJob stores only non-secret metadata', async () => {
  const jobsDir = await makeJobsDir();
  try {
    const job = await createChatJob({
      endpoint: 'http://127.0.0.1:9333',
      beforeAssistantCount: 2,
      attachmentCount: 1,
      model: {
        ok: true,
        capability: 'chat',
        requested: 'auto',
        selected_label: 'Pro 研究级智能模型',
        selected_testid: 'model-switcher-gpt-5-4-pro',
        strategy: 'auto_priority',
      },
      toolModes: ['web_search', 'deep_research', 'unsafe mode', '../../bad'],
      pageUrl: 'https://chatgpt.com/c/[redacted]',
      prompt: 'NEVER_PERSIST_PROMPT',
      response: 'NEVER_PERSIST_RESPONSE',
      filePath: '/tmp/NEVER_PERSIST_PATH.txt',
      fileName: 'NEVER_PERSIST_NAME.txt',
      fileContents: 'NEVER_PERSIST_FILE_CONTENTS',
    }, { jobsDir });

    const raw = await readFile(jobPath(job.id, { jobsDir }), 'utf8');
    const stored = JSON.parse(raw);

    assert.equal(stored.type, 'chat');
    assert.equal(stored.status, 'submitted');
    assert.equal(stored.phase, 'submit');
    assert.equal(stored.endpoint, 'http://127.0.0.1:9333');
    assert.equal(stored.before_assistant_count, 2);
    assert.equal(stored.attachment_count, 1);
    assert.equal(stored.model.selected_testid, 'model-switcher-gpt-5-4-pro');
    assert.deepEqual(stored.tool_modes, ['web_search', 'deep_research']);
    assert.deepEqual((await listJobs({ jobsDir }))[0].tool_modes, ['web_search', 'deep_research']);
    assert.equal(stored.page_url, 'https://chatgpt.com/c/[redacted]');
    assert.equal(stored.prompt, undefined);
    assert.equal(stored.response, undefined);
    assert.equal(stored.filePath, undefined);
    assert.equal(stored.fileName, undefined);
    assert.equal(stored.fileContents, undefined);
    assert.equal(raw.includes('NEVER_PERSIST_PROMPT'), false);
    assert.equal(raw.includes('NEVER_PERSIST_RESPONSE'), false);
    assert.equal(raw.includes('NEVER_PERSIST_PATH'), false);
    assert.equal(raw.includes('NEVER_PERSIST_NAME'), false);
    assert.equal(raw.includes('NEVER_PERSIST_FILE_CONTENTS'), false);
  } finally {
    await rm(jobsDir, { recursive: true, force: true });
  }
});

test('createImageJob stores only non-secret image metadata', async () => {
  const jobsDir = await makeJobsDir();
  try {
    const job = await createImageJob({
      endpoint: 'http://127.0.0.1:9333',
      beforeArtifactCount: 12,
      attachmentCount: 1,
      parentJobId: '11111111-1111-1111-1111-111111111111',
      model: {
        ok: true,
        capability: 'image',
        requested: 'auto',
        selected_label: '进阶专业',
        selected_testid: null,
        strategy: 'current_accepted',
      },
      pageUrl: 'https://chatgpt.com/images/',
      pageKey: 'abc123hash',
      pageIndex: 2,
      resultSurface: 'chatgpt',
      prompt: 'NEVER_PERSIST_IMAGE_PROMPT',
      sourceUrl: 'https://NEVER_PERSIST_SOURCE_URL.example/image.png',
      outputDir: '/tmp/NEVER_PERSIST_OUTPUT_DIR',
      filePath: '/tmp/NEVER_PERSIST_IMAGE_PATH.png',
      fileName: 'NEVER_PERSIST_IMAGE_NAME.png',
      fileContents: 'NEVER_PERSIST_IMAGE_CONTENTS',
    }, { jobsDir });

    const raw = await readFile(jobPath(job.id, { jobsDir }), 'utf8');
    const stored = JSON.parse(raw);

    assert.equal(stored.type, 'image');
    assert.equal(stored.status, 'submitted');
    assert.equal(stored.phase, 'submit');
    assert.equal(stored.before_artifact_count, 12);
    assert.equal(stored.attachment_count, 1);
    assert.equal(stored.parent_job_id, '11111111-1111-1111-1111-111111111111');
    assert.equal(stored.artifact_count, 0);
    assert.equal(stored.output_count, 0);
    assert.equal(stored.page_index, 2);
    assert.equal(stored.result_surface, 'chatgpt');
    assert.equal(stored.model.selected_label, '进阶专业');
    assert.equal(stored.page_key, 'abc123hash');
    assert.equal(JSON.stringify(await listJobs({ jobsDir })).includes('abc123hash'), false);
    assert.equal(stored.prompt, undefined);
    assert.equal(stored.sourceUrl, undefined);
    assert.equal(stored.outputDir, undefined);
    assert.equal(stored.filePath, undefined);
    assert.equal(stored.fileName, undefined);
    assert.equal(stored.fileContents, undefined);
    assert.equal(raw.includes('NEVER_PERSIST_IMAGE_PROMPT'), false);
    assert.equal(raw.includes('NEVER_PERSIST_SOURCE_URL'), false);
    assert.equal(raw.includes('NEVER_PERSIST_OUTPUT_DIR'), false);
    assert.equal(raw.includes('NEVER_PERSIST_IMAGE_PATH'), false);
    assert.equal(raw.includes('NEVER_PERSIST_IMAGE_NAME'), false);
    assert.equal(raw.includes('NEVER_PERSIST_IMAGE_CONTENTS'), false);
  } finally {
    await rm(jobsDir, { recursive: true, force: true });
  }
});

test('listJobs filters by status, sorts newest first, and applies limit', async () => {
  const jobsDir = await makeJobsDir();
  try {
    await writeFixtureJob(jobsDir, {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      status: 'collected',
      phase: 'collect',
      updated_at: '2026-04-21T01:00:00.000Z',
    });
    await writeFixtureJob(jobsDir, {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      status: 'submitted',
      phase: 'submit',
      updated_at: '2026-04-21T02:00:00.000Z',
    });
    await writeFixtureJob(jobsDir, {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      status: 'collected',
      phase: 'collect',
      updated_at: '2026-04-21T03:00:00.000Z',
    });

    const all = await listJobs({ jobsDir });
    assert.deepEqual(all.map((job) => job.id), [
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    ]);

    const collected = await listJobs({ jobsDir, jobStatus: 'collected', limit: 1 });
    assert.deepEqual(collected.map((job) => job.id), [
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
    ]);

    await writeFixtureJob(jobsDir, {
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      type: 'image',
      status: 'submitted',
      phase: 'submit',
      updated_at: '2026-04-21T04:00:00.000Z',
    });

    const chatOnly = await listJobs({ jobsDir, jobType: 'chat' });
    assert.equal(chatOnly.some((job) => job.type === 'image'), false);
    const imageOnly = await listJobs({ jobsDir, jobType: 'image' });
    assert.deepEqual(imageOnly.map((job) => job.id), [
      'dddddddd-dddd-dddd-dddd-dddddddddddd',
    ]);
  } finally {
    await rm(jobsDir, { recursive: true, force: true });
  }
});

test('cleanupJobs is dry-run by default and deletes selected metadata only with yes', async () => {
  const jobsDir = await makeJobsDir();
  try {
    await writeFixtureJob(jobsDir, {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      status: 'collected',
      phase: 'collect',
      updated_at: '2026-04-21T01:00:00.000Z',
    });
    await writeFixtureJob(jobsDir, {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      status: 'submitted',
      phase: 'submit',
      updated_at: '2026-04-21T02:00:00.000Z',
    });
    await writeFixtureJob(jobsDir, {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      status: 'collected',
      phase: 'collect',
      updated_at: '2026-04-21T03:00:00.000Z',
    });

    const preview = await cleanupJobs({ jobsDir, jobStatus: 'collected', limit: 1 });
    assert.equal(preview.dry_run, true);
    assert.deepEqual(preview.deleted, []);
    assert.deepEqual(preview.candidates.map((job) => job.id), [
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
    ]);
    assert.deepEqual(await sortedJobFiles(jobsDir), [
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.json',
      'cccccccc-cccc-cccc-cccc-cccccccccccc.json',
    ]);

    const deleted = await cleanupJobs({
      jobsDir,
      jobStatus: 'collected',
      limit: 1,
      yes: true,
    });
    assert.equal(deleted.dry_run, false);
    assert.deepEqual(deleted.deleted, [
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
    ]);
    assert.deepEqual(await sortedJobFiles(jobsDir), [
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.json',
    ]);
  } finally {
    await rm(jobsDir, { recursive: true, force: true });
  }
});

async function makeJobsDir() {
  return mkdtemp(join(tmpdir(), 'playwright-openai-jobs-'));
}

async function writeFixtureJob(jobsDir, overrides) {
  const job = {
    id: overrides.id,
    type: overrides.type ?? 'chat',
    status: overrides.status,
    phase: overrides.phase,
    endpoint: 'http://127.0.0.1:9333',
    page_url: 'https://chatgpt.com/c/[redacted]',
    created_at: '2026-04-21T00:00:00.000Z',
    updated_at: overrides.updated_at,
  };
  await writeFile(join(jobsDir, `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`, 'utf8');
}

async function sortedJobFiles(jobsDir) {
  return (await readdir(jobsDir)).filter((name) => name.endsWith('.json')).sort();
}
