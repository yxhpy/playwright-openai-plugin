import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDiscoveryCapabilities,
  classifyDiscoverySessionState,
} from '../src/discover.js';

test('classifyDiscoverySessionState treats auth pages as auth flow', () => {
  assert.equal(
    classifyDiscoverySessionState('openai_auth', presentSignals('composer_editable')),
    'auth_flow',
  );
});

test('classifyDiscoverySessionState keeps login controls higher priority than composer', () => {
  assert.equal(
    classifyDiscoverySessionState('chatgpt', presentSignals('composer_editable', 'login_link_or_button')),
    'login_required_public_composer',
  );
  assert.equal(
    classifyDiscoverySessionState('chatgpt', presentSignals('composer_editable', 'signup_link_or_button')),
    'login_required_public_composer',
  );
});

test('classifyDiscoverySessionState detects ordinary login-required pages', () => {
  assert.equal(
    classifyDiscoverySessionState('chatgpt', presentSignals('auth_form_input')),
    'login_required',
  );
  assert.equal(
    classifyDiscoverySessionState('chatgpt', presentSignals('login_link_or_button')),
    'login_required',
  );
});

test('classifyDiscoverySessionState detects app-ready and unknown pages', () => {
  assert.equal(
    classifyDiscoverySessionState('chatgpt', presentSignals('composer_editable')),
    'app_ready',
  );
  assert.equal(
    classifyDiscoverySessionState('chatgpt', presentSignals('new_chat_control')),
    'app_ready',
  );
  assert.equal(
    classifyDiscoverySessionState('chatgpt', presentSignals()),
    'openai_page_present_unknown',
  );
});

test('buildDiscoveryCapabilities exposes chat and file candidates only when app-ready', () => {
  const signals = presentSignals('composer_editable', 'file_input');

  assert.deepEqual(
    buildDiscoveryCapabilities('chatgpt', 'app_ready', signals),
    [
      {
        name: 'chat_submit_candidate',
        status: 'available',
        evidence: 'composer_editable',
      },
      {
        name: 'file_upload_candidate',
        status: 'available',
        evidence: 'file_input',
      },
    ],
  );

  assert.deepEqual(
    buildDiscoveryCapabilities('chatgpt', 'login_required_public_composer', signals),
    [],
  );
});

test('buildDiscoveryCapabilities exposes app-ready advanced ChatGPT controls', () => {
  assert.deepEqual(
    buildDiscoveryCapabilities(
      'chatgpt',
      'app_ready',
      presentSignals(
        'model_selector',
        'web_search_control',
        'deep_research_control',
        'image_creation_control',
        'temporary_chat_control',
      ),
    ),
    [
      {
        name: 'model_selection_candidate',
        status: 'available',
        evidence: 'model_selector',
      },
      {
        name: 'web_search_candidate',
        status: 'available',
        evidence: 'web_search_control',
      },
      {
        name: 'deep_research_candidate',
        status: 'available',
        evidence: 'deep_research_control',
      },
      {
        name: 'image_creation_candidate',
        status: 'available',
        evidence: 'image_creation_control',
      },
      {
        name: 'temporary_chat_candidate',
        status: 'available',
        evidence: 'temporary_chat_control',
      },
    ],
  );

  assert.deepEqual(
    buildDiscoveryCapabilities(
      'chatgpt',
      'login_required',
      presentSignals('model_selector', 'web_search_control', 'deep_research_control'),
    ),
    [],
  );
});

test('buildDiscoveryCapabilities reports images surface candidates from safe image signals', () => {
  assert.deepEqual(
    buildDiscoveryCapabilities('chatgpt_images', 'app_ready', presentSignals('new_chat_control')),
    [
      {
        name: 'images_surface_candidate',
        status: 'available',
        evidence: 'current_url',
      },
    ],
  );

  assert.deepEqual(
    buildDiscoveryCapabilities('chatgpt', 'app_ready', presentSignals('chatgpt_images_url')),
    [
      {
        name: 'images_surface_candidate',
        status: 'available',
        evidence: 'images_link',
      },
    ],
  );

  assert.deepEqual(
    buildDiscoveryCapabilities('chatgpt_images', 'app_ready', presentSignals('image_edit_control', 'image_share_control')),
    [
      {
        name: 'images_surface_candidate',
        status: 'available',
        evidence: 'current_url',
      },
      {
        name: 'image_edit_candidate',
        status: 'available',
        evidence: 'image_edit_control',
      },
      {
        name: 'image_share_candidate',
        status: 'available',
        evidence: 'image_share_control',
      },
    ],
  );
});

function presentSignals(...names) {
  return names.map((name) => ({ name, present: true }));
}
