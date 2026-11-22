// AgentPulse Frontend Application Logic
let allServices = [];
let currentFilter = 'all';
let selectedServiceSlug = 'stripe';
let currentServiceEtag = '';

// There is NO fallback dataset. If the API is unreachable the dashboard
// shows an explicit unavailable state — invented services, statuses, or
// latencies are never rendered as if they were live data.
let servicesUnavailable = false;

// Active incident counts per service slug, grouped ONLY from the live
// GET /v1/incidents response. null = not loaded or fetch failed, in
// which case no incident badges or breakdown are rendered at all —
// counts are never invented or carried over from a previous load.
let incidentCountsByService = null;

document.addEventListener('DOMContentLoaded', async () => {
  setupTabNavigation();
  setupFilterButtons();
  setupPreflightControls();
  await loadInitialData();
  connectLiveStream();
  selectService('stripe');
});

// Toast System (Replaces intrusive window.alert)
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icon = type === 'success' ? '✅' : (type === 'error' ? '❌' : '⚡');
  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease-out';
    setTimeout(() => {
      if (toast.parentElement) toast.parentElement.removeChild(toast);
    }, 300);
  }, 3500);
}

// Tab Navigation
function setupTabNavigation() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const targetId = tab.dataset.tab;
      document.querySelectorAll('.tab-pane').forEach(pane => {
        pane.classList.remove('active');
      });

      const activePane = document.getElementById(targetId);
      if (activePane) activePane.classList.add('active');
    });
  });
}

async function loadInitialData() {
  try {
    const [servicesRes, metricsRes, incidentsRes] = await Promise.all([
      fetch('/v1/services').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/v1/metrics').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/v1/incidents?status=active').then(r => r.ok ? r.json() : null).catch(() => null)
    ]);

    if (servicesRes && Array.isArray(servicesRes.services)) {
      allServices = servicesRes.services;
      servicesUnavailable = false;
    } else {
      // API unreachable: show the unavailable state, never invented data.
      allServices = [];
      servicesUnavailable = true;
    }

    // Group the live incidents payload per service. The payload itself
    // is the single source for both the card badges and the breakdown,
    // so the two can never disagree. A failed fetch clears the counts:
    // nothing is rendered rather than stale or invented numbers.
    if (incidentsRes && Array.isArray(incidentsRes.incidents)) {
      incidentCountsByService = new Map();
      for (const incident of incidentsRes.incidents) {
        if (!incident.service_slug) continue;
        incidentCountsByService.set(
          incident.service_slug,
          (incidentCountsByService.get(incident.service_slug) || 0) + 1
        );
      }
    } else {
      incidentCountsByService = null;
    }

    renderServicesList();
    renderPreflightDependencies();
    renderIncidentBreakdown();

    if (metricsRes) {
      updateMetrics(metricsRes);
    }
  } catch (err) {
    console.warn('Live data unavailable:', err);
    allServices = [];
    servicesUnavailable = true;
    incidentCountsByService = null;
    renderServicesList();
    renderPreflightDependencies();
    renderIncidentBreakdown();
  }
}

function updateMetrics(metrics) {
  if (!metrics) return;
  const countEl = document.getElementById('stat-total-services');
  if (countEl) countEl.textContent = metrics.services?.total || allServices.length;

  const incEl = document.getElementById('stat-active-incidents');
  if (incEl) incEl.textContent = metrics.active_incidents || 0;

  // Always written, including an honest 0 when nothing was saved today.
  const tokenEl = document.getElementById('stat-tokens-saved');
  if (tokenEl) tokenEl.textContent = Number(metrics.estimated_tokens_saved || 0).toLocaleString();

  const agentsEl = document.getElementById('stat-registered-agents');
  if (agentsEl) agentsEl.textContent = metrics.registered_agents ?? '—';

  const badge = document.getElementById('service-count-badge');
  if (badge) badge.textContent = servicesUnavailable ? 'Unavailable' : `${allServices.length} Tracking`;
}

function serviceDisplayName(slug) {
  const service = allServices.find(s => s.slug === slug);
  return service ? service.name : slug;
}

// Compact per-service breakdown under the Active Incidents stat: one
// "Name · count" row per impacted service, busiest first. Renders
// nothing when counts are unavailable or no service has an incident.
function renderIncidentBreakdown() {
  const container = document.getElementById('stat-incident-breakdown');
  if (!container) return;
  container.innerHTML = '';

  if (!incidentCountsByService || incidentCountsByService.size === 0) return;

  const entries = [...incidentCountsByService.entries()]
    .map(([slug, count]) => ({ name: serviceDisplayName(slug), count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  entries.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'incident-breakdown-row';
    row.textContent = `${entry.name} · ${entry.count}`;
    container.appendChild(row);
  });
}

function renderServicesList() {
  const container = document.getElementById('services-grid');
  if (!container) return;
  container.innerHTML = '';

  const filtered = currentFilter === 'all'
    ? allServices
    : allServices.filter(s => s.category === currentFilter);

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'service-card';
    empty.textContent = servicesUnavailable
      ? 'Live data unavailable — the AgentPulse API could not be reached. No status is claimed for any service right now.'
      : 'No services in this category.';
    container.appendChild(empty);
    return;
  }

  filtered.forEach(service => {
    const card = document.createElement('div');
    card.className = `service-card ${service.slug === selectedServiceSlug ? 'selected' : ''}`;
    card.dataset.slug = service.slug;

    const statusClass = service.current_status || 'operational';

    const incidentCount = incidentCountsByService
      ? (incidentCountsByService.get(service.slug) || 0)
      : 0;
    const incidentBadge = incidentCount > 0
      ? `<span class="incident-badge">${incidentCount} incident${incidentCount === 1 ? '' : 's'}</span>`
      : '';

    card.innerHTML = `
      <div class="service-top">
        <div class="service-name">
          <span>${getServiceIcon(service.category)}</span>
          ${service.name}
        </div>
        <span class="status-badge ${statusClass}">
          ${statusClass}
        </span>
      </div>
      <div class="service-meta">
        <span>${service.latency_ms ? service.latency_ms.toFixed(1) + 'ms' : '—'}</span>
        ${incidentBadge}
        <span class="etag-tag">${service.etag || 'W/"live"'}</span>
      </div>
    `;

    card.addEventListener('click', () => {
      selectService(service.slug);
    });

    container.appendChild(card);
  });
}

function getServiceIcon(category) {
  switch (category) {
    case 'ai_models': return '🧠';
    case 'payments': return '💳';
    case 'cloud_infra': return '☁️';
    case 'database': return '🗄️';
    case 'hosting': return '🚀';
    case 'communications': return '📬';
    case 'observability': return '📊';
    case 'dev_tools': return '🛠️';
    default: return '📦';
  }
}

async function selectService(slug) {
  selectedServiceSlug = slug;
  
  // Highlight card
  document.querySelectorAll('.service-card').forEach(el => {
    el.classList.toggle('selected', el.dataset.slug === slug);
  });

  const slugLabel = document.getElementById('inspector-slug');
  if (slugLabel) slugLabel.textContent = slug;

  const titleEl = document.getElementById('terminal-endpoint-title');
  if (titleEl) titleEl.textContent = `GET /v1/status/${slug}`;

  try {
    const res = await fetch(`/v1/status/${slug}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    currentServiceEtag = res.headers.get('ETag') || data.etag || 'W/"live"';

    // Update terminal output
    const outputEl = document.getElementById('payload-output');
    if (outputEl) {
      outputEl.textContent = JSON.stringify(data, null, 2);
    }

    // Update incident preview box
    const incBox = document.getElementById('incident-box-wrapper');
    if (data.active_incidents && data.active_incidents.length > 0) {
      const inc = data.active_incidents[0];
      incBox.style.display = 'block';
      document.getElementById('inc-scope').textContent = inc.scope;
      document.getElementById('inc-badge').textContent = inc.severity;
      document.getElementById('inc-badge').className = `status-badge ${inc.severity === 'critical' ? 'outage' : 'degraded'}`;
      document.getElementById('inc-summary').textContent = inc.summary;
      document.getElementById('inc-hint').textContent = inc.agent_hint;
    } else {
      incBox.style.display = 'block';
      document.getElementById('inc-scope').textContent = 'All Systems Operational';
      document.getElementById('inc-badge').textContent = 'operational';
      document.getElementById('inc-badge').className = 'status-badge operational';
      document.getElementById('inc-summary').textContent = `No active incidents reported for ${data.service}.`;
      document.getElementById('inc-hint').textContent = 'All systems nominal. Safe for automated high-concurrency tool execution.';
    }
  } catch (err) {
    console.warn(`Could not fetch live status for ${slug}:`, err);
    // The backend is unreachable, so nothing is claimed about the
    // service's real state: the payload says "unknown" outright rather
    // than dressing a guess up as a status response.
    const unknownData = {
      service: slug,
      status: 'unknown',
      error: 'Live status unavailable — the AgentPulse API could not be reached, so no status is claimed for this service.'
    };

    const outputEl = document.getElementById('payload-output');
    if (outputEl) outputEl.textContent = JSON.stringify(unknownData, null, 2);

    const incBox = document.getElementById('incident-box-wrapper');
    if (incBox) {
      incBox.style.display = 'block';
      document.getElementById('inc-scope').textContent = 'Status unknown';
      document.getElementById('inc-badge').textContent = 'unknown';
      document.getElementById('inc-badge').className = 'status-badge';
      document.getElementById('inc-summary').textContent = unknownData.error;
      document.getElementById('inc-hint').textContent = '—';
    }
  }
}

// Test 304 ETag Cache Hit
window.testEtagCache = async function() {
  const slug = selectedServiceSlug || 'stripe';
  try {
    const start = performance.now();
    const res = await fetch(`/v1/status/${slug}`, {
      headers: {
        'If-None-Match': currentServiceEtag || 'W/"etag-placeholder"'
      }
    });
    const duration = Math.round(performance.now() - start);

    if (res.status === 304) {
      showToast(`⚡ 304 Not Modified! (Duration: ${duration}ms, 0 tokens wasted, +2 Good Citizen points awarded)`, 'success');
    } else {
      showToast(`HTTP ${res.status} returned (${duration}ms). State mutated or ETag updated.`, 'info');
    }
  } catch (err) {
    showToast(`ETag test error: ${err.message}`, 'error');
  }
};

function setupFilterButtons() {
  const buttons = document.querySelectorAll('.filter-btn');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderServicesList();
    });
  });
}

function renderPreflightDependencies() {
  const container = document.getElementById('preflight-selector');
  if (!container) return;
  container.innerHTML = '';

  const defaultChecked = ['stripe', 'openai', 'supabase', 'resend'];

  allServices.forEach(s => {
    const label = document.createElement('label');
    const isChecked = defaultChecked.includes(s.slug);
    label.className = `dep-checkbox-label ${isChecked ? 'checked' : ''}`;
    label.innerHTML = `
      <input type="checkbox" id="dep-${s.slug}" value="${s.slug}" ${isChecked ? 'checked' : ''}>
      <span>${s.name.split(' ')[0]}</span>
    `;

    const input = label.querySelector('input');
    input.addEventListener('change', () => {
      label.classList.toggle('checked', input.checked);
    });

    container.appendChild(label);
  });
}

function setupPreflightControls() {
  const btnRun = document.getElementById('btn-run-preflight');
  const btnReset = document.getElementById('btn-reset-preflight');
  const btnHealthy = document.getElementById('btn-select-healthy-preflight');

  if (btnRun) {
    btnRun.addEventListener('click', async () => {
      const checkedInputs = document.querySelectorAll('#preflight-selector input:checked');
      const deps = Array.from(checkedInputs).map(i => i.value);

      btnRun.innerHTML = '<span>⏳</span> Evaluating...';

      try {
        const start = performance.now();
        const res = await fetch('/v1/preflight', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dependencies: deps })
        });
        const duration = Math.round(performance.now() - start);
        const data = await res.json();

        const out = document.getElementById('preflight-output');
        out.textContent = `// Response in ${duration}ms (Verdict: ${data.verdict.toUpperCase()})\n` + JSON.stringify(data, null, 2);
        showToast(`Preflight evaluated: ${data.verdict.toUpperCase()} (${duration}ms)`, data.healthy ? 'success' : 'info');
      } catch (err) {
        document.getElementById('preflight-output').textContent = `Error running preflight: ${err.message}`;
        showToast(`Preflight failed: ${err.message}`, 'error');
      } finally {
        btnRun.innerHTML = '<span>⚡</span> Run Preflight Query';
      }
    });
  }

  if (btnReset) {
    btnReset.addEventListener('click', () => {
      document.querySelectorAll('#preflight-selector input').forEach(input => {
        input.checked = false;
        input.parentElement.classList.remove('checked');
      });
      document.getElementById('preflight-output').textContent = '// Select dependencies above and click "Run Preflight Query"';
    });
  }

  if (btnHealthy) {
    btnHealthy.addEventListener('click', () => {
      const healthySlugs = allServices.filter(s => s.current_status === 'operational').map(s => s.slug);
      document.querySelectorAll('#preflight-selector input').forEach(input => {
        const isHealthy = healthySlugs.includes(input.value);
        input.checked = isHealthy;
        input.parentElement.classList.toggle('checked', isHealthy);
      });
      showToast('Selected healthy operational dependencies', 'info');
    });
  }
}

// Bot Onboarding Form
window.handleAgentRegistration = async function(event) {
  event.preventDefault();
  const nameInput = document.getElementById('reg-agent-name');
  const urlInput = document.getElementById('reg-operator-url');
  const resultDiv = document.getElementById('reg-result');
  const outputPre = document.getElementById('reg-output');

  try {
    const res = await fetch('/v1/agents/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `${nameInput.value}/1.0`
      },
      body: JSON.stringify({
        agent_name: nameInput.value,
        operator_url: urlInput.value
      })
    });

    const data = await res.json();
    resultDiv.style.display = 'block';

    if (res.ok && data.agent) {
      const apiKey = data.agent.api_key;
      outputPre.textContent = `# Zero-CAPTCHA Verification Complete!\n` +
        `API Key: ${apiKey}\n` +
        `Tier: ${data.agent.tier} (Daily Quota: ${data.agent.daily_quota} req/day)\n\n` +
        `# Test with cURL:\n` +
        `curl -H "Authorization: Bearer ${apiKey}" \\\n` +
        `     -H "If-None-Match: W/\"etag-placeholder\"" \\\n` +
        `     http://${window.location.host}/v1/status/stripe`;
      
      showToast(`Agent registered: ${data.agent.agent_name}`, 'success');
      appendStreamLog('REGISTER', `New agent client onboarded: ${data.agent.agent_name}`);
    } else {
      outputPre.textContent = `Error: ${data.error || 'Registration failed'}`;
      showToast(`Registration error: ${data.error}`, 'error');
    }
  } catch (err) {
    resultDiv.style.display = 'block';
    outputPre.textContent = `Error: ${err.message}`;
    showToast(`Network error: ${err.message}`, 'error');
  }
};

// Interactive MCP Tool Explorer
window.updateMcpToolParams = function() {
  const toolSelect = document.getElementById('mcp-tool-select');
  const argsArea = document.getElementById('mcp-tool-args');
  if (!toolSelect || !argsArea) return;

  const tool = toolSelect.value;
  if (tool === 'check_dependency_health') {
    argsArea.value = JSON.stringify({ dependencies: ['stripe', 'openai', 'aws'] }, null, 2);
  } else if (tool === 'get_service_status') {
    argsArea.value = JSON.stringify({ service: 'stripe' }, null, 2);
  } else if (tool === 'lookup_breaking_changes') {
    argsArea.value = JSON.stringify({ service: 'openai', since: '2026-01-01T00:00:00Z' }, null, 2);
  }
};

window.executeSelectedMcpTool = async function() {
  const toolSelect = document.getElementById('mcp-tool-select');
  const argsArea = document.getElementById('mcp-tool-args');
  const outputPre = document.getElementById('mcp-tool-output');

  try {
    const toolName = toolSelect.value;
    const toolArgs = JSON.parse(argsArea.value);

    outputPre.textContent = '// Invoking stateless MCP server...';

    const res = await fetch('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: toolArgs
        }
      })
    });

    const data = await res.json();
    outputPre.textContent = JSON.stringify(data.result || data, null, 2);
    showToast(`MCP Tool ${toolName} completed`, 'success');
  } catch (err) {
    outputPre.textContent = `Error invoking tool: ${err.message}`;
    showToast(`MCP Error: ${err.message}`, 'error');
  }
};

// Crowdsource Telemetry Submission
window.handleTelemetryReport = async function(event) {
  event.preventDefault();
  const service = document.getElementById('tel-service').value;
  const endpoint = document.getElementById('tel-endpoint').value;
  const errorCode = document.getElementById('tel-error').value;

  try {
    const res = await fetch('/v1/telemetry/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service,
        endpoint,
        error_code: parseInt(errorCode, 10),
        error_type: `${errorCode}_anomaly`
      })
    });

    const data = await res.json();
    if (res.ok) {
      showToast(`Telemetry logged for ${service} (${errorCode})`, 'success');
      appendStreamLog('TELEMETRY', `Anomaly reported for ${service}: ${endpoint} (${errorCode})`);
    } else {
      showToast(`Error: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Telemetry error: ${err.message}`, 'error');
  }
};

// Copy snippet helper
window.copySnippet = function(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const text = el.textContent;

  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied to clipboard!', 'success');
  }).catch(() => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast('Copied to clipboard!', 'success');
  });
};

// Real-Time SSE Stream Connection
function connectLiveStream() {
  try {
    const eventSource = new EventSource('/v1/stream');

    eventSource.addEventListener('connected', () => {
      appendStreamLog('CONNECTED', 'Edge SSE stream established (keepalive: 15s)');
      const statusPill = document.getElementById('live-status-text');
      if (statusPill) statusPill.textContent = 'EDGE LIVE';
    });

    eventSource.addEventListener('incident', e => {
      const data = JSON.parse(e.data);
      appendStreamLog('INCIDENT', `${data.service}: ${data.incident.agent_summary}`);
      loadInitialData(); // Refresh UI
    });

    eventSource.addEventListener('heartbeat', e => {
      const data = JSON.parse(e.data);
      appendStreamLog('HEARTBEAT', `Ingestion cycle checked ${data.services_checked} dependencies`);
    });

    eventSource.onerror = () => {
      const statusPill = document.getElementById('live-status-text');
      if (statusPill) statusPill.textContent = 'RECONNECTING';
    };
  } catch (err) {
    console.warn('SSE stream unavailable:', err);
  }
}

function appendStreamLog(type, msg) {
  const container = document.getElementById('stream-logs');
  if (!container) return;

  const now = new Date().toTimeString().split(' ')[0];
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `
    <span class="log-time">[${now}]</span>
    <span class="log-event">${type}</span>
    <span class="log-msg">${msg}</span>
  `;

  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;

  // Limit max entries
  while (container.children.length > 50) {
    container.removeChild(container.firstChild);
  }
}
