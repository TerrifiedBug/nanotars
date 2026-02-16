import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

const MAX_BODY_SIZE = 65536; // 64KB
const ROUTES_FILE = path.join('data', 'webhook-routes.json');

let server;
let routes = {};
let fsWatcher;

function loadRoutes(logger) {
  try {
    const data = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf-8'));
    routes = data.routes || {};
    return Object.keys(routes).length;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger?.warn({ err }, 'Failed to parse webhook routes file');
    }
    routes = {};
    return 0;
  }
}

function findJidByFolder(ctx, folder) {
  const groups = ctx.getRegisteredGroups();
  const entry = Object.entries(groups).find(([, g]) => g.folder === folder);
  return entry ? entry[0] : null;
}

function handleRequest(ctx, req, res) {
  const ip = req.socket.remoteAddress;

  if (req.method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Parse path: /webhook → folder "main", /webhook/family-chat → folder "family-chat"
  const urlPath = (req.url || '').split('?')[0];
  const match = urlPath.match(/^\/webhook(?:\/(.+))?$/);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const folder = match[1] || 'main';
  const route = routes[folder];

  if (!route) {
    ctx.logger.warn({ ip, folder }, 'Webhook 404: unknown route');
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown webhook route' }));
    return;
  }

  // Verify per-route token
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${route.secret}`) {
    ctx.logger.warn({ ip, folder }, 'Webhook 401: auth rejected');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // Read body
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
    if (body.length > MAX_BODY_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      req.destroy();
    }
  });

  req.on('end', () => {
    if (res.writableEnded) return;

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const source = payload.source || 'webhook';
    const text = payload.text;

    if (!text || typeof text !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "text" field' }));
      return;
    }

    const jid = findJidByFolder(ctx, folder);
    if (!jid) {
      ctx.logger.warn({ folder }, 'Webhook 404: group not registered');
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Group not registered' }));
      return;
    }

    const messageId = `wh-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    ctx.insertMessage(jid, messageId, `webhook:${source}`, source, text);

    ctx.logger.info({ source, folder, messageId, length: text.length }, 'Webhook message injected');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, messageId }));
  });
}

export async function onStartup(ctx) {
  const count = loadRoutes(ctx.logger);
  if (count === 0) {
    ctx.logger.debug('Webhook plugin: no routes configured, skipping');
    return;
  }

  ctx.logger.info({ routeCount: count, routes: Object.keys(routes) }, 'Webhook routes loaded');

  const port = parseInt(process.env.WEBHOOK_PORT || '3457', 10);
  const host = process.env.WEBHOOK_HOST || '127.0.0.1';

  server = http.createServer((req, res) => handleRequest(ctx, req, res));

  server.listen(port, host, () => {
    ctx.logger.info({ port, host }, 'Webhook server listening');
  });

  // Watch routes file for changes (hot-reload without restart)
  try {
    fsWatcher = fs.watch(ROUTES_FILE, () => {
      const newCount = loadRoutes(ctx.logger);
      ctx.logger.info({ routeCount: newCount, routes: Object.keys(routes) }, 'Webhook routes reloaded');
    });
  } catch {
    // File watching is optional — routes still work, just need restart to update
  }
}

export async function onShutdown() {
  if (fsWatcher) {
    fsWatcher.close();
    fsWatcher = null;
  }
  if (server) {
    server.close();
    server = null;
  }
}
