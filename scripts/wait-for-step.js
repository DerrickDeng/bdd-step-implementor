#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { isPidAlive } = require('./platform-runner');
const { clampWaitTimeoutMs, remainingRunMs } = require('./timeout-policy');
const { readJsonIfExists, resolveRunContext } = require('./run-manifest');

const ROOT = process.cwd();

function parseArgs(argv) {
  const parsed = {
    stepIndex: null,
    timeoutMs: 120000,
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
    throw new Error('Usage: node wait-for-step.js <step-index> [--timeout-ms 120000] [--run-id <id>]');
  }

  return parsed;
}

function describeExitMessage(testPid, actualTestPid) {
  if (actualTestPid && testPid && actualTestPid !== testPid) {
    return `Actual test process (PID ${actualTestPid}) is no longer running (wrapper PID ${testPid} is the run root)`;
  }
  if (testPid) {
    return `Test process (PID ${testPid}) is no longer running`;
  }
  if (actualTestPid) {
    return `Actual test process (PID ${actualTestPid}) is no longer running`;
  }
  return 'Test process is no longer running';
}

function describeRunProgress(bridgeDir) {
  if (!fs.existsSync(bridgeDir)) {
    return {
      bridgeDir,
      exists: false,
      highestPassedStep: null,
      currentPausedStep: null,
      waitingForImplStep: null,
      errorStep: null,
      observedSteps: [],
    };
  }

  const observed = new Map();
  for (const entry of fs.readdirSync(bridgeDir)) {
    const match = /^step-(\d+)-(.+)$/.exec(entry);
    if (!match) continue;
    const stepIndex = Number(match[1]);
    const suffix = match[2];
    const state = observed.get(stepIndex) || {
      stepIndex,
      hasPause: false,
      hasImpl: false,
      hasPass: false,
      hasError: false,
    };
    if (suffix === 'pause.json') state.hasPause = true;
    if (suffix === 'impl.js') state.hasImpl = true;
    if (suffix === 'pass.signal' || suffix === 'pass.json') state.hasPass = true;
    if (suffix === 'error.txt') state.hasError = true;
    observed.set(stepIndex, state);
  }

  const observedSteps = Array.from(observed.values()).sort((a, b) => a.stepIndex - b.stepIndex);
  const highestPassed = observedSteps
    .filter(step => step.hasPass)
    .reduce((max, step) => Math.max(max, step.stepIndex), 0) || null;
  const currentPaused = observedSteps.find(step => step.hasPause && !step.hasPass) || null;
  const waitingForImpl = observedSteps.find(step => step.hasPause && !step.hasPass && !step.hasImpl) || null;
  const errorStep = observedSteps.find(step => step.hasError && !step.hasPass) || null;

  return {
    bridgeDir,
    exists: true,
    highestPassedStep: highestPassed,
    currentPausedStep: currentPaused ? currentPaused.stepIndex : null,
    waitingForImplStep: waitingForImpl ? waitingForImpl.stepIndex : null,
    errorStep: errorStep ? errorStep.stepIndex : null,
    observedSteps,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bridgeRootAbs = path.resolve(ROOT, options.bridgeRoot);
  const run = resolveRunContext(bridgeRootAbs, options.runId);
  const pauseFile = path.join(run.bridgeDir, `step-${options.stepIndex}-pause.json`);
  const passFile = path.join(run.bridgeDir, `step-${options.stepIndex}-pass.signal`);
  const passMetaFile = path.join(run.bridgeDir, `step-${options.stepIndex}-pass.json`);
  const runDeadlineAt = Number(run.manifest?.runDeadlineAt || 0) || null;
  const effectiveTimeoutMs = clampWaitTimeoutMs(options.timeoutMs, runDeadlineAt);
  const deadline = Date.now() + effectiveTimeoutMs;
  const testPid = run.manifest?.pid || null;
  const actualTestPid = run.manifest?.actualTestPid || null;
  const pidToCheck = testPid || actualTestPid;

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
    // Check if step already passed (e.g. from a restored impl that ran successfully)
    if (fs.existsSync(passFile)) {
      const passMeta = readJsonIfExists(passMetaFile);
      process.stdout.write(JSON.stringify({
        alreadyPassed: true,
        stepIndex: options.stepIndex,
        runId: run.runId,
        passMeta,
      }, null, 2) + '\n');
      return;
    }

    if (fs.existsSync(pauseFile)) {
      process.stdout.write(`${fs.readFileSync(pauseFile, 'utf8')}\n`);
      return;
    }

    // Check test process liveness on every poll (not just every 10th)
    if (pidToCheck && !isPidAlive(pidToCheck, ROOT)) {
      const progress = describeRunProgress(run.bridgeDir);
      const message = describeExitMessage(testPid, actualTestPid);
      console.error(JSON.stringify({
        error: 'test_process_exited',
        message,
        requestedStepIndex: options.stepIndex,
        runId: run.runId,
        bridgeDir: run.bridgeDir,
        logPath: run.manifest?.logPath || null,
        testPid,
        actualTestPid,
        progress,
      }, null, 2));
      process.exit(3);
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

  const progress = describeRunProgress(run.bridgeDir);
  console.error(JSON.stringify({
    error: 'wait_for_step_timeout',
    requestedStepIndex: options.stepIndex,
    runId: run.runId,
    bridgeDir: run.bridgeDir,
    logPath: run.manifest?.logPath || null,
    resumedFromRunId: run.manifest?.resumedFromRunId || null,
    restoredSteps: run.manifest?.restoredSteps || [],
    progress,
  }, null, 2));
  process.exit(2);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
