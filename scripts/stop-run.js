#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { getPortOwners, terminatePidTree } = require('./platform-runner');
const { atomicWriteJsonSync } = require('./fs-utils');
const { resolveRunContext } = require('./run-manifest');
const { cliSessionNameForRun, legacyCliSessionNamesForRun } = require('./cli-session');

const ROOT = process.cwd();

function parseArgs(argv) {
  const parsed = {
    bridgeRoot: 'mcp-bridge',
    runId: null,
    port: 9222,
    cleanPort: false,
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
    if (arg === '--port') {
      parsed.port = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--clean-port') {
      parsed.cleanPort = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function readManifest(options) {
  const bridgeRootAbs = path.resolve(ROOT, options.bridgeRoot);
  const latestPath = path.join(bridgeRootAbs, 'latest-run.json');
  if (!fs.existsSync(latestPath) && !options.runId) {
    return { bridgeRootAbs, manifest: null, manifestPath: latestPath };
  }

  const context = resolveRunContext(bridgeRootAbs, options.runId);
  if (!context.manifest) {
    if (options.runId) {
      throw new Error(`Run manifest not found for ${options.runId}`);
    }
    return { bridgeRootAbs, manifest: null, manifestPath: latestPath, latestPath, launchPath: null };
  }

  return {
    bridgeRootAbs,
    manifest: context.manifest,
    manifestPath: context.launchManifest ? context.launchPath : context.latestPath,
    latestPath: context.latestPath,
    launchPath: context.launchManifest ? context.launchPath : null,
  };
}

function closeCliDaemon(runId) {
  const sessionNames = [cliSessionNameForRun(runId), ...legacyCliSessionNamesForRun(runId)];
  for (const sessionName of sessionNames) {
    const result = require('child_process').spawnSync(
      'playwright-cli',
      ['-s', sessionName, 'close'],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) {
      // Session may not exist (run never attached) — swallow silently
      if (!/is not open/i.test(`${result.stdout}\n${result.stderr}`)) {
        console.warn(`[stop-run] playwright-cli close ${sessionName} returned ${result.status}: ${result.stderr?.trim()}`);
      }
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { bridgeRootAbs, manifest, manifestPath, latestPath, launchPath } = readManifest(options);

  const result = {
    runId: manifest?.runId ?? options.runId ?? null,
    manifestFound: Boolean(manifest),
    processTermination: null,
    cleanedPortOwners: [],
  };

  if (manifest?.pid) {
    result.processTermination = await terminatePidTree(manifest.pid, ROOT);
  }

  const runId = manifest?.runId ?? options.runId;
  if (runId) {
    closeCliDaemon(runId);
  }

  if (options.cleanPort) {
    const owners = getPortOwners(options.port, ROOT);
    for (const owner of owners) {
      result.cleanedPortOwners.push(await terminatePidTree(owner.pid, ROOT));
    }
  }

  if (manifestPath && fs.existsSync(manifestPath) && manifest) {
    const updated = {
      ...manifest,
      stoppedAt: new Date().toISOString(),
      stopResult: result,
    };
    if (launchPath && fs.existsSync(launchPath)) {
      atomicWriteJsonSync(launchPath, updated);
    } else {
      atomicWriteJsonSync(manifestPath, updated);
    }
    if (latestPath && fs.existsSync(latestPath)) {
      const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
      if (latest.runId === manifest.runId) {
        atomicWriteJsonSync(latestPath, {
          ...latest,
          stoppedAt: updated.stoppedAt,
          stopResult: result,
        });
      }
    }
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
