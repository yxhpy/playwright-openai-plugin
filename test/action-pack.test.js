import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import { failedActionsFromQaReport, packageActionSheets, runActionPackCreate, splitSpriteSheet } from '../src/action-pack.js';

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

test('packageActionSheets removes dark background-hue foot shadow residue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'poai-action-pack-shadow-'));
  const sheetPath = join(dir, 'idle.png');
  await writeShadowSheet(sheetPath);

  const result = await packageActionSheets({
    actions: ['idle'],
    sheetPaths: { idle: sheetPath },
    outputDir: dir,
    grid: { columns: 3, rows: 3 },
    framesPerAction: 9,
    frameSize: { width: 64, height: 80 },
    background: 'auto',
    backgroundTolerance: 32,
  });

  const frame = PNG.sync.read(await readFile(join(result.packageDir, 'idle', 'idle_01.png')));
  assert.equal(countGreenShadowPixels(frame), 0);
  assert.ok(countOpaquePixels(frame) > 0);
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
  assert.equal(result.ok, false);
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

test('splitSpriteSheet recovers foreground poses that spill across source cell boundaries', () => {
  const sheet = new PNG({ width: 40, height: 20 });
  fillPng(sheet, { r: 0, g: 255, b: 0, a: 255 });
  paintRect(sheet, { x: 12, y: 6, width: 12, height: 8, r: 230, g: 40, b: 60, a: 255 });
  paintRect(sheet, { x: 26, y: 6, width: 8, height: 8, r: 70, g: 70, b: 230, a: 255 });

  const frames = splitSpriteSheet(sheet, {
    grid: { columns: 2, rows: 1 },
    framesPerAction: 2,
    frameSize: { width: 40, height: 40 },
    background: 'auto',
    backgroundTolerance: 32,
  });

  assert.equal(frames.length, 2);
  assert.ok(opaqueBounds(frames[0]).width >= 34);
});

test('splitSpriteSheet keeps extracted poses on a shared bottom anchor', () => {
  const sheet = new PNG({ width: 40, height: 20 });
  fillPng(sheet, { r: 0, g: 255, b: 0, a: 255 });
  paintRect(sheet, { x: 5, y: 3, width: 8, height: 12, r: 230, g: 40, b: 60, a: 255 });
  paintRect(sheet, { x: 25, y: 8, width: 8, height: 7, r: 70, g: 70, b: 230, a: 255 });

  const frames = splitSpriteSheet(sheet, {
    grid: { columns: 2, rows: 1 },
    framesPerAction: 2,
    frameSize: { width: 40, height: 40 },
    background: 'auto',
    backgroundTolerance: 32,
  });

  assert.equal(opaqueBounds(frames[0]).bottom, 39);
  assert.equal(opaqueBounds(frames[1]).bottom, 39);
});

test('packageActionSheets writes a contact sheet and can curate frame order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'poai-action-pack-contact-'));
  const sheetPath = join(dir, 'idle.png');
  await writeSyntheticSheet(sheetPath, { width: 24, height: 24 });

  const result = await packageActionSheets({
    actions: ['idle'],
    sheetPaths: { idle: sheetPath },
    outputDir: dir,
    grid: { columns: 2, rows: 2 },
    framesPerAction: 4,
    frameOrder: [1, 3, 2],
    frameSize: { width: 32, height: 32 },
    background: 'auto',
    backgroundTolerance: 32,
  });

  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(result.frameCount, 3);
  assert.equal(manifest.frame_count, 3);
  assert.equal(manifest.frames_per_action, 3);
  assert.deepEqual(manifest.frame_order, [1, 3, 2]);
  assert.equal(manifest.files.contact_sheet, 'contact_sheet.png');
  assert.ok((await readFile(join(result.packageDir, 'contact_sheet.png'))).length > 0);
  assert.deepEqual(await readdir(join(result.packageDir, 'idle')), [
    'idle_01.png',
    'idle_02.png',
    'idle_03.png',
  ]);
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
  assert.deepEqual(result.remaining_failed_actions, ['idle']);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.category === 'qa_blank_frame'));
});

test('failedActionsFromQaReport returns unique error actions only', () => {
  assert.deepEqual(failedActionsFromQaReport({
    issues: [
      { severity: 'warning', action: 'idle' },
      { severity: 'error', action: 'walk' },
      { severity: 'error', action: 'walk' },
      { severity: 'error', action: 'run' },
      { severity: 'error', action: '' },
    ],
  }), ['walk', 'run']);
});

test('regen-failed does not regenerate local from-dir sheets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'poai-action-pack-local-regen-'));
  const sourceDir = join(dir, 'source');
  const outputDir = join(dir, 'out');
  await writeBlankSheet(join(sourceDir, 'idle.png'));

  const result = await runActionPackCreate({
    fromDir: sourceDir,
    outputDir,
    actions: 'idle',
    frameSize: '16x20',
    grid: '3x3',
    regenFailed: true,
    regenAttempts: 2,
  });

  assert.equal(result.phase, 'quality_failed');
  assert.equal(result.completed, false);
  assert.equal(result.regen_failed, true);
  assert.equal(result.regen_attempts_used, 0);
  assert.deepEqual(result.regenerated_actions, []);
  assert.match(result.next_step, /local sheets/);
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

async function writeShadowSheet(path) {
  const sheet = new PNG({ width: 36, height: 36 });
  for (let y = 0; y < sheet.height; y += 1) {
    for (let x = 0; x < sheet.width; x += 1) {
      const offset = (y * sheet.width + x) * 4;
      sheet.data[offset] = 30;
      sheet.data[offset + 1] = 230;
      sheet.data[offset + 2] = 24;
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
    for (let y = baseY + 9; y < baseY + 11; y += 1) {
      for (let x = baseX + 2; x < baseX + 10; x += 1) {
        const offset = (y * sheet.width + x) * 4;
        sheet.data[offset] = 8;
        sheet.data[offset + 1] = 75;
        sheet.data[offset + 2] = 6;
        sheet.data[offset + 3] = 255;
      }
    }
    for (let y = baseY + 3; y < baseY + 9; y += 1) {
      for (let x = baseX + 4; x < baseX + 8; x += 1) {
        const offset = (y * sheet.width + x) * 4;
        sheet.data[offset] = 230;
        sheet.data[offset + 1] = 230;
        sheet.data[offset + 2] = 220;
        sheet.data[offset + 3] = 255;
      }
    }
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, PNG.sync.write(sheet));
}

function fillPng(png, color) {
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      png.data[offset] = color.r;
      png.data[offset + 1] = color.g;
      png.data[offset + 2] = color.b;
      png.data[offset + 3] = color.a;
    }
  }
}

function paintRect(png, rect) {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      png.data[offset] = rect.r;
      png.data[offset + 1] = rect.g;
      png.data[offset + 2] = rect.b;
      png.data[offset + 3] = rect.a;
    }
  }
}

function opaqueBounds(frame) {
  let minX = frame.width;
  let minY = frame.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const alpha = frame.data[(y * frame.width + x) * 4 + 3];
      if (alpha <= 16) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    x: minX,
    y: minY,
    right: maxX,
    bottom: maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function countGreenShadowPixels(frame) {
  let count = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const offset = (y * frame.width + x) * 4;
      const red = frame.data[offset];
      const green = frame.data[offset + 1];
      const blue = frame.data[offset + 2];
      const alpha = frame.data[offset + 3];
      if (alpha > 16 && green > red + 24 && green > blue + 24) {
        count += 1;
      }
    }
  }
  return count;
}

function countOpaquePixels(frame) {
  let count = 0;
  for (let offset = 3; offset < frame.data.length; offset += 4) {
    if (frame.data[offset] > 16) {
      count += 1;
    }
  }
  return count;
}
