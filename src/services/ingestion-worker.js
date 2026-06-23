import { id } from '../lib/id.js';
import { nowIso } from '../lib/time.js';

const ACTIVE_STATUSES = new Set(['queued', 'processing']);

export class IngestionWorker {
  constructor({ processDocument }) {
    this.processDocument = processDocument;
    this.jobs = [];
    this.processing = false;
  }

  enqueue(input, context = {}) {
    const createdAt = nowIso();
    const job = {
      id: id('job'),
      projectId: context.projectId || null,
      title: String(input.title || '').trim().slice(0, 160) || 'Untitled document',
      sourceType: String(input.sourceType || 'text').trim().slice(0, 40) || 'text',
      status: 'queued',
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
      error: null,
      result: null,
      input: { ...input }
    };

    this.jobs.unshift(job);
    this.jobs = this.jobs.slice(0, 100);
    queueMicrotask(() => this.drain());
    return sanitizeJob(job);
  }

  list(projectId = null) {
    return this.jobs
      .filter((job) => !projectId || job.projectId === projectId)
      .map(sanitizeJob);
  }

  get(jobId, projectId = null) {
    const job = this.jobs.find((item) => item.id === jobId && (!projectId || item.projectId === projectId));
    return job ? sanitizeJob(job) : null;
  }

  hasActiveJobs(projectId = null) {
    return this.jobs.some((job) => ACTIVE_STATUSES.has(job.status) && (!projectId || job.projectId === projectId));
  }

  clear() {
    this.jobs = [];
    this.processing = false;
  }

  async drain() {
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      while (true) {
        const job = this.jobs.find((item) => item.status === 'queued');
        if (!job) {
          return;
        }
        await this.process(job);
      }
    } finally {
      this.processing = false;
    }
  }

  async process(job) {
    job.status = 'processing';
    job.startedAt = nowIso();
    job.updatedAt = job.startedAt;

    try {
      const result = await this.processDocument(job.input, {
        projectId: job.projectId,
        jobId: job.id
      });
      job.status = 'completed';
      job.completedAt = nowIso();
      job.updatedAt = job.completedAt;
      job.result = {
        document: result.document,
        chunkCount: result.chunks?.length || 0
      };
      job.input = null;
    } catch (error) {
      job.status = 'failed';
      job.completedAt = nowIso();
      job.updatedAt = job.completedAt;
      job.error = error.message || 'Document ingestion failed.';
      job.input = null;
    }
  }
}

function sanitizeJob(job) {
  return {
    id: job.id,
    projectId: job.projectId,
    title: job.title,
    sourceType: job.sourceType,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    document: job.result?.document || null,
    chunkCount: job.result?.chunkCount || 0
  };
}
