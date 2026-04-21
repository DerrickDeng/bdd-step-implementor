#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Atomic file write — prevents readers from seeing partially-written content.
 *
 * Writes to a temporary file in the same directory, then renames it to the
 * target path.  `rename()` is atomic on POSIX when source and target are on
 * the same filesystem (which is guaranteed here because the tmp file lives
 * in the same directory).  On Windows, `renameSync` replaces an existing
 * file atomically as of Node 14+.
 */
function atomicWriteFileSync(targetPath, content, encoding = 'utf8') {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.tmp.${process.pid}.${Date.now()}.${path.basename(targetPath)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmpPath, content, encoding);
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Atomic JSON write — serialises `value` with 2-space indent and writes
 * atomically via `atomicWriteFileSync`.
 */
function atomicWriteJsonSync(targetPath, value) {
  atomicWriteFileSync(targetPath, JSON.stringify(value, null, 2));
}

/**
 * Read the project profile from `.claude/project-profile.json`.
 * Returns the parsed object, or null if the file does not exist or is invalid.
 */
function readProjectProfile(root) {
  const profilePath = path.join(root || process.cwd(), '.claude', 'project-profile.json');
  if (!fs.existsSync(profilePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  atomicWriteFileSync,
  atomicWriteJsonSync,
  readProjectProfile,
};
