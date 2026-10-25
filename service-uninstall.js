'use strict';

/**
 * Uninstall the gatekeeper Windows service.
 *
 * Usage:
 *   set SERVICE_NAME=OnDemandGatekeeper-gazi-portfolio
 *   node service-uninstall.js
 *
 * Run as Administrator.
 */
const Service = require('node-windows').Service;
const path = require('path');

const serviceName = process.env.SERVICE_NAME || 'OnDemandGatekeeper';

const svc = new Service({
  name: serviceName,
  script: path.join(__dirname, 'service-wrapper.js'),
});

svc.on('uninstall', () => {
  console.log(`Service "${serviceName}" uninstalled.`);
});

svc.on('error', (err) => {
  console.error('Service error:', err);
});

svc.uninstall();
console.log(`Uninstalling service "${serviceName}"...`);
