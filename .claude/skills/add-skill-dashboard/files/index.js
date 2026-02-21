// @ts-check
import http from 'http';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

/** @type {http.Server | null} */
let server = null;
/** @type {any} */
let ctx = null;

// ─── Auth ───────────────────────────────────────────────────────────

let dashboardSecret = process.env.DASHBOARD_SECRET || '';

function checkAuth(req, res) {
  if (!dashboardSecret) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Dashboard disabled — set DASHBOARD_SECRET in .env');
    return false;
  }
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${dashboardSecret}`) return true;
  const cookies = parseCookies(req);
  if (cookies.dashboard_token === dashboardSecret) return true;
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get('token') === dashboardSecret) {
    res.writeHead(302, {
      'Set-Cookie': `dashboard_token=${dashboardSecret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
      Location: '/',
    });
    res.end();
    return false;
  }
  return false;
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  for (const pair of header.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  }
  return cookies;
}

// ─── HTML Helpers ───────────────────────────────────────────────────

const START_TIME = Date.now();

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Pages ──────────────────────────────────────────────────────────

function loginPage() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NanoClaw Dashboard</title>
<link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
</head><body class="bg-gray-900 text-white flex items-center justify-center min-h-screen">
<form method="GET" action="/" class="bg-gray-800 p-8 rounded-lg shadow-lg w-full max-w-sm">
  <h1 class="text-2xl font-bold mb-6 text-center">NanoClaw Dashboard</h1>
  <label class="block text-sm font-medium mb-2" for="token">Access Token</label>
  <input type="password" name="token" id="token" required
    class="w-full px-4 py-2 rounded bg-gray-700 border border-gray-600 focus:border-blue-500 focus:outline-none mb-4"
    placeholder="Enter DASHBOARD_SECRET">
  <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 py-2 px-4 rounded font-medium">Login</button>
</form>
</body></html>`;
}

function shell() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NanoClaw Dashboard</title>
<link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
<script src="https://unpkg.com/htmx.org@2.0.4"></script>
<style>
  .htmx-indicator { opacity: 0; transition: opacity 200ms; }
  .htmx-request .htmx-indicator, .htmx-request.htmx-indicator { opacity: 1; }
  .fade-in { animation: fadeIn 0.3s ease-in; }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
  .dot-on { background: #10b981; }
  .dot-off { background: #ef4444; }
  pre { white-space: pre-wrap; word-break: break-word; }
  .tab-btn { padding: 0.5rem 1rem; border-bottom: 2px solid transparent; cursor: pointer; color: #9ca3af; transition: color 0.15s, border-color 0.15s; }
  .tab-btn:hover { color: #d1d5db; }
  .tab-btn.active { color: #fff; border-color: #3b82f6; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  /* Light theme overrides */
  body.light { background: #f3f4f6; color: #111827; }
  body.light .bg-gray-900 { background: #e5e7eb !important; }
  body.light .bg-gray-800 { background: #fff !important; }
  body.light .bg-gray-700 { background: #e5e7eb !important; }
  body.light .bg-gray-700\\/50 { background: rgba(229,231,235,0.5) !important; }
  body.light .bg-gray-900\\/50 { background: rgba(243,244,246,0.5) !important; }
  body.light .text-gray-100 { color: #111827 !important; }
  body.light .text-gray-400 { color: #6b7280 !important; }
  body.light .text-gray-500 { color: #9ca3af !important; }
  body.light .text-gray-300 { color: #374151 !important; }
  body.light .border-gray-700 { border-color: #d1d5db !important; }
  body.light .border-gray-700\\/50 { border-color: rgba(209,213,219,0.5) !important; }
  body.light .border-gray-600 { border-color: #d1d5db !important; }
  body.light .tab-btn { color: #6b7280; }
  body.light .tab-btn:hover { color: #374151; }
  body.light .tab-btn.active { color: #111827; }
  body.light pre { color: #374151; }
</style>
<script>
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
}
function toggleTheme() {
  const light = document.body.classList.toggle('light');
  localStorage.setItem('dashboard-theme', light ? 'light' : 'dark');
  document.getElementById('theme-icon').textContent = light ? 'Dark' : 'Light';
}
if (localStorage.getItem('dashboard-theme') === 'light') {
  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('light');
    document.getElementById('theme-icon').textContent = 'Dark';
  });
}
</script>
</head>
<body class="bg-gray-900 text-gray-100 min-h-screen">
<div class="max-w-7xl mx-auto px-4 py-6">

  <header class="flex items-center justify-between mb-4">
    <h1 class="text-2xl font-bold">NanoClaw Dashboard</h1>
    <div class="flex items-center gap-4">
      <button onclick="toggleTheme()" class="text-sm text-gray-400 hover:text-white" id="theme-icon">Light</button>
      <a href="/logout" class="text-sm text-gray-400 hover:text-white">Logout</a>
    </div>
  </header>

  <!-- Health (always visible) -->
  <section class="mb-4">
    <div hx-get="/api/health" hx-trigger="load, every 5s" hx-swap="innerHTML"
      class="bg-gray-800 rounded-lg p-4"></div>
  </section>

  <!-- Tab bar -->
  <nav class="flex border-b border-gray-700 mb-6 overflow-x-auto">
    <button class="tab-btn active" data-tab="overview" onclick="switchTab('overview')">Overview</button>
    <button class="tab-btn" data-tab="groups" onclick="switchTab('groups')">Groups</button>
    <button class="tab-btn" data-tab="tasks" onclick="switchTab('tasks')">Tasks</button>
    <button class="tab-btn" data-tab="plugins" onclick="switchTab('plugins')">Plugins</button>
    <button class="tab-btn" data-tab="messages" onclick="switchTab('messages')">Messages</button>
    <button class="tab-btn" data-tab="logs" onclick="switchTab('logs')">Logs</button>
  </nav>

  <!-- ── Overview tab ── -->
  <div id="tab-overview" class="tab-panel active">
    <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
      <section>
        <h2 class="text-lg font-semibold mb-3">Channels</h2>
        <div hx-get="/api/channels" hx-trigger="load, every 10s" hx-swap="innerHTML"
          class="bg-gray-800 rounded-lg p-4"></div>
      </section>
      <section>
        <h2 class="text-lg font-semibold mb-3">Queue</h2>
        <div hx-get="/api/queue" hx-trigger="load, every 5s" hx-swap="innerHTML"
          class="bg-gray-800 rounded-lg p-4"></div>
      </section>
    </div>
    <section class="mb-6">
      <h2 class="text-lg font-semibold mb-3">Identity</h2>
      <div hx-get="/api/identity" hx-trigger="load" hx-swap="innerHTML"
        class="bg-gray-800 rounded-lg p-4"></div>
    </section>
    <section class="mb-6">
      <h2 class="text-lg font-semibold mb-3">Recent Runs</h2>
      <div hx-get="/api/runs" hx-trigger="load, every 10s" hx-swap="innerHTML"
        class="bg-gray-800 rounded-lg p-4 overflow-x-auto"></div>
    </section>
  </div>

  <!-- ── Groups tab ── -->
  <div id="tab-groups" class="tab-panel">
    <section class="mb-6">
      <h2 class="text-lg font-semibold mb-3">Groups</h2>
      <div hx-get="/api/groups" hx-trigger="load, every 10s" hx-swap="innerHTML"
        class="bg-gray-800 rounded-lg p-4 overflow-x-auto"></div>
    </section>
    <section id="group-detail" class="mb-6"></section>
  </div>

  <!-- ── Tasks tab ── -->
  <div id="tab-tasks" class="tab-panel">
    <section class="mb-6">
      <h2 class="text-lg font-semibold mb-3">Scheduled Tasks</h2>
      <div id="tasks-section" hx-get="/api/tasks" hx-trigger="load, every 10s" hx-swap="innerHTML"
        class="bg-gray-800 rounded-lg p-4 overflow-x-auto"></div>
    </section>
    <section id="task-logs" class="mb-6"></section>

    <section class="mb-6">
      <h2 class="text-lg font-semibold mb-3">Create Task</h2>
      <div class="bg-gray-800 rounded-lg p-4">
        <form hx-post="/api/tasks" hx-target="#tasks-section" hx-swap="innerHTML"
          class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium mb-1">Group Folder</label>
            <select name="group_folder" required class="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2">${renderGroupOptions()}</select>
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Schedule Type</label>
            <select name="schedule_type" required class="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2">
              <option value="cron">Cron</option>
              <option value="interval">Interval</option>
              <option value="once">Once</option>
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Schedule Value</label>
            <input name="schedule_value" required placeholder="*/30 * * * * or 1800000"
              class="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2">
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Context Mode</label>
            <select name="context_mode" class="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2">
              <option value="isolated">Isolated</option>
              <option value="group">Group</option>
            </select>
          </div>
          <div class="md:col-span-2">
            <label class="block text-sm font-medium mb-1">Prompt</label>
            <textarea name="prompt" required rows="3" placeholder="What should the agent do?"
              class="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"></textarea>
          </div>
          <div class="md:col-span-2">
            <button type="submit" class="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded font-medium">Create Task</button>
          </div>
        </form>
      </div>
    </section>
  </div>

  <!-- ── Plugins tab ── -->
  <div id="tab-plugins" class="tab-panel">
    <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
      <section>
        <h2 class="text-lg font-semibold mb-3">Installed Plugins</h2>
        <div hx-get="/api/plugins" hx-trigger="load" hx-swap="innerHTML"
          class="bg-gray-800 rounded-lg p-4"></div>
      </section>
      <section>
        <h2 class="text-lg font-semibold mb-3">Not Installed</h2>
        <div hx-get="/api/templates" hx-trigger="load" hx-swap="innerHTML"
          class="bg-gray-800 rounded-lg p-4"></div>
      </section>
    </div>
  </div>

  <!-- ── Logs tab ── -->
  <div id="tab-logs" class="tab-panel">
    <section class="mb-6">
      <h2 class="text-lg font-semibold mb-3">System Logs</h2>
      <div hx-get="/api/logs" hx-trigger="load, every 5s" hx-swap="innerHTML"
        class="bg-gray-800 rounded-lg p-4"></div>
    </section>
  </div>

  <!-- ── Messages tab ── -->
  <div id="tab-messages" class="tab-panel">
    <section class="mb-6">
      <h2 class="text-lg font-semibold mb-3">Messages</h2>
      <div class="bg-gray-800 rounded-lg p-4">
        <div class="flex gap-4 mb-4 items-end">
          <div class="flex-1">
            <label class="block text-sm font-medium mb-1">Group</label>
            <select id="msg-group" name="group_folder"
              class="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2">${renderGroupOptions()}</select>
          </div>
          <button hx-get="/api/messages" hx-include="#msg-group" hx-target="#messages-list" hx-swap="innerHTML"
            class="bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded font-medium">Load</button>
        </div>
        <div id="messages-list"></div>
      </div>
    </section>

    <section class="mb-6">
      <h2 class="text-lg font-semibold mb-3">Send Message</h2>
      <div class="bg-gray-800 rounded-lg p-4">
        <form hx-post="/api/send" hx-swap="innerHTML" hx-target="#send-result" class="flex gap-4 items-end">
          <div class="flex-1">
            <label class="block text-sm font-medium mb-1">Group</label>
            <select name="jid" class="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2">${renderJidOptions()}</select>
          </div>
          <div class="flex-1">
            <label class="block text-sm font-medium mb-1">Message</label>
            <input name="text" required placeholder="Hello from the dashboard"
              class="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2">
          </div>
          <button type="submit" class="bg-green-600 hover:bg-green-700 px-4 py-2 rounded font-medium">Send</button>
        </form>
        <div id="send-result" class="mt-2 text-sm"></div>
      </div>
    </section>
  </div>

</div>
</body></html>`;
}

// ─── Fragment Renderers ─────────────────────────────────────────────

function renderHealth() {
  const uptime = Math.floor((Date.now() - START_TIME) / 1000);
  const mem = process.memoryUsage();
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = uptime % 60;
  return `<div class="flex flex-wrap gap-6 text-sm">
    <span><strong>Uptime:</strong> ${h}h ${m}m ${s}s</span>
    <span><strong>Memory:</strong> ${(mem.rss / 1048576).toFixed(1)} MB RSS / ${(mem.heapUsed / 1048576).toFixed(1)} MB heap</span>
    <span><strong>Node:</strong> ${process.version}</span>
    <span><strong>PID:</strong> ${process.pid}</span>
  </div>`;
}

function renderIdentity() {
  const safeVars = ['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'TZ', 'CLAUDE_MODEL'];
  let html = '<div class="space-y-4">';

  // Safe env vars
  html += '<div class="grid grid-cols-2 gap-2 text-sm">';
  for (const key of safeVars) {
    const val = process.env[key];
    if (val !== undefined) {
      html += `<span class="text-gray-400">${esc(key)}</span><span>${esc(val)}</span>`;
    }
  }
  html += '</div>';

  // Global IDENTITY.md and CLAUDE.md
  const globalDir = path.join(process.cwd(), 'groups', 'global');
  for (const file of ['IDENTITY.md', 'CLAUDE.md']) {
    try {
      const content = fs.readFileSync(path.join(globalDir, file), 'utf-8');
      html += `<details class="mt-3">
        <summary class="cursor-pointer text-sm text-blue-400 hover:text-blue-300">${esc(file)}</summary>
        <pre class="mt-2 p-3 bg-gray-900 rounded text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap">${esc(content)}</pre>
      </details>`;
    } catch {}
  }

  html += '</div>';
  return html;
}

function renderChannels() {
  const channels = ctx.getChannelStatus();
  if (!channels.length) return '<p class="text-gray-500 text-sm">No channels connected</p>';
  return channels.map(c =>
    `<div class="flex items-center gap-2 py-1">
      <span class="dot ${c.connected ? 'dot-on' : 'dot-off'}"></span>
      <span>${esc(c.name)}</span>
      <span class="text-xs text-gray-500">${c.connected ? 'connected' : 'disconnected'}</span>
    </div>`
  ).join('');
}

function renderQueue() {
  const status = ctx.getQueueStatus();
  let html = `<div class="text-sm mb-2"><strong>Active containers:</strong> ${status.activeCount}</div>`;
  // Only show groups with activity (active, pending messages, pending tasks, or retries)
  const active = status.groups.filter(g => g.active || g.pendingMessages || g.pendingTaskCount > 0 || g.retryCount > 0);
  if (!active.length) {
    html += '<p class="text-gray-500 text-sm">No active queue items</p>';
  } else {
    // Look up registered groups to resolve JIDs to folder names
    const registered = ctx.getRegisteredGroups();
    html += '<div class="space-y-1 text-sm">';
    for (const g of active) {
      const name = g.folder || (registered[g.jid] ? registered[g.jid].folder : g.jid);
      const badges = [];
      if (g.active) badges.push('<span class="bg-green-800 text-green-200 px-1.5 py-0.5 rounded text-xs">active</span>');
      if (g.pendingMessages) badges.push('<span class="bg-yellow-800 text-yellow-200 px-1.5 py-0.5 rounded text-xs">pending</span>');
      if (g.pendingTaskCount > 0) badges.push(`<span class="bg-purple-800 text-purple-200 px-1.5 py-0.5 rounded text-xs">${g.pendingTaskCount} tasks</span>`);
      if (g.retryCount > 0) badges.push(`<span class="bg-red-800 text-red-200 px-1.5 py-0.5 rounded text-xs">retry ${g.retryCount}</span>`);
      html += `<div class="flex items-center gap-2">${esc(name)} ${badges.join(' ')}</div>`;
    }
    html += '</div>';
  }
  return html;
}

function renderGroups() {
  const groups = ctx.getRegisteredGroups();
  const entries = Object.entries(groups);
  if (!entries.length) return '<p class="text-gray-500 text-sm">No registered groups</p>';
  let html = `<table class="w-full text-sm"><thead><tr class="text-left text-gray-400 border-b border-gray-700">
    <th class="pb-2 pr-4">Name</th><th class="pb-2 pr-4">Folder</th><th class="pb-2 pr-4">Channel</th><th class="pb-2 pr-4">Trigger</th><th class="pb-2">Actions</th>
  </tr></thead><tbody>`;
  for (const [jid, g] of entries) {
    html += `<tr class="border-b border-gray-700/50">
      <td class="py-2 pr-4">${esc(g.name)}</td>
      <td class="py-2 pr-4 font-mono text-xs">${esc(g.folder)}</td>
      <td class="py-2 pr-4">${esc(g.channel || '-')}</td>
      <td class="py-2 pr-4 font-mono text-xs">${esc(g.trigger)}</td>
      <td class="py-2">
        <button hx-get="/api/groups/${encodeURIComponent(g.folder)}" hx-target="#group-detail" hx-swap="innerHTML"
          class="text-blue-400 hover:text-blue-300 text-xs">Detail</button>
      </td>
    </tr>`;
  }
  html += '</tbody></table>';
  return html;
}

function renderGroupDetail(folder) {
  const groups = ctx.getRegisteredGroups();
  const entry = Object.entries(groups).find(([, g]) => g.folder === folder);
  if (!entry) return '<p class="text-red-400">Group not found</p>';
  const [jid, g] = entry;
  const sessions = ctx.getSessions();
  const sessionId = sessions[folder] || 'none';

  let claudeMd = '';
  try {
    claudeMd = fs.readFileSync(path.join(process.cwd(), 'groups', folder, 'CLAUDE.md'), 'utf-8');
  } catch { claudeMd = '(no CLAUDE.md)'; }

  let mediaSize = '0 MB';
  try {
    const mediaDir = path.join(process.cwd(), 'groups', folder, 'media');
    if (fs.existsSync(mediaDir)) {
      let total = 0;
      for (const f of fs.readdirSync(mediaDir)) {
        try { total += fs.statSync(path.join(mediaDir, f)).size; } catch {}
      }
      mediaSize = (total / 1048576).toFixed(1) + ' MB';
    }
  } catch {}

  return `<div class="bg-gray-800 rounded-lg p-4 fade-in">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-semibold">Group: ${esc(g.name)}</h2>
      <button onclick="this.closest('section').innerHTML=''"
        class="text-gray-400 hover:text-white text-sm">Close</button>
    </div>
    <div class="grid grid-cols-2 gap-4 text-sm mb-4">
      <div><strong>JID:</strong> <span class="font-mono text-xs">${esc(jid)}</span></div>
      <div><strong>Folder:</strong> ${esc(folder)}</div>
      <div><strong>Channel:</strong> ${esc(g.channel || '-')}</div>
      <div><strong>Session:</strong> <span class="font-mono text-xs">${esc(sessionId.slice(0, 16))}${sessionId.length > 16 ? '...' : ''}</span></div>
      <div><strong>Media:</strong> ${esc(mediaSize)}</div>
      <div><strong>Added:</strong> ${esc(g.added_at)}</div>
    </div>
    <details class="text-sm">
      <summary class="cursor-pointer text-gray-400 hover:text-white mb-2">CLAUDE.md</summary>
      <pre class="bg-gray-900 p-3 rounded text-xs overflow-auto max-h-64">${esc(claudeMd)}</pre>
    </details>
    ${(() => {
      // Check both locations: group workspace and claude-code session data
      const candidates = [
        path.join(process.cwd(), 'groups', folder, 'MEMORY.md'),
        path.join(process.cwd(), 'data', 'sessions', folder, '.claude', 'projects', '-workspace-group', 'memory', 'MEMORY.md'),
      ];
      for (const p of candidates) {
        try {
          const memMd = fs.readFileSync(p, 'utf-8');
          return `<details class="text-sm mt-2">
            <summary class="cursor-pointer text-gray-400 hover:text-white mb-2">MEMORY.md</summary>
            <pre class="bg-gray-900 p-3 rounded text-xs overflow-auto max-h-64">${esc(memMd)}</pre>
          </details>`;
        } catch {}
      }
      return '<p class="text-gray-500 text-xs mt-2">No MEMORY.md found</p>';
    })()}
  </div>`;
}

function renderTasks() {
  const tasks = ctx.getAllTasks().filter(t => t.status !== 'completed');
  if (!tasks.length) return '<p class="text-gray-500 text-sm">No active scheduled tasks</p>';
  let html = `<table class="w-full text-sm"><thead><tr class="text-left text-gray-400 border-b border-gray-700">
    <th class="pb-2 pr-3">Group</th><th class="pb-2 pr-3">Prompt</th><th class="pb-2 pr-3">Schedule</th>
    <th class="pb-2 pr-3">Status</th><th class="pb-2 pr-3">Next Run</th><th class="pb-2">Actions</th>
  </tr></thead><tbody>`;
  for (const t of tasks) {
    const sc = t.status === 'active' ? 'text-green-400' : t.status === 'paused' ? 'text-yellow-400' : 'text-gray-500';
    const prompt = t.prompt.length > 60 ? t.prompt.slice(0, 60) + '...' : t.prompt;
    const next = t.next_run ? new Date(t.next_run).toLocaleString() : '-';
    const toggle = t.status === 'active' ? 'paused' : 'active';
    const label = t.status === 'active' ? 'Pause' : 'Resume';
    html += `<tr class="border-b border-gray-700/50">
      <td class="py-2 pr-3 font-mono text-xs">${esc(t.group_folder)}</td>
      <td class="py-2 pr-3" title="${esc(t.prompt)}">${esc(prompt)}</td>
      <td class="py-2 pr-3 font-mono text-xs">${esc(t.schedule_type)}: ${esc(t.schedule_value)}</td>
      <td class="py-2 pr-3 ${sc}">${esc(t.status)}</td>
      <td class="py-2 pr-3 text-xs">${esc(next)}</td>
      <td class="py-2 flex gap-2">
        <button hx-post="/api/tasks/${esc(t.id)}" hx-vals='${JSON.stringify({ status: toggle })}' hx-target="#tasks-section" hx-swap="innerHTML"
          class="text-yellow-400 hover:text-yellow-300 text-xs">${label}</button>
        <button hx-post="/api/tasks/${esc(t.id)}/run" hx-target="#tasks-section" hx-swap="innerHTML"
          class="text-green-400 hover:text-green-300 text-xs">Run Now</button>
        <button hx-get="/api/tasks/${esc(t.id)}/logs" hx-target="#task-logs" hx-swap="innerHTML"
          class="text-blue-400 hover:text-blue-300 text-xs">Logs</button>
        <button hx-delete="/api/tasks/${esc(t.id)}" hx-target="#tasks-section" hx-swap="innerHTML" hx-confirm="Delete this task?"
          class="text-red-400 hover:text-red-300 text-xs">Delete</button>
      </td>
    </tr>`;
  }
  html += '</tbody></table>';
  return html;
}

function renderTaskLogs(taskId) {
  const task = ctx.getTaskById(taskId);
  if (!task) return '<p class="text-red-400">Task not found</p>';
  const logs = ctx.getTaskRunLogs(taskId, 20);
  let html = `<div class="bg-gray-800 rounded-lg p-4 fade-in">
    <div class="flex items-center justify-between mb-4">
      <h3 class="text-lg font-semibold">Run Logs: ${esc(task.prompt.slice(0, 40))}...</h3>
      <button onclick="this.closest('section').innerHTML=''"
        class="text-gray-400 hover:text-white text-sm">Close</button>
    </div>`;
  if (!logs.length) {
    html += '<p class="text-gray-500 text-sm">No run logs yet</p>';
  } else {
    html += `<table class="w-full text-sm"><thead><tr class="text-left text-gray-400 border-b border-gray-700">
      <th class="pb-2 pr-3">Time</th><th class="pb-2 pr-3">Duration</th><th class="pb-2 pr-3">Status</th><th class="pb-2">Result</th>
    </tr></thead><tbody>`;
    for (const log of logs) {
      const sc = log.status === 'success' ? 'text-green-400' : 'text-red-400';
      const dur = (log.duration_ms / 1000).toFixed(1) + 's';
      const result = log.error || log.result || '-';
      const short = result.length > 80 ? result.slice(0, 80) + '...' : result;
      html += `<tr class="border-b border-gray-700/50">
        <td class="py-2 pr-3 text-xs">${esc(new Date(log.run_at).toLocaleString())}</td>
        <td class="py-2 pr-3">${esc(dur)}</td>
        <td class="py-2 pr-3 ${sc}">${esc(log.status)}</td>
        <td class="py-2 text-xs" title="${esc(result)}">${esc(short)}</td>
      </tr>`;
    }
    html += '</tbody></table>';
  }
  html += '</div>';
  return html;
}

function renderPlugins() {
  const plugins = ctx.getInstalledPlugins();
  if (!plugins.length) return '<p class="text-gray-500 text-sm">No plugins installed</p>';
  return `<div class="space-y-2">${plugins.map(p => {
    const type = p.channelPlugin
      ? '<span class="bg-blue-800 text-blue-200 px-1.5 py-0.5 rounded text-xs">channel</span>'
      : '<span class="bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded text-xs">skill</span>';
    const scope = [];
    if (p.groups && p.groups[0] !== '*') scope.push('groups: ' + p.groups.join(', '));
    if (p.channels && p.channels[0] !== '*') scope.push('channels: ' + p.channels.join(', '));
    const scopeHtml = scope.length ? ` <span class="text-gray-500 text-xs">(${esc(scope.join('; '))})</span>` : '';
    return `<div class="flex items-center gap-2">
      ${type}
      <strong>${esc(p.name)}</strong>
      ${p.version ? `<span class="text-gray-500 text-xs">v${esc(p.version)}</span>` : ''}
      ${p.description ? `<span class="text-gray-400 text-xs">- ${esc(p.description)}</span>` : ''}
      ${scopeHtml}
    </div>`;
  }).join('')}</div>`;
}

function renderTemplates() {
  try {
    const skillsDir = path.join(process.cwd(), '.claude', 'skills');
    const pluginsDir = path.join(process.cwd(), 'plugins');
    const dirs = fs.readdirSync(skillsDir).filter(d => d.startsWith('add-skill-'));
    // Build set of installed plugin names from plugins/ (flat + category subdirs)
    const installed = new Set();
    try {
      for (const entry of fs.readdirSync(pluginsDir)) {
        const ep = path.join(pluginsDir, entry);
        if (fs.statSync(ep).isDirectory()) {
          installed.add(entry);
          // Category subdirectories (e.g. plugins/channels/whatsapp)
          try {
            for (const sub of fs.readdirSync(ep)) {
              if (fs.statSync(path.join(ep, sub)).isDirectory()) installed.add(sub);
            }
          } catch {}
        }
      }
    } catch {}
    // Filter: read each template's plugin.json "name" to get the actual installed dir name
    const available = dirs.filter(d => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(skillsDir, d, 'files', 'plugin.json'), 'utf-8'));
        return !installed.has(manifest.name);
      } catch {
        // No plugin.json — fall back to dir name heuristic
        const name = d.replace('add-skill-', '');
        return !installed.has(name);
      }
    });
    if (!available.length) return '<p class="text-gray-500 text-sm">All skill plugins installed</p>';
    return `<div class="space-y-1 text-sm">${available.map(d => {
      let desc = '';
      try {
        const skill = fs.readFileSync(path.join(skillsDir, d, 'SKILL.md'), 'utf-8');
        const m = skill.match(/^description:\s*(.+)$/m);
        if (m) desc = m[1].split('.')[0];
      } catch {}
      return `<div><code class="text-blue-400">/${d}</code>${desc ? ` <span class="text-gray-400">- ${esc(desc)}</span>` : ''}</div>`;
    }).join('')}</div>`;
  } catch {
    return '<p class="text-gray-500 text-sm">Could not read templates</p>';
  }
}

function renderMessages(folder) {
  if (!folder) return '<p class="text-gray-500 text-sm">Select a group to view messages</p>';
  const groups = ctx.getRegisteredGroups();
  let chatJid = null;
  for (const [j, g] of Object.entries(groups)) {
    if (g.folder === folder) { chatJid = j; break; }
  }
  if (!chatJid) return `<p class="text-red-400">Group not found: ${esc(folder)}</p>`;
  const messages = ctx.getRecentMessages(chatJid, 50);
  if (!messages.length) return '<p class="text-gray-500 text-sm">No messages</p>';
  const sorted = [...messages].reverse();
  return `<div class="space-y-2 max-h-96 overflow-y-auto">${sorted.map(m => {
    const time = new Date(m.timestamp).toLocaleTimeString();
    const isBot = m.is_bot_message || m.is_from_me;
    const bg = isBot ? 'bg-gray-700/50' : 'bg-gray-900/50';
    const content = m.content || '';
    return `<div class="px-3 py-2 rounded ${bg} text-sm">
      <span class="text-gray-400 text-xs">${esc(time)}</span>
      <strong class="${isBot ? 'text-blue-400' : 'text-green-400'}">${esc(m.sender_name)}</strong>:
      ${esc(content.slice(0, 300))}${content.length > 300 ? '...' : ''}
    </div>`;
  }).join('')}</div>`;
}

function renderGroupOptions() {
  const groups = ctx.getRegisteredGroups();
  return Object.entries(groups).map(([, g]) =>
    `<option value="${esc(g.folder)}">${esc(g.name)} (${esc(g.folder)})</option>`
  ).join('');
}

function renderJidOptions() {
  const groups = ctx.getRegisteredGroups();
  return Object.entries(groups).map(([jid, g]) =>
    `<option value="${esc(jid)}">${esc(g.name)}</option>`
  ).join('');
}

function renderLogs() {
  try {
    const logPath = path.join(process.cwd(), 'logs', 'nanoclaw.log');
    const stat = fs.statSync(logPath);
    const readSize = Math.min(stat.size, 65536);
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);
    const text = buf.toString('utf-8');
    const firstNewline = text.indexOf('\n');
    const lines = text.slice(firstNewline + 1).split('\n').filter(l => l.trim());
    const last = lines.slice(-100);
    return `<div class="flex justify-between items-center mb-3">
      <span class="text-xs text-gray-500">Last ${last.length} lines (tail 64KB of ${(stat.size / 1048576).toFixed(1)} MB)</span>
    </div>
    <pre class="bg-gray-900 p-3 rounded text-xs overflow-auto max-h-96 font-mono leading-relaxed">${esc(last.join('\n'))}</pre>`;
  } catch (err) {
    return `<p class="text-red-400">Could not read logs: ${esc(err.message)}</p>`;
  }
}

function renderRecentRuns() {
  const tasks = ctx.getAllTasks();
  const allLogs = [];
  for (const t of tasks) {
    const logs = ctx.getTaskRunLogs(t.id, 5);
    for (const log of logs) {
      allLogs.push({ ...log, group_folder: t.group_folder, prompt: t.prompt });
    }
  }
  allLogs.sort((a, b) => new Date(b.run_at).getTime() - new Date(a.run_at).getTime());
  const recent = allLogs.slice(0, 15);
  if (!recent.length) return '<p class="text-gray-500 text-sm">No task runs yet</p>';
  let html = `<table class="w-full text-sm"><thead><tr class="text-left text-gray-400 border-b border-gray-700">
    <th class="pb-2 pr-3">Time</th><th class="pb-2 pr-3">Group</th><th class="pb-2 pr-3">Prompt</th>
    <th class="pb-2 pr-3">Duration</th><th class="pb-2">Status</th>
  </tr></thead><tbody>`;
  for (const r of recent) {
    const sc = r.status === 'success' ? 'text-green-400' : 'text-red-400';
    const dur = (r.duration_ms / 1000).toFixed(1) + 's';
    const prompt = r.prompt.length > 40 ? r.prompt.slice(0, 40) + '...' : r.prompt;
    const time = new Date(r.run_at).toLocaleString();
    html += `<tr class="border-b border-gray-700/50">
      <td class="py-1.5 pr-3 text-xs">${esc(time)}</td>
      <td class="py-1.5 pr-3 font-mono text-xs">${esc(r.group_folder)}</td>
      <td class="py-1.5 pr-3 text-xs" title="${esc(r.prompt)}">${esc(prompt)}</td>
      <td class="py-1.5 pr-3">${esc(dur)}</td>
      <td class="py-1.5 ${sc}">${esc(r.status)}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  return html;
}

// ─── HTTP Server ────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        try { resolve(JSON.parse(body)); } catch { resolve({}); }
      } else {
        const params = {};
        for (const pair of body.split('&')) {
          const [k, ...v] = pair.split('=');
          if (k) params[decodeURIComponent(k)] = decodeURIComponent(v.join('='));
        }
        resolve(params);
      }
    });
    req.on('error', reject);
  });
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === '/logout') {
    res.writeHead(302, { 'Set-Cookie': 'dashboard_token=; Path=/; Max-Age=0', Location: '/' });
    res.end();
    return;
  }

  if (!checkAuth(req, res)) {
    if (!res.writableEnded) sendHtml(res, loginPage(), 401);
    return;
  }

  try {
    if (method === 'GET' && pathname === '/') return sendHtml(res, shell());
    if (method === 'GET' && pathname === '/api/health') return sendHtml(res, renderHealth());
    if (method === 'GET' && pathname === '/api/channels') return sendHtml(res, renderChannels());
    if (method === 'GET' && pathname === '/api/identity') return sendHtml(res, renderIdentity());
    if (method === 'GET' && pathname === '/api/queue') return sendHtml(res, renderQueue());
    if (method === 'GET' && pathname === '/api/groups') return sendHtml(res, renderGroups());
    if (method === 'GET' && pathname === '/api/plugins') return sendHtml(res, renderPlugins());
    if (method === 'GET' && pathname === '/api/templates') return sendHtml(res, renderTemplates());
    if (method === 'GET' && pathname === '/api/group-options') return sendHtml(res, renderGroupOptions());
    if (method === 'GET' && pathname === '/api/jid-options') return sendHtml(res, renderJidOptions());
    if (method === 'GET' && pathname === '/api/tasks') return sendHtml(res, renderTasks());
    if (method === 'GET' && pathname === '/api/logs') return sendHtml(res, renderLogs());
    if (method === 'GET' && pathname === '/api/runs') return sendHtml(res, renderRecentRuns());

    if (method === 'GET' && pathname === '/api/messages') {
      return sendHtml(res, renderMessages(url.searchParams.get('group_folder')));
    }

    // Group detail: /api/groups/:folder
    const groupMatch = pathname.match(/^\/api\/groups\/([^/]+)$/);
    if (method === 'GET' && groupMatch) {
      return sendHtml(res, renderGroupDetail(decodeURIComponent(groupMatch[1])));
    }

    // Task run now: POST /api/tasks/:id/run
    const runMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
    if (method === 'POST' && runMatch) {
      const id = decodeURIComponent(runMatch[1]);
      const task = ctx.getTaskById(id);
      if (!task) return sendHtml(res, '<p class="text-red-400">Task not found</p>', 404);
      // Set next_run to now and ensure active — scheduler picks it up within 60s
      ctx.updateTask(id, { next_run: new Date().toISOString(), status: 'active' });
      return sendHtml(res, renderTasks());
    }

    // Task logs: /api/tasks/:id/logs
    const logsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/logs$/);
    if (method === 'GET' && logsMatch) {
      return sendHtml(res, renderTaskLogs(decodeURIComponent(logsMatch[1])));
    }

    // Create task
    if (method === 'POST' && pathname === '/api/tasks') {
      parseBody(req).then(body => {
        const groups = ctx.getRegisteredGroups();
        const entry = Object.entries(groups).find(([, g]) => g.folder === body.group_folder);
        if (!entry) return sendHtml(res, '<p class="text-red-400">Group not found</p>', 400);
        ctx.createTask({
          id: randomUUID(),
          group_folder: body.group_folder,
          chat_jid: entry[0],
          prompt: body.prompt,
          schedule_type: body.schedule_type,
          schedule_value: body.schedule_value,
          context_mode: body.context_mode || 'isolated',
          model: 'claude-sonnet-4-5',
          next_run: new Date().toISOString(),
          status: 'active',
          created_at: new Date().toISOString(),
        });
        sendHtml(res, renderTasks());
      }).catch(() => sendHtml(res, '<p class="text-red-400">Bad request</p>', 400));
      return;
    }

    // Update task: POST /api/tasks/:id
    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === 'POST' && taskMatch) {
      parseBody(req).then(body => {
        const VALID_STATUSES = new Set(['active', 'paused']);
        const VALID_SCHEDULE_TYPES = new Set(['cron', 'interval', 'once']);
        const updates = {};
        if (body.status && VALID_STATUSES.has(body.status)) updates.status = body.status;
        if (body.prompt) updates.prompt = body.prompt;
        if (body.schedule_value) updates.schedule_value = body.schedule_value;
        if (body.schedule_type && VALID_SCHEDULE_TYPES.has(body.schedule_type)) updates.schedule_type = body.schedule_type;
        ctx.updateTask(decodeURIComponent(taskMatch[1]), updates);
        sendHtml(res, renderTasks());
      }).catch(() => sendHtml(res, '<p class="text-red-400">Bad request</p>', 400));
      return;
    }

    // Delete task: DELETE /api/tasks/:id
    if (method === 'DELETE' && taskMatch) {
      ctx.deleteTask(decodeURIComponent(taskMatch[1]));
      return sendHtml(res, renderTasks());
    }

    // Send message
    if (method === 'POST' && pathname === '/api/send') {
      parseBody(req).then(async (body) => {
        if (!body.jid || !body.text) return sendHtml(res, '<p class="text-red-400">Missing jid or text</p>', 400);
        const groups = ctx.getRegisteredGroups();
        if (!groups[body.jid]) return sendHtml(res, '<p class="text-red-400">JID not in registered groups</p>', 400);
        try {
          await ctx.sendMessage(body.jid, body.text);
          sendHtml(res, '<p class="text-green-400">Message sent</p>');
        } catch (err) {
          sendHtml(res, `<p class="text-red-400">Failed: ${esc(err.message)}</p>`, 500);
        }
      }).catch(() => sendHtml(res, '<p class="text-red-400">Bad request</p>', 400));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    ctx.logger.error({ err, path: pathname }, 'Dashboard request error');
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error');
  }
}

// ─── Plugin Hooks ───────────────────────────────────────────────────

export async function onStartup(pluginCtx) {
  ctx = pluginCtx;
  const secret = process.env.DASHBOARD_SECRET || '';
  const port = parseInt(process.env.DASHBOARD_PORT || '3456', 10);
  const host = process.env.DASHBOARD_HOST || '127.0.0.1';

  if (!secret) {
    ctx.logger.warn('Dashboard disabled — set DASHBOARD_SECRET in .env to enable');
    return;
  }

  // Update secret at startup (env is loaded by core before plugins start)
  dashboardSecret = secret;

  server = http.createServer(handleRequest);
  server.listen(port, host, () => {
    ctx.logger.info({ port, host }, 'Dashboard listening');
  });
}

export async function onShutdown() {
  if (server) {
    await new Promise(resolve => server.close(resolve));
    server = null;
  }
}
