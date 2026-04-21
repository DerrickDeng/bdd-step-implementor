#!/usr/bin/env node
'use strict';

/**
 * cleanup.js
 *
 * Removes all temporary files created by the mcp-step-implementor skill:
 *   - src/steps/_mcp-stubs.steps.ts
 *   - mcp-bridge/ (all run-scoped bridge directories and manifests)
 *
 * Usage:
 *   node .claude/skills/mcp-step-implementor/scripts/cleanup.js [--stub-file <path>]
 */

const fs = require('fs');
const path = require('path');
const { readProjectProfile } = require('./fs-utils');

const ROOT = process.cwd();

function parseArgs(argv) {
  const profile = readProjectProfile(ROOT);
  const parsed = {
    stubFile: profile?.files?.stub_step_def
      ? path.resolve(ROOT, profile.files.stub_step_def)
      : path.join(ROOT, 'src', 'steps', '_mcp-stubs.steps.ts'),
    bridgeDir: path.join(ROOT, 'mcp-bridge'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--stub-file') {
      parsed.stubFile = path.resolve(ROOT, argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--bridge-dir') {
      parsed.bridgeDir = path.resolve(ROOT, argv[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

const options = parseArgs(process.argv.slice(2));
const STUB_FILE = options.stubFile;
const BRIDGE_DIR = options.bridgeDir;

let cleaned = 0;

if (fs.existsSync(STUB_FILE)) {
  fs.unlinkSync(STUB_FILE);
  console.log(`Deleted: ${STUB_FILE}`);
  cleaned++;
} else {
  console.log(`Not found (skipped): ${STUB_FILE}`);
}

if (fs.existsSync(BRIDGE_DIR)) {
  fs.rmSync(BRIDGE_DIR, { recursive: true, force: true });
  console.log(`Deleted: ${BRIDGE_DIR}/`);
  cleaned++;
} else {
  console.log(`Not found (skipped): ${BRIDGE_DIR}/`);
}

console.log(cleaned > 0 ? `\nCleanup complete (${cleaned} item(s) removed).` : '\nNothing to clean.');
