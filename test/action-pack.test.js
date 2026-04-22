import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import { packageActionSheets, runActionPackCreate } from '../src/action-pack.js';

test('packageActionSheets splits frames, removes simple background, and writes package files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'poai-action-pack-'));
  const sheetPath = join(dir, 'idle.png');
  await writeSyntheticSheet(sheetPath);

  const result = await packageActionSheets({
    actions: ['idle'],
    sheetPaths: { idle: sheetPath },
    outputDir: dir,
    grid: { columns: 3, rows: 3 },
    framesPerAction: 9,
    frameSize: { width: 64, height: 80 },
    background: 'auto',
    backgroundTolerance: 32,
    delayMs: 80,
  });

  assert.equal(result.frameCount, 9);
  assert.ok(result.packageZip.endsWith('action_pack.zip'));
  assert.ok((await readFile(result.packageZip)).length > 0);
  assert.ok((await readFile(result.animationGifPath)).length > 0);
  assert.ok((await readFile(result.qaReportPath)).length > 0);
  assert.equal(result.qaReport.status, 'pass');

  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(manifest.frame_count, 9);
  assert.deepEqual(manifest.frame_size, { width: 64, height: 80 });
  assert.equal(manifest.browser_jobs.length, 0);
  assert.equal(manifest.qa.status, 'pass');
  assert.equal(manifest.files.qa_report, 'qa_report.json');

  const frame = PNG.sync.read(await readFile(join(result.packageDir, 'idle', 'idle_01.png')));
  assert.equal(frame.width, 64);
  assert.equal(frame.height, 80);
  assert.ok(frame.data.some((value, index) => index % 4 === 3 && value === 0));
  assert.ok(frame.data.some((value, index) => index % 4 === 3 && value > 0));
});

test('runActionPackCreate packages existing sheets from a directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'poai-action-pack-create-'));
  const sourceDir = join(dir, 'source');
  const outputDir = join(dir, 'out');
  await writeSyntheticSheet(join(sourceDir, 'idle.png'));

  const result = await runActionPackCreate({
    fromDir: sourceDir,
    outputDir,
    actions: 'idle',
    frameSize: '64x80',
    grid: '3x3',
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'from_dir');
  assert.equal(result.completed, true);
  assert.equal(result.qa_status, 'pass');
  assert.equal(result.frame_count, 9);
  assert.equal(result.actions[0], 'idle');
  assert.ok((await readdir(join(outputDir, 'package', 'idle'))).includes('idle_01.png'));
});

test('runActionPackCreate returns diagnostics when generation input is incomplete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'poai-action-pack-missing-character-'));
  const result = await runActionPackCreate({
    outputDir: dir,
    actions: 'idle',
  });

  assert.equal(result.command, 'action-pack create');
  assert.equal(result.phase, 'generate');
  assert.equal(result.submitted, false);
  assert.match(result.next_step, /Missing --character/);
});

test('packageActionSheets center-crops sheets that are not exactly divisible by grid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'poai-action-pack-crop-'));
  const sheetPath = join(dir, 'idle.png');
  await writeSyntheticSheet(sheetPath, { width: 37, height: 37 });

  const result = await packageActionSheets({
    actions: ['idle'],
    sheetPaths: { idle: sheetPath },
    outputDir: dir,
    grid: { columns: 3, rows: 3 },
    framesPerAction: 9,
    frameSize: { width: 16, height: 20 },
  });

  const frame = PNG.sync.read(await readFile(join(result.packageDir, 'idle', 'idle_09.png')));
  assert.equal(frame.width, 16);
  assert.equal(frame.height, 20);
  assert.equal(result.frameCount, 9);
});

test('runActionPackCreate blocks blank sheets in strict QA mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'poai-action-pack-qa-fail-'));
  const sourceDir = join(dir, 'source');
  const outputDir = join(dir, 'out');
  await writeBlankSheet(join(sourceDir, 'idle.png'));

  const result = await runActionPackCreate({
    fromDir: sourceDir,
    outputDir,
    actions: 'idle',
    frameSize: '16x20',
    grid: '3x3',
  });

  assert.equal(result.phase, 'quality_failed');
  assert.equal(result.completed, false);
  assert.equal(result.qa_status, 'fail');
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.category === 'qa_blank_frame'));
});

test('runActionPackCreate can keep a suspect package in warn QA mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'poai-action-pack-qa-warn-'));
  const sourceDir = join(dir, 'source');
  const outputDir = join(dir, 'out');
  await writeBlankSheet(join(sourceDir, 'idle.png'));

  const result = await runActionPackCreate({
    fromDir: sourceDir,
    outputDir,
    actions: 'idle',
    frameSize: '16x20',
    grid: '3x3',
    qaMode: 'warn',
  });

  assert.equal(result.completed, true);
  assert.equal(result.qa_status, 'fail');
  const report = JSON.parse(await readFile(result.qa_report, 'utf8'));
  assert.equal(report.status, 'fail');
});

async function writeSyntheticSheet(path, size = { width: 36, height: 36 }) {
  const sheet = new PNG({ width: size.width, height: size.height });
  for (let y = 0; y < sheet.height; y += 1) {
    for (let x = 0; x < sheet.width; x += 1) {
      const offset = (y * sheet.width + x) * 4;
      sheet.data[offset] = 0;
      sheet.data[offset + 1] = 255;
      sheet.data[offset + 2] = 0;
      sheet.data[offset + 3] = 255;
    }
  }

  for (let frame = 0; frame < 9; frame += 1) {
    const column = frame % 3;
    const row = Math.floor(frame / 3);
    const cellWidth = Math.floor(sheet.width / 3);
    const cellHeight = Math.floor(sheet.height / 3);
    const baseX = column * cellWidth;
    const baseY = row * cellHeight;
    for (let y = baseY + 3; y < baseY + 10; y += 1) {
      for (let x = baseX + 3; x < baseX + 9; x += 1) {
        const offset = (y * sheet.width + x) * 4;
        sheet.data[offset] = 220;
        sheet.data[offset + 1] = 40 + frame;
        sheet.data[offset + 2] = 80;
        sheet.data[offset + 3] = 255;
      }
    }
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, PNG.sync.write(sheet));
}

async function writeBlankSheet(path) {
  const sheet = new PNG({ width: 36, height: 36 });
  for (let y = 0; y < sheet.height; y += 1) {
    for (let x = 0; x < sheet.width; x += 1) {
      const offset = (y * sheet.width + x) * 4;
      sheet.data[offset] = 0;
      sheet.data[offset + 1] = 255;
      sheet.data[offset + 2] = 0;
      sheet.data[offset + 3] = 255;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, PNG.sync.write(sheet));
}
