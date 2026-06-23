import { EMBEDDING_DIMENSIONS } from '../rag/embedding.js';

export const postgresStatements = {
  listProjects() {
    return statement(`
      SELECT id, name, description, owner_id AS "ownerId", settings, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM raglens_projects
      ORDER BY updated_at DESC
    `);
  },

  loadProjectState(projectId) {
    return statement(
      `
        SELECT
          p.id,
          p.name,
          p.description,
          p.owner_id AS "ownerId",
          p.settings,
          p.created_at AS "createdAt",
          p.updated_at AS "updatedAt",
          COALESCE(documents.items, '[]'::jsonb) AS documents,
          COALESCE(chunks.items, '[]'::jsonb) AS chunks,
          COALESCE(runs.items, '[]'::jsonb) AS runs,
          COALESCE(eval_questions.items, '[]'::jsonb) AS "evalQuestions"
        FROM raglens_projects p
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at DESC) AS items
          FROM raglens_documents d
          WHERE d.project_id = p.id
        ) documents ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(to_jsonb(c) ORDER BY c.document_id, c.chunk_index) AS items
          FROM raglens_chunks c
          WHERE c.project_id = p.id
        ) chunks ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            to_jsonb(r) || jsonb_build_object('feedback', COALESCE(feedback.items, '[]'::jsonb))
            ORDER BY r.created_at DESC
          ) AS items
          FROM raglens_query_runs r
          LEFT JOIN LATERAL (
            SELECT jsonb_agg(to_jsonb(f) ORDER BY f.created_at DESC) AS items
            FROM raglens_feedback f
            WHERE f.run_id = r.id AND f.project_id = p.id
          ) feedback ON true
          WHERE r.project_id = p.id
        ) runs ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(to_jsonb(e) ORDER BY e.updated_at DESC) AS items
          FROM raglens_eval_questions e
          WHERE e.project_id = p.id
        ) eval_questions ON true
        WHERE p.id = $1
      `,
      [projectId]
    );
  },

  assertSchema() {
    return statement(`
      SELECT
        to_regclass('raglens_projects') AS projects,
        to_regclass('raglens_documents') AS documents,
        to_regclass('raglens_chunks') AS chunks,
        to_regclass('raglens_query_runs') AS runs,
        to_regclass('raglens_eval_questions') AS eval_questions
    `);
  },

  insertProject(project) {
    return statement(
      `
        INSERT INTO raglens_projects (id, name, description, owner_id, settings, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7::timestamptz)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          settings = EXCLUDED.settings,
          updated_at = EXCLUDED.updated_at
      `,
      [
        project.id,
        project.name,
        project.description || '',
        project.ownerId || null,
        json(project.settings || {}),
        project.createdAt,
        project.updatedAt || project.createdAt
      ]
    );
  },

  updateProjectSettings(projectId, settings, updatedAt) {
    return statement(
      `
        UPDATE raglens_projects
        SET settings = $2::jsonb, updated_at = $3::timestamptz
        WHERE id = $1
      `,
      [projectId, json(settings || {}), updatedAt]
    );
  },

  deleteProjectsNotIn(projectIds) {
    return statement(
      `
        DELETE FROM raglens_projects
        WHERE NOT (id = ANY($1::text[]))
      `,
      [projectIds]
    );
  },

  deleteStaleDocuments(projectId, documentIds) {
    return statement(
      `
        DELETE FROM raglens_documents
        WHERE project_id = $1 AND NOT (id = ANY($2::text[]))
      `,
      [projectId, documentIds]
    );
  },

  deleteStaleQueryRuns(projectId, runIds) {
    return statement(
      `
        DELETE FROM raglens_query_runs
        WHERE project_id = $1 AND NOT (id = ANY($2::text[]))
      `,
      [projectId, runIds]
    );
  },

  deleteStaleEvalQuestions(projectId, evalQuestionIds) {
    return statement(
      `
        DELETE FROM raglens_eval_questions
        WHERE project_id = $1 AND NOT (id = ANY($2::text[]))
      `,
      [projectId, evalQuestionIds]
    );
  },

  deleteStaleFeedback(projectId, feedbackIds) {
    return statement(
      `
        DELETE FROM raglens_feedback
        WHERE project_id = $1 AND NOT (id = ANY($2::text[]))
      `,
      [projectId, feedbackIds]
    );
  },

  insertDocument(document) {
    return statement(
      `
        INSERT INTO raglens_documents (
          id, project_id, title, source_type, text, checksum, word_count, status, metadata, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz, $11::timestamptz)
        ON CONFLICT (id) DO NOTHING
      `,
      [
        document.id,
        document.projectId,
        document.title,
        document.sourceType,
        document.text,
        document.checksum,
        number(document.wordCount),
        document.status || 'indexed',
        json(document.metadata || {}),
        document.createdAt,
        document.updatedAt || document.createdAt
      ]
    );
  },

  insertChunk(chunk) {
    return statement(
      `
        INSERT INTO raglens_chunks (
          id, project_id, document_id, document_title, chunk_index, label, heading, section, page,
          text, token_count, terms, term_counts, embedding, embedding_model, embedded_at, created_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12::jsonb, $13::jsonb, $14::vector, $15, $16::timestamptz, $17::timestamptz
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        chunk.id,
        chunk.projectId,
        chunk.documentId,
        chunk.documentTitle,
        number(chunk.index),
        chunk.label,
        chunk.heading || chunk.section || 'Untitled section',
        chunk.section || chunk.heading || 'Untitled section',
        nullableNumber(chunk.page),
        chunk.text,
        number(chunk.tokenCount),
        json(chunk.terms || []),
        json(chunk.termCounts || {}),
        vector(chunk.embedding),
        chunk.embeddingModel || 'local-hash-embedding-v1',
        chunk.embeddedAt,
        chunk.createdAt || chunk.embeddedAt
      ]
    );
  },

  deleteDocument(projectId, documentId) {
    return statement(
      `
        DELETE FROM raglens_documents
        WHERE project_id = $1 AND id = $2
      `,
      [projectId, documentId]
    );
  },

  insertQueryRun(run) {
    return statement(
      `
        INSERT INTO raglens_query_runs (
          id, project_id, question, config, query, query_terms, retrieved, answer, evaluation, prompt,
          warnings, trace, usage, redactions, evidence_snapshot, observability, latency_ms, created_at
        )
        VALUES (
          $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
          $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17, $18::timestamptz
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        run.id,
        run.projectId,
        run.question,
        json(run.config || {}),
        json(run.query || {}),
        json(run.queryTerms || []),
        json(run.retrieved || []),
        json(run.answer || {}),
        json(run.evaluation || {}),
        run.prompt ? json(run.prompt) : null,
        json(run.warnings || []),
        json(run.trace || []),
        json(run.usage || {}),
        json(run.redactions || []),
        json(run.evidenceSnapshot || { documents: [], chunks: [] }),
        json(run.observability || {}),
        number(run.latencyMs),
        run.createdAt
      ]
    );
  },

  insertRetrievedChunk(runId, item) {
    return statement(
      `
        INSERT INTO raglens_retrieved_chunks (
          run_id, chunk_id, rank, score, raw_score, lexical_score, similarity_score,
          rerank_score, coverage, novelty, matched_terms, missing_terms
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
        ON CONFLICT (run_id, chunk_id) DO NOTHING
      `,
      [
        runId,
        item.chunkId,
        number(item.rank),
        number(item.score),
        number(item.rawScore),
        number(item.lexicalScore),
        number(item.similarityScore),
        number(item.rerankScore),
        number(item.coverage),
        number(item.novelty),
        json(item.matchedTerms || []),
        json(item.missingTerms || [])
      ]
    );
  },

  searchChunksByVector(projectId, queryTerms, queryEmbedding, options = {}) {
    const topK = Math.min(Math.max(Number(options.topK || 6), 1), 20);
    const mode = ['keyword', 'vector', 'hybrid'].includes(options.retrievalMode)
      ? options.retrievalMode
      : 'hybrid';

    return statement(
      `
        WITH query_input AS (
          SELECT
            $2::text[] AS terms,
            $3::vector AS embedding,
            $4::text AS mode,
            $5::boolean AS rerank
        ),
        scored AS (
          SELECT
            c.id,
            c.project_id AS "projectId",
            c.document_id AS "documentId",
            c.document_title AS "documentTitle",
            c.chunk_index AS "chunkIndex",
            c.label,
            c.heading,
            c.section,
            c.page,
            c.text,
            c.token_count AS "tokenCount",
            c.terms,
            c.term_counts AS "termCounts",
            c.embedding::text AS embedding,
            c.embedding_model AS "embeddingModel",
            c.embedded_at AS "embeddedAt",
            c.created_at AS "createdAt",
            count(*) OVER () AS "indexedChunks",
            COALESCE(term_stats.matched_terms, ARRAY[]::text[]) AS "matchedTerms",
            COALESCE(term_stats.missing_terms, ARRAY[]::text[]) AS "missingTerms",
            CASE
              WHEN COALESCE(array_length(q.terms, 1), 0) = 0 THEN 0
              ELSE COALESCE(array_length(term_stats.matched_terms, 1), 0)::numeric / array_length(q.terms, 1)
            END AS coverage,
            COALESCE(term_stats.lexical_score, 0) AS "lexicalScore",
            1 - (c.embedding <=> q.embedding) AS "vectorScore"
          FROM raglens_chunks c
          CROSS JOIN query_input q
          LEFT JOIN LATERAL (
            SELECT
              array_agg(term ORDER BY ord) FILTER (WHERE c.term_counts ? term) AS matched_terms,
              array_agg(term ORDER BY ord) FILTER (WHERE NOT (c.term_counts ? term)) AS missing_terms,
              SUM(
                CASE
                  WHEN c.term_counts ? term THEN COALESCE((c.term_counts ->> term)::numeric, 0)
                  ELSE 0
                END
              ) AS lexical_score
            FROM unnest(q.terms) WITH ORDINALITY AS t(term, ord)
          ) term_stats ON true
          WHERE c.project_id = $1
        ),
        ranked AS (
          SELECT
            *,
            CASE
              WHEN $4 = 'keyword' THEN "lexicalScore"
              WHEN $4 = 'vector' THEN GREATEST("vectorScore", 0) * 5
              ELSE "lexicalScore" * 0.72 + GREATEST("vectorScore", 0) * 2.4
            END AS "rawScore"
          FROM scored
        )
        SELECT
          *,
          CASE
            WHEN $5 THEN "rawScore" + coverage * 1.1 + GREATEST("vectorScore", 0) * 0.8
            ELSE "rawScore"
          END AS "rerankScore"
        FROM ranked
        WHERE "rawScore" > 0 OR "vectorScore" > 0.08
        ORDER BY "rerankScore" DESC, id ASC
        LIMIT $6
      `,
      [
        projectId,
        textArray(queryTerms),
        vector(queryEmbedding),
        mode,
        options.rerank !== false,
        topK
      ]
    );
  },

  listRuns(projectId) {
    return statement(
      `
        SELECT id, question, created_at AS "createdAt", latency_ms AS "latencyMs", warnings, evaluation, config
        FROM raglens_query_runs
        WHERE project_id = $1
        ORDER BY created_at DESC
        LIMIT 100
      `,
      [projectId]
    );
  },

  getRun(projectId, runId) {
    return statement(
      `
        SELECT *
        FROM raglens_query_runs
        WHERE project_id = $1 AND id = $2
      `,
      [projectId, runId]
    );
  },

  getRunsForCompare(projectId, leftRunId, rightRunId) {
    return statement(
      `
        SELECT *
        FROM raglens_query_runs
        WHERE project_id = $1 AND id = ANY($2::text[])
        ORDER BY array_position($2::text[], id)
      `,
      [projectId, [leftRunId, rightRunId]]
    );
  },

  findExpectedSource(projectId, question) {
    return statement(
      `
        SELECT *
        FROM raglens_eval_questions
        WHERE project_id = $1 AND lower(question) = lower($2)
        LIMIT 1
      `,
      [projectId, question]
    );
  },

  upsertEvalQuestion(item) {
    return statement(
      `
        INSERT INTO raglens_eval_questions (
          id, project_id, question, expected_source, expected_answer, redactions, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz)
        ON CONFLICT (project_id, lower(question)) DO UPDATE SET
          expected_source = EXCLUDED.expected_source,
          expected_answer = EXCLUDED.expected_answer,
          redactions = EXCLUDED.redactions,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `,
      [
        item.id,
        item.projectId,
        item.question,
        item.expectedSource,
        item.expectedAnswer || '',
        json(item.redactions || []),
        item.createdAt,
        item.updatedAt || item.createdAt
      ]
    );
  },

  deleteEvalQuestion(projectId, evalQuestionId) {
    return statement(
      `
        DELETE FROM raglens_eval_questions
        WHERE project_id = $1 AND id = $2
      `,
      [projectId, evalQuestionId]
    );
  },

  insertFeedback(projectId, runId, feedback) {
    return statement(
      `
        INSERT INTO raglens_feedback (id, run_id, project_id, rating, note, expected_answer, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
        ON CONFLICT (id) DO NOTHING
      `,
      [
        feedback.id,
        runId,
        projectId,
        feedback.rating === 'down' ? 'down' : 'up',
        feedback.note || '',
        feedback.expectedAnswer || '',
        feedback.createdAt
      ]
    );
  }
};

function statement(text, values = []) {
  return {
    text: text.trim().replace(/[ \t]+\n/g, '\n'),
    values
  };
}

function json(value) {
  return JSON.stringify(value);
}

function vector(value) {
  const source = Array.isArray(value) ? value : [];
  const vectorValue = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => {
    const parsed = Number(source[index] ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return `[${vectorValue.join(',')}]`;
}

function textArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 64)
    : [];
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
