#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function resolveRunContext(bridgeRootAbs, explicitRunId) {
  const latestPath = path.join(bridgeRootAbs, 'latest-run.json');
  const latestManifest = readJsonIfExists(latestPath);

  const runId = explicitRunId || latestManifest?.runId || null;
  if (!runId) {
    throw new Error(`Run manifest not found: ${latestPath}`);
  }

  const defaultBridgeDir = path.join(bridgeRootAbs, runId);
  const bridgeDir = (
    explicitRunId
      ? (latestManifest?.runId === explicitRunId ? latestManifest.bridgeDir : null)
      : latestManifest?.bridgeDir
  ) || defaultBridgeDir;

  const launchPath = path.join(defaultBridgeDir, 'launch.json');
  const launchManifest = readJsonIfExists(launchPath);
  const latestForRun = latestManifest?.runId === runId ? latestManifest : null;
  const manifest = launchManifest || latestForRun || null;

  return {
    runId,
    bridgeDir,
    manifest,
    launchManifest,
    latestManifest: latestForRun,
    launchPath,
    latestPath,
  };
}

module.exports = {
  readJsonIfExists,
  resolveRunContext,
};
