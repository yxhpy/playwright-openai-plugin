import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildChatToolModeAvailability,
  evaluateLatestChatResponseState,
  normalizeChatToolModes,
  validateAttachmentFile,
} from '../src/chat.js';

test('normalizeChatToolModes maps explicit CLI flags to safe mode ids', () => {
  assert.deepEqual(
    normalizeChatToolModes({
      webSearch: true,
      deepResearch: true,
      temporary: true,
      createImage: true,
    }),
    ['web_search', 'deep_research', 'temporary', 'create_image'],
  );

  assert.deepEqual(normalizeChatToolModes({}), []);
});

test('buildChatToolModeAvailability reports safe tool mode capabilities', () => {
  assert.deepEqual(
    buildChatToolModeAvailability({
      temporaryPresent: true,
      composerPlusPresent: true,
      menuText: '添加照片和文件 创建图片 深度研究 网页搜索',
    }),
    [
      {
        name: 'temporary',
        flag: '--temporary',
        status: 'available',
        evidence: 'temporary_chat_control',
        unavailable_reason: null,
      },
      {
        name: 'web_search',
        flag: '--web-search',
        status: 'available',
        evidence: 'composer_plus_menu',
        unavailable_reason: null,
      },
      {
        name: 'deep_research',
        flag: '--deep-research',
        status: 'available',
        evidence: 'composer_plus_menu',
        unavailable_reason: null,
      },
      {
        name: 'create_image',
        flag: '--create-image',
        status: 'available',
        evidence: 'composer_plus_menu',
        unavailable_reason: null,
      },
    ],
  );

  const unavailable = buildChatToolModeAvailability({
    temporaryPresent: false,
    composerPlusPresent: false,
    menuText: '网页搜索',
  });
  assert.deepEqual(unavailable.map((mode) => mode.status), [
    'unavailable',
    'unavailable',
    'unavailable',
    'unavailable',
  ]);
  assert.deepEqual(unavailable.map((mode) => mode.unavailable_reason), [
    'temporary_chat_control_missing',
    'composer_plus_unavailable',
    'composer_plus_unavailable',
    'composer_plus_unavailable',
  ]);
});

test('evaluateLatestChatResponseState treats image-only ChatGPT replies as complete', () => {
  const result = evaluateLatestChatResponseState({
    beforeAssistantCount: 0,
    assistantCount: 0,
    latestText: '',
    beforeImageArtifactCount: 0,
    imageArtifactCount: 2,
    generating: false,
    toolModes: ['create_image'],
  });

  assert.equal(result.completed, true);
  assert.equal(result.text, '');
  assert.equal(result.imageArtifactCount, 2);
});

test('evaluateLatestChatResponseState waits while image-only replies are still generating', () => {
  const result = evaluateLatestChatResponseState({
    beforeAssistantCount: 0,
    assistantCount: 0,
    latestText: '',
    beforeImageArtifactCount: 0,
    imageArtifactCount: 2,
    generating: true,
    toolModes: ['create_image'],
  });

  assert.equal(result.completed, false);
  assert.equal(result.imageArtifactCount, 2);
});

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
