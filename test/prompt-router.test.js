import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const router = resolve(root, 'skills/gpt-image-prompt-router/scripts/prompt_router.py');
const hasPython = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

function runRouter(args) {
  const result = spawnSync('python3', [router, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('prompt router lists bundled categories', { skip: !hasPython }, () => {
  const output = runRouter(['categories', '--language', 'zh', '--format', 'json']);
  const ecommerce = output.categories.find((category) => category.slug === 'ecommerce-main-image');
  assert.equal(output.source.license, 'CC BY 4.0');
  assert.equal(ecommerce.prompt_count, 20);
});

test('prompt router searches Chinese ecommerce requests', { skip: !hasPython }, () => {
  const output = runRouter(['search', '电商主图 直播间 科技产品', '--language', 'zh', '--limit', '3']);
  assert.equal(output.results[0].category.slug, 'ecommerce-main-image');
  assert.ok(output.results[0].score > 0);
});

test('prompt router shows full prompt with attribution', { skip: !hasPython }, () => {
  const output = runRouter(['show', '13460', '--language', 'zh', '--format', 'json']);
  assert.equal(output.id, '13460');
  assert.equal(output.source_catalog.commit, 'afc137615a888b6bfbba0ee1c97e4995a7e8a4bc');
  assert.match(output.prompt, /VR 头显/);
});
