import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeCsdnMarkdown,
  isPublishConfirmed,
  parseImageMap,
  prepareCsdnMarkdown,
  validatePublishSettings,
  validateSourceUrl,
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

test('validateSourceUrl accepts only http and https URLs', () => {
  assert.equal(validateSourceUrl('https://example.com/a').ok, true);
  assert.equal(validateSourceUrl('http://example.com/a').ok, true);
  assert.equal(validateSourceUrl('ftp://example.com/a').ok, false);
  assert.equal(validateSourceUrl('not-a-url').ok, false);
});

test('validatePublishSettings detects missing requested CSDN fields', () => {
  const diagnostics = validatePublishSettings({
    requested: {
      cover: true,
      summary: '摘要',
      tags: ['Playwright', 'CSDN'],
      category: 'AI编程',
      articleType: 'original',
      sourceUrl: 'https://example.com/original',
      visibility: 'fans',
    },
    results: [
      { field: 'category', ok: false },
    ],
    settings: {
      cover_uploaded: false,
      summary: '',
      tags_text: '文章标签 Playwright',
      category_text: '分类专栏',
      article_type: 'repost',
      source_url: '',
      visibility: 'public',
    },
  });
  const categories = diagnostics.map((item) => item.category);

  assert.equal(categories.includes('category_not_filled'), true);
  assert.equal(categories.includes('cover_not_confirmed'), true);
  assert.equal(categories.includes('summary_not_confirmed'), true);
  assert.equal(categories.includes('tag_not_confirmed'), true);
  assert.equal(categories.includes('category_not_confirmed'), true);
  assert.equal(categories.includes('article_type_not_confirmed'), true);
  assert.equal(categories.includes('source_url_not_confirmed'), true);
  assert.equal(categories.includes('visibility_not_confirmed'), true);
});

test('validatePublishSettings passes when requested CSDN fields are confirmed', () => {
  const diagnostics = validatePublishSettings({
    requested: {
      cover: true,
      summary: '摘要',
      tags: ['Playwright', 'CSDN'],
      category: 'AI编程',
      articleType: '原创',
      sourceUrl: 'https://example.com/original',
      visibility: '粉丝可见',
    },
    results: [
      { field: 'category', ok: true },
    ],
    settings: {
      cover_uploaded: true,
      summary: '摘要',
      tags_text: '文章标签 Playwright CSDN',
      category_text: '分类专栏 AI编程',
      article_type: 'original',
      source_url: 'https://example.com/original',
      visibility: 'read_need_fans',
    },
  });

  assert.deepEqual(diagnostics, []);
});
