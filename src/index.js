import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { createServer } from './http/server.js';
import { createRaglensStore } from './services/store-factory.js';

loadDotEnv();
const config = loadConfig();
const store = createRaglensStore(config);
await store.load();

const server = createServer({ config, store });

server.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}`;
  console.log(`RAGLens is running at ${url}`);
  console.log(config.storage.driver === 'postgres' ? 'Storage: PostgreSQL' : `Data file: ${config.dataFile}`);
});

process.on('SIGINT', () => {
  server.close(async () => {
    await store.close?.();
    process.exit(0);
  });
});

function loadDotEnv(filePath = new URL('../.env', import.meta.url)) {
  if (!existsSync(filePath)) {
    return;
  }

  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) {
      continue;
    }
    process.env[match[1]] = parseDotEnvValue(match[2] || '');
  }
}

function parseDotEnvValue(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, '');
}
