import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  analyzeXArticleMarkdown,
  isPublishConfirmed,
  markdownToXArticleHtml,
  prepareXArticleMarkdown,
  xArticleInsertionPlan,
} from '../src/x-articles.js';

test('prepareXArticleMarkdown strips duplicate title heading when requested', () => {
  const result = prepareXArticleMarkdown('# 标题\n\n正文', {
    title: '标题',
    stripTitleHeading: true,
  });

  assert.equal(result.markdown, '正文\n');
  assert.equal(result.text, '正文');
});

test('analyzeXArticleMarkdown accepts existing local image paths', async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, 'a.png'), 'not-a-real-png-but-existing', 'utf8');
    const result = analyzeXArticleMarkdown('正文\n\n![本地图](./a.png)\n', {
      title: '标题',
      baseDir: dir,
    });

    assert.equal(result.diagnostics.some((item) => item.category === 'article_image_not_found'), false);
    assert.equal(result.diagnostics.some((item) => item.category === 'remote_article_image_unsupported'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('analyzeXArticleMarkdown rejects remote markdown images', () => {
  const result = analyzeXArticleMarkdown('正文\n\n![远程图](https://example.com/a.png)\n', {
    title: '标题',
  });

  assert.equal(result.diagnostics.some((item) => item.category === 'remote_article_image_unsupported'), true);
  assert.equal(result.diagnostics.some((item) => item.category === 'article_image_not_found'), false);
});

test('analyzeXArticleMarkdown requires standalone image lines', async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, 'a.png'), 'not-a-real-png-but-existing', 'utf8');
    const result = analyzeXArticleMarkdown('正文 ![内联图](./a.png)\n', {
      title: '标题',
      baseDir: dir,
    });

    assert.equal(result.diagnostics.some((item) => item.category === 'article_image_must_be_standalone'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('analyzeXArticleMarkdown rejects native blocks after local images', async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, 'a.png'), 'not-a-real-png-but-existing', 'utf8');
    const result = analyzeXArticleMarkdown('正文\n\n![图](./a.png)\n\n```js\nconsole.log(1)\n```\n', {
      title: '标题',
      baseDir: dir,
    });

    assert.equal(result.diagnostics.some((item) => item.category === 'article_native_block_after_image_unstable'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('analyzeXArticleMarkdown warns about duplicate title heading', () => {
  const result = analyzeXArticleMarkdown('# 标题\n\n正文\n', {
    title: '标题',
  });

  assert.equal(result.diagnostics.some((item) => item.category === 'duplicate_title_heading'), true);
});

test('markdownToXArticleHtml converts supported article structure', () => {
  const html = markdownToXArticleHtml([
    '## 小节',
    '',
    '第一段 **重点** 和 [链接](https://example.com)。',
    '',
    '> 引用 **内容** ✅',
    '',
    '- 要点一',
    '- 要点二',
    '',
    '1. 步骤一',
    '2. 步骤二',
  ].join('\n'));

  assert.match(html, /<h2>小节<\/h2>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<a href="https:\/\/example\.com">链接<\/a>/);
  assert.match(html, /<blockquote>引用 <strong>内容<\/strong> ✅<\/blockquote>/);
  assert.match(html, /<ul><li>要点一<\/li><li>要点二<\/li><\/ul>/);
  assert.match(html, /<ol><li>步骤一<\/li><li>步骤二<\/li><\/ol>/);
});

test('isPublishConfirmed requires exact title', () => {
  assert.equal(isPublishConfirmed('X Article', 'X Article'), true);
  assert.equal(isPublishConfirmed('X Article', ' X Article '), true);
  assert.equal(isPublishConfirmed('X Article', 'Other'), false);
  assert.equal(isPublishConfirmed('X Article', ''), false);
});

test('xArticleInsertionPlan separates native article blocks', () => {
  const plan = xArticleInsertionPlan([
    '正文',
    '',
    '---',
    '',
    '```js',
    'console.log("native")',
    '```',
    '',
    '$$E=mc^2$$',
    '',
    '{{x:post:https://x.com/OpenAI/status/2016959338523611621}}',
    '',
    '{{x:gif:celebrate}}',
    '',
    '![配图](./article.png)',
  ].join('\n'));

  assert.deepEqual(plan.map((operation) => operation.type), ['rich_text', 'divider', 'code', 'latex', 'x_post', 'gif', 'image']);
  assert.equal(plan[2].language, 'js');
  assert.equal(plan[2].code, 'console.log("native")');
  assert.equal(plan[3].tex, 'E=mc^2');
  assert.equal(plan[4].url, 'https://x.com/OpenAI/status/2016959338523611621');
  assert.equal(plan[5].query, 'celebrate');
  assert.equal(plan[6].alt, '配图');
  assert.equal(plan[6].path.endsWith('/article.png'), true);
});

test('xArticleInsertionPlan treats article URLs as plain text, not X posts', () => {
  const plan = xArticleInsertionPlan([
    '{{x:post:https://x.com/i/articles/2014467401203831233}}',
    '结尾',
  ].join('\n'));

  assert.deepEqual(plan.map((operation) => operation.type), ['rich_text']);
  assert.equal(plan[0].markdown.includes('{{x:post:https://x.com/i/articles/2014467401203831233}}'), true);
  assert.equal(plan[0].markdown.includes('结尾'), true);
});

test('analyzeXArticleMarkdown treats /i/articles URLs as plain text', () => {
  const result = analyzeXArticleMarkdown('{{x:post:https://x.com/i/articles/2014467401203831233}}', {
    title: '标题',
  });

  assert.equal(result.diagnostics.some((item) => item.category === 'x_post_url_invalid'), false);
  assert.equal(result.chars > 0, true);
});

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), 'playwright-openai-x-articles-'));
}
