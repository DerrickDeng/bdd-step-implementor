#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  inspectPrereqs,
  printReport,
  readIfExists,
  readJsonIfExists,
  run,
} = require('./doctor-lib');

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
  };
}

function logAction(message) {
  console.log(`ACTION  ${message}`);
}

function applyAction(description, dryRun, fn) {
  logAction(`${description}${dryRun ? ' [dry-run]' : ''}`);
  if (!dryRun) fn();
}

function ensureGitignoreEntries(dryRun) {
  const gitignorePath = path.join(ROOT, '.gitignore');
  const existing = readIfExists('.gitignore') || '';
  const required = ['mcp-bridge/'];
  const missing = required.filter(entry => !existing.includes(entry));
  if (missing.length === 0) return false;

  applyAction(`Update .gitignore with ${missing.join(', ')}`, dryRun, () => {
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    const next = `${existing}${prefix}${missing.join('\n')}\n`;
    fs.writeFileSync(gitignorePath, next);
  });
  return true;
}

function ensureDependencies(dryRun) {
  const installCommand = fs.existsSync(path.join(ROOT, 'package-lock.json'))
    ? ['npm', ['ci']]
    : ['npm', ['install']];

  applyAction(`Install project dependencies with "${installCommand[0]} ${installCommand[1].join(' ')}"`, dryRun, () => {
    const result = run(installCommand[0], installCommand[1], { cwd: ROOT, stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      throw new Error('Dependency installation failed.');
    }
  });
}

function hasBlockingManualIssues(report) {
  return report.summary.manualRequired > 0 || report.summary.unsupported > 0;
}

function needsDependencyInstall(report) {
  const ids = new Set(report.checks.filter(check => !check.ok).map(check => check.id));
  return [
    'deps-playwright-test',
    'deps-cucumber',
  ].some(id => ids.has(id));
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  const initialReport = inspectPrereqs();
  printReport(initialReport);

  if (initialReport.ready) {
    console.log('\nSetup status: NOTHING TO DO');
    return;
  }

  if (hasBlockingManualIssues(initialReport)) {
    console.log('\nSetup status: BLOCKED');
    console.log('Resolve manual-required or unsupported issues before auto-setup can finish.');
  }

  let changed = false;

  if (ensureGitignoreEntries(options.dryRun)) changed = true;

  if (needsDependencyInstall(initialReport)) {
    ensureDependencies(options.dryRun);
    changed = true;
  }

  if (!changed) {
    console.log('\nSetup status: NO AUTO-FIXABLE CHANGES APPLIED');
  }

  if (options.dryRun) {
    console.log('\nSetup dry-run complete. Re-run without --dry-run to apply changes.');
    return;
  }

  const finalReport = inspectPrereqs();
  console.log('');
  printReport(finalReport);
  console.log(`\nSetup status: ${finalReport.ready ? 'READY' : 'NOT READY'}`);

  if (!finalReport.ready) {
    process.exit(1);
  }
}

main();
