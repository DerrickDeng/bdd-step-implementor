#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');

const featureFile = process.argv[2];

if (!featureFile) {
  console.error('Usage: node feature-baseline-hash.js <feature_file>');
  process.exit(2);
}

const content = fs.readFileSync(featureFile);
const hash = crypto.createHash('md5').update(content).digest('hex');

console.log(hash);
