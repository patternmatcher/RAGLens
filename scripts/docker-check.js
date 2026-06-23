import { readFile } from 'node:fs/promises';

const dockerfile = await readFile('Dockerfile', 'utf8');
const compose = await readFile('docker-compose.yml', 'utf8');
const dockerignore = await readFile('.dockerignore', 'utf8');
const failures = [];

requireMatch('Dockerfile', dockerfile, /^FROM node:24-alpine/m, 'uses the pinned Node 24 Alpine base image');
requireMatch('Dockerfile', dockerfile, /ENV RAGLENS_HOST=0\.0\.0\.0/, 'binds to all interfaces inside the container');
requireMatch('Dockerfile', dockerfile, /ENV RAGLENS_DATA_DIR=\/data/, 'stores runtime data in /data');
requireMatch('Dockerfile', dockerfile, /USER raglens/, 'runs as the non-root raglens user');
requireMatch('Dockerfile', dockerfile, /HEALTHCHECK[\s\S]+\/api\/health/, 'defines an HTTP healthcheck');
requireMatch('Dockerfile', dockerfile, /CMD \["node", "src\/index\.js"\]/, 'runs the production entrypoint');

requireMatch('docker-compose.yml', compose, /"127\.0\.0\.1:4177:4177"/, 'publishes the service on loopback by default');
requireMatch('docker-compose.yml', compose, /RAGLENS_HOST:\s*0\.0\.0\.0/, 'uses the container bind host');
requireMatch('docker-compose.yml', compose, /RAGLENS_ALLOWED_HOSTS:/, 'documents allowed host wiring');
requireMatch('docker-compose.yml', compose, /RAGLENS_STORAGE_DRIVER:/, 'documents optional storage driver wiring');
requireMatch('docker-compose.yml', compose, /RAGLENS_DATABASE_URL:/, 'documents optional Postgres database URL wiring');
requireMatch('docker-compose.yml', compose, /RAGLENS_ADMIN_TOKEN:\s*\$\{RAGLENS_ADMIN_TOKEN:\?/, 'requires an operator-provided admin token for non-loopback binds');
rejectMatch('docker-compose.yml', compose, /change-this-before-hosting/, 'must not ship a known default admin token');
requireMatch('docker-compose.yml', compose, /RAGLENS_AUTO_SEED:/, 'documents auto-seed wiring');
requireMatch('docker-compose.yml', compose, /RAGLENS_ALLOW_INSECURE_DATABASE_SSL:/, 'documents explicit insecure database SSL wiring');
requireMatch('docker-compose.yml', compose, /RAGLENS_ALLOW_UNSAFE_PROVIDER_HTTP:/, 'documents unsafe provider HTTP wiring');
requireMatch('docker-compose.yml', compose, /RAGLENS_ALLOW_UNSAFE_OTEL_HTTP:/, 'documents unsafe OTLP HTTP wiring');
requireMatch('docker-compose.yml', compose, /RAGLENS_OPENAI_API_KEY:/, 'documents optional provider API key wiring');
requireMatch('docker-compose.yml', compose, /RAGLENS_OPENAI_TIMEOUT_MS:/, 'documents optional provider timeout wiring');
requireMatch('docker-compose.yml', compose, /RAGLENS_COST_INPUT_USD_PER_1M:/, 'documents optional input cost rate wiring');
requireMatch('docker-compose.yml', compose, /RAGLENS_COST_OUTPUT_USD_PER_1M:/, 'documents optional output cost rate wiring');
requireMatch('docker-compose.yml', compose, /RAGLENS_OTEL_EXPORT_URL:/, 'documents optional OTLP export URL wiring');
requireMatch('docker-compose.yml', compose, /RAGLENS_OTEL_HEADERS:/, 'documents optional OTLP header wiring');
requireMatch('docker-compose.yml', compose, /RAGLENS_OTEL_INCLUDE_CONTENT:/, 'documents explicit OTLP content export wiring');
requireMatch('docker-compose.yml', compose, /RAGLENS_PDF_TEXT_COMMAND:/, 'documents optional PDF text command wiring');
requireMatch('docker-compose.yml', compose, /RAGLENS_PDF_TEXT_TIMEOUT_MS:/, 'documents optional PDF text timeout wiring');
requireMatch('docker-compose.yml', compose, /raglens-data:\/data/, 'mounts persistent data at /data');
requireMatch('docker-compose.yml', compose, /read_only:\s*true/, 'uses a read-only root filesystem');
requireMatch('docker-compose.yml', compose, /tmpfs:[\s\S]+\/tmp/, 'provides tmpfs for parser temp files');
requireMatch('docker-compose.yml', compose, /cap_drop:[\s\S]+ALL/, 'drops Linux capabilities');
requireMatch('docker-compose.yml', compose, /no-new-privileges:true/, 'enables no-new-privileges');
requireMatch('docker-compose.yml', compose, /pids_limit:\s*128/, 'sets a process limit');
requireMatch('docker-compose.yml', compose, /mem_limit:\s*512m/, 'sets a memory limit');

for (const entry of ['data/', 'data-*/', 'node_modules/', '.git/', '.env', '.env.*', '!.env.example']) {
  requireMatch('.dockerignore', dockerignore, new RegExp(`(^|\\n)${escapeRegExp(entry)}($|\\n)`), `excludes ${entry}`);
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`Docker contract failed: ${failure}`);
  }
  process.exit(1);
}

console.log('Docker contract check passed.');

function requireMatch(file, text, pattern, description) {
  if (!pattern.test(text)) {
    failures.push(`${file} ${description}.`);
  }
}

function rejectMatch(file, text, pattern, description) {
  if (pattern.test(text)) {
    failures.push(`${file} ${description}.`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
