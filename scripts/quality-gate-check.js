#!/usr/bin/env node
// Quality Gate Checker for mcp-step-implementor
// Self-contained copy — does not depend on step-implementor's version.
// Cross-platform (Node.js) — no bash/grep/md5 dependency.
//
// Usage (legacy): node quality-gate-check.js <feature_file> <step_def_file> <page_object_file> <feature_baseline_hash>
// Usage (multi-file): node quality-gate-check.js <feature_file> <feature_baseline_hash> --step-def <file> [--step-def <file> ...] --page-object <file> [--page-object <file> ...] [--stub-file <path>]
//
// Exit codes:
//   0 = all gates pass
//   1 = gate violation found (details printed to stdout)

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { readProjectProfile } = require('./fs-utils');

function usage() {
  return [
    'Usage:',
    '  node quality-gate-check.js <feature_file> <step_def_file> <page_object_file> <feature_baseline_hash>',
    '  node quality-gate-check.js <feature_file> <feature_baseline_hash> --step-def <file> [--step-def <file> ...] --page-object <file> [--page-object <file> ...] [--stub-file <path>]',
  ].join('\n');
}

function parseArgs(argv) {
  const profile = readProjectProfile();
  const defaultStubFile = profile?.files?.stub_step_def
    ? path.resolve(process.cwd(), profile.files.stub_step_def)
    : path.resolve(process.cwd(), 'src', 'steps', '_mcp-stubs.steps.ts');

  if (argv.length === 4 && !argv.some(arg => arg.startsWith('--'))) {
    return {
      featureFile: argv[0],
      baselineHash: argv[3],
      stepDefFiles: [argv[1]],
      pageObjectFiles: [argv[2]],
      stubFile: defaultStubFile,
      bridgeDir: path.resolve(process.cwd(), 'mcp-bridge'),
    };
  }

  const [featureFile, baselineHash, ...rest] = argv;
  const parsed = {
    featureFile,
    baselineHash,
    stepDefFiles: [],
    pageObjectFiles: [],
    stubFile: defaultStubFile,
    bridgeDir: path.resolve(process.cwd(), 'mcp-bridge'),
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--step-def') {
      parsed.stepDefFiles.push(rest[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--page-object') {
      parsed.pageObjectFiles.push(rest[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--stub-file') {
      parsed.stubFile = path.resolve(process.cwd(), rest[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--bridge-dir') {
      parsed.bridgeDir = path.resolve(process.cwd(), rest[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  console.error(usage());
  process.exit(2);
}

if (
  !options.featureFile ||
  !options.baselineHash ||
  options.stepDefFiles.length === 0 ||
  options.pageObjectFiles.length === 0
) {
  console.error(usage());
  process.exit(2);
}

const {
  featureFile,
  baselineHash,
  stepDefFiles,
  pageObjectFiles,
  stubFile,
  bridgeDir,
} = options;

let violations = 0;

function check(name, passed, detail) {
  if (!passed) {
    console.log(`FAIL  [${name}] ${detail}`);
    violations++;
  } else {
    console.log(`PASS  [${name}]`);
  }
}

function md5(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(content).digest('hex');
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8').split('\n');
}

function isComment(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*');
}

function findViolations(lines, pattern) {
  const hitLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isComment(lines[i]) && pattern.test(lines[i])) {
      hitLines.push(i + 1);
    }
  }
  return hitLines;
}

function summarizeHits(hitGroups) {
  return hitGroups
    .map(group => `${group.file}:${group.hits.join(',')}`)
    .join('; ');
}

function collectViolations(filePaths, pattern) {
  const groups = [];
  for (const filePath of filePaths) {
    const lines = readLines(filePath);
    if (!lines) continue;
    const hits = findViolations(lines, pattern);
    if (hits.length > 0) {
      groups.push({ file: filePath, hits });
    }
  }
  return groups;
}

function collectProbeMarkers(filePaths) {
  const groups = [];
  for (const filePath of filePaths) {
    const lines = readLines(filePath);
    if (!lines) continue;
    const hits = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (/@probe/.test(lines[i])) hits.push(i + 1);
    }
    if (hits.length > 0) {
      groups.push({ file: filePath, hits });
    }
  }
  return groups;
}

// ── Gate 1: Feature file integrity ──────────────────────────────────
const currentHash = md5(featureFile);
check(
  'feature-file-integrity',
  currentHash === baselineHash,
  `Feature file was modified after Phase 1. Expected MD5 ${baselineHash}, got ${currentHash}. Revert any step text changes, and compute the baseline with: node .claude/skills/mcp-step-implementor/scripts/feature-baseline-hash.js <feature_file>.`
);

// ── Gate 2: No expect() in step definitions ─────────────────────────
const expectHits = collectViolations(stepDefFiles, /expect\(/);
check(
  'no-expect-in-stepdef',
  expectHits.length === 0,
  `Step definition contains expect() calls — assertions belong in Page Object methods. Files/lines: ${summarizeHits(expectHits)}`
);

// ── Gate 3: No direct this.page.* in step definitions ───────────────
const directPageHits = collectViolations(stepDefFiles, /this\.page\./);
check(
  'no-direct-page-in-stepdef',
  directPageHits.length === 0,
  `Step definition has direct this.page.* calls — delegate to Page Object methods instead. Files/lines: ${summarizeHits(directPageHits)}`
);

// ── Gate 4: No if/else selector fallbacks in Page Object ────────────
const selectorFallbackHits = collectViolations(
  pageObjectFiles,
  /if\s*\(.*locator|if\s*\(.*selector|try\s*\{.*locator|catch.*locator|\.catch\(.*click|\.catch\(.*fill/
);
check(
  'no-selector-fallback',
  selectorFallbackHits.length === 0,
  `Page Object contains if/else or try/catch selector fallbacks — use a single deterministic locator. Files/lines: ${summarizeHits(selectorFallbackHits)}`
);

// ── Gate 5: No probe code residue in Page Object ────────────────────
// Probes are marked with `// @probe` and `// @probe-end` comments.
const probeHits = collectProbeMarkers(pageObjectFiles);
check(
  'no-probe-residue',
  probeHits.length === 0,
  `Page Object contains probe marker (// @probe) — remove all probe code before declaring PASS. Files/lines: ${summarizeHits(probeHits)}`
);

// ── Gate 6: No stub residue ─────────────────────────────────────────
// The mcp-stubs file and mcp-bridge directory should have been cleaned up.
const residue = [];
if (fs.existsSync(stubFile)) residue.push(stubFile);
if (fs.existsSync(bridgeDir)) residue.push(bridgeDir);
check(
  'no-stub-residue',
  residue.length === 0,
  `MCP stub artifacts still present — run cleanup.js before declaring PASS. Found: ${residue.join(', ')}`
);

// ── Summary ─────────────────────────────────────────────────────────
console.log('');
if (violations === 0) {
  console.log('Quality Gate: ALL PASS (6 checks)');
  process.exit(0);
} else {
  console.log(`Quality Gate: ${violations} VIOLATION(S) — fix before declaring step PASS`);
  process.exit(1);
}
