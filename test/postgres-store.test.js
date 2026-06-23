import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createDemoState } from '../src/demo.js';
import { createRaglensStore } from '../src/services/store-factory.js';
import { RaglensStore } from '../src/services/store.js';
import { PostgresRaglensStore, loadStateFromPostgres, retrieveContextFromPostgres, syncStateToPostgres } from '../src/services/postgres-store.js';

test('createRaglensStore keeps JSON as the default and selects Postgres when configured', () => {
  const jsonConfig = loadConfig({
    RAGLENS_HOST: '127.0.0.1',
    RAGLENS_PORT: '0',
    RAGLENS_DATA_DIR: './data-test'
  });
  const postgresConfig = loadConfig({
    RAGLENS_HOST: '127.0.0.1',
    RAGLENS_PORT: '0',
    RAGLENS_DATA_DIR: './data-test',
    RAGLENS_STORAGE_DRIVER: 'postgres',
    RAGLENS_DATABASE_URL: 'postgres://raglens:secret@db.example.test/raglens'
  });

  assert.ok(createRaglensStore(jsonConfig) instanceof RaglensStore);
  assert.ok(createRaglensStore(postgresConfig, { postgres: { pool: fakePool() } }) instanceof PostgresRaglensStore);
  assert.throws(
    () =>
      loadConfig({
        RAGLENS_HOST: '127.0.0.1',
        RAGLENS_PORT: '0',
        RAGLENS_STORAGE_DRIVER: 'postgres'
      }),
    /RAGLENS_DATABASE_URL/
  );
});

test('loadStateFromPostgres maps project-scoped rows into normalized state', async () => {
  const demo = createDemoState();
  const project = demo.projects[0];
  const document = demo.documents[0];
  const chunk = demo.chunks[0];
  const run = {
    ...demo.runs[0],
    feedback: [
      {
        id: 'fbk_aaaaaaaaaaaa',
        rating: 'down',
        note: 'Needs review.',
        expected_answer: 'Expected answer.',
        created_at: demo.createdAt
      }
    ]
  };
  const pool = fakePool((text) => {
    if (text.startsWith('SELECT id, name')) {
      return {
        rows: [
          {
            id: project.id,
            name: project.name,
            description: project.description,
            ownerId: null,
            settings: demo.settings,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt
          }
        ]
      };
    }
    if (text.includes('WHERE p.id = $1')) {
      return {
        rows: [
          {
            id: project.id,
            name: project.name,
            description: project.description,
            settings: demo.settings,
            documents: [
              {
                id: document.id,
                project_id: document.projectId,
                title: document.title,
                source_type: document.sourceType,
                text: document.text,
                checksum: document.checksum,
                word_count: document.wordCount,
                status: document.status,
                metadata: document.metadata,
                created_at: document.createdAt,
                updated_at: document.updatedAt
              }
            ],
            chunks: [
              {
                id: chunk.id,
                project_id: chunk.projectId,
                document_id: chunk.documentId,
                document_title: chunk.documentTitle,
                chunk_index: chunk.index,
                label: chunk.label,
                heading: chunk.heading,
                section: chunk.section,
                page: chunk.page,
                text: chunk.text,
                token_count: chunk.tokenCount,
                terms: chunk.terms,
                term_counts: chunk.termCounts,
                embedding: `[${chunk.embedding.join(',')}]`,
                embedding_model: chunk.embeddingModel,
                embedded_at: chunk.embeddedAt,
                created_at: chunk.createdAt
              }
            ],
            runs: [run],
            evalQuestions: demo.evalQuestions
          }
        ]
      };
    }
    return { rows: [] };
  });

  const state = await loadStateFromPostgres(pool);

  assert.equal(state.activeProjectId, project.id);
  assert.equal(state.documents[0].sourceType, document.sourceType);
  assert.equal(state.chunks[0].embedding.length, 64);
  assert.equal(state.runs[0].feedback[0].expectedAnswer, 'Expected answer.');
  assert.equal(state.evalQuestions[0].expectedSource, demo.evalQuestions[0].expectedSource);
});

test('syncStateToPostgres writes a project-scoped transaction with cleanup and parameterized statements', async () => {
  const demo = createDemoState();
  demo.runs = [
    {
      id: 'run_aaaaaaaaaaaa',
      projectId: demo.activeProjectId,
      question: 'What happened?',
      config: {},
      query: {},
      queryTerms: [],
      retrieved: [
        {
          chunkId: demo.chunks[0].id,
          rank: 1,
          score: 0.9,
          rawScore: 1,
          lexicalScore: 1,
          similarityScore: 0.8,
          rerankScore: 1.2,
          coverage: 1,
          novelty: 1,
          matchedTerms: ['happened'],
          missingTerms: []
        }
      ],
      answer: {},
      evaluation: { metrics: {} },
      prompt: null,
      warnings: [],
      trace: [],
      usage: {},
      redactions: [],
      evidenceSnapshot: { documents: [], chunks: [] },
      observability: {},
      latencyMs: 12,
      feedback: [
        {
          id: 'fbk_aaaaaaaaaaaa',
          rating: 'down',
          note: 'Looks unsupported.',
          expectedAnswer: 'Expected grounded answer.',
          createdAt: demo.createdAt
        }
      ],
      createdAt: demo.createdAt
    }
  ];
  const client = {
    calls: [],
    released: false,
    async query(text, values = []) {
      this.calls.push({ text, values });
      return { rows: [] };
    },
    release() {
      this.released = true;
    }
  };
  const pool = {
    async connect() {
      return client;
    }
  };

  await syncStateToPostgres(pool, demo);

  assert.equal(client.calls[0].text, 'BEGIN');
  assert.equal(client.calls.at(-1).text, 'COMMIT');
  assert.equal(client.released, true);
  assert.ok(client.calls.some((call) => call.text.includes('DELETE FROM raglens_documents')));
  assert.ok(client.calls.some((call) => call.text.includes('INSERT INTO raglens_projects')));
  assert.ok(client.calls.some((call) => call.text.includes('$14::vector')));
  assert.ok(client.calls.some((call) => call.text.includes('INSERT INTO raglens_feedback')));
  assert.ok(client.calls.every((call) => !call.text.includes('undefined') && !call.text.includes('NaN')));
});

test('retrieveContextFromPostgres maps pgvector search rows into pipeline retrieval results', async () => {
  const demo = createDemoState();
  const chunk = demo.chunks[0];
  const pool = fakePool((text, values) => {
    assert.match(text, /embedding <=> q\.embedding/);
    assert.equal(values[0], demo.activeProjectId);
    assert.ok(values[1].includes('delivery'));
    assert.equal(values[3], 'hybrid');
    assert.equal(values[5], 3);

    return {
      rows: [
        {
          id: chunk.id,
          projectId: chunk.projectId,
          documentId: chunk.documentId,
          documentTitle: chunk.documentTitle,
          chunkIndex: chunk.index,
          label: chunk.label,
          heading: chunk.heading,
          section: chunk.section,
          page: chunk.page,
          text: chunk.text,
          tokenCount: chunk.tokenCount,
          terms: chunk.terms,
          termCounts: chunk.termCounts,
          embedding: `[${chunk.embedding.join(',')}]`,
          embeddingModel: chunk.embeddingModel,
          embeddedAt: chunk.embeddedAt,
          createdAt: chunk.createdAt,
          indexedChunks: demo.chunks.length,
          matchedTerms: ['delivery'],
          missingTerms: ['estimate'],
          coverage: '0.5',
          lexicalScore: '2.75',
          vectorScore: '0.82',
          rawScore: '3.95',
          rerankScore: '5.1'
        }
      ]
    };
  });

  const retrieval = await retrieveContextFromPostgres(pool, {
    projectId: demo.activeProjectId,
    question: 'What caused delivery estimate failures?',
    topK: 3,
    retrievalMode: 'hybrid',
    rerank: true
  });

  assert.equal(retrieval.stats.source, 'postgres-pgvector');
  assert.equal(retrieval.stats.indexedChunks, demo.chunks.length);
  assert.equal(retrieval.results[0].rank, 1);
  assert.equal(retrieval.results[0].chunk.id, chunk.id);
  assert.equal(retrieval.results[0].coverage, 0.5);
  assert.equal(retrieval.results[0].similarityScore, 0.82);
  assert.deepEqual(retrieval.results[0].matchedTerms, ['delivery']);
});

function fakePool(handler = () => ({ rows: [] })) {
  return {
    queries: [],
    async query(text, values = []) {
      this.queries.push({ text, values });
      return handler(text, values);
    }
  };
}
