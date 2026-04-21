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
});

function presentSignals(...names) {
  return names.map((name) => ({ name, present: true }));
}
