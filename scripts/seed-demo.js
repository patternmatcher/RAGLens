import { loadConfig } from '../src/config.js';
import { RaglensStore } from '../src/services/store.js';

const store = new RaglensStore(loadConfig());
await store.resetDemo();
console.log('Seeded the RAGLens demo workspace.');
