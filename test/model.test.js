import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyImagePromptDifficulty,
  chooseModelOption,
  normalizeModelRequest,
  resolveImageModelRequest,
} from '../src/model.js';

const LIVE_MODEL_OPTIONS = [
  {
    testid: 'model-switcher-gpt-5-3',
    text: 'Instant 适用于日常聊天',
  },
  {
    testid: 'model-switcher-gpt-5-5-thinking',
    text: 'Thinking 适用于解答复杂问题',
  },
  {
    testid: 'model-switcher-gpt-5-5-pro',
    text: 'Pro 研究级智能模型',
  },
];

test('chooseModelOption prefers Pro for automatic chat actions', () => {
  const choice = chooseModelOption(LIVE_MODEL_OPTIONS, {
    capability: 'chat',
    requestedModel: 'auto',
  });

  assert.equal(choice.testid, 'model-switcher-gpt-5-5-pro');
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
      testid: 'model-switcher-gpt-5-5-pro',
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
    'model-switcher-gpt-5-5-thinking',
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
    'model-switcher-gpt-5-5-pro',
  );
  assert.equal(
    chooseModelOption([
      {
        testid: 'model-switcher-gpt-5-4-thinking',
        text: 'Thinking 适用于解答复杂问题',
      },
    ], {
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

test('classifyImagePromptDifficulty routes simple prompts to instant', () => {
  const result = classifyImagePromptDifficulty('一张可爱的猫头像');

  assert.equal(result.level, 'simple');
  assert.equal(result.targetModel, 'instant');
});

test('classifyImagePromptDifficulty routes complex image prompts to thinking', () => {
  const result = classifyImagePromptDifficulty(
    '生成一张电商产品主图海报，包含中文标题、英文副标题、logo、价格标签、清晰排版、写实摄影光影，并严格保持参考图里的产品包装一致。',
    { hasAttachment: true },
  );

  assert.equal(result.level, 'expert');
  assert.equal(result.targetModel, 'thinking');
  assert.equal(result.requestedThinkingEffort, 'heavy');
});

test('resolveImageModelRequest maps auto and thinking effort requests for images', () => {
  assert.deepEqual(
    resolveImageModelRequest({
      model: 'auto',
      prompt: '透明背景角色精灵动作图集，9 帧，保持角色一致性。',
    }),
    {
      requested: 'auto',
      targetModel: 'thinking',
      routingDifficulty: 'complex',
      requestedThinkingEffort: 'extended',
      strategy: 'image_auto_complex',
    },
  );

  assert.deepEqual(
    resolveImageModelRequest({ model: 'heavy', prompt: '角色设定图' }),
    {
      requested: 'heavy',
      targetModel: 'thinking',
      routingDifficulty: 'manual',
      requestedThinkingEffort: 'heavy',
      strategy: 'image_thinking_effort_explicit',
    },
  );
});

test('resolveImageModelRequest keeps image surface modes and avoids Pro for image generation', () => {
  assert.equal(resolveImageModelRequest({ model: 'advanced' }).targetModel, 'advanced');
  assert.deepEqual(
    resolveImageModelRequest({ model: 'pro', prompt: '复杂产品海报' }),
    {
      requested: 'pro',
      targetModel: 'thinking',
      routingDifficulty: 'manual',
      requestedThinkingEffort: 'heavy',
      strategy: 'image_pro_unavailable_to_thinking',
    },
  );
});
