import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { chunkDocument, createDocument } from '../src/rag/chunker.js';
import { EmbeddingCache, embedTexts } from '../src/rag/embedding-provider.js';
import { runRagInspection } from '../src/rag/pipeline.js';
import { planQuery, rewriteQuery } from '../src/rag/query.js';
import { rerankCandidates } from '../src/rag/reranker.js';
import { retrieve } from '../src/rag/retriever.js';
import { searchWeb } from '../src/rag/web-fallback.js';

test('content-addressed embedding cache batches misses and reuses vectors', async () => {
  const cache = new EmbeddingCache();
  let calls = 0;
  const options = {
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8001/v1',
    model: 'test-embedding',
    projectId: 'prj_test',
    cache,
    fetchImpl: async (_url, request) => {
      calls += 1;
      const input = JSON.parse(request.body).input;
      return Response.json({ data: input.map((_, index) => ({ index, embedding: [index + 1, 0, 1] })) });
    }
  };

  const first = await embedTexts(['alpha', 'beta'], options);
  const second = await embedTexts(['alpha', 'beta'], options);

  assert.equal(calls, 1);
  assert.equal(first.cache.misses, 2);
  assert.equal(second.cache.hits, 2);
  assert.deepEqual(second.vectors, first.vectors);
  assert.equal(cache.toJSON().some((entry) => Object.hasOwn(entry, 'text')), false);
});

test('query planning decomposes locally and accepts structured local-model output', async () => {
  const local = rewriteQuery('Compare refund timing and explain approval ownership');
  assert.ok(local.searchQueries.length > 1);
  assert.equal(rewriteQuery('What is the RPO?').rewritten.includes('recovery point objective'), true);

  const planned = await planQuery('What changed in the refund policy?', {
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'local-planner',
    fetchImpl: async () => Response.json({
      choices: [{ message: { content: JSON.stringify({
        rewrittenQuery: 'latest refund policy changes',
        expansions: ['returns'],
        subqueries: ['refund window', 'refund approval'],
        ambiguous: false,
        ambiguityReason: ''
      }) } }]
    })
  });

  assert.equal(planned.mode, 'openai-compatible');
  assert.deepEqual(planned.searchQueries, ['latest refund policy changes', 'refund window', 'refund approval']);
});

test('external reranking and ColBERT mode preserve indexed score ordering', async () => {
  const chunks = sampleChunks();
  const retrieval = retrieve('refund policy', chunks, { topK: 2, candidateDepth: 3 });
  const reranked = await rerankCandidates('refund policy', retrieval.candidates, {
    provider: 'colbert',
    baseUrl: 'http://127.0.0.1:8080',
    model: 'colbert-ir',
    topK: 2,
    fetchImpl: async () => Response.json({
      results: retrieval.candidates.map((_, index) => ({ index, relevance_score: index }))
    })
  });

  assert.equal(reranked.results[0].chunk.id, retrieval.candidates.at(-1).chunk.id);
  assert.equal(reranked.stage.name, 'ColBERT late-interaction rerank');
});

test('parent retrieval expands neighboring chunks without changing ranked matches', () => {
  const document = createDocument({
    title: 'Long Policy',
    text: '# Refunds\nThe refund request begins in the support portal. '.repeat(20) +
      '\n\nApproval belongs to the finance duty manager. '.repeat(20)
  });
  const chunks = chunkDocument(document, { maxTokens: 40, overlapTokens: 0 });
  const result = retrieve('Who approves refund requests?', chunks, {
    topK: 1,
    candidateDepth: 4,
    parentContext: true,
    parentContextMaxTokens: 240
  });

  assert.equal(result.matches.length, 1);
  assert.ok(result.results.length > result.matches.length);
  assert.ok(result.results.some((item) => item.contextRole === 'parent'));
});

test('low-confidence runs abstain unless an approved web fallback returns evidence', async () => {
  const abstained = await runRagInspection({ question: 'What is the launch code?', chunks: [] });
  assert.equal(abstained.answer.abstained, true);
  assert.equal(abstained.retrieval.abstained, true);

  const web = await searchWeb('refund window', {
    enabled: true,
    baseUrl: 'http://127.0.0.1:8888',
    allowedDomains: ['docs.example.test'],
    fetchImpl: async () => Response.json({ results: [
      { title: 'Approved source', url: 'https://docs.example.test/refunds', content: 'Refund requests are accepted for thirty days.', score: 0.9 },
      { title: 'Rejected source', url: 'https://other.example.test/refunds', content: 'Unapproved result.', score: 1 }
    ] })
  });
  assert.equal(web.results.length, 1);

  const recovered = await runRagInspection({
    question: 'What is the refund window?',
    chunks: [],
    config: {
      webFallback: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:8888',
        allowedDomains: ['docs.example.test'],
        minConfidence: 0.32,
        fetchImpl: async () => Response.json({ results: [
          { title: 'Refund policy', url: 'https://docs.example.test/refunds', content: 'The refund window is thirty days from purchase.', score: 0.9 }
        ] })
      }
    }
  });
  assert.equal(recovered.answer.abstained, false);
  assert.equal(recovered.retrieval.fallback.status, 'ok');
  assert.ok(recovered.retrieved[0].chunkId.startsWith('web_'));
});

test('remote embedding and search egress require explicit deployment consent', () => {
  const base = { RAGLENS_HOST: '127.0.0.1', RAGLENS_PORT: '0', RAGLENS_DATA_DIR: './data-test' };
  assert.throws(() => loadConfig({
    ...base,
    RAGLENS_EMBEDDING_PROVIDER: 'openai-compatible',
    RAGLENS_EMBEDDING_BASE_URL: 'https://embed.example.test/v1',
    RAGLENS_EMBEDDING_API_KEY: 'test-key',
    RAGLENS_EMBEDDING_MODEL: 'embed-model'
  }), /ALLOW_REMOTE_EMBEDDING_EGRESS/);
  assert.throws(() => loadConfig({
    ...base,
    RAGLENS_WEB_FALLBACK_ENABLED: 'true',
    RAGLENS_WEB_SEARCH_BASE_URL: 'https://search.example.test'
  }), /ALLOW_REMOTE_WEB_QUERY_EGRESS/);
});

function sampleChunks() {
  const documents = [
    createDocument({ title: 'Refund policy', text: 'Refund policy requests are accepted for thirty days after purchase.' }),
    createDocument({ title: 'Approval guide', text: 'Finance managers approve refund requests after support review.' }),
    createDocument({ title: 'Unrelated', text: 'Warehouse inventory is counted every Friday.' })
  ];
  return documents.flatMap((document) => chunkDocument(document, { maxTokens: 80, overlapTokens: 0 }));
}
