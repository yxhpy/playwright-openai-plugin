import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chooseModelOption,
  normalizeModelRequest,
} from '../src/model.js';

const LIVE_MODEL_OPTIONS = [
  {
    testid: 'model-switcher-gpt-5-3',
    text: 'Instant 适用于日常聊天',
  },
  {
    testid: 'model-switcher-gpt-5-4-thinking',
    text: 'Thinking 适用于解答复杂问题',
  },
  {
    testid: 'model-switcher-gpt-5-4-pro',
    text: 'Pro 研究级智能模型',
  },
];

test('chooseModelOption prefers Pro for automatic chat actions', () => {
  const choice = chooseModelOption(LIVE_MODEL_OPTIONS, {
    capability: 'chat',
    requestedModel: 'auto',
  });

  assert.equal(choice.testid, 'model-switcher-gpt-5-4-pro');
});

test('chooseModelOption prefers Standard for automatic image actions', () => {
  const choice = chooseModelOption([
    {
      role: 'menuitemradio',
      testid: '',
      text: '进阶',
    },
    {
      role: 'menuitemradio',
      testid: '',
      text: '标准',
    },
    {
      role: 'menuitemradio',
      testid: 'model-switcher-gpt-5-4-pro',
      text: 'Pro 研究级智能模型',
    },
  ], {
    capability: 'image',
    requestedModel: 'auto',
  });

  assert.equal(choice.text, '标准');
});

test('chooseModelOption supports explicit image mode aliases', () => {
  assert.equal(
    chooseModelOption([
      {
        role: 'menuitemradio',
        testid: '',
        text: '标准',
      },
      {
        role: 'menuitemradio',
        testid: '',
        text: '进阶',
      },
    ], {
      capability: 'image',
      requestedModel: 'advanced',
    }).text,
    '进阶',
  );
});

test('chooseModelOption supports explicit aliases', () => {
  assert.equal(
    chooseModelOption(LIVE_MODEL_OPTIONS, {
      capability: 'chat',
      requestedModel: 'thinking',
    }).testid,
    'model-switcher-gpt-5-4-thinking',
  );
  assert.equal(
    chooseModelOption(LIVE_MODEL_OPTIONS, {
      capability: 'chat',
      requestedModel: 'instant',
    }).testid,
    'model-switcher-gpt-5-3',
  );
});

test('chooseModelOption can match direct label or test id fragments', () => {
  assert.equal(
    chooseModelOption(LIVE_MODEL_OPTIONS, {
      capability: 'chat',
      requestedModel: '研究级',
    }).testid,
    'model-switcher-gpt-5-4-pro',
  );
  assert.equal(
    chooseModelOption(LIVE_MODEL_OPTIONS, {
      capability: 'chat',
      requestedModel: '5-4-thinking',
    }).testid,
    'model-switcher-gpt-5-4-thinking',
  );
});

test('normalizeModelRequest defaults blank input to auto', () => {
  assert.equal(normalizeModelRequest(undefined), 'auto');
  assert.equal(normalizeModelRequest(''), 'auto');
  assert.equal(normalizeModelRequest(' Pro '), 'pro');
});
