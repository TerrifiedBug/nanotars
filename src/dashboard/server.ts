import fs from 'fs';
import http from 'http';
import path from 'path';
import { URL } from 'url';

import { deleteTask, getTaskById, updateTask } from '../db/tasks.js';
import { collectDashboardSnapshot } from './snapshot.js';

export interface DashboardServerOptions {
  projectRoot: string;
  host: string;
  port: number;
  secret?: string;
}

export function startDashboardServer(options: DashboardServerOptions): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, options).catch((err) => {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: DashboardServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${options.host}:${options.port}`}`);

  if (url.pathname === '/api/status') {
    json(res, 200, {
      ok: true,
      auth_required: Boolean(options.secret),
      pid: process.pid,
      uptime_sec: Math.floor(process.uptime()),
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/dashboard') {
    html(res, renderDashboardHtml(Boolean(options.secret)));
    return;
  }

  if (!isAuthorized(req, url, options.secret)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/snapshot') {
    json(res, 200, collectDashboardSnapshot(options.projectRoot));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    json(res, 200, { lines: tailLog(path.join(options.projectRoot, 'logs', 'nanotars.log'), 160) });
    return;
  }

  const taskAction = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(pause|resume|delete|run-now)$/);
  if (req.method === 'POST' && taskAction) {
    const [, taskId, action] = taskAction;
    const task = getTaskById(decodeURIComponent(taskId));
    if (!task) {
      json(res, 404, { error: 'task not found' });
      return;
    }
    switch (action) {
      case 'pause':
        updateTask(task.id, { status: 'paused' });
        break;
      case 'resume':
        updateTask(task.id, { status: 'active' });
        break;
      case 'run-now':
        updateTask(task.id, { status: 'active', next_run: new Date().toISOString() });
        break;
      case 'delete':
        deleteTask(task.id);
        break;
    }
    json(res, 200, { ok: true });
    return;
  }

  json(res, 404, { error: 'not found' });
}

function isAuthorized(req: http.IncomingMessage, url: URL, secret?: string): boolean {
  if (!secret) return true;
  const header = req.headers.authorization;
  if (header === `Bearer ${secret}`) return true;
  if (url.searchParams.get('token') === secret) return true;
  const cookie = req.headers.cookie ?? '';
  return cookie.split(';').some((part) => part.trim() === `nanotars_dashboard=${encodeURIComponent(secret)}`);
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function html(res: http.ServerResponse, body: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function tailLog(file: string, maxLines: number): string[] {
  if (!fs.existsSync(file)) return [];
  const maxBytes = 128 * 1024;
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
    return buffer
      .toString('utf8')
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split('\n')
      .filter((line) => line.trim())
      .slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

function renderDashboardHtml(authRequired: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NanoTars Dashboard</title>
  <style>
    :root { color-scheme: dark; --bg:#101114; --panel:#181b20; --line:#2b3038; --text:#f3f0e8; --muted:#a8b0bd; --accent:#6ee7b7; --warn:#fbbf24; --bad:#fb7185; --blue:#93c5fd; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--text); }
    header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:18px 22px; border-bottom:1px solid var(--line); position:sticky; top:0; background:rgba(16,17,20,.96); }
    h1 { margin:0; font-size:20px; font-weight:650; }
    main { padding:18px; display:grid; gap:18px; max-width:1500px; margin:0 auto; }
    .toolbar { display:flex; gap:10px; align-items:center; color:var(--muted); font-size:13px; }
    button { background:#242933; color:var(--text); border:1px solid var(--line); border-radius:6px; padding:7px 10px; cursor:pointer; font:inherit; }
    button:hover { border-color:#536070; }
    .danger { color:#fecdd3; }
    .grid { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:12px; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; min-width:0; }
    .metric { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    .value { font-size:28px; margin-top:4px; }
    .cols { display:grid; grid-template-columns: 1.2fr .8fr; gap:18px; align-items:start; }
    h2 { font-size:15px; margin:0 0 12px; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
    th { color:var(--muted); font-weight:550; }
    .pill { display:inline-block; padding:2px 7px; border-radius:999px; background:#26303a; color:var(--blue); font-size:12px; margin:1px 3px 1px 0; }
    .ok { color:var(--accent); } .warn { color:var(--warn); } .bad { color:var(--bad); }
    .muted { color:var(--muted); } .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .log { max-height:360px; overflow:auto; white-space:pre-wrap; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; color:#d6d3d1; }
    .task-actions { display:flex; gap:6px; flex-wrap:wrap; }
    @media (max-width: 1000px) { .grid, .cols { grid-template-columns:1fr; } header { align-items:flex-start; flex-direction:column; } }
  </style>
</head>
<body>
  <header>
    <h1>NanoTars Dashboard</h1>
    <div class="toolbar"><span id="status">loading</span><button onclick="refresh()">Refresh</button></div>
  </header>
  <main>
    <section class="grid" id="metrics"></section>
    <section class="cols">
      <div class="panel"><h2>Groups</h2><div id="groups"></div></div>
      <div class="panel"><h2>Runtime</h2><div id="runtime"></div></div>
    </section>
    <section class="cols">
      <div class="panel"><h2>Scheduled Tasks</h2><div id="tasks"></div></div>
      <div class="panel"><h2>Channels</h2><div id="channels"></div></div>
    </section>
    <section class="cols">
      <div class="panel"><h2>Recent Messages</h2><div id="messages"></div></div>
      <div class="panel"><h2>Plugins</h2><div id="plugins"></div></div>
    </section>
    <section class="panel"><h2>Logs</h2><div class="log" id="logs"></div></section>
  </main>
  <script>
    const authRequired = ${JSON.stringify(authRequired)};
    let token = new URLSearchParams(location.search).get('token') || localStorage.getItem('nanotars_dashboard_token') || '';
    if (authRequired && !token) token = prompt('Dashboard token') || '';
    if (token) localStorage.setItem('nanotars_dashboard_token', token);
    const headers = () => token ? { Authorization: 'Bearer ' + token } : {};
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const short = (v, n=90) => { const s = String(v ?? ''); return s.length > n ? s.slice(0, n - 1) + '...' : s; };
    async function api(path, opts = {}) {
      const res = await fetch(path, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
      if (res.status === 401) { localStorage.removeItem('nanotars_dashboard_token'); throw new Error('unauthorized'); }
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }
    function table(cols, rows) {
      if (!rows.length) return '<div class="muted">(none)</div>';
      return '<table><thead><tr>' + cols.map(c => '<th>' + esc(c[0]) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + cols.map(c => '<td>' + c[1](r) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    }
    async function task(id, action) { await api('/api/tasks/' + encodeURIComponent(id) + '/' + action, { method:'POST' }); await refresh(); }
    async function refresh() {
      try {
        const snap = await api('/api/snapshot');
        document.getElementById('status').innerHTML = '<span class="ok">live</span> ' + esc(snap.generated_at) + ' host=' + esc(snap.health.host_status);
        const metrics = [['Groups', snap.counts.groups], ['Channels', snap.counts.channels], ['Tasks', snap.counts.active_tasks + '/' + snap.counts.tasks], ['Containers', snap.counts.active_containers], ['Failures', snap.counts.recent_failures], ['Plugins', snap.counts.plugins], ['Messages', snap.recent_messages.length], ['Memory', snap.health.memory_mb + ' MB']];
        document.getElementById('metrics').innerHTML = metrics.map(m => '<div class="panel"><div class="metric">' + esc(m[0]) + '</div><div class="value">' + esc(m[1]) + '</div></div>').join('');
        document.getElementById('groups').innerHTML = table([['Folder', r => '<span class="mono">' + esc(r.folder) + '</span>'], ['Name', r => esc(r.name)], ['Wirings', r => r.wirings.map(w => '<span class="pill">' + esc(w.channel) + '</span>').join('') || '<span class="muted">none</span>'], ['Tasks', r => esc(r.tasks)], ['Containers', r => esc(r.active_containers)]], snap.groups);
        document.getElementById('runtime').innerHTML = '<div class="metric">active</div><div class="value">' + esc(snap.runtime.active) + '</div>' + table([['Status', r => '<span class="' + (r.status === 'running' ? 'ok' : r.status === 'completed' ? 'muted' : 'bad') + '">' + esc(r.status) + '</span>'], ['Group', r => esc(r.group_folder)], ['Reason', r => esc(r.reason)], ['Updated', r => esc(r.updated_at)]], snap.runtime.containers.slice(0, 10));
        document.getElementById('tasks').innerHTML = table([['Status', r => '<span class="' + (r.status === 'active' ? 'ok' : 'warn') + '">' + esc(r.status) + '</span>'], ['Group', r => esc(r.group_folder)], ['Prompt', r => esc(short(r.prompt))], ['Next', r => esc(r.next_run || '')], ['Actions', r => '<div class="task-actions"><button onclick="task(\\'' + esc(r.id) + '\\',\\'run-now\\')">Run</button><button onclick="task(\\'' + esc(r.id) + '\\',\\'' + (r.status === 'active' ? 'pause' : 'resume') + '\\')">' + (r.status === 'active' ? 'Pause' : 'Resume') + '</button><button class="danger" onclick="task(\\'' + esc(r.id) + '\\',\\'delete\\')">Delete</button></div>']], snap.tasks);
        document.getElementById('channels').innerHTML = table([['Channel', r => esc(r.channel)], ['Chats', r => esc(r.chats)], ['Groups', r => esc(r.group_chats)], ['Latest', r => esc(r.latest_activity || '')]], snap.channels);
        document.getElementById('messages').innerHTML = table([['Time', r => esc(r.timestamp)], ['Chat', r => esc(short(r.chat_jid, 36))], ['Sender', r => esc(short(r.sender_name, 24))], ['Text', r => esc(short(r.content, 110))]], snap.recent_messages.slice(0, 20));
        document.getElementById('plugins').innerHTML = table([['Name', r => esc(r.name)], ['Type', r => esc(r.type)], ['Version', r => esc(r.version || '')], ['Scope', r => esc((r.channels || []).join(', '))]], snap.plugins);
        const logs = await api('/api/logs');
        document.getElementById('logs').textContent = logs.lines.join('\\n');
      } catch (err) {
        document.getElementById('status').innerHTML = '<span class="bad">' + esc(err.message || err) + '</span>';
      }
    }
    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>`;
}
