#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { isPidAlive, sleep, terminatePidTree } = require('./platform-runner');
const { computeRunDeadlineAt, DEFAULT_SHUTDOWN_GRACE_MS } = require('./timeout-policy');
const { atomicWriteJsonSync } = require('./fs-utils');

const ROOT = process.cwd();

function parseArgs(argv) {
  const parsed = {
    bridgeRoot: 'mcp-bridge',
    graceMs: DEFAULT_SHUTDOWN_GRACE_MS,
    pid: null,
    runId: null,
    startedAtMs: null,
    timeoutMs: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--bridge-root') {
      parsed.bridgeRoot = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--grace-ms') {
      parsed.graceMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--pid') {
      parsed.pid = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--run-id') {
      parsed.runId = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--started-at-ms') {
      parsed.startedAtMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!parsed.runId || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    throw new Error('Usage: node run-watchdog.js --run-id <id> --pid <pid> --started-at-ms <ms> --timeout-ms <ms> [--bridge-root mcp-bridge] [--grace-ms 10000]');
  }

  if (!Number.isFinite(parsed.startedAtMs) || parsed.startedAtMs <= 0) {
    throw new Error('started-at-ms must be a positive number');
  }

  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error('timeout-ms must be a positive number');
  }

  return parsed;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return null;
  }
}

// Use atomicWriteJsonSync from fs-utils for all manifest writes.
// It handles mkdirSync internally.

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bridgeRootAbs = path.resolve(ROOT, options.bridgeRoot);
  const launchPath = path.join(bridgeRootAbs, options.runId, 'launch.json');
  const latestPath = path.join(bridgeRootAbs, 'latest-run.json');
  const runDeadlineAt = computeRunDeadlineAt(options.startedAtMs, options.timeoutMs);
  const sleepMs = Math.max(0, runDeadlineAt - Date.now());

  if (sleepMs > 0) {
    await sleep(sleepMs);
  }

  if (!isPidAlive(options.pid, ROOT)) {
    return;
  }

  const termination = await terminatePidTree(options.pid, ROOT);
  if (options.graceMs > 0) {
    await sleep(options.graceMs);
  }

  const timedOutAt = new Date().toISOString();
  const launchManifest = readJsonIfExists(launchPath);
  if (launchManifest) {
    atomicWriteJsonSync(launchPath, {
      ...launchManifest,
      runDeadlineAt,
      timedOutAt,
      timeoutScope: 'run',
      timeoutSource: 'run-watchdog',
      timeoutTermination: termination,
    });
  }

  const latestManifest = readJsonIfExists(latestPath);
  if (latestManifest && latestManifest.runId === options.runId) {
    atomicWriteJsonSync(latestPath, {
      ...latestManifest,
      runDeadlineAt,
      timedOutAt,
      timeoutScope: 'run',
      timeoutSource: 'run-watchdog',
      timeoutTermination: termination,
    });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
