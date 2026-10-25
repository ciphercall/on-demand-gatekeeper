'use strict';
// start-instance.js — starts a gatekeeper instance using a .env file
// Usage: node start-instance.js <path-to-.env>
const fs = require('fs');
const path = require('path');

const envFile = process.argv[2];
if (!envFile || !fs.existsSync(envFile)) {
  console.error('Usage: node start-instance.js <path-to-.env>');
  process.exit(1);
}

const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
for (const line of lines) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) {
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const { loadConfig, createGatekeeper } = require(path.join(__dirname, 'src', 'server'));
const config = loadConfig(process.env);
const gk = createGatekeeper(config);
gk.start();

process.on('SIGINT', () => { gk.stop().then(() => process.exit(0)); });
process.on('SIGTERM', () => { gk.stop().then(() => process.exit(0)); });
