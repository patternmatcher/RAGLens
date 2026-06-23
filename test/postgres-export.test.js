import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoState } from '../src/demo.js';
import { exportStateToPostgresSql } from '../scripts/postgres-export.js';

test('exportStateToPostgresSql emits idempotent pgvector seed SQL for demo state', () => {
  const sql = exportStateToPostgresSql(createDemoState());

  assert.match(sql, /BEGIN;/);
  assert.match(sql, /COMMIT;/);
  assert.match(sql, /INSERT INTO raglens_projects/);
  assert.match(sql, /INSERT INTO raglens_documents/);
  assert.match(sql, /INSERT INTO raglens_chunks/);
  assert.match(sql, /INSERT INTO raglens_eval_questions/);
  assert.match(sql, /ON CONFLICT DO NOTHING;/);
  assert.match(sql, /::jsonb/);
  assert.match(sql, /::vector/);
  assert.match(sql, /\[[-0-9.,]+\]'::vector/);
  assert.doesNotMatch(sql, /undefined/);
  assert.doesNotMatch(sql, /NaN/);
});

test('exportStateToPostgresSql preserves non-active project settings', () => {
  const demo = createDemoState();
  const otherProject = {
    id: 'prj_aaaaaaaaaaaa',
    name: 'Other Project',
    description: 'Has its own settings.',
    settings: {
      topK: 2,
      retrievalMode: 'keyword',
      promptTemplate: 'Other project prompt.'
    },
    createdAt: demo.createdAt,
    updatedAt: demo.updatedAt
  };
  const sql = exportStateToPostgresSql({
    ...demo,
    projects: [...demo.projects, otherProject]
  });

  assert.match(sql, /Other Project/);
  assert.match(sql, /Other project prompt/);
  assert.match(sql, /"retrievalMode":"keyword"/);
});
