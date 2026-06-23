import assert from 'node:assert/strict';
import test from 'node:test';

import { lintText, runLint } from '../scripts/lint.js';

test('lint flags focused tests without requiring external tooling', () => {
  const text = 'import test from "node:test";\n' + 'test' + '.only("case", () => {});\n';
  const findings = lintText({ relativePath: 'test/example.test.js', text });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'focused-test');
});

test('lint protects public assets from secret surfaces and persistent token storage', () => {
  const text = 'const token = window.' + 'localStorage' + '.getItem("token");\nconst url = "RAGLENS_DATABASE_URL";\n';
  const findings = lintText({ relativePath: 'public/app.js', text });

  assert.ok(findings.some((finding) => finding.rule === 'public-secret-surface'));
  assert.ok(findings.some((finding) => finding.rule === 'escape-regression'));
  assert.ok(findings.some((finding) => finding.rule === 'token-storage-regression'));
});

test('lint catches unsafe dynamic code and html insertion', () => {
  const text = [
    'const run = globalThis["ev" + "al"];',
    'run("1 + 1");',
    'document.body.insertAdjacent' + 'HTML("beforeend", value);',
    'const fn = new ' + 'Function("return value");'
  ].join('\n');
  const findings = lintText({ relativePath: 'src/example.js', text });

  assert.ok(findings.some((finding) => finding.rule === 'unsafe-dom'));
  assert.ok(findings.some((finding) => finding.rule === 'dynamic-code'));
});

test('lint passes the current repository', async () => {
  const result = await runLint({ cwd: process.cwd() });

  assert.equal(result.ok, true, result.findings.map((finding) => `${finding.file}:${finding.line} ${finding.message}`).join('\n'));
  assert.ok(result.checkedFiles > 20);
});
