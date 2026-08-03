import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoState } from '../src/demo.js';
import { postgresStatements } from '../src/services/postgres-statements.js';

test('postgresStatements expose project-scoped runtime adapter queries', () => {
  const demo = createDemoState();
  const projectId = demo.activeProjectId;
  const document = demo.documents[0];
  const chunk = demo.chunks[0];
  const evalQuestion = demo.evalQuestions[0];

  const statements = [
    postgresStatements.listProjects(),
    postgresStatements.loadProjectState(projectId),
    postgresStatements.assertSchema(),
    postgresStatements.insertProject({ ...demo.projects[0], settings: demo.settings }),
    postgresStatements.updateProjectSettings(projectId, demo.settings, demo.updatedAt),
    postgresStatements.deleteProjectsNotIn([projectId]),
    postgresStatements.deleteStaleDocuments(projectId, [document.id]),
    postgresStatements.deleteStaleQueryRuns(projectId, ['run_aaaaaaaaaaaa']),
    postgresStatements.deleteStaleEvalQuestions(projectId, [evalQuestion.id]),
    postgresStatements.deleteStaleFeedback(projectId, ['fbk_aaaaaaaaaaaa']),
    postgresStatements.insertDocument(document),
    postgresStatements.insertChunk(chunk),
    postgresStatements.searchChunksByVector(projectId, ['delivery', 'estimate'], chunk.embedding, {
      topK: 8,
      retrievalMode: 'hybrid',
      rerank: true
    }),
    postgresStatements.deleteDocument(projectId, document.id),
    postgresStatements.listRuns(projectId),
    postgresStatements.getRun(projectId, 'run_aaaaaaaaaaaa'),
    postgresStatements.getRunsForCompare(projectId, 'run_aaaaaaaaaaaa', 'run_bbbbbbbbbbbb'),
    postgresStatements.findExpectedSource(projectId, evalQuestion.question),
    postgresStatements.upsertEvalQuestion({ ...evalQuestion, createdAt: demo.createdAt, updatedAt: demo.updatedAt }),
    postgresStatements.deleteEvalQuestion(projectId, evalQuestion.id),
    postgresStatements.insertFeedback(projectId, 'run_aaaaaaaaaaaa', {
      id: 'fbk_aaaaaaaaaaaa',
      rating: 'down',
      note: 'Needs review.',
      expectedAnswer: 'Expected answer.',
      createdAt: demo.createdAt
    })
  ];

  for (const item of statements) {
    assert.equal(typeof item.text, 'string');
    assert.ok(Array.isArray(item.values));
    assert.doesNotMatch(item.text, /undefined|NaN/);
  }

  assert.match(postgresStatements.loadProjectState(projectId).text, /WHERE p\.id = \$1/);
  assert.match(postgresStatements.loadProjectState(projectId).text, /raglens_feedback/);
  assert.match(postgresStatements.assertSchema().text, /to_regclass\('raglens_projects'\)/);
  assert.match(postgresStatements.deleteProjectsNotIn([projectId]).text, /DELETE FROM raglens_projects/);
  assert.match(postgresStatements.deleteDocument(projectId, document.id).text, /WHERE project_id = \$1 AND id = \$2/);
  assert.match(postgresStatements.insertChunk(chunk).text, /\$20::vector/);
  assert.match(postgresStatements.searchChunksByVector(projectId, ['delivery'], chunk.embedding).text, /embedding::vector\(64\) <=> q\.embedding/);
  assert.match(postgresStatements.searchChunksByVector(projectId, ['delivery'], chunk.embedding).text, /embedding_model = \$7/);
  assert.match(postgresStatements.searchChunksByVector(projectId, ['delivery'], chunk.embedding).text, /\$9::jsonb AS filter/);
  assert.match(postgresStatements.searchChunksByVector(projectId, ['delivery'], chunk.embedding).text, /ORDER BY "rerankScore" DESC/);
  assert.match(postgresStatements.searchChunksByVector(projectId, ['delivery'], chunk.embedding).text, /LIMIT \$6/);
  assert.match(postgresStatements.insertQueryRun(fakeRun(demo)).text, /evidence_snapshot/);
  assert.match(postgresStatements.upsertEvalQuestion({ ...evalQuestion, createdAt: demo.createdAt }).text, /ON CONFLICT \(project_id, lower\(question\)\)/);

  const vectorValue = postgresStatements.insertChunk({
    ...chunk,
    embedding: [1, Number.NaN, '2']
  }).values[19];
  const vectorItems = vectorValue.slice(1, -1).split(',');
  assert.equal(vectorItems.length, 3);
  assert.equal(vectorItems[0], '1');
  assert.equal(vectorItems[1], '0');
  assert.equal(vectorItems[2], '2');
  assert.doesNotMatch(vectorValue, /NaN|undefined/);

  const searchStatement = postgresStatements.searchChunksByVector(projectId, ['delivery', null, 'estimate'], [1, Number.NaN], {
    topK: 99,
    retrievalMode: 'nonsense'
  });
  assert.equal(searchStatement.values[0], projectId);
  assert.deepEqual(searchStatement.values[1], ['delivery', 'estimate']);
  assert.equal(searchStatement.values[3], 'hybrid');
  assert.equal(searchStatement.values[5], 80);
  assert.equal(searchStatement.values[2].slice(1, -1).split(',').length, 2);
  assert.equal(searchStatement.values[7], 2);
  assert.equal(searchStatement.values[8], '{}');
});

test('postgresStatements use parameter arrays for untrusted values', () => {
  const maliciousTitle = "Robert'); DROP TABLE raglens_documents; --";
  const statement = postgresStatements.insertDocument({
    id: 'doc_aaaaaaaaaaaa',
    projectId: 'prj_aaaaaaaaaaaa',
    title: maliciousTitle,
    sourceType: 'text',
    text: maliciousTitle,
    checksum: 'abc',
    wordCount: 4,
    status: 'indexed',
    metadata: {},
    createdAt: '2026-06-23T00:00:00.000Z',
    updatedAt: '2026-06-23T00:00:00.000Z'
  });

  assert.equal(statement.text.includes(maliciousTitle), false);
  assert.equal(statement.values.includes(maliciousTitle), true);
});

function fakeRun(demo) {
  return {
    id: 'run_aaaaaaaaaaaa',
    projectId: demo.activeProjectId,
    question: 'What caused the unsupported delivery estimates?',
    config: {},
    query: {},
    queryTerms: [],
    retrieved: [],
    answer: {},
    evaluation: {},
    prompt: null,
    warnings: [],
    trace: [],
    usage: {},
    redactions: [],
    evidenceSnapshot: { documents: [], chunks: [] },
    observability: {},
    latencyMs: 12,
    createdAt: demo.createdAt
  };
}
