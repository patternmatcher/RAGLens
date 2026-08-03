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
        to_regclass('raglens_eval_questions') AS eval_questions,
        to_regclass('raglens_embedding_cache') AS embedding_cache
    `);
  },

  listEmbeddingCache(projectIds) {
    return statement(
      `
        SELECT project_id AS "projectId", cache_key AS key, provider, model, dimensions,
          embedding::text AS embedding, created_at AS "createdAt", last_used_at AS "lastUsedAt"
        FROM raglens_embedding_cache
        WHERE project_id = ANY($1::text[])
        ORDER BY last_used_at DESC
      `,
      [projectIds]
    );
  },

  deleteStaleEmbeddingCache(projectId, keys) {
    return statement(
      `
        DELETE FROM raglens_embedding_cache
        WHERE project_id = $1 AND NOT (cache_key = ANY($2::text[]))
      `,
      [projectId, keys]
    );
  },

  insertEmbeddingCache(entry) {
    return statement(
      `
        INSERT INTO raglens_embedding_cache (
          project_id, cache_key, provider, model, dimensions, embedding, created_at, last_used_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::vector, $7::timestamptz, $8::timestamptz)
        ON CONFLICT (project_id, cache_key) DO UPDATE SET
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          dimensions = EXCLUDED.dimensions,
          embedding = EXCLUDED.embedding,
          last_used_at = EXCLUDED.last_used_at
      `,
      [
        entry.projectId,
        entry.key,
        entry.provider,
        entry.model,
        embeddingDimensions(entry.dimensions || entry.embedding?.length),
        vector(entry.embedding),
        entry.createdAt,
        entry.lastUsedAt || entry.createdAt
      ]
    );
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
          id, project_id, document_id, document_title, stable_chunk_id, chunk_index, label, heading, section,
          page, page_start, page_end, page_numbers_exact, character_start, character_end,
          text, token_count, terms, term_counts, embedding, embedding_provider, embedding_model,
          embedding_dimensions, embedded_at, created_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15,
          $16, $17, $18::jsonb, $19::jsonb, $20::vector, $21, $22, $23, $24::timestamptz, $25::timestamptz
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        chunk.id,
        chunk.projectId,
        chunk.documentId,
        chunk.documentTitle,
        chunk.stableChunkId || chunk.id,
        number(chunk.index),
        chunk.label,
        chunk.heading || chunk.section || 'Untitled section',
        chunk.section || chunk.heading || 'Untitled section',
        nullableNumber(chunk.page),
        nullableNumber(chunk.pageStart ?? chunk.page),
        nullableNumber(chunk.pageEnd ?? chunk.page),
        chunk.pageNumbersExact === true,
        nullableNumber(chunk.characterStart),
        nullableNumber(chunk.characterEnd),
        chunk.text,
        number(chunk.tokenCount),
        json(chunk.terms || []),
        json(chunk.termCounts || {}),
        vector(chunk.embedding),
        chunk.embeddingProvider || 'local',
        chunk.embeddingModel || 'local-hash-embedding-v1',
        embeddingDimensions(chunk.embeddingDimensions || chunk.embedding?.length),
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
    const dimensions = embeddingDimensions(options.embeddingDimensions || queryEmbedding?.length);
    const candidateDepth = Math.min(Math.max(Number(options.candidateDepth || Math.max(24, topK * 4)), topK), 100);

    return statement(
      `
        WITH query_input AS (
          SELECT
            $2::text[] AS terms,
            $3::vector(${dimensions}) AS embedding,
            $4::text AS mode,
            $5::boolean AS rerank,
            $9::jsonb AS filter
        ),
        scored AS (
          SELECT
            c.id,
            c.project_id AS "projectId",
            c.document_id AS "documentId",
            c.document_title AS "documentTitle",
            c.stable_chunk_id AS "stableChunkId",
            c.chunk_index AS "chunkIndex",
            c.label,
            c.heading,
            c.section,
            c.page,
            c.page_start AS "pageStart",
            c.page_end AS "pageEnd",
            c.page_numbers_exact AS "pageNumbersExact",
            c.character_start AS "characterStart",
            c.character_end AS "characterEnd",
            c.text,
            c.token_count AS "tokenCount",
            c.terms,
            c.term_counts AS "termCounts",
            c.embedding::text AS embedding,
            c.embedding_provider AS "embeddingProvider",
            c.embedding_model AS "embeddingModel",
            c.embedding_dimensions AS "embeddingDimensions",
            d.source_type AS "sourceType",
            d.metadata AS "documentMetadata",
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
            1 - (c.embedding::vector(${dimensions}) <=> q.embedding) AS "vectorScore"
          FROM raglens_chunks c
          JOIN raglens_documents d ON d.id = c.document_id AND d.project_id = c.project_id
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
            AND c.embedding_model = $7
            AND c.embedding_dimensions = $8
            AND (NOT (q.filter ? 'documentIds') OR c.document_id IN (SELECT jsonb_array_elements_text(q.filter -> 'documentIds')))
            AND (NOT (q.filter ? 'sourceTypes') OR d.source_type IN (SELECT jsonb_array_elements_text(q.filter -> 'sourceTypes')))
            AND (NOT (q.filter ? 'collections') OR d.metadata ->> 'collection' IN (SELECT jsonb_array_elements_text(q.filter -> 'collections')))
            AND (NOT (q.filter ? 'departments') OR d.metadata ->> 'department' IN (SELECT jsonb_array_elements_text(q.filter -> 'departments')))
            AND (NOT (q.filter ? 'versions') OR d.metadata ->> 'version' IN (SELECT jsonb_array_elements_text(q.filter -> 'versions')))
            AND (NOT (q.filter ? 'sensitivities') OR d.metadata ->> 'sensitivity' IN (SELECT jsonb_array_elements_text(q.filter -> 'sensitivities')))
            AND (NOT (q.filter ? 'tags') OR EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(q.filter -> 'tags') AS requested(tag)
              WHERE COALESCE(d.metadata -> 'tags', '[]'::jsonb) ? requested.tag
            ))
            AND (NOT (q.filter ? 'effectiveAfter') OR CASE
              WHEN d.metadata ->> 'effectiveDate' ~ '^\\d{4}-\\d{2}-\\d{2}$'
              THEN (d.metadata ->> 'effectiveDate')::date >= (q.filter ->> 'effectiveAfter')::date
              ELSE FALSE
            END)
            AND (NOT (q.filter ? 'effectiveBefore') OR CASE
              WHEN d.metadata ->> 'effectiveDate' ~ '^\\d{4}-\\d{2}-\\d{2}$'
              THEN (d.metadata ->> 'effectiveDate')::date <= (q.filter ->> 'effectiveBefore')::date
              ELSE FALSE
            END)
            AND (NOT (q.filter ? 'pageStart') OR c.page_end >= (q.filter ->> 'pageStart')::integer)
            AND (NOT (q.filter ? 'pageEnd') OR c.page_start <= (q.filter ->> 'pageEnd')::integer)
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
        candidateDepth,
        options.embeddingModel || 'local-hash-embedding-v1',
        dimensions,
        json(options.metadataFilter || {})
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
  const vectorValue = source.slice(0, 8_192).map((item) => {
    const parsed = Number(item ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  if (!vectorValue.length) vectorValue.push(0);
  return `[${vectorValue.join(',')}]`;
}

function textArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 64)
    : [];
}

function embeddingDimensions(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 8_192 ? parsed : 64;
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
