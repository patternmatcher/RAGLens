import { id } from '../lib/id.js';
import { nowIso } from '../lib/time.js';
import { EMBEDDING_MODEL, embedText } from './embedding.js';
import { tokenize, termCounts } from './tokenize.js';

const DEFAULT_CHUNK_TOKENS = 120;
const DEFAULT_OVERLAP_TOKENS = 24;

export function createDocument({ title, sourceType = 'text', text, metadata = {}, projectId = null }) {
  const normalizedText = normalizeText(text);
  const createdAt = nowIso();

  return {
    id: id('doc'),
    projectId,
    title: cleanTitle(title),
    sourceType,
    text: normalizedText,
    metadata,
    checksum: checksum(normalizedText),
    createdAt,
    updatedAt: createdAt,
    wordCount: tokenize(normalizedText, { keepStopwords: true }).length,
    status: 'indexed'
  };
}

export function chunkDocument(document, options = {}) {
  const maxTokens = Math.max(40, Number(options.maxTokens || DEFAULT_CHUNK_TOKENS));
  const overlapTokens = Math.min(
    Math.max(0, Number(options.overlapTokens || DEFAULT_OVERLAP_TOKENS)),
    Math.floor(maxTokens / 2)
  );
  const sections = splitIntoSections(document.text);
  const chunks = [];

  for (const section of sections) {
    const paragraphs = section.body
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean);

    let buffer = [];
    let bufferText = [];

    for (const paragraph of paragraphs) {
      const paragraphTokens = tokenize(paragraph, { keepStopwords: true });

      if (buffer.length && buffer.length + paragraphTokens.length > maxTokens) {
        chunks.push(makeChunk(document, section, bufferText.join('\n\n'), chunks.length));
        buffer = buffer.slice(Math.max(0, buffer.length - overlapTokens));
        bufferText = buffer.length ? [buffer.join(' ')] : [];
      }

      if (paragraphTokens.length > maxTokens) {
        const words = paragraph.split(/\s+/);
        let start = 0;
        while (start < words.length) {
          const slice = words.slice(start, start + maxTokens).join(' ');
          chunks.push(makeChunk(document, section, slice, chunks.length));
          start += Math.max(1, maxTokens - overlapTokens);
        }
        buffer = [];
        bufferText = [];
      } else {
        buffer.push(...paragraphTokens);
        bufferText.push(paragraph);
      }
    }

    if (bufferText.length) {
      chunks.push(makeChunk(document, section, bufferText.join('\n\n'), chunks.length));
    }
  }

  return chunks.filter((chunk) => chunk.tokenCount > 4);
}

export function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[ \f\v]+/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function splitIntoSections(text) {
  const lines = normalizeText(text).split('\n');
  const sections = [];
  let current = { heading: 'Untitled section', body: [] };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = line.match(/^(#{1,6}\s+|[A-Z][A-Za-z0-9 ,:()/-]{3,80}$)/);

    if (heading && current.body.length) {
      sections.push({ heading: current.heading, body: current.body.join('\n') });
      current = { heading: line.replace(/^#{1,6}\s+/, ''), body: [] };
    } else if (heading && current.heading === 'Untitled section' && !current.body.length) {
      current.heading = line.replace(/^#{1,6}\s+/, '');
    } else {
      current.body.push(rawLine);
    }
  }

  if (current.body.length) {
    sections.push({ heading: current.heading, body: current.body.join('\n') });
  }

  return sections.length ? sections : [{ heading: 'Untitled section', body: text }];
}

function makeChunk(document, section, text, index) {
  const cleaned = normalizeText(text);
  const tokens = tokenize(cleaned);
  const counts = Object.fromEntries(termCounts(tokens));
  const embeddedAt = nowIso();

  return {
    id: id('chk'),
    projectId: document.projectId || null,
    documentId: document.id,
    documentTitle: document.title,
    index,
    label: `${document.title} / ${section.heading} / C${index + 1}`,
    heading: section.heading,
    section: section.heading,
    page: estimatePage(index),
    text: cleaned,
    tokenCount: tokenize(cleaned, { keepStopwords: true }).length,
    terms: tokens,
    termCounts: counts,
    embedding: embedText(cleaned),
    embeddingModel: EMBEDDING_MODEL,
    embeddedAt,
    createdAt: embeddedAt
  };
}

function estimatePage(index) {
  return Math.floor(index / 3) + 1;
}

function cleanTitle(title) {
  const value = String(title || '').trim();
  return value || 'Untitled document';
}

function checksum(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}
