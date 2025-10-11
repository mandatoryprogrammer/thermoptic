// Simple script to wait until Chrome DevTools Protocol (CDP) is ready.
// Reads host/port from CHROME_DEBUGGING_HOST and CHROME_DEBUGGING_PORT.
// Optionally configure poll interval and timeout via CDP_POLL_INTERVAL_MS and CDP_STARTUP_TIMEOUT_MS.

import http from 'http';
import * as logger from './logger.js';

const host = process.env.CHROME_DEBUGGING_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.CHROME_DEBUGGING_PORT || '9222', 10);

const pollIntervalMs = Number.parseInt(process.env.CDP_POLL_INTERVAL_MS || '1000', 10);
const startupTimeoutMs = process.env.CDP_STARTUP_TIMEOUT_MS
  ? Number.parseInt(process.env.CDP_STARTUP_TIMEOUT_MS, 10)
  : null;
const deadline = startupTimeoutMs ? Date.now() + startupTimeoutMs : null;
const wait_logger = logger.get_logger();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkCdp() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host,
        port,
        path: '/json/version',
        timeout: 1500,
        // Some Chrome setups reject non-local Host headers even via a TCP proxy.
        // Force a localhost-style Host header while connecting to the service name.
        headers: { host: '127.0.0.1' },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk || ''));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return resolve(false);
          }
          try {
            const json = JSON.parse(data || '{}');
            // Treat presence of common fields as readiness.
            const ready =
              !!json?.Browser ||
              !!json?.['Protocol-Version'] ||
              !!json?.webSocketDebuggerUrl;
            resolve(Boolean(ready));
          } catch (_) {
            resolve(false);
          }
        });
      }
    );

    req.on('timeout', () => {
      // abort slow connection attempt
      req.destroy(new Error('timeout'));
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function main() {
  // Quick banner
  wait_logger.info('Waiting for CDP availability.', {
    host,
    port,
    poll_interval_ms: pollIntervalMs,
    startup_timeout_ms: startupTimeoutMs
  });

  // Loop until available or timeout (if set)
  while (true) {
    const ok = await checkCdp();
    if (ok) {
      wait_logger.info('CDP is available.', {
        host,
        port
      });
      process.exit(0);
    }

    if (deadline && Date.now() > deadline) {
      wait_logger.error('Timed out waiting for CDP.', {
        host,
        port,
        startup_timeout_ms: startupTimeoutMs
      });
      process.exit(1);
    }

    await sleep(pollIntervalMs);
  }
}

main().catch((err) => {
  wait_logger.error('Unexpected failure while waiting for CDP.', {
    message: err.message,
    stack: err.stack
  });
  process.exit(1);
});
