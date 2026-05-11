#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { readProjectProfile } = require('./fs-utils');

const ROOT = process.cwd();
const MIN_NODE_MAJOR = 18;

function checkPlaywrightCliInstalled(opts = {}) {
  const MIN = [0, 1, 8];
  let version = opts.simulate;
  if (version === undefined) {
    try {
      const out = require('child_process').spawnSync('playwright-cli', ['--version'], { encoding: 'utf8' });
      if (out.status === 0) {
        const m = (out.stdout || '').trim().match(/^(\d+\.\d+\.\d+)/);
        version = m ? m[1] : null;
      } else {
        version = null;
      }
    } catch (_) {
      version = null;
    }
  }
  if (!version) {
    return { ok: false, reason: 'playwright-cli is not installed. Install with: npm install -g @playwright/cli@latest' };
  }
  const parts = version.split(/[.\-]/).map((n) => parseInt(n, 10));
  const cmp = [0, 1, 2].reduce((acc, i) => acc || ((parts[i] || 0) - MIN[i]), 0);
  if (cmp < 0) {
    return { ok: false, version, reason: `playwright-cli ${version} is older than required >= 0.1.8. Upgrade with: npm install -g @playwright/cli@latest` };
  }
  return { ok: true, version };
}

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    ...options,
  });
}

function readIfExists(relPath) {
  const absPath = path.join(ROOT, relPath);
  return fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : null;
}

function readJsonIfExists(relPath) {
  const raw = readIfExists(relPath);
  if (raw === null) return { exists: false, value: null, error: null };
  try {
    return { exists: true, value: JSON.parse(raw), error: null };
  } catch (error) {
    return { exists: true, value: null, error };
  }
}

function commandExists(command, args = ['--help']) {
  const result = run(command, args);
  if (result.error) return false;
  return result.status === 0 || result.status === 1;
}

function localPackageInstalled(packageName) {
  return fs.existsSync(path.join(ROOT, 'node_modules', ...packageName.split('/'), 'package.json'));
}

function addCheck(checks, id, label, ok, category, detail, fixCommand) {
  checks.push({ id, label, ok, category, detail, fixCommand });
}

function inspectPrereqs() {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);

  addCheck(
    checks,
    'platform-supported',
    'platform is supported',
    ['darwin', 'linux', 'win32'].includes(process.platform),
    ['darwin', 'linux', 'win32'].includes(process.platform) ? 'none' : 'unsupported',
    `Current platform is ${process.platform}; only macOS, Linux, and Windows are supported.`,
    null
  );

  addCheck(
    checks,
    'node-version',
    `Node.js version is >= ${MIN_NODE_MAJOR}`,
    Number.isInteger(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR,
    'manual-required',
    `Found Node.js ${process.versions.node}. Install Node.js ${MIN_NODE_MAJOR}+ first.`,
    null
  );

  addCheck(
    checks,
    'npm-exists',
    'npm is available',
    commandExists('npm', ['--version']),
    'manual-required',
    'npm is not available on PATH.',
    null
  );

  addCheck(
    checks,
    'npx-exists',
    'npx is available',
    commandExists('npx', ['--version']),
    'manual-required',
    'npx is not available on PATH.',
    null
  );

  addCheck(
    checks,
    'package-json',
    'package.json exists',
    fs.existsSync(path.join(ROOT, 'package.json')),
    'manual-required',
    'Run this skill from the project root that contains package.json.',
    null
  );

  addCheck(
    checks,
    'deps-playwright-test',
    '@playwright/test is installed locally',
    localPackageInstalled('@playwright/test'),
    'auto-fixable',
    'Run setup to install project dependencies.',
    'node .claude/skills/mcp-step-implementor/scripts/setup.js'
  );

  addCheck(
    checks,
    'deps-cucumber',
    '@cucumber/cucumber is installed locally',
    localPackageInstalled('@cucumber/cucumber'),
    'auto-fixable',
    'Run setup to install project dependencies.',
    'node .claude/skills/mcp-step-implementor/scripts/setup.js'
  );

  const cliCheck = checkPlaywrightCliInstalled();
  addCheck(
    checks,
    'playwright-cli',
    'playwright-cli >= 0.1.8 installed',
    cliCheck.ok,
    'manual-required',
    cliCheck.ok ? null : cliCheck.reason,
    'npm install -g @playwright/cli@latest',
  );

  // Read hooks path from profile if available, then fall back to search
  const profile = readProjectProfile(ROOT);
  const hooksPaths = [
    profile?.files?.hooks,
    'src/support/hooks.ts',
    'src/step-definitions/hooks/hooks.ts',
    'src/steps/hooks/hooks.ts',
    'src/support/hooks.js',
    'src/step-definitions/hooks/hooks.js',
    'src/steps/hooks/hooks.js',
  ].filter(Boolean);
  const hooksFound = hooksPaths.reduce((found, p) => {
    if (found.content !== null) return found;
    const content = readIfExists(p);
    return content !== null ? { path: p, content } : found;
  }, { path: null, content: null });

  addCheck(
    checks,
    'hooks-exists',
    'hooks.ts exists',
    hooksFound.content !== null,
    'manual-required',
    `Required for launching Chromium with a CDP port. Searched: ${hooksPaths.join(', ')}`,
    null
  );

  if (hooksFound.content !== null) {
    addCheck(
      checks,
      'hooks-cdp-port',
      `${hooksFound.path} supports PW_MCP_CDP_PORT`,
      hooksFound.content.includes('PW_MCP_CDP_PORT'),
      'manual-required',
      'Cucumber browser must expose a remote debugging port for MCP attach.',
      null
    );

    addCheck(
      checks,
      'hooks-close-browser',
      `${hooksFound.path} closes browser in AfterAll hook`,
      hooksFound.content.includes('AfterAll') && hooksFound.content.includes('browser.close()'),
      'manual-required',
      'AfterAll hook must close browser to ensure test process exits cleanly. If stub steps are paused, AfterAll won\'t execute, so browser stays open for MCP attach.',
      null
    );
  }

  const gitignore = readIfExists('.gitignore');
  addCheck(
    checks,
    'gitignore-exists',
    '.gitignore exists',
    gitignore !== null,
    'auto-fixable',
    'Missing .gitignore at the repo root.',
    'node .claude/skills/mcp-step-implementor/scripts/setup.js'
  );

  addCheck(
    checks,
    'gitignore-bridge',
    '.gitignore ignores mcp-bridge/',
    gitignore !== null && gitignore.includes('mcp-bridge/'),
    'auto-fixable',
    'Temporary bridge files should stay untracked.',
    'node .claude/skills/mcp-step-implementor/scripts/setup.js'
  );

  const platformCommandsOk = process.platform === 'win32'
    ? commandExists('netstat', ['-ano']) && commandExists('taskkill', ['/?'])
    : commandExists('lsof', ['-v']);
  addCheck(
    checks,
    'platform-tooling',
    process.platform === 'win32'
      ? 'Windows port/process tooling is available'
      : 'Unix port/process tooling is available',
    platformCommandsOk,
    'manual-required',
    process.platform === 'win32'
      ? 'netstat/taskkill are unavailable; port cleanup cannot run.'
      : 'lsof is unavailable; port cleanup cannot run.',
    null
  );

  const summary = {
    passed: checks.filter(check => check.ok).length,
    autoFixable: checks.filter(check => !check.ok && check.category === 'auto-fixable').length,
    manualRequired: checks.filter(check => !check.ok && check.category === 'manual-required').length,
    unsupported: checks.filter(check => !check.ok && check.category === 'unsupported').length,
  };

  return {
    root: ROOT,
    checks,
    summary,
    ready: summary.autoFixable === 0 && summary.manualRequired === 0 && summary.unsupported === 0,
  };
}

function printReport(report) {
  for (const check of report.checks) {
    const prefix = check.ok ? 'PASS' : 'FAIL';
    const suffix = check.ok ? '' : ` [${check.category}]`;
    console.log(`${prefix}  ${check.label}${suffix}`);
    if (!check.ok && check.detail) {
      console.log(`      ${check.detail}`);
    }
    if (!check.ok && check.fixCommand) {
      console.log(`      fix: ${check.fixCommand}`);
    }
  }

  console.log('');
  console.log(
    `Summary: ${report.summary.passed} passed, ` +
    `${report.summary.autoFixable} auto-fixable, ` +
    `${report.summary.manualRequired} manual-required, ` +
    `${report.summary.unsupported} unsupported.`
  );
}

module.exports = {
  ROOT,
  inspectPrereqs,
  printReport,
  readIfExists,
  readJsonIfExists,
  run,
};
module.exports.checkPlaywrightCliInstalled = checkPlaywrightCliInstalled;
