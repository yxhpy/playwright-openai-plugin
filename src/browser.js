import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { inspectCandidateEndpoints } from './cdp.js';
import { defaultChromePath, defaultProfileDir, defaultStatePath } from './paths.js';

const DEFAULT_PORT = 9333;
const DEFAULT_URL = 'https://chatgpt.com/';

export async function runBrowserLaunch(options = {}) {
  const port = readPort(options.port ?? DEFAULT_PORT);
  const endpoint = `http://127.0.0.1:${port}`;
  const profileDir = resolve(options.profileDir ?? defaultProfileDir());
  const statePath = resolve(options.statePath ?? defaultStatePath());
  const chromePath = options.chromePath ?? defaultChromePath();
  const url = options.url ?? DEFAULT_URL;
  const timeoutMs = options.timeoutMs ?? 5000;

  const existing = await loadState(statePath);
  if (existing?.endpoint) {
    const existingProbe = await inspectEndpoint(existing.endpoint, timeoutMs);
    if (existingProbe.connected) {
      return {
        ok: true,
        command: 'browser launch',
        launched: false,
        already_running: true,
        endpoint: existing.endpoint,
        port: existing.port,
        pid: existing.pid ?? null,
        profile_dir: existing.profile_dir ?? null,
        state_path: statePath,
        diagnostics: [],
        next_step: `Run \`poai status --endpoint ${existing.endpoint} --json\`.`,
      };
    }
  }

  await mkdir(profileDir, { recursive: true });
  await mkdir(dirname(statePath), { recursive: true });

  const args = buildChromeArgs({
    port,
    profileDir,
    url,
    headless: Boolean(options.headless),
  });

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const state = {
    managed_by: 'playwright-openai',
    pid: child.pid,
    endpoint,
    port,
    profile_dir: profileDir,
    chrome_path: chromePath,
    headless: Boolean(options.headless),
    launched_at: new Date().toISOString(),
  };
  await writeState(statePath, state);

  const probe = await waitForEndpoint(endpoint, timeoutMs);
  const diagnostics = [];
  if (!probe.connected) {
    diagnostics.push({
      category: probe.category,
      message: probe.message ?? 'Launched Chrome but CDP endpoint did not become reachable.',
      next_step: probe.next_step ?? 'Inspect the managed Chrome process and retry.',
    });
  }

  return {
    ok: true,
    command: 'browser launch',
    launched: true,
    ready: probe.connected,
    endpoint,
    port,
    pid: child.pid,
    profile_dir: profileDir,
    state_path: statePath,
    headless: Boolean(options.headless),
    open_url: url,
    diagnostics,
    next_step: probe.connected
      ? `Run \`poai status --endpoint ${endpoint} --json\`. If this is a new profile, log into ChatGPT in the launched browser first.`
      : 'Chrome started, but the CDP endpoint is not ready. Retry status or stop and relaunch.',
  };
}

export async function runBrowserStop(options = {}) {
  const statePath = resolve(options.statePath ?? defaultStatePath());
  const state = await loadState(statePath);
  if (!state) {
    return {
      ok: true,
      command: 'browser stop',
      stopped: false,
      diagnostics: [
        {
          category: 'browser_not_found',
          message: 'No managed browser state file was found.',
          next_step: 'Run `poai browser launch` before stopping a managed browser.',
        },
      ],
      next_step: 'No managed browser was stopped.',
    };
  }

  const diagnostics = [];
  let stopped = false;
  if (state.pid && isProcessAlive(state.pid)) {
    try {
      process.kill(state.pid, 'SIGTERM');
      stopped = true;
    } catch (error) {
      diagnostics.push({
        category: 'browser_stop_failed',
        message: error instanceof Error ? error.message : String(error),
        next_step: 'Check whether the managed Chrome process is still running.',
      });
    }
  }

  await rm(statePath, { force: true });
  return {
    ok: true,
    command: 'browser stop',
    stopped,
    pid: state.pid ?? null,
    endpoint: state.endpoint ?? null,
    state_path: statePath,
    diagnostics,
    next_step: stopped ? 'Managed browser stop requested.' : 'State file removed; no live managed process was found.',
  };
}

function buildChromeArgs({ port, profileDir, url, headless }) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
  ];
  if (headless) {
    args.push('--headless=new', '--disable-gpu');
  }
  args.push(url);
  return args;
}

async function waitForEndpoint(endpoint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await inspectEndpoint(endpoint, 750);
    if (last.connected) {
      return last;
    }
    await sleep(200);
  }
  return last ?? {
    connected: false,
    category: 'browser_not_found',
    message: `Timed out waiting for ${endpoint}.`,
    next_step: 'Confirm Chrome launched successfully.',
  };
}

async function inspectEndpoint(endpoint, timeoutMs) {
  const [result] = await inspectCandidateEndpoints([endpoint], { timeoutMs });
  return result;
}

async function loadState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    return null;
  }
}

async function writeState(statePath, state) {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function readPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

