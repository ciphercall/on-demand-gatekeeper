'use strict';

/**
 * Install the gatekeeper as a Windows service.
 *
 * Usage:
 *   set SERVICE_NAME=OnDemandGatekeeper-gazi-portfolio
 *   set GATEKEEPER_ENV_FILE=C:\path\to\.env
 *   node service-install.js
 *
 * Run as Administrator.
 */
const Service = require('node-windows').Service;
const path = require('path');

const serviceName = process.env.SERVICE_NAME || 'OnDemandGatekeeper';
const envFile = process.env.GATEKEEPER_ENV_FILE || path.join(__dirname, '.env');

const svc = new Service({
  name: serviceName,
  description: 'On-Demand Gatekeeper - ' + (process.env.TARGET_NAME || 'target-app'),
  script: path.join(__dirname, 'service-wrapper.js'),
  nodeOptions: [],
  env: [
    { name: 'GATEKEEPER_ENV_FILE', value: envFile },
  ],
});

svc.on('install', () => {
  console.log(`Service "${serviceName}" installed. Starting...`);
  svc.start();
});

svc.on('start', () => {
  console.log(`Service "${serviceName}" started.`);
});

svc.on('error', (err) => {
  console.error('Service error:', err);
});

svc.install();
console.log(`Installing service "${serviceName}"...`);
