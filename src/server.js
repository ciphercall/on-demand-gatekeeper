'use strict';

/**
 * On-Demand Gatekeeper
 *
 * The only always-on component for an on-demand webapp. It listens on
 * PUBLIC_PORT and, on the first visitor request, boots the target webapp's
 * existing Docker stack in the background, shows a countdown/progress page,
 * reverse-proxies once the stack is healthy, and tears the stack down again
 * after IDLE_TIMEOUT_MS of inactivity.
 *
 * It NEVER modifies the target project: it only reads the target's compose
 * file + .env and drives `docker compose` against the host daemon.
 *
 * Config is entirely env-driven (see .env.example), so one binary serves any
 * webapp. Testable: the factory accepts injectable deps (runCompose,
 * checkHealth, now, sleep) and the module only starts listening when run as
 * the main module.
 */

const http = require('http');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadConfig(env) {
  const e = env || process.env;
  const publicPort = parseInt(e.PUBLIC_PORT || '8023', 10);
  const internalPort = parseInt(e.INTERNAL_PORT || '8024', 10);
  const idleTimeoutMs = parseInt(e.IDLE_TIMEOUT_MS || String(5 * 60 * 60 * 1000), 10);
  const healthUrl =
    e.TARGET_HEALTH_URL || `http://127.0.0.1:${internalPort}/api/health`;
  return {
    publicPort,
    targetName: e.TARGET_NAME || 'target-app',
    composeFile: e.TARGET_COMPOSE_FILE || '/target/docker-compose.yml',
    envFile: e.TARGET_ENV_FILE || '/target/.env',
    composeOverrideFile: e.TARGET_COMPOSE_OVERRIDE_FILE || '',
    internalPort,
    healthUrl,
    idleTimeoutMs,
    deployTimeoutMs: parseInt(e.DEPLOY_TIMEOUT_MS || '300000', 10),
    pollIntervalMs: parseInt(e.READY_POLL_INTERVAL_MS || '2000', 10),
    estimatedDeploySeconds: parseInt(e.ESTIMATED_DEPLOY_SECONDS || '90', 10),
    deployBuild: e.DEPLOY_BUILD === 'true',
    adminToken: e.ADMIN_TOKEN || '',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultRunCompose(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `docker ${args.join(' ')} exited ${code}: ${(stderr || stdout).trim()}`
          )
        );
    });
  });
}

function defaultCheckHealth(url) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      resolve(false);
      return;
    }
    const req = http.get(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        timeout: 5000,
      },
      (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Gatekeeper factory (injectable deps for testing)
// ---------------------------------------------------------------------------
function createGatekeeper(config, deps) {
  const d = deps || {};
  const runCompose = d.runCompose || defaultRunCompose;
  const checkHealth = d.checkHealth || ((url) => defaultCheckHealth(url));
  const now = d.now || (() => Date.now());
  const sleepFn = d.sleep || sleep;

  // State
  let state = 'idle'; // idle | warming | ready | stopping | error
  let message = 'Waiting for first request.';
  let deployStartedAt = null;
  let readyAt = null;
  let lastActivity = null;
  let deployPromise = null;
  let teardownPromise = null;
  const sseClients = new Set();

  function setState(next, msg) {
    state = next;
    if (msg) message = msg;
    broadcast('state', statusPayload());
  }

  function statusPayload() {
    return {
      state,
      message,
      target: config.targetName,
      deployStartedAt,
      readyAt,
      lastActivity,
      estimatedDeploySeconds: config.estimatedDeploySeconds,
      idleTimeoutMs: config.idleTimeoutMs,
      internalPort: config.internalPort,
      publicPort: config.publicPort,
    };
  }

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch (err) {
        sseClients.delete(res);
      }
    }
  }

  function composeEnv() {
    return Object.assign({}, process.env, {
      WEB_PORT: String(config.internalPort),
      FRONTEND_PORT: String(config.internalPort),
    });
  }

  // Build the base compose args, including an optional override file.
  function composeArgs(subcommand) {
    const args = ['compose', '-f', config.composeFile];
    if (config.composeOverrideFile) {
      args.push('-f', config.composeOverrideFile);
    }
    args.push('--env-file', config.envFile);
    if (subcommand === 'up') {
      args.push('up', '-d');
      if (config.deployBuild) args.push('--build');
    } else if (subcommand === 'down') {
      args.push('down');
    }
    return args;
  }

  async function deploy() {
    if (deployPromise) return deployPromise;
    if (state === 'ready') return Promise.resolve();
    deployPromise = (async () => {
      setState('warming', 'Starting containers...');
      deployStartedAt = now();
      readyAt = null;
      try {
        const args = composeArgs('up');
        await runCompose(args, composeEnv());
        setState('warming', 'Waiting for health check...');
        const deadline = now() + config.deployTimeoutMs;
        while (now() < deadline) {
          if (await checkHealth(config.healthUrl)) break;
          await sleepFn(config.pollIntervalMs);
        }
        if (!(await checkHealth(config.healthUrl))) {
          throw new Error('health check timed out');
        }
        readyAt = now();
        lastActivity = now();
        setState('ready', 'Ready');
      } catch (err) {
        setState('idle', `Deploy failed: ${err.message}`);
        deployStartedAt = null;
        throw err;
      } finally {
        deployPromise = null;
      }
    })();
    return deployPromise;
  }

  async function teardown() {
    if (teardownPromise) return teardownPromise;
    teardownPromise = (async () => {
      setState('stopping', 'Stopping containers...');
      try {
        await runCompose(composeArgs('down'), composeEnv());
      } catch (err) {
        // best-effort; still return to idle
        setState('error', `Teardown failed: ${err.message}`);
      }
      deployStartedAt = null;
      readyAt = null;
      lastActivity = null;
      setState('idle', 'Waiting for first request.');
      teardownPromise = null;
    })();
    return teardownPromise;
  }

  // Idle watcher tick (exposed for tests). Returns true if it triggered teardown.
  function tickIdle() {
    if (
      state === 'ready' &&
      lastActivity !== null &&
      now() - lastActivity >= config.idleTimeoutMs
    ) {
      teardown().catch(() => {});
      return true;
    }
    return false;
  }

  let idleTimer = null;
  function startIdleWatcher(intervalMs) {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      tickIdle();
    }, intervalMs || 30000);
    if (idleTimer.unref) idleTimer.unref();
  }
  function stopIdleWatcher() {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }

  // ---- HTTP helpers ----
  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function isAdmin(req, url) {
    if (!config.adminToken) return true;
    const t = req.headers['x-admin-token'] || url.searchParams.get('token');
    return t === config.adminToken;
  }

  function serveWarmingPage(res) {
    const html = WARMING_PAGE_HTML.split('__ESTIMATE__').join(
      String(config.estimatedDeploySeconds)
    );
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  }

  function handleSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: state\ndata: ${JSON.stringify(statusPayload())}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (err) {
        // ignore
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  }

  function proxyRequest(req, res) {
    lastActivity = now();
    const options = {
      hostname: '127.0.0.1',
      port: config.internalPort,
      path: req.url,
      method: req.method,
      headers: Object.assign({}, req.headers, {
        host: `127.0.0.1:${config.internalPort}`,
      }),
    };
    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end(`Bad gateway: ${err.message}`);
    });
    const destroyProxy = () => {
      try {
        proxyReq.destroy();
      } catch (err) {
        // ignore
      }
    };
    res.on('close', destroyProxy);
    req.on('aborted', destroyProxy);
    req.pipe(proxyReq);
  }

  function handler(req, res) {
    // Track activity whenever the stack is ready, for any request.
    if (state === 'ready') lastActivity = now();

    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad request');
      return;
    }
    const path = url.pathname;

    if (path === '/_ondemand/events') {
      handleSSE(req, res);
      return;
    }
    if (path === '/_ondemand/status') {
      sendJson(res, 200, statusPayload());
      return;
    }
    if (path === '/_ondemand/deploy' && req.method === 'POST') {
      if (!isAdmin(req, url)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      deploy()
        .then(() => sendJson(res, 200, statusPayload()))
        .catch((err) => sendJson(res, 500, { error: err.message }));
      return;
    }
    if (path === '/_ondemand/teardown' && req.method === 'POST') {
      if (!isAdmin(req, url)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      teardown()
        .then(() => sendJson(res, 200, statusPayload()))
        .catch((err) => sendJson(res, 500, { error: err.message }));
      return;
    }

    if (state === 'ready') {
      proxyRequest(req, res);
      return;
    }

    // idle / warming / stopping / error: trigger deploy if idle, serve warming page
    if (state === 'idle') {
      deploy().catch(() => {
        /* state already updated inside deploy() */
      });
    }
    serveWarmingPage(res);
  }

  const server = http.createServer(handler);

  function start(port) {
    const p = port || config.publicPort;
    startIdleWatcher();
    server.listen(p, () => {
      // eslint-disable-next-line no-console
      console.log(
        `[gatekeeper] ${config.targetName} listening on :${p} (idle timeout ${Math.round(
          config.idleTimeoutMs / 1000 / 60
        )} min)`
      );
    });
    return server;
  }

  function stop() {
    stopIdleWatcher();
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  return {
    config,
    server,
    start,
    stop,
    deploy,
    teardown,
    tickIdle,
    getState: () => state,
    getMessage: () => message,
    statusPayload,
  };
}

// ---------------------------------------------------------------------------
// Warming page (self-contained, no external assets)
// ---------------------------------------------------------------------------
const WARMING_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Preparing your project…</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(1200px 600px at 50% -10%, #1e293b, #020617);
    color: #e2e8f0;
  }
  .card {
    width: min(460px, 92vw); padding: 32px 28px; border-radius: 16px;
    background: rgba(15, 23, 42, 0.72); border: 1px solid rgba(148,163,184,0.18);
    backdrop-filter: blur(8px); box-shadow: 0 20px 60px rgba(0,0,0,0.45);
    text-align: center;
  }
  h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; }
  .sub { color: #94a3b8; font-size: 14px; margin: 0 0 24px; }
  .bar { height: 8px; border-radius: 999px; background: rgba(148,163,184,0.15);
         overflow: hidden; margin: 18px 0 10px; }
  .fill { height: 100%; width: 0%; border-radius: 999px;
          background: linear-gradient(90deg, #38bdf8, #818cf8);
          transition: width 0.4s ease; }
  .row { display: flex; justify-content: space-between; font-size: 13px; color: #94a3b8; }
  .status { margin-top: 16px; font-size: 13px; color: #cbd5e1; min-height: 18px; }
  .spinner { width: 34px; height: 34px; margin: 0 auto 16px; border: 3px solid rgba(148,163,184,0.2);
             border-top-color: #38bdf8; border-radius: 50%; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .err { color: #fca5a5; }
  button { margin-top: 14px; padding: 8px 14px; border-radius: 8px; border: 1px solid rgba(148,163,184,0.3);
           background: rgba(30,41,59,0.8); color: #e2e8f0; cursor: pointer; font-size: 13px; }
  button:hover { background: rgba(51,65,85,0.9); }
</style>
</head>
<body>
  <div class="card">
    <div class="spinner" id="spinner"></div>
    <h1>Preparing your project</h1>
    <p class="sub">The real app is starting up. This usually takes under two minutes.</p>
    <div class="bar"><div class="fill" id="fill"></div></div>
    <div class="row"><span id="elapsed">0s elapsed</span><span id="remaining">~__ESTIMATE__s remaining</span></div>
    <div class="status" id="status">Starting containers…</div>
    <button id="retry" style="display:none" onclick="location.reload()">Retry</button>
  </div>
<script>
  const estimate = __ESTIMATE__;
  const start = Date.now();
  const fill = document.getElementById('fill');
  const elapsedEl = document.getElementById('elapsed');
  const remainingEl = document.getElementById('remaining');
  const statusEl = document.getElementById('status');
  const retryBtn = document.getElementById('retry');
  const spinner = document.getElementById('spinner');

  function tick() {
    const sec = Math.floor((Date.now() - start) / 1000);
    elapsedEl.textContent = sec + 's elapsed';
    const rem = Math.max(0, estimate - sec);
    remainingEl.textContent = '~' + rem + 's remaining';
    const pct = Math.min(95, (sec / estimate) * 100);
    fill.style.width = pct + '%';
  }
  setInterval(tick, 500);
  tick();

  try {
    const es = new EventSource('/_ondemand/events');
    es.addEventListener('state', (e) => {
      const d = JSON.parse(e.data);
      statusEl.textContent = d.message || d.state;
      if (d.state === 'ready') {
        fill.style.width = '100%';
        statusEl.textContent = 'Ready — redirecting…';
        setTimeout(() => { location.href = location.pathname === '/' ? '/' : location.pathname; }, 400);
        es.close();
      } else if (d.state === 'error' || d.message && d.message.indexOf('failed') >= 0) {
        statusEl.classList.add('err');
        spinner.style.display = 'none';
        retryBtn.style.display = 'inline-block';
      }
    });
    es.onerror = () => { /* keep retrying automatically */ };
  } catch (err) {
    statusEl.textContent = 'Unable to stream progress. Refresh to check.';
  }
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  const config = loadConfig(process.env);
  const gk = createGatekeeper(config);
  gk.start();
  process.on('SIGINT', () => {
    gk.stop().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    gk.stop().then(() => process.exit(0));
  });
}

module.exports = { loadConfig, createGatekeeper, WARMING_PAGE_HTML };
