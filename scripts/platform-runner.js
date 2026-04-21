#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
}

function parseTasklistCsv(output) {
  const line = (output || '')
    .split(/\r?\n/)
    .map(value => value.trim())
    .find(value => value && !/^INFO:/i.test(value));

  if (!line) return null;

  const normalized = line.replace(/^"|"$/g, '');
  const parts = normalized.split('","');
  if (parts.length < 2) return null;

  return {
    imageName: parts[0],
    pid: Number(parts[1]),
    raw: line,
  };
}

function getProcessDetail(pid, cwd) {
  if (process.platform === 'win32') {
    const result = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { cwd });
    const parsed = parseTasklistCsv(result.stdout || '');
    return parsed ? `${parsed.imageName} (PID ${parsed.pid})` : `PID ${pid}`;
  }

  const psResult = run('ps', ['-p', String(pid), '-o', 'pid=,ppid=,command='], { cwd });
  const detail = (psResult.stdout || '').trim();
  return detail || `PID ${pid}`;
}

function getPortOwners(port, cwd) {
  if (process.platform === 'win32') {
    const result = run('netstat', ['-ano', '-p', 'tcp'], { cwd });
    if (result.error || ![0, 1].includes(result.status)) {
      throw new Error(`Failed to inspect port ${port}: ${result.error ? result.error.message : result.stderr || result.stdout}`);
    }

    const owners = new Map();
    for (const line of (result.stdout || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!/^TCP/i.test(trimmed)) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 5) continue;
      const localAddress = parts[1];
      const state = parts[3];
      const pid = Number(parts[4]);
      const portSuffix = `:${port}`;
      if (!localAddress.endsWith(portSuffix) || state.toUpperCase() !== 'LISTENING' || !Number.isInteger(pid) || pid <= 0) {
        continue;
      }
      owners.set(pid, { pid, detail: getProcessDetail(pid, cwd) });
    }

    return [...owners.values()];
  }

  const result = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { cwd });
  if (result.error || ![0, 1].includes(result.status)) {
    throw new Error(`Failed to inspect port ${port}: ${result.error ? result.error.message : result.stderr || result.stdout}`);
  }

  const pids = (result.stdout || '')
    .split(/\s+/)
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value > 0);

  return pids.map(pid => ({ pid, detail: getProcessDetail(pid, cwd) }));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isPidAlive(pid, cwd) {
  if (!pid) return false;

  if (process.platform === 'win32') {
    const result = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { cwd });
    return Boolean(parseTasklistCsv(result.stdout || ''));
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function getChildPids(parentPid, cwd) {
  if (!parentPid) return [];

  if (process.platform === 'win32') {
    // Use WMIC to get child processes
    const result = run('wmic', [
      'process',
      'where',
      `(ParentProcessId=${parentPid})`,
      'get',
      'ProcessId',
      '/format:list'
    ], { cwd });

    if (result.error || result.status !== 0) return [];

    const children = [];
    for (const line of (result.stdout || '').split(/\r?\n/)) {
      const match = /^ProcessId=(\d+)$/.exec(line.trim());
      if (match) {
        const childPid = Number(match[1]);
        if (childPid > 0) children.push(childPid);
      }
    }
    return children;
  }

  // Unix: use ps to find children
  const result = run('ps', ['-o', 'pid=', '--ppid', String(parentPid)], { cwd });
  if (result.error || result.status !== 0) return [];

  return (result.stdout || '')
    .split(/\s+/)
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value > 0);
}

function findActualTestProcess(rootPid, cwd, maxDepth = 10) {
  // Recursively find the actual test process (node/cucumber) from a wrapper process (cmd.exe)
  // Strategy: find the DEEPEST node.exe process in the tree
  // This handles chains like: cmd.exe → npm (node) → cmd → cross-env (node) → cmd → cucumber (node)

  if (!isPidAlive(rootPid, cwd)) return null;

  const visited = new Set();
  const queue = [{ pid: rootPid, depth: 0 }];
  let deepestNode = null;
  let deepestNodeDepth = -1;

  while (queue.length > 0) {
    const { pid, depth } = queue.shift();

    if (visited.has(pid) || depth >= maxDepth) continue;
    visited.add(pid);

    const children = getChildPids(pid, cwd);

    // Check if this is a node.exe process
    const detail = getProcessDetail(pid, cwd);
    const processName = detail.split('(')[0].trim().toLowerCase();

    if (processName.includes('node.exe') && pid !== rootPid) {
      // Found a node.exe - keep track if it's the deepest one
      if (depth > deepestNodeDepth) {
        deepestNodeDepth = depth;
        deepestNode = pid;
      }
    }

    // Add children to queue
    for (const childPid of children) {
      queue.push({ pid: childPid, depth: depth + 1 });
    }
  }

  return deepestNode;
}

async function terminatePidTree(pid, cwd) {
  if (!pid || !isPidAlive(pid, cwd)) {
    return { pid, alive: false };
  }

  if (process.platform === 'win32') {
    run('taskkill', ['/PID', String(pid), '/T', '/F'], { cwd });
    await sleep(800);
    return { pid, alive: isPidAlive(pid, cwd) };
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (innerError) {
      // ignore
    }
  }

  await sleep(1500);

  if (isPidAlive(pid, cwd)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (innerError) {
        // ignore
      }
    }
  }

  await sleep(500);
  return { pid, alive: isPidAlive(pid, cwd) };
}

module.exports = {
  getPortOwners,
  getProcessDetail,
  isPidAlive,
  getChildPids,
  findActualTestProcess,
  run,
  sleep,
  terminatePidTree,
};
