#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { clampWaitTimeoutMs, remainingRunMs } = require('./timeout-policy');
const { resolveRunContext } = require('./run-manifest');

const ROOT = process.cwd();

function parseArgs(argv) {
  const parsed = {
    stepIndex: null,
    timeoutMs: 60000,
    bridgeRoot: 'mcp-bridge',
    runId: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--bridge-root') {
      parsed.bridgeRoot = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--run-id') {
      parsed.runId = argv[i + 1];
      i += 1;
      continue;
    }
    if (parsed.stepIndex === null) {
      parsed.stepIndex = Number(arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(parsed.stepIndex) || parsed.stepIndex <= 0) {
    throw new Error('Usage: node wait-for-result.js <step-index> [--timeout-ms 60000] [--run-id <id>]');
  }

  return parsed;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bridgeRootAbs = path.resolve(ROOT, options.bridgeRoot);
  const run = resolveRunContext(bridgeRootAbs, options.runId);
  const passFile = path.join(run.bridgeDir, `step-${options.stepIndex}-pass.signal`);
  const errorFile = path.join(run.bridgeDir, `step-${options.stepIndex}-error.txt`);
  const runDeadlineAt = Number(run.manifest?.runDeadlineAt || 0) || null;
  const effectiveTimeoutMs = clampWaitTimeoutMs(options.timeoutMs, runDeadlineAt);
  const deadline = Date.now() + effectiveTimeoutMs;

  if (runDeadlineAt !== null && remainingRunMs(runDeadlineAt) === 0) {
    console.error(JSON.stringify({
      error: 'run_timeout',
      requestedStepIndex: options.stepIndex,
      runId: run.runId,
      bridgeDir: run.bridgeDir,
      logPath: run.manifest?.logPath || null,
      runDeadlineAt,
    }, null, 2));
    process.exit(4);
  }

  while (Date.now() <= deadline) {
    if (fs.existsSync(passFile)) {
      process.stdout.write('PASS\n');
      return;
    }
    if (fs.existsSync(errorFile)) {
      process.stdout.write(`${fs.readFileSync(errorFile, 'utf8')}\n`);
      process.exit(2);
    }
    await sleep(500);
  }

  if (runDeadlineAt !== null && remainingRunMs(runDeadlineAt) === 0) {
    console.error(JSON.stringify({
      error: 'run_timeout',
      requestedStepIndex: options.stepIndex,
      runId: run.runId,
      bridgeDir: run.bridgeDir,
      logPath: run.manifest?.logPath || null,
      runDeadlineAt,
    }, null, 2));
    process.exit(4);
  }

  console.error(`Timed out waiting for result of step ${options.stepIndex}`);
  process.exit(3);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
