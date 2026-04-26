import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeXhsMarkdown,
  isPublishConfirmed,
  markdownToXhsText,
  prepareXhsMarkdown,
  runXhsCapabilities,
} from '../src/xhs.js';

test('prepareXhsMarkdown strips duplicate title heading when requested', () => {
  const result = prepareXhsMarkdown('# 标题\n\n正文', {
    title: '标题',
    stripTitleHeading: true,
  });

  assert.equal(result.markdown, '正文\n');
  assert.equal(result.text, '正文');
});

test('prepareXhsMarkdown appends repeatable Xiaohongshu topics', () => {
  const result = prepareXhsMarkdown('正文', {
    topics: ['AI工具', '#自动化'],
  });

  assert.equal(result.text, '正文\n\n#AI工具 #自动化');
});

test('markdownToXhsText converts a Xiaohongshu-friendly subset', () => {
  const text = markdownToXhsText([
    '## 小节',
    '',
    '第一段 **重点** 和 [链接](https://example.com)。',
    '',
    '- 要点一',
    '1. 步骤一',
    '',
    '#穿搭 #AI工具',
  ].join('\n'));

  assert.match(text, /小节/);
  assert.match(text, /第一段 重点 和 链接 https:\/\/example\.com。/);
  assert.match(text, /- 要点一/);
  assert.match(text, /1\. 步骤一/);
  assert.match(text, /#穿搭 #AI工具/);
});

test('analyzeXhsMarkdown requires media for automated note drafts', () => {
  const result = analyzeXhsMarkdown('正文\n', {
    title: '标题',
    imageCount: 0,
  });

  assert.equal(result.diagnostics.some((item) => item.category === 'media_required'), true);
});

test('analyzeXhsMarkdown warns about duplicate title heading', () => {
  const result = analyzeXhsMarkdown('# 标题\n\n正文\n', {
    title: '标题',
    imageCount: 1,
  });

  assert.equal(result.diagnostics.some((item) => item.category === 'duplicate_title_heading'), true);
});

test('analyzeXhsMarkdown flags markdown images as unsupported', () => {
  const result = analyzeXhsMarkdown('正文\n\n![图](./images/a.png)\n', {
    title: '标题',
    imageCount: 1,
  });

  assert.equal(result.diagnostics.some((item) => item.category === 'local_markdown_image_unsupported'), true);
});

test('analyzeXhsMarkdown rejects more than observed max image count', () => {
  const result = analyzeXhsMarkdown('正文\n', {
    title: '标题',
    imageCount: 19,
  });

  assert.equal(result.diagnostics.some((item) => item.category === 'too_many_images'), true);
});

test('runXhsCapabilities documents supported and manual surfaces', () => {
  const result = runXhsCapabilities();

  assert.equal(result.ok, true);
  assert.equal(result.supported.visibility.supported, true);
  assert.equal(result.supported.content_type_declaration.labels.ai, '笔记含AI合成内容');
  assert.equal(result.supported.schedule_publish.supported, true);
  assert.equal(result.supported.save_draft.supported, true);
  assert.equal(Boolean(result.not_yet_supported.cover_editing), true);
});

test('isPublishConfirmed requires exact Xiaohongshu note title', () => {
  assert.equal(isPublishConfirmed('小红书笔记', '小红书笔记'), true);
  assert.equal(isPublishConfirmed('小红书笔记', ' 小红书笔记 '), true);
  assert.equal(isPublishConfirmed('小红书笔记', '其他标题'), false);
  assert.equal(isPublishConfirmed('小红书笔记', ''), false);
});
