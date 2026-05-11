#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveRunContext, readJsonIfExists } = require('./run-manifest');
const { cliSessionNameForRun } = require('./cli-session');
const { resolveWsUrl: resolveHttpWsUrl } = require('./start-run');

const ROOT = process.cwd();

function parseArgs(argv) {
  const parsed = {
    bridgeRoot: 'mcp-bridge',
    runId: null,
    step: null,
    timeoutMs: 30000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
    if (arg === '--step') {
      parsed.step = Number(argv[i + 1]);
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

  if (!Number.isInteger(parsed.step) || parsed.step < 1) {
    throw new Error('Usage: node attach-cli.js --step <N> [--run-id <runId>] [--bridge-root <dir>] [--timeout-ms <ms>]');
  }

  return parsed;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readNonEmptyFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const value = fs.readFileSync(filePath, 'utf8').trim();
  return value || null;
}

async function waitForFileValue(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readNonEmptyFile(filePath);
    if (value) return value;
    await sleep(250);
  }
  return null;
}

async function resolveWsUrl(context, timeoutMs) {
  const wsFile = path.join(context.bridgeDir, 'cdp-ws.txt');
  const wsFromFile = await waitForFileValue(wsFile, timeoutMs);
  if (wsFromFile) {
    return { wsUrl: wsFromFile, source: wsFile };
  }

  const port = context.manifest?.port || 9222;
  const wsUrl = await resolveHttpWsUrl(`http://127.0.0.1:${port}`, {
    timeoutMs: Math.min(timeoutMs, 5000),
  });
  return { wsUrl, source: `http://127.0.0.1:${port}/json/version` };
}

function closeSession(sessionName) {
  const result = spawnSync('playwright-cli', ['-s', sessionName, 'close'], { encoding: 'utf8' });
  if (result.status !== 0 && !/is not open/i.test(`${result.stdout}\n${result.stderr}`)) {
    console.warn(`[attach-cli] playwright-cli close returned ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function attachSession(sessionName, wsUrl) {
  const result = spawnSync('playwright-cli', ['-s', sessionName, 'attach', '--cdp', wsUrl], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) {
    throw new Error(`playwright-cli attach failed with exit code ${result.status}`);
  }
}

function readExpectedUrl(context, step) {
  const pausePath = path.join(context.bridgeDir, `step-${step}-pause.json`);
  const expectedUrl = readJsonIfExists(pausePath)?.url || null;
  if (!expectedUrl) {
    throw new Error(`Paused step URL not found: ${pausePath}`);
  }
  return expectedUrl;
}

function tabList(sessionName) {
  const result = spawnSync('playwright-cli', ['-s', sessionName, 'tab-list'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`playwright-cli tab-list failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout || '';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bridgeRootAbs = path.resolve(ROOT, options.bridgeRoot);
  const context = resolveRunContext(bridgeRootAbs, options.runId);
  const sessionName = cliSessionNameForRun(context.runId);
  const { wsUrl, source } = await resolveWsUrl(context, options.timeoutMs);

  closeSession(sessionName);
  attachSession(sessionName, wsUrl);

  const tabs = tabList(sessionName);
  const expectedUrl = readExpectedUrl(context, options.step);
  if (!tabs.includes(expectedUrl)) {
    throw new Error(
      `Attached browser does not expose paused step URL.\n` +
      `Expected URL: ${expectedUrl}\n` +
      `Tabs:\n${tabs}`
    );
  }

  console.log(`[attach-cli] runId: ${context.runId}`);
  console.log(`[attach-cli] session: ${sessionName}`);
  console.log(`[attach-cli] cdp: ${source}`);
  console.log(`[attach-cli] CLI=\"playwright-cli -s=${sessionName}\"`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  resolveWsUrl,
};
