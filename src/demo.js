import { createDocument, chunkDocument } from './rag/chunker.js';
import { id } from './lib/id.js';
import { nowIso } from './lib/time.js';

const DEMO_DOCS = [
  {
    title: 'SupportBot RAG Runbook',
    sourceType: 'markdown',
    text: `# SupportBot RAG Runbook

SupportBot answers customer questions using a retrieval augmented generation pipeline. The retriever searches product manuals, incident notes, and policy documents before the model writes a response.

## Retrieval settings

The production retriever uses hybrid search with both keyword and vector similarity. The default top-k is six chunks. Chunks are around 500 tokens with a 75 token overlap. For technical troubleshooting, engineers may increase top-k to ten, but this can add duplicated context and raise latency.

## Grounding policy

Answers must cite the source document for any product limit, pricing rule, incident status, or support promise. If the retrieved context does not contain enough evidence, the assistant must say that the answer is not available from the indexed sources.

## Known failure modes

The most common RAG failure is retrieval miss: the right document exists, but no relevant chunk appears in the top results. The second most common failure is stale context, where an old policy chunk outranks the current policy. The third failure is answer drift, where the model adds a plausible detail that was not present in any retrieved chunk.`
  },
  {
    title: 'Incident Review 2026-05-14',
    sourceType: 'markdown',
    text: `# Incident Review 2026-05-14

On 2026-05-14, SupportBot produced unsupported delivery estimates for enterprise customers. The root cause was a stale logistics policy document that remained in the vector index after a policy migration.

## Impact

Thirty-seven conversations included a delivery estimate that could not be verified against current policy. No customer data was exposed. Support agents corrected affected conversations manually.

## Corrective actions

The team added document checksums during ingestion, a daily stale-document report, and a citation coverage gate. Any answer with less than 80 percent citation coverage is now routed to manual review. The RAG evaluation set also gained twelve regression questions about delivery policy.

## Lessons learned

Trace visibility shortened the investigation. Engineers compared the failed run with a run against the new index and immediately saw that the stale chunk had a higher retrieval score than the current policy chunk.`
  },
  {
    title: 'RAG Security Notes',
    sourceType: 'markdown',
    text: `# RAG Security Notes

RAG systems can be attacked through malicious documents as well as direct user prompts. A document may contain instructions such as ignore previous instructions or reveal the system prompt. Retrieved text should be treated as untrusted data, not as an instruction layer.

## Controls

The application should separate retrieved context from system instructions. It should also scan retrieved chunks for prompt injection patterns, redact secrets before logging, and avoid granting tools directly from document text. For agentic workflows, dangerous actions need explicit approval.

## Review checklist

Engineers should verify that source documents are current, chunks preserve section titles, retrieved context is displayed in traces, and unsupported claims are visible to reviewers.`
  },
  {
    title: 'Evaluation Playbook',
    sourceType: 'markdown',
    text: `# Evaluation Playbook

A useful RAG evaluation separates retrieval quality from answer quality. Retrieval metrics include precision at k, recall at k, mean reciprocal rank, duplicate rate, and latency. Answer metrics include faithfulness, citation coverage, answer relevance, and unsupported claim count.

## Regression workflow

Every prompt or indexing change should be tested against saved questions. Engineers should compare the new run with the previous baseline and inspect any drop in retrieval confidence, faithfulness, or citation coverage.

## Healthy thresholds

For support use cases, faithfulness should stay above 0.85 and citation coverage should stay above 0.80. Retrieval confidence below 0.35 should trigger manual inspection because it often means the query wording does not match the available chunks.`
  }
];

export function createDemoState() {
  const project = {
    id: id('prj'),
    name: 'Demo RAG workspace',
    description: 'A local-first sample dataset for inspecting retrieval failures, grounding, and citations.',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  const documents = DEMO_DOCS.map((doc) => createDocument({ ...doc, projectId: project.id }));
  const chunks = documents.flatMap((document) =>
    chunkDocument(document, {
      maxTokens: 95,
      overlapTokens: 18
    })
  );

  return {
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    activeProjectId: project.id,
    projects: [project],
    documents,
    chunks,
    runs: [],
    evalQuestions: [
      {
        id: id('eval'),
        projectId: project.id,
        question: 'What caused the May 2026 unsupported delivery estimates?',
        expectedSource: 'Incident Review 2026-05-14',
        expectedAnswer: 'The root cause was a stale logistics policy document that remained in the vector index after a policy migration.'
      },
      {
        id: id('eval'),
        projectId: project.id,
        question: 'What should happen if citation coverage drops below 80 percent?',
        expectedSource: 'Incident Review 2026-05-14',
        expectedAnswer: 'Any answer with less than 80 percent citation coverage is routed to manual review.'
      },
      {
        id: id('eval'),
        projectId: project.id,
        question: 'How should retrieved text be treated when it contains instructions?',
        expectedSource: 'RAG Security Notes',
        expectedAnswer: 'Retrieved text should be treated as untrusted data, not as an instruction layer.'
      }
    ],
    settings: {
      topK: 6,
      maxClaims: 4,
      chunkTokens: 120,
      overlapTokens: 24,
      temperature: 0,
      provider: 'local',
      model: 'local-extractive-v1',
      retrievalMode: 'hybrid',
      promptTemplate: 'Answer using only the retrieved context. Cite every factual claim with the source label.',
      promptLoggingEnabled: false,
      redactionEnabled: true,
      rerank: true
    }
  };
}
