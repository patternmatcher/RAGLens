export function estimateRunCost({ provider, mode, inputTokens, outputTokens, costRates = {} }) {
  const localMode = String(provider || '').toLowerCase() === 'local' || String(mode || '').startsWith('local-');
  if (localMode) {
    return {
      estimatedCostUsd: 0,
      configured: true,
      source: 'local-free',
      inputUsd: 0,
      outputUsd: 0,
      inputUsdPer1MTokens: 0,
      outputUsdPer1MTokens: 0
    };
  }

  const inputRate = Number(costRates.inputUsdPer1MTokens || 0);
  const outputRate = Number(costRates.outputUsdPer1MTokens || 0);
  const configured = inputRate > 0 || outputRate > 0;

  if (!configured) {
    return {
      estimatedCostUsd: 0,
      configured: false,
      source: 'rates-not-configured',
      inputUsd: 0,
      outputUsd: 0,
      inputUsdPer1MTokens: 0,
      outputUsdPer1MTokens: 0
    };
  }

  const inputUsd = (Number(inputTokens || 0) * inputRate) / 1_000_000;
  const outputUsd = (Number(outputTokens || 0) * outputRate) / 1_000_000;

  return {
    estimatedCostUsd: roundUsd(inputUsd + outputUsd),
    configured: true,
    source: 'configured-rates',
    inputUsd: roundUsd(inputUsd),
    outputUsd: roundUsd(outputUsd),
    inputUsdPer1MTokens: inputRate,
    outputUsdPer1MTokens: outputRate
  };
}

function roundUsd(value) {
  return Number(Number(value || 0).toFixed(8));
}
