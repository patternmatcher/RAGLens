const state = {
  view: 'dashboard',
  data: null,
  activeRun: null,
  compare: null,
  busy: false,
  jobPollTimer: null,
  selectedProjectId: null
};

const viewTitles = {
  dashboard: ['Demo RAG workspace', 'Dashboard'],
  documents: ['Corpus', 'Documents'],
  workbench: ['Query pipeline', 'Workbench'],
  inspector: ['Run detail', 'Inspector'],
  compare: ['Regression view', 'Compare'],
  evals: ['Saved questions', 'Eval Set'],
  settings: ['Project controls', 'Settings']
};

const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
const ADMIN_TOKEN_KEY = 'raglens.adminToken';
const DOCUMENT_TEXT_CHAR_LIMIT = 200_000;
const TEXT_FILE_BYTE_LIMIT = 260_000;
const PDF_FILE_BYTE_LIMIT = 1_000_000;
const projectSelect = document.querySelector('#project-select');

onAll('[data-view]', 'click', (button) => {
  if (state.busy) {
    return;
  }
  state.view = button.dataset.view;
  state.compare = null;
  setActiveNav();
  render();
});

onOne('#refresh-button', 'click', () => runSafely(loadState));
onOne('#new-project-button', 'click', () => runSafely(createProject));
onElement(projectSelect, 'change', () => runSafely(() => switchProject(projectSelect.value)));
onOne('#reset-demo-button', 'click', () => runSafely(async () => {
  if (!confirm('Reset the local RAGLens demo workspace?')) {
    return;
  }
  await api('/api/demo/reset', { method: 'POST' });
  state.activeRun = null;
  await loadState();
  showToast('Demo workspace reset.');
}));
window.addEventListener('hashchange', () => runSafely(() => loadState()));

try {
  await loadState();
} catch (error) {
  showToast(error.message || 'Unable to load RAGLens.');
  app.innerHTML = `<div class="empty-state">Unable to load RAGLens.</div>`;
}

async function loadState() {
  const statePath = state.selectedProjectId
    ? `/api/state?projectId=${encodeURIComponent(state.selectedProjectId)}`
    : '/api/state';
  state.data = await api(statePath);
  state.selectedProjectId = state.data.activeProjectId;
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  const sharedRunId = hashParams.get('run');
  const sharedProjectId = hashParams.get('projectId') || hashParams.get('project');
  if (sharedRunId) {
    try {
      await selectRun(sharedRunId, { renderAfter: false, shared: true, projectId: sharedProjectId });
      state.view = 'inspector';
    } catch (error) {
      history.replaceState(null, '', location.pathname);
      state.activeRun = null;
      showToast(error.message || 'Shared run was not found.');
    }
  } else if (state.activeRun && !state.data.runs.some((run) => run.id === state.activeRun.id)) {
    state.activeRun = null;
  }

  if (!sharedRunId && !state.activeRun && state.data.runs.length) {
    await selectRun(state.data.runs[0].id, { renderAfter: false });
  }
  render();
}

async function api(path, options = {}) {
  let response;
  const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
  try {
    response = await fetch(path, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-RAGLens-Token': token } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch (error) {
    throw new Error(`Network error: ${error.message}`);
  }

  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && !options.retryAfterTokenPrompt) {
    const adminToken = prompt('Admin token required.');
    if (adminToken) {
      sessionStorage.setItem(ADMIN_TOKEN_KEY, adminToken.trim());
      return api(path, { ...options, retryAfterTokenPrompt: true });
    }
  }
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function onAll(selector, eventName, handler, root = document) {
  root.querySelectorAll(selector).forEach((element) => {
    element.addEventListener(eventName, (event) => handler(element, event));
  });
}

function onOne(selector, eventName, handler, root = document) {
  onElement(root.querySelector(selector), eventName, handler);
}

function onElement(element, eventName, handler) {
  if (element) {
    element.addEventListener(eventName, handler);
  }
}

function setActiveNav() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle('active', active);
    if (active) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  });
}

function render() {
  setActiveNav();
  document.body.classList.toggle('is-busy', state.busy);
  app.setAttribute('aria-busy', String(state.busy));
  const [eyebrow, title] = viewTitles[state.view] || viewTitles.dashboard;
  document.querySelector('#page-eyebrow').textContent = activeProject()?.name || eyebrow;
  document.querySelector('#page-title').textContent = title;
  document.querySelector('#refresh-button').disabled = state.busy;
  document.querySelector('#reset-demo-button').disabled = state.busy;
  document.querySelector('#new-project-button').disabled = state.busy;
  projectSelect.disabled = state.busy || !state.data;
  updateProjectControls();

  if (!state.data) {
    app.innerHTML = `<div class="empty-state">Loading RAGLens...</div>`;
    return;
  }

  const views = {
    dashboard: renderDashboard,
    documents: renderDocuments,
    workbench: renderWorkbench,
    inspector: renderInspector,
    compare: renderCompare,
    evals: renderEvals,
    settings: renderSettings
  };

  app.innerHTML = views[state.view]();
  bindViewEvents();
  setBusyUi();
  scheduleIngestionRefresh();
}

function activeProject() {
  return state.data?.projects?.find((project) => project.id === state.data.activeProjectId) || state.data?.projects?.[0] || null;
}

function currentProjectId() {
  return state.data?.activeProjectId || activeProject()?.id || '';
}

function withProjectBody(body = {}) {
  const projectId = currentProjectId();
  return projectId
    ? {
        ...body,
        projectId
      }
    : body;
}

function withProjectParam(path) {
  const projectId = currentProjectId();
  if (!projectId) {
    return path;
  }
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}projectId=${encodeURIComponent(projectId)}`;
}

function updateProjectControls() {
  const project = activeProject();
  if (state.data) {
    projectSelect.innerHTML = state.data.projects
      .map((item) => `<option value="${escapeAttr(item.id)}" ${item.id === state.data.activeProjectId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`)
      .join('');
  }
  if (project && state.view === 'dashboard') {
    document.querySelector('#page-eyebrow').textContent = project.name;
  }
}

function renderDashboard() {
  const latest = state.activeRun;
  const docs = state.data.documents.length;
  const chunks = state.data.chunks.length;
  const runs = state.data.runs.length;
  const faithfulness = latest?.evaluation.metrics.faithfulness ?? 0;
  const warnings = state.data.runs.flatMap((run) => run.warnings || []).slice(0, 5);

  return `
    <div class="grid">
      <div class="metrics-grid">
        ${metricCard('Documents', docs, 'indexed sources')}
        ${metricCard('Chunks', chunks, 'retrievable units')}
        ${metricCard('Runs', runs, 'saved traces')}
        ${metricCard('Faithfulness', pct(faithfulness), latest ? 'latest run' : 'no runs yet')}
      </div>

      <div class="grid two">
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">Latest Run</h2>
              <p class="panel-subtitle">${latest ? escapeHtml(latest.question) : 'No query run selected.'}</p>
            </div>
            <button class="small-button" data-go="workbench">Open Workbench</button>
          </div>
          ${latest ? renderMetricRows(latest.evaluation.metrics) : emptyState('Run a question to populate the inspector.')}
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">Recent Runs</h2>
              <p class="panel-subtitle">${runs} stored traces</p>
            </div>
          </div>
          ${renderRunList(state.data.runs.slice(0, 5))}
        </section>
      </div>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Failure Signals</h2>
            <p class="panel-subtitle">${warnings.length ? 'Warnings detected in recent runs' : 'No warnings in recent runs'}</p>
          </div>
        </div>
        ${warnings.length ? `<div class="badge-row">${warnings.map(renderWarningBadge).join('')}</div>` : `<div class="badge-row"><span class="badge good">clean recent traces</span></div>`}
      </section>
    </div>
  `;
}

function renderDocuments() {
  return `
    <div class="grid two">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Index Document</h2>
            <p class="panel-subtitle">TXT, Markdown, CSV, JSON, logs</p>
          </div>
        </div>
        <div class="badge-row" style="margin-bottom: 12px;">
          <span class="badge">local only</span>
          <span class="badge">secret redaction</span>
          <span class="badge">200k char limit</span>
          <span class="badge">1MB PDF limit</span>
        </div>
        <form class="form-grid" id="document-form">
          <div class="field">
            <label for="doc-title">Title</label>
            <input id="doc-title" name="title" placeholder="Runbook, incident review, policy note" required />
          </div>
          <div class="field">
            <label for="doc-source">Source type</label>
            <select id="doc-source" name="sourceType">
              <option value="markdown">Markdown</option>
              <option value="text">Text</option>
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
              <option value="log">Log</option>
              <option value="pdf">PDF</option>
            </select>
          </div>
          <div class="grid two">
            <div class="field">
              <label for="doc-collection">Collection</label>
              <input id="doc-collection" name="collection" placeholder="policies" />
            </div>
            <div class="field">
              <label for="doc-department">Department</label>
              <input id="doc-department" name="department" placeholder="finance" />
            </div>
          </div>
          <div class="grid two">
            <div class="field">
              <label for="doc-version">Version</label>
              <input id="doc-version" name="version" placeholder="v3" />
            </div>
            <div class="field">
              <label for="doc-tags">Tags</label>
              <input id="doc-tags" name="tags" placeholder="current, approved" />
            </div>
          </div>
          <div class="field">
            <label for="doc-file">File</label>
            <input id="doc-file" type="file" accept=".txt,.md,.markdown,.csv,.json,.log,.pdf,application/pdf" />
          </div>
          <div class="field">
            <label for="doc-text">Text</label>
            <textarea id="doc-text" name="text" required></textarea>
          </div>
        <div class="button-row">
            <button class="primary-button" type="submit">Index Now</button>
            <button class="small-button" id="queue-document-button" type="button">Queue</button>
          </div>
        </form>
        ${renderIngestionJobs()}
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Indexed Corpus</h2>
            <p class="panel-subtitle">${state.data.documents.length} documents, ${state.data.chunks.length} chunks</p>
          </div>
          ${state.data.documents.length ? '<button class="small-button" id="reindex-documents-button" type="button">Reindex</button>' : ''}
        </div>
        ${renderDocumentList()}
      </section>
    </div>
  `;
}

function renderWorkbench() {
  const suggested = state.data.evalQuestions || [];
  return `
    <div class="grid two">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Query</h2>
            <p class="panel-subtitle">${state.data.chunks.length} indexed chunks available</p>
          </div>
        </div>
        <form class="form-grid" id="query-form">
          <div class="field">
            <label for="question">Question</label>
            <textarea id="question" name="question" required>${escapeHtml(suggested[0]?.question || 'What caused the unsupported delivery estimates?')}</textarea>
          </div>
          <div class="grid two">
            ${rangeControl('topK', 'Top-k', 1, 12, state.data.settings.topK)}
            ${rangeControl('maxClaims', 'Claims', 1, 6, state.data.settings.maxClaims)}
          </div>
          <div class="grid two">
            ${rangeControl('candidateDepth', 'Candidates', 4, 100, state.data.settings.candidateDepth || 24, 4)}
            ${rangeControl('parentContextMaxTokens', 'Context budget', 200, 4000, state.data.settings.parentContextMaxTokens || 1200, 200)}
          </div>
          <div class="grid two">
            ${rangeControl('temperature', 'Temperature', 0, 1, state.data.settings.temperature, 0.05)}
            <div class="field">
              <label for="retrievalMode">Retrieval</label>
              <select id="retrievalMode" name="retrievalMode">
                ${optionList(['hybrid', 'keyword', 'vector'], state.data.settings.retrievalMode)}
              </select>
            </div>
          </div>
          <div class="grid two">
            <label class="toggle-row"><input type="checkbox" name="rerank" checked /> Rerank candidates</label>
            <label class="toggle-row"><input type="checkbox" name="parentContext" /> Include parent context</label>
          </div>
          <div class="grid two">
            <div class="field">
              <label for="filterCollection">Collection filter</label>
              <input id="filterCollection" name="filterCollection" placeholder="all collections" />
            </div>
            <div class="field">
              <label for="filterDepartment">Department filter</label>
              <input id="filterDepartment" name="filterDepartment" placeholder="all departments" />
            </div>
          </div>
          <div class="field">
            <label for="filterTags">Tag filter</label>
            <input id="filterTags" name="filterTags" placeholder="comma-separated tags" />
          </div>
          <div class="grid two">
            <div class="field">
              <label for="model">Model</label>
              <input id="model" name="model" value="${escapeAttr(state.data.settings.model)}" />
            </div>
            <div class="field">
              <label for="provider">Provider</label>
              <select id="provider" name="provider">
                ${optionList(['local', 'openai-compatible'], state.data.settings.provider)}
              </select>
            </div>
          </div>
          <div class="field">
            <label for="promptTemplate">Prompt template</label>
            <textarea id="promptTemplate" name="promptTemplate">${escapeHtml(state.data.settings.promptTemplate)}</textarea>
          </div>
          <div class="button-row">
            <button class="primary-button" type="submit">Run Inspection</button>
            ${suggested.map((item) => `<button class="small-button" type="button" data-question="${escapeAttr(item.question)}">${escapeHtml(item.question)}</button>`).join('')}
          </div>
        </form>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Run History</h2>
            <p class="panel-subtitle">${state.data.runs.length} saved traces</p>
          </div>
        </div>
        ${renderRunList(state.data.runs)}
      </section>
    </div>
    <div class="grid" style="margin-top: 16px;">
      ${state.activeRun ? renderRunDetail(state.activeRun) : ''}
    </div>
  `;
}

function renderInspector() {
  if (!state.activeRun) {
    return emptyState('Select a run from Workbench or create a new inspection.');
  }
  return renderRunDetail(state.activeRun);
}

function renderCompare() {
  const runs = state.data.runs;
  if (runs.length < 2) {
    return emptyState('Run at least two questions to compare traces.');
  }

  const left = state.compare?.left?.id || runs[1]?.id || runs[0].id;
  const right = state.compare?.right?.id || runs[0].id;
  const options = runs.map((run) => `<option value="${run.id}">${escapeHtml(formatRunOption(run))}</option>`).join('');

  return `
    <div class="grid">
      <section class="panel">
        <div class="split-select">
          <div class="field">
            <label for="compare-left">Baseline</label>
            <select id="compare-left">${options}</select>
          </div>
          <div class="field">
            <label for="compare-right">Candidate</label>
            <select id="compare-right">${options}</select>
          </div>
        </div>
        <div class="button-row" style="margin-top: 12px;">
          <button class="primary-button" id="compare-button" type="button">Compare Runs</button>
        </div>
      </section>
      ${state.compare ? renderComparison(state.compare) : ''}
    </div>
  `.replace(`id="compare-left"`, `id="compare-left" data-value="${left}"`).replace(`id="compare-right"`, `id="compare-right" data-value="${right}"`);
}

function renderEvals() {
  const questions = state.data.evalQuestions || [];
  const sourceOptions = state.data.documents
    .map((document) => `<option value="${escapeAttr(document.title)}"></option>`)
    .join('');
  return `
    <div class="grid two">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Saved Questions</h2>
            <p class="panel-subtitle">${questions.length} checks</p>
          </div>
          <button class="small-button" id="run-evals-button" type="button" ${questions.length ? '' : 'disabled'}>Run All</button>
        </div>
        <form class="form-grid compact-form" id="eval-form">
          <div class="field">
            <label for="eval-question">Question</label>
            <textarea id="eval-question" name="question" required placeholder="What should this RAG system answer from the indexed sources?"></textarea>
          </div>
          <div class="field">
            <label for="eval-source">Expected source</label>
            <input id="eval-source" name="expectedSource" list="eval-source-options" placeholder="Document title expected in top-k" required />
            <datalist id="eval-source-options">${sourceOptions}</datalist>
          </div>
          <div class="field">
            <label for="eval-answer">Expected answer</label>
            <textarea id="eval-answer" name="expectedAnswer" placeholder="Optional reviewer note or target answer"></textarea>
          </div>
          <div class="button-row">
            <button class="primary-button" type="submit">Save Eval Check</button>
          </div>
        </form>
        <div class="run-list">
          ${questions.length
            ? questions.map(
                (item) => `
              <div class="run-item">
                <p class="item-title">${escapeHtml(item.question)}</p>
                <div class="item-meta">${escapeHtml(item.expectedSource)}</div>
                ${item.expectedAnswer ? `<div class="chunk-text">${escapeHtml(item.expectedAnswer)}</div>` : ''}
                <div class="button-row">
                  <button class="small-button" type="button" data-eval-question="${escapeAttr(item.question)}">Run</button>
                  <button class="small-button" type="button" data-delete-eval="${escapeAttr(item.id)}">Delete</button>
                </div>
              </div>`
              ).join('')
            : emptyState('Save an eval check to run regression questions.')}
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Latest Result</h2>
            <p class="panel-subtitle">${state.activeRun ? escapeHtml(state.activeRun.question) : 'No run selected'}</p>
          </div>
        </div>
        ${state.activeRun ? renderMetricRows(state.activeRun.evaluation.metrics) : emptyState('Run an eval question.')}
      </section>
    </div>
  `;
}

function renderSettings() {
  const settings = state.data.settings;
  const providerState = state.data.providers || {};
  const storageState = state.data.storage || {};
  const otlpState = state.data.observability?.otlp || {};
  const pdfParser = state.data.parsers?.pdf || {};
  const liveConfigured = Boolean(providerState.openaiCompatible?.configured);
  const costConfigured = Boolean(providerState.costRates?.configured);
  const hasAdminToken = Boolean(sessionStorage.getItem(ADMIN_TOKEN_KEY));
  return `
    <div class="grid two">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">RAG Defaults</h2>
            <p class="panel-subtitle">Applied to new inspections and new chunks</p>
          </div>
        </div>
        <form class="form-grid" id="settings-form">
          <div class="grid two">
            ${rangeControl('topK', 'Default top-k', 1, 20, settings.topK)}
            ${rangeControl('maxClaims', 'Default claims', 1, 8, settings.maxClaims)}
          </div>
          <div class="grid two">
            ${rangeControl('chunkTokens', 'Chunk tokens', 40, 2000, settings.chunkTokens)}
            ${rangeControl('overlapTokens', 'Overlap tokens', 0, 500, settings.overlapTokens)}
          </div>
          <div class="grid two">
            ${rangeControl('temperature', 'Temperature', 0, 1, settings.temperature, 0.05)}
            <div class="field">
              <label for="settings-retrievalMode">Retrieval mode</label>
              <select id="settings-retrievalMode" name="retrievalMode">
                ${optionList(['hybrid', 'keyword', 'vector'], settings.retrievalMode)}
              </select>
            </div>
          </div>
          <div class="grid two">
            <div class="field">
              <label for="settings-provider">Provider</label>
              <select id="settings-provider" name="provider">
                ${optionList(['local', 'openai-compatible'], settings.provider)}
              </select>
            </div>
            <div class="field">
              <label for="settings-model">Model</label>
              <input id="settings-model" name="model" value="${escapeAttr(settings.model)}" />
            </div>
          </div>
          <div class="field">
            <label for="settings-promptTemplate">Prompt template</label>
            <textarea id="settings-promptTemplate" name="promptTemplate">${escapeHtml(settings.promptTemplate)}</textarea>
          </div>
          <label class="toggle-row"><input type="checkbox" name="promptLoggingEnabled" ${settings.promptLoggingEnabled ? 'checked' : ''} /> Prompt logging</label>
          <label class="toggle-row"><input type="checkbox" name="redactionEnabled" ${settings.redactionEnabled ? 'checked' : ''} /> Secret redaction</label>
          <label class="toggle-row"><input type="checkbox" name="rerank" ${settings.rerank ? 'checked' : ''} /> Local reranker</label>
          <div class="button-row">
            <button class="primary-button" type="submit">Save Settings</button>
          </div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Project</h2>
            <p class="panel-subtitle">${escapeHtml(activeProject()?.description || 'Local RAG inspection workspace')}</p>
          </div>
        </div>
        <div class="metric-row"><div class="item-meta">Provider</div><strong>${escapeHtml(settings.provider)}</strong><span></span></div>
        <div class="metric-row"><div class="item-meta">Model</div><strong>${escapeHtml(settings.model)}</strong><span></span></div>
        <div class="metric-row"><div class="item-meta">Retrieval</div><strong>${escapeHtml(settings.retrievalMode)}</strong><span></span></div>
        <div class="metric-row"><div class="item-meta">Prompt logs</div><strong>${settings.promptLoggingEnabled ? 'on' : 'off'}</strong><span></span></div>
        <div class="metric-row"><div class="item-meta">Live provider</div><strong>${liveConfigured ? 'configured' : 'not configured'}</strong><span></span></div>
        <div class="metric-row"><div class="item-meta">Provider host</div><strong>${escapeHtml(providerState.openaiCompatible?.endpointHost || 'local only')}</strong><span></span></div>
        <div class="metric-row"><div class="item-meta">Cost rates</div><strong>${costConfigured ? 'configured' : 'not configured'}</strong><span></span></div>
        <div class="metric-row"><div class="item-meta">Input rate</div><strong>${formatUsd(providerState.costRates?.inputUsdPer1MTokens || 0)} / 1M</strong><span></span></div>
        <div class="metric-row"><div class="item-meta">Output rate</div><strong>${formatUsd(providerState.costRates?.outputUsdPer1MTokens || 0)} / 1M</strong><span></span></div>
        <div class="metric-row"><div class="item-meta">Storage</div><strong>${escapeHtml(storageState.driver || 'json')}</strong><span></span></div>
        <div class="metric-row"><div class="item-meta">Postgres</div><strong>${storageState.postgres?.configured ? 'configured' : 'not configured'}</strong><span></span></div>
        <div class="metric-row"><div class="item-meta">OTLP export</div><strong>${otlpState.configured ? 'configured' : 'not configured'}</strong><span></span></div>
        <div class="metric-row"><div class="item-meta">OTLP host</div><strong>${escapeHtml(otlpState.endpointHost || 'none')}</strong><span></span></div>
        <div class="metric-row"><div class="item-meta">OTLP headers</div><strong>${Number(otlpState.headerCount || 0)}</strong><span></span></div>
        <div class="metric-row"><div class="item-meta">PDF parser</div><strong>${escapeHtml(pdfParser.mode || 'internal-fallback')}</strong><span></span></div>
        <div class="metric-row"><div class="item-meta">PDF timeout</div><strong>${Number(pdfParser.timeoutMs || 0)}ms</strong><span></span></div>
        <div class="metric-row"><div class="item-meta">Admin token</div><strong>${hasAdminToken ? 'set' : 'not set'}</strong><span></span></div>
        <div class="button-row" style="margin-top: 14px;">
          <button class="small-button" id="set-admin-token" type="button">Set Admin Token</button>
          <button class="small-button" id="clear-admin-token" type="button">Clear Token</button>
        </div>
      </section>
    </div>
  `;
}

function renderRunDetail(run) {
  return `
    <div class="grid">
      <div class="metrics-grid">
        ${metricCard('Retrieval', pct(run.evaluation.metrics.retrievalConfidence), 'confidence')}
        ${metricCard('Hit Rate', pct(run.evaluation.metrics.hitRateAtK), 'top-k')}
        ${metricCard('MRR', pct(run.evaluation.metrics.mrr), 'first relevant result')}
        ${metricCard('NDCG', pct(run.evaluation.metrics.ndcgAtK), 'ranking quality')}
        ${metricCard('Faithfulness', pct(run.evaluation.metrics.faithfulness), 'claim support')}
        ${metricCard('Citations', pct(run.evaluation.metrics.citationCoverage), 'coverage')}
        ${metricCard('Latency', `${run.latencyMs}ms`, run.config.mode || 'pipeline')}
        ${metricCard('Tokens', run.usage?.totalTokens || 0, `${formatUsd(run.usage?.estimatedCostUsd || 0)} est.`)}
      </div>

      <div class="grid two">
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">Answer</h2>
              <p class="panel-subtitle">${escapeHtml(run.question)}</p>
            </div>
            <div class="button-row">
              <button class="small-button" type="button" data-copy-share="${run.id}">Copy Share Link</button>
              <button class="small-button" type="button" data-download-otel="${run.id}">OTel JSON</button>
              <button class="small-button" type="button" data-download-bundle="${run.id}">Run Bundle</button>
            </div>
          </div>
          ${run.answer?.abstained || run.retrieval?.abstained ? '<div class="answer-box"><strong>Answer withheld.</strong> The available evidence did not meet the retrieval policy.</div>' : ''}
          <div class="answer-box">${escapeHtml(run.answer.text)}</div>
          <div class="source-heatmap" title="Claim support heatmap" aria-label="${escapeAttr(heatmapSummary(run.evaluation.claims))}">
            <span class="sr-only">${escapeHtml(heatmapSummary(run.evaluation.claims))}</span>
            ${run.evaluation.claims.map(renderHeatmapCell).join('')}
          </div>
          ${renderSourceUsageMatrix(run)}
          <div class="claim-list" style="margin-top: 12px;">
            ${run.evaluation.claims.map(renderClaim).join('')}
          </div>
          <form class="feedback-form" data-feedback-run="${run.id}">
            <div class="button-row">
              <button class="small-button" name="rating" value="up" type="submit">Thumbs Up</button>
              <button class="small-button" name="rating" value="down" type="submit">Thumbs Down</button>
              <input name="note" placeholder="Optional note or expected answer" />
            </div>
          </form>
        </section>
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">Trace</h2>
              <p class="panel-subtitle">${new Date(run.createdAt).toLocaleString()}</p>
            </div>
          </div>
          ${renderTrace(run.trace)}
          <div class="answer-box" style="margin-top: 12px;">${escapeHtml(run.evaluation.failureSummary)}</div>
          ${run.warnings?.length ? `<div class="badge-row" style="margin-top: 14px;">${run.warnings.map(renderWarningBadge).join('')}</div>` : ''}
        </section>
      </div>

      <div class="grid two">
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">Query Rewrite</h2>
              <p class="panel-subtitle">${escapeHtml(run.config.retrievalMode)} retrieval, ${escapeHtml(run.config.provider)} / ${escapeHtml(run.config.model)}</p>
            </div>
          </div>
          <div class="chunk-text">${escapeHtml(run.query?.rewritten || run.question)}</div>
          ${run.query?.expansions?.length ? `<div class="badge-row" style="margin-top: 10px;">${run.query.expansions.map((item) => `<span class="badge">${escapeHtml(item)}</span>`).join('')}</div>` : ''}
          ${run.query?.subqueries?.length ? `<div class="item-meta" style="margin-top: 10px;">${escapeHtml(run.query.subqueries.join(' / '))}</div>` : ''}
        </section>
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">Prompt</h2>
              <p class="panel-subtitle">${run.prompt ? 'logged' : 'logging disabled'}</p>
            </div>
          </div>
          <div class="chunk-text">${escapeHtml(run.prompt?.text || 'Prompt logging disabled for this run.')}</div>
        </section>
      </div>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Retrieval Pipeline</h2>
            <p class="panel-subtitle">Candidate generation through prompt context</p>
          </div>
        </div>
        ${renderRetrievalStages(run.retrieval?.stages || [])}
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Retrieved Chunks</h2>
            <p class="panel-subtitle">Top-${run.config.topK}, ${run.queryTerms.length} query terms</p>
          </div>
        </div>
        <div class="chunk-list">
          ${run.retrieved.map((item) => renderChunk(item, run.queryTerms)).join('')}
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Usage</h2>
            <p class="panel-subtitle">Latency and token accounting</p>
          </div>
        </div>
        ${renderUsage(run)}
      </section>
    </div>
  `;
}

function renderMetricRows(metrics) {
  const rows = [
    ['Retrieval confidence', metrics.retrievalConfidence],
    ['Context relevance', metrics.contextRelevance],
    ['Faithfulness', metrics.faithfulness],
    ['Citation coverage', metrics.citationCoverage],
    ['Answer focus', metrics.answerFocus],
    ['Hit rate@k', metrics.hitRateAtK],
    ['NDCG@k', metrics.ndcgAtK]
  ];

  if (metrics.evalAvailable) {
    rows.push(['Precision@k', metrics.precisionAtK], ['Recall@k', metrics.recallAtK], ['MRR', metrics.mrr]);
  }

  rows.push(['Redundancy', metrics.redundancy, true]);

  return rows
    .map(([label, value, inverse]) => {
      const tone = metricTone(value, inverse);
      return `
        <div class="metric-row">
          <div class="item-meta">${label}</div>
          <div class="bar ${tone}"><span style="width:${Math.round(value * 100)}%"></span></div>
          <strong>${pct(value)}</strong>
        </div>
      `;
    })
    .join('');
}

function renderRunList(runs) {
  if (!runs.length) {
    return emptyState('No runs yet.');
  }

  return `
    <div class="run-list">
      ${runs
        .map(
          (run) => `
          <button class="run-item ${state.activeRun?.id === run.id ? 'active' : ''}" data-run-id="${run.id}" ${state.activeRun?.id === run.id ? 'aria-current="true"' : ''}>
            <span class="item-title">${escapeHtml(run.question)}</span>
            <span class="item-meta">${new Date(run.createdAt).toLocaleString()} / ${run.latencyMs}ms</span>
            <span class="badge-row">
              <span class="badge ${badgeTone(run.metrics.faithfulness)}">faith ${pct(run.metrics.faithfulness)}</span>
              <span class="badge ${badgeTone(run.metrics.citationCoverage)}">cite ${pct(run.metrics.citationCoverage)}</span>
              ${run.warnings?.length ? `<span class="badge bad">${run.warnings.length} warnings</span>` : `<span class="badge good">clean</span>`}
            </span>
          </button>`
        )
        .join('')}
    </div>
  `;
}

function renderDocumentList() {
  if (!state.data.documents.length) {
    return emptyState('No documents indexed.');
  }

  return `
    <div class="doc-list">
      ${state.data.documents
        .map((doc) => {
          const count = state.data.chunks.filter((chunk) => chunk.documentId === doc.id).length;
          const previews = state.data.chunks.filter((chunk) => chunk.documentId === doc.id).slice(0, 2);
          return `
            <div class="doc-item">
              <div class="panel-header">
                <div>
                  <p class="item-title">${escapeHtml(doc.title)}</p>
                  <p class="item-meta">${doc.sourceType} / ${doc.wordCount} words / ${count} chunks / ${doc.checksum}</p>
                  <div class="badge-row" style="margin-top: 8px;">
                    ${renderRedactionBadges(doc)}
                  </div>
                </div>
                <button class="small-button" data-delete-doc="${doc.id}" type="button">Delete</button>
              </div>
              <div class="chunk-list">
                ${previews.map((chunk) => `<div class="chunk-text">${escapeHtml(chunk.label)}\n\n${escapeHtml(chunk.text.slice(0, 360))}</div>`).join('')}
              </div>
            </div>
          `;
        })
        .join('')}
    </div>
  `;
}

function renderIngestionJobs() {
  const jobs = state.data.ingestionJobs || [];
  if (!jobs.length) {
    return '';
  }

  return `
    <div class="doc-list" style="margin-top: 16px;">
      ${jobs.slice(0, 6).map((job) => `
        <div class="doc-item">
          <div class="panel-header">
            <div>
              <p class="item-title">${escapeHtml(job.title)}</p>
              <p class="item-meta">${escapeHtml(job.sourceType)} / ${escapeHtml(job.status)} / ${new Date(job.updatedAt).toLocaleString()}</p>
              <div class="badge-row" style="margin-top: 8px;">
                <span class="badge ${ingestionTone(job.status)}">${escapeHtml(job.status)}</span>
                ${job.chunkCount ? `<span class="badge good">${job.chunkCount} chunks</span>` : ''}
                ${job.error ? `<span class="badge bad">${escapeHtml(job.error)}</span>` : ''}
              </div>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderClaim(claim) {
  return `
    <div class="claim-card ${claim.status}">
      <div class="badge-row">
        <span class="badge ${claim.status === 'supported' ? 'good' : claim.status === 'partial' ? 'warn' : 'bad'}">${claim.status}</span>
        <span class="badge">confidence ${pct(claim.confidence)}</span>
        ${claim.citations.map((citation) => `<button class="badge badge-button" type="button" data-scroll-chunk="${escapeAttr(citation)}">${escapeHtml(citation)}</button>`).join('')}
      </div>
      <p class="claim-text">${escapeHtml(claim.text)}</p>
    </div>
  `;
}

function renderSourceUsageMatrix(run) {
  const claims = run.evaluation?.claims || [];
  const sources = (run.retrieved || []).filter((item) => item.chunk).slice(0, 8);

  if (!claims.length || !sources.length) {
    return '';
  }

  const header = sources
    .map(
      (item) => `
      <button class="source-column" type="button" data-scroll-chunk="${escapeAttr(item.chunk.id)}" title="${escapeAttr(item.document?.title || item.chunk.documentTitle)}">
        <span>${escapeHtml(item.chunk.label)}</span>
        <small>#${item.rank} / ${pct(item.score)}</small>
      </button>`
    )
    .join('');

  const rows = claims
    .map(
      (claim) => `
      <div class="source-claim-label">
        <strong>C${claim.index + 1}</strong>
        <span>${escapeHtml(truncate(claim.text, 96))}</span>
      </div>
      ${sources.map((source) => renderSourceUsageCell(claim, source)).join('')}`
    )
    .join('');

  return `
    <div class="source-matrix-wrap">
      <div class="source-matrix-head">
        <div>
          <h3 class="micro-title">Source Usage Heatmap</h3>
          <p class="panel-subtitle">Claim support mapped to retrieved chunks</p>
        </div>
        <div class="source-legend">
          <span><i class="legend-dot supported"></i>Supported</span>
          <span><i class="legend-dot partial"></i>Partial</span>
          <span><i class="legend-dot unsupported"></i>Unsupported</span>
          <span><i class="legend-dot uncited"></i>No citation</span>
        </div>
      </div>
      <div class="source-matrix" style="--source-count:${sources.length}">
        <div class="source-corner">Claim</div>
        ${header}
        ${rows}
      </div>
    </div>
  `;
}

function renderSourceUsageCell(claim, source) {
  const citations = claim.citations || [];
  const isCited = citations.includes(source.chunk.id);
  const isBest = claim.bestChunkId === source.chunk.id;
  const support = sourceSupportForClaim(claim, source.chunk.id);
  const supportStatus = support?.status || 'unsupported';
  const supportConfidence = support?.confidence ?? 0;
  const status = isCited ? supportStatus : isBest ? 'best' : 'empty';
  const label = isCited
    ? `${supportStatus}, ${pct(supportConfidence)} support from this source`
    : isBest
      ? `best uncited match, support ${pct(supportConfidence)}`
      : 'not used';

  return `
    <button
      class="source-cell ${status} ${isBest ? 'best-match' : ''}"
      type="button"
      data-scroll-chunk="${escapeAttr(source.chunk.id)}"
      title="${escapeAttr(`${label} / ${source.chunk.label}`)}"
      aria-label="${escapeAttr(label)}">
    </button>
  `;
}

function sourceSupportForClaim(claim, chunkId) {
  return (claim.sourceSupport || []).find((item) => item.chunkId === chunkId) || null;
}

function renderTrace(trace) {
  return `
    <div class="trace-list">
      ${trace
        .map(
          (step, index) => `
          <div class="trace-step">
            <div class="trace-index">${index + 1}</div>
            <div>
              <div class="item-title">${escapeHtml(step.label)}</div>
              <div class="item-meta">${escapeHtml(step.detail)}</div>
            </div>
            <span class="badge">${step.durationMs}ms</span>
          </div>`
        )
        .join('')}
    </div>
  `;
}

function renderRetrievalStages(stages) {
  if (!stages.length) return emptyState('No staged retrieval telemetry was recorded.');
  return `
    <div class="trace-list">
      ${stages.map((stage, index) => `
        <div class="trace-step">
          <div class="trace-index">${index + 1}</div>
          <div>
            <div class="item-title">${escapeHtml(stage.name || stage.kind || 'Retrieval stage')}</div>
            <div class="item-meta">${escapeHtml(stage.kind || '')} / ${Number(stage.candidateCount || 0)} candidates / ${(stage.selectedEvidenceIds || []).length} selected${stage.provider ? ` / ${escapeHtml(stage.provider)}` : ''}${stage.model ? ` / ${escapeHtml(stage.model)}` : ''}</div>
            ${Object.keys(stage.filter || {}).length ? `<div class="item-meta">filter ${escapeHtml(JSON.stringify(stage.filter))}</div>` : ''}
          </div>
          <span class="badge ${stage.status === 'error' ? 'bad' : stage.status === 'warning' ? 'warn' : 'good'}">${escapeHtml(stage.status || 'ok')} / ${Number(stage.latencyMs || 0)}ms</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderChunk(item, queryTerms) {
  if (!item.chunk) {
    return '';
  }

  return `
    <article class="chunk-item" id="chunk-${escapeAttr(item.chunk.id)}">
      <div class="panel-header">
        <div>
          <p class="item-title">#${item.rank} ${escapeHtml(item.chunk.label)}</p>
          <p class="item-meta">${escapeHtml(item.document?.title || item.chunk.documentTitle)} / ${escapeHtml(formatSourceLocation(item.chunk))} / ${escapeHtml(item.chunk.section)} / ${item.chunk.tokenCount} tokens / embedded ${new Date(item.chunk.embeddedAt).toLocaleString()}</p>
        </div>
        <div class="badge-row">
          <span class="badge ${item.contextRole === 'parent' ? 'warn' : 'good'}">${escapeHtml(item.contextRole || 'match')}</span>
          <span class="badge ${badgeTone(item.score)}">score ${pct(item.score)}</span>
          <span class="badge">sim ${pct(item.similarityScore)}</span>
          <span class="badge">rerank ${item.rerankScore}</span>
          <span class="badge">coverage ${pct(item.coverage)}</span>
          <span class="badge">novelty ${pct(item.novelty)}</span>
        </div>
      </div>
      <div class="badge-row" style="margin-bottom: 10px;">
        ${item.matchedTerms.map((term) => `<span class="badge good">${escapeHtml(term)}</span>`).join('')}
        ${item.missingTerms.slice(0, 6).map((term) => `<span class="badge">${escapeHtml(term)}</span>`).join('')}
      </div>
      <div class="chunk-text">${highlightTerms(item.chunk.text, queryTerms)}</div>
    </article>
  `;
}

function renderComparison(comparison) {
  const retrieval = comparison.retrieval || {};
  const answers = comparison.answers || {};
  const warnings = comparison.warnings || {};
  const changedConfigCount = (comparison.configDiffs || []).filter((row) => row.changed).length;
  const warningDelta = Number((warnings.rightCount || 0) - (warnings.leftCount || 0));

  return `
    <div class="grid comparison-grid">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Comparison Summary</h2>
            <p class="panel-subtitle">Candidate minus baseline</p>
          </div>
        </div>
        <div class="metrics-grid">
          ${metricCard('Retrieval Overlap', pct(retrieval.overlapRatio), `${retrieval.overlapCount || 0} shared chunks`)}
          ${metricCard('Source Overlap', pct(retrieval.sourceOverlapRatio), `${retrieval.sourceOverlapCount || 0} shared sources`)}
          ${metricCard('Faithfulness', signedPct(answers.faithfulnessDelta), 'delta')}
          ${metricCard('Citations', signedPct(answers.citationCoverageDelta), 'delta')}
          ${metricCard('Config Changes', changedConfigCount, 'settings')}
          ${metricCard('Warnings', signedNumber(warningDelta), 'delta')}
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Metric Deltas</h2>
            <p class="panel-subtitle">Candidate minus baseline</p>
          </div>
        </div>
        <div class="comparison-table">
          <div class="comparison-row item-meta"><strong>Metric</strong><strong>Baseline</strong><strong>Candidate</strong><strong>Delta</strong></div>
          ${(comparison.deltas || []).map(renderMetricDeltaRow).join('')}
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Configuration</h2>
            <p class="panel-subtitle">Model, retrieval, and prompt controls</p>
          </div>
        </div>
        ${renderConfigDiffs(comparison.configDiffs || [])}
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Answer Comparison</h2>
            <p class="panel-subtitle">${answers.leftClaimCount || 0} baseline claims / ${answers.rightClaimCount || 0} candidate claims</p>
          </div>
        </div>
        ${renderAnswerComparison(answers)}
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Retrieval Movement</h2>
            <p class="panel-subtitle">${retrieval.topSourceChanged ? 'Top source changed' : retrieval.topChunkChanged ? 'Top source held, chunk changed' : 'Top chunk unchanged'}</p>
          </div>
        </div>
        ${renderRetrievalComparison(retrieval)}
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Warning Changes</h2>
            <p class="panel-subtitle">${warnings.leftCount || 0} baseline / ${warnings.rightCount || 0} candidate</p>
          </div>
        </div>
        ${renderWarningComparison(warnings)}
      </section>
    </div>
  `;
}

function renderMetricDeltaRow(row) {
  return `
    <div class="comparison-row">
      <div class="item-title">${humanize(row.key)}</div>
      <div>${pct(row.left)}</div>
      <div>${pct(row.right)}</div>
      <div class="${row.delta >= 0 ? 'muted' : ''}">${signedPct(row.delta)}</div>
    </div>`;
}

function renderConfigDiffs(rows) {
  if (!rows.length) {
    return emptyState('No comparable configuration was captured.');
  }

  return `
    <div class="comparison-table">
      <div class="comparison-row config-row item-meta"><strong>Setting</strong><strong>Baseline</strong><strong>Candidate</strong><strong>Status</strong></div>
      ${rows
        .map(
          (row) => `
          <div class="comparison-row config-row ${row.changed ? 'changed' : ''}">
            <div class="item-title">${humanize(row.key)}</div>
            <div>${escapeHtml(row.left)}</div>
            <div>${escapeHtml(row.right)}</div>
            <div><span class="badge ${row.changed ? 'warn' : 'good'}">${row.changed ? 'changed' : 'same'}</span></div>
          </div>`
        )
        .join('')}
    </div>
  `;
}

function renderAnswerComparison(answers) {
  return `
    <div class="answer-compare">
      <div>
        <div class="item-meta">Baseline</div>
        <div class="answer-box compare-answer">${escapeHtml(answers.leftText || '')}</div>
      </div>
      <div>
        <div class="item-meta">Candidate</div>
        <div class="answer-box compare-answer">${escapeHtml(answers.rightText || '')}</div>
      </div>
    </div>
    <div class="badge-row" style="margin-top: 12px;">
      <span class="badge">latency ${signedNumber(answers.latencyDeltaMs || 0)}ms</span>
      <span class="badge">cost ${formatSignedUsd(answers.costDeltaUsd || 0)}</span>
    </div>
  `;
}

function renderRetrievalComparison(retrieval) {
  return `
    ${renderStableSources(retrieval)}
    <div class="retrieval-diff-grid">
      <div>
        <h3 class="section-kicker">Shared</h3>
        ${renderSharedChunks(retrieval.shared || [])}
      </div>
      <div>
        <h3 class="section-kicker">Baseline Only</h3>
        ${renderMiniChunkList(retrieval.leftOnly || [])}
      </div>
      <div>
        <h3 class="section-kicker">Candidate Only</h3>
        ${renderMiniChunkList(retrieval.rightOnly || [])}
      </div>
    </div>
  `;
}

function renderStableSources(retrieval) {
  const sources = retrieval.sharedSources || [];
  if (!sources.length) {
    return '<div class="empty-mini" style="margin-bottom: 12px;">No stable source overlap.</div>';
  }

  return `
    <div class="mini-chunk-list" style="margin-bottom: 12px;">
      <h3 class="section-kicker">Stable Sources</h3>
      ${sources
        .map(
          (item) => `
          <div class="mini-chunk">
            <div class="mini-chunk-title">${escapeHtml(item.documentTitle)} / ${escapeHtml(item.section || 'Unknown section')}</div>
            <div class="item-meta">rank ${item.leftRank} -> ${item.rightRank}, chunks ${item.leftChunkCount} -> ${item.rightChunkCount}, score ${pct(item.leftScore)} -> ${pct(item.rightScore)}</div>
            <p>${escapeHtml(truncate(item.text, 220))}</p>
          </div>`
        )
        .join('')}
    </div>
  `;
}

function renderSharedChunks(chunks) {
  if (!chunks.length) {
    return '<div class="empty-mini">No shared chunks.</div>';
  }

  return `
    <div class="mini-chunk-list">
      ${chunks
        .map(
          (item) => `
          <div class="mini-chunk">
            <div class="mini-chunk-title">${escapeHtml(item.label)} / ${escapeHtml(item.documentTitle)}</div>
            <div class="item-meta">rank ${item.leftRank} -> ${item.rightRank}, score ${pct(item.leftScore)} -> ${pct(item.rightScore)} (${signedPct(item.scoreDelta)})</div>
            <p>${escapeHtml(truncate(item.text, 220))}</p>
          </div>`
        )
        .join('')}
    </div>
  `;
}

function renderMiniChunkList(chunks) {
  if (!chunks.length) {
    return '<div class="empty-mini">None.</div>';
  }

  return `
    <div class="mini-chunk-list">
      ${chunks
        .map(
          (item) => `
          <div class="mini-chunk">
            <div class="mini-chunk-title">${escapeHtml(item.label)} / ${escapeHtml(item.documentTitle)}</div>
            <div class="item-meta">rank ${item.rank}, score ${pct(item.score)}, rerank ${item.rerankScore}</div>
            <p>${escapeHtml(truncate(item.text, 220))}</p>
          </div>`
        )
        .join('')}
    </div>
  `;
}

function renderWarningComparison(warnings) {
  const common = warnings.commonTypes || [];
  const resolved = warnings.resolvedTypes || [];
  const added = warnings.addedTypes || [];

  return `
    <div class="warning-compare-grid">
      <div>
        <h3 class="section-kicker">Resolved</h3>
        ${renderWarningTypeBadges(resolved, 'good', 'No resolved warnings.')}
      </div>
      <div>
        <h3 class="section-kicker">Added</h3>
        ${renderWarningTypeBadges(added, 'bad', 'No added warnings.')}
      </div>
      <div>
        <h3 class="section-kicker">Still Present</h3>
        ${renderWarningTypeBadges(common, 'warn', 'No shared warnings.')}
      </div>
    </div>
    ${(warnings.leftOnly || []).length || (warnings.rightOnly || []).length
      ? `<div class="badge-row" style="margin-top: 12px;">
          ${(warnings.leftOnly || []).map(renderWarningBadge).join('')}
          ${(warnings.rightOnly || []).map(renderWarningBadge).join('')}
        </div>`
      : ''}
  `;
}

function renderWarningTypeBadges(types, tone, emptyText) {
  if (!types.length) {
    return `<div class="empty-mini">${escapeHtml(emptyText)}</div>`;
  }

  return `<div class="badge-row">${types.map((type) => `<span class="badge ${tone}">${escapeHtml(type)}</span>`).join('')}</div>`;
}

function renderUsage(runOrUsage = {}) {
  const usage = runOrUsage.usage || runOrUsage;
  const otelExport = runOrUsage.observability?.otelExport;
  const rows = [
    ['Input tokens', usage.inputTokens || 0],
    ['Output tokens', usage.outputTokens || 0],
    ['Total tokens', usage.totalTokens || 0],
    ['Retrieval', `${usage.retrievalMs || 0}ms`],
    ['Generation', `${usage.generationMs || 0}ms`],
    ['Evaluation', `${usage.evaluationMs || 0}ms`],
    ['Estimated cost', formatUsd(usage.estimatedCostUsd || 0)]
  ];

  if (usage.embeddingCache) {
    rows.push(
      ['Embedding cache', `${usage.embeddingCache.hits || 0} hits / ${usage.embeddingCache.misses || 0} misses`],
      ['Cache hit rate', pct(usage.embeddingCache.hitRate || 0)]
    );
  }

  if (usage.cost) {
    rows.push(
      ['Cost basis', usage.cost.source || 'unknown'],
      ['Input cost', formatUsd(usage.cost.inputUsd || 0)],
      ['Output cost', formatUsd(usage.cost.outputUsd || 0)]
    );
  }

  if (usage.provider) {
    rows.push(
      ['Provider model', usage.provider.model || 'unknown'],
      ['Finish reason', usage.provider.finishReason || 'unknown']
    );
  }

  if (otelExport) {
    rows.push(
      ['OTLP export', otelExport.configured ? (otelExport.ok ? 'sent' : 'failed') : 'not configured'],
      ['OTLP host', otelExport.endpointHost || 'none']
    );
  }

  return rows
    .map(
      ([label, value]) => `
      <div class="metric-row">
        <div class="item-meta">${escapeHtml(label)}</div>
        <strong>${escapeHtml(value)}</strong>
        <span></span>
      </div>`
    )
    .join('');
}

function bindViewEvents() {
  onAll('[data-go]', 'click', (button) => {
    if (state.busy) {
      return;
    }
    state.view = button.dataset.go;
    render();
  });

  onAll('[data-run-id]', 'click', (button) => runSafely(() => selectRun(button.dataset.runId)));

  onAll('[data-question]', 'click', (button) => {
    const question = document.querySelector('#question');
    if (question) {
      question.value = button.dataset.question;
    }
  });

  onAll('[data-eval-question]', 'click', (button) => runSafely(() => runQuestion(button.dataset.evalQuestion)));
  onOne('#run-evals-button', 'click', () => runSafely(runEvalSet));
  onOne('#eval-form', 'submit', (event) => runSafely(() => submitEvalQuestion(event)));

  onAll('[data-delete-eval]', 'click', (button) => runSafely(() => deleteEvalQuestion(button.dataset.deleteEval)));

  const documentForm = document.querySelector('#document-form');
  onElement(documentForm, 'submit', (event) => runSafely(() => submitDocument(event)));
  onOne('#queue-document-button', 'click', queueCurrentDocument);

  const settingsForm = document.querySelector('#settings-form');
  onElement(settingsForm, 'submit', (event) => runSafely(() => submitSettings(event)));
  bindRangeOutputs(settingsForm);

  onOne('#set-admin-token', 'click', () => {
    const adminToken = prompt('Admin token required.');
    if (adminToken) {
      sessionStorage.setItem(ADMIN_TOKEN_KEY, adminToken.trim());
      showToast('Admin token set for this browser session.');
      render();
    }
  });

  onOne('#clear-admin-token', 'click', () => {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    showToast('Admin token cleared.');
    render();
  });

  onOne('#doc-file', 'change', readDocumentFile);
  onAll('[data-delete-doc]', 'click', (button) => runSafely(() => deleteDocument(button.dataset.deleteDoc)));
  onOne('#reindex-documents-button', 'click', () => runSafely(reindexDocuments));

  const queryForm = document.querySelector('#query-form');
  onElement(queryForm, 'submit', (event) => runSafely(() => submitQuery(event)));
  bindRangeOutputs(queryForm);

  const compareButton = document.querySelector('#compare-button');
  const left = document.querySelector('#compare-left');
  const right = document.querySelector('#compare-right');
  if (left?.dataset.value) {
    left.value = left.dataset.value;
  }
  if (right?.dataset.value) {
    right.value = right.dataset.value;
  }
  onElement(compareButton, 'click', () => runSafely(async () => {
    state.compare = await api(withProjectParam(`/api/compare?left=${left.value}&right=${right.value}`));
    render();
  }));

  onAll('[data-copy-share]', 'click', (button) => runSafely(() => copyShareLink(button.dataset.copyShare)));
  onAll('[data-download-otel]', 'click', (button) => runSafely(() => downloadOtel(button.dataset.downloadOtel)));
  onAll('[data-download-bundle]', 'click', (button) =>
    runSafely(() => downloadRunBundle(button.dataset.downloadBundle))
  );

  onAll('[data-feedback-run]', 'submit', (_form, event) => runSafely(() => submitFeedback(event)));

  onAll('[data-scroll-chunk]', 'click', (button) => {
    document.querySelector(`#chunk-${CSS.escape(button.dataset.scrollChunk)}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
  });
}

function queueCurrentDocument() {
  const form = document.querySelector('#document-form');
  if (!form?.reportValidity()) {
    return;
  }
  try {
    const payload = documentPayload(form);
    runSafely(() => submitQueuedDocument(payload));
  } catch (error) {
    showToast(error.message || 'Unable to queue document.');
  }
}

function bindRangeOutputs(root) {
  if (!root) {
    return;
  }
  onAll('input[type="range"]', 'input', (range) => {
    const output = document.getElementById(`${range.id}-value`);
    if (output) {
      output.textContent = range.value;
    }
  }, root);
}

async function selectRun(runId, options = {}) {
  const sharedPath = options.projectId
    ? `/api/share/${runId}?projectId=${encodeURIComponent(options.projectId)}`
    : `/api/share/${runId}`;
  const path = options.shared ? sharedPath : withProjectParam(`/api/query-runs/${runId}`);
  state.activeRun = await api(path);
  if (options.renderAfter !== false) {
    render();
  }
}

async function createProject() {
  const name = prompt('Project name');
  if (!name?.trim()) {
    return;
  }
  const description = prompt('Project description') || '';
  const created = await api('/api/projects', {
    method: 'POST',
    body: {
      name,
      description
    }
  });
  state.selectedProjectId = created.activeProjectId;
  state.activeRun = null;
  state.compare = null;
  state.view = 'dashboard';
  await loadState();
  showToast('Project created.');
}

async function switchProject(projectId) {
  if (!projectId || projectId === state.data?.activeProjectId) {
    return;
  }
  state.selectedProjectId = projectId;
  state.activeRun = null;
  state.compare = null;
  await loadState();
  showToast('Project switched.');
}

async function submitDocument(event) {
  event.preventDefault();
  await api('/api/documents', {
    method: 'POST',
    body: withProjectBody(documentPayload(event.currentTarget))
  });
  await loadState();
  showToast('Document indexed.');
}

async function submitQueuedDocument(payload) {
  await api('/api/ingestion-jobs', {
    method: 'POST',
    body: withProjectBody(payload)
  });
  await loadState();
  showToast('Document queued.');
}

function documentPayload(formElement) {
  const form = new FormData(formElement);
  const text = String(form.get('text') || '').trim();
  if (!text) {
    throw new Error('Document text is required.');
  }
  return {
    title: form.get('title'),
    sourceType: form.get('sourceType'),
    text,
    base64: formElement.dataset.base64 || undefined,
    metadata: {
      collection: form.get('collection'),
      department: form.get('department'),
      version: form.get('version'),
      tags: formList(form.get('tags'))
    }
  };
}

async function readDocumentFile(event) {
  try {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const form = document.querySelector('#document-form');
    form.dataset.base64 = '';
    document.querySelector('#doc-title').value ||= file.name.replace(/\.[^.]+$/, '');
    const source = document.querySelector('#doc-source');
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      assertFileWithinLimit(file, PDF_FILE_BYTE_LIMIT, 'PDF');
      source.value = 'pdf';
      const bytes = new Uint8Array(await file.arrayBuffer());
      form.dataset.base64 = bytesToBase64(bytes);
      document.querySelector('#doc-text').value = 'PDF selected. RAGLens will extract best-effort text on the server.';
      return;
    }
    assertFileWithinLimit(file, TEXT_FILE_BYTE_LIMIT, 'Text file');
    const text = await file.text();
    if (text.length > DOCUMENT_TEXT_CHAR_LIMIT) {
      throw new Error(`Text is too large. Limit is ${DOCUMENT_TEXT_CHAR_LIMIT.toLocaleString()} characters.`);
    }
    document.querySelector('#doc-text').value = text;
  } catch (error) {
    resetSelectedFile(event.target);
    showToast(error.message || 'Unable to read file.');
  }
}

async function deleteDocument(documentId) {
  if (!confirm('Delete this indexed document and its chunks?')) {
    return;
  }
  await api(withProjectParam(`/api/documents/${documentId}`), { method: 'DELETE' });
  state.activeRun = null;
  await loadState();
  showToast('Document deleted.');
}

async function reindexDocuments() {
  if (!confirm('Reindex this project with the current chunk settings? Existing run evidence snapshots are preserved.')) {
    return;
  }
  const result = await api('/api/documents/reindex', {
    method: 'POST',
    body: withProjectBody({})
  });
  await loadState();
  showToast(`Reindexed ${result.documents.length} documents into ${result.chunks.length} chunks.`);
}

async function submitQuery(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await runQuestion(form.get('question'), {
    topK: Number(form.get('topK')),
    candidateDepth: Number(form.get('candidateDepth')),
    maxClaims: Number(form.get('maxClaims')),
    temperature: Number(form.get('temperature')),
    retrievalMode: form.get('retrievalMode'),
    rerank: form.has('rerank'),
    parentContext: form.has('parentContext'),
    parentContextMaxTokens: Number(form.get('parentContextMaxTokens')),
    metadataFilter: {
      collections: formList(form.get('filterCollection')),
      departments: formList(form.get('filterDepartment')),
      tags: formList(form.get('filterTags'))
    },
    model: form.get('model'),
    provider: form.get('provider'),
    promptTemplate: form.get('promptTemplate')
  });
}

function formList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function runQuestion(question, config = {}) {
  const run = await api('/api/query-runs', {
    method: 'POST',
    body: withProjectBody({
      question,
      ...config
    })
  });
  await loadState();
  await selectRun(run.id, { renderAfter: false });
  state.view = 'inspector';
  render();
  showToast('Inspection run saved.');
}

async function submitSettings(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api('/api/settings', {
    method: 'PATCH',
    body: withProjectBody({
      topK: Number(form.get('topK')),
      maxClaims: Number(form.get('maxClaims')),
      chunkTokens: Number(form.get('chunkTokens')),
      overlapTokens: Number(form.get('overlapTokens')),
      temperature: Number(form.get('temperature')),
      retrievalMode: form.get('retrievalMode'),
      provider: form.get('provider'),
      model: form.get('model'),
      promptTemplate: form.get('promptTemplate'),
      promptLoggingEnabled: form.has('promptLoggingEnabled'),
      redactionEnabled: form.has('redactionEnabled'),
      rerank: form.has('rerank')
    })
  });
  await loadState();
  showToast('Settings saved.');
}

async function submitFeedback(event) {
  event.preventDefault();
  const submitter = event.submitter;
  const form = new FormData(event.currentTarget);
  await api(`/api/query-runs/${event.currentTarget.dataset.feedbackRun}/feedback`, {
    method: 'POST',
    body: withProjectBody({
      rating: submitter?.value || 'up',
      note: form.get('note')
    })
  });
  showToast('Feedback saved.');
}

async function submitEvalQuestion(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api('/api/eval-questions', {
    method: 'POST',
    body: withProjectBody({
      question: form.get('question'),
      expectedSource: form.get('expectedSource'),
      expectedAnswer: form.get('expectedAnswer')
    })
  });
  await loadState();
  state.view = 'evals';
  render();
  showToast('Eval check saved.');
}

async function deleteEvalQuestion(evalQuestionId) {
  if (!confirm('Delete this eval check?')) {
    return;
  }
  await api(withProjectParam(`/api/eval-questions/${evalQuestionId}`), { method: 'DELETE' });
  await loadState();
  state.view = 'evals';
  render();
  showToast('Eval check deleted.');
}

async function runEvalSet() {
  const questions = state.data.evalQuestions || [];
  if (!questions.length) {
    state.view = 'evals';
    showToast('Save an eval check before running the set.');
    return;
  }

  let lastRun = null;
  for (const item of questions) {
    lastRun = await api('/api/query-runs', {
      method: 'POST',
      body: withProjectBody({
        question: item.question,
        topK: state.data.settings.topK,
        maxClaims: state.data.settings.maxClaims
      })
    });
  }
  await loadState();
  if (lastRun) {
    await selectRun(lastRun.id, { renderAfter: false });
  }
  state.view = 'inspector';
  render();
  showToast('Eval set completed.');
}

function metricCard(label, value, delta) {
  return `
    <div class="metric-card">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(String(value))}</div>
      <div class="metric-delta">${escapeHtml(delta)}</div>
    </div>
  `;
}

function rangeControl(name, label, min, max, value, step = 1) {
  return `
    <div class="field">
      <label for="${name}">${label}</label>
      <div class="range-row">
        <input id="${name}" name="${name}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" />
        <strong id="${name}-value">${value}</strong>
      </div>
    </div>
  `;
}

function optionList(values, selected) {
  return values.map((value) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${value}</option>`).join('');
}

function formatRunOption(run) {
  const created = run.createdAt ? new Date(run.createdAt).toLocaleString() : 'unknown time';
  const config = run.config || {};
  const retrieval = config.retrievalMode || 'retrieval';
  const topK = config.topK ? `top-${config.topK}` : 'top-k';
  const model = [config.provider, config.model].filter(Boolean).join('/') || 'local';
  return `${truncate(run.question, 54)} / ${created} / ${retrieval} ${topK} / ${model}`;
}

function renderHeatmapCell(claim, index) {
  const cls = claim.citations.length ? claim.status : 'uncited';
  const label = `Claim ${index + 1}: ${claim.citations.length ? claim.status : 'no citation found'}`;
  return `<span class="heatmap-cell ${cls}" title="${escapeAttr(label)}" role="img" aria-label="${escapeAttr(label)}"></span>`;
}

function heatmapSummary(claims = []) {
  const counts = claims.reduce(
    (summary, claim) => {
      const key = claim.citations?.length ? claim.status : 'uncited';
      summary[key] = (summary[key] || 0) + 1;
      return summary;
    },
    {
      supported: 0,
      partial: 0,
      unsupported: 0,
      uncited: 0
    }
  );
  return `${counts.supported} supported, ${counts.partial} partial, ${counts.unsupported} unsupported, ${counts.uncited} uncited claims.`;
}

function renderWarningBadge(warning) {
  const tone = warning.severity === 'high' ? 'bad' : 'warn';
  return `<span class="badge ${tone}" title="${escapeAttr(warning.message)}">${escapeHtml(warning.type)}</span>`;
}

function renderRedactionBadges(doc) {
  const redactions = doc.metadata?.redactions || [];
  if (!redactions.length) {
    return '<span class="badge good">no redactions</span>';
  }

  return redactions
    .map((item) => `<span class="badge warn">redacted ${escapeHtml(item.label)} x${Number(item.count || 0)}</span>`)
    .join('');
}

function emptyState(text) {
  return `<div class="empty-state">${escapeHtml(text)}</div>`;
}

function pct(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function signedPct(value) {
  const number = Number(value || 0);
  return `${number > 0 ? '+' : ''}${pct(number)}`;
}

function signedNumber(value) {
  const number = Number(value || 0);
  return `${number > 0 ? '+' : ''}${number}`;
}

function formatUsd(value) {
  const number = Number(value || 0);
  if (!number) {
    return '$0.00';
  }
  if (Math.abs(number) < 0.01) {
    return `$${number.toFixed(6)}`;
  }
  return `$${number.toFixed(2)}`;
}

function formatSignedUsd(value) {
  const number = Number(value || 0);
  return `${number > 0 ? '+' : ''}${formatUsd(number)}`;
}

function formatBytes(value) {
  const number = Number(value || 0);
  if (number < 1024) {
    return `${number} B`;
  }
  if (number < 1024 * 1024) {
    return `${Math.round(number / 1024)} KB`;
  }
  return `${(number / 1024 / 1024).toFixed(1)} MB`;
}

function formatSourceLocation(chunk = {}) {
  const start = Number(chunk.pageStart ?? chunk.page);
  const end = Number(chunk.pageEnd ?? start);
  if (chunk.pageNumbersExact !== true || !Number.isInteger(start) || start < 1) {
    return 'page unavailable';
  }
  return end > start ? `pages ${start}-${end}` : `page ${start}`;
}

function assertFileWithinLimit(file, limit, label) {
  if (file.size > limit) {
    throw new Error(`${label} is too large (${formatBytes(file.size)}). Limit is ${formatBytes(limit)}.`);
  }
}

function resetSelectedFile(input) {
  if (input) {
    input.value = '';
  }
  const form = document.querySelector('#document-form');
  if (form) {
    form.dataset.base64 = '';
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 16_384;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function truncate(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}...` : text;
}

function metricTone(value, inverse = false) {
  const score = inverse ? 1 - value : value;
  if (score >= 0.72) {
    return 'good';
  }
  if (score >= 0.42) {
    return 'warn';
  }
  return 'bad';
}

function badgeTone(value) {
  if (value >= 0.72) {
    return 'good';
  }
  if (value >= 0.42) {
    return 'warn';
  }
  return 'bad';
}

function humanize(key) {
  return key.replace(/[A-Z]/g, (match) => ` ${match.toLowerCase()}`).replace(/^./, (letter) => letter.toUpperCase());
}

function highlightTerms(text, terms) {
  const escaped = escapeHtml(text);
  const safeTerms = [...new Set(terms || [])].filter((term) => term.length > 2).slice(0, 16);
  if (!safeTerms.length) {
    return escaped;
  }
  const pattern = new RegExp(`\\b(${safeTerms.map(escapeRegExp).join('|')})\\b`, 'gi');
  return escaped.replace(pattern, '<mark>$1</mark>');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('\n', ' ');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function copyShareLink(runId) {
  const hash = new URLSearchParams({
    run: runId,
    projectId: currentProjectId()
  });
  const url = `${location.origin}${location.pathname}#${hash.toString()}`;
  const copied = await copyTextToClipboard(url);
  if (copied) {
    showToast('Share link copied.');
    return;
  }
  prompt('Copy share link', url);
  showToast('Share link ready.');
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the textarea fallback.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.append(textarea);
  textarea.select();
  try {
    return document.execCommand?.('copy') === true;
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

async function downloadOtel(runId) {
  const otel = await api(withProjectParam(`/api/query-runs/${runId}/otel`));
  const blob = new Blob([JSON.stringify(otel, null, 2)], { type: 'application/json' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `${runId}-otel.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

async function downloadRunBundle(runId) {
  const bundle = await api(withProjectParam(`/api/query-runs/${runId}/bundle`));
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `${runId}-bundle.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function showToast(message) {
  toast.textContent = String(message || 'Action failed.').slice(0, 240);
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

async function runSafely(action) {
  if (state.busy) {
    return;
  }

  state.busy = true;
  render();
  try {
    await action();
  } catch (error) {
    showToast(error.message || 'Action failed.');
  } finally {
    state.busy = false;
    render();
  }
}

function setBusyUi() {
  document
    .querySelectorAll(
      '.topbar-actions button, .view-host button, .view-host input, .view-host textarea, .view-host select'
    )
    .forEach((element) => {
      element.disabled = state.busy;
    });
}

function scheduleIngestionRefresh() {
  if (state.jobPollTimer) {
    clearTimeout(state.jobPollTimer);
    state.jobPollTimer = null;
  }
  const hasActiveJobs = (state.data?.ingestionJobs || []).some((job) => ['queued', 'processing'].includes(job.status));
  if (state.view === 'documents' && hasActiveJobs && !state.busy) {
    state.jobPollTimer = setTimeout(() => runSafely(() => loadState()), 1500);
  }
}

function ingestionTone(status) {
  if (status === 'completed') {
    return 'good';
  }
  if (status === 'failed') {
    return 'bad';
  }
  return 'warn';
}

