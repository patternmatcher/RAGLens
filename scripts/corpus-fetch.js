import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fetchNoRedirect, readResponseBytes } from '../src/security/http-client.js';

const RAW_DIR = path.join('corpora', 'raw');
const NORMALIZED_DIR = path.join('corpora', 'normalized');
const MANIFEST_PATH = path.join('corpora', 'manifest.json');
const DEFAULT_LIMITS = {
  squad: 120,
  stratrag: 60,
  scifact: 120
};
const SOURCES = {
  squad: {
    name: 'SQuAD v1.1 dev',
    kind: 'json',
    url: 'https://rajpurkar.github.io/SQuAD-explorer/dataset/dev-v1.1.json',
    sha256: '95aa6a52d5d6a735563366753ca50492a658031da74f301ac5238b03966972c9',
    maxBytes: 8 * 1024 * 1024,
    rawFile: 'squad-dev-v1.1.json',
    normalizedFile: 'squad.json'
  },
  stratrag: {
    name: 'StratRAG validation',
    kind: 'json',
    url: 'https://datasets-server.huggingface.co/rows?dataset=Aryanp088%2FStratRAG&config=default&split=validation&offset=0&length=100',
    sha256: 'c49d8ec8573426f16cd31644d79cb9a6299f394872f6301ec3289e65c92b9e1e',
    maxBytes: 4 * 1024 * 1024,
    rawFile: 'stratrag-validation.json',
    normalizedFile: 'stratrag.json'
  },
  scifact: {
    name: 'SciFact dev',
    kind: 'tar.gz',
    url: 'https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz',
    sha256: '11c621288d41ac144d29b13b0f8503b3820b7d6e8b1f6ff24dff335c196d76be',
    maxBytes: 8 * 1024 * 1024,
    maxExpandedBytes: 64 * 1024 * 1024,
    rawFile: 'scifact-data.tar.gz',
    normalizedFile: 'scifact.json'
  }
};

const options = parseArgs(process.argv.slice(2));
const selectedSources = options.sources.length ? options.sources : Object.keys(SOURCES);

await mkdir(RAW_DIR, { recursive: true });
await mkdir(NORMALIZED_DIR, { recursive: true });

const manifest = {
  schemaVersion: 'raglens-corpus-manifest/v1',
  updatedAt: new Date().toISOString(),
  sources: []
};

for (const key of selectedSources) {
  const source = SOURCES[key];
  if (!source) {
    throw new Error(`Unknown corpus source "${key}". Available sources: ${Object.keys(SOURCES).join(', ')}.`);
  }

  const rawPath = path.join(RAW_DIR, source.rawFile);
  const normalizedPath = path.join(NORMALIZED_DIR, source.normalizedFile);
  const rawBuffer = await readOrDownload(source, rawPath, options.force);
  const limit = options.limits[key] || DEFAULT_LIMITS[key];
  const normalized = normalizeSource(key, source, rawBuffer, limit);

  await writeJson(normalizedPath, normalized);
  manifest.sources.push({
    key,
    name: source.name,
    sourceUrl: source.url,
    rawFile: rawPath.replaceAll('\\', '/'),
    normalizedFile: normalizedPath.replaceAll('\\', '/'),
    documents: normalized.documents.length,
    questions: normalized.questions.length,
    sha256: source.sha256
  });

  console.log(`${source.name}: ${normalized.documents.length} documents, ${normalized.questions.length} questions`);
}

await writeJson(MANIFEST_PATH, manifest);
console.log(`Wrote ${MANIFEST_PATH}`);

async function readOrDownload(source, rawPath, force) {
  if (!force) {
    try {
      const cached = await readFile(rawPath);
      verifyDigest(source, cached);
      return cached;
    } catch {
      // Download below.
    }
  }

  console.log(`Downloading ${source.name} from ${source.url}`);
  const response = await fetchNoRedirect(globalThis.fetch, source.url, {
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${source.name}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await readResponseBytes(response, {
    label: source.name,
    maxBytes: source.maxBytes
  }));
  verifyDigest(source, buffer);
  await writeFile(rawPath, buffer);
  return buffer;
}

function normalizeSource(key, source, rawBuffer, limit) {
  if (key === 'squad') {
    return normalizeSquad(source, parseJson(rawBuffer), limit);
  }
  if (key === 'stratrag') {
    return normalizeStratRag(source, parseJson(rawBuffer), limit);
  }
  if (key === 'scifact') {
    return normalizeSciFact(source, extractTarGz(rawBuffer, source.maxExpandedBytes), limit);
  }
  throw new Error(`No normalizer for ${key}.`);
}

function normalizeSquad(source, input, limit) {
  const documents = [];
  const questions = [];
  const paragraphs = [];

  for (const article of input.data || []) {
    for (const [paragraphIndex, paragraph] of (article.paragraphs || []).entries()) {
      paragraphs.push({ article, paragraph, paragraphIndex });
    }
  }

  for (const item of paragraphs) {
    if (questions.length >= limit) {
      break;
    }

    const title = titleFor('SQuAD', `${item.article.title} #${item.paragraphIndex + 1}`);
    documents.push({
      id: stableId('squad-doc', title),
      title,
      sourceType: 'text',
      text: `# ${item.article.title}\n\n${item.paragraph.context}`,
      metadata: {
        corpus: source.name,
        articleTitle: item.article.title,
        paragraphIndex: item.paragraphIndex
      }
    });

    for (const qa of item.paragraph.qas || []) {
      if (questions.length >= limit) {
        break;
      }
      if (qa.is_impossible) {
        continue;
      }
      questions.push({
        id: stableId('squad-q', qa.id || qa.question),
        question: qa.question,
        expectedSources: [title],
        expectedAnswer: qa.answers?.[0]?.text || '',
        tags: ['single-hop', 'wikipedia', 'extractive']
      });
    }
  }

  return normalizedCorpus('squad', source, documents, questions);
}

function normalizeStratRag(source, input, limit) {
  const documentsByTitle = new Map();
  const questions = [];
  const rows = Array.isArray(input)
    ? input
    : (input.rows || []).map((item) => item.row || item);

  for (const item of rows) {
    if (questions.length >= limit) {
      break;
    }

    const contextTitles = new Set();
    for (const doc of item.doc_pool || []) {
      const sourceTitle = String(doc.source || doc.doc_id || 'Untitled');
      const documentTitle = titleFor('StratRAG', `${sourceTitle} (${doc.doc_id || stableId('doc', sourceTitle)})`);
      contextTitles.add(documentTitle);
      if (!documentsByTitle.has(documentTitle)) {
        documentsByTitle.set(documentTitle, {
          id: stableId('stratrag-doc', documentTitle),
          title: documentTitle,
          sourceType: 'text',
          text: `# ${sourceTitle}\n\n${doc.text || ''}`,
          metadata: {
            corpus: source.name,
            sourceTitle,
            sourceDocId: doc.doc_id || ''
          }
        });
      }
    }

    const expectedSources = [...new Set((item.gold_doc_indices || [])
      .map((index) => item.doc_pool?.[Number(index)])
      .filter(Boolean)
      .map((doc) => {
        const sourceTitle = String(doc.source || doc.doc_id || 'Untitled');
        return titleFor('StratRAG', `${sourceTitle} (${doc.doc_id || stableId('doc', sourceTitle)})`);
      })
      .filter((title) => contextTitles.has(title)))];
    if (!expectedSources.length) {
      continue;
    }

    questions.push({
      id: stableId('stratrag-q', item.id || item.query),
      question: item.query,
      expectedSources,
      expectedAnswer: item.reference_answer || '',
      tags: [
        'multi-hop',
        'hotpotqa-derived',
        item.metadata?.question_type || 'unknown',
        item.metadata?.split || 'validation'
      ]
    });
  }

  return normalizedCorpus('stratrag', source, [...documentsByTitle.values()], questions);
}

function normalizeSciFact(source, entries, limit) {
  const corpusRows = readJsonLines(findTarEntry(entries, 'corpus.jsonl'));
  const claimRows = readJsonLines(findTarEntry(entries, 'claims_dev.jsonl'));
  const corpusById = new Map(corpusRows.map((row) => [String(row.doc_id), row]));
  const selectedClaims = [];
  const expectedIds = new Set();

  for (const claim of claimRows) {
    const claimExpectedIds = expectedDocIdsForSciFact(claim).filter((id) => corpusById.has(id));
    if (!claimExpectedIds.length) {
      continue;
    }
    selectedClaims.push({ claim, expectedIds: claimExpectedIds });
    claimExpectedIds.forEach((id) => expectedIds.add(id));
    if (selectedClaims.length >= limit) {
      break;
    }
  }

  const documents = [...expectedIds].map((docId) => scifactDocument(source, corpusById.get(docId)));
  for (const row of corpusRows) {
    if (documents.length >= Math.max(limit * 2, 220)) {
      break;
    }
    if (!expectedIds.has(String(row.doc_id))) {
      documents.push(scifactDocument(source, row));
    }
  }

  const questions = selectedClaims.map(({ claim, expectedIds: ids }) => ({
    id: stableId('scifact-q', String(claim.id || claim.claim)),
    question: claim.claim,
    expectedSources: ids.map((docId) => titleFor('SciFact', corpusById.get(docId)?.title || docId)),
    expectedAnswer: '',
    tags: ['scientific-claims', claim.evidence_label || claim.label || 'evidence']
  }));

  return normalizedCorpus('scifact', source, documents, questions);
}

function scifactDocument(source, row) {
  const title = titleFor('SciFact', row.title || String(row.doc_id));
  return {
    id: stableId('scifact-doc', String(row.doc_id)),
    title,
    sourceType: 'text',
    text: `# ${row.title || row.doc_id}\n\n${arrayText(row.abstract).join(' ')}`,
    metadata: {
      corpus: source.name,
      sourceDocId: String(row.doc_id)
    }
  };
}

function expectedDocIdsForSciFact(claim) {
  const ids = new Set();
  for (const key of ['evidence_doc_id', 'doc_id']) {
    if (claim[key] !== undefined && claim[key] !== null) {
      ids.add(String(claim[key]));
    }
  }
  for (const idValue of claim.cited_doc_ids || []) {
    ids.add(String(idValue));
  }
  if (claim.evidence && typeof claim.evidence === 'object' && !Array.isArray(claim.evidence)) {
    Object.keys(claim.evidence).forEach((idValue) => ids.add(String(idValue)));
  }
  return [...ids];
}

function normalizedCorpus(key, source, documents, questions) {
  return {
    schemaVersion: 'raglens-corpus/v1',
    key,
    name: source.name,
    sourceUrl: source.url,
    preparedAt: new Date().toISOString(),
    documents,
    questions
  };
}

function extractTarGz(buffer, maxOutputLength) {
  const tar = zlib.gunzipSync(buffer, { maxOutputLength });
  const entries = new Map();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const name = cleanTarString(header.subarray(0, 100));
    if (!name) {
      break;
    }

    const size = Number.parseInt(cleanTarString(header.subarray(124, 136)).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('SciFact archive contains an invalid entry size.');
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > tar.length) throw new Error('SciFact archive contains a truncated entry.');
    entries.set(name, tar.subarray(bodyStart, bodyEnd).toString('utf8'));
    if (entries.size > 10_000) throw new Error('SciFact archive contains too many entries.');
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

function verifyDigest(source, buffer) {
  const actual = sha256(buffer);
  if (actual !== source.sha256) {
    throw new Error(`${source.name} failed SHA-256 verification. Expected ${source.sha256}, received ${actual}.`);
  }
}

function findTarEntry(entries, filename) {
  for (const [name, content] of entries) {
    if (name.endsWith(`/${filename}`) || name === filename) {
      return content;
    }
  }
  throw new Error(`Could not find ${filename} in SciFact tarball.`);
}

function readJsonLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseJson(buffer) {
  return JSON.parse(buffer.toString('utf8'));
}

function arrayText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return [String(value || '').trim()].filter(Boolean);
}

function titleFor(corpusName, title) {
  return `${corpusName}: ${String(title || 'Untitled').trim()}`;
}

function stableId(prefix, value) {
  return `${prefix}_${sha256(String(value)).slice(0, 12)}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(args) {
  const parsed = {
    force: args.includes('--force'),
    sources: [],
    limits: { ...DEFAULT_LIMITS }
  };

  for (const arg of args) {
    if (arg.startsWith('--source=')) {
      parsed.sources = arg.slice('--source='.length).split(',').map((item) => item.trim()).filter(Boolean);
    } else if (arg.startsWith('--limit=')) {
      const limit = Number(arg.slice('--limit='.length));
      if (Number.isFinite(limit) && limit > 0) {
        for (const key of Object.keys(parsed.limits)) {
          parsed.limits[key] = limit;
        }
      }
    } else if (arg.startsWith('--limit-')) {
      const [name, value] = arg.slice('--limit-'.length).split('=');
      const limit = Number(value);
      if (Object.hasOwn(parsed.limits, name) && Number.isFinite(limit) && limit > 0) {
        parsed.limits[name] = limit;
      }
    }
  }

  return parsed;
}

function cleanTarString(buffer) {
  const zero = buffer.indexOf(0);
  const slice = zero === -1 ? buffer : buffer.subarray(0, zero);
  return slice.toString('utf8');
}
