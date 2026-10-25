'use strict';

/**
 * Service wrapper — entry point when the gatekeeper runs as a Windows service.
 * Loads environment variables from a .env file (path from GATEKEEPER_ENV_FILE
 * or ./.env next to this file), then starts the gatekeeper.
 */
const fs = require('fs');
const path = require('path');

const envFile = process.env.GATEKEEPER_ENV_FILE || path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
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
}

const { loadConfig, createGatekeeper } = require('./src/server');
const config = loadConfig(process.env);
const gk = createGatekeeper(config);
gk.start();

process.on('SIGINT', () => { gk.stop().then(() => process.exit(0)); });
process.on('SIGTERM', () => { gk.stop().then(() => process.exit(0)); });
