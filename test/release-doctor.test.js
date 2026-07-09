import assert from 'node:assert/strict';
import test from 'node:test';
import { createReleaseDoctorReport } from '../scripts/release-doctor.js';

test('release doctor treats missing external tools as warnings', async () => {
  const report = await createReleaseDoctorReport({
    cwd: process.cwd(),
    env: {},
    commandRunner: async () => ({ ok: false, stdout: '' })
  });

  assert.equal(report.ok, true);
  assert.equal(report.tools.git.available, false);
  assert.equal(report.tools.docker.available, false);
  assert.ok(report.checks.some((check) => check.label === 'package exposes lint' && check.ok));
  assert.ok(report.checks.some((check) => check.label === 'preflight runs lint' && check.ok));
  assert.ok(report.warnings.some((warning) => warning.includes('Git is unavailable')));
  assert.ok(report.warnings.some((warning) => warning.includes('Docker is unavailable')));
  assert.equal(report.errors.length, 0);
});

test('release doctor validates Postgres env without leaking database credentials', async () => {
  const cleanCommandRunner = async (command, args = []) => {
    if (command === 'git' && args[0] === 'ls-files') {
      return { ok: true, stdout: '' };
    }
    if (command === 'git' && args[0] === 'status') {
      return { ok: true, stdout: '' };
    }
    return { ok: true, stdout: `${command} version 1.0.0` };
  };
  const missingUrl = await createReleaseDoctorReport({
    cwd: process.cwd(),
    env: {
      RAGLENS_STORAGE_DRIVER: 'postgres'
    },
    commandRunner: cleanCommandRunner
  });
  const configured = await createReleaseDoctorReport({
    cwd: process.cwd(),
    env: {
      RAGLENS_STORAGE_DRIVER: 'postgres',
      RAGLENS_DATABASE_URL: 'postgres://raglens:super-secret-password@db.example.test/raglens'
    },
    commandRunner: cleanCommandRunner
  });

  assert.equal(missingUrl.ok, false);
  assert.ok(missingUrl.errors.some((error) => error.includes('RAGLENS_DATABASE_URL')));
  assert.equal(configured.ok, true);
  assert.equal(configured.storage.databaseHost, 'db.example.test');
  assert.equal(JSON.stringify(configured).includes('super-secret-password'), false);
});

test('strict release doctor fails when external proof tools are unavailable', async () => {
  const report = await createReleaseDoctorReport({
    cwd: process.cwd(),
    env: {},
    strict: true,
    commandRunner: async () => ({ ok: false, stdout: '' })
  });

  assert.equal(report.ok, false);
  assert.equal(report.strict, true);
  assert.ok(report.errors.some((error) => error.includes('Strict release mode requires Git')));
  assert.ok(report.errors.some((error) => error.includes('Strict release mode requires Docker')));
});
