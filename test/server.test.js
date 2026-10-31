'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig, createGatekeeper } = require('../src/server.js');

function makeConfig(overrides) {
  return Object.assign(
    {
      publicPort: 8023,
      targetName: 'test-app',
      composeFile: '/tmp/compose.yml',
      envFile: '/tmp/.env',
      internalPort: 8024,
      healthUrl: 'http://127.0.0.1:8024/api/health',
      idleTimeoutMs: 1000,
      deployTimeoutMs: 100,
      pollIntervalMs: 5,
      estimatedDeploySeconds: 10,
      deployBuild: false,
      adminToken: '',
      autoRedeploy: true,
      rebuildStampFile: '',
      rebuildPollIntervalMs: 30000,
      redeployTimeoutMs: 100,
    },
    overrides || {}
  );
}

test('loadConfig parses env with defaults', () => {
  const c = loadConfig({});
  assert.equal(c.publicPort, 8023);
  assert.equal(c.internalPort, 8024);
  assert.equal(c.idleTimeoutMs, 5 * 60 * 60 * 1000);
  assert.equal(c.deployBuild, false);
  assert.equal(c.healthUrl, 'http://127.0.0.1:8024/api/health');
});

test('loadConfig honours overrides', () => {
  const c = loadConfig({
    PUBLIC_PORT: '9000',
    INTERNAL_PORT: '9001',
    DEPLOY_BUILD: 'true',
    ADMIN_TOKEN: 'secret',
    IDLE_TIMEOUT_MS: '1234',
    TARGET_COMPOSE_OVERRIDE_FILE: '/tmp/override.yml',
  });
  assert.equal(c.publicPort, 9000);
  assert.equal(c.internalPort, 9001);
  assert.equal(c.deployBuild, true);
  assert.equal(c.adminToken, 'secret');
  assert.equal(c.idleTimeoutMs, 1234);
  assert.equal(c.composeOverrideFile, '/tmp/override.yml');
});

test('loadConfig defaults composeOverrideFile to empty', () => {
  const c = loadConfig({});
  assert.equal(c.composeOverrideFile, '');
});

test('deploy transitions idle -> warming -> ready', async () => {
  let nowVal = 1000;
  const runCompose = async () => ({ stdout: '', stderr: '' });
  const checkHealth = async () => true;
  const gk = createGatekeeper(makeConfig(), {
    runCompose,
    checkHealth,
    now: () => nowVal,
    sleep: async () => {},
  });
  assert.equal(gk.getState(), 'idle');
  await gk.deploy();
  assert.equal(gk.getState(), 'ready');
  assert.ok(gk.statusPayload().readyAt !== null);
  assert.ok(gk.statusPayload().lastActivity !== null);
});

test('deploy is idempotent / concurrent', async () => {
  let calls = 0;
  const runCompose = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return { stdout: '', stderr: '' };
  };
  const checkHealth = async () => true;
  const gk = createGatekeeper(makeConfig(), {
    runCompose,
    checkHealth,
    sleep: async () => {},
  });
  const [a, b] = await Promise.all([gk.deploy(), gk.deploy()]);
  assert.equal(calls, 1, 'compose should run once');
});

test('deploy failure returns to idle', async () => {
  const runCompose = async () => {
    throw new Error('boom');
  };
  const checkHealth = async () => true;
  const gk = createGatekeeper(makeConfig(), {
    runCompose,
    checkHealth,
    sleep: async () => {},
  });
  await assert.rejects(gk.deploy(), /boom/);
  assert.equal(gk.getState(), 'idle');
  assert.match(gk.getMessage(), /Deploy failed/);
});

test('deploy health timeout returns to idle', async () => {
  const runCompose = async () => ({ stdout: '', stderr: '' });
  const checkHealth = async () => false;
  let nowVal = 0;
  const gk = createGatekeeper(makeConfig({ deployTimeoutMs: 10, pollIntervalMs: 1 }), {
    runCompose,
    checkHealth,
    now: () => nowVal,
    sleep: async () => {
      nowVal += 5;
    },
  });
  await assert.rejects(gk.deploy(), /health check timed out/);
  assert.equal(gk.getState(), 'idle');
});

test('teardown transitions ready -> idle', async () => {
  const runCompose = async () => ({ stdout: '', stderr: '' });
  const checkHealth = async () => true;
  const gk = createGatekeeper(makeConfig(), {
    runCompose,
    checkHealth,
    sleep: async () => {},
  });
  await gk.deploy();
  assert.equal(gk.getState(), 'ready');
  await gk.teardown();
  assert.equal(gk.getState(), 'idle');
  assert.equal(gk.statusPayload().readyAt, null);
  assert.equal(gk.statusPayload().lastActivity, null);
});

test('teardown failure still returns to idle', async () => {
  let n = 0;
  const runCompose = async (args) => {
    n++;
    if (args.includes('down')) throw new Error('down failed');
    return { stdout: '', stderr: '' };
  };
  const checkHealth = async () => true;
  const gk = createGatekeeper(makeConfig(), {
    runCompose,
    checkHealth,
    sleep: async () => {},
  });
  await gk.deploy();
  await gk.teardown();
  assert.equal(gk.getState(), 'idle');
});

test('tickIdle triggers teardown after timeout', async () => {
  let nowVal = 1000;
  const runCompose = async () => ({ stdout: '', stderr: '' });
  const checkHealth = async () => true;
  const gk = createGatekeeper(makeConfig({ idleTimeoutMs: 500 }), {
    runCompose,
    checkHealth,
    now: () => nowVal,
    sleep: async () => {},
  });
  await gk.deploy();
  // not idle yet
  nowVal = 1200;
  assert.equal(gk.tickIdle(), false);
  assert.equal(gk.getState(), 'ready');
  // now idle
  nowVal = 2000;
  assert.equal(gk.tickIdle(), true);
  // teardown is async; allow microtasks
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(gk.getState(), 'idle');
});

test('tickIdle does nothing while not ready', () => {
  const gk = createGatekeeper(makeConfig(), {
    runCompose: async () => ({ stdout: '', stderr: '' }),
    checkHealth: async () => true,
    sleep: async () => {},
  });
  assert.equal(gk.tickIdle(), false);
  assert.equal(gk.getState(), 'idle');
});

test('status payload shape', async () => {
  const gk = createGatekeeper(makeConfig(), {
    runCompose: async () => ({ stdout: '', stderr: '' }),
    checkHealth: async () => true,
    sleep: async () => {},
  });
  const s = gk.statusPayload();
  assert.equal(s.state, 'idle');
  assert.equal(s.target, 'test-app');
  assert.equal(s.publicPort, 8023);
  assert.equal(s.internalPort, 8024);
  assert.equal(s.estimatedDeploySeconds, 10);
  assert.equal(s.idleTimeoutMs, 1000);
});

test('admin token gating (unit: isAdmin via HTTP)', async () => {
  // Exercise the HTTP layer with a token-gated gatekeeper.
  const http = require('node:http');
  const gk = createGatekeeper(
    makeConfig({ adminToken: 'tok' }),
    {
      runCompose: async () => ({ stdout: '', stderr: '' }),
      checkHealth: async () => true,
      sleep: async () => {},
    }
  );
  const server = gk.server;
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  function post(path, headers) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path, method: 'POST', headers: headers || {} },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  // no token -> 403
  const r1 = await post('/_ondemand/teardown');
  assert.equal(r1.status, 403);
  // wrong token -> 403
  const r2 = await post('/_ondemand/teardown', { 'x-admin-token': 'nope' });
  assert.equal(r2.status, 403);
  // correct token -> 200
  const r3 = await post('/_ondemand/teardown', { 'x-admin-token': 'tok' });
  assert.equal(r3.status, 200);

  await new Promise((resolve) => server.close(resolve));
});

test('ready state proxies requests and updates lastActivity', async () => {
  const http = require('node:http');
  // A tiny upstream target server on internal port.
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('hello from target: ' + req.url);
  });
  await new Promise((resolve) => upstream.listen(8099, '127.0.0.1', resolve));

  const gk = createGatekeeper(
    makeConfig({ internalPort: 8099, healthUrl: 'http://127.0.0.1:8099/health' }),
    {
      runCompose: async () => ({ stdout: '', stderr: '' }),
      checkHealth: async () => true,
      sleep: async () => {},
    }
  );
  // force ready state by deploying (checkHealth mocked true)
  await gk.deploy();
  assert.equal(gk.getState(), 'ready');

  const server = gk.server;
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/foo?bar=1`, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve(b));
    }).on('error', reject);
  });
  assert.match(body, /hello from target: \/foo\?bar=1/);

  server.closeAllConnections();
  upstream.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
});

// ---- loadConfig new env vars ----
test('loadConfig parses new redeploy env vars with defaults', () => {
  const c = loadConfig({});
  assert.equal(c.autoRedeploy, true);
  assert.equal(c.rebuildStampFile, '');
  assert.equal(c.rebuildPollIntervalMs, 30000);
  assert.equal(c.redeployTimeoutMs, 300000);
});

test('loadConfig honours redeploy overrides', () => {
  const c = loadConfig({
    AUTO_REDEPLOY: 'false',
    REBUILD_STAMP_FILE: '/tmp/stamp',
    REBUILD_POLL_INTERVAL_MS: '123',
    REDEPLOY_TIMEOUT_MS: '456',
  });
  assert.equal(c.autoRedeploy, false);
  assert.equal(c.rebuildStampFile, '/tmp/stamp');
  assert.equal(c.rebuildPollIntervalMs, 123);
  assert.equal(c.redeployTimeoutMs, 456);
});

test('loadConfig AUTO_REDEPLOY false only when exactly false', () => {
  const c = loadConfig({ AUTO_REDEPLOY: 'true' });
  assert.equal(c.autoRedeploy, true);
});

test('loadConfig redeployTimeoutMs falls back to DEPLOY_TIMEOUT_MS', () => {
  const c = loadConfig({ DEPLOY_TIMEOUT_MS: '789' });
  assert.equal(c.redeployTimeoutMs, 789);
});

// ---- redeploy success ----
test('redeploy tears down then deploys to ready', async () => {
  let calls = 0;
  const runCompose = async () => {
    calls++;
    return { stdout: '', stderr: '' };
  };
  const checkHealth = async () => true;
  const gk = createGatekeeper(makeConfig(), {
    runCompose,
    checkHealth,
    sleep: async () => {},
  });
  await gk.deploy();
  assert.equal(gk.getState(), 'ready');
  const before = calls;
  await gk.redeploy();
  assert.equal(gk.getState(), 'ready');
  assert.equal(gk.getMessage(), 'Ready (redeployed)');
  assert.ok(calls - before >= 2, 'compose called for down then up');
});

// ---- redeploy admin gating via HTTP ----
test('redeploy admin gating via HTTP', async () => {
  const http = require('node:http');
  const gk = createGatekeeper(
    makeConfig({ adminToken: 'tok' }),
    {
      runCompose: async () => ({ stdout: '', stderr: '' }),
      checkHealth: async () => true,
      sleep: async () => {},
    }
  );
  await gk.deploy();
  const server = gk.server;
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  function post(path, headers) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path, method: 'POST', headers: headers || {} },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  const r1 = await post('/_ondemand/redeploy');
  assert.equal(r1.status, 403);
  const r2 = await post('/_ondemand/redeploy', { 'x-admin-token': 'nope' });
  assert.equal(r2.status, 403);
  const r3 = await post('/_ondemand/redeploy', { 'x-admin-token': 'tok' });
  assert.equal(r3.status, 200);

  await new Promise((resolve) => server.close(resolve));
});

// ---- checkRebuildStamp baseline ----
test('checkRebuildStamp records baseline without redeploy', async () => {
  let calls = 0;
  const runCompose = async () => {
    calls++;
    return { stdout: '', stderr: '' };
  };
  const checkHealth = async () => true;
  const statFn = () => ({ mtimeMs: 1000 });
  const gk = createGatekeeper(makeConfig({ autoRedeploy: true }), {
    runCompose,
    checkHealth,
    sleep: async () => {},
    statFn,
  });
  await gk.deploy();
  const before = calls;
  gk.checkRebuildStamp();
  assert.equal(gk.getState(), 'ready');
  assert.equal(calls, before);
});

// ---- checkRebuildStamp trigger ----
test('checkRebuildStamp triggers redeploy on larger mtime', async () => {
  let mtime = 1000;
  const statFn = () => ({ mtimeMs: mtime });
  let calls = 0;
  const runCompose = async () => {
    calls++;
    return { stdout: '', stderr: '' };
  };
  const checkHealth = async () => true;
  const gk = createGatekeeper(makeConfig({ autoRedeploy: true }), {
    runCompose,
    checkHealth,
    sleep: async () => {},
    statFn,
  });
  await gk.deploy();
  gk.checkRebuildStamp(); // baseline at 1000
  mtime = 2000;
  const before = calls;
  gk.checkRebuildStamp(); // trigger
  // wait for redeploy to finish
  const start = Date.now();
  while (gk.getMessage() !== 'Ready (redeployed)' && Date.now() - start < 2000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(gk.getState(), 'ready');
  assert.equal(gk.getMessage(), 'Ready (redeployed)');
  assert.ok(calls - before >= 2, 'compose called');
});

// ---- checkRebuildStamp skip while warming ----
test('checkRebuildStamp skips while warming', async () => {
  let mtime = 1000;
  const statFn = () => ({ mtimeMs: mtime });
  const runCompose = async () => new Promise(() => {});
  const checkHealth = async () => true;
  const gk = createGatekeeper(makeConfig({ autoRedeploy: true }), {
    runCompose,
    checkHealth,
    sleep: async () => {},
    statFn,
  });
  const p = gk.deploy(); // state becomes warming, hangs
  // avoid unhandled rejection
  p.catch(() => {});
  assert.equal(gk.getState(), 'warming');
  // baseline
  gk.checkRebuildStamp();
  mtime = 2000;
  gk.checkRebuildStamp();
  assert.equal(gk.getState(), 'warming');
});
