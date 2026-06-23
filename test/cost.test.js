import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateRunCost } from '../src/rag/cost.js';

test('estimateRunCost treats local mode as free', () => {
  const cost = estimateRunCost({
    provider: 'local',
    mode: 'local-grounded-extractive',
    inputTokens: 10_000,
    outputTokens: 5_000,
    costRates: {
      inputUsdPer1MTokens: 100,
      outputUsdPer1MTokens: 100
    }
  });

  assert.equal(cost.estimatedCostUsd, 0);
  assert.equal(cost.configured, true);
  assert.equal(cost.source, 'local-free');
});

test('estimateRunCost calculates provider cost from configured rates', () => {
  const cost = estimateRunCost({
    provider: 'openai-compatible',
    mode: 'openai-compatible-chat',
    inputTokens: 111,
    outputTokens: 17,
    costRates: {
      inputUsdPer1MTokens: 0.5,
      outputUsdPer1MTokens: 1.5
    }
  });

  assert.equal(cost.estimatedCostUsd, 0.000081);
  assert.equal(cost.inputUsd, 0.0000555);
  assert.equal(cost.outputUsd, 0.0000255);
  assert.equal(cost.source, 'configured-rates');
});

test('estimateRunCost marks provider costs unconfigured when rates are missing', () => {
  const cost = estimateRunCost({
    provider: 'openai-compatible',
    mode: 'openai-compatible-chat',
    inputTokens: 111,
    outputTokens: 17
  });

  assert.equal(cost.estimatedCostUsd, 0);
  assert.equal(cost.configured, false);
  assert.equal(cost.source, 'rates-not-configured');
});
