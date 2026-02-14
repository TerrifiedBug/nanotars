/**
 * WhatsApp Authentication Script
 *
 * Run this during setup to authenticate with WhatsApp.
 * Displays QR code, waits for scan, saves credentials, then exits.
 *
 * Usage:
 *   npx tsx src/whatsapp-auth.ts                           # Terminal QR
 *   npx tsx src/whatsapp-auth.ts --serve                   # HTTP server on :8899
 *   npx tsx src/whatsapp-auth.ts --serve --port 8900       # Custom port
 *   npx tsx src/whatsapp-auth.ts --auth-dir store/alt-auth # Custom auth dir
 *   npx tsx src/whatsapp-auth.ts --pairing-code --phone N  # Pairing code
 */
import fs from 'fs';
import http from 'http';
import pino from 'pino';
import QRCode from 'qrcode';
import qrcode from 'qrcode-terminal';
import readline from 'readline';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

// CLI flags
const usePairingCode = process.argv.includes('--pairing-code');
const useServe = process.argv.includes('--serve');
const phoneArg = process.argv.find((_, i, arr) => arr[i - 1] === '--phone');
const portArg = process.argv.find((_, i, arr) => arr[i - 1] === '--port');
const authDirArg = process.argv.find((_, i, arr) => arr[i - 1] === '--auth-dir');

const AUTH_DIR = authDirArg || './store/auth';
const QR_FILE = './store/qr-data.txt';
const STATUS_FILE = './store/auth-status.txt';
const SERVE_PORT = portArg ? parseInt(portArg, 10) : 8899;

const logger = pino({
  level: 'warn',
});

// HTTP server state (only used with --serve)
let currentQR: string | null = null;
let authStatus: 'waiting' | 'success' | 'failed' = 'waiting';
let httpServer: http.Server | undefined;

function startHttpServer(): void {
  const templatePath = '.claude/skills/setup/qr-auth.html';
  const hasTemplate = fs.existsSync(templatePath);

  httpServer = http.createServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });

    if (authStatus === 'success') {
      res.end('<html><body style="text-align:center;font-family:sans-serif;padding:50px"><h1>Authenticated!</h1><p>WhatsApp is now connected. You can close this page.</p></body></html>');
      return;
    }

    if (!currentQR) {
      res.end('<html><body style="text-align:center;font-family:sans-serif;padding:50px"><h1>Waiting for QR code...</h1><script>setTimeout(()=>location.reload(),2000)</script></body></html>');
      return;
    }

    const svgQR = await QRCode.toString(currentQR, { type: 'svg', width: 400, margin: 2 });

    if (hasTemplate) {
      const template = fs.readFileSync(templatePath, 'utf-8');
      res.end(template.replace('{{QR_SVG}}', svgQR));
    } else {
      res.end(`<html><body style="text-align:center;font-family:sans-serif;padding:20px">
        <h2>Scan with WhatsApp</h2>
        <p>Settings &rarr; Linked Devices &rarr; Link a Device</p>
        <div style="display:inline-block;padding:20px;background:white;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,0.1)">${svgQR}</div>
        <p style="color:#888;margin-top:20px">QR code refreshes automatically</p>
        <script>setTimeout(()=>location.reload(),30000)</script>
      </body></html>`);
    }
  });

  httpServer.listen(SERVE_PORT, '0.0.0.0', () => {
    console.log(`\nQR code server running at http://0.0.0.0:${SERVE_PORT}`);
    console.log('Open this URL in your browser to scan the QR code.\n');
  });
}

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function shutdown(code: number): void {
  if (httpServer) httpServer.close();
  setTimeout(() => process.exit(code), 1000);
}

async function connectSocket(phoneNumber?: string): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (state.creds.registered) {
    fs.writeFileSync(STATUS_FILE, 'already_authenticated');
    console.log('✓ Already authenticated with WhatsApp');
    console.log(
      `  To re-authenticate, delete the ${AUTH_DIR} folder and run again.`,
    );
    shutdown(0);
    return;
  }

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
  });

  if (usePairingCode && phoneNumber && !state.creds.me) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber!);
        console.log(`\n🔗 Your pairing code: ${code}\n`);
        console.log('  1. Open WhatsApp on your phone');
        console.log('  2. Tap Settings → Linked Devices → Link a Device');
        console.log('  3. Tap "Link with phone number instead"');
        console.log(`  4. Enter this code: ${code}\n`);
        fs.writeFileSync(STATUS_FILE, `pairing_code:${code}`);
      } catch (err: any) {
        console.error('Failed to request pairing code:', err.message);
        shutdown(1);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      fs.writeFileSync(QR_FILE, qr);
      if (!useServe) {
        console.log('Scan this QR code with WhatsApp:\n');
        console.log('  1. Open WhatsApp on your phone');
        console.log('  2. Tap Settings → Linked Devices → Link a Device');
        console.log('  3. Point your camera at the QR code below\n');
        qrcode.generate(qr, { small: true });
      } else {
        console.log('New QR code generated — refresh browser if needed');
      }
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        authStatus = 'failed';
        fs.writeFileSync(STATUS_FILE, 'failed:logged_out');
        console.log(`\n✗ Logged out. Delete ${AUTH_DIR} and try again.`);
        shutdown(1);
      } else if (reason === DisconnectReason.timedOut) {
        fs.writeFileSync(STATUS_FILE, 'failed:qr_timeout');
        console.log('\n✗ QR code timed out. Please try again.');
        shutdown(1);
      } else if (reason === 515) {
        // 515 = stream error, often happens after pairing succeeds but before
        // registration completes. Reconnect to finish the handshake.
        console.log('\n⟳ Stream error (515) after pairing — reconnecting...');
        connectSocket(phoneNumber);
      } else {
        authStatus = 'failed';
        fs.writeFileSync(STATUS_FILE, `failed:${reason || 'unknown'}`);
        console.log('\n✗ Connection failed. Please try again.');
        shutdown(1);
      }
    }

    if (connection === 'open') {
      authStatus = 'success';
      fs.writeFileSync(STATUS_FILE, 'authenticated');
      try { fs.unlinkSync(QR_FILE); } catch {}
      console.log('\n✓ Successfully authenticated with WhatsApp!');
      console.log(`  Credentials saved to ${AUTH_DIR}/`);
      console.log('  You can now start the NanoClaw service.\n');
      shutdown(0);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

async function authenticate(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  // Clean up any stale QR/status files from previous runs
  try { fs.unlinkSync(QR_FILE); } catch {}
  try { fs.unlinkSync(STATUS_FILE); } catch {}

  if (useServe) startHttpServer();

  let phoneNumber = phoneArg;
  if (usePairingCode && !phoneNumber) {
    phoneNumber = await askQuestion('Enter your phone number (with country code, no + or spaces, e.g. 14155551234): ');
  }

  console.log('Starting WhatsApp authentication...\n');

  await connectSocket(phoneNumber);
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  shutdown(1);
});
