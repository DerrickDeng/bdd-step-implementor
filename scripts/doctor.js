#!/usr/bin/env node
'use strict';

const { inspectPrereqs, printReport } = require('./doctor-lib');

const report = inspectPrereqs();
printReport(report);

if (report.ready) {
  console.log('\nDoctor status: READY');
  process.exit(0);
}

console.log('\nDoctor status: NOT READY');
process.exit(1);
