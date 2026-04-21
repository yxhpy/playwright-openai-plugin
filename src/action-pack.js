import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { zipSync } from 'fflate';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import {
  runImageCollect,
  runImageRevise,
  runImageSubmit,
  runImageWait,
} from './images.js';
import { defaultActionPackOutputDir } from './paths.js';

const DEFAULT_ACTIONS = ['idle', 'walk', 'run', 'jump', 'attack', 'cast', 'hurt', 'victory'];
const DEFAULT_GRID = { columns: 3, rows: 3 };
const DEFAULT_FRAME_SIZE = { width: 160, height: 224 };
const DEFAULT_DELAY_MS = 90;
const DEFAULT_BACKGROUND_TOLERANCE = 42;

export async function runActionPackCreate(options = {}) {
  const spec = normalizeActionPackOptions(options);
  const outputDir = resolve(spec.outputDir ?? defaultActionPackOutputDir(spec.name));
  const rawDir = join(outputDir, 'raw');
  await mkdir(rawDir, { recursive: true });

  let sheetPaths;
  let browserJobs = [];
  if (spec.fromDir) {
    sheetPaths = await resolveSheetPaths(spec.fromDir, spec.actions);
  } else {
    const generated = await generateActionSheets(spec, rawDir, options);
    if (!generated.ok || !generated.sheetPaths) {
      return generated;
    }
    sheetPaths = generated.sheetPaths;
    browserJobs = generated.browserJobs;
  }

  const packaged = await packageActionSheets({
    actions: spec.actions,
    sheetPaths,
    outputDir,
    grid: spec.grid,
    framesPerAction: spec.framesPerAction,
    frameSize: spec.frameSize,
    background: spec.background,
    backgroundTolerance: spec.backgroundTolerance,
    delayMs: spec.delayMs,
    browserJobs,
  });

  return {
    ok: true,
    command: 'action-pack create',
    phase: spec.fromDir ? 'package_from_dir' : 'generate_and_package',
    output_dir: outputDir,
    package_dir: packaged.packageDir,
    package_zip: packaged.packageZip,
    manifest: packaged.manifestPath,
    atlas: packaged.atlasPath,
    animation_gif: packaged.animationGifPath,
    source: spec.fromDir ? 'from_dir' : 'browser',
    actions: spec.actions,
    frame_size: spec.frameSize,
    grid: spec.grid,
    frames_per_action: spec.framesPerAction,
    frame_count: packaged.frameCount,
    browser_jobs: browserJobs,
    diagnostics: [],
    next_step: 'Action pack created. The manifest avoids prompt text, character descriptions, cookies, local storage, and source URLs.',
  };
}

export async function packageActionSheets({
  actions,
  sheetPaths,
  outputDir,
  grid = DEFAULT_GRID,
  framesPerAction = grid.columns * grid.rows,
  frameSize = DEFAULT_FRAME_SIZE,
  background = 'auto',
  backgroundTolerance = DEFAULT_BACKGROUND_TOLERANCE,
  delayMs = DEFAULT_DELAY_MS,
  browserJobs = [],
} = {}) {
  const normalizedActions = normalizeActions(actions);
  const normalizedGrid = normalizeGrid(grid);
  const normalizedFrameSize = normalizeFrameSize(frameSize);
  const frameLimit = normalizeFramesPerAction(framesPerAction, normalizedGrid);
  const packageDir = join(resolve(outputDir), 'package');
  const rawPackageDir = join(packageDir, 'raw');
  await mkdir(packageDir, { recursive: true });
  await mkdir(rawPackageDir, { recursive: true });

  const framesByAction = new Map();
  const manifestActions = [];
  for (const action of normalizedActions) {
    const sheetPath = sheetPaths[action];
    if (!sheetPath) {
      throw new Error(`Missing sheet path for action: ${action}`);
    }
    const source = await readPng(sheetPath);
    const rawTarget = join(rawPackageDir, `${action}${extensionFromPath(sheetPath)}`);
    await copyFile(sheetPath, rawTarget);

    const frames = splitSpriteSheet(source, {
      grid: normalizedGrid,
      framesPerAction: frameLimit,
      frameSize: normalizedFrameSize,
      background,
      backgroundTolerance,
    });
    const actionDir = join(packageDir, action);
    await mkdir(actionDir, { recursive: true });
    const frameFiles = [];
    for (let i = 0; i < frames.length; i += 1) {
      const filename = `${action}_${String(i + 1).padStart(2, '0')}.png`;
      const framePath = join(actionDir, filename);
      await writePng(framePath, frames[i]);
      frameFiles.push(`${action}/${filename}`);
    }
    framesByAction.set(action, frames);
    manifestActions.push({
      name: action,
      source_sheet: `raw/${basename(rawTarget)}`,
      frames: frameFiles,
    });
  }

  const atlas = buildAtlas(framesByAction, normalizedActions, frameLimit, normalizedFrameSize);
  const atlasPath = join(packageDir, 'action_pack_atlas.png');
  await writePng(atlasPath, atlas);

  const animationGifPath = join(packageDir, 'action_pack_animation.gif');
  await writeFile(animationGifPath, buildGif(framesByAction, normalizedActions, delayMs));

  const manifest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    actions: manifestActions,
    action_order: normalizedActions,
    frame_size: normalizedFrameSize,
    grid: normalizedGrid,
    frames_per_action: frameLimit,
    frame_count: normalizedActions.length * frameLimit,
    background: {
      mode: background,
      tolerance: background === 'none' ? 0 : backgroundTolerance,
    },
    files: {
      atlas: 'action_pack_atlas.png',
      animation_gif: 'action_pack_animation.gif',
    },
    browser_jobs: browserJobs.map((job) => ({
      action: job.action,
      job_id: job.job_id,
      parent_job_id: job.parent_job_id ?? null,
      model: job.model ?? null,
    })),
  };
  const manifestPath = join(packageDir, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const packageZip = join(resolve(outputDir), 'action_pack.zip');
  await writeZip(packageDir, packageZip);

  return {
    packageDir,
    packageZip,
    manifestPath,
    atlasPath,
    animationGifPath,
    frameCount: manifest.frame_count,
  };
}

export function splitSpriteSheet(source, {
  grid = DEFAULT_GRID,
  framesPerAction = grid.columns * grid.rows,
  frameSize = DEFAULT_FRAME_SIZE,
  background = 'auto',
  backgroundTolerance = DEFAULT_BACKGROUND_TOLERANCE,
} = {}) {
  const normalizedGrid = normalizeGrid(grid);
  const normalizedFrameSize = normalizeFrameSize(frameSize);
  const frameLimit = normalizeFramesPerAction(framesPerAction, normalizedGrid);
  let splitSource = source;
  if (source.width % normalizedGrid.columns !== 0 || source.height % normalizedGrid.rows !== 0) {
    const croppedWidth = source.width - (source.width % normalizedGrid.columns);
    const croppedHeight = source.height - (source.height % normalizedGrid.rows);
    if (croppedWidth <= 0 || croppedHeight <= 0) {
      throw new Error(`Sheet dimensions ${source.width}x${source.height} are too small for grid ${normalizedGrid.columns}x${normalizedGrid.rows}.`);
    }
    splitSource = cropCentered(source, croppedWidth, croppedHeight);
  }
  const cellWidth = splitSource.width / normalizedGrid.columns;
  const cellHeight = splitSource.height / normalizedGrid.rows;
  const frames = [];
  for (let index = 0; index < frameLimit; index += 1) {
    const column = index % normalizedGrid.columns;
    const row = Math.floor(index / normalizedGrid.columns);
    const cell = extractRgba(splitSource, column * cellWidth, row * cellHeight, cellWidth, cellHeight);
    const removed = removeBackground(cell, background, backgroundTolerance);
    const trimmed = trimTransparentBounds(removed);
    frames.push(resizeAndPad(trimmed, normalizedFrameSize.width, normalizedFrameSize.height));
  }
  return frames;
}

function cropCentered(source, width, height) {
  const sourceX = Math.floor((source.width - width) / 2);
  const sourceY = Math.floor((source.height - height) / 2);
  return extractRgba(source, sourceX, sourceY, width, height);
}

function normalizeActionPackOptions(options = {}) {
  const grid = normalizeGrid(parseSizeLike(options.grid, DEFAULT_GRID, 'grid'));
  return {
    actions: normalizeActions(options.actions),
    grid,
    framesPerAction: normalizeFramesPerAction(options.framesPerAction, grid),
    frameSize: normalizeFrameSize(parseSizeLike(options.frameSize, DEFAULT_FRAME_SIZE, 'frame-size')),
    outputDir: options.outputDir,
    fromDir: options.fromDir ? resolve(String(options.fromDir)) : null,
    name: normalizeName(options.name),
    character: String(options.character ?? options.prompt ?? '').trim(),
    model: options.model ?? 'thinking',
    background: normalizeBackground(options.background),
    backgroundTolerance: normalizeTolerance(options.backgroundTolerance),
    delayMs: normalizeDelay(options.delayMs),
    filePath: options.filePath,
    timeoutMs: options.timeoutMs,
  };
}

async function generateActionSheets(spec, rawDir, options) {
  if (!spec.character) {
    return actionPackFailure('generate', [], 'Missing --character for browser-backed action-pack generation. Use --from-dir to package existing sheets.');
  }

  const sheetPaths = {};
  const browserJobs = [];
  let parentJobId = null;
  for (const action of spec.actions) {
    const prompt = buildActionPrompt(spec, action);
    const submitOptions = {
      ...options,
      prompt,
      model: spec.model,
      timeoutMs: spec.timeoutMs,
    };
    const submit = parentJobId
      ? await runImageRevise({ ...submitOptions, jobId: parentJobId })
      : await runImageSubmit({ ...submitOptions, filePath: spec.filePath });
    if (!submit.submitted || !submit.job_id) {
      return actionPackFailure('generate', submit.diagnostics ?? [], `Image ${parentJobId ? 'revision' : 'submission'} failed for action "${action}". ${submit.next_step ?? ''}`.trim());
    }

    const wait = await runImageWait({
      ...options,
      jobId: submit.job_id,
      timeoutMs: spec.timeoutMs ?? 180000,
    });
    const actionRawDir = join(rawDir, action);
    const collect = await runImageCollect({
      ...options,
      jobId: submit.job_id,
      outputDir: actionRawDir,
      maxArtifacts: 1,
    });
    if (!collect.completed || !collect.artifacts?.length) {
      return actionPackFailure('collect', [
        ...(wait.diagnostics ?? []),
        ...(collect.diagnostics ?? []),
      ], `Could not collect a generated sheet for action "${action}". Retry wait/collect for job ${submit.job_id} before resubmitting.`);
    }

    const artifactPath = collect.artifacts[0].path;
    sheetPaths[action] = artifactPath;
    browserJobs.push({
      action,
      job_id: submit.job_id,
      parent_job_id: submit.parent_job_id ?? null,
      model: submit.model ?? null,
    });
    parentJobId = submit.job_id;
  }
  return { ok: true, sheetPaths, browserJobs };
}

function buildActionPrompt(spec, action) {
  return [
    `Create one clean ${spec.grid.columns}x${spec.grid.rows} sprite sheet for the action "${action}".`,
    `Use exactly ${spec.framesPerAction} sequential animation frames in reading order.`,
    `Keep the same character across all frames: ${spec.character}.`,
    'Use a plain removable background, centered full-body pose, consistent scale, no labels, no captions, no UI, and no extra panels.',
    'Return one image sheet only.',
  ].join(' ');
}

async function resolveSheetPaths(fromDir, actions) {
  const sheetPaths = {};
  for (const action of actions) {
    const candidates = [
      join(fromDir, `${action}.png`),
      join(fromDir, `${action}_sheet.png`),
      join(fromDir, action, 'image-1.png'),
      join(fromDir, action, `${action}.png`),
      join(fromDir, action, `${action}_sheet.png`),
    ];
    const found = await firstFile(candidates);
    if (!found) {
      throw new Error(`Missing source sheet for action "${action}" under ${fromDir}.`);
    }
    sheetPaths[action] = found;
  }
  return sheetPaths;
}

async function firstFile(candidates) {
  for (const candidate of candidates) {
    try {
      const entry = await stat(candidate);
      if (entry.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function readPng(filePath) {
  return readFile(filePath).then((buffer) => PNG.sync.read(buffer));
}

async function writePng(filePath, png) {
  await writeFile(filePath, PNG.sync.write(png));
}

function extractRgba(source, sourceX, sourceY, width, height) {
  const target = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = ((sourceY + y) * source.width + (sourceX + x)) * 4;
      const targetOffset = (y * width + x) * 4;
      target.data[targetOffset] = source.data[sourceOffset];
      target.data[targetOffset + 1] = source.data[sourceOffset + 1];
      target.data[targetOffset + 2] = source.data[sourceOffset + 2];
      target.data[targetOffset + 3] = source.data[sourceOffset + 3];
    }
  }
  return target;
}

function removeBackground(image, background, tolerance) {
  if (background === 'none') {
    return clonePng(image);
  }
  const colors = background.startsWith('#')
    ? [parseHexColor(background)]
    : detectEdgeBackgroundColors(image);
  if (colors.length === 0) {
    return clonePng(image);
  }

  const output = clonePng(image);
  const feather = Math.max(8, Math.floor(tolerance / 2));
  for (let offset = 0; offset < output.data.length; offset += 4) {
    const alpha = output.data[offset + 3];
    if (alpha === 0) {
      continue;
    }
    const distance = colors.reduce((min, color) => Math.min(min, colorDistance(output.data, offset, color)), Infinity);
    if (distance <= tolerance) {
      output.data[offset + 3] = 0;
    } else if (distance <= tolerance + feather) {
      const ratio = (distance - tolerance) / feather;
      output.data[offset + 3] = Math.round(alpha * ratio);
    }
  }
  return output;
}

function detectEdgeBackgroundColors(image) {
  const buckets = new Map();
  const add = (x, y) => {
    const offset = (y * image.width + x) * 4;
    if (image.data[offset + 3] < 16) {
      return;
    }
    const key = [
      Math.round(image.data[offset] / 8),
      Math.round(image.data[offset + 1] / 8),
      Math.round(image.data[offset + 2] / 8),
    ].join(',');
    const item = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    item.count += 1;
    item.r += image.data[offset];
    item.g += image.data[offset + 1];
    item.b += image.data[offset + 2];
    buckets.set(key, item);
  };

  for (let x = 0; x < image.width; x += 1) {
    add(x, 0);
    add(x, image.height - 1);
  }
  for (let y = 1; y < image.height - 1; y += 1) {
    add(0, y);
    add(image.width - 1, y);
  }

  const edgeCount = Math.max(1, image.width * 2 + image.height * 2 - 4);
  return [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .filter((item) => item.count / edgeCount >= 0.05)
    .slice(0, 2)
    .map((item) => ({
      r: Math.round(item.r / item.count),
      g: Math.round(item.g / item.count),
      b: Math.round(item.b / item.count),
    }));
}

function trimTransparentBounds(image) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.data[(y * image.width + x) * 4 + 3];
      if (alpha <= 12) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) {
    return clonePng(image);
  }
  return extractRgba(image, minX, minY, maxX - minX + 1, maxY - minY + 1);
}

function resizeAndPad(image, targetWidth, targetHeight) {
  const scale = Math.min(targetWidth / image.width, targetHeight / image.height);
  const resizedWidth = Math.max(1, Math.round(image.width * scale));
  const resizedHeight = Math.max(1, Math.round(image.height * scale));
  const resized = resizeRgba(image, resizedWidth, resizedHeight);
  const output = new PNG({ width: targetWidth, height: targetHeight });
  const startX = Math.floor((targetWidth - resizedWidth) / 2);
  const startY = Math.floor((targetHeight - resizedHeight) / 2);
  pastePng(output, resized, startX, startY);
  return output;
}

function resizeRgba(source, width, height) {
  const target = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    const sourceY = (y + 0.5) * source.height / height - 0.5;
    const y0 = clamp(Math.floor(sourceY), 0, source.height - 1);
    const y1 = clamp(y0 + 1, 0, source.height - 1);
    const yWeight = sourceY - Math.floor(sourceY);
    for (let x = 0; x < width; x += 1) {
      const sourceX = (x + 0.5) * source.width / width - 0.5;
      const x0 = clamp(Math.floor(sourceX), 0, source.width - 1);
      const x1 = clamp(x0 + 1, 0, source.width - 1);
      const xWeight = sourceX - Math.floor(sourceX);
      const pixel = samplePremultiplied(source, x0, y0, x1, y1, xWeight, yWeight);
      const offset = (y * width + x) * 4;
      target.data[offset] = pixel.r;
      target.data[offset + 1] = pixel.g;
      target.data[offset + 2] = pixel.b;
      target.data[offset + 3] = pixel.a;
    }
  }
  return target;
}

function samplePremultiplied(source, x0, y0, x1, y1, xWeight, yWeight) {
  const p00 = readPremultiplied(source, x0, y0);
  const p10 = readPremultiplied(source, x1, y0);
  const p01 = readPremultiplied(source, x0, y1);
  const p11 = readPremultiplied(source, x1, y1);
  const top = lerpPixel(p00, p10, xWeight);
  const bottom = lerpPixel(p01, p11, xWeight);
  const value = lerpPixel(top, bottom, yWeight);
  if (value.a <= 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  return {
    r: clamp(Math.round(value.r / value.a * 255), 0, 255),
    g: clamp(Math.round(value.g / value.a * 255), 0, 255),
    b: clamp(Math.round(value.b / value.a * 255), 0, 255),
    a: clamp(Math.round(value.a), 0, 255),
  };
}

function readPremultiplied(source, x, y) {
  const offset = (y * source.width + x) * 4;
  const alpha = source.data[offset + 3] / 255;
  return {
    r: source.data[offset] * alpha,
    g: source.data[offset + 1] * alpha,
    b: source.data[offset + 2] * alpha,
    a: source.data[offset + 3],
  };
}

function lerpPixel(a, b, weight) {
  return {
    r: a.r + (b.r - a.r) * weight,
    g: a.g + (b.g - a.g) * weight,
    b: a.b + (b.b - a.b) * weight,
    a: a.a + (b.a - a.a) * weight,
  };
}

function buildAtlas(framesByAction, actions, framesPerAction, frameSize) {
  const atlas = new PNG({
    width: framesPerAction * frameSize.width,
    height: actions.length * frameSize.height,
  });
  actions.forEach((action, actionIndex) => {
    const frames = framesByAction.get(action) ?? [];
    for (let frameIndex = 0; frameIndex < framesPerAction; frameIndex += 1) {
      pastePng(atlas, frames[frameIndex], frameIndex * frameSize.width, actionIndex * frameSize.height);
    }
  });
  return atlas;
}

function buildGif(framesByAction, actions, delayMs) {
  const { GIFEncoder, quantize, applyPalette } = gifenc;
  const gif = GIFEncoder();
  for (const action of actions) {
    for (const frame of framesByAction.get(action) ?? []) {
      const flattened = flattenForGif(frame);
      const palette = quantize(flattened, 256, { format: 'rgba4444' });
      const indexed = applyPalette(flattened, palette, 'rgba4444');
      gif.writeFrame(indexed, frame.width, frame.height, { palette, delay: delayMs });
    }
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

function flattenForGif(frame) {
  const output = new Uint8Array(frame.data.length);
  for (let offset = 0; offset < frame.data.length; offset += 4) {
    const alpha = frame.data[offset + 3] / 255;
    output[offset] = Math.round(frame.data[offset] * alpha + 255 * (1 - alpha));
    output[offset + 1] = Math.round(frame.data[offset + 1] * alpha + 255 * (1 - alpha));
    output[offset + 2] = Math.round(frame.data[offset + 2] * alpha + 255 * (1 - alpha));
    output[offset + 3] = 255;
  }
  return output;
}

function pastePng(target, source, startX, startY) {
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const targetX = startX + x;
      const targetY = startY + y;
      if (targetX < 0 || targetY < 0 || targetX >= target.width || targetY >= target.height) {
        continue;
      }
      const sourceOffset = (y * source.width + x) * 4;
      const targetOffset = (targetY * target.width + targetX) * 4;
      target.data[targetOffset] = source.data[sourceOffset];
      target.data[targetOffset + 1] = source.data[sourceOffset + 1];
      target.data[targetOffset + 2] = source.data[sourceOffset + 2];
      target.data[targetOffset + 3] = source.data[sourceOffset + 3];
    }
  }
}

async function writeZip(sourceDir, zipPath) {
  const files = await collectFiles(sourceDir);
  const entries = {};
  for (const filePath of files) {
    const key = relative(sourceDir, filePath).split(sep).join('/');
    entries[key] = new Uint8Array(await readFile(filePath));
  }
  await writeFile(zipPath, Buffer.from(zipSync(entries, { level: 6 })));
}

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}

function clonePng(image) {
  const cloned = new PNG({ width: image.width, height: image.height });
  image.data.copy(cloned.data);
  return cloned;
}

function normalizeActions(value) {
  const actions = (Array.isArray(value) ? value : String(value ?? DEFAULT_ACTIONS.join(',')).split(','))
    .map((action) => sanitizeActionName(action))
    .filter(Boolean);
  if (actions.length === 0) {
    throw new Error('At least one action is required.');
  }
  return [...new Set(actions)];
}

function sanitizeActionName(value) {
  const action = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!action) {
    return '';
  }
  if (!/^[a-z0-9_-]+$/.test(action)) {
    throw new Error(`Invalid action name: ${value}`);
  }
  return action;
}

function normalizeGrid(value) {
  const grid = value ?? DEFAULT_GRID;
  const columns = Number(grid.columns);
  const rows = Number(grid.rows);
  if (!Number.isInteger(columns) || columns <= 0 || !Number.isInteger(rows) || rows <= 0) {
    throw new Error('Invalid --grid value. Use CxR, for example 3x3.');
  }
  return { columns, rows };
}

function normalizeFrameSize(value) {
  const frameSize = value ?? DEFAULT_FRAME_SIZE;
  const width = Number(frameSize.width);
  const height = Number(frameSize.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('Invalid --frame-size value. Use WIDTHxHEIGHT, for example 160x224.');
  }
  return { width, height };
}

function normalizeFramesPerAction(value, grid) {
  const frameCount = value === undefined || value === null ? grid.columns * grid.rows : Number(value);
  if (!Number.isInteger(frameCount) || frameCount <= 0 || frameCount > grid.columns * grid.rows) {
    throw new Error(`Invalid --frames-per-action value. It must be between 1 and ${grid.columns * grid.rows}.`);
  }
  return frameCount;
}

function parseSizeLike(value, fallback, label) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'object') {
    return value;
  }
  const match = String(value).trim().match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new Error(`Invalid --${label} value. Use WIDTHxHEIGHT.`);
  }
  return { width: Number(match[1]), height: Number(match[2]), columns: Number(match[1]), rows: Number(match[2]) };
}

function normalizeBackground(value) {
  const background = String(value ?? 'auto').trim().toLowerCase();
  if (background === 'auto' || background === 'none' || /^#[0-9a-f]{6}$/i.test(background)) {
    return background;
  }
  throw new Error('Invalid --background value. Use auto, none, or #rrggbb.');
}

function normalizeTolerance(value) {
  if (value === undefined || value === null) {
    return DEFAULT_BACKGROUND_TOLERANCE;
  }
  const tolerance = Number(value);
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 255) {
    throw new Error('Invalid --tolerance value. Use a number from 0 to 255.');
  }
  return tolerance;
}

function normalizeDelay(value) {
  if (value === undefined || value === null) {
    return DEFAULT_DELAY_MS;
  }
  const delay = Number(value);
  if (!Number.isInteger(delay) || delay <= 0) {
    throw new Error('Invalid --delay-ms value.');
  }
  return delay;
}

function normalizeName(value) {
  const raw = String(value ?? `action-pack-${new Date().toISOString().replace(/[:.]/g, '-')}`).trim();
  const name = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return name || hashName(raw);
}

function parseHexColor(value) {
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

function colorDistance(data, offset, color) {
  const dr = data[offset] - color.r;
  const dg = data[offset + 1] - color.g;
  const db = data[offset + 2] - color.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function extensionFromPath(path) {
  const match = String(path).match(/\.[a-z0-9]+$/i);
  return match ? match[0].toLowerCase() : '.png';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hashName(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function actionPackFailure(phase, diagnostics, nextStep) {
  return {
    ok: true,
    command: 'action-pack create',
    phase,
    submitted: false,
    completed: false,
    diagnostics,
    next_step: nextStep,
  };
}
