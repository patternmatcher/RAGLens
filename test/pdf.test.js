import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { extractPdfText, extractPdfTextWithFallback } from '../src/rag/pdf.js';

test('extractPdfText reads simple uncompressed PDF text objects', () => {
  const fakePdf = Buffer.from('%PDF-1.4\nBT (Hello RAGLens PDF) Tj ET\n%%EOF', 'latin1');
  assert.equal(extractPdfText(fakePdf), 'Hello RAGLens PDF');
});

test('extractPdfText reads Flate-compressed PDF streams', () => {
  const content = 'BT /F1 12 Tf (Compressed RAGLens PDF) Tj ET';
  const compressed = deflateSync(Buffer.from(content, 'latin1')).toString('latin1');
  const fakePdf = Buffer.from(
    `%PDF-1.4
1 0 obj
<< /Length ${compressed.length} /Filter /FlateDecode >>
stream
${compressed}
endstream
endobj
%%EOF`,
    'latin1'
  );

  assert.equal(extractPdfText(fakePdf), 'Compressed RAGLens PDF');
});

test('extractPdfText reads TJ arrays and hex strings', () => {
  const fakePdf = Buffer.from(
    '%PDF-1.4\nBT [(Hybrid) -160 (Search)] TJ <205241474c656e73> Tj ET\n%%EOF',
    'latin1'
  );

  assert.equal(extractPdfText(fakePdf), 'Hybrid Search RAGLens');
});

test('extractPdfText reads quoted text operators', () => {
  const fakePdf = Buffer.from('%PDF-1.4\nBT (First line) Tj (Second line) \' ET\n%%EOF', 'latin1');

  assert.equal(extractPdfText(fakePdf), 'First line Second line');
});

test('extractPdfTextWithFallback can use a configured external command', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'raglens-pdf-test-'));
  const scriptPath = path.join(tempDir, 'fake-pdf-text.mjs');
  const previousSecret = process.env.RAGLENS_OPENAI_API_KEY;

  try {
    process.env.RAGLENS_OPENAI_API_KEY = 'provider-secret-that-must-not-leak';
    await writeFile(
      scriptPath,
      "import { readFileSync } from 'node:fs';\nif (process.env.RAGLENS_OPENAI_API_KEY) process.exit(7);\nconst input = process.argv[2];\nif (!readFileSync(input).toString('latin1').includes('%PDF')) process.exit(2);\nconsole.log('External layout text from PDF');\n",
      'utf8'
    );

    const result = await extractPdfTextWithFallback(Buffer.from('%PDF-1.4\n%%EOF', 'latin1'), {
      command: process.execPath,
      args: [scriptPath, '{input}', '-'],
      timeoutMs: 5_000
    });

    assert.equal(result.text, 'External layout text from PDF');
    assert.equal(result.metadata.method, 'external-pdf-text-command');
    assert.equal(result.metadata.externalConfigured, true);
  } finally {
    if (previousSecret === undefined) {
      delete process.env.RAGLENS_OPENAI_API_KEY;
    } else {
      process.env.RAGLENS_OPENAI_API_KEY = previousSecret;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('extractPdfText caps inflated PDF streams without throwing', () => {
  const hugeContent = `BT (${`${'A'.repeat(1_100_000)}`}) Tj ET`;
  const compressed = deflateSync(Buffer.from(hugeContent, 'latin1')).toString('latin1');
  const fakePdf = Buffer.from(
    `%PDF-1.4
1 0 obj
<< /Length ${compressed.length} /Filter /FlateDecode >>
stream
${compressed}
endstream
endobj
%%EOF`,
    'latin1'
  );

  assert.doesNotThrow(() => extractPdfText(fakePdf));
  assert.ok(extractPdfText(fakePdf).length <= 200_000);
});

test('extractPdfText caps aggregate stream work before late streams', () => {
  const streamObjects = [
    pdfStream(deflateSync(Buffer.from(`BT (Early PDF Marker) Tj ET\n${'A'.repeat(499_000)}`, 'latin1'))),
    pdfStream(deflateSync(Buffer.from('B'.repeat(700_000), 'latin1'))),
    pdfStream(deflateSync(Buffer.from('C'.repeat(700_000), 'latin1'))),
    pdfStream(deflateSync(Buffer.from('D'.repeat(700_000), 'latin1'))),
    pdfStream(deflateSync(Buffer.from('BT (Late PDF Marker) Tj ET', 'latin1')))
  ].join('\n');
  const fakePdf = Buffer.from(`%PDF-1.4\n${streamObjects}\n%%EOF`, 'latin1');
  const text = extractPdfText(fakePdf);

  assert.match(text, /Early PDF Marker/);
  assert.doesNotMatch(text, /Late PDF Marker/);
});

test('extractPdfTextWithFallback uses internal parser when external command fails', async () => {
  const result = await extractPdfTextWithFallback(Buffer.from('%PDF-1.4\nBT (Fallback PDF text) Tj ET\n%%EOF', 'latin1'), {
    command: process.execPath,
    args: ['-e', 'process.exit(9)'],
    timeoutMs: 5_000
  });

  assert.equal(result.text, 'Fallback PDF text');
  assert.equal(result.metadata.method, 'internal-pdf-parser-fallback');
  assert.equal(result.metadata.externalConfigured, true);
  assert.match(result.metadata.externalError, /exit code|Command failed/i);
});

function pdfStream(compressed) {
  const value = compressed.toString('latin1');
  return `<< /Length ${value.length} /Filter /FlateDecode >>
stream
${value}
endstream`;
}
