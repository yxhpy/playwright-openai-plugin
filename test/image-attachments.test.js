import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateImageAttachmentFile } from '../src/images.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFhQJ+Wn7zTAAAAABJRU5ErkJggg==',
  'base64',
);

test('validateImageAttachmentFile accepts a readable png image', async () => {
  const dir = await makeTempDir();
  try {
    const filePath = join(dir, 'safe-reference.png');
    await writeFile(filePath, ONE_PIXEL_PNG);

    const result = await validateImageAttachmentFile(filePath);

    assert.equal(result.ok, true);
    assert.equal(result.attachmentCount, 1);
    assert.equal(result.imageType, 'png');
    assert.equal(result.path, filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateImageAttachmentFile rejects unsupported files without echoing local path', async () => {
  const dir = await makeTempDir();
  try {
    const filePath = join(dir, 'sensitive-reference.txt');
    await writeFile(filePath, 'not an image', 'utf8');

    const result = await validateImageAttachmentFile(filePath);

    assert.equal(result.ok, false);
    assert.equal(result.diagnostic.category, 'image_file_unsupported');
    assert.equal(result.diagnostic.message.includes(filePath), false);
    assert.equal(result.diagnostic.message.includes('sensitive-reference'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateImageAttachmentFile rejects missing files without echoing local path', async () => {
  const dir = await makeTempDir();
  try {
    const filePath = join(dir, 'missing-private-reference.png');

    const result = await validateImageAttachmentFile(filePath);

    assert.equal(result.ok, false);
    assert.equal(result.diagnostic.category, 'file_not_found');
    assert.equal(result.diagnostic.message.includes(filePath), false);
    assert.equal(result.diagnostic.message.includes('missing-private-reference'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateImageAttachmentFile rejects directories without echoing local path', async () => {
  const dir = await makeTempDir();
  try {
    const nestedDir = join(dir, 'private-reference-dir');
    await mkdir(nestedDir);

    const result = await validateImageAttachmentFile(nestedDir);

    assert.equal(result.ok, false);
    assert.equal(result.diagnostic.category, 'file_not_regular');
    assert.equal(result.diagnostic.message.includes(nestedDir), false);
    assert.equal(result.diagnostic.message.includes('private-reference-dir'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), 'playwright-openai-image-attach-'));
}
