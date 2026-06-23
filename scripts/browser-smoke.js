import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { findOpenPort, stopChild, trackChild, waitForHealth } from './smoke-utils.js';

const execFileAsync = promisify(execFile);
const browserPath = process.env.RAGLENS_BROWSER || findBrowser();

if (!browserPath) {
  console.log('Browser smoke skipped: set RAGLENS_BROWSER to Chrome or Edge.');
  process.exit(0);
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'raglens-browser-data-'));
const profileDir = await mkdtemp(path.join(os.tmpdir(), 'raglens-browser-profile-'));
const runStamp = Date.now();
const desktopDomPath = path.join(os.tmpdir(), `raglens-browser-${runStamp}-desktop.html`);
const desktopScreenshotPath = path.join(os.tmpdir(), `raglens-browser-${runStamp}-desktop.png`);
const mobileDomPath = path.join(os.tmpdir(), `raglens-browser-${runStamp}-mobile.html`);
const mobileScreenshotPath = path.join(os.tmpdir(), `raglens-browser-${runStamp}-mobile.png`);
const port = await findOpenPort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['src/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RAGLENS_HOST: '127.0.0.1',
    RAGLENS_PORT: String(port),
    RAGLENS_DATA_DIR: dataDir
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
const childState = trackChild(server);

try {
  await waitForHealth(`${baseUrl}/api/health`, { childState });
  const run = await createSmokeRun(baseUrl);
  const bundle = await fetchJson(`${baseUrl}/api/query-runs/${run.id}/bundle`);
  if (bundle.schema !== 'raglens.run-bundle.v1') {
    throw new Error('Run bundle endpoint returned an unexpected schema.');
  }
  const desktopDom = await captureBrowser({
    runId: run.id,
    screenshotPath: desktopScreenshotPath,
    width: 1440,
    height: 1000
  });
  const mobileDom = await captureBrowser({
    runId: run.id,
    screenshotPath: mobileScreenshotPath,
    width: 390,
    height: 900
  });
  await writeFile(desktopDomPath, desktopDom, 'utf8');
  await writeFile(mobileDomPath, mobileDom, 'utf8');

  assertAppDom(desktopDom, 'desktop');
  assertAppDom(mobileDom, 'mobile');
  console.log(`Browser smoke passed. Screenshots: ${desktopScreenshotPath}, ${mobileScreenshotPath}`);
} finally {
  await stopChild(server);
}

async function captureBrowser({ runId, screenshotPath, width, height }) {
  const { stdout } = await execFileAsync(browserPath, [
    '--headless',
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--use-gl=swiftshader',
    '--use-angle=swiftshader',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--virtual-time-budget=5000',
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    `--screenshot=${screenshotPath}`,
    '--dump-dom',
    `${baseUrl}/#run=${runId}`
  ]);
  return stdout;
}

function findBrowser() {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];

  return candidates.find((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertAppDom(stdout, label) {
  assert(stdout.includes('RAGLens'), `${label} DOM is missing RAGLens`);
  assert(stdout.includes('Inspector'), `${label} DOM is missing Inspector`);
  assert(stdout.includes('Run Bundle'), `${label} DOM is missing Run Bundle action`);
  assert(stdout.includes('Retrieved Chunks'), `${label} DOM is missing retrieved chunks`);
  assert(stdout.includes('project-select'), `${label} DOM is missing project selector`);
  assert(stdout.includes('New Project'), `${label} DOM is missing new project action`);
}

async function createSmokeRun(baseUrl) {
  return fetchJson(`${baseUrl}/api/query-runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      question: 'What caused the unsupported delivery estimates?',
      topK: 4,
      maxClaims: 2
    })
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}
