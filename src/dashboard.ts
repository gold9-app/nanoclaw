import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT) || 3000;

// ── Bot process state ──
let bot: ChildProcess | null = null;
let botStartTime: number | null = null;
const sseClients = new Set<http.ServerResponse>();
const MAX_LOG_LINES = 200;
const logBuffer: { text: string; type: string }[] = [];

// Strip ANSI escape codes from log output
function stripAnsi(str: string): string {
  return str.replace(
    /[\u001b\u009b]\[[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g,
    '',
  );
}

function classifyLog(line: string): string {
  const lower = line.toLowerCase();
  if (lower.includes('error') || lower.includes('fatal')) return 'error';
  if (lower.includes('warn')) return 'warn';
  if (lower.includes('info') || lower.includes('connected')) return 'info';
  return '';
}

function pushLog(text: string) {
  const clean = stripAnsi(text).trim();
  if (!clean) return;

  for (const line of clean.split('\n')) {
    if (!line.trim()) continue;
    const entry = { text: line, type: classifyLog(line) };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
    broadcast('log', entry);
  }
}

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function broadcastStatus() {
  broadcast('status', getStatus());
}

function getStatus() {
  return {
    running: bot !== null && bot.exitCode === null,
    pid: bot?.pid ?? null,
    uptime:
      bot && botStartTime ? Math.floor((Date.now() - botStartTime) / 1000) : 0,
  };
}

function startBot(): { ok: boolean; error?: string } {
  if (bot && bot.exitCode === null) {
    return { ok: false, error: 'Bot is already running' };
  }

  const projectRoot = path.resolve(__dirname, '..');
  bot = spawn('npx', ['tsx', '--env-file=.env', 'src/index.ts'], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  botStartTime = Date.now();
  pushLog('[Dashboard] Bot started (PID: ' + bot.pid + ')');
  broadcastStatus();

  bot.stdout?.on('data', (chunk: Buffer) => pushLog(chunk.toString()));
  bot.stderr?.on('data', (chunk: Buffer) => pushLog(chunk.toString()));

  bot.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    pushLog(`[Dashboard] Bot exited (${reason})`);
    bot = null;
    botStartTime = null;
    broadcastStatus();
  });

  bot.on('error', (err) => {
    pushLog(`[Dashboard] Bot spawn error: ${err.message}`);
    bot = null;
    botStartTime = null;
    broadcastStatus();
  });

  return { ok: true };
}

function stopBot(): { ok: boolean; error?: string } {
  if (!bot || bot.exitCode !== null) {
    return { ok: false, error: 'Bot is not running' };
  }

  pushLog('[Dashboard] Stopping bot...');
  bot.kill('SIGTERM');

  // Force kill after 5s if still alive
  const pid = bot.pid;
  setTimeout(() => {
    if (bot && bot.pid === pid && bot.exitCode === null) {
      pushLog('[Dashboard] Force killing bot...');
      bot.kill('SIGKILL');
    }
  }, 5000);

  return { ok: true };
}

// ── HTTP Server ──
function sendJson(res: http.ServerResponse, data: unknown, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const htmlPath = path.join(__dirname, 'dashboard.html');

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  // GET / → serve HTML
  if (req.method === 'GET' && url.pathname === '/') {
    try {
      const html = fs.readFileSync(htmlPath, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
      });
      res.end(html);
    } catch (err) {
      sendJson(res, { error: 'HTML file not found' }, 500);
    }
    return;
  }

  // GET /status
  if (req.method === 'GET' && url.pathname === '/status') {
    sendJson(res, getStatus());
    return;
  }

  // POST /start
  if (req.method === 'POST' && url.pathname === '/start') {
    sendJson(res, startBot());
    return;
  }

  // POST /stop
  if (req.method === 'POST' && url.pathname === '/stop') {
    sendJson(res, stopBot());
    return;
  }

  // GET /events → SSE
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send current status
    res.write(
      `event: status\ndata: ${JSON.stringify(getStatus())}\n\n`,
    );

    // Replay recent logs
    for (const entry of logBuffer) {
      res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    }

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // 404
  sendJson(res, { error: 'Not found' }, 404);
});

// Cleanup on exit
function cleanup() {
  if (bot && bot.exitCode === null) {
    bot.kill('SIGTERM');
  }
  server.close();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  NanoClaw Dashboard`);
  console.log(`  http://localhost:${PORT}\n`);
});
