import { RaglensStore } from './store.js';
import { PostgresRaglensStore } from './postgres-store.js';

export function createRaglensStore(config, options = {}) {
  if (config.storage?.driver === 'postgres') {
    return new PostgresRaglensStore(config, options.postgres || {});
  }

  return new RaglensStore(config);
}
