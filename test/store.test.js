import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeState } from '../src/services/store.js';

test('normalizeState migrates legacy top-level settings into per-project settings', () => {
  const state = normalizeState({
    version: 1,
    activeProjectId: 'prj_bbbbbbbbbbbb',
    projects: [
      {
        id: 'prj_aaaaaaaaaaaa',
        name: 'Legacy Project',
        description: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'prj_bbbbbbbbbbbb',
        name: 'Configured Project',
        description: '',
        settings: {
          topK: 2,
          retrievalMode: 'keyword'
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ],
    settings: {
      topK: 8,
      chunkTokens: 500,
      promptTemplate: 'Answer from retrieved evidence.'
    },
    documents: [],
    chunks: [],
    runs: [],
    evalQuestions: []
  });

  const legacyProject = state.projects.find((project) => project.id === 'prj_aaaaaaaaaaaa');
  const configuredProject = state.projects.find((project) => project.id === 'prj_bbbbbbbbbbbb');

  assert.equal(legacyProject.settings.topK, 8);
  assert.equal(legacyProject.settings.chunkTokens, 500);
  assert.equal(configuredProject.settings.topK, 2);
  assert.equal(configuredProject.settings.chunkTokens, 500);
  assert.equal(configuredProject.settings.retrievalMode, 'keyword');
  assert.equal(state.settings.topK, 2);
  assert.equal(state.settings.retrievalMode, 'keyword');
});
