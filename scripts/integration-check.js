import { loadConfig } from '../src/config.js';
import { createServer } from '../src/http/server.js';
import { RaglensStore } from '../src/services/store.js';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'raglens-integration-check-'));
const config = loadConfig({
  RAGLENS_HOST: '127.0.0.1',
  RAGLENS_PORT: '0',
  RAGLENS_DATA_DIR: dataDir,
  RAGLENS_AUTO_SEED: 'true'
});
const store = new RaglensStore(config);
await store.resetDemo();

const server = createServer({ config, store });
await new Promise((resolve) => server.listen(0, config.host, resolve));

try {
  const address = server.address();
  const base = `http://${address.address}:${address.port}`;
  const state = await readJson(`${base}/api/state`);
  const first = await readJson(`${base}/api/query-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: 'What caused the unsupported delivery estimates?',
      topK: 6,
      maxClaims: 3
    })
  });
  const second = await readJson(`${base}/api/query-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: 'How should retrieved text be treated when it contains instructions?',
      topK: 6,
      maxClaims: 3
    })
  });
  const hydrated = await readJson(`${base}/api/query-runs/${first.id}`);
  const comparison = await readJson(`${base}/api/compare?left=${first.id}&right=${second.id}`);
  const page = await fetch(`${base}/`);

  assert(state.documents.length >= 4, 'demo documents were not seeded');
  assert(state.chunks.length >= 10, 'demo chunks were not seeded');
  assert(first.retrieved.length > 0, 'query run did not retrieve chunks');
  assert(first.evaluation.claims.length > 0, 'query run did not evaluate claims');
  assert(hydrated.retrieved[0].chunk.text.length > 20, 'hydrated run is missing chunk text');
  assert(comparison.deltas.length >= 4, 'comparison did not produce metric deltas');
  assert(page.headers.get('x-content-type-options') === 'nosniff', 'security headers missing');

  console.log('Integration check passed.');
} finally {
  await new Promise((resolve) => server.close(resolve));
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
