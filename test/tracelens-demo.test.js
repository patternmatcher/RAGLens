import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTraceLensDemoScenario } from '../src/integration/tracelens-demo.js';

test('TraceLens demo scenario produces a real stale-source retrieval regression', async () => {
  const scenario = await buildTraceLensDemoScenario();

  assert.equal(scenario.baseline.metrics.recallAtK, 1);
  assert.equal(scenario.candidate.metrics.recallAtK, 0);
  assert.equal(scenario.baseline.topSource, 'Incident Review 2026-05-14');
  assert.equal(scenario.candidate.topSource, 'Legacy Incident Summary');
  assert.ok(scenario.baseline.metrics.faithfulness >= 0.8);
  assert.equal(scenario.baseline.otlp.resourceSpans.length, 1);
  assert.equal(scenario.candidate.otlp.resourceSpans.length, 1);
});
