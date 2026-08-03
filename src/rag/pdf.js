import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';

const TEXT_OPERATORS = new Set(['Tj', 'TJ', "'", '"', 'T*']);
const execFileAsync = promisify(execFile);
const MAX_PDF_STREAMS = 80;
const MAX_COMPRESSED_STREAM_BYTES = 1_000_000;
const MAX_INFLATED_STREAM_BYTES = 1_000_000;
const MAX_TOTAL_STREAM_CHARS = 2_000_000;
const MAX_EXTRACTED_TEXT_CHARS = 200_000;
const CLEARING_OPERATORS = new Set([
  'BT',
  'ET',
  'Tf',
  'Tm',
  'Td',
  'TD',
  'Tc',
  'Tw',
  'Tz',
  'TL',
  'Tr',
  'Ts',
  'cm',
  'q',
  'Q',
  'Do',
  'rg',
  'RG',
  'g',
  'G'
]);

export function extractPdfText(bufferLike) {
  const buffer = Buffer.isBuffer(bufferLike) ? bufferLike : Buffer.from(bufferLike || '');
  const raw = buffer.toString('latin1');
  const candidates = [raw, ...extractPdfStreams(raw)];
  const text = candidates
    .map((candidate) => extractContentText(candidate))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_EXTRACTED_TEXT_CHARS);

  return text || printableFallback(raw);
}

export function extractPdfPages(bufferLike) {
  const text = extractPdfText(bufferLike);
  return text
    ? [{ pageNumber: null, text, exact: false }]
    : [];
}

export async function extractPdfTextWithFallback(bufferLike, options = {}) {
  const buffer = Buffer.isBuffer(bufferLike) ? bufferLike : Buffer.from(bufferLike || '');

  if (!options.command) {
    const pages = extractPdfPages(buffer);
    return {
      text: joinPages(pages),
      pages,
      metadata: {
        method: 'internal-pdf-parser',
        externalConfigured: false,
        pageCount: pages.length,
        pageNumbersExact: false
      }
    };
  }

  try {
    const pages = await extractPdfTextWithCommand(buffer, options);
    if (pages.length) {
      return {
        text: joinPages(pages),
        pages,
        metadata: {
          method: 'external-pdf-text-command',
          externalConfigured: true,
          commandName: path.basename(options.command),
          pageCount: pages.length,
          pageNumbersExact: true
        }
      };
    }
  } catch (error) {
    const pages = extractPdfPages(buffer);
    return {
      text: joinPages(pages),
      pages,
      metadata: {
        method: 'internal-pdf-parser-fallback',
        externalConfigured: true,
        commandName: path.basename(options.command),
        externalError: String(error.message || error).slice(0, 240),
        pageCount: pages.length,
        pageNumbersExact: false
      }
    };
  }

  const pages = extractPdfPages(buffer);
  return {
    text: joinPages(pages),
    pages,
    metadata: {
      method: 'internal-pdf-parser-fallback',
      externalConfigured: true,
      commandName: path.basename(options.command),
      externalError: 'External PDF text command returned no text.',
      pageCount: pages.length,
      pageNumbersExact: false
    }
  };
}

async function extractPdfTextWithCommand(buffer, options) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'raglens-pdf-'));
  const inputPath = path.join(tempDir, 'input.pdf');

  try {
    await writeFile(inputPath, buffer);
    const args = normalizeExternalArgs(options.args).map((arg) => arg.replaceAll('{input}', inputPath));
    const { stdout } = await execFileAsync(options.command, args, {
      cwd: tempDir,
      env: minimalPdfCommandEnv(tempDir),
      timeout: Number(options.timeoutMs || 10_000),
      maxBuffer: 2_000_000,
      windowsHide: true
    });

    return splitExternalPages(stdout);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function splitExternalPages(text) {
  const rawPages = String(text || '').replace(/\u0000/g, '').split('\f');
  const pages = rawPages
    .map((pageText, index) => ({
      pageNumber: index + 1,
      text: normalizeExtractedText(pageText),
      exact: true
    }))
    .filter((page) => page.text);

  return pages.length ? pages : [];
}

function joinPages(pages) {
  return pages.map((page) => page.text).filter(Boolean).join('\n\n').slice(0, MAX_EXTRACTED_TEXT_CHARS);
}

function normalizeExternalArgs(args) {
  return Array.isArray(args) && args.length ? args.map(String) : ['-layout', '{input}', '-'];
}

function normalizeExtractedText(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, MAX_EXTRACTED_TEXT_CHARS);
}

function extractPdfStreams(raw) {
  const streams = [];
  const pattern = /<<(.*?)>>\s*stream(?:\r\n|\n|\r)?/g;
  let totalStreamChars = 0;
  let match;

  while ((match = pattern.exec(raw))) {
    if (streams.length >= MAX_PDF_STREAMS || totalStreamChars >= MAX_TOTAL_STREAM_CHARS) {
      break;
    }

    const end = raw.indexOf('endstream', pattern.lastIndex);
    if (end === -1) {
      break;
    }

    const dictionary = match[1];
    const streamData = trimStreamBoundary(raw.slice(pattern.lastIndex, end));
    const streamBuffer = Buffer.from(streamData, 'latin1');
    const remainingChars = MAX_TOTAL_STREAM_CHARS - totalStreamChars;
    let streamText = '';

    if (/\/Filter\s*(?:\[[^\]]*)?\/FlateDecode\b/.test(dictionary)) {
      const streamBudget = Math.min(MAX_INFLATED_STREAM_BYTES, remainingChars);
      try {
        if (streamBuffer.length <= MAX_COMPRESSED_STREAM_BYTES) {
          streamText = inflateSync(streamBuffer, {
            maxOutputLength: streamBudget
          }).toString('latin1');
        }
      } catch {
        if (streamBudget < MAX_INFLATED_STREAM_BYTES) {
          totalStreamChars = MAX_TOTAL_STREAM_CHARS;
        } else {
          streamText = streamBuffer.subarray(0, streamBudget).toString('latin1');
        }
      }
    } else {
      streamText = streamBuffer
        .subarray(0, Math.min(MAX_INFLATED_STREAM_BYTES, remainingChars))
        .toString('latin1');
    }

    if (streamText && totalStreamChars < MAX_TOTAL_STREAM_CHARS) {
      const boundedText = streamText.slice(0, remainingChars);
      streams.push(boundedText);
      totalStreamChars += boundedText.length;
    }

    pattern.lastIndex = end + 'endstream'.length;
  }

  return streams;
}

function extractContentText(content) {
  const parts = [];
  const textObjectPattern = /BT([\s\S]*?)ET/g;
  let objectMatch;

  while ((objectMatch = textObjectPattern.exec(content))) {
    parts.push(...extractTextObjectParts(objectMatch[1]));
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function extractTextObjectParts(block) {
  const tokens = tokenizePdfContent(block);
  const stack = [];
  const parts = [];

  for (const token of tokens) {
    if (token.type !== 'operator') {
      stack.push(token);
      continue;
    }

    if (TEXT_OPERATORS.has(token.value)) {
      const value = renderOperatorText(token.value, stack);
      if (value) {
        parts.push(value);
      }
      stack.length = 0;
      continue;
    }

    if (CLEARING_OPERATORS.has(token.value)) {
      stack.length = 0;
    }
  }

  return parts;
}

function renderOperatorText(operator, stack) {
  const last = stack.at(-1);

  if (operator === 'TJ' && last?.type === 'array') {
    return renderArrayText(last.value);
  }

  if ((operator === 'Tj' || operator === "'" || operator === '"') && isRenderable(last)) {
    return last.value;
  }

  if (operator === 'T*') {
    return '\n';
  }

  return '';
}

function tokenizePdfContent(content) {
  const tokens = [];
  let index = 0;

  while (index < content.length) {
    const char = content[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '%') {
      index = skipComment(content, index);
      continue;
    }

    if (char === '(') {
      const parsed = parseLiteralString(content, index);
      tokens.push({ type: 'string', value: decodePdfString(parsed.value) });
      index = parsed.next;
      continue;
    }

    if (char === '<' && content[index + 1] !== '<') {
      const parsed = parseHexString(content, index);
      tokens.push({ type: 'string', value: decodeHexString(parsed.value) });
      index = parsed.next;
      continue;
    }

    if (char === '[') {
      const parsed = parseArray(content, index);
      tokens.push({ type: 'array', value: parsed.value });
      index = parsed.next;
      continue;
    }

    if (isDelimiter(char)) {
      index += 1;
      continue;
    }

    const parsed = parseAtom(content, index);
    tokens.push(classifyAtom(parsed.value));
    index = parsed.next;
  }

  return tokens;
}

function parseLiteralString(content, start) {
  let index = start + 1;
  let depth = 1;
  let value = '';

  while (index < content.length && depth > 0) {
    const char = content[index];

    if (char === '\\') {
      value += char + (content[index + 1] || '');
      index += 2;
      continue;
    }

    if (char === '(') {
      depth += 1;
      value += char;
      index += 1;
      continue;
    }

    if (char === ')') {
      depth -= 1;
      if (depth > 0) {
        value += char;
      }
      index += 1;
      continue;
    }

    value += char;
    index += 1;
  }

  return {
    value,
    next: index
  };
}

function parseHexString(content, start) {
  const end = content.indexOf('>', start + 1);
  if (end === -1) {
    return { value: '', next: content.length };
  }

  return {
    value: content.slice(start + 1, end),
    next: end + 1
  };
}

function parseArray(content, start) {
  const items = [];
  let index = start + 1;

  while (index < content.length) {
    const char = content[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === ']') {
      return {
        value: items,
        next: index + 1
      };
    }

    if (char === '(') {
      const parsed = parseLiteralString(content, index);
      items.push({ type: 'string', value: decodePdfString(parsed.value) });
      index = parsed.next;
      continue;
    }

    if (char === '<' && content[index + 1] !== '<') {
      const parsed = parseHexString(content, index);
      items.push({ type: 'string', value: decodeHexString(parsed.value) });
      index = parsed.next;
      continue;
    }

    if (char === '%') {
      index = skipComment(content, index);
      continue;
    }

    const parsed = parseAtom(content, index);
    const token = classifyAtom(parsed.value);
    if (token.type === 'number') {
      items.push(token);
    }
    index = parsed.next;
  }

  return {
    value: items,
    next: index
  };
}

function parseAtom(content, start) {
  let index = start;
  while (index < content.length && !/\s/.test(content[index]) && !isDelimiter(content[index])) {
    index += 1;
  }

  return {
    value: content.slice(start, index),
    next: index
  };
}

function classifyAtom(value) {
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return { type: 'number', value: Number(value) };
  }

  return { type: 'operator', value };
}

function renderArrayText(items) {
  let text = '';

  for (const item of items) {
    if (item.type === 'string') {
      text += item.value;
    } else if (item.type === 'number' && item.value < -120) {
      text += ' ';
    }
  }

  return text;
}

function decodePdfString(value) {
  return value
    .replace(/\\\r\n|\\\n|\\\r/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function decodeHexString(value) {
  const clean = value.replace(/\s+/g, '');
  const padded = clean.length % 2 ? `${clean}0` : clean;
  const bytes = Buffer.from(padded, 'hex');

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      text += String.fromCharCode((bytes[index] << 8) + bytes[index + 1]);
    }
    return text;
  }

  return bytes.toString('latin1');
}

function isRenderable(token) {
  return token?.type === 'string';
}

function skipComment(content, start) {
  const end = content.slice(start).search(/[\r\n]/);
  return end === -1 ? content.length : start + end + 1;
}

function isDelimiter(char) {
  return ['<', '>', '[', ']', '{', '}', '/', ')'].includes(char);
}

function trimStreamBoundary(value) {
  return value.replace(/(?:\r\n|\n|\r)$/, '');
}

function printableFallback(raw) {
  return raw.replace(/[^\x20-\x7E\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20_000);
}

function minimalPdfCommandEnv(tempDir, env = process.env) {
  const allowedKeys = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'LANG',
    'LC_ALL'
  ];
  return {
    ...Object.fromEntries(
    allowedKeys
      .filter((key) => env[key])
      .map((key) => [key, env[key]])
    ),
    TMP: tempDir,
    TEMP: tempDir,
    HOME: tempDir,
    USERPROFILE: tempDir
  };
}
