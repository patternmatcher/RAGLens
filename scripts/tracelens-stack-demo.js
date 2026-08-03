import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { buildTraceLensDemoScenario } from '../src/integration/tracelens-demo.js';

const options = parseArgs(process.argv.slice(2));
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const traceLensDir = path.resolve(rootDir, options.traceLensDir);
const outputDir = path.resolve(rootDir, options.outputDir);
const traceLensCli = path.join(traceLensDir, 'src', 'cli.js');
const policyFile = path.join(traceLensDir, 'policies', 'raglens-local-demo.json');

await access(traceLensCli).catch(() => {
  throw new Error(`TraceLens was not found at ${traceLensDir}. Pass --tracelens-dir=<path>.`);
});
await mkdir(outputDir, { recursive: true });

const scenario = await buildTraceLensDemoScenario();
const files = fileMap(outputDir);
await writeJson(files.baselineOtlp, scenario.baseline.otlp);
await writeJson(files.candidateOtlp, scenario.candidate.otlp);
await writeJson(files.baselineRagTrace, scenario.baseline.ragTrace);
await writeJson(files.candidateRagTrace, scenario.candidate.ragTrace);

await traceLens('import-rag-trace', files.baselineRagTrace, '--out', files.baselineTrace);
await traceLens('import-rag-trace', files.candidateRagTrace, '--out', files.candidateTrace);
await traceLens('gate', files.baselineTrace, '--policy', policyFile, '--out', files.baselineGate);
await traceLens('gate', files.candidateTrace, '--policy', policyFile, '--out', files.candidateGate, { expectedStatus: 1 });
await traceLens('replay-report', files.baselineTrace, files.candidateTrace, '--out', files.replay, '--markdown', files.replayMarkdown, '--allow-regressions');
await traceLens('evidence-report', files.baselineTrace, files.candidateTrace, '--out', files.evidence, '--markdown', files.evidenceMarkdown, '--allow-evidence-gaps');
await traceLens('review-workflow', files.candidateTrace, files.replay, files.evidence, '--routing', path.join(traceLensDir, 'routing', 'enterprise-open-weights.json'), '--out', files.workflow, '--markdown', files.workflowMarkdown, '--allow-open');
await traceLens('root-cause-report', files.workflow, '--out', files.rootCause, '--markdown', files.rootCauseMarkdown, '--allow-findings');
await traceLens('bundle-review', files.baselineTrace, files.candidateTrace, '--report', files.replay, '--report', files.evidence, '--report', files.workflow, '--report', files.rootCause, '--redaction-profile', 'safe-export', '--out-dir', files.bundleDir, '--name', 'raglens-stack-release-review');
await traceLens('verify-review-bundle', files.bundleDir, '--out', files.verification, '--markdown', files.verificationMarkdown);

const baselineTrace = await readJson(files.baselineTrace);
const candidateTrace = await readJson(files.candidateTrace);
const { buildReleaseDecision } = await import(pathToFileURL(path.join(traceLensDir, 'src', 'shared', 'release-decision.js')));
const policy = await readJson(policyFile);
const decision = buildReleaseDecision(baselineTrace, candidateTrace, policy);
await writeJson(files.decision, decision);
await writeFile(files.summary, renderSummary(scenario, decision, files), 'utf8');

console.log(`TraceLens stack demo complete: ${files.summary}`);

async function traceLens(...values) {
  const commandOptions = typeof values.at(-1) === 'object' ? values.pop() : {};
  const expectedStatus = commandOptions.expectedStatus ?? 0;
  const result = await run(process.execPath, [traceLensCli, ...values], traceLensDir);
  if (result.status !== expectedStatus) {
    throw new Error(`TraceLens ${values[0]} exited ${result.status}. ${result.stderr || result.stdout}`.trim());
  }
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function fileMap(directory) {
  return Object.fromEntries(Object.entries({
    baselineOtlp: 'baseline.raglens-otlp.json',
    candidateOtlp: 'candidate.raglens-otlp.json',
    baselineRagTrace: 'baseline.rag-trace-v2.json',
    candidateRagTrace: 'candidate.rag-trace-v2.json',
    baselineTrace: 'baseline.tracelens.json',
    candidateTrace: 'candidate.tracelens.json',
    baselineGate: 'baseline.gate.json',
    candidateGate: 'candidate.gate.json',
    replay: 'replay-report.json',
    replayMarkdown: 'replay-report.md',
    evidence: 'evidence-report.json',
    evidenceMarkdown: 'evidence-report.md',
    workflow: 'review-workflow.json',
    workflowMarkdown: 'review-workflow.md',
    rootCause: 'root-cause-report.json',
    rootCauseMarkdown: 'root-cause-report.md',
    bundleDir: 'review-bundle',
    verification: 'bundle-verification.json',
    verificationMarkdown: 'bundle-verification.md',
    decision: 'release-decision.json',
    summary: 'README.md'
  }).map(([key, file]) => [key, path.join(directory, file)]));
}

function renderSummary(scenario, decision, files) {
  return `# RAGLens To TraceLens Stack Demo

This demonstration runs the RAGLens document and query pipeline twice, imports the versioned staged RAG traces into TraceLens, and uses TraceLens to make a release decision. Generic OTLP exports are written beside the RAG traces for comparison.

## Scenario

- Question: ${scenario.question}
- Corpus: ${scenario.corpus.documents} documents and ${scenario.corpus.chunks} chunks
- Baseline: hybrid retrieval, reranking enabled, top-k 4
- Candidate: a stale legacy document is present, reranking is disabled, top-k 1

The candidate answer is grounded in the chunk it retrieved, but it retrieved the wrong source. This is why answer-only grounding is not enough for a release gate.

## Result

- Decision: ${decision.decision.toUpperCase()}
- Baseline source: ${scenario.baseline.topSource}
- Candidate source: ${scenario.candidate.topSource}
- Retrieval recall: ${scenario.baseline.metrics.recallAtK} -> ${scenario.candidate.metrics.recallAtK}
- Groundedness: ${scenario.baseline.metrics.faithfulness} -> ${scenario.candidate.metrics.faithfulness}
- Citation coverage: ${scenario.baseline.metrics.citationCoverage} -> ${scenario.candidate.metrics.citationCoverage}
- Release blockers: ${decision.blockers.length}

## Artifacts

- Baseline TraceLens trace: ${path.basename(files.baselineTrace)}
- Candidate TraceLens trace: ${path.basename(files.candidateTrace)}
- Baseline RAG transport trace: ${path.basename(files.baselineRagTrace)}
- Candidate RAG transport trace: ${path.basename(files.candidateRagTrace)}
- Replay report: ${path.basename(files.replayMarkdown)}
- Evidence report: ${path.basename(files.evidenceMarkdown)}
- Review workflow: ${path.basename(files.workflowMarkdown)}
- Root cause report: ${path.basename(files.rootCauseMarkdown)}
- Verified redacted review bundle: ${path.basename(files.bundleDir)}/

All artifacts in this directory are generated and can be removed safely.
`;
}

function parseArgs(args) {
  const options = {
    traceLensDir: '../tracelens',
    outputDir: 'corpora/results/tracelens-stack-demo'
  };
  for (const arg of args) {
    if (arg.startsWith('--tracelens-dir=')) options.traceLensDir = arg.slice('--tracelens-dir='.length);
    else if (arg.startsWith('--out-dir=')) options.outputDir = arg.slice('--out-dir='.length);
  }
  return options;
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}
