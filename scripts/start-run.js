#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { getPortOwners, getProcessDetail, isPidAlive, terminatePidTree, findActualTestProcess } = require('./platform-runner');
const { buildWindowsSpawnSpec } = require('./windows-launch');
const {
  computeRunDeadlineAt,
  computeRunTimeoutMs,
  DEFAULT_IMPL_ATTEMPT_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_GRACE_MS,
} = require('./timeout-policy');
const { atomicWriteJsonSync } = require('./fs-utils');

const ROOT = process.cwd();
const RUN_WATCHDOG = path.join(__dirname, 'run-watchdog.js');

function parseArgs(argv) {
  const parsed = {
    port: 9222,
    log: 'test-results/mcp-step.log',
    bridgeRoot: 'mcp-bridge',
    implTimeoutMs: DEFAULT_IMPL_ATTEMPT_TIMEOUT_MS,
    shutdownGraceMs: DEFAULT_SHUTDOWN_GRACE_MS,
    timeoutMs: null,
    timeoutExplicit: false,
    stepCount: null,
    cleanPort: false,
    command: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      parsed.command = argv.slice(i + 1);
      break;
    }
    if (arg === '--port') {
      parsed.port = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--log') {
      parsed.log = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--bridge-root') {
      parsed.bridgeRoot = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(argv[i + 1]);
      parsed.timeoutExplicit = true;
      i += 1;
      continue;
    }
    if (arg === '--step-count') {
      parsed.stepCount = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--impl-timeout-ms') {
      parsed.implTimeoutMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--shutdown-grace-ms') {
      parsed.shutdownGraceMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--clean-port') {
      parsed.cleanPort = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (parsed.command.length === 0) {
    throw new Error('Usage: node start-run.js [options] -- <command...>');
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

function commandsMatch(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function restoreValidatedImpls(previousBridgeDir, nextBridgeDir) {
  if (!previousBridgeDir || !fs.existsSync(previousBridgeDir)) {
    console.error(`[restore] No previous bridge dir: ${previousBridgeDir}`);
    return [];
  }

  const restored = [];
  const failed = [];
  const entries = fs.readdirSync(previousBridgeDir);
  const passSignals = new Set(
    entries
      .map(name => /^step-(\d+)-pass\.signal$/.exec(name))
      .filter(Boolean)
      .map(match => Number(match[1]))
  );

  console.error(`[restore] Previous dir: ${previousBridgeDir}`);
  console.error(`[restore] Target dir: ${nextBridgeDir}`);
  console.error(`[restore] Steps with pass signals: [${[...passSignals].sort((a, b) => a - b).join(', ')}]`);

  for (const stepIndex of passSignals) {
    const implName = `step-${stepIndex}-impl.js`;
    const sourceImpl = path.join(previousBridgeDir, implName);
    const targetImpl = path.join(nextBridgeDir, implName);
    if (!fs.existsSync(sourceImpl)) {
      console.error(`[restore] SKIP step ${stepIndex}: source impl missing (${sourceImpl})`);
      continue;
    }
    const sourceSize = fs.statSync(sourceImpl).size;
    fs.copyFileSync(sourceImpl, targetImpl);
    // Post-copy verification
    if (fs.existsSync(targetImpl)) {
      const targetSize = fs.statSync(targetImpl).size;
      if (targetSize === sourceSize && targetSize > 0) {
        restored.push(stepIndex);
        console.error(`[restore] OK step ${stepIndex}: ${sourceSize} bytes`);
      } else {
        failed.push(stepIndex);
        console.error(`[restore] FAIL step ${stepIndex}: size mismatch (source=${sourceSize}, target=${targetSize})`);
      }
    } else {
      failed.push(stepIndex);
      console.error(`[restore] FAIL step ${stepIndex}: target file not created`);
    }
  }

  if (failed.length > 0) {
    console.error(`[restore] WARNING: ${failed.length} step(s) failed to restore: [${failed.join(', ')}]`);
  }

  return restored.sort((a, b) => a - b);
}

function shellEscape(arg) {
  // If arg contains only safe characters, no escaping needed
  if (/^[a-zA-Z0-9_./:@=,+%-]+$/.test(arg)) return arg;
  // Wrap in single quotes, escaping any embedded single quotes
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function isWrappedInLiteralQuotes(value) {
  return (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  );
}

function validateCommandArgs(command) {
  for (let i = 0; i < command.length; i += 1) {
    const arg = command[i];
    let tagValue = null;

    if (arg === '--tags') {
      tagValue = command[i + 1] || '';
    } else if (arg.startsWith('--tags=')) {
      tagValue = arg.slice('--tags='.length);
    }

    if (tagValue && isWrappedInLiteralQuotes(tagValue)) {
      throw new Error(
        `Invalid --tags value contains literal quote characters: ${tagValue}\n` +
        'Use shell quotes only, for example: --tags "@verify_x and @bdd". ' +
        'Do not pass nested literal quotes like: --tags \'"@verify_x and @bdd"\'.'
      );
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function writeLaunchFailureDiagnostic(targetPath, value) {
  atomicWriteJsonSync(targetPath, {
    ...value,
    recordedAt: new Date().toISOString(),
  });
}

async function resolveWsUrl(httpBase, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const pollIntervalMs = opts.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  const url = `${httpBase.replace(/\/+$/, '')}/json/version`;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = await res.json();
        if (typeof body.webSocketDebuggerUrl === 'string') {
          return body.webSocketDebuggerUrl;
        }
        throw new Error('webSocketDebuggerUrl missing in /json/version response');
      }
      lastErr = new Error(`/json/version returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Timed out resolving ws URL from ${url}: ${lastErr?.message || 'unknown error'}`);
}

async function terminatePids(pids) {
  for (const pid of pids) {
    await terminatePidTree(pid, ROOT);
  }

  await sleep(200);
  return {
    requested: pids,
    remaining: pids.filter(pid => isPidAlive(pid, ROOT)),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  validateCommandArgs(options.command);
  if (!options.timeoutExplicit) {
    options.timeoutMs = computeRunTimeoutMs(options.stepCount);
  }
  const bridgeRootAbs = path.resolve(ROOT, options.bridgeRoot);
  const logAbs = path.resolve(ROOT, options.log);
  const previousLatestRun = readJsonIfExists(path.join(bridgeRootAbs, 'latest-run.json'));
  const runId = `mcp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const bridgeDir = path.join(bridgeRootAbs, runId);
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const runDeadlineAt = computeRunDeadlineAt(startedAtMs, options.timeoutMs);
  const owners = getPortOwners(options.port, ROOT);

  let termination = null;
  if (owners.length > 0) {
    if (!options.cleanPort) {
      const lines = owners.map(owner => `PID ${owner.pid}: ${owner.detail}`).join('\n');
      throw new Error(
        `Port ${options.port} is already in use.\n${lines}\n` +
        'Re-run with --clean-port or stop the stale run first.'
      );
    }
    termination = await terminatePids(owners.map(owner => owner.pid));
    const afterCleanup = getPortOwners(options.port, ROOT);
    if (afterCleanup.length > 0) {
      const lines = afterCleanup.map(owner => `PID ${owner.pid}: ${owner.detail}`).join('\n');
      throw new Error(`Port ${options.port} is still busy after cleanup.\n${lines}`);
    }
  }

  fs.mkdirSync(bridgeRootAbs, { recursive: true });
  fs.rmSync(bridgeDir, { recursive: true, force: true });
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.mkdirSync(path.dirname(logAbs), { recursive: true });
  fs.writeFileSync(logAbs, '', 'utf8');

  const resumedFromRunId = previousLatestRun && commandsMatch(previousLatestRun.command, options.command)
    ? previousLatestRun.runId
    : null;
  const restoredSteps = resumedFromRunId
    ? restoreValidatedImpls(previousLatestRun.bridgeDir, bridgeDir)
    : [];

  const isWindows = process.platform === 'win32';
  const logFd = fs.openSync(logAbs, 'w');

  // Cross-platform spawn strategy:
  // Windows: use cmd /c without detached — detached breaks fd inheritance on Windows, unref() is sufficient
  // macOS/Linux: use shell: true + detached for proper process group signal handling
  const spawnEnv = {
    ...process.env,
    PW_MCP_CDP_PORT: String(options.port),
    MCP_STEP_RUN_ID: runId,
    MCP_STEP_BRIDGE_ROOT: path.relative(ROOT, bridgeRootAbs) || options.bridgeRoot,
    MCP_STEP_RUN_TIMEOUT_MS: String(options.timeoutMs),
    MCP_STEP_TIMEOUT_MS: String(options.timeoutMs),
    MCP_STEP_IMPL_TIMEOUT_MS: String(options.implTimeoutMs),
  };

  let child;
  if (isWindows) {
    const spec = buildWindowsSpawnSpec({
      root: ROOT,
      logFd,
      spawnEnv,
      command: options.command,
    });
    child = childProcess.spawn(spec.command, spec.args, spec.options);
  } else {
    // macOS/Linux: use shell: true for proper process group handling
    // Shell-escape each arg so spaces inside arguments (e.g. --tags "@a and @b") survive
    const escaped = options.command.map(shellEscape);
    child = childProcess.spawn(escaped[0], escaped.slice(1), {
      cwd: ROOT,
      detached: true,
      shell: true,
      stdio: ['ignore', logFd, logFd],
      env: spawnEnv,
    });
  }

  child.unref();
  fs.closeSync(logFd);

  const watchdog = childProcess.spawn(process.execPath, [
    RUN_WATCHDOG,
    '--bridge-root',
    options.bridgeRoot,
    '--grace-ms',
    String(options.shutdownGraceMs),
    '--pid',
    String(child.pid),
    '--run-id',
    runId,
    '--started-at-ms',
    String(startedAtMs),
    '--timeout-ms',
    String(options.timeoutMs),
  ], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
  });
  watchdog.unref();

  // Clean up the child process if this launcher receives a termination signal.
  // Without this, a killed launcher leaves the detached child holding the CDP port.
  function cleanupChild() {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {
      try { process.kill(child.pid, 'SIGTERM'); } catch (__) { /* already gone */ }
    }
  }
  process.on('SIGINT', () => { cleanupChild(); process.exit(130); });
  process.on('SIGTERM', () => { cleanupChild(); process.exit(143); });

  // Brief post-spawn health check: catch immediate failures (bad command, missing deps, config errors)
  await sleep(2000);
  if (!isPidAlive(child.pid, ROOT)) {
    const logContent = fs.existsSync(logAbs)
      ? fs.readFileSync(logAbs, 'utf8').trim()
      : '(empty)';
    const tail = logContent.length > 2000 ? logContent.slice(-2000) : logContent;
    const launchFailurePath = path.join(bridgeDir, 'launch-failure.json');
    writeLaunchFailureDiagnostic(launchFailurePath, {
      runId,
      bridgeDir,
      logPath: logAbs,
      command: options.command,
      pid: child.pid,
      processGroupId: child.pid,
      startedAt: startedAtIso,
      runDeadlineAt,
      runTimeoutMs: options.timeoutMs,
      implAttemptTimeoutMs: options.implTimeoutMs,
      logTail: tail,
    });
    throw new Error(
      `Test process (PID ${child.pid}) exited immediately after spawn.\n` +
      `Command: ${options.command.join(' ')}\n` +
      `Log tail:\n${tail}\n` +
      `Launch diagnostic: ${launchFailurePath}`
    );
  }

  // On Windows, find the actual test process beneath the cmd.exe wrapper
  let actualTestPid = null;
  let actualTestDetail = null;
  if (isWindows) {
    actualTestPid = findActualTestProcess(child.pid, ROOT);
    if (actualTestPid) {
      actualTestDetail = getProcessDetail(actualTestPid, ROOT);
      console.error(`[start-run] Wrapper PID ${child.pid}, actual test PID ${actualTestPid}`);
    } else {
      console.error(`[start-run] Could not find actual test process under wrapper PID ${child.pid}`);
    }
  }

  const manifest = {
    runId,
    bridgeRoot: bridgeRootAbs,
    bridgeDir,
    logPath: logAbs,
    port: options.port,
    implAttemptTimeoutMs: options.implTimeoutMs,
    runDeadlineAt,
    runTimeoutMs: options.timeoutMs,
    shutdownGraceMs: options.shutdownGraceMs,
    timeoutMs: options.timeoutMs,
    stepCount: options.stepCount,
    timeoutStrategy: options.timeoutExplicit ? 'explicit' : 'dynamic_by_step_count',
    command: options.command,
    pid: child.pid,
    processGroupId: child.pid,
    startedAt: startedAtIso,
    watchdogPid: watchdog.pid,
    cleanedPortOwners: owners,
    termination,
    resumedFromRunId,
    restoredSteps,
    ...(actualTestPid ? { actualTestPid, actualTestDetail } : {}),
  };

  atomicWriteJsonSync(path.join(bridgeDir, 'launch.json'), manifest);
  atomicWriteJsonSync(path.join(bridgeRootAbs, 'latest-run.json'), manifest);

  try {
    const wsUrl = await resolveWsUrl(`http://127.0.0.1:${options.port}`, { timeoutMs: 30000 });
    fs.writeFileSync(path.join(bridgeDir, 'cdp-ws.txt'), wsUrl + '\n');
    console.log(`[start-run] cdp ws url -> ${path.join(bridgeDir, 'cdp-ws.txt')}`);
  } catch (err) {
    console.error(`[start-run] failed to resolve CDP ws url: ${err.message}`);
    try { process.kill(child.pid, 'SIGTERM'); } catch (_) {}
    fs.writeFileSync(
      path.join(bridgeDir, 'launch-failure.json'),
      JSON.stringify({ kind: 'ws-url-resolution', error: err.message }, null, 2),
    );
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { ...module.exports, resolveWsUrl, validateCommandArgs };
