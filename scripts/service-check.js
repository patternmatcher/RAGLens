import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findOpenPort, stopChild, trackChild, waitForHealth } from './check-utils.js';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'raglens-service-'));
const port = await findOpenPort();
const baseUrl = `http://127.0.0.1:${port}`;
const adminToken = 'service-check-token';
const server = spawn(process.execPath, ['src/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RAGLENS_HOST: '127.0.0.1',
    RAGLENS_PORT: String(port),
    RAGLENS_DATA_DIR: dataDir,
    RAGLENS_AUTO_SEED: 'true',
    RAGLENS_ADMIN_TOKEN: adminToken
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
const childState = trackChild(server);

try {
  await waitForHealth(`${baseUrl}/api/health`, { childState });

  const publicState = await fetch(`${baseUrl}/api/state`);
  assert(publicState.status === 401, 'secured production entrypoint exposed state without an admin token');

  const state = await readJson(`${baseUrl}/api/state`, {
    headers: {
      'X-RAGLens-Token': adminToken
    }
  });
  assert(state.documents.length >= 4, 'production entrypoint did not seed demo documents');
  assert(state.providers.local.configured === true, 'provider status was not exposed');
  assert(JSON.stringify(state).includes('RAGLENS_OPENAI_API_KEY') === false, 'provider env name leaked into state');

  const unauthorized = await fetch(`${baseUrl}/api/query-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'Should this be rejected?' })
  });
  assert(unauthorized.status === 401, 'secured production entrypoint accepted an unauthenticated mutation');

  const run = await readJson(`${baseUrl}/api/query-runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-RAGLens-Token': adminToken
    },
    body: JSON.stringify({
      question: 'What caused the unsupported delivery estimates?',
      topK: 6,
      maxClaims: 3
    })
  });
  assert(run.id.startsWith('run_'), 'query run id was not created');
  assert(run.config.mode === 'local-grounded-extractive', 'unexpected default generation mode');
  assert(run.answer.citations.length > 0, 'query run did not attach citations');

  const publicShare = await fetch(`${baseUrl}/api/share/${run.id}`);
  assert(publicShare.status === 401, 'secured production entrypoint exposed a shared run without an admin token');

  const shared = await readJson(`${baseUrl}/api/share/${run.id}`, {
    headers: {
      'X-RAGLens-Token': adminToken
    }
  });
  assert(shared.id === run.id, 'share endpoint did not return the same run');

  console.log(`Service check passed at ${baseUrl}.`);
} finally {
  await stopChild(server);
}

async function readJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
