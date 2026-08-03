import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/http/server.js';
import { RaglensStore } from '../src/services/store.js';

test('HTTP server serves assets and query-run API', async () => {
  const fixture = await startFixtureServer();

  try {
    const { base } = fixture;
    const health = await readJson(`${base}/api/health`);
    const page = await (await fetch(`${base}/`)).text();
    const run = await readJson(`${base}/api/query-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'What caused the unsupported delivery estimates?',
        topK: 6,
        maxClaims: 3
      })
    });

    assert.equal(health.ok, true);
    assert.match(page, /RAGLens/);
    assert.equal(run.retrieved.length > 0, true);
    assert.equal(run.evaluation.claims.length > 0, true);
  } finally {
    await fixture.close();
  }
});

test('compare API explains config, answers, warnings, and retrieval movement', async () => {
  const fixture = await startFixtureServer();

  try {
    const { base } = fixture;
    const baseline = await readJson(`${base}/api/query-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'What caused the unsupported delivery estimates?',
        topK: 3,
        maxClaims: 2,
        retrievalMode: 'hybrid',
        promptTemplate: 'Answer briefly from retrieved context and cite sources.',
        promptLoggingEnabled: true
      })
    });
    const candidate = await readJson(`${base}/api/query-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'What caused the unsupported delivery estimates?',
        topK: 7,
        maxClaims: 4,
        retrievalMode: 'keyword',
        promptTemplate: 'Explain the operational cause from retrieved context and cite every claim.',
        promptLoggingEnabled: true
      })
    });
    const comparison = await readJson(`${base}/api/compare?left=${baseline.id}&right=${candidate.id}`);

    assert.equal(comparison.left.id, baseline.id);
    assert.equal(comparison.right.id, candidate.id);
    assert.equal(Object.hasOwn(comparison.left, 'retrieved'), false);
    assert.equal(Object.hasOwn(comparison.right, 'retrieved'), false);
    assert.equal(JSON.stringify(comparison.left).includes('"text"'), false);
    assert.equal(JSON.stringify(comparison.right).includes('"text"'), false);
    assert.ok(comparison.deltas.some((row) => row.key === 'faithfulness'));
    assert.ok(comparison.configDiffs.some((row) => row.key === 'topK' && row.left === '3' && row.right === '7' && row.changed));
    assert.ok(comparison.configDiffs.some((row) => row.key === 'retrievalMode' && row.changed));
    assert.ok(comparison.configDiffs.some((row) => row.key === 'promptTemplateFingerprint' && row.changed));
    assert.ok(comparison.configDiffs.some((row) => row.key === 'promptTemplatePreview' && row.changed));
    assert.ok(comparison.configDiffs.some((row) => row.key === 'chunkTokens'));
    assert.ok(comparison.configDiffs.some((row) => row.key === 'avgChunkTokens'));
    assert.equal(typeof comparison.answers.leftText, 'string');
    assert.equal(typeof comparison.answers.rightText, 'string');
    assert.equal(typeof comparison.answers.faithfulnessDelta, 'number');
    assert.equal(typeof comparison.retrieval.overlapRatio, 'number');
    assert.equal(typeof comparison.retrieval.sourceOverlapRatio, 'number');
    assert.equal(typeof comparison.retrieval.topChunkChanged, 'boolean');
    assert.equal(typeof comparison.retrieval.topSourceChanged, 'boolean');
    assert.ok(Array.isArray(comparison.retrieval.shared));
    assert.ok(Array.isArray(comparison.retrieval.sharedSources));
    assert.ok(Array.isArray(comparison.retrieval.leftOnly));
    assert.ok(Array.isArray(comparison.retrieval.rightOnly));
    assert.equal(typeof comparison.warnings.leftCount, 'number');
    assert.equal(typeof comparison.warnings.rightCount, 'number');
    assert.ok(Array.isArray(comparison.warnings.addedTypes));
    assert.ok(Array.isArray(comparison.warnings.resolvedTypes));
  } finally {
    await fixture.close();
  }
});

test('HTTP server applies security headers and rejects unsafe requests', async () => {
  const fixture = await startFixtureServer();

  try {
    const { base } = fixture;
    const page = await fetch(`${base}/`);
    const traversal = await fetch(`${base}/..%2Fpackage.json`);
    const wrongType = await fetch(`${base}/api/query-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'question=hello'
    });
    const missingAsset = await fetch(`${base}/missing.js`);

    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(traversal.status, 403);
    assert.equal(wrongType.status, 415);
    assert.equal(missingAsset.status, 404);
  } finally {
    await fixture.close();
  }
});

test('HTTP server rejects untrusted Host headers', async () => {
  const fixture = await startFixtureServer();

  try {
    const { base } = fixture;
    const port = new URL(base).port;
    const host = `attacker.example:${port}`;
    const readAttempt = await requestWithHost(base, {
      path: '/api/state',
      headers: { Host: host }
    });
    const mutationAttempt = await requestWithHost(base, {
      method: 'PATCH',
      path: '/api/settings',
      headers: {
        Host: host,
        Origin: `http://${host}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });

    assert.equal(readAttempt.status, 403);
    assert.equal(mutationAttempt.status, 403);
  } finally {
    await fixture.close();
  }
});

test('document indexing redacts likely secrets before persistence', async () => {
  const fixture = await startFixtureServer();

  try {
    const { base } = fixture;
    const result = await readJson(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Secret Fixture',
        sourceType: 'text',
        text: 'The API_KEY=supersecretvalue123456789 should never stay raw in indexed text.'
      })
    });

    assert.equal(Object.hasOwn(result.document, 'text'), false);
    assert.match(result.chunks[0].text, /\[REDACTED:generic-api-key\]/);
    assert.equal(result.chunks[0].text.includes('supersecretvalue123456789'), false);
  } finally {
    await fixture.close();
  }
});

test('ingestion job API queues documents without exposing raw source text', async () => {
  const fixture = await startFixtureServer();

  try {
    const { base } = fixture;
    const job = await readJson(`${base}/api/ingestion-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Queued Secret Fixture',
        sourceType: 'text',
        text: 'The queued ingestion body contains API_KEY=queuedsecret123456789 and should not echo raw text.'
      })
    });
    const completed = await waitForJson(
      `${base}/api/ingestion-jobs/${job.id}`,
      (payload) => ['completed', 'failed'].includes(payload.status)
    );
    const jobs = await readJson(`${base}/api/ingestion-jobs`);
    const state = await readJson(`${base}/api/state`);
    const serializedJob = JSON.stringify(completed);

    assert.equal(job.status, 'queued');
    assert.equal(Object.hasOwn(job, 'input'), false);
    assert.equal(serializedJob.includes('queuedsecret123456789'), false);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.document.title, 'Queued Secret Fixture');
    assert.equal(completed.chunkCount > 0, true);
    assert.equal(jobs.some((item) => item.id === job.id), true);
    assert.equal(state.ingestionJobs.some((item) => item.id === job.id), true);
    assert.equal(state.documents.some((document) => document.id === completed.document.id), true);
  } finally {
    await fixture.close();
  }
});

test('ingestion jobs remain scoped to their queued project', async () => {
  const fixture = await startFixtureServer();

  try {
    const { base } = fixture;
    const first = await readJson(`${base}/api/state`);
    const second = await readJson(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Queue Project',
        description: 'Project-scoped queue fixture.'
      })
    });
    const job = await readJson(`${base}/api/ingestion-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: second.activeProjectId,
        title: 'Scoped Queue Fixture',
        sourceType: 'text',
        text: 'Scoped queue text says the private queue answer is cobalt.'
      })
    });
    await waitForJson(
      `${base}/api/ingestion-jobs/${job.id}?projectId=${second.activeProjectId}`,
      (payload) => payload.status === 'completed'
    );
    const firstAgain = await readJson(`${base}/api/projects/active`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: first.activeProjectId })
    });
    const hiddenJob = await fetch(`${base}/api/ingestion-jobs/${job.id}?projectId=${first.activeProjectId}`);
    const secondAgain = await readJson(`${base}/api/projects/active`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: second.activeProjectId })
    });

    assert.equal(hiddenJob.status, 404);
    assert.equal(firstAgain.ingestionJobs.some((item) => item.id === job.id), false);
    assert.equal(secondAgain.ingestionJobs.some((item) => item.id === job.id), true);
    assert.equal(secondAgain.documents.some((document) => document.title === 'Scoped Queue Fixture'), true);
  } finally {
    await fixture.close();
  }
});

test('document reindex supports chunk-size comparison workflow', async () => {
  const fixture = await startFixtureServer();

  try {
    const { base } = fixture;
    const longText = Array.from({ length: 18 }, (_, index) =>
      `Chunk experiment paragraph ${index + 1} says delivery policy evidence should stay searchable while chunk boundaries change.`
    ).join('\n\n');
    const projectState = await readJson(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Chunk Experiment',
        description: 'Chunk-size comparison fixture.'
      })
    });
    await readJson(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: projectState.activeProjectId,
        chunkTokens: 120,
        overlapTokens: 0
      })
    });
    const indexed = await readJson(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: projectState.activeProjectId,
        title: 'Chunk Experiment Note',
        sourceType: 'text',
        text: longText
      })
    });
    const baseline = await readJson(`${base}/api/query-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: projectState.activeProjectId,
        question: 'What should stay searchable while chunk boundaries change?',
        topK: 4,
        maxClaims: 2
      })
    });
    await readJson(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: projectState.activeProjectId,
        chunkTokens: 40,
        overlapTokens: 0
      })
    });
    const reindexed = await readJson(`${base}/api/documents/reindex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: projectState.activeProjectId })
    });
    const candidate = await readJson(`${base}/api/query-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: projectState.activeProjectId,
        question: 'What should stay searchable while chunk boundaries change?',
        topK: 4,
        maxClaims: 2
      })
    });
    const comparison = await readJson(
      `${base}/api/compare?left=${baseline.id}&right=${candidate.id}&projectId=${projectState.activeProjectId}`
    );

    assert.equal(indexed.chunks.length < reindexed.chunks.length, true);
    assert.equal(reindexed.settings.chunkTokens, 40);
    assert.equal(reindexed.documents[0].title, 'Chunk Experiment Note');
    assert.equal(reindexed.chunks.every((chunk) => chunk.documentId === indexed.document.id), true);
    assert.equal(candidate.config.chunkTokens, 40);
    assert.ok(comparison.configDiffs.some((row) => row.key === 'chunkTokens' && row.changed));
    assert.equal(comparison.retrieval.overlapRatio, 0);
    assert.equal(comparison.retrieval.sourceOverlapRatio, 1);
    assert.equal(comparison.retrieval.sharedSources[0].documentTitle, 'Chunk Experiment Note');
    assert.equal(comparison.left.id, baseline.id);
    assert.equal(comparison.right.id, candidate.id);
  } finally {
    await fixture.close();
  }
});

test('public state and document responses omit retrieval-only embedding internals', async () => {
  const fixture = await startFixtureServer();

  try {
    const { base } = fixture;
    const initialState = await readJson(`${base}/api/state`);
    const result = await readJson(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Public API Fixture',
        sourceType: 'text',
        text: 'Public responses should include previewable evidence text but not embedding vectors or term internals.'
      })
    });
    const nextState = await readJson(`${base}/api/state`);
    const exposedChunks = [...initialState.chunks, ...result.chunks, ...nextState.chunks];

    assert.ok(exposedChunks.length > 0);
    for (const document of nextState.documents) {
      assert.equal(Object.hasOwn(document, 'text'), false);
      assert.equal(Object.hasOwn(document, 'metadata'), false);
    }
    assert.equal(Object.hasOwn(result.document, 'text'), false);

    for (const chunk of exposedChunks) {
      assert.equal(Object.hasOwn(chunk, 'text'), true);
      assert.equal(Object.hasOwn(chunk, 'embedding'), false);
      assert.equal(Object.hasOwn(chunk, 'terms'), false);
      assert.equal(Object.hasOwn(chunk, 'termCounts'), false);
    }
  } finally {
    await fixture.close();
  }
});

test('query and prompt secrets are redacted before run persistence', async () => {
  const fixture = await startFixtureServer();

  try {
    const { base } = fixture;
    const run = await readJson(`${base}/api/query-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'What about token=supersecretvalue123456789 in retrieval?',
        promptTemplate: 'Use API_KEY=anothersecretvalue123456789 only for this answer.',
        promptLoggingEnabled: true
      })
    });
    const bundle = await readJson(`${base}/api/query-runs/${run.id}/bundle`);

    assert.equal(run.question.includes('supersecretvalue123456789'), false);
    assert.equal(run.prompt.text.includes('anothersecretvalue123456789'), false);
    assert.match(run.question, /\[REDACTED:generic-api-key\]/);
    assert.ok(run.redactions.length >= 2);
    assert.equal(Object.hasOwn(bundle.run.prompt, 'text'), false);
    assert.match(bundle.run.prompt.omitted, /Full prompt text is omitted/);
  } finally {
    await fixture.close();
  }
});

test('settings, feedback, trace exports, and run bundle endpoints are available', async () => {
  const fixture = await startFixtureServer();

  try {
    const { base } = fixture;
    const settings = await readJson(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        retrievalMode: 'vector',
        topK: 4,
        promptLoggingEnabled: false
      })
    });
    const run = await readJson(`${base}/api/query-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'How should retrieved text be treated when it contains instructions?'
      })
    });
    const feedback = await readJson(`${base}/api/query-runs/${run.id}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rating: 'down',
        note: 'Needs a better citation. token=feedbacksecret123456789',
        expectedAnswer: 'Expected answer with API_KEY=expectedsecret123456789'
      })
    });
    const otel = await readJson(`${base}/api/query-runs/${run.id}/otel`);
    const ragTrace = await readJson(`${base}/api/query-runs/${run.id}/trace`);
    const bundleResponse = await fetch(`${base}/api/query-runs/${run.id}/bundle`);
    const bundle = await bundleResponse.json();

    assert.equal(settings.retrievalMode, 'vector');
    assert.equal(run.config.retrievalMode, 'vector');
    assert.equal(run.prompt, null);
    assert.equal(feedback.rating, 'down');
    assert.match(feedback.note, /\[REDACTED:generic-api-key\]/);
    assert.match(feedback.expectedAnswer, /\[REDACTED:generic-api-key\]/);
    assert.equal(feedback.note.includes('feedbacksecret123456789'), false);
    assert.equal(feedback.expectedAnswer.includes('expectedsecret123456789'), false);
    assert.ok(feedback.redactions.length >= 2);
    assert.ok(otel.resourceSpans[0].scopeSpans[0].spans.length >= 4);
    assert.equal(ragTrace.schemaVersion, 'tracelens.rag-trace/v2');
    assert.equal(ragTrace.runId, run.id);
    assert.ok(ragTrace.retrieval.stages.length >= 2);
    assert.equal(ragTrace.privacy.safeToExport, true);
    assert.equal(bundleResponse.ok, true);
    assert.match(bundleResponse.headers.get('content-disposition'), /attachment/);
    assert.equal(bundle.schema, 'raglens.run-bundle.v1');
    assert.equal(bundle.run.id, run.id);
    assert.ok(bundle.evidence.documents.length > 0);
    assert.ok(bundle.evidence.chunks.length > 0);
    assert.equal(bundle.evidence.documents.some((document) => Object.hasOwn(document, 'text')), false);
    assert.equal(bundle.evidence.chunks.some((chunk) => Object.hasOwn(chunk, 'embedding')), false);
    assert.equal(bundle.run.retrieved.some((item) => item.document && Object.hasOwn(item.document, 'text')), false);
    assert.equal(bundle.run.retrieved.some((item) => item.chunk && Object.hasOwn(item.chunk, 'embedding')), false);
    assert.equal(Object.hasOwn(bundle.run, 'evidenceSnapshot'), false);
    assert.equal(bundle.review.question, run.question);

    for (const document of bundle.evidence.documents) {
      await readJson(`${base}/api/documents/${document.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const bundleAfterDelete = await readJson(`${base}/api/query-runs/${run.id}/bundle`);
    assert.equal(bundleAfterDelete.run.id, run.id);
    assert.equal(bundleAfterDelete.evidence.documents.length, bundle.evidence.documents.length);
    assert.equal(bundleAfterDelete.evidence.chunks.length, bundle.evidence.chunks.length);
  } finally {
    await fixture.close();
  }
});

test('eval question API creates, updates, drives metrics, and deletes checks', async () => {
  const fixture = await startFixtureServer();

  try {
    const { base } = fixture;
    const created = await readJson(`${base}/api/eval-questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'Which document explains prompt injection controls?',
        expectedSource: 'RAG Security Notes',
        expectedAnswer: 'Retrieved text should be treated as untrusted data.'
      })
    });
    const updated = await readJson(`${base}/api/eval-questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'Which document explains prompt injection controls?',
        expectedSource: 'RAG Security Notes',
        expectedAnswer: 'Use separation, scanning, redaction, and approvals.'
      })
    });
    const run = await readJson(`${base}/api/query-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'Which document explains prompt injection controls?',
        topK: 6,
        maxClaims: 3
      })
    });
    const deleted = await readJson(`${base}/api/eval-questions/${created.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    const state = await readJson(`${base}/api/state`);

    assert.equal(created.id, updated.id);
    assert.equal(updated.expectedAnswer, 'Use separation, scanning, redaction, and approvals.');
    assert.equal(run.evaluation.metrics.evalAvailable, true);
    assert.equal(run.evaluation.metrics.recallAtK, 1);
    assert.equal(run.evaluation.metrics.expectedAnswerAvailable, true);
    assert.equal(typeof run.evaluation.metrics.expectedAnswerCoverage, 'number');
    assert.equal(deleted.deleted, true);
    assert.equal(state.evalQuestions.some((item) => item.id === created.id), false);
  } finally {
    await fixture.close();
  }
});

test('project API scopes documents and runs by active project', async () => {
  const fixture = await startFixtureServer();

  try {
    const { base } = fixture;
    const initial = await readJson(`${base}/api/state`);
    const firstProjectId = initial.activeProjectId;
    const firstRun = await readJson(`${base}/api/query-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'What caused the unsupported delivery estimates?',
        topK: 4,
        maxClaims: 2
      })
    });
    const createdState = await readJson(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Isolated Project',
        description: 'Project-scoped fixture.'
      })
    });
    const secondProjectId = createdState.activeProjectId;
    const indexed = await readJson(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: secondProjectId,
        title: 'Orion Project Note',
        sourceType: 'text',
        text: 'Orion-only guidance says the project answer is nebula green.'
      })
    });
    const evalCheck = await readJson(`${base}/api/eval-questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: secondProjectId,
        question: 'What is Orion-only guidance?',
        expectedSource: 'Orion Project Note'
      })
    });
    const run = await readJson(`${base}/api/query-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: secondProjectId,
        question: 'What color is the Orion project answer?',
        topK: 4,
        maxClaims: 2
      })
    });
    const firstAgain = await readJson(`${base}/api/projects/active`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: firstProjectId })
    });
    const hiddenRun = await fetch(`${base}/api/query-runs/${run.id}?projectId=${firstProjectId}`);
    const hiddenShare = await fetch(`${base}/api/share/${run.id}?projectId=${firstProjectId}`);
    const hiddenOtel = await fetch(`${base}/api/query-runs/${run.id}/otel?projectId=${firstProjectId}`);
    const hiddenBundle = await fetch(`${base}/api/query-runs/${run.id}/bundle?projectId=${firstProjectId}`);
    const hiddenFeedback = await fetch(`${base}/api/query-runs/${run.id}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: firstProjectId, rating: 'up' })
    });
    const hiddenDelete = await fetch(`${base}/api/documents/${indexed.document.id}?projectId=${firstProjectId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    const hiddenEvalDelete = await fetch(`${base}/api/eval-questions/${evalCheck.id}?projectId=${firstProjectId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    const hiddenCompare = await fetch(
      `${base}/api/compare?left=${firstRun.id}&right=${run.id}&projectId=${firstProjectId}`
    );
    const secondAgain = await readJson(`${base}/api/projects/active`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: secondProjectId })
    });

    assert.notEqual(firstProjectId, secondProjectId);
    assert.equal(createdState.documents.length, 0);
    assert.equal(indexed.document.projectId, secondProjectId);
    assert.equal(run.projectId, secondProjectId);
    assert.match(run.answer.text, /nebula green/i);
    assert.equal(hiddenRun.status, 404);
    assert.equal(hiddenShare.status, 404);
    assert.equal(hiddenOtel.status, 404);
    assert.equal(hiddenBundle.status, 404);
    assert.equal(hiddenFeedback.status, 404);
    assert.equal(hiddenDelete.status, 404);
    assert.equal(hiddenEvalDelete.status, 404);
    assert.equal(hiddenCompare.status, 404);
    assert.equal(firstAgain.documents.some((document) => document.id === indexed.document.id), false);
    assert.equal(firstAgain.runs.some((item) => item.id === run.id), false);
    assert.equal(secondAgain.documents.some((document) => document.id === indexed.document.id), true);
    assert.equal(secondAgain.runs.some((item) => item.id === run.id), true);
    assert.equal(secondAgain.evalQuestions.some((item) => item.id === evalCheck.id), true);
  } finally {
    await fixture.close();
  }
});

test('project-scoped mutations can target an explicit project without switching active project', async () => {
  const fixture = await startFixtureServer();

  try {
    const { base } = fixture;
    const initial = await readJson(`${base}/api/state`);
    const firstProjectId = initial.activeProjectId;
    const createdState = await readJson(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Concurrent Target',
        description: 'Used to prove explicit project ids.'
      })
    });
    const secondProjectId = createdState.activeProjectId;
    const indexed = await readJson(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: secondProjectId,
        title: 'Concurrent Project Note',
        sourceType: 'text',
        text: 'Concurrent project guidance says the launch status is amber.'
      })
    });

    await readJson(`${base}/api/projects/active`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: firstProjectId })
    });
    const secondSettings = await readJson(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: secondProjectId,
        topK: 2,
        maxClaims: 1,
        retrievalMode: 'keyword'
      })
    });

    const evalCheck = await readJson(`${base}/api/eval-questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: secondProjectId,
        question: 'What is the concurrent launch status?',
        expectedSource: 'Concurrent Project Note',
        expectedAnswer: 'The launch status is amber.'
      })
    });
    const run = await readJson(`${base}/api/query-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: secondProjectId,
        question: 'What is the concurrent launch status?'
      })
    });
    const hydrated = await readJson(`${base}/api/query-runs/${run.id}?projectId=${secondProjectId}`);
    const shared = await readJson(`${base}/api/share/${run.id}?projectId=${secondProjectId}`);
    const otel = await readJson(`${base}/api/query-runs/${run.id}/otel?projectId=${secondProjectId}`);
    const bundle = await readJson(`${base}/api/query-runs/${run.id}/bundle?projectId=${secondProjectId}`);
    const feedback = await readJson(`${base}/api/query-runs/${run.id}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: secondProjectId,
        rating: 'up',
        note: 'Explicit project targeting worked.'
      })
    });
    const comparison = await readJson(`${base}/api/compare?left=${run.id}&right=${run.id}&projectId=${secondProjectId}`);
    const deletedEval = await readJson(`${base}/api/eval-questions/${evalCheck.id}?projectId=${secondProjectId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    const deletedDocument = await readJson(`${base}/api/documents/${indexed.document.id}?projectId=${secondProjectId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    const firstState = await readJson(`${base}/api/state`);
    const secondState = await readJson(`${base}/api/projects/active`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: secondProjectId })
    });

    assert.notEqual(firstProjectId, secondProjectId);
    assert.equal(indexed.document.projectId, secondProjectId);
    assert.equal(evalCheck.projectId, secondProjectId);
    assert.equal(secondSettings.topK, 2);
    assert.equal(secondSettings.maxClaims, 1);
    assert.equal(run.projectId, secondProjectId);
    assert.equal(run.config.topK, 2);
    assert.equal(run.config.maxClaims, 1);
    assert.equal(run.config.retrievalMode, 'keyword');
    assert.match(run.answer.text, /amber/i);
    assert.equal(run.evaluation.metrics.expectedAnswerAvailable, true);
    assert.equal(hydrated.id, run.id);
    assert.equal(shared.id, run.id);
    assert.ok(Array.isArray(otel.resourceSpans));
    assert.equal(otel.resourceSpans[0].resource.attributes.some((item) => item.key === 'raglens.project_id'), true);
    assert.equal(bundle.project.id, secondProjectId);
    assert.equal(feedback.rating, 'up');
    assert.equal(comparison.left.id, run.id);
    assert.equal(deletedEval.deleted, true);
    assert.equal(deletedDocument.deleted, true);
    assert.equal(firstState.activeProjectId, firstProjectId);
    assert.equal(firstState.settings.topK, initial.settings.topK);
    assert.equal(firstState.projects.some((project) => Object.hasOwn(project, 'settings')), false);
    assert.equal(firstState.runs.some((item) => item.id === run.id), false);
    assert.equal(secondState.settings.topK, 2);
    assert.equal(secondState.runs.some((item) => item.id === run.id), true);
  } finally {
    await fixture.close();
  }
});

test('non-loopback binding requires an admin token or explicit unsafe override', () => {
  const strongAdminToken = 'dev-token-with-at-least-thirty-two-characters';

  assert.throws(
    () =>
      loadConfig({
        RAGLENS_HOST: '0.0.0.0',
        RAGLENS_PORT: '0',
        RAGLENS_DATA_DIR: './data-test',
        RAGLENS_AUTO_SEED: 'false'
      }),
    /refuses to bind/
  );
  assert.throws(
    () =>
      loadConfig({
        RAGLENS_HOST: '0.0.0.0',
        RAGLENS_ADMIN_TOKEN: 'dev-token',
        RAGLENS_PORT: '0',
        RAGLENS_DATA_DIR: './data-test'
      }),
    /at least 32 characters/
  );

  assert.equal(
    loadConfig({
      RAGLENS_HOST: '0.0.0.0',
      RAGLENS_ADMIN_TOKEN: strongAdminToken,
      RAGLENS_PORT: '0',
      RAGLENS_DATA_DIR: './data-test'
    }).adminToken,
    strongAdminToken
  );
});

test('provider base URL rejects credentialed or tokenized URLs', () => {
  assert.throws(
    () =>
      loadConfig({
        RAGLENS_HOST: '127.0.0.1',
        RAGLENS_PORT: '0',
        RAGLENS_DATA_DIR: './data-test',
        RAGLENS_OPENAI_BASE_URL: 'https://user:pass@llm.example.test/v1?token=secret#frag'
      }),
    /without credentials/
  );
  assert.throws(
    () =>
      loadConfig({
        RAGLENS_HOST: '127.0.0.1',
        RAGLENS_PORT: '0',
        RAGLENS_DATA_DIR: './data-test',
        RAGLENS_OPENAI_BASE_URL: 'http://llm.example.test/v1'
      }),
    /HTTPS URL/
  );
  const localVllmConfig = loadConfig({
    RAGLENS_HOST: '127.0.0.1',
    RAGLENS_PORT: '0',
    RAGLENS_DATA_DIR: './data-test',
    RAGLENS_OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1'
  });
  assert.equal(
    localVllmConfig.openaiCompatible.baseUrl,
    'http://127.0.0.1:11434/v1'
  );
  assert.equal(localVllmConfig.openaiCompatible.configured, true);
  assert.equal(localVllmConfig.openaiCompatible.requiresApiKey, false);
  assert.equal(
    loadConfig({
      RAGLENS_HOST: '127.0.0.1',
      RAGLENS_PORT: '0',
      RAGLENS_DATA_DIR: './data-test',
      RAGLENS_OPENAI_BASE_URL: 'http://host.docker.internal:8000/v1'
    }).openaiCompatible.baseUrl,
    'http://host.docker.internal:8000/v1'
  );
  assert.equal(
    loadConfig({
      RAGLENS_HOST: '127.0.0.1',
      RAGLENS_PORT: '0',
      RAGLENS_DATA_DIR: './data-test',
      RAGLENS_OPENAI_BASE_URL: 'http://llm.example.test/v1',
      RAGLENS_ALLOW_UNSAFE_PROVIDER_HTTP: 'true'
    }).allowUnsafeProviderHttp,
    true
  );
  assert.throws(
    () =>
      loadConfig({
        RAGLENS_HOST: '127.0.0.1',
        RAGLENS_PORT: '0',
        RAGLENS_DATA_DIR: './data-test',
        RAGLENS_OTEL_EXPORT_URL: 'https://otel.example.test/v1/traces?token=secret'
      }),
    /OTEL_EXPORT_URL/
  );
  assert.throws(
    () =>
      loadConfig({
        RAGLENS_HOST: '127.0.0.1',
        RAGLENS_PORT: '0',
        RAGLENS_DATA_DIR: './data-test',
        RAGLENS_OTEL_EXPORT_URL: 'http://otel.example.test/v1/traces'
      }),
    /OTEL_EXPORT_URL/
  );
  assert.equal(
    loadConfig({
      RAGLENS_HOST: '127.0.0.1',
      RAGLENS_PORT: '0',
      RAGLENS_DATA_DIR: './data-test',
      RAGLENS_OTEL_EXPORT_URL: 'http://127.0.0.1:4318/v1/traces'
    }).otel.endpoint,
    'http://127.0.0.1:4318/v1/traces'
  );
  assert.equal(
    loadConfig({
      RAGLENS_HOST: '127.0.0.1',
      RAGLENS_PORT: '0',
      RAGLENS_DATA_DIR: './data-test',
      RAGLENS_STORAGE_DRIVER: 'postgres',
      RAGLENS_DATABASE_URL: 'postgres://raglens:secret@db.example.test/raglens',
      RAGLENS_DATABASE_SSL: 'true'
    }).postgres.ssl.rejectUnauthorized,
    true
  );
  assert.equal(
    loadConfig({
      RAGLENS_HOST: '127.0.0.1',
      RAGLENS_PORT: '0',
      RAGLENS_DATA_DIR: './data-test',
      RAGLENS_STORAGE_DRIVER: 'postgres',
      RAGLENS_DATABASE_URL: 'postgres://raglens:secret@db.example.test/raglens',
      RAGLENS_DATABASE_SSL: 'true',
      RAGLENS_ALLOW_INSECURE_DATABASE_SSL: 'true'
    }).postgres.ssl.rejectUnauthorized,
    false
  );
  assert.throws(
    () =>
      loadConfig({
        RAGLENS_HOST: '127.0.0.1',
        RAGLENS_PORT: '0',
        RAGLENS_DATA_DIR: './data-test',
        RAGLENS_PDF_TEXT_COMMAND: 'pdftotext'
      }),
    /absolute path/
  );
});

test('configured admin token is required for mutations', async () => {
  const fixture = await startFixtureServer({ adminToken: 'test-token' });

  try {
    const { base } = fixture;
    const health = await readJson(`${base}/api/health`);
    const unauthorizedState = await fetch(`${base}/api/state`);
    const wrongHeaderToken = await fetch(`${base}/api/state`, {
      headers: {
        'X-RAGLens-Token': 'test-token-suffix'
      }
    });
    const wrongBearerToken = await fetch(`${base}/api/state`, {
      headers: {
        Authorization: 'Bearer test-token-suffix'
      }
    });
    const unauthorized = await fetch(`${base}/api/query-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Will this run?' })
    });
    const authorizedState = await readJson(`${base}/api/state`, {
      headers: {
        'X-RAGLens-Token': 'test-token'
      }
    });
    const authorized = await readJson(`${base}/api/query-runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token'
      },
      body: JSON.stringify({ question: 'What caused the unsupported delivery estimates?' })
    });
    const unauthorizedShare = await fetch(`${base}/api/share/${authorized.id}`);
    const unauthorizedBundle = await fetch(`${base}/api/query-runs/${authorized.id}/bundle`);
    const authorizedShare = await readJson(`${base}/api/share/${authorized.id}`, {
      headers: {
        Authorization: 'Bearer test-token'
      }
    });
    const authorizedBundle = await readJson(`${base}/api/query-runs/${authorized.id}/bundle`, {
      headers: {
        Authorization: 'Bearer test-token'
      }
    });

    assert.equal(health.ok, true);
    assert.equal(unauthorizedState.status, 401);
    assert.equal(wrongHeaderToken.status, 401);
    assert.equal(wrongBearerToken.status, 401);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorizedShare.status, 401);
    assert.equal(unauthorizedBundle.status, 401);
    assert.ok(authorizedState.documents.length > 0);
    assert.ok(authorized.id.startsWith('run_'));
    assert.equal(authorizedShare.id, authorized.id);
    assert.equal(authorizedBundle.run.id, authorized.id);
  } finally {
    await fixture.close();
  }
});

test('provider, cost, and observability status are exposed without leaking secrets', async () => {
  let otlpExports = 0;
  const fixture = await startFixtureServer({
    openaiApiKey: 'provider-secret-token',
    openaiBaseUrl: 'https://llm.example.test/v1',
    inputUsdPer1MTokens: '0.5',
    outputUsdPer1MTokens: '1.5',
    otelEndpoint: 'https://otel.example.test/v1/traces',
    otelHeaders: '{"Authorization":"Bearer otel-secret"}',
    otelFetchImpl: async (_url, options) => {
      otlpExports += 1;
      assert.equal(options.headers.Authorization, 'Bearer otel-secret');
      const payload = JSON.parse(options.body);
      const attributes = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
      assert.equal(attributes.some((item) => item.key === 'raglens.question'), false);
      assert.equal(attributes.some((item) => item.key === 'raglens.question_hash'), false);
      assert.equal(attributes.some((item) => item.key === 'raglens.question_length'), false);
      return new Response('', { status: 202 });
    }
  });

  try {
    const state = await readJson(`${fixture.base}/api/state`, {
      headers: {
        'X-RAGLens-Token': fixture.adminToken
      }
    });

    assert.equal(state.providers.openaiCompatible.configured, true);
    assert.equal(state.providers.openaiCompatible.endpointHost, 'llm.example.test');
    assert.equal(Object.hasOwn(state.providers.openaiCompatible, 'baseUrl'), false);
    assert.equal(state.storage.driver, 'json');
    assert.equal(JSON.stringify(state).includes('postgres://'), false);
    assert.equal(state.providers.costRates.configured, true);
    assert.equal(state.providers.costRates.inputUsdPer1MTokens, 0.5);
    assert.equal(state.providers.costRates.outputUsdPer1MTokens, 1.5);
    assert.equal(state.observability.otlp.configured, true);
    assert.equal(state.observability.otlp.endpointHost, 'otel.example.test');
    assert.equal(state.observability.otlp.headerCount, 1);
    assert.equal(state.parsers.pdf.externalConfigured, false);
    assert.equal(state.parsers.pdf.mode, 'internal-fallback');
    assert.equal(JSON.stringify(state).includes('provider-secret-token'), false);
    assert.equal(JSON.stringify(state).includes('/v1'), false);
    assert.equal(JSON.stringify(state).includes('otel-secret'), false);

    const run = await readJson(`${fixture.base}/api/query-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What caused the unsupported delivery estimates?' })
    });

    assert.equal(otlpExports, 1);
    assert.equal(run.observability.otelExport.ok, true);
    assert.equal(run.observability.otelExport.endpointHost, 'otel.example.test');
    assert.equal(JSON.stringify(run.observability).includes('otel-secret'), false);
  } finally {
    await fixture.close();
  }
});

test('PDF parser status is exposed without leaking command details', async () => {
  const fixture = await startFixtureServer({
    pdfTextCommand: 'C:\\sensitive-tools\\pdftotext.exe',
    pdfTextArgs: '["-layout","{input}","-"]'
  });

  try {
    const state = await readJson(`${fixture.base}/api/state`);

    assert.equal(state.parsers.pdf.externalConfigured, true);
    assert.equal(state.parsers.pdf.mode, 'external-command-with-internal-fallback');
    assert.equal(JSON.stringify(state).includes('sensitive-tools'), false);
    assert.equal(JSON.stringify(state).includes('pdftotext.exe'), false);
  } finally {
    await fixture.close();
  }
});

test('PDF uploads reject invalid magic bytes and oversized decoded files', async () => {
  const fixture = await startFixtureServer();

  try {
    const { base } = fixture;
    const invalid = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Invalid PDF',
        sourceType: 'pdf',
        text: 'placeholder',
        base64: Buffer.from('not a pdf').toString('base64')
      })
    });
    const tooLargeBuffer = Buffer.concat([
      Buffer.from('%PDF-1.4\n', 'latin1'),
      Buffer.alloc(1_000_001, 65)
    ]);
    const tooLarge = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Huge PDF',
        sourceType: 'pdf',
        text: 'placeholder',
        base64: tooLargeBuffer.toString('base64')
      })
    });

    assert.equal(invalid.status, 400);
    assert.equal(tooLarge.status, 413);
  } finally {
    await fixture.close();
  }
});

async function readJson(url, options) {
  const response = await fetch(url, options);
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return response.json();
}

async function requestWithHost(base, options = {}) {
  const url = new URL(base);
  const body = options.body || '';

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        method: options.method || 'GET',
        path: options.path || '/',
        headers: options.headers || {}
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );

    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

async function waitForJson(url, predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const payload = await readJson(url);
    if (predicate(payload)) {
      return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function startFixtureServer(options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'raglens-test-'));
  const config = loadConfig({
    RAGLENS_HOST: '127.0.0.1',
    RAGLENS_PORT: '0',
    RAGLENS_DATA_DIR: dataDir,
    RAGLENS_AUTO_SEED: 'true',
    RAGLENS_ADMIN_TOKEN: options.adminToken || '',
    RAGLENS_OPENAI_API_KEY: options.openaiApiKey || '',
    RAGLENS_OPENAI_BASE_URL: options.openaiBaseUrl || 'https://api.openai.com/v1',
    RAGLENS_COST_INPUT_USD_PER_1M: options.inputUsdPer1MTokens || '0',
    RAGLENS_COST_OUTPUT_USD_PER_1M: options.outputUsdPer1MTokens || '0',
    RAGLENS_OTEL_EXPORT_URL: options.otelEndpoint || '',
    RAGLENS_OTEL_HEADERS: options.otelHeaders || '',
    RAGLENS_PDF_TEXT_COMMAND: options.pdfTextCommand || '',
    RAGLENS_PDF_TEXT_ARGS: options.pdfTextArgs || ''
  });
  if (options.otelFetchImpl) {
    config.otel.fetchImpl = options.otelFetchImpl;
  }
  const store = new RaglensStore(config);
  await store.resetDemo();

  const server = createServer({ config, store });
  await new Promise((resolve) => server.listen(0, config.host, resolve));
  const address = server.address();

  return {
    base: `http://${address.address}:${address.port}`,
    adminToken: options.adminToken || '',
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
