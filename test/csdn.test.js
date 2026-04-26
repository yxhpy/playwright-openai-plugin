import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeCsdnMarkdown,
  isPublishConfirmed,
  parseImageMap,
  prepareCsdnMarkdown,
} from '../src/csdn.js';

test('parseImageMap accepts stable placeholder keys', () => {
  const map = parseImageMap(['hero=./fixtures/hero.png', 'step_1=/tmp/step.jpg']);

  assert.equal(Object.keys(map).length, 2);
  assert.match(map.hero, /fixtures\/hero\.png$/);
  assert.equal(map.step_1, '/tmp/step.jpg');
});

test('parseImageMap rejects ambiguous mappings', () => {
  assert.throws(() => parseImageMap(['hero']), /Invalid --image value/);
  assert.throws(() => parseImageMap(['bad key=/tmp/a.png']), /Invalid --image key/);
});

test('analyzeCsdnMarkdown detects missing CSDN image mappings', () => {
  const result = analyzeCsdnMarkdown('正文\n\n{{csdn:image:hero}}\n', {
    title: '标题',
    imageKeys: [],
  });

  assert.equal(result.placeholder_count, 1);
  assert.equal(result.diagnostics[0].category, 'missing_image_mapping');
});

test('analyzeCsdnMarkdown warns about local markdown images', () => {
  const result = analyzeCsdnMarkdown('![架构图](./images/arch.png)\n', {
    title: '标题',
    imageKeys: [],
  });

  assert.equal(result.diagnostics.some((item) => item.category === 'local_markdown_image'), true);
});

test('prepareCsdnMarkdown can strip a duplicate title heading', () => {
  const result = prepareCsdnMarkdown('# 文章标题\n\n正文', {
    title: '文章标题',
    stripTitleHeading: true,
  });

  assert.equal(result.markdown, '正文\n');
});

test('prepareCsdnMarkdown normalizes excessive blank lines', () => {
  const result = prepareCsdnMarkdown('第一段\n\n\n\n## 小节\n内容');

  assert.equal(result.markdown, '第一段\n\n## 小节\n内容\n');
});

test('isPublishConfirmed requires the exact article title', () => {
  assert.equal(isPublishConfirmed('文章标题', '文章标题'), true);
  assert.equal(isPublishConfirmed('文章标题', ' 文章标题 '), true);
  assert.equal(isPublishConfirmed('文章标题', '其他标题'), false);
  assert.equal(isPublishConfirmed('文章标题', ''), false);
});
