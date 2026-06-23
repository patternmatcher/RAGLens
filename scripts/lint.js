import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOTS = ['src', 'scripts', 'test', 'public'];
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.html', '.css']);
const PUBLIC_SECRET_MARKERS = [
  'process.env',
  'RAGLENS_DATABASE_URL',
  'RAGLENS_OPENAI_API_KEY',
  'RAGLENS_OTEL_HEADERS',
  'databaseUrl',
  'apiKey',
  'localStorage'
];

export function lintText({ relativePath, text }) {
  const normalizedPath = normalizePath(relativePath);
  const lines = text.split(/\r?\n/);
  const findings = [];

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;

    if (isJavaScriptFile(normalizedPath)) {
      if (/\beval\s*\(/.test(line)) {
        addFinding(findings, normalizedPath, lineNumber, 'dynamic-code', 'Avoid dynamic code execution.');
      }
      if (/\bnew\s+Function\s*\(/.test(line)) {
        addFinding(findings, normalizedPath, lineNumber, 'dynamic-code', 'Avoid the Function constructor.');
      }
      if (/\bdocument\.write\s*\(/.test(line)) {
        addFinding(findings, normalizedPath, lineNumber, 'unsafe-dom', 'Avoid document.write in browser-facing code.');
      }
      if (/\.insertAdjacentHTML\s*\(/.test(line)) {
        addFinding(findings, normalizedPath, lineNumber, 'unsafe-dom', 'Avoid inserting unescaped HTML.');
      }
    }

    if (isTestFile(normalizedPath) && /\b(?:test|describe|it)\.only\s*\(/.test(line)) {
      addFinding(findings, normalizedPath, lineNumber, 'focused-test', 'Remove focused tests before publishing.');
    }

    if (isPublicFile(normalizedPath)) {
      for (const marker of PUBLIC_SECRET_MARKERS) {
        if (line.includes(marker)) {
          addFinding(findings, normalizedPath, lineNumber, 'public-secret-surface', `Browser assets must not reference ${marker}.`);
        }
      }
    }

    if (normalizedPath === 'public/app.js' && line.includes('.innerHTML') && !/\b(?:app|projectSelect)\.innerHTML\s*=/.test(line)) {
      addFinding(findings, normalizedPath, lineNumber, 'unsafe-rendering-regression', 'Only the audited top-level render targets may assign innerHTML.');
    }
  }

  if (normalizedPath === 'public/app.js') {
    if (!text.includes('function escapeHtml')) {
      addFinding(findings, normalizedPath, 1, 'escape-regression', 'Browser renderer must keep the escapeHtml helper.');
    }
    if (!text.includes('sessionStorage')) {
      addFinding(findings, normalizedPath, 1, 'token-storage-regression', 'Admin token storage must remain session-scoped.');
    }
  }

  return findings;
}

export async function runLint({ cwd = process.cwd(), roots = DEFAULT_ROOTS } = {}) {
  const files = [];
  for (const root of roots) {
    files.push(...await listSourceFiles(path.join(cwd, root), cwd));
  }

  const findings = [];
  for (const file of files) {
    const text = await readFile(path.join(cwd, file), 'utf8');
    findings.push(...lintText({ relativePath: file, text }));
  }

  return {
    ok: findings.length === 0,
    checkedFiles: files.length,
    findings
  };
}

async function listSourceFiles(root, cwd) {
  let rootInfo;
  try {
    rootInfo = await stat(root);
  } catch {
    return [];
  }

  if (rootInfo.isFile()) {
    return shouldLintFile(root) ? [normalizePath(path.relative(cwd, root))] : [];
  }

  const files = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) {
        continue;
      }
      files.push(...await listSourceFiles(fullPath, cwd));
      continue;
    }
    if (entry.isFile() && shouldLintFile(fullPath)) {
      files.push(normalizePath(path.relative(cwd, fullPath)));
    }
  }
  return files.sort();
}

function shouldLintFile(file) {
  return SOURCE_EXTENSIONS.has(path.extname(file));
}

function shouldSkipDirectory(name) {
  return ['node_modules', 'coverage', 'data', 'data-smoke'].includes(name);
}

function isJavaScriptFile(file) {
  return ['.js', '.mjs', '.cjs'].includes(path.extname(file));
}

function isTestFile(file) {
  return file.startsWith('test/') && isJavaScriptFile(file);
}

function isPublicFile(file) {
  return file.startsWith('public/');
}

function addFinding(findings, file, line, rule, message) {
  findings.push({ file, line, rule, message });
}

function normalizePath(file) {
  return file.replaceAll('\\', '/');
}

function isCliEntrypoint() {
  if (!process.argv[1]) {
    return false;
  }
  return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

if (isCliEntrypoint()) {
  const result = await runLint();
  if (!result.ok) {
    console.error('Lint failed:');
    for (const finding of result.findings) {
      console.error(`- ${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`);
    }
    process.exit(1);
  }

  console.log(`Lint passed (${result.checkedFiles} files).`);
}
