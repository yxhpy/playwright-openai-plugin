import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_DIR = join(homedir(), '.playwright-openai');

export function defaultAppDir() {
  return APP_DIR;
}

export function defaultProfileDir() {
  return join(APP_DIR, 'chrome-profile');
}

export function defaultStatePath() {
  return join(APP_DIR, 'browser-state.json');
}

export function defaultJobsDir() {
  return join(APP_DIR, 'jobs');
}

export function defaultImageOutputDir(jobId) {
  return join(APP_DIR, 'outputs', 'images', jobId);
}

export function defaultChromePath() {
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  return 'google-chrome';
}
