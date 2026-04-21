import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateAttachmentFile } from '../src/chat.js';

test('validateAttachmentFile accepts one readable regular file', async () => {
  const dir = await makeTempDir();
  try {
    const filePath = join(dir, 'safe-smoke.txt');
    await writeFile(filePath, 'POAI_SAFE_UPLOAD_CONTENT\n', 'utf8');

    const result = await validateAttachmentFile(filePath);

    assert.equal(result.ok, true);
    assert.equal(result.attachmentCount, 1);
    assert.equal(result.path, filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateAttachmentFile rejects missing files without echoing local path', async () => {
  const dir = await makeTempDir();
  try {
    const filePath = join(dir, 'missing-sensitive-name.txt');
    const result = await validateAttachmentFile(filePath);

    assert.equal(result.ok, false);
    assert.equal(result.diagnostic.category, 'file_not_found');
    assert.equal(result.diagnostic.message.includes(filePath), false);
    assert.equal(result.diagnostic.message.includes('missing-sensitive-name'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateAttachmentFile rejects directories without echoing local path', async () => {
  const dir = await makeTempDir();
  try {
    const nestedDir = join(dir, 'sensitive-directory-name');
    await mkdir(nestedDir);
    const result = await validateAttachmentFile(nestedDir);

    assert.equal(result.ok, false);
    assert.equal(result.diagnostic.category, 'file_not_regular');
    assert.equal(result.diagnostic.message.includes(nestedDir), false);
    assert.equal(result.diagnostic.message.includes('sensitive-directory-name'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), 'playwright-openai-attach-'));
}
