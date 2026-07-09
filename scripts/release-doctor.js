import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export async function createReleaseDoctorReport(options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const commandRunner = options.commandRunner || defaultCommandRunner;
  const strict = options.strict === true;
  const report = {
    ok: true,
    strict,
    checkedAt: new Date().toISOString(),
    project: {
      cwd,
      name: '',
      version: ''
    },
    checks: [],
    tools: {},
    storage: safeStorageStatus(env),
    generatedDataDirs: [],
    warnings: [],
    errors: []
  };

  const packageJson = await readJson(path.join(cwd, 'package.json'));
  report.project.name = packageJson.name || '';
  report.project.version = packageJson.version || '';

  await checkRequiredFiles(report, cwd);
  checkPackageScripts(report, packageJson);
  await checkIgnoreRules(report, cwd);
  await checkExternalTools(report, commandRunner);
  await checkGeneratedDataDirs(report, cwd);
  await checkGitState(report, cwd, commandRunner);
  checkStorageEnv(report, env);
  checkStrictReleaseRules(report);

  report.ok = report.errors.length === 0;
  return report;
}

function checkPackageScripts(report, packageJson) {
  const scripts = packageJson.scripts || {};
  for (const script of [
    'preflight',
    'doctor',
    'release:audit',
    'lint',
    'integration:check',
    'service:check',
    'browser:check',
    'docker:check',
    'docker:runtime',
    'api:contract',
    'postgres:contract',
    'eval'
  ]) {
    addCheck(report, `package exposes ${script}`, Boolean(scripts[script]));
  }

  addCheck(report, 'preflight runs release audit', String(scripts.preflight || '').includes('npm run release:audit'));
  addCheck(report, 'preflight runs lint', String(scripts.preflight || '').includes('npm run lint'));
  addCheck(report, 'preflight runs browser check', String(scripts.preflight || '').includes('npm run browser:check'));
  addCheck(report, 'preflight runs Docker runtime check', String(scripts.preflight || '').includes('npm run docker:runtime'));
}

async function checkRequiredFiles(report, cwd) {
  for (const file of [
    'README.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'LICENSE',
    '.env.example',
    '.gitignore',
    '.dockerignore',
    'Dockerfile',
    'docker-compose.yml',
    'docs/assets/dashboard.png',
    'docs/api/openapi.json',
    'docs/database/postgres-pgvector.sql',
    '.github/workflows/ci.yml',
    '.github/workflows/rag-evals.yml'
  ]) {
    addCheck(report, `${file} exists`, await fileExists(path.join(cwd, file)));
  }
}

async function checkIgnoreRules(report, cwd) {
  const gitignore = await readText(path.join(cwd, '.gitignore'));
  const dockerignore = await readText(path.join(cwd, '.dockerignore'));

  for (const entry of ['data/', 'data-*', '.env', 'node_modules/']) {
    addCheck(report, `.gitignore excludes ${entry}`, gitignore.includes(entry));
  }
  for (const entry of ['data/', 'data-*/', '.env', 'node_modules/', '.git/']) {
    addCheck(report, `.dockerignore excludes ${entry}`, dockerignore.includes(entry));
  }
}

async function checkExternalTools(report, commandRunner) {
  report.tools.git = await commandStatus('git', ['--version'], commandRunner);
  report.tools.docker = await commandStatus('docker', ['--version'], commandRunner);

  if (!report.tools.git.available) {
    report.warnings.push('Git is unavailable, so commit status and tracked generated files could not be checked.');
  }
  if (!report.tools.docker.available) {
    report.warnings.push('Docker is unavailable, so the Docker runtime check will skip locally.');
  }
}

async function checkGitState(report, cwd, commandRunner) {
  report.git = {
    trackedGeneratedData: [],
    dirtyReleaseFiles: []
  };

  if (!report.tools.git?.available) {
    return;
  }

  const tracked = await commandRunner('git', ['ls-files', '--', 'data', 'data-*'], { cwd });
  if (tracked.ok) {
    report.git.trackedGeneratedData = String(tracked.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  const status = await commandRunner('git', [
    'status',
    '--porcelain',
    '--',
    'README.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'package.json',
    '.env.example',
    '.gitignore',
    '.dockerignore',
    'Dockerfile',
    'docker-compose.yml',
    '.github',
    'docs',
    'public',
    'scripts',
    'src',
    'test'
  ], { cwd });
  if (status.ok) {
    report.git.dirtyReleaseFiles = String(status.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  if (report.git.trackedGeneratedData.length) {
    report.errors.push(`Generated data files are tracked by git: ${report.git.trackedGeneratedData.join(', ')}`);
  }
  if (report.git.dirtyReleaseFiles.length) {
    report.warnings.push(`${report.git.dirtyReleaseFiles.length} release-critical file(s) have uncommitted changes.`);
  }
}

async function checkGeneratedDataDirs(report, cwd) {
  let entries = [];
  try {
    entries = await readdir(cwd, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^data(?:$|-)/.test(entry.name)) {
      continue;
    }
    const absolutePath = path.join(cwd, entry.name);
    const sizeBytes = await directorySize(absolutePath);
    report.generatedDataDirs.push({
      name: entry.name,
      sizeBytes
    });
  }

  if (report.generatedDataDirs.length) {
    report.warnings.push('Generated data directories are present. They are ignored by git/docker, but confirm they are not staged before publishing.');
  }
}

function checkStrictReleaseRules(report) {
  if (!report.strict) {
    return;
  }
  if (!report.tools.git?.available) {
    report.errors.push('Strict release mode requires Git so tracked and dirty files can be checked.');
  }
  if (!report.tools.docker?.available) {
    report.errors.push('Strict release mode requires Docker so the runtime check can be run.');
  }
  if (report.generatedDataDirs.length) {
    report.errors.push('Strict release mode requires generated data directories to be removed before publishing archives.');
  }
  if (report.git?.dirtyReleaseFiles?.length) {
    report.errors.push('Strict release mode requires release-critical files to be committed or intentionally excluded.');
  }
}

function checkStorageEnv(report, env) {
  const driver = String(env.RAGLENS_STORAGE_DRIVER || 'json').toLowerCase();
  if (!['json', 'postgres'].includes(driver)) {
    report.errors.push('RAGLENS_STORAGE_DRIVER must be json or postgres.');
  }
  if (driver === 'postgres' && !env.RAGLENS_DATABASE_URL) {
    report.errors.push('RAGLENS_STORAGE_DRIVER=postgres requires RAGLENS_DATABASE_URL.');
  }
}

function safeStorageStatus(env) {
  const driver = String(env.RAGLENS_STORAGE_DRIVER || 'json').toLowerCase();
  const databaseUrl = String(env.RAGLENS_DATABASE_URL || '');
  return {
    driver,
    postgresConfigured: driver === 'postgres' && Boolean(databaseUrl),
    databaseHost: databaseUrl ? safeUrlHost(databaseUrl) : ''
  };
}

async function commandStatus(command, args, commandRunner) {
  const result = await commandRunner(command, args);
  return {
    available: Boolean(result.ok),
    version: result.ok ? String(result.stdout || '').trim().split(/\r?\n/)[0] : ''
  };
}

async function defaultCommandRunner(command, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 5_000,
      cwd: options.cwd,
      windowsHide: true
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stdout: '', error: error.message };
  }
}

async function directorySize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return total;
  }

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(absolutePath);
    } else if (entry.isFile()) {
      try {
        total += (await stat(absolutePath)).size;
      } catch {
        // Ignore transient files while calculating an advisory size.
      }
    }
  }

  return total;
}

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readText(filePath));
}

async function readText(filePath) {
  return readFile(filePath, 'utf8').catch(() => '');
}

function addCheck(report, label, ok) {
  report.checks.push({ label, ok });
  if (!ok) {
    report.errors.push(label);
  }
}

function safeUrlHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return 'invalid-url';
  }
}

function printTextReport(report) {
  console.log(`RAGLens release doctor: ${report.ok ? 'ok' : 'needs attention'}`);
  console.log(`Project: ${report.project.name}@${report.project.version}`);
  console.log(`Checks: ${report.checks.filter((check) => check.ok).length}/${report.checks.length}`);
  console.log(`Git: ${report.tools.git.available ? report.tools.git.version : 'unavailable'}`);
  console.log(`Docker: ${report.tools.docker.available ? report.tools.docker.version : 'unavailable'}`);
  console.log(`Storage: ${report.storage.driver}${report.storage.databaseHost ? ` (${report.storage.databaseHost})` : ''}`);

  if (report.generatedDataDirs.length) {
    console.log('Generated data dirs:');
    for (const item of report.generatedDataDirs) {
      console.log(`- ${item.name}: ${formatBytes(item.sizeBytes)}`);
    }
  }
  if (report.warnings.length) {
    console.log('Warnings:');
    for (const warning of report.warnings) {
      console.log(`- ${warning}`);
    }
  }
  if (report.errors.length) {
    console.log('Errors:');
    for (const error of report.errors) {
      console.log(`- ${error}`);
    }
  }
}

function formatBytes(value) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const report = await createReleaseDoctorReport({
    strict: process.argv.includes('--strict')
  });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTextReport(report);
  }
  process.exit(report.ok ? 0 : 1);
}
