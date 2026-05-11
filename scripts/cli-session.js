#!/usr/bin/env node
'use strict';

const crypto = require('crypto');

function cliSessionNameForRun(runId) {
  if (!runId || typeof runId !== 'string') {
    throw new Error('runId is required to build playwright-cli session name');
  }

  const digest = crypto.createHash('sha1').update(runId).digest('hex').slice(0, 8);
  return `bdd-${digest}`;
}

function legacyCliSessionNamesForRun(runId) {
  return [`bdd-${runId}`];
}

module.exports = {
  cliSessionNameForRun,
  legacyCliSessionNamesForRun,
};
