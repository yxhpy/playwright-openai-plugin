const CHAT_MODEL_BUTTON_SELECTORS = [
  'button[data-testid="model-switcher-dropdown-button"]',
  'button[aria-label="模型选择器"]',
  'button[aria-label*="model selector" i]',
  'button[aria-haspopup="menu"]:has-text("ChatGPT")',
  'button[aria-haspopup="menu"]:has-text("Pro")',
];

const IMAGE_MODEL_BUTTON_SELECTORS = [
  'button[aria-haspopup="menu"]:has-text("标准")',
  'button[aria-haspopup="menu"]:has-text("Standard")',
  'button[aria-haspopup="menu"]:has-text("进阶")',
  'button[aria-haspopup="menu"]:has-text("Advanced")',
  'button[aria-haspopup="menu"]:has-text("专业")',
];

const MODEL_OPTION_SELECTOR = [
  '[role="menuitemradio"][data-testid*="model-switcher"]',
  '[role="menuitem"][data-testid*="model-switcher"]',
  '[data-testid^="model-switcher-gpt"]',
].join(', ');

const AUTO_PRIORITIES = {
  chat: ['gpt-5-4-pro', 'pro', 'gpt-5-4-thinking', 'thinking', 'gpt-5-3', 'instant'],
  image: ['standard', '标准', 'image', '图片', 'advanced', '进阶'],
};

const MODEL_ALIASES = {
  pro: ['gpt-5-4-pro', 'pro', '研究级', '专业'],
  thinking: ['gpt-5-4-thinking', 'thinking', '复杂', '思考'],
  instant: ['gpt-5-3', 'instant', '日常'],
  image: ['image', 'images', '图片', 'standard', '标准'],
  standard: ['standard', '标准'],
  advanced: ['advanced', '进阶'],
};

export async function selectModelForAction(page, options = {}) {
  const capability = options.capability ?? 'chat';
  const requestedModel = normalizeModelRequest(options.requestedModel);
  await dismissTransientOverlays(page);
  const button = await firstVisibleLocator(page, modelButtonSelectorForCapability(capability));
  if (!button) {
    return {
      ok: false,
      diagnostic: {
        category: 'model_selector_unavailable',
        message: 'No visible model selector was found before submitting the action.',
        next_step: 'Run `poai discover --json` and inspect the current OpenAI UI before retrying.',
      },
    };
  }

  const currentLabel = await readLocatorLabel(button);
  if (requestedModel === 'current' && currentLabel) {
    return buildModelResult({
      capability,
      requestedModel,
      label: currentLabel,
      testid: await button.getAttribute('data-testid').catch(() => null),
      changed: false,
      strategy: 'current',
    });
  }

  const optionsList = await openModelOptions(page, button, { capability });

  const choice = chooseModelOption(optionsList, { capability, requestedModel });
  if (choice) {
    await clickModelOption(page, choice);
    await page.waitForTimeout(500);
    return buildModelResult({
      capability,
      requestedModel,
      label: choice.text,
      testid: choice.testid,
      changed: true,
      strategy: requestedModel === 'auto' ? 'auto_priority' : 'explicit',
    });
  }

  const chatFallback = capability === 'chat'
    ? await clickChatModelFallback(page, requestedModel)
    : null;
  if (chatFallback) {
    return buildModelResult({
      capability,
      requestedModel,
      label: chatFallback.label,
      testid: chatFallback.testid,
      changed: true,
      strategy: requestedModel === 'auto' ? 'auto_priority_fallback' : 'explicit_fallback',
    });
  }

  const imageFallback = capability === 'image'
    ? await clickImageModeFallback(page, requestedModel)
    : null;
  if (imageFallback) {
    return buildModelResult({
      capability,
      requestedModel,
      label: imageFallback,
      testid: null,
      changed: true,
      strategy: requestedModel === 'auto' ? 'auto_standard_fallback' : 'explicit_fallback',
    });
  }

  await page.keyboard.press('Escape').catch(() => {});
  if (canUseCurrentModel({ capability, requestedModel, currentLabel })) {
    return buildModelResult({
      capability,
      requestedModel,
      label: currentLabel,
      testid: await button.getAttribute('data-testid').catch(() => null),
      changed: false,
      strategy: 'current_accepted',
    });
  }

  return {
    ok: false,
    diagnostic: {
      category: 'model_selection_failed',
      message: `Could not select a suitable ${capability} model from the current UI.`,
      next_step: requestedModel === 'auto'
        ? 'Open the model picker in the managed browser and verify that a suitable model is available.'
        : 'Check `--model` against the labels visible in the model picker.',
    },
  };
}

async function dismissTransientOverlays(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200).catch(() => {});
}

export function chooseModelOption(options, config = {}) {
  const requestedModel = normalizeModelRequest(config.requestedModel);
  const capability = config.capability ?? 'chat';
  const candidates = dedupeOptions(options)
    .filter((option) => capability === 'image' ? option.text : option.testid);
  if (requestedModel !== 'auto') {
    return candidates.find((option) => modelOptionMatches(option, requestedModel)) ?? null;
  }

  for (const term of AUTO_PRIORITIES[capability] ?? AUTO_PRIORITIES.chat) {
    const match = candidates.find((option) => modelOptionMatches(option, term));
    if (match) {
      return match;
    }
  }
  return null;
}

export function sanitizeModelSelection(selection) {
  if (!selection?.ok) {
    return null;
  }
  return {
    capability: selection.capability,
    requested: selection.requested,
    selected_label: selection.selected_label,
    selected_testid: selection.selected_testid,
    strategy: selection.strategy,
  };
}

export function normalizeModelRequest(value) {
  const text = String(value ?? 'auto').trim();
  return text ? text.toLowerCase() : 'auto';
}

function canUseCurrentModel({ capability, requestedModel, currentLabel }) {
  if (!currentLabel) {
    return false;
  }
  if (requestedModel === 'auto' && capability === 'image') {
    return !modelTextMatches(currentLabel, 'pro');
  }
  return requestedModel !== 'auto' && modelTextMatches(currentLabel, requestedModel);
}

function modelOptionMatches(option, request) {
  return modelTextMatches(`${option.testid ?? ''} ${option.text ?? ''}`, request);
}

function modelTextMatches(text, request) {
  const haystack = normalizeComparable(text);
  const terms = MODEL_ALIASES[request] ?? [request];
  return terms.some((term) => haystack.includes(normalizeComparable(term)));
}

function normalizeComparable(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function listModelOptions(page, options = {}) {
  const selector = options.capability === 'image'
    ? `${MODEL_OPTION_SELECTOR}, [role="menuitemradio"]`
    : MODEL_OPTION_SELECTOR;
  const raw = await page.locator(selector).evaluateAll((items) => items
    .map((item) => {
      const rect = item.getBoundingClientRect();
      return {
        visible: rect.width > 0 && rect.height > 0,
        role: item.getAttribute('role') || '',
        testid: item.getAttribute('data-testid') || '',
        text: (item.innerText || item.textContent || '').replace(/\s+/g, ' ').trim(),
      };
    })
    .filter((item) => item.visible && item.text)
    .filter((item) => options.capability === 'image' ? item.role === 'menuitemradio' : item.testid));
  return dedupeOptions(raw);
}

async function waitForModelOptions(page, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 2500);
  let latest = [];
  while (Date.now() < deadline) {
    latest = await listModelOptions(page, options).catch(() => []);
    if (latest.length > 0) {
      return latest;
    }
    await sleep(150);
  }
  return latest;
}

async function openModelOptions(page, button, options = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(150).catch(() => {});
    if (attempt === 0) {
      await button.click({ timeout: 5000 }).catch(() => {});
    } else {
      await button.evaluate((element) => element.click()).catch(() => {});
    }
    const optionsList = await waitForModelOptions(page, {
      ...options,
      timeoutMs: attempt === 0 ? 2500 : 4000,
    });
    if (optionsList.length > 0) {
      return optionsList;
    }
  }
  return [];
}

async function clickModelOption(page, choice) {
  if (choice.testid) {
    await page.locator(`[data-testid="${cssString(choice.testid)}"]`).first().click({ timeout: 5000 });
    return;
  }
  await page.getByRole('menuitemradio', {
    name: new RegExp(`^${escapeRegex(choice.text)}$`),
  }).first().click({ timeout: 5000 });
}

async function clickChatModelFallback(page, requestedModel) {
  const target = chatModelFallbackTarget(requestedModel);
  if (!target) {
    return null;
  }
  const option = page.locator(`[data-testid="${cssString(target.testid)}"]`).first();
  if ((await option.count().catch(() => 0)) === 0) {
    return null;
  }
  if (!(await option.isVisible().catch(() => false))) {
    return null;
  }
  await option.click({ timeout: 5000 });
  await page.waitForTimeout(500);
  return target;
}

function chatModelFallbackTarget(requestedModel) {
  if (requestedModel === 'auto' || requestedModel === 'pro') {
    return {
      testid: 'model-switcher-gpt-5-4-pro',
      label: 'Pro 研究级智能模型',
    };
  }
  if (requestedModel === 'thinking') {
    return {
      testid: 'model-switcher-gpt-5-4-thinking',
      label: 'Thinking 适用于解答复杂问题',
    };
  }
  if (requestedModel === 'instant') {
    return {
      testid: 'model-switcher-gpt-5-3',
      label: 'Instant 适用于日常聊天',
    };
  }
  return null;
}

async function clickImageModeFallback(page, requestedModel) {
  const labels = imageFallbackLabels(requestedModel);
  for (const label of labels) {
    const option = page.getByRole('menuitemradio', {
      name: new RegExp(`^${escapeRegex(label)}$`),
    }).first();
    if ((await option.count().catch(() => 0)) === 0) {
      continue;
    }
    if (!(await option.isVisible().catch(() => false))) {
      continue;
    }
    await option.click({ timeout: 5000 });
    await page.waitForTimeout(500);
    return label;
  }
  return null;
}

function imageFallbackLabels(requestedModel) {
  if (requestedModel === 'auto' || requestedModel === 'image' || requestedModel === 'standard') {
    return ['标准', 'Standard'];
  }
  if (requestedModel === 'advanced') {
    return ['进阶', 'Advanced'];
  }
  return [];
}

function dedupeOptions(options) {
  const seen = new Set();
  const deduped = [];
  for (const option of options ?? []) {
    const key = `${option.testid ?? ''}\n${option.text ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({
      role: option.role ?? '',
      testid: option.testid ?? '',
      text: option.text ?? '',
    });
  }
  return deduped;
}

function modelButtonSelectorForCapability(capability) {
  if (capability === 'image') {
    return IMAGE_MODEL_BUTTON_SELECTORS.join(', ');
  }
  return CHAT_MODEL_BUTTON_SELECTORS.join(', ');
}

async function firstVisibleLocator(page, selector) {
  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }
  return null;
}

async function readLocatorLabel(locator) {
  const text = (await locator.innerText({ timeout: 1000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
  if (text) {
    return text;
  }
  return (await locator.getAttribute('aria-label').catch(() => '') ?? '').replace(/\s+/g, ' ').trim();
}

function buildModelResult({ capability, requestedModel, label, testid, changed, strategy }) {
  return {
    ok: true,
    capability,
    requested: requestedModel,
    selected_label: label,
    selected_testid: testid || null,
    changed,
    strategy,
  };
}

function cssString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
