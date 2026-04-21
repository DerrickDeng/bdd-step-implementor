#!/usr/bin/env node
'use strict';

function buildWindowsSpawnSpec({ root, logFd, spawnEnv, command }) {
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', ...command],
    options: {
      cwd: root,
      stdio: ['ignore', logFd, logFd],
      env: spawnEnv,
    },
  };
}

module.exports = {
  buildWindowsSpawnSpec,
};
