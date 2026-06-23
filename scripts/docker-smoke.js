import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { findOpenPort, waitForHealth } from './smoke-utils.js';

const execFileAsync = promisify(execFile);
const docker = process.env.RAGLENS_DOCKER || 'docker';
const tag = `raglens:smoke-${Date.now()}`;
const containerName = `raglens-smoke-${Date.now()}`;
const adminToken = 'docker-smoke-token-with-32-plus-characters';
const port = await findOpenPort();
const baseUrl = `http://127.0.0.1:${port}`;
let containerStarted = false;

try {
  if (!(await dockerAvailable())) {
    const message = 'Docker smoke skipped: Docker CLI/daemon is unavailable.';
    if (process.env.CI === 'true' || process.env.RAGLENS_REQUIRE_DOCKER === '1') {
      throw new Error(message);
    }
    console.log(message);
    process.exit(0);
  }

  await runDocker(['build', '-t', tag, '.'], { label: 'Docker image build' });
  const { stdout } = await execFileAsync(docker, [
    'run',
    '--rm',
    '-d',
    '--name',
    containerName,
    '-p',
    `127.0.0.1:${port}:4177`,
    '-e',
    `RAGLENS_ADMIN_TOKEN=${adminToken}`,
    '-e',
    'RAGLENS_AUTO_SEED=true',
    tag
  ]);
  const containerId = stdout.trim();
  containerStarted = Boolean(containerId);

  await waitForHealth(`${baseUrl}/api/health`, {
    timeoutMs: 30_000,
    childState: () => ({ exited: false })
  });

  const publicState = await fetch(`${baseUrl}/api/state`);
  assert(publicState.status === 401, 'container exposed state without an admin token');

  const state = await readJson(`${baseUrl}/api/state`, {
    headers: {
      'X-RAGLens-Token': adminToken
    }
  });
  assert(state.documents.length >= 4, 'container did not seed demo documents');

  const run = await readJson(`${baseUrl}/api/query-runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-RAGLens-Token': adminToken
    },
    body: JSON.stringify({
      question: 'What caused the unsupported delivery estimates?',
      topK: 4,
      maxClaims: 2
    })
  });
  assert(run.id.startsWith('run_'), 'container did not create a query run');
  assert(run.answer.citations.length > 0, 'container run did not include citations');

  const bundle = await readJson(`${baseUrl}/api/query-runs/${run.id}/bundle`, {
    headers: {
      'X-RAGLens-Token': adminToken
    }
  });
  assert(bundle.schema === 'raglens.run-bundle.v1', 'container bundle export returned the wrong schema');
  assert(bundle.evidence.chunks.length > 0, 'container bundle export did not include retrieved chunks');

  console.log(`Docker smoke passed at ${baseUrl}.`);
} finally {
  if (containerStarted) {
    await execFileAsync(docker, ['rm', '-f', containerName]).catch(() => {});
  }
  await execFileAsync(docker, ['image', 'rm', tag]).catch(() => {});
}

async function dockerAvailable() {
  try {
    await execFileAsync(docker, ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function runDocker(args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(docker, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${options.label || 'docker command'} failed with exit code ${code}.`));
    });
  });
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
