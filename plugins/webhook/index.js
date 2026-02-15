import crypto from 'crypto';
import http from 'http';

const MAX_BODY_SIZE = 65536; // 64KB
let server;

export async function onStartup(ctx) {
  const secret = process.env.NANOCLAW_WEBHOOK_SECRET;
  if (!secret) {
    ctx.logger.debug('Webhook plugin: NANOCLAW_WEBHOOK_SECRET not set, skipping');
    return;
  }

  const port = parseInt(process.env.WEBHOOK_PORT || '3457', 10);
  const host = process.env.WEBHOOK_HOST || '127.0.0.1';

  server = http.createServer((req, res) => {
    const ip = req.socket.remoteAddress;

    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${secret}`) {
      ctx.logger.warn({ ip }, 'Webhook 401: auth rejected');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

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

      const mainJid = ctx.getMainChannelJid();
      if (!mainJid) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No main channel configured' }));
        return;
      }

      const messageId = `wh-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      ctx.insertMessage(mainJid, messageId, `webhook:${source}`, source, text);

      ctx.logger.info({ source, messageId, length: text.length }, 'Webhook message injected');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, messageId }));
    });
  });

  server.listen(port, host, () => {
    ctx.logger.info({ port, host }, 'Webhook server listening');
  });
}

export async function onShutdown() {
  if (server) {
    server.close();
    server = null;
  }
}
